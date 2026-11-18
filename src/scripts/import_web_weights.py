"""从浏览器权重（weights.bin + weights.json）还原 PyTorch state_dict。

用途：门控会把 models/alphazero_net.pth 覆盖成新模型，而浏览器用的
web/weights.bin 往往还是旧模型。这个脚本可以把那份旧权重还原成 .pth，
用于回滚或 A/B 对比。

用法：
    python -m src.scripts.import_web_weights \
        --bin web/weights.bin --meta web/weights.json \
        --out models/alphazero_net_prev.pth
"""
import argparse
import json
from pathlib import Path

import numpy as np
import torch

from src.alphazero.network import AlphaZeroNet


def main():
    parser = argparse.ArgumentParser(description="从 web 权重还原 .pth")
    parser.add_argument("--bin", default="web/weights.bin")
    parser.add_argument("--meta", default="web/weights.json")
    parser.add_argument("--out", default="models/alphazero_net_prev.pth")
    args = parser.parse_args()

    meta = json.loads(Path(args.meta).read_text(encoding="utf-8"))
    flat = np.fromfile(args.bin, dtype="<f4")
    if flat.size != meta["count"]:
        raise SystemExit(f"权重长度不符：{flat.size} != {meta['count']}")

    state = {}
    for p in meta["params"]:
        chunk = flat[p["offset"]: p["offset"] + p["size"]].reshape(p["shape"])
        state[p["name"]] = torch.from_numpy(chunk.copy())

    model = AlphaZeroNet()
    model.load_state_dict(state)
    torch.save(state, args.out)
    print(f"已还原 {len(state)} 个张量 -> {args.out}")
    print(f"sha256: {meta['sha256']}")


if __name__ == "__main__":
    main()
