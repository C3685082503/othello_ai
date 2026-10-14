const BOARD_SIZE = 8;
const CELL_SIZE = 60;
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');

let gameId = null;
let boardState = null;
let isAiThinking = false;

// ---------- 渲染增强：动画与交互状态 ----------
let anims = [];            // 落子动画队列 {row, col, t}
let lastBoard = null;      // 上一帧棋盘，用于检测新落子
let hoverCell = null;      // 鼠标悬浮格子 [r, c]
let hoverDirty = false;

function easeOutBack(t) {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

// 检测相对上一帧新增的棋子
function detectNewCells() {
    const newCells = [];
    if (lastBoard) {
        for (let r = 0; r < BOARD_SIZE; r++) {
            for (let c = 0; c < BOARD_SIZE; c++) {
                if (!lastBoard[r][c] && boardState.board[r][c]) newCells.push([r, c]);
            }
        }
    }
    lastBoard = boardState.board.map(row => row.slice());
    return newCells;
}

// 落子动画主循环
function frame() {
    let running = false;
    for (const a of anims) { a.t += 0.11; if (a.t < 1) running = true; }
    anims = anims.filter(a => a.t < 1);
    drawBoard();
    if (running) requestAnimationFrame(frame);
}

function scheduleDraw() {
    if (hoverDirty) return;
    hoverDirty = true;
    requestAnimationFrame(() => { hoverDirty = false; drawBoard(); });
}

// 绘制立体棋子（cx, cy 为圆心，radius 为半径）
function drawPiece(cx, cy, radius, player) {
    if (radius <= 0.5) return;
    // 投影
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = radius * 0.3;
    ctx.shadowOffsetY = radius * 0.1;
    const grad = ctx.createRadialGradient(cx - radius * 0.32, cy - radius * 0.4, radius * 0.12, cx, cy, radius);
    if (player === 1) { // 黑
        grad.addColorStop(0, '#575d66');
        grad.addColorStop(0.5, '#25282e');
        grad.addColorStop(1, '#08090b');
    } else { // 白
        grad.addColorStop(0, '#ffffff');
        grad.addColorStop(0.55, '#edf0f4');
        grad.addColorStop(1, '#c0c6cf');
    }
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();
    // 边缘描边
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1, radius * 0.05);
    ctx.strokeStyle = player === 1 ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.14)';
    ctx.stroke();
    // 高光
    ctx.beginPath();
    ctx.ellipse(cx - radius * 0.32, cy - radius * 0.42, radius * 0.32, radius * 0.2, -0.6, 0, Math.PI * 2);
    ctx.fillStyle = player === 1 ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.9)';
    ctx.fill();
}

// 绘制棋盘主函数（供 render / 动画 / hover 复用）
function drawBoard() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 绘制网格
    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            ctx.fillStyle = (r + c) % 2 === 0 ? '#2f7a5c' : '#256b4f';
            ctx.fillRect(c * CELL_SIZE, r * CELL_SIZE, CELL_SIZE, CELL_SIZE);
            ctx.strokeStyle = 'rgba(10, 16, 26, 0.35)';
            ctx.lineWidth = 1;
            ctx.strokeRect(c * CELL_SIZE + 0.5, r * CELL_SIZE + 0.5, CELL_SIZE, CELL_SIZE);
        }
    }

    // 悬浮格高亮（画在棋子下层）
    if (hoverCell && !boardState.game_over && !isAiThinking) {
        const [hr, hc] = hoverCell;
        ctx.fillStyle = 'rgba(242, 196, 92, 0.13)';
        ctx.fillRect(hc * CELL_SIZE, hr * CELL_SIZE, CELL_SIZE, CELL_SIZE);
    }

    // 绘制棋子
    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            const piece = boardState.board[r][c];
            if (piece === 0) continue;
            const cx = c * CELL_SIZE + CELL_SIZE / 2;
            const cy = r * CELL_SIZE + CELL_SIZE / 2;
            const a = anims.find(x => x.row === r && x.col === c);
            if (a) {
                // 翻入动画：横向压扁 + 透明度过渡 + 轻微放大
                const sx = Math.sin(a.t * Math.PI / 2);
                ctx.save();
                ctx.globalAlpha = 0.3 + 0.7 * a.t;
                ctx.translate(cx, cy);
                ctx.scale(sx, 1);
                drawPiece(0, 0, CELL_SIZE * 0.4, piece);
                ctx.restore();
            } else {
                drawPiece(cx, cy, CELL_SIZE * 0.4, piece);
            }
        }
    }

    // 合法走法提示
    if (!boardState.game_over && !isAiThinking) {
        const legalSet = new Set(boardState.legal_moves.map(m => m[0] * 10 + m[1]));
        for (const [r, c] of boardState.legal_moves) {
            const cx = c * CELL_SIZE + CELL_SIZE / 2;
            const cy = r * CELL_SIZE + CELL_SIZE / 2;
            const hovering = hoverCell && hoverCell[0] === r && hoverCell[1] === c;
            ctx.beginPath();
            ctx.arc(cx, cy, CELL_SIZE * (hovering ? 0.2 : 0.15), 0, Math.PI * 2);
            ctx.strokeStyle = hovering ? 'rgba(242,196,92,0.95)' : 'rgba(242,196,92,0.7)';
            ctx.lineWidth = hovering ? 2.2 : 1.6;
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(cx, cy, CELL_SIZE * 0.05, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(242,196,92,0.9)';
            ctx.fill();
        }
        void legalSet;
    }
}

