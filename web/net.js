/*
 * 浏览器端前向推理（零依赖）
 *
 * 网络结构与 src/alphazero/network.py 一一对应：
 *   conv1: 3 -> 64, 3x3, pad 1, ReLU
 *   conv2: 64 -> 128, 3x3, pad 1, ReLU
 *   flatten: 128 * 8 * 8 = 8192（通道优先，与 PyTorch x.view 一致）
 *   fc: 8192 -> 128, ReLU
 *   policy_head: 128 -> 64, log_softmax
 *   value_head: 128 -> 1, tanh
 *
 * 权重来自 src/scripts/export_web_weights.py 导出的 weights.bin（float32 小端）
 * + weights.json（各层 offset）。不依赖 onnxruntime，整个推理约 600 万次乘加，
 * 普通笔记本单次前向在 10ms 量级。
 */
(function (global) {
  'use strict';

  var PIX = 64;        // 8 * 8
  var PAD_STRIDE = 10; // 8 + 两侧各 1
  var PAD_SIZE = 100;  // 10 * 10

  function asFloat32(buffer) {
    // 允许传入 ArrayBuffer / Uint8Array / Float32Array
    if (buffer instanceof Float32Array) return buffer;
    if (buffer instanceof Uint8Array) {
      return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength >> 2);
    }
    return new Float32Array(buffer);
  }

  function Net(meta, buffer) {
    if (!meta || !Array.isArray(meta.params)) throw new Error('weights.json 缺少 params');
    if (meta.endianness && meta.endianness !== 'little') {
      throw new Error('只支持小端权重');
    }
    this.meta = meta;
    var all = asFloat32(buffer);
    if (all.length !== meta.count) {
      throw new Error('权重长度不符：文件 ' + all.length + '，meta ' + meta.count);
    }

    var views = {};
    for (var i = 0; i < meta.params.length; i++) {
      var p = meta.params[i];
      views[p.name] = all.subarray(p.offset, p.offset + p.size);
    }
    var required = [
      'conv1.weight', 'conv1.bias', 'conv2.weight', 'conv2.bias',
      'fc.weight', 'fc.bias', 'policy_head.weight', 'policy_head.bias',
      'value_head.weight', 'value_head.bias'
    ];
    for (var k = 0; k < required.length; k++) {
      if (!views[required[k]]) throw new Error('权重缺少 ' + required[k]);
    }
    this.w = views;
    this.buf = all;

    // 复用缓冲区，避免每次前向都分配
    this.pad1 = new Float32Array(3 * PAD_SIZE);
    this.pad2 = new Float32Array(64 * PAD_SIZE);
    this.c1 = new Float32Array(64 * PIX);
    this.c2 = new Float32Array(128 * PIX);
    this.hidden = new Float32Array(128);
    this.acc = new Float32Array(PIX);
    this.logits = new Float32Array(64);
    this.policy = new Float32Array(64);
  }

  Net.prototype.paramCount = function () {
    return this.meta.count;
  };

  Net.prototype._pad = function (src, channels, dst) {
    dst.fill(0);
    for (var ch = 0; ch < channels; ch++) {
      var sBase = ch * PIX;
      var dBase = ch * PAD_SIZE;
      for (var r = 0; r < 8; r++) {
        var sRow = sBase + r * 8;
        var dRow = dBase + (r + 1) * PAD_STRIDE + 1;
        for (var c = 0; c < 8; c++) dst[dRow + c] = src[sRow + c];
      }
    }
  };

  /**
   * 3x3 卷积（pad 1, stride 1, ReLU）。
   * 输入必须已经是 10x10 填充过的布局，这样内层循环不需要边界判断。
   */
  Net.prototype._conv = function (padded, inCh, outCh, wName, bName, out) {
    var W = this.w[wName];
    var B = this.w[bName];
    var acc = this.acc;

    for (var o = 0; o < outCh; o++) {
      var bias = B[o];
      for (var p = 0; p < PIX; p++) acc[p] = bias;

      for (var ic = 0; ic < inCh; ic++) {
        var wBase = (o * inCh + ic) * 9;
        var inBase = ic * PAD_SIZE;
        for (var dr = -1; dr <= 1; dr++) {
          for (var dc = -1; dc <= 1; dc++) {
            var wv = W[wBase + (dr + 1) * 3 + (dc + 1)];
            if (wv === 0) continue;
            for (var r = 0; r < 8; r++) {
              var src = inBase + (r + dr + 1) * PAD_STRIDE + (dc + 1);
              var dst = r * 8;
              for (var c = 0; c < 8; c++) {
                acc[dst + c] += wv * padded[src + c];
              }
            }
          }
        }
      }

      var outBase = o * PIX;
      for (var q = 0; q < PIX; q++) {
        var v = acc[q];
        out[outBase + q] = v > 0 ? v : 0;
      }
    }
  };

  /** 从 192 维棋盘张量算出 policy（64 概率）与 value（[-1,1]） */
  Net.prototype.forward = function (tensor) {
    this._pad(tensor, 3, this.pad1);
    this._conv(this.pad1, 3, 64, 'conv1.weight', 'conv1.bias', this.c1);

    this._pad(this.c1, 64, this.pad2);
    this._conv(this.pad2, 64, 128, 'conv2.weight', 'conv2.bias', this.c2);

    // fc: 8192 -> 128
    var fcW = this.w['fc.weight'];
    var fcB = this.w['fc.bias'];
    var hidden = this.hidden;
    for (var o = 0; o < 128; o++) {
      var base = o * 8192;
      var sum = fcB[o];
      for (var i = 0; i < 8192; i++) sum += fcW[base + i] * this.c2[i];
      hidden[o] = sum > 0 ? sum : 0;
    }

    // policy: 128 -> 64，再 log_softmax -> exp（等价于直接 softmax）
    var pW = this.w['policy_head.weight'];
    var pB = this.w['policy_head.bias'];
    var logits = this.logits;
    var maxLogit = -Infinity;
    for (var k = 0; k < 64; k++) {
      var kb = k * 128;
      var ps = pB[k];
      for (var j = 0; j < 128; j++) ps += pW[kb + j] * hidden[j];
      logits[k] = ps;
      if (ps > maxLogit) maxLogit = ps;
    }
    var sumExp = 0;
    for (var k2 = 0; k2 < 64; k2++) {
      var e = Math.exp(logits[k2] - maxLogit);
      this.policy[k2] = e;
      sumExp += e;
    }
    var inv = 1 / sumExp;
    for (var k3 = 0; k3 < 64; k3++) this.policy[k3] *= inv;

    // value: 128 -> 1，tanh
    var vW = this.w['value_head.weight'];
    var vB = this.w['value_head.bias'];
    var vs = vB[0];
    for (var v = 0; v < 128; v++) vs += vW[v] * hidden[v];

    return { policy: this.policy, value: Math.tanh(vs) };
  };

  function decodeBase64(b64) {
    if (typeof atob === 'function') {
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
    throw new Error('当前环境无法解码 base64');
  }

  var NetApi = {
    Net: Net,
    decodeBase64: decodeBase64,
    /** 从 URL 加载（Pages 部署） */
    load: function (metaUrl, binUrl) {
      return Promise.all([
        fetch(metaUrl).then(function (r) {
          if (!r.ok) throw new Error('加载 ' + metaUrl + ' 失败：' + r.status);
          return r.json();
        }),
        fetch(binUrl).then(function (r) {
          if (!r.ok) throw new Error('加载 ' + binUrl + ' 失败：' + r.status);
          return r.arrayBuffer();
        })
      ]).then(function (pair) {
        return new Net(pair[0], pair[1]);
      });
    },
    /** 从内联的 meta + base64 权重构造（单文件离线版） */
    fromInline: function (meta, b64) {
      return new Net(meta, decodeBase64(b64));
    }
  };

  if (typeof module === 'object' && module.exports) module.exports = NetApi;
  if (typeof window !== 'undefined') window.OthelloNet = NetApi;
})(typeof globalThis !== 'undefined' ? globalThis : this);
