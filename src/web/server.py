import sys
import os

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))

import uuid
import torch
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import List, Optional

from src.game_engine.board import Board, BLACK, WHITE
from src.alphazero.mcts import MCTS

app = FastAPI(title="AlphaZero Othello Web API")

# 全局游戏状态：{game_id: Board}
games = {}

# 加载 MCTS（MCTS 内部已经加载了 models/alphazero_net.pth）
mcts_engine = MCTS(c_puct=1.5, num_simulations=100)

# 挂载静态文件目录
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
    games[game_id] = Board()
    return {
        "game_id": game_id,
        "board": games[game_id].board,
        "current_player": games[game_id].current_player,
        "legal_moves": games[game_id].legal_moves(),
        "game_over": False,
    }


@app.post("/move")
def player_move(req: MoveRequest):
    if req.game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    board = games[req.game_id]

    if board.is_terminal():
        raise HTTPException(status_code=400, detail="Game is over")

    if (req.row, req.col) not in board.legal_moves():
        raise HTTPException(status_code=400, detail="Illegal move")

    board.step(req.row, req.col)
    return _board_state(req.game_id, board)


@app.post("/ai_move")
def ai_move(game_id: str):
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    board = games[game_id]

    if board.is_terminal():
        return _board_state(game_id, board)

    player = board.current_player
    move = mcts_engine.search(board, player)

    if move is None:
        # 无合法走法，跳过
        board.current_player = -player
        return _board_state(game_id, board)

    board.step(*move)
    return _board_state(game_id, board)


@app.get("/state/{game_id}")
def get_state(game_id: str):
    if game_id not in games:
        raise HTTPException(status_code=404, detail="Game not found")
    return _board_state(game_id, games[game_id])


def _board_state(game_id: str, board: Board):
    black, white = board.score()
    winner = board.winner() if board.is_terminal() else None
    return {
        "game_id": game_id,
        "board": board.board,
        "current_player": board.current_player,
        "legal_moves": board.legal_moves() if not board.is_terminal() else [],
        "game_over": board.is_terminal(),
        "black_score": black,
        "white_score": white,
        "winner": winner,
    }