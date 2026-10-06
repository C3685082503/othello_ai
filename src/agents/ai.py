import random
from src.game_engine.evaluate import evaluate

# 定义全局位置权重，方便排序使用
CORNERS = [(0, 0), (0, 7), (7, 0), (7, 7)]
X_SQUARES = [(1, 1), (1, 6), (6, 1), (6, 6)]
C_SQUARES = [(0, 1), (1, 0), (0, 6), (1, 7), (6, 0), (7, 1), (6, 7), (7, 6)]


def random_ai(board, player):
    moves = board.legal_moves(player)
    return random.choice(moves) if moves else None


def greedy_ai(board, player):
    moves = board.legal_moves(player)
    if not moves: return None
    best_score = -float('inf')
    best_move = moves[0]
    for r, c in moves:
        b = board.clone()
        flips = b.get_flips(r, c, player)
        b.board[r][c] = player
        for rr, cc in flips: b.board[rr][cc] = player
        score = 0
        if (r, c) in CORNERS: score += 1000
        if (r, c) in X_SQUARES: score -= 200
        if r == 0 or r == 7 or c == 0 or c == 7: score += 50
        score += len(flips)
        if score > best_score:
            best_score = score
            best_move = (r, c)
    return best_move


# ================= 走法排序（核心） =================

def order_moves(board, moves, player):
    """
    对合法走法进行排序，让更有希望的走法先被搜索。
    这是 Alpha-Beta 剪枝效率翻倍的关键。
    """
    scored_moves = []
    for (r, c) in moves:
        score = 0
        # 1. 位置权重
        if (r, c) in CORNERS:
            score += 10000
        elif (r, c) in X_SQUARES or (r, c) in C_SQUARES:
            score -= 500
        elif r == 0 or r == 7 or c == 0 or c == 7:
            score += 100

        # 2. 翻转数量作为附加分（翻转越多，通常行动力越好）
        # 这里不克隆棋盘，直接用 get_flips 计算，节省性能
        score += len(board.get_flips(r, c, player)) * 10

        scored_moves.append((score, (r, c)))

    # 按分数从高到低排序，只返回走法列表
    scored_moves.sort(key=lambda x: x[0], reverse=True)
    return [move for _, move in scored_moves]


# ================= 核心搜索算法（加入排序） =================

def minimax(board, depth, ai_player, node_count):
    node_count[0] += 1
    if depth == 0 or board.is_terminal():
        return evaluate(board, ai_player)

    current_player = board.current_player
    moves = order_moves(board, board.legal_moves(current_player), current_player)

    if current_player == ai_player:  # Max 层
        max_eval = -float('inf')
        for move in moves:
            new_board = board.clone()
            new_board.step(*move)
            eval_score = minimax(new_board, depth - 1, ai_player, node_count)
            max_eval = max(max_eval, eval_score)
        return max_eval
    else:  # Min 层
        min_eval = float('inf')
        for move in moves:
            new_board = board.clone()
            new_board.step(*move)
            eval_score = minimax(new_board, depth - 1, ai_player, node_count)
            min_eval = min(min_eval, eval_score)
        return min_eval


def alpha_beta(board, depth, alpha, beta, ai_player, node_count):
    node_count[0] += 1
    if depth == 0 or board.is_terminal():
        return evaluate(board, ai_player)

    current_player = board.current_player
    moves = order_moves(board, board.legal_moves(current_player), current_player)

    if current_player == ai_player:  # Max 层
        max_eval = -float('inf')
        for move in moves:
            new_board = board.clone()
            new_board.step(*move)
            eval_score = alpha_beta(new_board, depth - 1, alpha, beta, ai_player, node_count)
            max_eval = max(max_eval, eval_score)
            alpha = max(alpha, eval_score)
            if beta <= alpha: break  # 剪枝
        return max_eval
    else:  # Min 层
        min_eval = float('inf')
        for move in moves:
            new_board = board.clone()
            new_board.step(*move)
            eval_score = alpha_beta(new_board, depth - 1, alpha, beta, ai_player, node_count)
            min_eval = min(min_eval, eval_score)
            beta = min(beta, eval_score)
            if beta <= alpha: break  # 剪枝
        return min_eval


# ================= 包装成统一接口的 AI =================

def minimax_ai(board, ai_player, depth=2):
    node_count = [0]
    best_score = -float('inf')
    best_move = None

    # 根节点也需要排序！
    moves = order_moves(board, board.legal_moves(ai_player), ai_player)

    for move in moves:
        new_board = board.clone()
        new_board.step(*move)
        eval_score = minimax(new_board, depth - 1, ai_player, node_count)
        if eval_score > best_score:
            best_score = eval_score
            best_move = move
    print(f"[Minimax] 深度: {depth}, 搜索节点: {node_count[0]}, 最优分数: {best_score}")
    return best_move


def alpha_beta_ai(board, ai_player, depth=4):
    node_count = [0]
    best_score = -float('inf')
    best_move = None
    alpha = -float('inf')
    beta = float('inf')

    # 根节点也需要排序！
    moves = order_moves(board, board.legal_moves(ai_player), ai_player)

    for move in moves:
        new_board = board.clone()
        new_board.step(*move)
        eval_score = alpha_beta(new_board, depth - 1, alpha, beta, ai_player, node_count)
        if eval_score > best_score:
            best_score = eval_score
            best_move = move
        alpha = max(alpha, best_score)
    print(f"[Alpha-Beta] 深度: {depth}, 搜索节点: {node_count[0]}, 最优分数: {best_score}")
    return best_move


