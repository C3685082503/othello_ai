/*
 * 中性开局库：只过滤明显坏手（X/C、送角），不按任何一方评分挑选。
 *
 * 和 tools/build-openings.mjs 的区别：
 *   - 深度 3 手（黑、白、黑），之后轮到白棋，AI 自己下第二手；
 *   - 均匀抽样，不做“对黑有利/对白有利”的排序，避免测试集偏向某一方。
 *
 * 用法：node tools/build-openings-neutral.mjs
 * 产物：tools/openings-neutral.json
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const { Board } = require(join(root, 'web', 'engine.js'));

const DEPTH = 3;
const PER_FIRST = 12;
const SEED = 20261118;

const CORNERS = [0, 7, 56, 63];
const ADJ_CORNER = {
  9: 0, 14: 7, 49: 56, 54: 63,
  1: 0, 6: 7, 8: 0, 15: 7,
  48: 56, 55: 63, 57: 56, 62: 63
};

function isCorner(idx) {
  return CORNERS.indexOf(idx) >= 0;
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

function isBadMove(board, move, player) {
  if (isCorner(move)) return false;
  if (ADJ_CORNER[move] !== undefined && board.cells[ADJ_CORNER[move]] !== player) return true;

  const next = board.clone();
  next.stepIndex(move);
  const oppMoves = next.legalMoves(-player);
  for (let i = 0; i < oppMoves.length; i++) {
    if (isCorner(oppMoves[i])) return true;
  }
  return false;
}

function collect(board, seq, out) {
  if (seq.length === DEPTH) {
    out.push({ moves: seq.slice(), key: Array.from(board.cells).join(',') });
    return;
  }
  const player = board.currentPlayer;
  const moves = board.legalMoves(player);
  if (moves.length === 0) {
    const passed = board.clone();
    passed.currentPlayer = -player;
    collect(passed, seq, out);
    return;
  }
  for (const move of moves) {
    if (isBadMove(board, move, player)) continue;
    const next = board.clone();
    next.stepIndex(move);
    seq.push(move);
    collect(next, seq, out);
    seq.pop();
  }
}

function main() {
  const start = new Board();
  const firstMoves = start.legalMoves();
  const rng = mulberry32(SEED);
  const picked = [];
  const usedKeys = new Set();

  for (const first of firstMoves) {
    const board = start.clone();
    board.stepIndex(first);

    const out = [];
    collect(board, [first], out);

    const seen = new Set();
    const candidates = out.filter((c) => {
      if (usedKeys.has(c.key) || seen.has(c.key)) return false;
      seen.add(c.key);
      return true;
    });

    const chosen = shuffle(candidates, rng).slice(0, PER_FIRST);
    for (const c of chosen) {
      usedKeys.add(c.key);
      picked.push(c);
    }
  }

  const lines = shuffle(picked, rng).map((c) => c.moves);
  const payload = {
    version: 1,
    depth: DEPTH,
    seed: SEED,
    count: lines.length,
    note: '中性开局库：前 3 手只过滤 X/C 与送角，不按任何一方评分挑选；之后白棋（AI）行棋。',
    lines
  };
  const outPath = join(here, 'openings-neutral.json');
  writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');

  // 自检
  const keys = new Set();
  const firstCount = new Map();
  for (const line of lines) {
    const b = new Board();
    for (const m of line) {
      if (!b.legalMoves().includes(m)) throw new Error(`非法：${line}`);
      b.stepIndex(m);
    }
    const k = Array.from(b.cells).join(',');
    if (keys.has(k)) throw new Error(`重复：${line}`);
    keys.add(k);
    firstCount.set(line[0], (firstCount.get(line[0]) || 0) + 1);
  }

  console.log(`已生成 ${lines.length} 条，每条 ${DEPTH} 手`);
  console.log('第一手分布：' + [...firstCount.entries()].map(([m, n]) => `${m}:${n}`).join('  '));
  console.log(`文件：${outPath}`);
}

main();
