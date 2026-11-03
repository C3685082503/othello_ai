#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# 唯一允许写死的一行：这台机器的解释器
# 以后迁到 Linux，改成 PY="python3"
PY="D:/anaconda3/envs/torch_env/python.exe"

usage() {
  cat <<'USAGE'
用法: ./run.sh <命令>

  test          跑单元测试
  web           启动网页版（http://127.0.0.1:8000）
  selfplay      自我对弈，生成训练数据
  train         进化训练 + 评估门控
  inspect       检查 data/train_data.pt 的数据形状
  play          Minimax 等传统 AI 互相对战
  play-mcts     MCTS + 神经网络 vs 贪心
  play-nn       纯神经网络 vs 贪心
  play-evolved  进化后的 MCTS+NN vs Alpha-Beta
USAGE
}

case "${1:-}" in
  test)         "$PY" -m pytest -v ;;
  web)          "$PY" -m uvicorn src.web.server:app --host 127.0.0.1 --port 8000 ;;
  selfplay)     "$PY" -m src.alphazero.self_play ;;
  train)        "$PY" -m src.alphazero.evolution ;;
  inspect)      "$PY" -m src.scripts.inspect_data ;;
  play)         "$PY" -m src.scripts.play ;;
  play-mcts)    "$PY" -m src.scripts.play_mcts ;;
  play-nn)      "$PY" -m src.scripts.play_nn ;;
  play-evolved) "$PY" -m src.scripts.play_evolved ;;
  ""|-h|--help) usage ;;
  *)            echo "未知命令: $1"; echo; usage; exit 1 ;;
esac
