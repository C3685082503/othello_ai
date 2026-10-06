import math
import torch
import numpy as np
import random

from src.alphazero.encoder import board_to_tensor, move_to_index
from src.alphazero.network import AlphaZeroNet

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
network = AlphaZeroNet().to(device)
try:
    network.load_state_dict(torch.load('models/alphazero_net.pth', map_location=device))
    print(">>> MCTS 加载当前最佳模型 models/alphazero_net.pth 成功")
except Exception:
    print(">>> 未找到最佳模型，回退加载 baseline 模型")
    network.load_state_dict(torch.load('models/baseline/alphazero_net_baseline.pth', map_location=device))
network.eval()


class Node:
    def __init__(self, board, player, parent=None, prior_p=1.0):
        self.board = board
        self.player = player
        self.parent = parent
        self.children = {}
        self.N = 0
        self.W = 0.0
        self.Q = 0.0
        self.P = prior_p

    def is_expanded(self):
        return len(self.children) > 0

    def select(self, c_puct):
        best_score = -float('inf')
        best_move = None
        best_child = None
        for move, child in self.children.items():
            q_value = -child.Q
            u_value = c_puct * child.P * math.sqrt(self.N) / (1 + child.N)
            score = q_value + u_value
            if score > best_score:
                best_score = score
                best_move = move
                best_child = child
        return best_move, best_child

    def expand(self, legal_moves, add_noise=False):
        if not legal_moves:
            return
        state_tensor = board_to_tensor(self.board, self.player).unsqueeze(0).to(device)
        with torch.no_grad():
            policy_logits, _ = network(state_tensor)
            policy = policy_logits.exp().squeeze().cpu().numpy()

        probs = []
        for move in legal_moves:
            idx = move_to_index(move)
            probs.append(policy[idx])
        if sum(probs) == 0:
            probs = [1.0 / len(legal_moves)] * len(legal_moves)
        else:
            total = sum(probs)
            probs = [p / total for p in probs]

        # ================= 新增 Dirichlet 噪声逻辑 =================
        if add_noise:
            # dirichlet_alpha 越小，噪声越极端（越倾向于随机选择几个走法）
            # epsilon 是噪声权重，通常设为 0.25
            dirichlet_alpha = 0.3
            epsilon = 0.25
            noise = np.random.dirichlet([dirichlet_alpha] * len(legal_moves))
            probs = [(1 - epsilon) * p + epsilon * n for p, n in zip(probs, noise)]
        # ===========================================================

        for move, prob in zip(legal_moves, probs):
            new_board = self.board.clone()
            new_board.step(*move)
            child = Node(new_board, -self.player, parent=self, prior_p=prob)
            self.children[move] = child

    def update(self, value):
        self.N += 1
        self.W += value
        self.Q = self.W / self.N


class MCTS:
    def __init__(self, c_puct=1.0, num_simulations=50):
        self.c_puct = c_puct
        self.num_simulations = num_simulations

    def search(self, board, player):
        root = Node(board.clone(), player)
        legal_moves = board.legal_moves(player)
        if not legal_moves:
            return None
        root.expand(legal_moves)

        for _ in range(self.num_simulations):
            node = root
            search_path = [node]

            while node.is_expanded() and not node.board.is_terminal():
                move, node = node.select(self.c_puct)
                search_path.append(node)

            if node.board.is_terminal():
                winner = node.board.winner()
                if winner == 0:
                    value = 0.0
                else:
                    value = 1.0 if winner == node.player else -1.0
            else:
                leaf_moves = node.board.legal_moves(node.player)
                if leaf_moves:
                    node.expand(leaf_moves)

                state_tensor = board_to_tensor(node.board, node.player).unsqueeze(0).to(device)
                with torch.no_grad():
                    _, value_tensor = network(state_tensor)
                    value = value_tensor.item()

            for n in reversed(search_path):
                n.update(value)
                value = -value

        best_move = max(root.children.items(), key=lambda x: x[1].N)[0]
        return best_move

    def search_with_pi(self, board, player, temperature=1.0):
        """
        返回：最佳走法, 概率分布pi (长度为64的numpy数组)
        """
        root = Node(board.clone(), player)
        legal_moves = board.legal_moves(player)
        if not legal_moves:
            return None, np.zeros(64)

        root.expand(legal_moves,add_noise=True)

        # === 动态残局算力 ===
        original_sims = self.num_simulations
        empty_count = sum(row.count(0) for row in board.board)
        if empty_count < 12:
            self.num_simulations = 800  # 残局直接暴走，拉高到800次
            #print(f"!!! 残局特训（剩余{empty_count}格），模拟次数临时提升至 800 !!!", flush=True)
        # ====================
        for _ in range(self.num_simulations):
            node = root
            search_path = [node]

            while node.is_expanded() and not node.board.is_terminal():
                move, node = node.select(self.c_puct)
                search_path.append(node)

            if node.board.is_terminal():
                winner = node.board.winner()
                if winner == 0:
                    value = 0.0
                else:
                    value = 1.0 if winner == node.player else -1.0
            else:
                leaf_moves = node.board.legal_moves(node.player)
                if leaf_moves:
                    node.expand(leaf_moves)

                state_tensor = board_to_tensor(node.board, node.player).unsqueeze(0).to(device)
                with torch.no_grad():
                    _, value_tensor = network(state_tensor)
                    value = value_tensor.item()

            for n in reversed(search_path):
                n.update(value)
                value = -value

            # === 恢复原有模拟次数，避免影响下一步 ===
            self.num_simulations = original_sims
            # ========================================
        # 计算概率分布 pi
        pi = np.zeros(64)
        for move, child in root.children.items():
            idx = move_to_index(move)
            pi[idx] = child.N

        # 根据温度参数平滑概率
        if temperature == 0:
            best_move = max(root.children.items(), key=lambda x: x[1].N)[0]
            pi = np.zeros(64)
            pi[move_to_index(best_move)] = 1.0
            return best_move, pi
        else:
            pi = pi ** (1 / temperature)
            if pi.sum() > 0:
                pi = pi / pi.sum()
            else:
                pi = np.ones(64) / 64

            root_moves = list(root.children.keys())
            legal_indices = [move_to_index(m) for m in root_moves]
            probs = [pi[idx] for idx in legal_indices]
            total_prob = sum(probs)
            if total_prob > 0:
                probs = [p / total_prob for p in probs]
                best_move = random.choices(root_moves, weights=probs, k=1)[0]
            else:
                best_move = random.choice(root_moves)

            return best_move, pi
