/* 教练：复用现有网络 + MCTS，只做分析，不下场。
 *
 * 主要接口：
 *   coach.analyze(board, player, {sims, shouldAbort, onProgress})
 *       -> MCTS 结果，含 moveValues（根玩家视角的每手 Q）
 *   coach.judge(analysis, move)
 *       -> {best, actual, loss, label, quality}
 *   coach.explain(beforeBoard, move, loss)
 *       -> {reason, tags}
 *   coach.quick(beforeBoard, player, move)
 *       -> 快速回退：价值网络 + 策略先验，不跑搜索
 *
 * 依赖：web/mcts.js 暴露的 window.OthelloMCTS。
 */
(function (global) {
  'use strict';

  var MCTS = global.OthelloMCTS.MCTS;

  var CORNERS = [0, 7, 56, 63];
  var ADJ_CORNER = {
    9: 0, 14: 7, 49: 56, 54: 63,
    1: 0, 6: 7, 8: 0, 15: 7,
    48: 56, 55: 63, 57: 56, 62: 63
  };

  function isCorner(idx) {
    return CORNERS.indexOf(idx) >= 0;
  }

  function moveName(idx) {
    if (idx < 0 || idx > 63) return '?';
    return String.fromCharCode(65 + (idx & 7)) + ((idx >> 3) + 1);
  }

  function boardKey(board) {
    return Array.prototype.join.call(board.cells, ',') + '|' + board.currentPlayer;
  }

  function countFlips(before, after, player) {
    var n = 0;
    for (var i = 0; i < 64; i++) {
      if (before.cells[i] === -player && after.cells[i] === player) n++;
    }
    return n;
  }

  function emptyCount(board) {
    var n = 0;
    for (var i = 0; i < 64; i++) if (board.cells[i] === 0) n++;
    return n;
  }

  function Coach(net, opts) {
    opts = opts || {};
    this.net = net;
    this.sims = opts.sims || 96;
    // 独立实例：不共享对局 AI 的树，也不复用
    this.mcts = new MCTS(net, { cPuct: 1.5 });
  }

  /** 分析一个局面；player 必须是行棋方（人类执黑就传 -1） */
  Coach.prototype.analyze = function (board, player, opts) {
    opts = opts || {};
    return this.mcts.search(board, player, {
      sims: opts.sims || this.sims,
      reuse: false,
      noise: false,
      yieldEvery: 8,
      shouldAbort: opts.shouldAbort || function () { return false; },
      onProgress: opts.onProgress
    });
  };

  /** 从 MCTS 结果中取最佳手，并和实际手比较 */
  Coach.prototype.judge = function (analysis, move) {
    var moves = analysis && analysis.moveValues ? analysis.moveValues : [];
    if (!moves.length) return null;

    var actual = null;
    var i;
    for (i = 0; i < moves.length; i++) {
      if (moves[i].move === move) { actual = moves[i]; break; }
    }
    if (!actual) return null;

    // 访问太少的 Q 不可信；优先在 >=5 次访问里挑，否则退回访问最多
    var best = null;
    for (i = 0; i < moves.length; i++) {
      if (moves[i].visits >= 5 && (!best || moves[i].q > best.q)) best = moves[i];
    }
    if (!best) {
      for (i = 0; i < moves.length; i++) {
        if (!best || moves[i].visits > best.visits) best = moves[i];
      }
    }

    var loss = best.q - actual.q; // 正数 = 实际手更差
    var label;
    if (loss >= 0.25) label = '失误';
    else if (loss >= 0.10) label = '略亏';
    else if (loss <= -0.10) label = '更优';
    else label = '好棋';

    return {
      best: best,
      actual: actual,
      loss: loss,
      label: label,
      quality: 'full'
    };
  };

  /** 用棋盘特征解释这手为什么好/坏 */
  Coach.prototype.explain = function (before, move, loss) {
    var player = before.currentPlayer;
    var after = before.clone();
    after.stepIndex(move);

    var oppBefore = before.legalMoves(-player);
    var oppAfter = after.legalMoves(-player);
    var oppCorners = oppAfter.filter(isCorner).length;
    var flips = countFlips(before, after, player);
    var empties = emptyCount(before);

    var reason = '';
    var tags = [];

    if (isCorner(move) && loss <= 0.10) {
      reason = '占角，好棋';
      tags.push('corner');
    } else if (oppCorners > 0) {
      reason = '这手把角让给了对手';
      tags.push('give-corner');
    } else if (ADJ_CORNER[move] !== undefined && before.cells[ADJ_CORNER[move]] !== player) {
      reason = 'X/C 位，角还空着，容易被抢';
      tags.push('xc');
    } else if (oppAfter.length - oppBefore.length >= 2) {
      reason = '对手行动力从 ' + oppBefore.length + ' 增到 ' + oppAfter.length;
      tags.push('mobility');
    } else if (flips >= 8 && empties > 20) {
      reason = '翻了 ' + flips + ' 子，帮对手铺路';
      tags.push('flips');
    } else if (loss >= 0.10) {
      reason = '局面估值下降';
      tags.push('value');
    } else {
      reason = '这手不错';
      tags.push('ok');
    }

    return { reason: reason, tags: tags, flips: flips, oppMoves: oppAfter.length };
  };

  /** 快速回退：两次价值前向 + 策略先验，不跑搜索 */
  Coach.prototype.quick = function (before, player, move) {
    var beforeOut = this.net.forward(before.toTensor(player));
    var after = before.clone();
    after.stepIndex(move);
    var afterOut = this.net.forward(after.toTensor(-player));

    var beforeValue = beforeOut.value;
    var afterValue = -afterOut.value; // 换回 player 视角
    var delta = beforeValue - afterValue; // 正数 = 这手让估值变差

    var legal = before.legalMoves(player);
    var bestMove = legal.length ? legal[0] : null;
    var bestPrior = -1;
    for (var i = 0; i < legal.length; i++) {
      var p = beforeOut.policy[legal[i]];
      if (p > bestPrior) { bestPrior = p; bestMove = legal[i]; }
    }

    return {
      quick: true,
      delta: delta,
      bestMove: bestMove,
      bestPrior: bestPrior,
      beforeValue: beforeValue,
      afterValue: afterValue
    };
  };

  var api = {
    Coach: Coach,
    boardKey: boardKey,
    moveName: moveName,
    isCorner: isCorner
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.OthelloCoach = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
