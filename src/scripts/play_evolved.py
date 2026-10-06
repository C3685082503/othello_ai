import sys
import os
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))

import random
import os
from src.game_engine.board import Board, BLACK
from src.agents.ai import alpha_beta_ai
#from src.agents.mcts_ai import mcts_ai
from src.alphazero import mcts
import torch
from src.alphazero.network import AlphaZeroNet
from src.alphazero.mcts import MCTS

# 替换加载的模型为进化后的模型
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
MODEL_PATH = 'models/alphazero_net_new.pth'
if not os.path.exists(MODEL_PATH):
    MODEL_PATH = 'models/baseline/alphazero_net_baseline.pth'
    print(f"models/alphazero_net_new.pth not found, falling back to {MODEL_PATH}")

evolved_network = AlphaZeroNet().to(device)
evolved_network.load_state_dict(torch.load(MODEL_PATH, map_location=device))
evolved_network.eval()
mcts.network = evolved_network


def play_game(black_ai, white_ai):
    board = Board()
    steps = 0
    while not board.is_terminal() and steps < 200:
        player = board.current_player
        ai = black_ai if player == BLACK else white_ai
        move = ai(board, player)
        if move is None:
            board.current_player = -player
            steps += 1
            continue
        board.step(*move)
        steps += 1
    return board.winner()


if __name__ == "__main__":
    random.seed(42)
    print(">>> 测试：进化后的 MCTS+NN vs Alpha-Beta 深度5", flush=True)

    wins, losses, draws = 0, 0, 0
    n_games = 1  # 先只跑1局！

    mcts_engine = MCTS(c_puct=1.5, num_simulations=200)  # 先降到50次模拟


    def mcts_wrapper(board, player):
        move, _ = mcts_engine.search_with_pi(board, player, temperature=0)
        return move


    for i in range(n_games):
        try:
            if i % 2 == 0:
                winner = play_game(mcts_wrapper, lambda b, p: alpha_beta_ai(b, p, depth=5))
                mcts_score = winner
            else:
                winner = play_game(lambda b, p: alpha_beta_ai(b, p, depth=5), mcts_wrapper)
                mcts_score = -winner if winner != 0 else 0

            # === 这里补全了统计逻辑 ===
            if mcts_score > 0:
                wins += 1
            elif mcts_score < 0:
                losses += 1
            else:
                draws += 1

            # 强制刷新打印缓冲区
            print(f"第 {i + 1} 局：{'进化MCTS胜' if mcts_score > 0 else 'Alpha-Beta胜' if mcts_score < 0 else '平局'}",
                  flush=True)

        except Exception as e:
            import traceback

            print(f"\n!!! 程序在第 {i + 1} 局崩溃了 !!!")
            traceback.print_exc()  # 打印详细报错
            break  # 结束循环

    # === 这里补全了最终的总结打印 ===
    print("=" * 30)
    print(f"进化MCTS 胜: {wins}, Alpha-Beta 胜: {losses}, 平局: {draws}")
    if n_games > 0:
        print(f"进化MCTS 胜率: {wins / n_games:.2%}")