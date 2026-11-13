/*
 * 规则引擎测试：从 tests/test_board.py 与 tests/test_encoder.py 逐条移植。
 *
 * 两侧规则必须等价，否则「浏览器版」和「Python 版」会下出不同的棋。
 * 这些用例故意保持与 Python 端同名同义，方便对照维护。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { Board, BLACK, WHITE, EMPTY, rcToIndex, indexToRC } = require(
  join(here, '..', '..', 'web', 'engine.js')
);

test('初始棋盘布局', () => {
  const b = new Board();
  assert.equal(b.at(3, 3), WHITE);
  assert.equal(b.at(3, 4), BLACK);
  assert.equal(b.at(4, 3), BLACK);
  assert.equal(b.at(4, 4), WHITE);
  assert.equal(b.currentPlayer, BLACK);
  assert.equal(b.gameOver, false);
});

test('初始合法走法', () => {
  const b = new Board();
  const moves = new Set(b.legalMoves(BLACK).map((i) => i));
  const expected = new Set([rcToIndex(2, 3), rcToIndex(3, 2), rcToIndex(4, 5), rcToIndex(5, 4)]);
  assert.deepEqual(moves, expected);
});

test('落子后正确翻子', () => {
  const b = new Board();
  const flips = b.step(2, 3);
  // (2,3) 只在正下方夹住 (3,3) 这一枚；(3,4)(4,3) 本来就是黑子
  assert.equal(flips.length, 1);
  assert.equal(b.at(2, 3), BLACK);
  assert.equal(b.at(3, 3), BLACK);
  assert.equal(b.at(3, 4), BLACK);
  assert.equal(b.at(4, 3), BLACK);
  assert.deepEqual(b.score(), [4, 1]);
});

test('非法落子抛错', () => {
  const b = new Board();
  assert.throws(() => b.step(0, 0), /Illegal move/);
});

test('clone 相互独立', () => {
  const b = new Board();
  const b2 = b.clone();
  b2.step(2, 3);
  assert.equal(b.at(2, 3), EMPTY);
  assert.equal(b2.at(2, 3), BLACK);
});

test('满盘判终局', () => {
  const b = new Board();
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      b.cells[rcToIndex(r, c)] = (r + c) % 2 === 0 ? BLACK : WHITE;
    }
  }
  b.gameOver = false;
  b.currentPlayer = BLACK;
  assert.equal(b.isTerminal(), true);
});

test('无子可下时自动跳过，双方皆无则终局', () => {
  // 构造一个黑棋下完后白棋无步可走、黑棋仍可走的局面不容易，
  // 这里退一步验证：跳过逻辑不允许出现「轮到没有合法步的一方」。
  const b = new Board();
  let guard = 0;
  let seed = 12345;
  while (!b.isTerminal() && guard < 200) {
    const moves = b.legalMoves();
    if (moves.length === 0) throw new Error('轮到的一方没有合法步，step 的跳过逻辑失效');
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const move = moves[seed % moves.length];
    b.stepIndex(move);
    guard++;
  }
  assert.ok(b.isTerminal());
});

// ---------- 编码器（对应 tests/test_encoder.py） ----------

test('张量形状与类型', () => {
  const t = new Board().toTensor(BLACK);
  assert.equal(t.length, 3 * 64);
  assert.ok(t instanceof Float32Array);
});

test('开局通道计数：双方各两枚', () => {
  const t = new Board().toTensor(BLACK);
  let c0 = 0;
  let c1 = 0;
  for (let i = 0; i < 64; i++) {
    c0 += t[i];
    c1 += t[64 + i];
  }
  assert.equal(c0, 2);
  assert.equal(c1, 2);
});

test('黑白视角下通道 0/1 互换', () => {
  const b = new Board();
  const black = b.toTensor(BLACK);
  const white = b.toTensor(WHITE);
  for (let i = 0; i < 64; i++) {
    assert.equal(black[i], white[64 + i]);
    assert.equal(black[64 + i], white[i]);
  }
});

test('通道 2 是先后手标记', () => {
  const b = new Board();
  const black = b.toTensor(BLACK);
  const white = b.toTensor(WHITE);
  for (let i = 128; i < 192; i++) {
    assert.equal(black[i], 1);
    assert.equal(white[i], 0);
  }
});

test('通道 0/1 互斥', () => {
  const t = new Board().toTensor(BLACK);
  for (let i = 0; i < 64; i++) assert.ok(!(t[i] === 1 && t[64 + i] === 1));
});

test('走法索引往返', () => {
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      assert.deepEqual(indexToRC(rcToIndex(r, c)), [r, c]);
    }
  }
});

test('四角索引', () => {
  assert.equal(rcToIndex(0, 0), 0);
  assert.equal(rcToIndex(0, 7), 7);
  assert.equal(rcToIndex(7, 0), 56);
  assert.equal(rcToIndex(7, 7), 63);
});
