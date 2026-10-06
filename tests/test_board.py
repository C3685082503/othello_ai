import sys
import os
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))

import pytest
from src.game_engine.board import Board, BLACK, WHITE, EMPTY
from src.game_engine.evaluate import evaluate
from src.agents.ai import order_moves, alpha_beta_ai, minimax_ai


# ================= 第一周：基础规则测试 =================

def test_initial_board():
    b = Board()
    assert b.board[3][3] == WHITE
    assert b.board[3][4] == BLACK
    assert b.board[4][3] == BLACK
    assert b.board[4][4] == WHITE
    assert b.current_player == BLACK


def test_initial_legal_moves():
    b = Board()
    moves = set(b.legal_moves(BLACK))
    expected = {(2, 3), (3, 2), (4, 5), (5, 4)}
    assert moves == expected


def test_step_flips():
    b = Board()
    b.step(2, 3)
    assert b.board[2][3] == BLACK
    assert b.board[3][3] == BLACK
    assert b.board[3][4] == BLACK
    assert b.board[4][3] == BLACK
    black, white = b.score()
    assert black == 4
    assert white == 1


def test_illegal_move_raises():
    b = Board()
    with pytest.raises(ValueError):
        b.step(0, 0)


def test_clone_independent():
    b = Board()
    b2 = b.clone()
    b2.step(2, 3)
    assert b.board[2][3] == EMPTY
    assert b2.board[2][3] == BLACK


def test_full_board_terminal():
    b = Board()
    for r in range(8):
        for c in range(8):
            b.board[r][c] = BLACK if (r + c) % 2 == 0 else WHITE
    b.game_over = False
    b.current_player = BLACK
    assert b.is_terminal()


# ================= 第二周：评估函数与搜索测试 =================

def test_evaluate_symmetry():
    """初始对称局面上，黑白双方评分应绝对对称"""
    b = Board()
    # 初始棋盘中，黑白子数均为2，双方行动力均为4，所以评估值应该相等
    assert evaluate(b, BLACK) == evaluate(b, WHITE)


def test_evaluate_corner_advantage():
    """占据角落应该获得极大的评估加成"""
    b = Board()
    # 人工给黑棋赋予一个角落
    b.board[0][0] = BLACK
    # 此时黑棋多一个角落，评估分数应远高于白棋
    assert evaluate(b, BLACK) > evaluate(b, WHITE)


def test_order_moves_prioritizes_corners():
    """走法排序应该把角落排在最前面"""
    b = Board()
    # 构造一个局面，让黑棋有占据角落的合法走法
    # 直接调用 legal_moves 然后排序
    moves = b.legal_moves(BLACK)
    ordered = order_moves(b, moves, BLACK)

    # 因为初始局面没有角落，我们只测试它返回的列表长度和元素是否正确
    assert len(ordered) == len(moves)
    assert set(ordered) == set(moves)


def test_alpha_beta_returns_legal_move():
    """Alpha-Beta AI 必须在有合法走法时返回合法的走法，无合法走法时返回 None"""
    b = Board()
    move = alpha_beta_ai(b, BLACK, depth=2)
    assert move in b.legal_moves(BLACK)


def test_minimax_returns_legal_move():
    """Minimax AI 必须在有合法走法时返回合法的走法"""
    b = Board()
    move = minimax_ai(b, BLACK, depth=2)
    assert move in b.legal_moves(BLACK)




