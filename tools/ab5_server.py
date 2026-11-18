"""AB5 引擎服务：给跨语言对局脚本用。

Node 侧（当前浏览器 AI）通过 stdin/stdout 逐行走 JSON：
    -> {"board": [64 个 -1/0/1], "player": 1, "depth": 5}
    <- {"move": 37}

直接复用 src.agents.ai.alpha_beta_ai，保证对手和原来 200 局评估里是同一套
评估函数、走法排序与剪枝，不存在“JS 移植版是不是同一个 AB5”的问题。

alpha_beta_ai 会往 stdout 打印节点数，必须重定向到 stderr，否则会污染协议。
"""
import contextlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.agents.ai import alpha_beta_ai  # noqa: E402
from src.game_engine.board import Board  # noqa: E402


def make_board(cells):
    board = Board()
    for r in range(8):
        for c in range(8):
            board.board[r][c] = int(cells[r * 8 + c])
    return board


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        if msg.get("quit"):
            break

        board = make_board(msg["board"])
        board.current_player = int(msg["player"])
        board.game_over = False

        with contextlib.redirect_stdout(sys.stderr):
            move = alpha_beta_ai(board, board.current_player, depth=int(msg.get("depth", 5)))

        if move is None:
            sys.stdout.write(json.dumps({"pass": True}) + "\n")
        else:
            sys.stdout.write(json.dumps({"move": move[0] * 8 + move[1]}) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
