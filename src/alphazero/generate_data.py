import torch
import random
from src.game_engine.board import Board, BLACK, WHITE
from src.agents.ai import alpha_beta_ai
from src.alphazero.encoder import board_to_tensor, move_to_index, index_to_move


def generate_dataset(num_games=1000, depth=3):
    states = []
    policies = []
    values = []

    print(f"开始生成 {num_games} 局数据（含数据增强与随机性）...")
    for i in range(num_games):
        board = Board()
        game_data = []

        while not board.is_terminal():
            player = board.current_player
            moves = board.legal_moves(player)
            if not moves:
                board.current_player = -player
                continue

            # 10% 概率随机选择，90% 概率选 Alpha-Beta 最佳，增加数据多样性
            if random.random() < 0.1:
                best_move = random.choice(moves)
            else:
                best_move = alpha_beta_ai(board, player, depth=depth)

            state_tensor = board_to_tensor(board, player)
            move_idx = move_to_index(best_move)
            game_data.append((state_tensor, move_idx, player))
            board.step(*best_move)

        winner = board.winner()

        # 数据处理与增强
        for state_tensor, move_idx, player in game_data:
            if winner == player:
                value = 1.0
            elif winner == -player:
                value = -1.0
            else:
                value = 0.0

            # 原数据
            states.append(state_tensor)
            policies.append(move_idx)
            values.append(value)

            # 数据增强：旋转 90, 180, 270 度
            for k in range(1, 4):
                rotated_state = torch.rot90(state_tensor, k, dims=[1, 2])
                r, c = index_to_move(move_idx)
                r_new, c_new = c, 7 - r
                for _ in range(k - 1):
                    r_new, c_new = c_new, 7 - r_new
                rotated_move = r_new * 8 + c_new
                states.append(rotated_state)
                policies.append(rotated_move)
                values.append(value)

            # 数据增强：左右镜像
            mirrored_state = torch.flip(state_tensor, dims=[2])
            r, c = index_to_move(move_idx)
            mirrored_move = r * 8 + (7 - c)
            states.append(mirrored_state)
            policies.append(mirrored_move)
            values.append(value)

        if (i + 1) % 100 == 0:
            print(f"已完成 {i + 1}/{num_games} 局，共收集 {len(states)} 条数据")

    torch.save({
        'states': torch.stack(states),
        'policies': torch.tensor(policies, dtype=torch.long),
        'values': torch.tensor(values, dtype=torch.float32)
    }, 'data/train_data.pt')
    print(f"数据已保存到 data/train_data.pt，共 {len(states)} 条")


if __name__ == "__main__":
    generate_dataset(num_games=1000, depth=3)
