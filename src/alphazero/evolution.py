import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import TensorDataset, DataLoader
from src.alphazero.network import AlphaZeroNet
from src.game_engine.board import Board, BLACK, WHITE
from src.alphazero.mcts import MCTS
import random
import os

BASELINE_MODEL = 'models/baseline/alphazero_net_baseline.pth'
BEST_MODEL = 'models/alphazero_net.pth'
NEW_MODEL = 'models/alphazero_net_new.pth'
SELF_PLAY_DATA = 'data/self_play_data.pt'


def current_best_model_path():
    if os.path.exists(BEST_MODEL):
        return BEST_MODEL
    return BASELINE_MODEL



def train_network(epochs=5):
    data = torch.load(SELF_PLAY_DATA)
    dataset = TensorDataset(data['states'], data['pis'], data['values'])
    dataloader = DataLoader(dataset, batch_size=64, shuffle=True)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = AlphaZeroNet().to(device)

    if os.path.exists('models/alphazero_net.pth'):
        try:
            model.load_state_dict(torch.load('models/alphazero_net.pth', map_location=device))
            print(">>> 成功加载现有模型，继续训练")
        except RuntimeError as e:
            print(f">>> 模型结构不匹配（可能网络已扩容），从头开始训练！错误信息: {e}")
    else:
        print(">>> 未找到现有模型 models/alphazero_net.pth，从头开始训练！")

    optimizer = optim.Adam(model.parameters(), lr=0.0001)

    for epoch in range(epochs):
        model.train()
        total_loss = 0
        for batch_states, batch_pis, batch_values in dataloader:
            batch_states = batch_states.to(device)
            batch_pis = batch_pis.to(device)
            batch_values = batch_values.to(device)

            pred_policy, pred_value = model(batch_states)

            policy_loss = -torch.sum(batch_pis * pred_policy, dim=1).mean()
            value_loss = nn.functional.mse_loss(pred_value.squeeze(-1), batch_values)
            loss = policy_loss + value_loss

            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            total_loss += loss.item()

        print(f"Epoch {epoch + 1:02d}/{epochs} | Loss: {total_loss / len(dataloader):.4f}")

    torch.save(model.state_dict(), NEW_MODEL)
    print(">>> 新模型已保存到 models/alphazero_net_new.pth")


def evaluate_new_model(n_games=10, num_simulations=20):
    from src.alphazero import mcts
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    old_model = AlphaZeroNet().to(device)
    old_model.load_state_dict(torch.load(current_best_model_path(), map_location=device))
    old_model.eval()

    new_model = AlphaZeroNet().to(device)
    new_model.load_state_dict(torch.load(NEW_MODEL, map_location=device))
    new_model.eval()

    mcts_engine = MCTS(c_puct=1.0, num_simulations=num_simulations)

    new_wins, old_wins, draws = 0, 0, 0

    print("\n>>> 开始评估新模型 vs 旧模型...")
    for i in range(n_games):
        new_is_black = (i % 2 == 0)
        board = Board()

        while not board.is_terminal():
            player = board.current_player
            legal_moves = board.legal_moves(player)

            # 【修复】评估循环同样需要处理跳过
            if not legal_moves:
                board.current_player = -player
                continue

            if (player == BLACK and new_is_black) or (player == WHITE and not new_is_black):
                mcts.network = new_model
            else:
                mcts.network = old_model

            move, _ = mcts_engine.search_with_pi(board, player, temperature=0.1)
            if move is None:
                board.current_player = -player
                continue

            # 【修复】强制同步
            if board.current_player != player:
                board.current_player = player

            board.step(*move)

        winner = board.winner()
        if winner == 0:
            draws += 1
        elif (winner == BLACK and new_is_black) or (winner == WHITE and not new_is_black):
            new_wins += 1
        else:
            old_wins += 1

        print(f"第 {i + 1}/{n_games} 局完成...")

    print("=" * 30)
    print(f"新模型胜: {new_wins}, 旧模型胜: {old_wins}, 平局: {draws}")
    win_rate = new_wins / n_games
    print(f"新模型胜率: {win_rate:.2%}")

    if win_rate > 0.55:
        torch.save(new_model.state_dict(), BEST_MODEL)
        print(">>> 胜率超过 55%，新模型已保存为当前最佳模型 models/alphazero_net.pth！")
    else:
        print(">>> 胜率未超过 55%，保持旧模型不变。")


if __name__ == "__main__":
    print(">>> 开始训练新网络...")
    train_network(epochs=30)
    evaluate_new_model(n_games=30, num_simulations=100)
