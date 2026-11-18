/*
 * 生成黑白棋开局库。
 *
 * 目标：给对局脚本一批“合理且互不相同”的前 4 手开局，避免随机开局把局面
 * 打散，也避免确定性引擎反复下同一条线。
 *
 * 过滤规则（黑棋视角的通用开局常识）：
 *   - 不主动下 X 位 / C 位（当相邻角还空着时）；
 *   - 下完之后不能让对手立刻有角可占；
 *   - 同一最终局面只保留一条（去转置）。
 *
 * 排序：角位差 + 行动力差 - 己方棋子数（开局少翻子更好）。
 *
 * 用法：node tools/build-openings.mjs
 * 产物：tools/openings.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const { Board } = require(join(root, 'web', 'engine.js'));

const DEPTH = 4;          // 开局库长度（手）
const TARGET = 48;        // 目标条数
const PER_FIRST = 12;     // 每个第一手取多少条
const SEED = 20261118;

const CORNERS = [0, 7, 56, 63];
const X_SQUARES = [9, 14, 49, 54];
const C_SQUARES = [1, 6, 8, 15, 48, 55, 57, 62];
// 每个 X/C 位相邻的角
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

/** 这一手是不是明显的坏手 */
function isBadMove(board, move, player) {
  if (isCorner(move)) return false;

  // X/C 位：相邻角还空着（或已被对手占）就别下
  if (ADJ_CORNER[move] !== undefined) {
    const corner = ADJ_CORNER[move];
    if (board.cells[corner] !== player) return true;
  }

  // 下完之后对手能直接占角 → 坏手
  const next = board.clone();
  next.stepIndex(move);
  const opp = -player;
  const oppMoves = next.legalMoves(opp);
  for (let i = 0; i < oppMoves.length; i++) {
    if (isCorner(oppMoves[i])) return true;
  }
  return false;
}

/** 四手之后从“当前行棋方”视角做个轻量评估，只用于排序 */
function evalOpening(board) {
  const player = board.currentPlayer;
  const cells = board.cells;
  let cornerDiff = 0;
  for (let i = 0; i < 4; i++) {
    const v = cells[CORNERS[i]];
    if (v === player) cornerDiff++;
    else if (v === -player) cornerDiff--;
  }
  const myMob = board.legalMoves(player).length;
  const oppMob = board.legalMoves(-player).length;
  const [black, white] = board.score();
  const myDiscs = player === 1 ? black : white;
  const oppDiscs = player === 1 ? white : black;
  // 开局阶段：角 > 行动力 > 少翻子
  return cornerDiff * 100 + (myMob - oppMob) * 10 - (myDiscs - oppDiscs) * 0.5;
}

function collect(board, seq, out) {
  if (seq.length === DEPTH) {
    out.push({ moves: seq.slice(), key: Array.from(board.cells).join(','), score: evalOpening(board) });
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

  for (let i = 0; i < moves.length; i++) {
    const move = moves[i];
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

  for (let f = 0; f < firstMoves.length; f++) {
    const first = firstMoves[f];
    const board = start.clone();
    board.stepIndex(first);

    const out = [];
    collect(board, [first], out);

    // 去重 + 按评估分排序
    const seen = new Set();
    const sorted = out
      .filter((c) => {
        if (usedKeys.has(c.key) || seen.has(c.key)) return false;
        seen.add(c.key);
        return true;
      })
      .sort((a, b) => b.score - a.score);

    // 取前一半里随机抽 PER_FIRST 条，保证强度也保证多样
    const pool = sorted.slice(0, Math.max(PER_FIRST * 2, Math.ceil(sorted.length * 0.6)));
    const chosen = shuffle(pool, rng).slice(0, PER_FIRST);

    for (const c of chosen) {
      usedKeys.add(c.key);
      picked.push(c);
    }
  }

  // 再整体打乱一次，避免同一第一手的线路连在一起
  const lines = shuffle(picked, rng).slice(0, TARGET).map((c) => c.moves);

  const payload = {
    version: 1,
    depth: DEPTH,
    seed: SEED,
    count: lines.length,
    note: '前 4 手开局库：过滤 X/C 与“送角”坏手，按角位/行动力排序后抽样；对局脚本每局用一条，保证独立。',
    lines
  };

  const outPath = join(here, 'openings.json');
  writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');

  // 简单自检
  let total = 0;
  const firstCount = new Map();
  for (const line of lines) {
    const b = new Board();
    for (const m of line) {
      const legal = b.legalMoves();
      if (!legal.includes(m)) throw new Error(`开局库非法走法：${line}`);
      b.stepIndex(m);
      total++;
    }
    firstCount.set(line[0], (firstCount.get(line[0]) || 0) + 1);
  }

  console.log(`已生成 ${lines.length} 条，每条 ${DEPTH} 手，共 ${total} 步`);
  console.log('第一手分布：' + [...firstCount.entries()].map(([m, n]) => `${m}:${n}`).join('  '));
  console.log(`文件：${outPath}`);
}

main();
