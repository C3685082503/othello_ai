"""8 对称（dihedral）数据增强。

黑白棋棋盘在 8 种变换下规则等价：
    4 个旋转（0/90/180/270）× 是否水平镜像。

状态是 [3, 8, 8]，策略是长度 64 的访问分布。对状态做变换时，策略的 64 个
索引必须用同一套坐标映射，否则网络会学到“棋盘转了、走法没转”的错误对应。

这里提供三个东西：
    SYMMETRY_PERMS      形状 [8, 64]，PERMS[t][new_index] = old_index
    apply_state_symmetry(states, t)
    apply_policy_symmetry(pis, t)
"""
import torch


def _transform_coord(r: int, c: int, t: int):
    """旧坐标 (r, c) 在变换 t 下变成哪个新坐标。

    注意 torch.rot90 是逆时针：old (r, c) -> new (7-c, r)。
    """
    if t >= 4:          # 先水平镜像
        c = 7 - c
    for _ in range(t % 4):  # 再逆时针旋转 t%4 次
        r, c = 7 - c, r
    return r, c


def _build_permutations() -> torch.Tensor:
    perms = []
    for t in range(8):
        perm = [0] * 64
        for old in range(64):
            r, c = divmod(old, 8)
            nr, nc = _transform_coord(r, c, t)
            perm[nr * 8 + nc] = old
        perms.append(perm)
    return torch.tensor(perms, dtype=torch.long)


SYMMETRY_PERMS = _build_permutations()


def apply_state_symmetry(states: torch.Tensor, t: int) -> torch.Tensor:
    """states: [..., 8, 8]；返回同样形状的新张量。"""
    if t >= 4:
        states = torch.flip(states, dims=[-1])
    k = t % 4
    if k:
        states = torch.rot90(states, k, dims=[-2, -1])
    return states


def apply_policy_symmetry(pis: torch.Tensor, t: int) -> torch.Tensor:
    """pis: [..., 64]；按同一套坐标映射重排策略。"""
    perm = SYMMETRY_PERMS[t].to(pis.device)
    return pis[..., perm]
