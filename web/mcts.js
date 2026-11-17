/*
 * MCTS + PUCT（浏览器端）
 *
 * 与 src/alphazero/mcts.py 的 search() 保持同一套语义：
 *   - 选择：score = -child.Q + c_puct * child.P * sqrt(parent.N) / (1 + child.N)
 *   - 扩展：策略头在合法步上归一化作为先验
 *   - 评估：价值头输出（叶子视角）
 *   - 回溯：沿路径交替取反
 *
 * 两处有意的改动：
 *   1. 一次前向同时取 policy 和 value。Python 版在 expand 里算完策略后，
 *      又对同一局面算了一次价值，等于每个模拟两次前向；这里省掉一次。
 *   2. 支持分片让出主线程（yieldEvery），否则 200 次模拟会把页面卡住。
 *
 * 实战不注入 Dirichlet 噪声——噪声只对自对弈数据多样性有意义，
 * 对人机对战只会削弱棋力。
 */
(function (global) {
  'use strict';

  function Node(board, player, parent, prior, move) {
    this.board = board;
    this.player = player;
    this.parent = parent || null;
    this.prior = prior === undefined ? 1 : prior;
    this.move = move === undefined ? -1 : move;
    this.children = [];
    this.N = 0;
    this.W = 0;
    this.Q = 0;
  }

  function MCTS(net, options) {
    options = options || {};
    this.net = net;
    this.cPuct = options.cPuct === undefined ? 1.5 : options.cPuct;
    this.cacheRoot = null; // 上一次搜索的树根，用于下一步复用
  }

  /** 节点与当前局面是否完全一致（64 格 + 行棋方） */
  function sameBoard(node, board, player) {
    if (node.player !== player) return false;
    var a = node.board.cells;
    var b = board.cells;
    for (var i = 0; i < 64; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /** 在旧树里找与当前局面匹配的节点（通常深度 2：我方一手 + 对方一手） */
  function findMatchingNode(root, board, player, maxNodes) {
    var stack = [root];
    var seen = 0;
    while (stack.length > 0 && seen < maxNodes) {
      var node = stack.pop();
      seen++;
      if (sameBoard(node, board, player)) return node;
      for (var i = 0; i < node.children.length; i++) stack.push(node.children[i]);
    }
    return null;
  }

  MCTS.prototype.resetCache = function () {
    this.cacheRoot = null;
  };

  /**
   * 扩展一个叶子节点，返回该局面的价值（node.player 视角）。
   * 内部完成「策略先验 + 价值评估」的唯一一次前向。
   */
  MCTS.prototype.expand = function (node) {
    var moves = node.board.legalMoves(node.player);
    if (moves.length === 0) return 0;

    var out = this.net.forward(node.board.toTensor(node.player));
    var probs = out.policy;

    var total = 0;
    var i;
    for (i = 0; i < moves.length; i++) total += probs[moves[i]];

    for (i = 0; i < moves.length; i++) {
      var prior;
      if (total > 0) {
        prior = probs[moves[i]] / total;
      } else {
        prior = 1 / moves.length; // 理论上不会发生，兜底避免全 0
      }
      var childBoard = node.board.clone();
      childBoard.stepIndex(moves[i]);
      node.children.push(new Node(childBoard, -node.player, node, prior, moves[i]));
    }
    return out.value;
  };

  /** 按 PUCT 选一个子节点 */
  MCTS.prototype.select = function (node) {
    var bestScore = -Infinity;
    var best = node.children[0];
    var sqrtN = Math.sqrt(node.N);
    for (var i = 0; i < node.children.length; i++) {
      var child = node.children[i];
      var q = -child.Q;
      var u = this.cPuct * child.prior * sqrtN / (1 + child.N);
      var score = q + u;
      if (score > bestScore) {
        bestScore = score;
        best = child;
      }
    }
    return best;
  };

  function terminalValue(node) {
    var winner = node.board.winner();
    if (winner === 0) return 0;
    return winner === node.player ? 1 : -1;
  }

  function bestChild(root) {
    var best = null;
    for (var i = 0; i < root.children.length; i++) {
      var c = root.children[i];
      if (best === null || c.N > best.N) best = c;
    }
    return best;
  }

  /** 访问次数最多的前 n 个候选，share 为占根节点访问量的比例 */
  function topChildren(root, n) {
    var sum = 0;
    var i;
    for (i = 0; i < root.children.length; i++) sum += root.children[i].N;
    var sorted = root.children.slice().sort(function (a, b) { return b.N - a.N; });
    var out = [];
    for (i = 0; i < sorted.length && i < n; i++) {
      out.push({
        move: sorted[i].move,
        visits: sorted[i].N,
        share: sum > 0 ? sorted[i].N / sum : 0
      });
    }
    return out;
  }

  /**
   * 搜索一步。返回 Promise：
   * { move, visits, value, sims, elapsedMs, root, reachedEnd }
   *
   * move 是 0..63 的索引；无合法步时为 null。
   */
  MCTS.prototype.search = async function (board, player, options) {
    options = options || {};
    var sims = options.sims === undefined ? 200 : options.sims;
    var yieldEvery = options.yieldEvery === undefined ? 0 : options.yieldEvery;
    var onProgress = options.onProgress;
    var shouldAbort = options.shouldAbort || function () { return false; };

    var legal = board.legalMoves(player);
    if (legal.length === 0) {
      return { move: null, visits: 0, value: 0, sims: 0, elapsedMs: 0, root: null, reachedEnd: true, reused: false };
    }

    // 树复用：上一步的树里若存在当前局面，直接把它作为新根，
    // 省掉重复搜索并保留访问统计（等效模拟数 +20~40%）。
    var root = null;
    var reused = false;
    if (options.reuse && this.cacheRoot) {
      root = findMatchingNode(this.cacheRoot, board, player, options.reuseLimit || 50000);
      if (root) {
        root.parent = null;
        reused = true;
      }
    }
    if (!root) {
      root = new Node(board.clone(), player, null, 1, -1);
      this.expand(root); // 根节点先扩展，保证 children 存在
    } else if (root.children.length === 0 && !root.board.isTerminal()) {
      this.expand(root);
    }

    var started = Date.now();
    var done = 0;

    for (var i = 0; i < sims; i++) {
      if (shouldAbort()) break;

      var node = root;
      var path = [node];

      // children 非空说明该节点已被扩展、且扩展时存在合法步 → 必然非终局
      while (node.children.length > 0) {
        node = this.select(node);
        path.push(node);
      }

      var value;
      if (node.board.isTerminal()) {
        value = terminalValue(node);
      } else {
        value = this.expand(node);
      }

      for (var k = path.length - 1; k >= 0; k--) {
        var n = path[k];
        n.N += 1;
        n.W += value;
        n.Q = n.W / n.N;
        value = -value;
      }

      done = i + 1;

      if (yieldEvery > 0 && done % yieldEvery === 0 && done < sims) {
        if (onProgress) {
          var bc = bestChild(root);
          onProgress({
            done: done,
            total: sims,
            bestMove: bc ? bc.move : null,
            bestVisits: bc ? bc.N : 0,
            candidates: topChildren(root, 3),
            elapsedMs: Date.now() - started
          });
        }
        await new Promise(function (resolve) { setTimeout(resolve, 0); });
      }
    }

    var best = bestChild(root);
    this.cacheRoot = root;
    return {
      move: best ? best.move : legal[0],
      visits: best ? best.N : 0,
      value: root.Q,             // 根节点视角（即 player）的平均价值
      sims: done,
      elapsedMs: Date.now() - started,
      root: root,
      reachedEnd: done >= sims,
      reused: reused,
      candidates: topChildren(root, 3)
    };
  };

  /** 只取价值，不给搜索用（前端显示胜率） */
  MCTS.prototype.evaluate = function (board, player) {
    var out = this.net.forward(board.toTensor(player));
    return { value: out.value, policy: Array.from(out.policy) };
  };

  var api = { MCTS: MCTS, Node: Node };

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.OthelloMCTS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
