import sys
import os
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))

import random
from src.game_engine.board import Board, BLACK, WHITE
from src.agents.ai import alpha_beta_ai,greedy_ai
from src.agents.mcts_ai import mcts_ai


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

    return board.winner()


def eval_mcts_vs_opponent(opponent_ai, opponent_name="对手", n_games=10, simulations=50):
    """
    opponent_ai: 传入一个函数，比如 greedy_ai 或者 lambda b, p: alpha_beta_ai(b, p, depth=5)
    """
    wins, losses, draws = 0, 0, 0

    for i in range(n_games):
        if i % 2 == 0:
            winner = play_game(lambda b, p: mcts_ai(b, p, simulations), opponent_ai)
            mcts_score = winner
        else:
            winner = play_game(opponent_ai, lambda b, p: mcts_ai(b, p, simulations))
            mcts_score = -winner if winner != 0 else 0

        if mcts_score > 0:
            wins += 1
        elif mcts_score < 0:
            losses += 1
        else:
            draws += 1

        print(f"第 {i + 1} 局：{'MCTS胜' if mcts_score > 0 else f'{opponent_name}胜' if mcts_score < 0 else '平局'}")

    print("=" * 30)
    print(f"MCTS+NN 胜: {wins}, {opponent_name} 胜: {losses}, 平局: {draws}")
    print(f"MCTS+NN 胜率: {wins / n_games:.2%}")


if __name__ == "__main__":
    random.seed(42)

    # 测试 1：打贪心
    '''print(">>> 测试：MCTS+NN vs 贪心AI")
    eval_mcts_vs_opponent(
        opponent_ai=lambda b, p: greedy_ai(b, p),
        opponent_name="贪心",
        n_games=10,
        simulations=50
    )'''

    # 测试 2：打 Alpha-Beta 深度5 (想测试的时候把下面注释打开)
    print("\n\n>>> 测试：MCTS+NN vs Alpha-Beta 深度5")
    eval_mcts_vs_opponent(
         opponent_ai=lambda b, p: alpha_beta_ai(b, p, depth=5),
         opponent_name="AB5",
         n_games=5,
         simulations=50
    )
