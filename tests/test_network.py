"""AlphaZeroNet 的前向传播测试。

只验证形状与取值域，不验证棋力——那是训练和自对弈的事。
依赖 torch，用 importorskip 以便在无 torch 环境跳过。
"""
import pytest

torch = pytest.importorskip("torch")

from src.alphazero.network import AlphaZeroNet


def test_output_shapes():
    net = AlphaZeroNet()
    policy, value = net(torch.zeros(2, 3, 8, 8))
    assert policy.shape == (2, 64)
    assert value.shape == (2, 1)


def test_policy_is_log_softmax():
    """策略头输出 log 概率，取 exp 后总和必须为 1。"""
    net = AlphaZeroNet()
    policy, _ = net(torch.zeros(1, 3, 8, 8))
    assert torch.allclose(policy.exp().sum(dim=1), torch.ones(1), atol=1e-5)


def test_value_is_bounded():
    """价值头经过 tanh，必须落在 [-1, 1]。"""
    net = AlphaZeroNet()
    _, value = net(torch.randn(4, 3, 8, 8))
    assert value.min().item() >= -1.0
    assert value.max().item() <= 1.0


def test_accepts_encoder_output():
    """端到端：encoder 的输出应当能直接喂给网络。"""
    from src.game_engine.board import Board, BLACK
    from src.alphazero.encoder import board_to_tensor

    net = AlphaZeroNet()
    x = board_to_tensor(Board(), BLACK).unsqueeze(0)  # [1, 3, 8, 8]
    policy, value = net(x)
    assert policy.shape == (1, 64)
    assert value.shape == (1, 1)
