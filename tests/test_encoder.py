"""encoder 的测试。

依赖 torch，因此用 importorskip：没有 torch 的环境里这些测试会优雅跳过，
而不是让整个测试套件失败。
"""
import pytest

torch = pytest.importorskip("torch")

from src.game_engine.board import Board, BLACK, WHITE
from src.alphazero.encoder import board_to_tensor, move_to_index, index_to_move


def test_tensor_shape_and_dtype():
    t = board_to_tensor(Board(), BLACK)
    assert t.shape == (3, 8, 8)
    assert t.dtype == torch.float32


def test_initial_position_counts():
    """开局四子：双方各两枚，且全部落在中心 2x2。"""
    t = board_to_tensor(Board(), BLACK)
    assert t[0].sum().item() == 2.0
    assert t[1].sum().item() == 2.0


def test_channels_swap_with_player():
    """同一局面的黑白两个视角，通道 0 与通道 1 应当互换。"""
    board = Board()
    black_view = board_to_tensor(board, BLACK)
    white_view = board_to_tensor(board, WHITE)
    assert torch.equal(black_view[0], white_view[1])
    assert torch.equal(black_view[1], white_view[0])


def test_player_flag_channel():
    """通道 2 是纯标记：黑棋视角全 1，白棋视角全 0。"""
    board = Board()
    assert torch.all(board_to_tensor(board, BLACK)[2] == 1.0)
    assert torch.all(board_to_tensor(board, WHITE)[2] == 0.0)


def test_channels_are_mutually_exclusive():
    """同一个格子不可能既是当前玩家又是对手。"""
    t = board_to_tensor(Board(), BLACK)
    assert not ((t[0] == 1.0) & (t[1] == 1.0)).any()


def test_move_index_roundtrip():
    for r in range(8):
        for c in range(8):
            assert index_to_move(move_to_index((r, c))) == (r, c)


def test_move_index_corners():
    assert move_to_index((0, 0)) == 0
    assert move_to_index((0, 7)) == 7
    assert move_to_index((7, 0)) == 56
    assert move_to_index((7, 7)) == 63
