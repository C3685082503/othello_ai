import torch
import numpy as np
import random
import os  # === 新增 ===
from src.game_engine.board import Board, BLACK, WHITE
from src.alphazero.encoder import board_to_tensor, move_to_index
from src.alphazero.mcts import MCTS


def self_play(num_games=500, num_simulations=200, temperature=1.0):
    """
    让 MCTS+NN 自己和自己下棋，生成训练数据。
    """
    mcts = MCTS(c_puct=1.0, num_simulations=num_simulations)
    all_states = []
    all_pis = []
    all_values = []

    # === 新增：断点续跑逻辑 ===
    checkpoint_path = 'data/self_play_checkpoint.pt'
    start_game = 0
    if os.path.exists(checkpoint_path):
        print(f">>> 发现断点存档，正在加载...", flush=True)
        checkpoint = torch.load(checkpoint_path, map_location='cpu')
        all_states = checkpoint['all_states']
        all_pis = checkpoint['all_pis']
        all_values = checkpoint['all_values']
        start_game = checkpoint['current_game']
        print(f">>> 从第 {start_game + 1} 局继续，已加载 {len(all_states)} 条数据", flush=True)
    # ========================

    print(f"开始自我对弈 {num_games} 局...", flush=True)
    for i in range(start_game, num_games):  # === 修改：从 start_game 开始 ===
        board = Board()
        game_history = []  # 记录每一局的数据 (state, pi, player)

        while not board.is_terminal():
            player = board.current_player
            legal_moves = board.legal_moves(player)
            if not legal_moves:
                board.current_player = -player
                continue

            # 前10步用 temperature=1.0 疯狂试错，10~20步用 0.5，20步之后降到 0.1
            step_num = len(game_history)
            if step_num < 10:
                temp = 1.0
            elif step_num < 20:
                temp = 0.5
            else:
                temp = 0.1
            move, pi = mcts.search_with_pi(board, player, temperature=temp)

            if move is None:
                board.current_player = -player
                continue

            state_tensor = board_to_tensor(board, player)
            game_history.append((state_tensor, pi, player))

            board.step(*move)

        # 对局结束，分配胜负标签
        winner = board.winner()
        for state_tensor, pi, player in game_history:
            if winner == 0:
                value = 0.0
            else:
                # 从当前步的 player 视角看胜负
                value = 1.0 if winner == player else -1.0

            all_states.append(state_tensor)
            all_pis.append(pi)
            all_values.append(value)

        # 原本的每 10 局打印
        if (i + 1) % 10 == 0:
            print(f"已完成 {i + 1}/{num_games} 局，共收集 {len(all_states)} 条数据", flush=True)

            # === 新增：每 100 局自动保存一次断点，防止崩溃丢数据 ===
            if (i + 1) % 100 == 0:
                torch.save({
                    'all_states': all_states,
                    'all_pis': all_pis,
                    'all_values': all_values,
                    'current_game': i + 1
                }, checkpoint_path)
                print(f"!!! 断点已保存：第 {i + 1}/{num_games} 局 !!!", flush=True)
            # =====================================================

    # 保存最终数据
    torch.save({
        'states': torch.stack(all_states),
        'pis': torch.tensor(np.array(all_pis), dtype=torch.float32),
        'values': torch.tensor(all_values, dtype=torch.float32)
    }, 'data/self_play_data.pt')

    # === 新增：全部跑完后，删除断点文件，避免下次误读 ===
    if os.path.exists(checkpoint_path):
        os.remove(checkpoint_path)
    # =====================================================

    print(f"数据已保存到 data/self_play_data.pt，共 {len(all_states)} 条")


if __name__ == "__main__":
    random.seed(42)
    # 先跑 5 局测试一下流程，跑通后再改成 50 或 100
    self_play(num_games=1000, num_simulations=200)