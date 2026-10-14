import numpy as np
from numba import njit

# 1. 用 NumPy 数组存储方向，Numba 最喜欢
DIRECTIONS = np.array([
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1], [0, 1],
    [1, -1], [1, 0], [1, 1]
], dtype=np.int64)


@njit
def get_flips_numba(board, r, c, player):
    """返回翻转棋子的索引数组（只返回真实长度）"""
    flips = np.zeros(64, dtype=np.int64)
    flip_count = 0
    opponent = -player

    for d in range(len(DIRECTIONS)):
        dr, dc = DIRECTIONS[d]
        rr, cc = r + dr, c + dc
        temp = np.zeros(64, dtype=np.int64)
        temp_count = 0

        # 沿方向探索
        while 0 <= rr < 8 and 0 <= cc < 8 and board[rr, cc] == opponent:
            temp[temp_count] = rr * 8 + cc
            temp_count += 1
            rr += dr
            cc += dc

        # 如果最后以己方棋子收尾，说明这一段都能翻转
        if temp_count > 0 and 0 <= rr < 8 and 0 <= cc < 8 and board[rr, cc] == player:
            for i in range(temp_count):
                flips[flip_count] = temp[i]
                flip_count += 1

    return flips[:flip_count]


@njit
def is_legal_numba(board, r, c, player):
    return len(get_flips_numba(board, r, c, player)) > 0


@njit
def legal_moves_numba(board, player):
    """返回合法走法的二维数组，每一行是 (r, c)"""
    moves = np.zeros((64, 2), dtype=np.int64)
    move_count = 0
    for r in range(8):
        for c in range(8):
            if board[r, c] == 0 and is_legal_numba(board, r, c, player):
                moves[move_count, 0] = r
                moves[move_count, 1] = c
                move_count += 1
    return moves[:move_count]


class NumbaBoard:
    def __init__(self):
        self.board = np.zeros((8, 8), dtype=np.int8)
        self.reset()

    def reset(self):
        self.board.fill(0)
        self.board[3][3] = -1
        self.board[3][4] = 1
        self.board[4][3] = 1
        self.board[4][4] = -1
        self.current_player = 1

    def clone(self):
        new_board = NumbaBoard()
        new_board.board = self.board.copy()
        new_board.current_player = self.current_player
        return new_board

    def legal_moves(self, player=None):
        if player is None:
            player = self.current_player
        # 返回结果从 NumPy 数组转为 Python 的元组列表，方便前端和 MCTS 处理
        moves_array = legal_moves_numba(self.board, player)
        return [(int(r), int(c)) for r, c in moves_array]

    def step(self, r, c):
        player = self.current_player
        flips = get_flips_numba(self.board, r, c, player)
        self.board[r][c] = player
        for idx in flips:
            rr, cc = idx // 8, idx % 8
            self.board[rr][cc] = player

        next_player = -player
        if len(legal_moves_numba(self.board, next_player)) > 0:
            self.current_player = next_player
        elif len(legal_moves_numba(self.board, player)) > 0:
            self.current_player = player
        else:
            self.current_player = next_player  # 游戏结束

    def is_terminal(self):
        return len(legal_moves_numba(self.board, 1)) == 0 and len(legal_moves_numba(self.board, -1)) == 0

    def winner(self):
        black = int(np.sum(self.board == 1))
        white = int(np.sum(self.board == -1))
        if black > white: return 1
        elif white > black: return -1
        else: return 0

    def score(self):
        black = int(np.sum(self.board == 1))
        white = int(np.sum(self.board == -1))
        return black, white