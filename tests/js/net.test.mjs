/*
 * 浏览器端推理与 PyTorch 的逐值对齐。
 *
 * tests/js/reference.json 由 src/scripts/export_web_weights.py 用 PyTorch 生成，
 * 覆盖开局、中盘、残局与终局。这里要求 JS 前向的结果与它一致——
 * 只要这条测试通过，就能确定「规则→编码→前向」整条链路没有抄错。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { Board } = require(join(here, '..', '..', 'web', 'engine.js'));
const { Net, fetchChunked } = require(join(here, '..', '..', 'web', 'net.js'));

const meta = JSON.parse(readFileSync(join(here, '..', '..', 'web', 'weights.json'), 'utf8'));
const bin = readFileSync(join(here, '..', '..', 'web', 'weights.bin'));
const buffer = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
const reference = JSON.parse(readFileSync(join(here, 'reference.json'), 'utf8'));

const net = new Net(meta, buffer);

function loadBoard(cells) {
  const b = new Board();
  b.cells.set(cells);
  return b;
}

test('权重元信息自洽', () => {
  assert.equal(meta.count, 1132737);
  assert.equal(buffer.byteLength, meta.count * 4);
  assert.equal(bin.length, buffer.byteLength);
  assert.equal(meta.params.length, 10);
});

test('weights.bin 与 weights.json 的 sha256 一致', () => {
  const hash = createHash('sha256').update(Buffer.from(buffer)).digest('hex');
  assert.equal(hash, meta.sha256, '权重文件与元信息不匹配，请重新运行导出脚本');
});

test('前向输出与 PyTorch 一致（policy / value）', () => {
  assert.ok(reference.cases.length >= 4, '参考样本太少');
  let worstPolicy = 0;
  let worstValue = 0;

  for (const c of reference.cases) {
    assert.equal(c.board.length, 64, `局面 ${c.tag} 的棋盘长度不对`);
    const board = loadBoard(c.board);
    const out = net.forward(board.toTensor(c.player));

    let sum = 0;
    for (let i = 0; i < 64; i++) {
      sum += out.policy[i];
      worstPolicy = Math.max(worstPolicy, Math.abs(out.policy[i] - c.policy[i]));
    }
    assert.ok(Math.abs(sum - 1) < 1e-5, `policy 未归一化：${sum}`);
    worstValue = Math.max(worstValue, Math.abs(out.value - c.value));
  }

  assert.ok(worstPolicy < 2e-4, `policy 最大误差 ${worstPolicy} 超出容差`);
  assert.ok(worstValue < 2e-4, `value 最大误差 ${worstValue} 超出容差`);
});

test('同一局面重复前向结果稳定（缓冲区复用无污染）', () => {
  const c = reference.cases[reference.cases.length - 1];
  const board = loadBoard(c.board);
  const a = Array.from(net.forward(board.toTensor(c.player)).policy);
  const b = Array.from(net.forward(board.toTensor(c.player)).policy);
  for (let i = 0; i < 64; i++) assert.equal(a[i], b[i]);
});

test('前向耗时（本机粗测）', () => {
  const board = new Board();
  const t = board.toTensor(1);
  for (let i = 0; i < 5; i++) net.forward(t); // 预热
  const n = 30;
  const start = process.hrtime.bigint();
  for (let i = 0; i < n; i++) net.forward(t);
  const ms = Number(process.hrtime.bigint() - start) / 1e6 / n;
  console.log(`  [bench] 单次前向 ${ms.toFixed(2)} ms（${(1000 / ms).toFixed(0)} 次/秒）`);
  assert.ok(ms < 200, `前向过慢：${ms} ms/次`);
});

// ---------- 分块下载 ----------

function makeBytes(n) {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = i & 0xff;
  return bytes;
}

function makeFetch(bytes, opts = {}) {
  const calls = [];
  let failures = opts.failures || 0;
  const fetchFn = async (url, init = {}) => {
    const range = init.headers && init.headers.Range;
    const m = /bytes=(\d+)-(\d+)/.exec(range || '');
    const start = m ? Number(m[1]) : 0;
    const end = m ? Number(m[2]) : bytes.length - 1;
    calls.push([start, end]);

    if (failures > 0) {
      failures--;
      throw new Error('模拟网络中断');
    }

    const whole = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    if (opts.ignoreRange) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => whole
      };
    }
    const slice = bytes.slice(start, end + 1);
    return {
      ok: true,
      status: start === 0 && end === bytes.length - 1 ? 200 : 206,
      arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength)
    };
  };
  return { fetchFn, calls };
}

test('分块下载：三块拼装正确，进度单调到 100%', async () => {
  const bytes = makeBytes(1_200_000);
  const { fetchFn, calls } = makeFetch(bytes);
  const progress = [];

  const buffer = await fetchChunked(fetchFn, 'weights.bin', bytes.length, {
    chunkSize: 512 * 1024,
    concurrency: 3,
    onProgress: (received, total) => progress.push(received / total)
  });

  assert.equal(buffer.byteLength, bytes.length);
  assert.deepEqual(new Uint8Array(buffer), bytes);
  assert.equal(calls.length, 3);
  assert.equal(progress[progress.length - 1], 1);
  for (let i = 1; i < progress.length; i++) {
    assert.ok(progress[i] >= progress[i - 1], '进度不应回退');
  }
});

test('分块下载：单块失败自动重试', async () => {
  const bytes = makeBytes(700_000);
  const { fetchFn } = makeFetch(bytes, { failures: 1 });

  const buffer = await fetchChunked(fetchFn, 'weights.bin', bytes.length, {
    chunkSize: 512 * 1024,
    concurrency: 1,
    retries: 2
  });

  assert.deepEqual(new Uint8Array(buffer), bytes);
});

test('分块下载：服务器忽略 Range 时退化为整文件', async () => {
  const bytes = makeBytes(600_000);
  const { fetchFn } = makeFetch(bytes, { ignoreRange: true });

  const buffer = await fetchChunked(fetchFn, 'weights.bin', bytes.length, {
    chunkSize: 512 * 1024,
    concurrency: 2
  });

  assert.deepEqual(new Uint8Array(buffer), bytes);
});

test('分块下载：重试耗尽后报错', async () => {
  const bytes = makeBytes(600_000);
  const { fetchFn } = makeFetch(bytes, { failures: 99 });

  await assert.rejects(
    () => fetchChunked(fetchFn, 'weights.bin', bytes.length, {
      chunkSize: 512 * 1024,
      concurrency: 1,
      retries: 2
    }),
    /模拟网络中断/
  );
});

test('分块下载：流式响应按字节上报进度', async () => {
  const bytes = makeBytes(300_000);
  const piece = 16 * 1024;

  const fetchFn = async (url, init = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    const start = Number(m[1]);
    const end = Number(m[2]);
    const slice = bytes.slice(start, end + 1);
    let offset = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (offset >= slice.length) {
          controller.close();
          return;
        }
        const n = Math.min(piece, slice.length - offset);
        controller.enqueue(slice.slice(offset, offset + n));
        offset += n;
      }
    });
    return { ok: true, status: 206, body };
  };

  const progress = [];
  const buffer = await fetchChunked(fetchFn, 'weights.bin', bytes.length, {
    chunkSize: 128 * 1024,
    concurrency: 2,
    onProgress: (received) => progress.push(received)
  });

  assert.deepEqual(new Uint8Array(buffer), bytes);
  assert.ok(progress.length > 4, `进度回调太少：${progress.length}`);
  for (let i = 1; i < progress.length; i++) {
    assert.ok(progress[i] >= progress[i - 1], '进度不应回退');
  }
  assert.equal(progress[progress.length - 1], bytes.length);
});
