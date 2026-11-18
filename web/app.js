/*
 * 浏览器版对局控制层
 *
 * 与原 FastAPI 版（src/web/static/app.js）的区别：
 *   - 没有 fetch：规则、推理、搜索全部在本页完成
 *   - 每次「玩家落子 + AI 回应」都在本地，刷新会丢局（刻意的无状态设计）
 *   - 胜率条统一按「黑方胜率」显示，修掉了原版终局时按 current_player 取色导致的错位
 */
(function () {
  'use strict';

  var engine = window.OthelloEngine;
  var netApi = window.OthelloNet;
  var mctsApi = window.OthelloMCTS;

  var CELL = 60;
  var BLACK = engine.BLACK;
  var WHITE = engine.WHITE;
  // 翻子动画：单个棋子翻面 300ms，按离落点的距离错开 42ms，最远延迟 210ms
  var ANIM_DURATION = 300;
  var ANIM_STEP = 42;
  // 空位 ≤ 11 时改用 alpha-beta 精确求解（本机 10 格 7–36ms，11 格 29–115ms）
  var ENDGAME_EMPTIES = 11;
  var solver = window.OthelloEndgame || null;

  var canvas = document.getElementById('board');
  var ctx = canvas.getContext('2d');

  var net = null;
  var mcts = null;

  var state = {
    board: new engine.Board(),
    snapshots: [],
    thinking: false,
    gameOver: false,
    lastMove: -1,
    blackRate: 0.5,
    sims: 160,
    epoch: 0,
    anims: [],
    animStart: 0,
    animating: false,
    hover: -1,
    kbCursor: 27,
    kbFocus: false,
    lastSearch: null,
    rulesOpen: false,
    rulesState: 'loading',
    thinkingStarted: 0,
    thinkingShown: false,
    thinkingTotal: 0,
    showCandidates: false,
    candidates: []
  };

  // ---------- 绘制 ----------

  // 棋子预渲染成离屏精灵：径向渐变 + 阴影只算一次，动画时只做 drawImage。
  var PIECE_PAD = 10;
  var pieceSprites = {};

  function buildPieceSprite(player) {
    var radius = CELL * 0.4;
    var scale = 2; // 2x 分辨率，缩放后仍然清晰
    var cssSize = (radius + PIECE_PAD) * 2;
    var canvas = document.createElement('canvas');
    canvas.width = Math.ceil(cssSize * scale);
    canvas.height = canvas.width;

    var c = canvas.getContext('2d');
    c.scale(scale, scale);
    var cx = cssSize / 2;
    var cy = cssSize / 2;

    c.save();
    c.shadowColor = 'rgba(0,0,0,0.5)';
    c.shadowBlur = radius * 0.3;
    c.shadowOffsetY = radius * 0.1;
    var grad = c.createRadialGradient(
      cx - radius * 0.32, cy - radius * 0.4, radius * 0.12, cx, cy, radius
    );
    if (player === 1) {
      grad.addColorStop(0, '#575d66');
      grad.addColorStop(0.5, '#25282e');
      grad.addColorStop(1, '#08090b');
    } else {
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.55, '#edf0f4');
      grad.addColorStop(1, '#c0c6cf');
    }
    c.beginPath();
    c.arc(cx, cy, radius, 0, Math.PI * 2);
    c.fillStyle = grad;
    c.fill();
    c.restore();

    c.beginPath();
    c.arc(cx, cy, radius, 0, Math.PI * 2);
    c.lineWidth = Math.max(1, radius * 0.05);
    c.strokeStyle = player === 1 ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.14)';
    c.stroke();

    c.beginPath();
    c.ellipse(cx - radius * 0.32, cy - radius * 0.42, radius * 0.32, radius * 0.2, -0.6, 0, Math.PI * 2);
    c.fillStyle = player === 1 ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.9)';
    c.fill();

    return { canvas: canvas, cssSize: cssSize, radius: radius };
  }

  function drawPiece(cx, cy, radius, player) {
    if (radius <= 0.5) return;
    var sprite = pieceSprites[player];
    if (!sprite) sprite = pieceSprites[player] = buildPieceSprite(player);
    var scale = radius / sprite.radius;
    var size = sprite.cssSize * scale;
    ctx.drawImage(sprite.canvas, cx - size / 2, cy - size / 2, size, size);
  }

  // 首帧前预生成黑白精灵，避免第一次落子时临时构建造成一次卡顿
  function prewarmSprites() {
    if (!pieceSprites[1]) pieceSprites[1] = buildPieceSprite(1);
    if (!pieceSprites[-1]) pieceSprites[-1] = buildPieceSprite(-1);
  }

  function humanTurn() {
    return !state.rulesOpen && !state.gameOver && !state.thinking && !state.animating &&
      state.board.currentPlayer === BLACK;
  }

  /** 等当前翻子动画播完；没有动画时立即 resolve */
  function waitAnimation() {
    if (!state.animating) return Promise.resolve();
    return new Promise(function (resolve) {
      function check() {
        if (!state.animating) resolve();
        else requestAnimationFrame(check);
      }
      requestAnimationFrame(check);
    });
  }

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function findAnim(idx) {
    for (var i = 0; i < state.anims.length; i++) {
      if (state.anims[i].idx === idx) return state.anims[i];
    }
    return null;
  }

  function animProgress(anim, now) {
    var p = (now - state.animStart - anim.delay) / ANIM_DURATION;
    return Math.max(0, Math.min(1, p));
  }

  /**
   * 新落子：从 45% 放大并淡入（带一点回弹）
   * 被翻的棋子：前半段显示旧色、后半段显示新色，用 scaleX 做 180° 翻面
   */
  function drawAnimatedPiece(anim, cx, cy, now) {
    var p = animProgress(anim, now);

    if (p <= 0) {
      if (anim.from !== 0) drawPiece(cx, cy, CELL * 0.4, anim.from);
      return;
    }

    if (anim.from === 0) {
      // 落子：从 55% 放大，末端有一点轻微过冲
      var scale = 0.55 + 0.45 * easeOutCubic(p) + 0.05 * Math.sin(Math.PI * p);
      ctx.save();
      ctx.globalAlpha = Math.min(1, p * 2.2);
      ctx.translate(cx, cy);
      ctx.scale(scale, scale);
      drawPiece(0, 0, CELL * 0.4, anim.to);
      ctx.restore();
      return;
    }

    // 翻子：中途抬起 2px，scaleX 走 1 → 0 → 1，在 0 附近换色
    var sx = Math.max(0.02, Math.abs(Math.cos(p * Math.PI)));
    var color = p < 0.5 ? anim.from : anim.to;
    var lift = 2 * Math.sin(p * Math.PI);
    ctx.save();
    ctx.translate(cx, cy - lift);
    ctx.scale(sx, 1);
    drawPiece(0, 0, CELL * 0.4, color);
    ctx.restore();
  }

  // 静态棋盘底图只画一次，动画时整张 drawImage，省掉每帧 128 次 fill/stroke
  var boardBg = null;

  function buildBoardBackground() {
    var bg = document.createElement('canvas');
    bg.width = canvas.width;
    bg.height = canvas.height;
    var g = bg.getContext('2d');
    for (var r = 0; r < 8; r++) {
      for (var c = 0; c < 8; c++) {
        g.fillStyle = (r + c) % 2 === 0 ? '#2f7a5c' : '#256b4f';
        g.fillRect(c * CELL, r * CELL, CELL, CELL);
        g.strokeStyle = 'rgba(10, 16, 26, 0.35)';
        g.lineWidth = 1;
        g.strokeRect(c * CELL + 0.5, r * CELL + 0.5, CELL, CELL);
      }
    }
    return bg;
  }

  function drawBoard() {
    if (!boardBg) boardBg = buildBoardBackground();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(boardBg, 0, 0);

    var legal = humanTurn() ? state.board.legalMoves(BLACK) : [];

    if (state.hover >= 0 && legal.indexOf(state.hover) >= 0) {
      ctx.fillStyle = 'rgba(242, 196, 92, 0.13)';
      ctx.fillRect((state.hover & 7) * CELL, (state.hover >> 3) * CELL, CELL, CELL);
    }

    var cells = state.board.cells;
    var now = performance.now();
    for (var i = 0; i < 64; i++) {
      var piece = cells[i];
      if (piece === 0) continue;
      var cx = (i & 7) * CELL + CELL / 2;
      var cy = (i >> 3) * CELL + CELL / 2;
      var anim = findAnim(i);
      if (anim) {
        drawAnimatedPiece(anim, cx, cy, now);
      } else {
        drawPiece(cx, cy, CELL * 0.4, piece);
      }
    }

    // 合法落点提示
    for (var m = 0; m < legal.length; m++) {
      var mv = legal[m];
      var lx = (mv & 7) * CELL + CELL / 2;
      var ly = (mv >> 3) * CELL + CELL / 2;
      var hovering = state.hover === mv;
      ctx.beginPath();
      ctx.arc(lx, ly, CELL * (hovering ? 0.2 : 0.15), 0, Math.PI * 2);
      ctx.strokeStyle = hovering ? 'rgba(242,196,92,0.95)' : 'rgba(242,196,92,0.7)';
      ctx.lineWidth = hovering ? 2.2 : 1.6;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(lx, ly, CELL * 0.05, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(242,196,92,0.9)';
      ctx.fill();
    }

    // 最近一手
    if (state.lastMove >= 0) {
      var lmx = (state.lastMove & 7) * CELL;
      var lmy = (state.lastMove >> 3) * CELL;
      ctx.beginPath();
      ctx.arc(lmx + CELL - 9, lmy + 9, 3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(242,196,92,0.95)';
      ctx.fill();
    }

    // 键盘光标
    if (state.kbFocus && humanTurn()) {
      var kx = (state.kbCursor & 7) * CELL;
      var ky = (state.kbCursor >> 3) * CELL;
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = 'rgba(242,196,92,0.85)';
      ctx.lineWidth = 2;
      ctx.strokeRect(kx + 3, ky + 3, CELL - 6, CELL - 6);
      ctx.restore();
    }

    // 可选：显示 AI 正在考虑的前 3 个点
    if (state.showCandidates && state.thinking && state.candidates.length > 0) {
      drawCandidates();
    }
  }

  function drawCandidates() {
    for (var i = 0; i < state.candidates.length; i++) {
      var c = state.candidates[i];
      var cx = (c.move & 7) * CELL + CELL / 2;
      var cy = (c.move >> 3) * CELL + CELL / 2;
      var radius = [27, 21, 16][i] || 14;

      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(242,196,92,' + (0.10 - i * 0.02) + ')';
      ctx.fill();
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = 'rgba(242,196,92,' + (0.95 - i * 0.18) + ')';
      ctx.stroke();

      var label = Math.round(c.share * 100) + '%';
      ctx.font = 'bold 12px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(8,12,20,.75)';
      ctx.strokeText(label, cx, cy + radius + 12);
      ctx.fillStyle = '#f2c45c';
      ctx.fillText(label, cx, cy + radius + 12);
    }
  }

  function frame() {
    drawBoard();
    var now = performance.now();
    var running = false;
    for (var i = 0; i < state.anims.length; i++) {
      if (animProgress(state.anims[i], now) < 1) { running = true; break; }
    }
    if (running) requestAnimationFrame(frame);
    else {
      state.anims = [];
      state.animating = false;
      // 动画结束后补一帧：此时 humanTurn 恢复，合法落点提示才会出现
      drawBoard();
    }
  }

  function scheduleDraw() {
    requestAnimationFrame(drawBoard);
  }

  // ---------- DOM ----------

  function updateDom() {
    var score = state.board.score();
    document.getElementById('black-score').textContent = score[0];
    document.getElementById('white-score').textContent = score[1];

    var blackCard = document.getElementById('black-card');
    var whiteCard = document.getElementById('white-card');
    var turn = document.getElementById('turn-indicator');
    var turnText = document.getElementById('turn-text');

    if (state.gameOver) {
      blackCard.classList.remove('is-active');
      whiteCard.classList.remove('is-active');
      var winner = state.board.winner();
      turnText.textContent = winner === 0 ? '平局' : (winner === BLACK ? '你赢了' : 'AI 获胜');
      turn.className = 'turn-badge is-done';
    } else {
      var isBlackTurn = state.board.currentPlayer === BLACK;
      blackCard.classList.toggle('is-active', isBlackTurn);
      whiteCard.classList.toggle('is-active', !isBlackTurn);
      if (state.thinking) {
        turnText.textContent = 'AI 思考中';
        turn.className = 'turn-badge is-white';
      } else {
        turnText.textContent = isBlackTurn ? '轮到你（黑）' : '轮到白棋';
        turn.className = 'turn-badge ' + (isBlackTurn ? 'is-black' : 'is-white');
      }
    }

    var rate = Math.max(0, Math.min(1, state.blackRate));
    document.getElementById('black-bar').style.width = (rate * 100) + '%';
    document.getElementById('white-bar').style.width = ((1 - rate) * 100) + '%';
    document.getElementById('win-rate-text').textContent = Math.round(rate * 100) + '%';

    document.getElementById('btn-undo').disabled = !canUndo();

    var status = document.getElementById('status');
    if (state.gameOver) {
      var w = state.board.winner();
      var msg = w === 0 ? '平局。' : (w === BLACK ? '黑棋（你）获胜！' : '白棋（AI）获胜。');
      status.textContent = msg + ' 黑 ' + score[0] + ' : 白 ' + score[1];
    }

    var timing = document.getElementById('timing');
    if (state.lastSearch) {
      if (state.lastSearch.endgame) {
        timing.textContent = '残局精算 ' + state.lastSearch.nodes + ' 节点 · ' +
          state.lastSearch.ms + ' ms' + (state.lastSearch.complete ? '' : '（未完成）');
      } else {
        timing.textContent = '上次搜索 ' + state.lastSearch.sims + ' 次 · ' +
          state.lastSearch.ms + ' ms' + (state.lastSearch.reused ? ' · 复用树' : '');
      }
    }
  }

  function canUndo() {
    if (state.thinking) return false;
    for (var i = state.snapshots.length - 1; i >= 0; i--) {
      if (state.snapshots[i].mover === BLACK) return true;
    }
    return false;
  }

  // ---------- 规则动作 ----------

  function snapshot(mover) {
    state.snapshots.push({
      cells: state.board.cells.slice(),
      currentPlayer: state.board.currentPlayer,
      gameOver: state.board.gameOver,
      mover: mover
    });
  }

  function applyMove(idx) {
    var before = state.board.cells.slice();
    state.board.stepIndex(idx);

    var anims = [];
    for (var i = 0; i < 64; i++) {
      var after = state.board.cells[i];
      if (before[i] === after) continue;
      var dist = Math.max(
        Math.abs((i >> 3) - (idx >> 3)),
        Math.abs((i & 7) - (idx & 7))
      );
      anims.push({
        idx: i,
        from: before[i],
        to: after,
        delay: Math.min(210, dist * ANIM_STEP)
      });
    }

    state.animStart = performance.now();
    state.anims = anims;
    state.lastMove = idx;
    state.gameOver = state.board.isTerminal();
    state.blackRate = evaluateBlackRate();

    var wasAnimating = state.animating;
    if (anims.length) state.animating = true;

    render();

    // 保证同一时间只有一个动画循环；AI 连走时只替换 anims，不重复启动
    if (anims.length && !wasAnimating) {
      requestAnimationFrame(frame);
    }
  }

  function evaluateBlackRate() {
    if (state.board.isTerminal()) {
      var s = state.board.score();
      if (s[0] > s[1]) return 1;
      if (s[1] > s[0]) return 0;
      return 0.5;
    }
    if (!net) return 0.5;
    var out = net.forward(state.board.toTensor(BLACK));
    return (out.value + 1) / 2;
  }

  async function playHuman(idx) {
    if (!humanTurn()) return;
    if (state.board.legalMoves(BLACK).indexOf(idx) < 0) return;

    snapshot(BLACK);
    applyMove(idx);

    if (state.gameOver) return;
    // 先让翻子动画播完，再开始 AI 搜索；否则推理会阻塞主线程，动画掉帧
    await waitAnimation();
    await aiTurn();
  }

  async function aiTurn() {
    // 可能连续走多手：当人类（黑）无子可下时，规则允许白棋连走
    var guard = 0;
    while (!state.gameOver && state.board.currentPlayer !== BLACK && guard < 4) {
      guard++;
      if (!mcts) return;
      if (state.animating) await waitAnimation();

      var myEpoch = state.epoch;
      var player = state.board.currentPlayer;
      state.thinking = true;
      beginThinking(state.sims);
      render();

      var started = performance.now();
      var result = null;
      var endgameInfo = null;

      // 残局（空位 ≤ 11）直接穷举到终局，不再依赖估值
      if (solver && state.board.emptyCount() <= ENDGAME_EMPTIES) {
        if (mcts) mcts.resetCache();
        endgameInfo = solver.solve(state.board, player, {
          maxEmpty: ENDGAME_EMPTIES,
          budgetMs: 1000
        });
        if (endgameInfo) result = { move: endgameInfo.move, sims: 0, reused: false };
      }

      if (!result) {
        try {
          result = await mcts.search(state.board, player, {
            sims: state.sims,
            yieldEvery: 16,
            reuse: true,
            onProgress: function (p) {
              updateThinkingUI(p.done, p.total);
              if (p.candidates) state.candidates = p.candidates;
              if (state.showCandidates) scheduleDraw();
            },
            shouldAbort: function () { return state.epoch !== myEpoch; }
          });
        } catch (err) {
          console.error(err);
          state.thinking = false;
          clearThinkingUI();
          document.getElementById('status').textContent = '搜索出错：' + err.message;
          render();
          return;
        }
      }

      if (state.epoch !== myEpoch) return; // 已被「新对局」打断

      state.thinking = false;
      clearThinkingUI();
      if (endgameInfo) {
        state.lastSearch = {
          endgame: true,
          nodes: endgameInfo.nodes,
          complete: endgameInfo.complete,
          ms: Math.round(performance.now() - started)
        };
      } else {
        state.lastSearch = {
          sims: result.sims,
          reused: !!result.reused,
          ms: Math.round(performance.now() - started)
        };
      }

      if (result.move === null || result.move === undefined) {
        render();
        return;
      }

      snapshot(player);
      applyMove(result.move);
    }
  }

  function undo() {
    if (state.thinking) return;
    var target = -1;
    for (var i = state.snapshots.length - 1; i >= 0; i--) {
      if (state.snapshots[i].mover === BLACK) { target = i; break; }
    }
    if (target < 0) return;

    var snap = state.snapshots[target];
    state.board.cells.set(snap.cells);
    state.board.currentPlayer = snap.currentPlayer;
    state.board.gameOver = snap.gameOver;
    state.snapshots.length = target;

    state.gameOver = false;
    state.lastMove = -1;
    state.anims = [];
    state.animating = false;
    state.lastSearch = null;
    if (mcts) mcts.resetCache();
    state.blackRate = evaluateBlackRate();
    document.getElementById('status').textContent = '';
    render();
  }

  function newGame() {
    state.epoch++;
    state.board.reset();
    state.snapshots = [];
    state.thinking = false;
    state.gameOver = false;
    state.lastMove = -1;
    state.anims = [];
    state.animating = false;
    state.hover = -1;
    state.lastSearch = null;
    state.blackRate = 0.5;
    if (mcts) mcts.resetCache();
    clearThinkingUI();
    document.getElementById('status').textContent = '';
    state.blackRate = evaluateBlackRate();
    render();
  }

  // ---------- 思考反馈（不遮棋盘） ----------
  // 0–180ms 不显示，避免残局/快棋闪烁；之后进度进入回合徽章与 AI 卡片。

  var THINKING_DELAY = 180;

  function beginThinking(total) {
    state.thinkingStarted = performance.now();
    state.thinkingTotal = total || 0;
    state.thinkingShown = false;
    state.candidates = [];
    clearThinkingUI();
  }

  function updateThinkingUI(done, total) {
    if (!state.thinkingShown) {
      if (performance.now() - state.thinkingStarted < THINKING_DELAY) return;
      state.thinkingShown = true;
    }

    var pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

    var ring = document.getElementById('turn-ring');
    if (ring) {
      ring.hidden = false;
      ring.style.setProperty('--p', (pct * 3.6) + 'deg');
    }

    var text = document.getElementById('turn-text');
    if (text) text.textContent = 'AI 思考中 ' + pct + '%';

    var card = document.getElementById('white-card');
    if (card) {
      card.classList.add('is-thinking');
      card.style.setProperty('--p', pct + '%');
    }

    var wrap = document.getElementById('board-wrap');
    if (wrap) wrap.classList.add('is-thinking');
  }

  function clearThinkingUI() {
    state.candidates = [];
    var ring = document.getElementById('turn-ring');
    if (ring) {
      ring.hidden = true;
      ring.style.removeProperty('--p');
    }

    var card = document.getElementById('white-card');
    if (card) {
      card.classList.remove('is-thinking');
      card.style.removeProperty('--p');
    }

    var wrap = document.getElementById('board-wrap');
    if (wrap) wrap.classList.remove('is-thinking');
  }

  // ---------- 开局规则 ----------

  function showRules() {
    state.rulesOpen = true;
    state.hover = -1;
    document.getElementById('rules').hidden = false;
    var start = document.getElementById('btn-rules-start');
    if (start && start.focus) start.focus();
    scheduleDraw();
  }

  function hideRules() {
    if (!state.rulesOpen) return;
    state.rulesOpen = false;
    document.getElementById('rules').hidden = true;
    scheduleDraw();
    if (canvas && canvas.focus) canvas.focus();
  }

  /**
   * 规则弹窗与模型加载是解耦的：规则先出现，按钮随模型状态切换。
   * loading → 按钮显示「模型加载中…」且点击无效（用 aria-disabled 保留可聚焦性）
   * ready   → 「开始对局」可点击
   * error   → 「关闭提示」，让用户能关掉弹窗看错误信息
   */
  function setRulesState(kind) {
    state.rulesState = kind;
    var btn = document.getElementById('btn-rules-start');
    var note = document.getElementById('rules-status');

    if (btn) {
      if (kind === 'ready') {
        btn.removeAttribute('aria-disabled');
        btn.textContent = '开始对局';
      } else if (kind === 'error') {
        btn.removeAttribute('aria-disabled');
        btn.textContent = '关闭提示';
      } else {
        btn.setAttribute('aria-disabled', 'true');
        btn.textContent = '模型加载中…';
      }
    }

    if (note) {
      if (kind === 'ready') {
        note.hidden = true;
      } else if (kind === 'error') {
        note.hidden = false;
        note.textContent = '模型加载失败：网络可能不稳定，可以刷新重试，或改用单文件离线版。';
      } else {
        note.hidden = false;
        note.textContent = '正在加载模型（4.3 MB，首次打开会慢一些）…';
      }
    }

    var track = document.getElementById('rules-progress');
    if (track && (kind === 'ready' || kind === 'error')) track.hidden = true;
  }

  /** 下载进度：分块下载每完成一块回调一次 */
  function formatBytes(bytes) {
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  }

  function updateLoadProgress(received, total) {
    var pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
    var note = document.getElementById('rules-status');
    var bar = document.getElementById('rules-progress-bar');
    var track = document.getElementById('rules-progress');

    if (note) {
      note.textContent = '正在下载模型 ' + formatBytes(received) + ' / ' +
        (total / 1048576).toFixed(1) + ' MB（' + pct + '%）';
    }
    if (bar) bar.style.width = pct + '%';
    if (track) track.hidden = false;
  }

  function onStartClick() {
    if (state.rulesState === 'loading') return;
    hideRules();
  }

  // ---------- 交互 ----------

  function eventToIndex(e) {
    var rect = canvas.getBoundingClientRect();
    var scale = canvas.width / rect.width;
    var col = Math.floor((e.clientX - rect.left) * scale / CELL);
    var row = Math.floor((e.clientY - rect.top) * scale / CELL);
    if (row < 0 || row > 7 || col < 0 || col > 7) return -1;
    return row * 8 + col;
  }

  function bind() {
    canvas.addEventListener('click', function (e) {
      state.kbFocus = false;
      var idx = eventToIndex(e);
      if (idx >= 0) playHuman(idx);
    });

    canvas.addEventListener('mousemove', function (e) {
      if (!humanTurn()) return;
      state.kbFocus = false;
      var idx = eventToIndex(e);
      if (idx !== state.hover) {
        state.hover = idx;
        scheduleDraw();
      }
    });

    canvas.addEventListener('mouseleave', function () {
      if (state.hover !== -1) {
        state.hover = -1;
        scheduleDraw();
      }
    });

    // 只有真正用键盘操作时才显示光标，避免鼠标点击后焦点落到 canvas 就出现虚线框
    canvas.addEventListener('focus', function () {
      state.kbFocus = false;
      scheduleDraw();
    });
    canvas.addEventListener('blur', function () {
      state.kbFocus = false;
      scheduleDraw();
    });

    canvas.addEventListener('keydown', function (e) {
      if (!humanTurn()) return;
      var r = state.kbCursor >> 3;
      var c = state.kbCursor & 7;
      var handled = true;
      if (e.key === 'ArrowUp') r = Math.max(0, r - 1);
      else if (e.key === 'ArrowDown') r = Math.min(7, r + 1);
      else if (e.key === 'ArrowLeft') c = Math.max(0, c - 1);
      else if (e.key === 'ArrowRight') c = Math.min(7, c + 1);
      else if (e.key === 'Enter' || e.key === ' ') {
        if (state.board.legalMoves(BLACK).indexOf(state.kbCursor) >= 0) {
          state.kbFocus = true;
          playHuman(state.kbCursor);
        }
        e.preventDefault();
        return;
      } else {
        handled = false;
      }
      if (handled) {
        state.kbFocus = true;
        state.kbCursor = r * 8 + c;
        state.hover = state.kbCursor;
        scheduleDraw();
        e.preventDefault();
      }
    });

    document.getElementById('btn-new').addEventListener('click', newGame);
    document.getElementById('btn-undo').addEventListener('click', undo);
    document.getElementById('btn-rules').addEventListener('click', showRules);
    document.getElementById('btn-rules-start').addEventListener('click', onStartClick);

    // 点遮罩空白处关闭；规则打开时把焦点圈在弹窗内
    document.getElementById('rules').addEventListener('click', function (e) {
      if (e.target === e.currentTarget) hideRules();
    });
    document.addEventListener('keydown', function (e) {
      if (!state.rulesOpen) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        hideRules();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        var start = document.getElementById('btn-rules-start');
        if (start && start.focus) start.focus();
      }
    });

    var chips = document.querySelectorAll('#difficulty-chips .chip');
    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener('click', function (e) {
        var el = e.currentTarget;
        state.sims = parseInt(el.getAttribute('data-sims'), 10) || 160;
        for (var j = 0; j < chips.length; j++) chips[j].classList.remove('is-active');
        el.classList.add('is-active');
        document.getElementById('depth-note').textContent = state.sims + ' 次模拟 / 步';
      });
    }

    var candidateToggle = document.getElementById('toggle-candidates');
    if (candidateToggle) {
      candidateToggle.addEventListener('click', function (e) {
        state.showCandidates = !state.showCandidates;
        e.currentTarget.setAttribute('aria-pressed', String(state.showCandidates));
        e.currentTarget.classList.toggle('is-on', state.showCandidates);
        scheduleDraw();
      });
    }
  }

  function render() {
    updateDom();
    drawBoard();
  }

  // ---------- 启动 ----------

  function showLoadError(err) {
    var info = document.getElementById('model-info');
    info.textContent = '模型加载失败';
    var status = document.getElementById('status');
    status.textContent =
      '无法加载 weights.bin：' + err.message +
      '。请通过 HTTP 打开（GitHub Pages / 本地 http 服务），或使用单文件离线版。';
  }

  async function boot() {
    bind();
    prewarmSprites();

    // 规则和棋盘都不依赖模型：先摆好、先弹出。
    // 否则慢网下要等 4.3 MB 权重下完规则才出现，页面看起来像卡死。
    newGame();
    showRules();
    setRulesState('loading');

    try {
      if (window.__OTHELLO_INLINE__) {
        net = netApi.fromInline(window.__OTHELLO_INLINE__.meta, window.__OTHELLO_INLINE__.b64);
      } else {
        net = await netApi.load('weights.json', 'weights.bin', {
          onProgress: updateLoadProgress
        });
      }
    } catch (err) {
      console.error(err);
      showLoadError(err);
      setRulesState('error');
      render();
      return;
    }

    mcts = new mctsApi.MCTS(net, { cPuct: 1.5 });

    document.getElementById('model-info').textContent =
      net.paramCount().toLocaleString() + ' 参数 · 本地推理 · ' +
      (window.__OTHELLO_INLINE__ ? '单文件离线版' : 'sha256 ' + String(net.meta.sha256).slice(0, 8));

    state.blackRate = evaluateBlackRate();
    setRulesState('ready');
    render();
  }

  // 供自动化验收脚本使用；不参与游戏逻辑，也不暴露任何外部能力
  window.__OTHELLO__ = {
    get state() { return state; },
    get net() { return net; },
    get mcts() { return mcts; },
    board: function () { return state.board; },
    playHuman: playHuman,
    aiTurn: aiTurn,
    newGame: newGame,
    undo: undo,
    render: render
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
