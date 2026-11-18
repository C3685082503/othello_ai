/*
 * 开局库自检：合法性、唯一性、以及“不送角”的质量约束。
 *
 * 这些约束和 tools/build-openings.mjs 的生成规则一致，
 * 改生成器或手工改开局库时都必须过这一关。
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

const book = JSON.parse(readFileSync(join(here, '..', '..', 'tools', 'openings.json'), 'utf8'));

const CORNERS = new Set([0, 7, 56, 63]);
const ADJ_CORNER = {
  9: 0, 14: 7, 49: 56, 54: 63,
  1: 0, 6: 7, 8: 0, 15: 7,
  48: 56, 55: 63, 57: 56, 62: 63
};

test('开局库规模与长度', () => {
  assert.ok(Array.isArray(book.lines));
  assert.equal(book.depth, 4);
  assert.ok(book.lines.length >= 40, `开局库太少：${book.lines.length}`);
  for (const line of book.lines) {
    assert.equal(line.length, 4, `线路长度不对：${line}`);
  }
});

test('每一条线路都合法，且终局局面唯一', () => {
  const keys = new Set();
  for (const line of book.lines) {
    const board = new Board();
    for (const move of line) {
      assert.ok(board.legalMoves().includes(move), `非法走法 ${move}：${line}`);
      board.stepIndex(move);
    }
    const key = Array.from(board.cells).join(',');
    assert.ok(!keys.has(key), `重复的终局局面：${line}`);
    keys.add(key);
  }
  assert.equal(keys.size, book.lines.length);
});

test('不主动下 X/C 位，也不把角送给对手', () => {
  for (const line of book.lines) {
    const board = new Board();
    for (const move of line) {
      const player = board.currentPlayer;

      if (!CORNERS.has(move) && ADJ_CORNER[move] !== undefined) {
        assert.equal(
          board.cells[ADJ_CORNER[move]],
          player,
          `在角还空着时下了 X/C 位：${move}，线路 ${line}`
        );
      }

      board.stepIndex(move);
      const opp = -player;
      for (const m of board.legalMoves(opp)) {
        assert.ok(!CORNERS.has(m), `下完 ${move} 后把角送给了对手，线路 ${line}`);
      }
    }
  }
});

test('四个第一手分布均衡', () => {
  const counts = new Map();
  for (const line of book.lines) {
    counts.set(line[0], (counts.get(line[0]) || 0) + 1);
  }
  assert.equal(counts.size, 4);
  for (const [move, n] of counts) {
    assert.ok(n >= 10, `第一手 ${move} 只有 ${n} 条`);
  }
});
