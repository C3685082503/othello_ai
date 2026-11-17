/*
 * 残局精确求解的测试。
 *
 * 正确性用「朴素极小极大」做对照：在 ≤6 空位的随机局面上，穷举所有走法，
 * 两边算出的分值必须完全相等。这比断言某个具体走法可靠得多——同一个分值
 * 可能有多个等价走法。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { Board, legalIndices, flipsFor } = require(join(here, '..', '..', 'web', 'engine.js'));
const { solve } = require(join(here, '..', '..', 'web', 'endgame.js'));

function scoreDiff(cells, player) {
  let d = 0;
  for (let i = 0; i < 64; i++) {
    if (cells[i] === player) d++;
    else if (cells[i] === -player) d--;
  }
  return d;
}

/** 没有剪枝的参照实现，只用于 ≤6 空位 */
function naive(cells, player) {
  const moves = legalIndices(cells, player);
  if (moves.length === 0) {
    if (legalIndices(cells, -player).length === 0) return scoreDiff(cells, player);
    return -naive(cells, -player);
  }
  let best = -Infinity;
  for (const m of moves) {
    const flips = flipsFor(cells, m >> 3, m & 7, player);
    cells[m] = player;
    for (const f of flips) cells[f] = player;
    const v = -naive(cells, -player);
    cells[m] = 0;
    for (const f of flips) cells[f] = -player;
    if (v > best) best = v;
  }
  return best;
}

function randomBoard(maxEmpty, seed) {
  const board = new Board();
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  let guard = 0;
  while (board.emptyCount() > maxEmpty && !board.isTerminal() && guard++ < 300) {
    const moves = board.legalMoves();
    if (moves.length === 0) {
      board.currentPlayer = -board.currentPlayer;
      continue;
    }
    board.stepIndex(moves[Math.floor(rnd() * moves.length)]);
  }
  return board;
}

test('空位超过上限时返回 null', () => {
  const board = new Board();
  assert.equal(solve(board, 1, { maxEmpty: 6 }), null);
});

test('与朴素极小极大的分值完全一致（≤6 空位）', () => {
  for (const seed of [11, 2024, 777777]) {
    const board = randomBoard(6, seed);
    assert.ok(!board.isTerminal(), `seed ${seed} 生成的是终局，换一个种子`);
    assert.ok(board.emptyCount() <= 6, `seed ${seed} 空位数量不对`);

    const expected = naive(board.cells.slice(), board.currentPlayer);
    const result = solve(board, board.currentPlayer, { maxEmpty: 6, budgetMs: 5000 });

    assert.ok(result, '应当返回结果');
    assert.equal(result.complete, true);
    assert.equal(result.score, expected, `seed ${seed} 分值不一致`);

    // 走这一步之后，从对手视角的精确值应当等于 -expected
    const next = board.clone();
    next.stepIndex(result.move);
    assert.equal(-naive(next.cells.slice(), next.currentPlayer), expected, `seed ${seed} 选出的走法不等价`);
  }
});

test('空位 = 1 时只有唯一合法步', () => {
  // 构造一个只剩一个空位的局面
  const board = new Board();
  const empties = [];
  for (let i = 0; i < 64; i++) empties.push(i);
  // 用随机对局逼近终局，然后手工留一个空位
  let guard = 0;
  while (board.emptyCount() > 0 && !board.isTerminal() && guard++ < 200) {
    const moves = board.legalMoves();
    if (moves.length === 0) {
      board.currentPlayer = -board.currentPlayer;
      continue;
    }
    if (board.emptyCount() === 1) break;
    board.stepIndex(moves[0]);
  }
  if (board.emptyCount() !== 1) return; // 该种子没走到一格，跳过
  const legal = board.legalMoves();
  assert.equal(legal.length, 1);
  const result = solve(board, board.currentPlayer, { maxEmpty: 6, budgetMs: 5000 });
  assert.equal(result.move, legal[0]);
  assert.equal(result.complete, true);
});

test('10 空位：能在预算内算完，并给出合法步', () => {
  for (const seed of [424242, 99991]) {
    const board = randomBoard(10, seed);
    const player = board.currentPlayer;
    const legal = board.legalMoves(player);
    const started = Date.now();
    const result = solve(board, player, { maxEmpty: 10, budgetMs: 2000 });
    const ms = Date.now() - started;

    assert.ok(result, '应当返回结果');
    assert.ok(legal.includes(result.move), '返回了非法步');
    console.log(`  [endgame] seed=${seed} 空位=${board.emptyCount()} 节点=${result.nodes} 耗时=${ms}ms 完成=${result.complete}`);
    assert.equal(result.complete, true, '10 空位不应超时');
    assert.ok(ms < 3000, `10 空位过慢：${ms}ms`);
  }
});
