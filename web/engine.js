/*
 * Othello 规则引擎（浏览器端）
 *
 * 语义与 src/game_engine/board.py 严格一致，逐条对应：
 *   - 落子后若对手无合法步但自己还有，则自己连走（Othello 的「跳过」规则）
 *   - 双方都无合法步 → game_over，current_player 切换为对手
 *   - is_terminal() 额外检查双方合法步，防止 clone 出来的局面漏判
 *
 * 棋盘用 Int8Array(64) 存，索引 = r * 8 + c。相比 Python 的 list-of-list，
 * 这样在 MCTS 里做 clone/step 更快，且天然对应网络的 64 维走法索引。
 */
(function (global) {
  'use strict';

  var SIZE = 8;
  var EMPTY = 0;
  var BLACK = 1;
  var WHITE = -1;

  var DIRS = [
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1], [0, 1],
    [1, -1], [1, 0], [1, 1]
  ];

  function rcToIndex(r, c) {
    return r * 8 + c;
  }

  function indexToRC(i) {
    return [i >> 3, i & 7];
  }

  /** 在 (r,c) 落子时能翻转的所有格子索引 */
  function flipsFor(cells, r, c, player) {
    var out = [];
    if (r < 0 || r > 7 || c < 0 || c > 7) return out;
    var here = r * 8 + c;
    if (cells[here] !== EMPTY) return out;

    var opp = -player;
    for (var d = 0; d < 8; d++) {
      var dr = DIRS[d][0];
      var dc = DIRS[d][1];
      var rr = r + dr;
      var cc = c + dc;
      var count = 0;
      while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && cells[rr * 8 + cc] === opp) {
        rr += dr;
        cc += dc;
        count++;
      }
      if (count === 0) continue;
      if (!(rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && cells[rr * 8 + cc] === player)) continue;

      var r2 = r + dr;
      var c2 = c + dc;
      for (var i = 0; i < count; i++) {
        out.push(r2 * 8 + c2);
        r2 += dr;
        c2 += dc;
      }
    }
    return out;
  }

  /** 只判断合法性，不分配数组（legalMoves 的热路径） */
  function hasFlips(cells, r, c, player) {
    if (r < 0 || r > 7 || c < 0 || c > 7) return false;
    if (cells[r * 8 + c] !== EMPTY) return false;

    var opp = -player;
    for (var d = 0; d < 8; d++) {
      var dr = DIRS[d][0];
      var dc = DIRS[d][1];
      var rr = r + dr;
      var cc = c + dc;
      var count = 0;
      while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && cells[rr * 8 + cc] === opp) {
        rr += dr;
        cc += dc;
        count++;
      }
      if (count > 0 && rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && cells[rr * 8 + cc] === player) {
        return true;
      }
    }
    return false;
  }

  function legalIndices(cells, player) {
    var moves = [];
    for (var i = 0; i < 64; i++) {
      if (cells[i] !== EMPTY) continue;
      if (hasFlips(cells, i >> 3, i & 7, player)) moves.push(i);
    }
    return moves;
  }

  function countPieces(cells, player) {
    var n = 0;
    for (var i = 0; i < 64; i++) if (cells[i] === player) n++;
    return n;
  }

  function Board() {
    this.cells = new Int8Array(64);
    this.currentPlayer = BLACK;
    this.gameOver = false;
    this.reset();
  }

  Board.prototype.reset = function () {
    this.cells.fill(EMPTY);
    // 与 Python 一致：(3,3)(4,4) 白，(3,4)(4,3) 黑
    this.cells[rcToIndex(3, 3)] = WHITE;
    this.cells[rcToIndex(4, 4)] = WHITE;
    this.cells[rcToIndex(3, 4)] = BLACK;
    this.cells[rcToIndex(4, 3)] = BLACK;
    this.currentPlayer = BLACK;
    this.gameOver = false;
    return this;
  };

  Board.prototype.clone = function () {
    var b = Object.create(Board.prototype);
    b.cells = this.cells.slice();
    b.currentPlayer = this.currentPlayer;
    b.gameOver = this.gameOver;
    return b;
  };

  Board.prototype.at = function (r, c) {
    return this.cells[r * 8 + c];
  };

  Board.prototype.inBounds = function (r, c) {
    return r >= 0 && r < 8 && c >= 0 && c < 8;
  };

  Board.prototype.flips = function (r, c, player) {
    if (player === undefined) player = this.currentPlayer;
    return flipsFor(this.cells, r, c, player);
  };

  Board.prototype.isLegal = function (r, c, player) {
    if (player === undefined) player = this.currentPlayer;
    return hasFlips(this.cells, r, c, player);
  };

  Board.prototype.legalMoves = function (player) {
    if (player === undefined) player = this.currentPlayer;
    return legalIndices(this.cells, player);
  };

  Board.prototype.hasLegal = function (player) {
    return legalIndices(this.cells, player).length > 0;
  };

  Board.prototype.step = function (r, c) {
    if (this.gameOver) throw new Error('Game is over');
    var player = this.currentPlayer;
    var flips = flipsFor(this.cells, r, c, player);
    if (flips.length === 0) throw new Error('Illegal move: (' + r + ',' + c + ')');

    var idx = r * 8 + c;
    this.cells[idx] = player;
    for (var i = 0; i < flips.length; i++) this.cells[flips[i]] = player;

    var next = -player;
    if (legalIndices(this.cells, next).length > 0) {
      this.currentPlayer = next;
    } else if (legalIndices(this.cells, player).length > 0) {
      this.currentPlayer = player;
    } else {
      this.gameOver = true;
      this.currentPlayer = next;
    }
    return flips;
  };

  Board.prototype.stepIndex = function (idx) {
    return this.step(idx >> 3, idx & 7);
  };

  Board.prototype.isTerminal = function () {
    if (this.gameOver) return true;
    return legalIndices(this.cells, BLACK).length === 0 && legalIndices(this.cells, WHITE).length === 0;
  };

  Board.prototype.score = function () {
    return [countPieces(this.cells, BLACK), countPieces(this.cells, WHITE)];
  };

  Board.prototype.winner = function () {
    var s = this.score();
    if (s[0] > s[1]) return BLACK;
    if (s[1] > s[0]) return WHITE;
    return 0;
  };

  Board.prototype.emptyCount = function () {
    var n = 0;
    for (var i = 0; i < 64; i++) if (this.cells[i] === EMPTY) n++;
    return n;
  };

  /**
   * 转成网络输入：[3, 8, 8] 展平成 192 个 float32。
   * 通道 0 = 当前视角的棋子，通道 1 = 对手棋子，通道 2 = 全 1/全 0 的先后手标记。
   * 与 src/alphazero/encoder.py 的 board_to_tensor 完全一致。
   */
  Board.prototype.toTensor = function (player) {
    if (player === undefined) player = this.currentPlayer;
    var t = new Float32Array(192);
    var opp = -player;
    for (var i = 0; i < 64; i++) {
      var v = this.cells[i];
      if (v === player) t[i] = 1;
      else if (v === opp) t[64 + i] = 1;
    }
    if (player === BLACK) t.fill(1, 128, 192);
    return t;
  };

  Board.prototype.toString = function () {
    var map = { '-1': 'O', '0': '.', '1': 'X' };
    var lines = ['  0 1 2 3 4 5 6 7'];
    for (var r = 0; r < 8; r++) {
      var row = [];
      for (var c = 0; c < 8; c++) row.push(map[String(this.cells[r * 8 + c])]);
      lines.push(r + ' ' + row.join(' '));
    }
    return lines.join('\n');
  };

  var api = {
    Board: Board,
    SIZE: SIZE,
    EMPTY: EMPTY,
    BLACK: BLACK,
    WHITE: WHITE,
    DIRS: DIRS,
    rcToIndex: rcToIndex,
    indexToRC: indexToRC,
    flipsFor: flipsFor,
    hasFlips: hasFlips,
    legalIndices: legalIndices
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.OthelloEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
