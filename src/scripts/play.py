import sys
import os
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))

import random
from src.game_engine.board import Board, BLACK
from src.agents.ai import greedy_ai, minimax_ai, alpha_beta_ai


def play_game(black_ai, white_ai, verbose=False):
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
        if verbose:
            print(board)
            print(f"Player {player} -> {move}\n")
    black, white = board.score()
    return board.winner(), black, white


def run_match(ai1, ai2, n_games=1000, label1="AI1", label2="AI2"):
    wins1, wins2, draws = 0, 0, 0
    total_diff = 0
    for i in range(n_games):
        if i % 2 == 0:
            winner, black, white = play_game(ai1, ai2)
            s1, s2 = black, white
        else:
            winner, black, white = play_game(ai2, ai1)
            s1, s2 = white, black
        total_diff += s1 - s2
        if s1 > s2:
            wins1 += 1
        elif s2 > s1:
            wins2 += 1
        else:
            draws += 1
        if (i + 1) % 10 == 0:
            print(f"已进行 {i + 1}/{n_games} 局，{label1} 胜率: {wins1 / (i + 1):.2%}")
    print("=" * 30)
    print(f"{label1} 胜: {wins1}, {label2} 胜: {wins2}, 平局: {draws}")
    print(f"{label1} 胜率: {wins1 / n_games:.2%}")
    print(f"平均棋子差: {total_diff / n_games:.2f}")


# 把 play.py 底部的 if __name__ == "__main__": 替换为：

if __name__ == "__main__":
    random.seed(42)

    print(">>> 测试：纯 Minimax 深度2 vs 贪心 (无排序)")


    def minimax_depth2(board, player):
        return minimax_ai(board, player, depth=2)


    run_match(minimax_depth2, greedy_ai, n_games=10, label1="Minimax2", label2="贪心")

    print("\n\n>>> 测试：Alpha-Beta 深度4 vs 贪心 (有排序)")


    def alpha_beta_depth4(board, player):
        return alpha_beta_ai(board, player, depth=4)


    # 这里可以跑100局，因为有了走法排序，剪枝效率会很高
    run_match(alpha_beta_depth4, greedy_ai, n_games=50, label1="AB4", label2="贪心")

    print("\n\n>>> 测试：Alpha-Beta 深度5 vs 贪心 (挑战更深)")


    def alpha_beta_depth5(board, player):
        return alpha_beta_ai(board, player, depth=5)


    run_match(alpha_beta_depth5, greedy_ai, n_games=50, label1="AB5", label2="贪心")




