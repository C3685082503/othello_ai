import sys
import os

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))

import uuid
import torch
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

from src.game_engine.board import Board, BLACK, WHITE
from src.alphazero.mcts import MCTS
from src.alphazero.encoder import board_to_tensor
from src.alphazero.network import AlphaZeroNet

app = FastAPI(title="AlphaZero Othello Web API")

# 1. 初始化全局游戏状态
# 结构: {game_id: {"board": Board, "history": [Board, ...]}}
games = {}

# 2. 初始化 MCTS（内部已加载模型，用于对局）
mcts_engine = MCTS(c_puct=1.5, num_simulations=50)

# 3. 单独加载网络，用于胜率评估
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
value_net = AlphaZeroNet().to(device)
try:
    value_net.load_state_dict(torch.load('models/alphazero_net.pth', map_location=device))
    value_net.eval()
    print(">>> 胜率评估网络加载成功")
except Exception as e:
    print(f">>> 胜率评估网络加载失败: {e}")

# 4. 挂载静态文件
static_dir = os.path.join(os.path.dirname(__file__), "static")
app.mount("/static", StaticFiles(directory=static_dir), name="static")


class MoveRequest(BaseModel):
    game_id: str
    row: int
    col: int


@app.get("/")
def root():
    return FileResponse(os.path.join(static_dir, "index.html"))


@app.post("/new_game")
def new_game():
    game_id = str(uuid.uuid4())
    games[game_id] = {
        "board": Board(),
        "history": []
    }
    return _board_state(game_id, games[game_id]["board"])


@app.post("/move")
def player_move(req: MoveRequest):
    if req.game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")

    game = games[req.game_id]
    board = game["board"]

    if board.is_terminal():
        raise HTTPException(status_code=400, detail="Game is over")
    if (req.row, req.col) not in board.legal_moves():
        raise HTTPException(status_code=400, detail="Illegal move")

    # 落子前保存历史
    game["history"].append(board.clone())
    board.step(req.row, req.col)

    return _board_state(req.game_id, board)


@app.post("/ai_move")
def ai_move(game_id: str):
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")

    game = games[game_id]
    board = game["board"]

    if board.is_terminal():
        return _board_state(game_id, board)

    player = board.current_player
    move = mcts_engine.search(board, player)

    if move is None:
        board.current_player = -player
        return _board_state(game_id, board)

    # 落子前保存历史
    game["history"].append(board.clone())
    board.step(*move)

    return _board_state(game_id, board)


@app.post("/undo")
def undo(game_id: str):
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")

    game = games[game_id]
    if not game["history"]:
        raise HTTPException(status_code=400, detail="No history to undo")

    # 弹出最后一份存档
    game["board"] = game["history"].pop()
    # 为了撤回玩家和 AI 的一整轮，再弹一次（如果想只撤一步可以去掉这行）
    if game["history"]:
        game["board"] = game["history"].pop()

    return _board_state(game_id, game["board"])


@app.get("/state/{game_id}")
def get_state(game_id: str):
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    return _board_state(game_id, games[game_id]["board"])


def _board_state(game_id: str, board: Board):
    black, white = board.score()
    winner = board.winner() if board.is_terminal() else None

    # === 新增：计算胜率 ===
    win_rate = 0.5
    if not board.is_terminal():
        state_tensor = board_to_tensor(board, board.current_player).unsqueeze(0).to(device)
        with torch.no_grad():
            _, value_tensor = value_net(state_tensor)
            value = value_tensor.item()  # 当前玩家的评估分 [-1, 1]
        win_rate = (value + 1) / 2  # 映射到 [0, 1]
    else:
        win_rate = 1.0 if black > white else (0.0 if black < white else 0.5)
    # ==================

    return {
        "game_id": game_id,
        "board": board.board,
        "current_player": board.current_player,
        "legal_moves": board.legal_moves() if not board.is_terminal() else [],
        "game_over": board.is_terminal(),
        "black_score": black,
        "white_score": white,
        "winner": winner,
        "win_rate": win_rate,  # 新增字段
    }