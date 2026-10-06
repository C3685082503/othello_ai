import sys
import os
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))

import random
from src.game_engine.board import Board, BLACK, WHITE
from src.agents.ai import greedy_ai
from src.agents.nn_ai import nn_ai

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

def eval_nn_vs_greedy(n_games=50):
    wins, losses, draws = 0, 0, 0
    for i in range(n_games):
        if i % 2 == 0:
            winner = play_game(nn_ai, greedy_ai)
            nn_score = winner
        else:
            winner = play_game(greedy_ai, nn_ai)
            nn_score = -winner if winner != 0 else 0
        if nn_score > 0: wins += 1
        elif nn_score < 0: losses += 1
        else: draws += 1
        if (i + 1) % 10 == 0:
            print(f"已进行 {i+1}/{n_games} 局，NN 胜率: {wins/(i+1):.2%}")
    print(f"NN 胜: {wins}, 贪心胜: {losses}, 平局: {draws}")
    print(f"NN 胜率: {wins / n_games:.2%}")

if __name__ == "__main__":
    random.seed(42)
    eval_nn_vs_greedy(n_games=50)
