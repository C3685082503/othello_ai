/*
 * MCTS 树复用测试。
 *
 * 复用不是「必须复用」的优化：找不到匹配节点时应当自动退回新建树，
 * 所以这里同时验证「命中」和「未命中」两条路径。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { Board } = require(join(here, '..', '..', 'web', 'engine.js'));
const { Net } = require(join(here, '..', '..', 'web', 'net.js'));
const { MCTS } = require(join(here, '..', '..', 'web', 'mcts.js'));

const meta = JSON.parse(readFileSync(join(here, '..', '..', 'web', 'weights.json'), 'utf8'));
const bin = readFileSync(join(here, '..', '..', 'web', 'weights.bin'));
const net = new Net(meta, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));

test('树复用：走完一手再轮到我方时能命中旧树', async () => {
  const mcts = new MCTS(net, { cPuct: 1.5 });
  const board = new Board();
  const player = board.currentPlayer;

  const first = await mcts.search(board, player, { sims: 40 });
  assert.equal(first.reused, false, '第一次搜索没有旧树');

  board.stepIndex(first.move);
  const replies = board.legalMoves();
  assert.ok(replies.length > 0, '开局阶段对手应当有合法步');
  board.stepIndex(replies[0]);

  const second = await mcts.search(board, board.currentPlayer, { sims: 40, reuse: true });
  assert.equal(second.reused, true, '应当命中上一棵搜索树');
  assert.ok(board.legalMoves(board.currentPlayer).includes(second.move), '复用后返回了非法步');
  assert.ok(second.sims > 0);
});

test('树复用：局面不匹配时自动退回新建', async () => {
  const mcts = new MCTS(net, { cPuct: 1.5 });
  const firstBoard = new Board();
  // 只跑 1 次模拟：树最多展开到第 2 层
  await mcts.search(firstBoard, firstBoard.currentPlayer, { sims: 1 });

  // 连走 3 手，必然不在旧树里
  const other = new Board();
  for (let i = 0; i < 3; i++) other.stepIndex(other.legalMoves()[0]);
  const result = await mcts.search(other, other.currentPlayer, { sims: 10, reuse: true });

  assert.equal(result.reused, false);
  assert.ok(other.legalMoves(other.currentPlayer).includes(result.move));
});

test('树复用：resetCache 之后不再命中', async () => {
  const mcts = new MCTS(net, { cPuct: 1.5 });
  const board = new Board();

  const first = await mcts.search(board, board.currentPlayer, { sims: 30 });
  board.stepIndex(first.move);
  board.stepIndex(board.legalMoves()[0]);
  const hit = await mcts.search(board, board.currentPlayer, { sims: 10, reuse: true });
  assert.equal(hit.reused, true);

  mcts.resetCache();
  const afterReset = await mcts.search(board, board.currentPlayer, { sims: 10, reuse: true });
  assert.equal(afterReset.reused, false);
});
