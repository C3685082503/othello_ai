/*
 * 残局收益基准：在 11 空位局面下，比较 MCTS(160) 的选择与精确解的最优值。
 *
 * 用途：回答「残局精算到底值不值」。不依赖 Alpha-Beta 对手，也不受对局时长影响。
 * 用法：node tools/bench-endgame.mjs [局面数]
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const { Board } = require(join(root, 'web', 'engine.js'));
const { solve } = require(join(root, 'web', 'endgame.js'));
const { Net } = require(join(root, 'web', 'net.js'));
const { MCTS } = require(join(root, 'web', 'mcts.js'));

const meta = JSON.parse(readFileSync(join(root, 'web', 'weights.json'), 'utf8'));
const bin = readFileSync(join(root, 'web', 'weights.bin'));
const net = new Net(meta, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));

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

function exactValueOfMove(board, player, move) {
  const next = board.clone();
  next.stepIndex(move);
  if (next.isTerminal()) {
    const [b, w] = next.score();
    return (b - w) * player;
  }
  const opponent = solve(next, next.currentPlayer, { maxEmpty: 12, budgetMs: 2000 });
  return -opponent.score;
}

const count = Number(process.argv[2] || 8);
const mcts = new MCTS(net, { cPuct: 1.5 });
let worse = 0;
let totalGap = 0;
let maxGap = 0;

console.log('seed  empties exact  mcts   gap   exactMs  mctsMs');
for (let i = 0; i < count; i++) {
  const seed = 1000 + i * 37;
  const board = randomBoard(11, seed);
  const player = board.currentPlayer;

  const t0 = Date.now();
  const exact = solve(board, player, { maxEmpty: 12, budgetMs: 2000 });
  const exactMs = Date.now() - t0;

  const t1 = Date.now();
  const picked = await mcts.search(board, player, { sims: 160 });
  const mctsMs = Date.now() - t1;

  const mctsValue = exactValueOfMove(board, player, picked.move);
  const gap = exact.score - mctsValue;
  if (gap > 0) worse++;
  totalGap += gap;
  maxGap = Math.max(maxGap, gap);

  console.log(
    String(seed).padEnd(6) +
    String(board.emptyCount()).padEnd(5) +
    String(exact.score).padEnd(8) +
    String(mctsValue).padEnd(8) +
    String(gap).padEnd(6) +
    String(exactMs + 'ms').padEnd(10) +
    mctsMs + 'ms'
  );
}

console.log('\npositions: ' + count);
console.log('MCTS suboptimal: ' + worse + '/' + count);
console.log('avg disc gap: ' + (totalGap / count).toFixed(2));
console.log('max disc gap: ' + maxGap);
