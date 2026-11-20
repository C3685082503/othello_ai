import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

const { Board, BLACK, WHITE } = require(join(root, 'web', 'engine.js'));
const { Net } = require(join(root, 'web', 'net.js'));
const mctsApi = require(join(root, 'web', 'mcts.js'));

// coach.js 在加载时读取 window/globalThis.OthelloMCTS
globalThis.OthelloMCTS = mctsApi;
const { Coach, boardKey, moveName } = require(join(root, 'web', 'coach.js'));

const meta = JSON.parse(readFileSync(join(root, 'web', 'weights.json'), 'utf8'));
const bin = readFileSync(join(root, 'web', 'weights.bin'));
const net = new Net(meta, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));

test('教练分析返回合法手和全部 moveValues', async () => {
  const board = new Board();
  const coach = new Coach(net, { sims: 24 });
  const res = await coach.analyze(board, BLACK, { sims: 24 });

  assert.ok(res.move !== null, '应给出一个走法');
  assert.ok(board.legalMoves(BLACK).includes(res.move), '走法必须合法');
  assert.equal(res.moveValues.length, board.legalMoves(BLACK).length, 'moveValues 应覆盖全部合法手');
  for (const m of res.moveValues) {
    assert.ok(m.q >= -1.01 && m.q <= 1.01, `q 越界: ${m.q}`);
  }
  assert.ok(res.value >= -1 && res.value <= 1);
});

test('最佳手损失为 0，差手损失为正', async () => {
  const board = new Board();
  const coach = new Coach(net, { sims: 32 });
  const res = await coach.analyze(board, BLACK, { sims: 32 });

  const first = coach.judge(res, res.move);
  assert.ok(first, '应能判定');
  const judgedBest = coach.judge(res, first.best.move);
  assert.ok(Math.abs(judgedBest.loss) < 1e-9, '最佳手损失应为 0');

  // 找到 Q 最低的一手，和最佳比较
  const sorted = res.moveValues.slice().sort((a, b) => a.q - b.q);
  const worst = sorted[0];
  const judgedWorst = coach.judge(res, worst.move);
  assert.ok(judgedWorst.loss >= judgedBest.loss, '差手的损失应不小于最佳手');
});

test('解释器能识别送角和 X/C', () => {
  const board = new Board();
  const coach = new Coach(net, { sims: 16 });
  const legal = board.legalMoves(BLACK);
  const out = coach.explain(board, legal[0], 0.2);
  assert.ok(typeof out.reason === 'string' && out.reason.length > 0);
  assert.ok(Array.isArray(out.tags));
});

test('快速回退返回有限估值和参考手', () => {
  const board = new Board();
  const coach = new Coach(net, { sims: 16 });
  const legal = board.legalMoves(BLACK);
  const q = coach.quick(board, BLACK, legal[0]);
  assert.ok(Number.isFinite(q.delta));
  assert.ok(legal.includes(q.bestMove), '参考手必须合法');
});

test('传入错误行棋方时以棋盘为准', async () => {
  const board = new Board();
  const coach = new Coach(net, { sims: 8 });
  const res = await coach.analyze(board, WHITE, { sims: 8 });
  assert.ok(res.move !== null);
  assert.ok(board.legalMoves(BLACK).includes(res.move), '应按黑方行棋');
});

test('boardKey 区分行棋方', () => {
  const board = new Board();
  assert.notEqual(boardKey(board), boardKey(Object.assign(board.clone(), { currentPlayer: WHITE })));
  assert.equal(moveName(0), 'A1');
  assert.equal(moveName(63), 'H8');
});
