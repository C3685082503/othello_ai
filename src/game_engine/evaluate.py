from src.game_engine.board import BLACK, EMPTY

WEIGHT_CORNER = 1000
WEIGHT_EDGE = 50
WEIGHT_X_SQUARE = -300
WEIGHT_C_SQUARE = -200
WEIGHT_MOBILITY = 20
WEIGHT_PIECE_DIFF = 1

def evaluate(board, player):
    score = 0
    corners = [(0, 0), (0, 7), (7, 0), (7, 7)]
    x_squares = [(1, 1), (1, 6), (6, 1), (6, 6)]
    c_squares = [(0, 1), (1, 0), (0, 6), (1, 7), (6, 0), (7, 1), (6, 7), (7, 6)]

    # 1. 静态位置分数
    for r in range(board.size):
        for c in range(board.size):
            piece = board.board[r][c]
            if piece == EMPTY: continue
            sign = 1 if piece == player else -1
            if (r, c) in corners: score += sign * WEIGHT_CORNER
            elif (r, c) in x_squares: score += sign * WEIGHT_X_SQUARE
            elif (r, c) in c_squares: score += sign * WEIGHT_C_SQUARE
            elif r == 0 or r == 7 or c == 0 or c == 7: score += sign * WEIGHT_EDGE

    # 2. 子数差
    black, white = board.score()
    piece_diff = (black - white) if player == BLACK else (white - black)
    score += piece_diff * WEIGHT_PIECE_DIFF

    # 3. 行动力（关键）
    my_moves = len(board.legal_moves(player))
    opp_moves = len(board.legal_moves(-player))
    if opp_moves == 0 and my_moves > 0:
        score += 500
    score += (my_moves - opp_moves) * WEIGHT_MOBILITY
    return score
