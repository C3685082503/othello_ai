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
    hover: -1,
    kbCursor: 27,
    kbFocus: false,
    lastSearch: null
  };

  // ---------- 绘制 ----------

  function drawPiece(cx, cy, radius, player) {
    if (radius <= 0.5) return;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = radius * 0.3;
    ctx.shadowOffsetY = radius * 0.1;
    var grad = ctx.createRadialGradient(
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
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1, radius * 0.05);
    ctx.strokeStyle = player === 1 ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.14)';
    ctx.stroke();

    ctx.beginPath();
    ctx.ellipse(cx - radius * 0.32, cy - radius * 0.42, radius * 0.32, radius * 0.2, -0.6, 0, Math.PI * 2);
    ctx.fillStyle = player === 1 ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.9)';
    ctx.fill();
  }

  function humanTurn() {
    return !state.gameOver && !state.thinking && state.board.currentPlayer === BLACK;
  }

  function drawBoard() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (var r = 0; r < 8; r++) {
      for (var c = 0; c < 8; c++) {
        ctx.fillStyle = (r + c) % 2 === 0 ? '#2f7a5c' : '#256b4f';
        ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
        ctx.strokeStyle = 'rgba(10, 16, 26, 0.35)';
        ctx.lineWidth = 1;
        ctx.strokeRect(c * CELL + 0.5, r * CELL + 0.5, CELL, CELL);
      }
    }

    var legal = humanTurn() ? state.board.legalMoves(BLACK) : [];

    if (state.hover >= 0 && legal.indexOf(state.hover) >= 0) {
      ctx.fillStyle = 'rgba(242, 196, 92, 0.13)';
      ctx.fillRect((state.hover & 7) * CELL, (state.hover >> 3) * CELL, CELL, CELL);
    }

    var cells = state.board.cells;
    for (var i = 0; i < 64; i++) {
      var piece = cells[i];
      if (piece === 0) continue;
      var cx = (i & 7) * CELL + CELL / 2;
      var cy = (i >> 3) * CELL + CELL / 2;
      var anim = null;
      for (var a = 0; a < state.anims.length; a++) {
        if (state.anims[a].idx === i) { anim = state.anims[a]; break; }
      }
      if (anim) {
        var sx = Math.sin(anim.t * Math.PI / 2);
        ctx.save();
        ctx.globalAlpha = 0.3 + 0.7 * anim.t;
        ctx.translate(cx, cy);
        ctx.scale(Math.max(0.02, sx), 1);
        drawPiece(0, 0, CELL * 0.4, piece);
        ctx.restore();
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
  }

  function frame() {
    var running = false;
    for (var i = 0; i < state.anims.length; i++) {
      state.anims[i].t += 0.11;
      if (state.anims[i].t < 1) running = true;
    }
    state.anims = state.anims.filter(function (a) { return a.t < 1; });
    drawBoard();
    if (running) requestAnimationFrame(frame);
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

    if (state.gameOver) {
      blackCard.classList.remove('is-active');
      whiteCard.classList.remove('is-active');
      turn.textContent = '对局结束';
      turn.className = 'turn-badge is-done';
    } else {
      var isBlackTurn = state.board.currentPlayer === BLACK;
      blackCard.classList.toggle('is-active', isBlackTurn);
      whiteCard.classList.toggle('is-active', !isBlackTurn);
      if (state.thinking) {
        turn.textContent = 'AI 思考中';
        turn.className = 'turn-badge is-white';
      } else {
        turn.textContent = isBlackTurn ? '轮到你（黑）' : '轮到白棋';
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
      timing.textContent = '上次搜索 ' + state.lastSearch.sims + ' 次 · ' + state.lastSearch.ms + ' ms';
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
    var changed = [];
    for (var i = 0; i < 64; i++) {
      if (before[i] !== state.board.cells[i]) changed.push({ idx: i, t: 0 });
    }
    state.anims = changed;
    state.lastMove = idx;
    state.gameOver = state.board.isTerminal();
    state.blackRate = evaluateBlackRate();
    render();
    if (changed.length) requestAnimationFrame(frame);
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
    await aiTurn();
  }

  async function aiTurn() {
    // 可能连续走多手：当人类（黑）无子可下时，规则允许白棋连走
    var guard = 0;
    while (!state.gameOver && state.board.currentPlayer !== BLACK && guard < 4) {
      guard++;
      if (!mcts) return;

      var myEpoch = state.epoch;
      var player = state.board.currentPlayer;
      state.thinking = true;
      showThinking(0, state.sims);
      render();

      var started = performance.now();
      var result;
      try {
        result = await mcts.search(state.board, player, {
          sims: state.sims,
          yieldEvery: 16,
          onProgress: function (p) { showThinking(p.done, p.total); },
          shouldAbort: function () { return state.epoch !== myEpoch; }
        });
      } catch (err) {
        console.error(err);
        state.thinking = false;
        hideThinking();
        document.getElementById('status').textContent = '搜索出错：' + err.message;
        render();
        return;
      }

      if (state.epoch !== myEpoch) return; // 已被「新对局」打断

      state.thinking = false;
      hideThinking();
      state.lastSearch = { sims: result.sims, ms: Math.round(performance.now() - started) };

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
    state.lastSearch = null;
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
    state.hover = -1;
    state.lastSearch = null;
    state.blackRate = 0.5;
    hideThinking();
    document.getElementById('status').textContent = '';
    state.blackRate = evaluateBlackRate();
    render();
  }

  // ---------- 思考遮罩 ----------

  function showThinking(done, total) {
    var box = document.getElementById('thinking');
    box.hidden = false;
    var pct = total > 0 ? Math.round((done / total) * 100) : 0;
    document.getElementById('thinking-progress').style.width = pct + '%';
    document.getElementById('thinking-text').textContent =
      done > 0 ? 'AI 思考中 ' + done + ' / ' + total : 'AI 思考中';
  }

  function hideThinking() {
    document.getElementById('thinking').hidden = true;
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

    try {
      if (window.__OTHELLO_INLINE__) {
        net = netApi.fromInline(window.__OTHELLO_INLINE__.meta, window.__OTHELLO_INLINE__.b64);
      } else {
        net = await netApi.load('weights.json', 'weights.bin');
      }
    } catch (err) {
      console.error(err);
      showLoadError(err);
      return;
    }

    mcts = new mctsApi.MCTS(net, { cPuct: 1.5 });

    document.getElementById('model-info').textContent =
      net.paramCount().toLocaleString() + ' 参数 · 本地推理 · ' +
      (window.__OTHELLO_INLINE__ ? '单文件离线版' : 'sha256 ' + String(net.meta.sha256).slice(0, 8));

    newGame();
  }

  // 供自动化验收脚本使用；不参与游戏逻辑，也不暴露任何外部能力
  window.__OTHELLO__ = {
    get state() { return state; },
    get net() { return net; },
    get mcts() { return mcts; },
    board: function () { return state.board; },
    playHuman: playHuman,
    newGame: newGame,
    undo: undo
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
