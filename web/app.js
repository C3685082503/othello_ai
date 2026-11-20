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
  var ANIM_DURATION = 180;
  var ANIM_STEP = 18;
  // 空位 ≤ 11 时改用 alpha-beta 精确求解（本机 10 格 7–36ms，11 格 29–115ms）
  var ENDGAME_EMPTIES = 11;
  var solver = window.OthelloEndgame || null;
  var coachApi = window.OthelloCoach || null;

  // 战绩：只保留最近 30 局，存在 localStorage
  var RECORDS_KEY = 'othello.records.v1';
  var RECORDS_LIMIT = 30;

  var canvas = document.getElementById('board');
  var ctx = canvas.getContext('2d');

  var net = null;
  var mcts = null;
  var coach = null;

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
    recordsOpen: false,
    records: [],
    recorded: false,
    recordedAt: 0,
    thinkingStarted: 0,
    thinkingShown: false,
    thinkingTotal: 0,
    showCandidates: false,
    candidates: [],
    moveLog: [],
    reviewOpen: false,
    reviewEpoch: 0,
    coach: {
      enabled: false,
      sims: 160,
      busy: false,
      epoch: 0,
      analysis: null,
      analysisKey: '',
      hint: null,
      feedback: null,
      history: [],
      review: null
    }
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
    return !state.rulesOpen && !state.recordsOpen && !state.reviewOpen &&
      !state.gameOver && !state.thinking && !state.animating &&
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

  // ---------- 教练 ----------

  function coachMoveName(idx) {
    if (idx === null || idx === undefined || idx < 0) return '—';
    return coachApi ? coachApi.moveName(idx) : String(idx);
  }

  // 教练预算跟随难度：轻松 160 / 标准 240 / 认真 480
  function coachSims() {
    return Math.max(160, Math.round(state.sims * 1.5));
  }

  function updateCoachPanel() {
    var panel = document.getElementById('coach-panel');
    if (!panel) return;
    if (!state.coach.enabled) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;

    var text = document.getElementById('coach-text');
    var hintBtn = document.getElementById('btn-hint');
    var reviewBtn = document.getElementById('btn-review');
    var hintList = document.getElementById('coach-hints');
    var c = state.coach;
    if (hintBtn) hintBtn.disabled = !(humanTurn() && !c.busy);
    if (reviewBtn) {
      reviewBtn.hidden = !(state.gameOver && state.coach.enabled);
      reviewBtn.disabled = state.reviewOpen;
    }
    if (hintList) {
      hintList.hidden = true;
      hintList.textContent = '';
    }

    if (c.feedback && c.feedback.text) {
      text.textContent = c.feedback.text;
    } else if (c.hint && c.hint.moves && c.hint.moves.length) {
      text.textContent = '提示（' + coachSims() + ' 次）：点候选直接下，或点棋盘。';
      if (hintList) {
        hintList.hidden = false;
        for (var h = 0; h < c.hint.moves.length; h++) {
          (function (item, idx) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'chip coach-hint-btn';
            b.textContent = (idx + 1) + ' ' + coachMoveName(item.move);
            b.addEventListener('click', function () {
              playHuman(item.move);
            });
            hintList.appendChild(b);
          })(c.hint.moves[h], h);
        }
      }
    } else if (c.busy) {
      text.textContent = '正在分析当前局面（' + coachSims() + ' 次）…';
    } else if (humanTurn()) {
      text.textContent = '轮到你，可点「提示」（教练 ' + coachSims() + ' 次）。';
    } else if (state.thinking) {
      text.textContent = 'AI 思考中，等它落子后我再分析。';
    } else {
      text.textContent = '等轮到你时，我会先看当前局面。';
    }
  }

  function cancelCoach() {
    state.coach.epoch++;
    state.coach.busy = false;
    state.coach.analysis = null;
    state.coach.analysisKey = '';
    state.coach.hint = null;
  }

  function setCoach(on) {
    if (!coachApi || !coach) return;
    state.coach.enabled = !!on;
    var btn = document.getElementById('toggle-coach');
    if (btn) {
      btn.classList.toggle('is-on', state.coach.enabled);
      btn.setAttribute('aria-pressed', String(state.coach.enabled));
    }
    if (!state.coach.enabled) {
      cancelCoach();
      state.coach.feedback = null;
      updateCoachPanel();
      scheduleDraw();
      return;
    }
    state.coach.feedback = null;
    state.coach.hint = null;
    updateCoachPanel();
    scheduleCoach();
    scheduleDraw();
  }

  function scheduleCoach() {
    if (!coachApi || !coach || !state.coach.enabled) return;
    if (!humanTurn() || state.coach.busy) return;

    var key = coachApi.boardKey(state.board);
    if (state.coach.analysis && state.coach.analysisKey === key) return;

    var board = state.board.clone();
    var epoch = ++state.coach.epoch;
    state.coach.busy = true;
    state.coach.analysis = null;
    state.coach.analysisKey = '';
    state.coach.hint = null;
    state.coach.feedback = null;
    updateCoachPanel();

    coach.analyze(board, BLACK, {
      sims: coachSims(),
      shouldAbort: function () { return epoch !== state.coach.epoch; }
    }).then(function (res) {
      if (epoch !== state.coach.epoch) return;
      state.coach.busy = false;
      if (!res || res.move === null) { updateCoachPanel(); return; }
      if (coachApi.boardKey(state.board) !== key) { updateCoachPanel(); return; }
      state.coach.analysis = res;
      state.coach.analysisKey = key;
      updateCoachPanel();
      scheduleDraw();
    }).catch(function (err) {
      if (epoch !== state.coach.epoch) return;
      state.coach.busy = false;
      updateCoachPanel();
      console.error('coach analyze failed', err);
    });
  }

  async function showHint() {
    if (!coachApi || !coach || !state.coach.enabled || !humanTurn() || state.coach.busy) return;

    var key = coachApi.boardKey(state.board);
    if (!state.coach.analysis || state.coach.analysisKey !== key) {
      var board = state.board.clone();
      var epoch = ++state.coach.epoch;
      state.coach.busy = true;
      updateCoachPanel();
      try {
        var res = await coach.analyze(board, BLACK, {
          sims: coachSims(),
          shouldAbort: function () { return epoch !== state.coach.epoch; }
        });
        if (epoch !== state.coach.epoch) return;
        if (!res || res.move === null) return;
        if (coachApi.boardKey(state.board) !== key) return;
        state.coach.analysis = res;
        state.coach.analysisKey = key;
      } finally {
        if (epoch === state.coach.epoch) state.coach.busy = false;
      }
    }

    var all = state.coach.analysis.moveValues.slice();
    var stable = all.filter(function (m) { return m.visits >= 5; })
      .sort(function (a, b) { return b.q - a.q; });
    var rest = all.filter(function (m) { return m.visits < 5; })
      .sort(function (a, b) { return b.visits - a.visits; });
    state.coach.hint = { moves: stable.concat(rest).slice(0, 3) };
    state.coach.feedback = null;
    updateCoachPanel();
    render();
  }

  function coachFeedback(before, move, analysis) {
    if (!coachApi || !coach || !state.coach.enabled) return;

    var fb = null;
    if (analysis && analysis.moveValues && analysis.moveValues.length) {
      var judged = coach.judge(analysis, move);
      if (judged) {
        var ex = coach.explain(before, move, judged.loss);
        var bestName = coachMoveName(judged.best.move);
        var text;
        if (judged.label === '好棋' || judged.label === '更优') {
          text = '这手' + judged.label + '。';
        } else {
          text = judged.label + ' ' + Math.abs(judged.loss).toFixed(2) +
            '。更好的是 ' + bestName + '（' + ex.reason + '）';
        }
        fb = {
          quality: 'full',
          label: judged.label,
          loss: judged.loss,
          bestMove: judged.best.move,
          actualMove: move,
          reason: ex.reason,
          text: text
        };
      }
    }

    if (!fb) {
      var q = coach.quick(before, BLACK, move);
      var d = q.delta;
      fb = {
        quality: 'quick',
        delta: d,
        bestMove: q.bestMove,
        actualMove: move,
        text: '快速评估：估值' + (d >= 0 ? '下降 ' : '上升 ') +
          Math.abs(d).toFixed(2) + '；参考 ' + coachMoveName(q.bestMove) + '。'
      };
    }

    fb.boardKey = coachApi.boardKey(state.board);
    state.coach.feedback = fb;
    state.coach.hint = null;
    state.coach.busy = false;
    state.coach.history.push({
      move: move,
      quality: fb.quality,
      label: fb.label || '',
      loss: fb.loss || 0,
      bestMove: fb.bestMove,
      reason: fb.reason || '',
      boardKey: fb.boardKey
    });
    updateCoachPanel();
    scheduleDraw();
  }

  function drawCoachOverlay() {
    if (!coachApi) return;
    if (state.coach.hint && state.coach.hint.moves) {
      for (var i = 0; i < state.coach.hint.moves.length; i++) {
        var mv = state.coach.hint.moves[i].move;
        var cx = (mv & 7) * CELL + CELL / 2;
        var cy = (mv >> 3) * CELL + CELL / 2;
        ctx.save();
        ctx.strokeStyle = i === 0 ? 'rgba(242,196,92,0.95)' : 'rgba(242,196,92,0.55)';
        ctx.lineWidth = i === 0 ? 3 : 2;
        if (i > 0) ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(cx, cy, CELL * 0.44, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        ctx.fillStyle = i === 0 ? 'rgba(242,196,92,0.95)' : 'rgba(242,196,92,0.65)';
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(String(i + 1), cx - CELL * 0.36, cy - CELL * 0.34);
      }
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    }

    var fb = state.coach.feedback;
    if (!fb || fb.boardKey !== coachApi.boardKey(state.board)) return;

    if (fb.bestMove !== undefined && fb.bestMove !== null) {
      var bx = (fb.bestMove & 7) * CELL + CELL / 2;
      var by = (fb.bestMove >> 3) * CELL + CELL / 2;
      ctx.save();
      ctx.strokeStyle = 'rgba(242,196,92,0.75)';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.arc(bx, by, CELL * 0.44, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    var ax = (fb.actualMove & 7) * CELL + CELL / 2;
    var ay = (fb.actualMove >> 3) * CELL + CELL / 2;
    var color = fb.label === '失误' ? '#ff6b5a' :
      (fb.label === '略亏' ? '#f2c45c' : '#63d29a');
    ctx.beginPath();
    ctx.arc(ax + CELL * 0.3, ay - CELL * 0.3, 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  // ---------- 教练复盘 ----------

  function reviewRows() {
    var rows = [];
    for (var i = 0; i < state.snapshots.length; i++) {
      var snap = state.snapshots[i];
      var log = state.moveLog[i];
      if (!log || snap.mover !== BLACK || log.player !== BLACK) continue;
      var b = new engine.Board();
      b.cells.set(snap.cells);
      b.currentPlayer = snap.currentPlayer;
      b.gameOver = snap.gameOver;
      rows.push({
        ply: i + 1,
        move: log.move,
        board: b,
        cells: snap.cells.slice()
      });
    }
    return rows;
  }

  function setReviewProgress(done, total) {
    var wrap = document.getElementById('review-progress');
    var bar = document.getElementById('review-bar');
    var text = document.getElementById('review-progress-text');
    if (!wrap || !bar || !text) return;
    wrap.hidden = false;
    bar.style.width = (total > 0 ? Math.round((done / total) * 100) : 0) + '%';
    text.textContent = done >= total
      ? '复盘完成'
      : '正在复盘 ' + done + '/' + total + ' 手…';
  }

  function openReview() {
    if (!state.gameOver || !state.coach.enabled || !coach) return;
    state.reviewOpen = true;
    state.reviewEpoch++;
    var epoch = state.reviewEpoch;
    var modal = document.getElementById('review');
    modal.hidden = false;
    document.getElementById('review-close').focus();

    if (state.coach.review) {
      renderReview(state.coach.review);
      return;
    }

    document.getElementById('review-summary').textContent = '正在复盘…';
    document.getElementById('review-list').textContent = '';
    document.getElementById('review-board-wrap').hidden = true;
    buildReview(epoch).catch(function (err) {
      if (epoch !== state.reviewEpoch) return;
      console.error('review failed', err);
      document.getElementById('review-summary').textContent = '复盘失败，请重试。';
      document.getElementById('review-progress').hidden = true;
    });
  }

  async function buildReview(epoch) {
    var rows = reviewRows();
    if (!rows.length) {
      document.getElementById('review-summary').textContent = '这局没有可复盘的人类走法。';
      document.getElementById('review-progress').hidden = true;
      return;
    }

    var results = [];
    for (var k = 0; k < rows.length; k++) {
      if (epoch !== state.reviewEpoch) return;
      setReviewProgress(k, rows.length);
      var res = await coach.analyze(rows[k].board, BLACK, {
        sims: 320,
        shouldAbort: function () { return epoch !== state.reviewEpoch; }
      });
      if (epoch !== state.reviewEpoch) return;
      if (!res || res.move === null) continue;

      var judged = coach.judge(res, rows[k].move);
      if (!judged) continue;
      var ex = coach.explain(rows[k].board, rows[k].move, judged.loss);
      results.push({
        ply: rows[k].ply,
        move: rows[k].move,
        cells: rows[k].cells,
        loss: judged.loss,
        best: judged.best.move,
        label: judged.label,
        reason: ex.reason
      });
    }

    setReviewProgress(rows.length, rows.length);

    var sorted = results.slice().sort(function (a, b) { return b.loss - a.loss; });
    var mistakes = sorted.filter(function (r) { return r.loss >= 0.10; });
    var items = sorted.slice(0, 5);

    var maxLoss = results.reduce(function (m, r) { return Math.max(m, r.loss); }, 0);
    var summary;
    if (!mistakes.length) {
      summary = '本局没有明显失误（最大损失 ' + maxLoss.toFixed(2) + '）；下面是最接近的几手。';
    } else {
      summary = '本局 ' + mistakes.length + ' 处明显失误，最大损失 ' +
        mistakes[0].loss.toFixed(2) + '。点击查看局面。';
    }

    state.coach.review = { items: items, all: results, summary: summary };
    renderReview(state.coach.review);
  }

  function renderReview(review) {
    document.getElementById('review-summary').textContent = review.summary;
    document.getElementById('review-progress').hidden = true;

    var list = document.getElementById('review-list');
    list.textContent = '';
    var detail = document.getElementById('review-detail');
    detail.textContent = '';

    if (!review.items.length) {
      var empty = document.createElement('li');
      empty.className = 'review-empty';
      empty.textContent = '没有明显失误';
      list.appendChild(empty);
      document.getElementById('review-board-wrap').hidden = true;
      return;
    }

    for (var i = 0; i < review.items.length; i++) {
      (function (item, idx) {
        var li = document.createElement('li');
        li.dataset.index = String(idx);

        var ply = document.createElement('span');
        ply.className = 'rv-ply';
        ply.textContent = '第 ' + item.ply + ' 手';

        var mv = document.createElement('span');
        mv.className = 'rv-move';
        mv.textContent = coachMoveName(item.move);

        var loss = document.createElement('span');
        loss.className = 'rv-loss';
        loss.textContent = '亏 ' + item.loss.toFixed(2);

        var best = document.createElement('span');
        best.className = 'rv-best';
        best.textContent = '最佳 ' + coachMoveName(item.best);

        li.appendChild(ply);
        li.appendChild(mv);
        li.appendChild(loss);
        li.appendChild(best);
        li.addEventListener('click', function () {
          selectReviewItem(item, li);
        });
        list.appendChild(li);
      })(review.items[i], i);
    }

    var first = list.firstElementChild;
    if (first) selectReviewItem(review.items[0], first);
  }

  function selectReviewItem(item, li) {
    var all = document.querySelectorAll('#review-list li');
    for (var i = 0; i < all.length; i++) all[i].classList.remove('is-active');
    if (li) li.classList.add('is-active');

    var wrap = document.getElementById('review-board-wrap');
    wrap.hidden = false;
    drawReviewBoard(document.getElementById('review-board'), item.cells, item.move, item.best);

    document.getElementById('review-detail').textContent =
      '第 ' + item.ply + ' 手 ' + coachMoveName(item.move) + '：' +
      item.label + '，亏 ' + item.loss.toFixed(2) + '。最佳 ' +
      coachMoveName(item.best) + '（' + item.reason + '）。';
  }

  function drawReviewBoard(canvas, cells, actual, best) {
    var c = canvas.getContext('2d');
    var n = 8;
    var cell = canvas.width / n;
    var r, col;
    for (r = 0; r < n; r++) {
      for (col = 0; col < n; col++) {
        c.fillStyle = (r + col) % 2 === 0 ? '#2f7a5c' : '#256b4f';
        c.fillRect(col * cell, r * cell, cell, cell);
        c.strokeStyle = 'rgba(10, 16, 26, 0.35)';
        c.lineWidth = 1;
        c.strokeRect(col * cell + 0.5, r * cell + 0.5, cell, cell);
      }
    }

    for (var i = 0; i < 64; i++) {
      var piece = cells[i];
      if (!piece) continue;
      var cx = (i & 7) * cell + cell / 2;
      var cy = (i >> 3) * cell + cell / 2;
      c.beginPath();
      c.arc(cx, cy, cell * 0.36, 0, Math.PI * 2);
      c.fillStyle = piece === 1 ? '#171b22' : '#eef2f6';
      c.fill();
      c.strokeStyle = piece === 1 ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.18)';
      c.lineWidth = 1;
      c.stroke();
    }

    if (best !== null && best !== undefined) {
      var bx = (best & 7) * cell + cell / 2;
      var by = (best >> 3) * cell + cell / 2;
      c.save();
      c.strokeStyle = 'rgba(242,196,92,0.85)';
      c.lineWidth = 2;
      c.setLineDash([5, 4]);
      c.beginPath();
      c.arc(bx, by, cell * 0.42, 0, Math.PI * 2);
      c.stroke();
      c.restore();
    }

    var ax = (actual & 7) * cell + cell / 2;
    var ay = (actual >> 3) * cell + cell / 2;
    c.beginPath();
    c.strokeStyle = '#ff8a7a';
    c.lineWidth = 2.5;
    c.arc(ax, ay, cell * 0.3, 0, Math.PI * 2);
    c.stroke();
  }

  function closeReview() {
    state.reviewOpen = false;
    state.reviewEpoch++;
    var modal = document.getElementById('review');
    if (modal) modal.hidden = true;
    var btn = document.getElementById('btn-review');
    if (btn && !btn.hidden) btn.focus();
    if (state.coach.enabled) updateCoachPanel();
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
   * 新落子：从 82% 轻微放大淡入，不做回弹。
   * 被翻的棋子：新子先完整画在下面，旧子缩小 6% 并淡出；不压扁、不抬起。
   */
  function drawAnimatedPiece(anim, cx, cy, now) {
    var p = animProgress(anim, now);

    if (p <= 0) {
      if (anim.from !== 0) drawPiece(cx, cy, CELL * 0.4, anim.from);
      return;
    }

    var e = easeOutCubic(p);

    if (anim.from === 0) {
      var scale = 0.82 + 0.18 * e;
      ctx.save();
      ctx.globalAlpha = Math.min(1, p * 1.8);
      ctx.translate(cx, cy);
      ctx.scale(scale, scale);
      drawPiece(0, 0, CELL * 0.4, anim.to);
      ctx.restore();
      return;
    }

    // 新颜色先画满，旧颜色像一层薄幕退场，避免两色同时半透明糊成灰块
    drawPiece(cx, cy, CELL * 0.4, anim.to);

    ctx.save();
    ctx.globalAlpha = 1 - e;
    ctx.translate(cx, cy);
    var shrink = 1 - 0.06 * e;
    ctx.scale(shrink, shrink);
    drawPiece(0, 0, CELL * 0.4, anim.from);
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

    if (state.coach.enabled) drawCoachOverlay();

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
      if (state.coach.enabled) scheduleCoach();
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
    var mover = state.board.currentPlayer;
    state.moveLog.push({ move: idx, player: mover });
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
        delay: Math.min(70, dist * ANIM_STEP)
      });
    }

    state.animStart = performance.now();
    state.anims = anims;
    state.lastMove = idx;
    state.gameOver = state.board.isTerminal();
    if (state.gameOver) recordResult();
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

    // 先留下落子前的棋盘；如果预分析已完成，就用它的 Q 直接点评
    var before = state.board.clone();
    var analysis = (coachApi && state.coach.analysis &&
      state.coach.analysisKey === coachApi.boardKey(state.board)) ? state.coach.analysis : null;

    if (state.coach.enabled) cancelCoach();

    snapshot(BLACK);
    applyMove(idx);

    if (state.coach.enabled) coachFeedback(before, idx, analysis);

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
        if (state.coach.enabled) scheduleCoach();
        return;
      }

      snapshot(player);
      applyMove(result.move);
    }

    if (state.coach.enabled) scheduleCoach();
  }

  // ---------- 战绩 ----------

  function loadRecords() {
    try {
      var raw = window.localStorage.getItem(RECORDS_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.filter(function (r) {
        return r && typeof r.t === 'number' &&
          (r.result === 'win' || r.result === 'loss' || r.result === 'draw') &&
          typeof r.black === 'number' && typeof r.white === 'number';
      }).slice(0, RECORDS_LIMIT);
    } catch (e) {
      return [];
    }
  }

  function saveRecords() {
    try {
      window.localStorage.setItem(RECORDS_KEY, JSON.stringify(state.records));
    } catch (e) {
      // 隐私模式 / 存储满：保留内存里的记录即可
    }
  }

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function formatRecordTime(t) {
    var d = new Date(t);
    return (d.getMonth() + 1) + '-' + d.getDate() + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function simsLabel(sims) {
    if (sims === 80) return '轻松';
    if (sims === 160) return '标准';
    if (sims === 320) return '认真';
    return sims + ' 模拟';
  }

  function recordResult() {
    if (state.recorded || !state.gameOver) return;

    var winner = state.board.winner();
    var score = state.board.score();
    var rec = {
      t: Date.now(),
      result: winner === 0 ? 'draw' : (winner === BLACK ? 'win' : 'loss'),
      black: score[0],
      white: score[1],
      sims: state.sims,
      plies: state.snapshots.length
    };

    state.records.unshift(rec);
    if (state.records.length > RECORDS_LIMIT) state.records.length = RECORDS_LIMIT;
    state.recorded = true;
    state.recordedAt = rec.t;
    saveRecords();
    if (state.recordsOpen) renderRecords();
  }

  function removeRecord(t) {
    state.records = state.records.filter(function (r) { return r.t !== t; });
    saveRecords();
    if (state.recordsOpen) renderRecords();
  }

  function renderRecords() {
    var list = document.getElementById('records-list');
    var summary = document.getElementById('records-summary');
    var clear = document.getElementById('records-clear');
    if (!list || !summary || !clear) return;

    list.textContent = '';
    if (!state.records.length) {
      summary.textContent = '还没有对局记录。';
      clear.disabled = true;
      return;
    }

    var wins = 0, losses = 0, draws = 0;
    for (var i = 0; i < state.records.length; i++) {
      var r = state.records[i];
      if (r.result === 'win') wins++;
      else if (r.result === 'loss') losses++;
      else draws++;
    }
    var rate = Math.round((wins / state.records.length) * 100);
    summary.textContent = '最近 ' + state.records.length + ' 局：' +
      wins + ' 胜 ' + losses + ' 负 ' + draws + ' 平 · 胜率 ' + rate + '%';
    clear.disabled = false;

    for (var j = 0; j < state.records.length; j++) {
      var rec = state.records[j];
      var li = document.createElement('li');

      var date = document.createElement('span');
      date.className = 'rec-date';
      date.textContent = formatRecordTime(rec.t);

      var result = document.createElement('span');
      result.className = 'rec-result ' + rec.result;
      result.textContent = rec.result === 'win' ? '胜' : (rec.result === 'loss' ? '负' : '平');

      var score = document.createElement('span');
      score.className = 'rec-score';
      score.textContent = '黑 ' + rec.black + ' : ' + rec.white;

      var meta = document.createElement('span');
      meta.className = 'rec-meta';
      meta.textContent = simsLabel(rec.sims);

      li.appendChild(date);
      li.appendChild(result);
      li.appendChild(score);
      li.appendChild(meta);
      list.appendChild(li);
    }
  }

  function openRecords() {
    state.recordsOpen = true;
    renderRecords();
    document.getElementById('records').hidden = false;
    document.getElementById('records-close').focus();
  }

  function closeRecords() {
    state.recordsOpen = false;
    document.getElementById('records').hidden = true;
    document.getElementById('btn-records').focus();
  }

  function clearRecords() {
    if (!state.records.length) return;
    if (!window.confirm('清空最近 30 局记录？')) return;
    state.records = [];
    state.recorded = false;
    state.recordedAt = 0;
    saveRecords();
    renderRecords();
  }

  function undo() {
    if (state.thinking) return;
    var target = -1;
    for (var i = state.snapshots.length - 1; i >= 0; i--) {
      if (state.snapshots[i].mover === BLACK) { target = i; break; }
    }
    if (target < 0) return;

    // 终局后撤销：把刚记录的那一局从战绩里移除，避免重复
    if (state.recorded) {
      removeRecord(state.recordedAt);
      state.recorded = false;
      state.recordedAt = 0;
    }

    var snap = state.snapshots[target];
    state.board.cells.set(snap.cells);
    state.board.currentPlayer = snap.currentPlayer;
    state.board.gameOver = snap.gameOver;
    state.snapshots.length = target;
    state.moveLog.length = target;
    state.coach.review = null;

    state.gameOver = false;
    state.lastMove = -1;
    state.anims = [];
    state.animating = false;
    state.lastSearch = null;
    if (coach) {
      cancelCoach();
      state.coach.feedback = null;
      state.coach.hint = null;
      state.coach.history = [];
    }
    if (mcts) mcts.resetCache();
    state.blackRate = evaluateBlackRate();
    document.getElementById('status').textContent = '';
    render();
    if (state.coach.enabled) scheduleCoach();
  }

  function newGame() {
    state.epoch++;
    if (coach) {
      cancelCoach();
      state.coach.feedback = null;
      state.coach.hint = null;
      state.coach.history = [];
    }
    state.board.reset();
    state.snapshots = [];
    state.moveLog = [];
    state.reviewOpen = false;
    state.reviewEpoch++;
    var reviewModal = document.getElementById('review');
    if (reviewModal) reviewModal.hidden = true;
    state.coach.review = null;
    state.thinking = false;
    state.gameOver = false;
    state.recorded = false;
    state.recordedAt = 0;
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
    if (state.coach.enabled) scheduleCoach();
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

    document.getElementById('btn-records').addEventListener('click', openRecords);
    document.getElementById('records-close').addEventListener('click', closeRecords);
    document.getElementById('records').addEventListener('click', function (e) {
      if (e.target === e.currentTarget) closeRecords();
    });
    document.getElementById('records-clear').addEventListener('click', clearRecords);

    // 点遮罩空白处关闭；弹窗打开时把焦点圈在弹窗内
    document.getElementById('rules').addEventListener('click', function (e) {
      if (e.target === e.currentTarget) hideRules();
    });
    document.addEventListener('keydown', function (e) {
      if (state.reviewOpen) {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeReview();
        } else if (e.key === 'Tab') {
          e.preventDefault();
          document.getElementById('review-close').focus();
        }
        return;
      }
      if (state.recordsOpen) {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeRecords();
        } else if (e.key === 'Tab') {
          e.preventDefault();
          document.getElementById('records-close').focus();
        }
        return;
      }
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

        // 难度变了，教练预算也变；丢弃旧分析并重新预分析
        if (state.coach.enabled) {
          cancelCoach();
          state.coach.feedback = null;
          state.coach.review = null;
          updateCoachPanel();
          scheduleCoach();
        }
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

    var coachToggle = document.getElementById('toggle-coach');
    if (coachToggle) {
      coachToggle.addEventListener('click', function () {
        setCoach(!state.coach.enabled);
      });
    }

    var hintBtn = document.getElementById('btn-hint');
    if (hintBtn) {
      hintBtn.addEventListener('click', function () {
        showHint();
      });
    }

    var reviewBtn = document.getElementById('btn-review');
    if (reviewBtn) reviewBtn.addEventListener('click', openReview);

    document.getElementById('review-close').addEventListener('click', closeReview);
    document.getElementById('review-close-btn').addEventListener('click', closeReview);
    document.getElementById('review').addEventListener('click', function (e) {
      if (e.target === e.currentTarget) closeReview();
    });
  }

  function render() {
    updateDom();
    drawBoard();
    if (state.coach.enabled) updateCoachPanel();
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
    state.records = loadRecords();

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
    if (coachApi) {
      coach = new coachApi.Coach(net, { sims: state.coach.sims });
    } else {
      var coachToggle = document.getElementById('toggle-coach');
      if (coachToggle) coachToggle.hidden = true;
    }

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
    render: render,
    records: function () { return state.records.slice(); },
    recordResult: recordResult,
    get coach() { return coach; },
    coachState: state.coach
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
