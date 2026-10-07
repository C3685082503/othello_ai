const BOARD_SIZE = 8;
const CELL_SIZE = 60;
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');

let gameId = null;
let boardState = null;
let isAiThinking = false;

async function newGame() {
    const res = await fetch('/new_game', { method: 'POST' });
    const data = await res.json();
    gameId = data.game_id;
    boardState = data;
    isAiThinking = false;
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
    render();
    document.getElementById('status').textContent = '';
}

function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 绘制网格
    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            ctx.fillStyle = (r + c) % 2 === 0 ? '#3a8c68' : '#2d6a4f';
            ctx.fillRect(c * CELL_SIZE, r * CELL_SIZE, CELL_SIZE, CELL_SIZE);
            ctx.strokeStyle = '#1a1a2e';
            ctx.strokeRect(c * CELL_SIZE, r * CELL_SIZE, CELL_SIZE, CELL_SIZE);
        }
    }

    // 绘制棋子
    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            const piece = boardState.board[r][c];
            if (piece === 0) continue;
            const cx = c * CELL_SIZE + CELL_SIZE / 2;
            const cy = r * CELL_SIZE + CELL_SIZE / 2;
            ctx.beginPath();
            ctx.arc(cx, cy, CELL_SIZE * 0.4, 0, Math.PI * 2);
            ctx.fillStyle = piece === 1 ? '#111' : '#fff';
            ctx.fill();
            ctx.strokeStyle = '#888';
            ctx.stroke();
        }
    }

    // 绘制合法走法提示
    if (!boardState.game_over && !isAiThinking) {
        for (const [r, c] of boardState.legal_moves) {
            const cx = c * CELL_SIZE + CELL_SIZE / 2;
            const cy = r * CELL_SIZE + CELL_SIZE / 2;
            ctx.beginPath();
            ctx.arc(cx, cy, 6, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(240, 192, 64, 0.6)';
            ctx.fill();
        }
    }

    // 更新比分
    document.getElementById('black-score').textContent = boardState.black_score;
    document.getElementById('white-score').textContent = boardState.white_score;
    const turn = boardState.current_player === 1 ? '黑棋' : '白棋';
    document.getElementById('turn-indicator').textContent =
        boardState.game_over ? '对局结束' : `轮到${turn}`;

    // 更新胜率条
    const blackBar = document.getElementById('black-bar');
    const whiteBar = document.getElementById('white-bar');
    if (blackBar && whiteBar && boardState.win_rate !== undefined) {
        const rate = boardState.win_rate;
        if (boardState.current_player === 1) {
            blackBar.style.width = (rate * 100) + '%';
            whiteBar.style.width = ((1 - rate) * 100) + '%';
        } else {
            whiteBar.style.width = (rate * 100) + '%';
            blackBar.style.width = ((1 - rate) * 100) + '%';
        }
    }
}

function showResult() {
    const w = boardState.winner;
    let msg = w === 0 ? '平局！' : (w === 1 ? '黑棋获胜！' : '白棋获胜！');
    document.getElementById('status').textContent =
        `${msg} 黑: ${boardState.black_score} / 白: ${boardState.white_score}`;
}

canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const col = Math.floor((e.clientX - rect.left) / CELL_SIZE);
    const row = Math.floor((e.clientY - rect.top) / CELL_SIZE);
    playerMove(row, col);
});

// 页面加载时自动开始新对局
newGame();