/*
 * 残局精确求解（alpha-beta 穷举）
 *
 * 为什么需要：MCTS + 价值网络在最后十几手仍然是在「估」，估值偏一点就会把
 * 已经赢下的棋送掉。空位 ≤ 10 时分支很少，完全可以算到终局，得到精确结果。
 *
 * 实现要点：
 *   - 直接在 Int8Array 上落子/翻子/撤销，不 clone Board，避免 GC 压力
 *   - 负极大 + alpha-beta + 位置排序（角优先）
 *   - 节点数/耗时双预算，超时返回当前最好的一手并标记 incomplete
 *   - 终局分值 = 我方棋子数 - 对方棋子数，与胜负完全一致
 *
 * 依赖 engine.js：legalIndices / flipsFor（浏览器里是全局 OthelloEngine）。
 */
(function (global) {
  'use strict';

  var isNode = typeof module === 'object' && module.exports;
  var engine = isNode ? require('./engine.js') : global.OthelloEngine;
  var legalIndices = engine.legalIndices;
  var flipsFor = engine.flipsFor;

  // 走法排序用：角最好，X/C 位最差，边次之。只影响搜索速度，不影响结果。
  var POS = (function () {
    var w = new Int16Array(64);
    for (var i = 0; i < 64; i++) {
      var r = i >> 3;
      var c = i & 7;
      var corner = (r === 0 || r === 7) && (c === 0 || c === 7);
      var edge = r === 0 || r === 7 || c === 0 || c === 7;
      var xsq = (r === 1 || r === 6) && (c === 1 || c === 6);
      var csq = ((r === 0 || r === 7) && (c === 1 || c === 6)) ||
                ((c === 0 || c === 7) && (r === 1 || r === 6));
      w[i] = corner ? 1000 : xsq ? -300 : csq ? -200 : edge ? 50 : 0;
    }
    return w;
  })();

  function scoreDiff(cells, player) {
    var diff = 0;
    for (var i = 0; i < 64; i++) {
      if (cells[i] === player) diff++;
      else if (cells[i] === -player) diff--;
    }
    return diff;
  }

  function orderMoves(moves) {
    moves.sort(function (a, b) { return POS[b] - POS[a]; });
  }

  function search(cells, player, alpha, beta, ctx) {
    ctx.nodes++;
    if ((ctx.nodes & 2047) === 0) {
      if (ctx.nodes > ctx.nodeLimit || Date.now() > ctx.deadline) ctx.aborted = true;
    }
    if (ctx.aborted) return alpha;

    var moves = legalIndices(cells, player);
    if (moves.length === 0) {
      // 自己无子可下：对方还有就跳过，否则终局计分
      if (legalIndices(cells, -player).length === 0) return scoreDiff(cells, player);
      return -search(cells, -player, -beta, -alpha, ctx);
    }

    orderMoves(moves);
    var best = -Infinity;

    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      var flips = flipsFor(cells, m >> 3, m & 7, player);

      cells[m] = player;
      for (var f = 0; f < flips.length; f++) cells[flips[f]] = player;

      var v = -search(cells, -player, -beta, -best, ctx);

      cells[m] = 0;
      for (var u = 0; u < flips.length; u++) cells[flips[u]] = -player;

      if (v > best) best = v;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
      if (ctx.aborted) break;
    }

    return best === -Infinity ? alpha : best;
  }

  /**
   * 精确求解一步。
   * @param {Board} board  当前局面（不会被修改）
   * @param {number} player 轮到谁（1 黑 / -1 白）
   * @param {object} options maxEmpty / budgetMs / nodeLimit
   * @returns {{move:number|null, score:number, nodes:number, complete:boolean, ms:number, empties:number}}
   */
  function solve(board, player, options) {
    var opts = options || {};
    var maxEmpty = opts.maxEmpty === undefined ? 10 : opts.maxEmpty;
    var empties = board.emptyCount();
    if (empties > maxEmpty) return null;

    var started = Date.now();
    var cells = board.cells.slice();
    var moves = legalIndices(cells, player);
    if (moves.length === 0) {
      return { move: null, score: 0, nodes: 0, complete: true, ms: Date.now() - started, empties: empties };
    }

    var ctx = {
      nodes: 0,
      nodeLimit: opts.nodeLimit || 3000000,
      deadline: started + (opts.budgetMs === undefined ? 600 : opts.budgetMs),
      aborted: false
    };

    orderMoves(moves);
    var bestMove = moves[0];
    var bestVal = -Infinity;
    var alpha = -Infinity;

    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      var flips = flipsFor(cells, m >> 3, m & 7, player);

      cells[m] = player;
      for (var f = 0; f < flips.length; f++) cells[flips[f]] = player;

      var v = -search(cells, -player, -Infinity, -alpha, ctx);

      cells[m] = 0;
      for (var u = 0; u < flips.length; u++) cells[flips[u]] = -player;

      if (v > bestVal) {
        bestVal = v;
        bestMove = m;
      }
      if (v > alpha) alpha = v;
      if (ctx.aborted) break;
    }

    return {
      move: bestMove,
      score: bestVal,
      nodes: ctx.nodes,
      complete: !ctx.aborted,
      ms: Date.now() - started,
      empties: empties
    };
  }

  var api = { solve: solve, POS: POS };

  if (isNode) module.exports = api;
  if (typeof window !== 'undefined') window.OthelloEndgame = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
