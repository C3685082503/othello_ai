"""8 对称增强的正确性测试。

核心要求只有一条：状态怎么转，策略的 64 个索引就必须怎么转。
这里用 one-hot 棋盘和 one-hot 策略逐点验证，覆盖全部 8 种变换。
"""
import pytest

torch = pytest.importorskip("torch")

from src.alphazero.symmetry import (  # noqa: E402
    SYMMETRY_PERMS,
    apply_policy_symmetry,
    apply_state_symmetry,
)


def test_permutations_are_bijections():
    assert tuple(SYMMETRY_PERMS.shape) == (8, 64)
    for t in range(8):
        assert sorted(SYMMETRY_PERMS[t].tolist()) == list(range(64))


def test_all_transforms_are_distinct():
    seen = {tuple(SYMMETRY_PERMS[t].tolist()) for t in range(8)}
    assert len(seen) == 8


def test_identity_is_noop():
    state = torch.rand(2, 3, 8, 8)
    pi = torch.rand(2, 64)
    assert torch.equal(apply_state_symmetry(state, 0), state)
    assert torch.equal(apply_policy_symmetry(pi, 0), pi)


def test_state_and_policy_follow_same_mapping():
    for t in range(8):
        for old in (0, 7, 9, 27, 36, 63):
            r, c = divmod(old, 8)

            state = torch.zeros(1, 3, 8, 8)
            state[0, 0, r, c] = 1.0
            pi = torch.zeros(1, 64)
            pi[0, old] = 1.0

            moved_state = apply_state_symmetry(state, t)
            moved_pi = apply_policy_symmetry(pi, t)

            new = int(moved_pi.argmax())
            nr, nc = divmod(new, 8)
            assert moved_state[0, 0, nr, nc].item() == 1.0, f"t={t} old={old} 状态没跟着转"
            if old != new:
                assert moved_state[0, 0, r, c].item() == 0.0, f"t={t} old={old} 旧位置没清空"


def test_policy_sum_preserved():
    pi = torch.rand(4, 64)
    for t in range(8):
        moved = apply_policy_symmetry(pi, t)
        assert torch.allclose(moved.sum(dim=1), pi.sum(dim=1), atol=1e-6)
