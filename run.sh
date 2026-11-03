#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# 唯一允许写死的一行：这台机器的解释器
# 以后迁到 Linux，改成 PY="python3"
PY="D:/anaconda3/envs/torch_env/python.exe"

case "${1:-}" in
  web)      "$PY" -m uvicorn src.web.server:app --host 127.0.0.1 --port 8000 ;;
  selfplay) "$PY" -m src.alphazero.self_play ;;
  train)    "$PY" -m src.alphazero.evolution ;;
  test)     "$PY" -m pytest tests/ -v ;;
  *)        echo "usage: ./run.sh {web|selfplay|train|test}"; exit 1 ;;
esac
