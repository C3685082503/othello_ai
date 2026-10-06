import torch
from src.game_engine.board import BLACK

def board_to_tensor(board, player):
    """
    将棋盘转换为 [3, 8, 8] 的张量。
    通道0：当前玩家的棋子
    通道1：对手的棋子
    通道2：当前玩家（全1表示黑棋，全0表示白棋）
    """
    tensor = torch.zeros(3, 8, 8)
    opponent = -player

    for r in range(8):
        for c in range(8):
            piece = board.board[r][c]
            if piece == player:
                tensor[0, r, c] = 1.0
            elif piece == opponent:
                tensor[1, r, c] = 1.0

    # 通道2：如果当前玩家是黑棋，全填1；如果是白棋，全填0
    if player == BLACK:
        tensor[2, :, :] = 1.0

    return tensor

def move_to_index(move):
    """把 (r, c) 坐标转成 0-63 的索引"""
    r, c = move
    return r * 8 + c

def index_to_move(index):
    """把 0-63 的索引转回 (r, c) 坐标"""
    return index // 8, index % 8
