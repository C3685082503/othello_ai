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
const { Net } = require(join(here, '..', '..', 'web', 'net.js'));

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
