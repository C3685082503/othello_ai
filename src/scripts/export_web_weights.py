"""把 PyTorch 权重导出成浏览器可以直接读的二进制格式。

为什么不用 ONNX：这个网络只有 113 万参数（4.5 MB），推理就是两层 3x3 卷积
加三层全连接。导 ONNX 要么在浏览器里带 10 MB 的 onnxruntime wasm，要么依赖
CDN——对「单文件离线、微信直接发」的目标来说都是负担。所以这里把权重按固定
顺序拼成一个 little-endian float32 文件，前端用几十行 JS 手写前向，零依赖。

同时生成一组参考输出（tests/js/reference.json），供 JS 侧做逐值对齐：
JS 的 policy/value 必须和 PyTorch 在这个文件里的结果一致。

用法（项目根目录）：

    python -m src.scripts.export_web_weights

产物：
    web/weights.bin          权重主体（float32, 小端）
    web/weights.json         各层 offset/shape + sha256，前端据此切视图
    tests/js/reference.json  参考棋盘与 PyTorch 的 policy/value
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
from pathlib import Path

import numpy as np
import torch

from src.alphazero.encoder import board_to_tensor
from src.alphazero.network import AlphaZeroNet
from src.game_engine.board import Board
from src.paths import BEST_MODEL, PROJECT_ROOT

WEB_DIR = PROJECT_ROOT / "web"
REFERENCE_PATH = PROJECT_ROOT / "tests" / "js" / "reference.json"

# 顺序必须和 web/net.js 里的读取顺序严格一致。
# 每个元素：(state_dict key, 期望形状)
PARAM_ORDER: list[tuple[str, tuple[int, ...]]] = [
    ("conv1.weight", (64, 3, 3, 3)),
    ("conv1.bias", (64,)),
    ("conv2.weight", (128, 64, 3, 3)),
    ("conv2.bias", (128,)),
    ("fc.weight", (128, 128 * 8 * 8)),
    ("fc.bias", (128,)),
    ("policy_head.weight", (64, 128)),
    ("policy_head.bias", (64,)),
    ("value_head.weight", (1, 128)),
    ("value_head.bias", (1,)),
]


def load_state_dict(model_path: Path) -> dict[str, torch.Tensor]:
    state = torch.load(model_path, map_location="cpu")
    # 兼容直接保存 nn.Module 的老文件
    if hasattr(state, "state_dict"):
        state = state.state_dict()
    return {k: v for k, v in state.items()}


def export_weights(state: dict[str, torch.Tensor]) -> tuple[bytes, dict]:
    chunks: list[np.ndarray] = []
    params: list[dict] = []
    offset = 0

    for key, shape in PARAM_ORDER:
        if key not in state:
            raise KeyError(f"权重文件里缺少 {key}；现有键：{sorted(state)}")
        tensor = state[key]
        if tuple(tensor.shape) != shape:
            raise ValueError(f"{key} 形状是 {tuple(tensor.shape)}，期望 {shape}")
        array = tensor.detach().to(torch.float32).cpu().contiguous().numpy().astype("<f4", copy=False)
        flat = array.reshape(-1)
        params.append(
            {
                "name": key,
                "shape": list(shape),
                "offset": offset,
                "size": int(flat.size),
            }
        )
        offset += int(flat.size)
        chunks.append(flat)

    blob = np.concatenate(chunks).astype("<f4", copy=False).tobytes()
    meta = {
        "version": 1,
        "endianness": "little",
        "dtype": "float32",
        "count": offset,
        "bytes": len(blob),
        "sha256": hashlib.sha256(blob).hexdigest(),
        "params": params,
    }
    return blob, meta


def build_reference_cases(model: AlphaZeroNet, plies: tuple[int, ...]) -> list[dict]:
    """随机走若干步，在指定 ply 上留档；再补一个终局局面。"""
    rng = random.Random(2024)
    board = Board()
    wanted = set(plies)
    cases: list[dict] = []

    def snapshot(tag: str, ply_no: int) -> None:
        player = board.current_player
        with torch.no_grad():
            log_probs, value = model(board_to_tensor(board, player).unsqueeze(0))
        probs = log_probs.exp().squeeze(0).numpy().astype(np.float64)
        total = float(probs.sum())
        if abs(total - 1.0) > 1e-4:
            raise AssertionError(f"policy 未归一化，和={total}")
        cases.append(
            {
                "tag": tag,
                "ply": ply_no,
                "player": int(player),
                "board": [int(v) for row in board.board for v in row],
                "policy": [round(float(v), 7) for v in probs],
                "value": round(float(value.item()), 7),
            }
        )

    ply = 0
    while not board.is_terminal() and ply <= max(plies):
        if ply in wanted:
            snapshot(f"ply-{ply}", ply)
        moves = board.legal_moves()
        if not moves:
            board.current_player = -board.current_player
            ply += 1
            continue
        board.step(*rng.choice(moves))
        ply += 1

    # 一直下到终局，留一个终局（合法步为空）的局面
    guard = 0
    while not board.is_terminal() and guard < 200:
        moves = board.legal_moves()
        if not moves:
            board.current_player = -board.current_player
            guard += 1
            continue
        board.step(*rng.choice(moves))
        guard += 1
    snapshot("terminal", guard)
    return cases


def main() -> None:
    parser = argparse.ArgumentParser(description="导出浏览器端权重与参考输出")
    parser.add_argument("--model", type=Path, default=BEST_MODEL)
    parser.add_argument("--out-dir", type=Path, default=WEB_DIR)
    parser.add_argument("--reference", type=Path, default=REFERENCE_PATH)
    args = parser.parse_args()

    if not args.model.exists():
        raise SystemExit(f"找不到模型：{args.model}")

    model = AlphaZeroNet()
    state = load_state_dict(args.model)
    model.load_state_dict(state)
    model.eval()

    blob, meta = export_weights(state)
    meta["source"] = args.model.name
    meta["model_bytes"] = args.model.stat().st_size

    args.out_dir.mkdir(parents=True, exist_ok=True)
    (args.out_dir / "weights.bin").write_bytes(blob)
    (args.out_dir / "weights.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    cases = build_reference_cases(model, plies=(0, 8, 24, 40))
    args.reference.parent.mkdir(parents=True, exist_ok=True)
    args.reference.write_text(
        json.dumps(
            {
                "meta": {
                    "sha256": meta["sha256"],
                    "model": args.model.name,
                    "note": "policy 为 64 维概率，value 为 tanh 输出；JS 侧需逐值对齐",
                },
                "cases": cases,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    print(f"权重  : {args.out_dir / 'weights.bin'}  ({len(blob) / 1024 / 1024:.2f} MB)")
    print(f"参数  : {meta['count']:,}")
    print(f"sha256: {meta['sha256']}")
    print(f"参考样本: {args.reference}  ({len(cases)} 个局面)")
    for p in meta["params"]:
        print(f"  {p['name']:<20} offset={p['offset']:>8}  size={p['size']:>8}")


if __name__ == "__main__":
    main()
