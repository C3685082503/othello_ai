/*
 * 端到端冒烟：用真实权重跑完整对局。
 *
 * 不追求棋力断言（那是模型评估的事），只验证：
 *   - 200 次模拟能在可接受时间内返回合法步
 *   - 一整局不会出现非法状态、不会卡死、必定终局
 *   - 搜索确实比随机走子强
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { Board, BLACK, WHITE } = require(join(here, '..', '..', 'web', 'engine.js'));
const { Net } = require(join(here, '..', '..', 'web', 'net.js'));
const { MCTS } = require(join(here, '..', '..', 'web', 'mcts.js'));

const meta = JSON.parse(readFileSync(join(here, '..', '..', 'web', 'weights.json'), 'utf8'));
const bin = readFileSync(join(here, '..', '..', 'web', 'weights.bin'));
const net = new Net(meta, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));

function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('200 次模拟：合法步 + 耗时可控', async () => {
  const mcts = new MCTS(net, { cPuct: 1.5 });
  const board = new Board();
  const start = Date.now();
  const result = await mcts.search(board, BLACK, { sims: 200 });
  const ms = Date.now() - start;

  assert.ok(result.move !== null);
  assert.ok(board.legalMoves(BLACK).includes(result.move), '返回了非法步');
  assert.equal(result.sims, 200);
  assert.ok(result.visits > 0);
  assert.ok(Math.abs(result.value) <= 1);
  console.log(`  [bench] 200 次模拟 ${ms} ms（${(ms / 200).toFixed(1)} ms/模拟）`);
  assert.ok(ms < 4000, `搜索过慢：${ms} ms`);
});

test('完整对局：MCTS(24) vs 随机，全程合法且终局', async () => {
  const mcts = new MCTS(net, { cPuct: 1.5 });
  const board = new Board();
  const rng = makeRng(20240917);
  let plies = 0;

  while (!board.isTerminal() && plies < 200) {
    const player = board.currentPlayer;
    const legal = board.legalMoves(player);
    assert.ok(legal.length > 0, '轮到的一方必须有合法步');

    let move;
    if (player === BLACK) {
      move = (await mcts.search(board, player, { sims: 24 })).move;
    } else {
      move = legal[Math.floor(rng() * legal.length)];
    }
    assert.ok(legal.includes(move), `第 ${plies} 手出现非法步 ${move}`);

    board.stepIndex(move);
    plies++;
  }

  assert.ok(board.isTerminal(), '对局没有正常结束');
  const [black, white] = board.score();
  assert.equal(black + white <= 64, true);
  assert.equal(black + white + board.emptyCount(), 64);
  console.log(`  [game] ${plies} 手结束，黑 ${black} : 白 ${white}`);
});

test('搜索强度：MCTS(32) 明显强于随机', async () => {
  const mcts = new MCTS(net, { cPuct: 1.5 });
  const rng = makeRng(777);
  let mctsWins = 0;
  const games = 2;

  for (let g = 0; g < games; g++) {
    const board = new Board();
    const mctsIsBlack = g % 2 === 0;
    let plies = 0;
    while (!board.isTerminal() && plies < 200) {
      const player = board.currentPlayer;
      const legal = board.legalMoves(player);
      const mctsTurn = (player === BLACK) === mctsIsBlack;
      const move = mctsTurn
        ? (await mcts.search(board, player, { sims: 32 })).move
        : legal[Math.floor(rng() * legal.length)];
      board.stepIndex(move);
      plies++;
    }
    const winner = board.winner();
    const mctsSide = mctsIsBlack ? BLACK : WHITE;
    if (winner === mctsSide) mctsWins++;
  }

  assert.ok(mctsWins >= 1, `MCTS 只赢了 ${mctsWins}/${games} 局`);
  console.log(`  [game] MCTS 对随机 ${mctsWins}/${games}`);
});