// 更新 DOM（分数 / 回合 / 胜率 / 卡片高亮）
function updateDom() {
    document.getElementById('black-score').textContent = boardState.black_score;
    document.getElementById('white-score').textContent = boardState.white_score;

    const blackCard = document.getElementById('black-card');
    const whiteCard = document.getElementById('white-card');
    const turn = document.getElementById('turn-indicator');

    if (boardState.game_over) {
        blackCard.classList.remove('is-active');
        whiteCard.classList.remove('is-active');
        turn.textContent = '对局结束';
        turn.className = 'turn-badge is-done';
    } else {
        const isBlackTurn = boardState.current_player === 1;
        blackCard.classList.toggle('is-active', isBlackTurn);
        whiteCard.classList.toggle('is-active', !isBlackTurn);
        turn.textContent = isBlackTurn ? '轮到黑棋' : '轮到白棋';
        turn.className = 'turn-badge ' + (isBlackTurn ? 'is-black' : 'is-white');
    }

    // 胜率条 + 百分比文本
    const blackBar = document.getElementById('black-bar');
    const whiteBar = document.getElementById('white-bar');
    const rateText = document.getElementById('win-rate-text');
    if (blackBar && whiteBar && boardState.win_rate !== undefined) {
        const rate = boardState.win_rate;
        if (boardState.current_player === 1) {
            blackBar.style.width = (rate * 100) + '%';
            whiteBar.style.width = ((1 - rate) * 100) + '%';
        } else {
            whiteBar.style.width = (rate * 100) + '%';
            blackBar.style.width = ((1 - rate) * 100) + '%';
        }
        if (rateText) rateText.textContent = Math.round(rate * 100) + '%';
    }
}

// 主渲染入口：更新数据 + 触发动画 + 重绘
function render() {
    const newCells = detectNewCells();
    for (const nc of newCells) anims.push({ row: nc[0], col: nc[1], t: 0 });
    if (newCells.length && !boardState.game_over) requestAnimationFrame(frame);
    updateDom();
    drawBoard();
}

// ---------- 网络逻辑 ----------
async function newGame() {
    const res = await fetch('/new_game', { method: 'POST' });
    const data = await res.json();
    gameId = data.game_id;
    boardState = data;
    isAiThinking = false;
    lastBoard = null;
    anims = [];
    render();
    document.getElementById('status').textContent = '';
}

async function playerMove(row, col) {
    if (isAiThinking || boardState.game_over) return;
    if (!boardState.legal_moves.some(m => m[0] === row && m[1] === col)) return;

    // 玩家落子
    const res = await fetch('/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game_id: gameId, row, col })
    });
    boardState = await res.json();
    render();

    if (boardState.game_over) { showResult(); return; }

    // AI 走子
    isAiThinking = true;
    document.getElementById('status').textContent = 'AI 正在思考...';
    const aiRes = await fetch(`/ai_move?game_id=${gameId}`, { method: 'POST' });
    boardState = await aiRes.json();
    isAiThinking = false;
    render();

    if (boardState.game_over) showResult();
    else document.getElementById('status').textContent = '';
}

async function undoMove() {
    if (isAiThinking || !gameId) return;
    const res = await fetch(`/undo?game_id=${gameId}`, { method: 'POST' });
    if (!res.ok) return;
    boardState = await res.json();
    lastBoard = null;
    anims = [];
    render();
    document.getElementById('status').textContent = '';
}

function showResult() {
    const w = boardState.winner;
    let msg = w === 0 ? '平局！' : (w === 1 ? '黑棋获胜！' : '白棋获胜！');
    document.getElementById('status').textContent =
        `${msg} 黑: ${boardState.black_score} / 白: ${boardState.white_score}`;
}

// ---------- 交互事件 ----------
canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / rect.width;   // 适配 CSS 缩放
    const col = Math.floor((e.clientX - rect.left) * scale / CELL_SIZE);
    const row = Math.floor((e.clientY - rect.top) * scale / CELL_SIZE);
    playerMove(row, col);
});

canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / rect.width;
    const col = Math.floor((e.clientX - rect.left) * scale / CELL_SIZE);
    const row = Math.floor((e.clientY - rect.top) * scale / CELL_SIZE);
    if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return;
    if (!hoverCell || hoverCell[0] !== row || hoverCell[1] !== col) {
        hoverCell = [row, col];
        scheduleDraw();
    }
});

canvas.addEventListener('mouseleave', () => {
    if (hoverCell) { hoverCell = null; drawBoard(); }
});

// 页面加载时自动开始新对局
newGame();
