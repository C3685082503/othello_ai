import torch
from src.game_engine.board import BLACK, WHITE
from src.alphazero.encoder import board_to_tensor
from src.alphazero.network import AlphaZeroNet

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
model = AlphaZeroNet().to(device)
model.load_state_dict(torch.load('models/baseline/alphazero_net_baseline.pth', map_location=device))
model.eval()

def nn_ai(board, player):
    state_tensor = board_to_tensor(board, player).unsqueeze(0).to(device)
    with torch.no_grad():
        policy, _ = model(state_tensor)
        policy = policy.exp().squeeze()

    legal_moves = board.legal_moves(player)
    if not legal_moves: return None

    best_move, best_prob = None, -1.0
    for r, c in legal_moves:
        idx = r * 8 + c
        prob = policy[idx].item()
        if prob > best_prob:
            best_prob = prob
            best_move = (r, c)
    return best_move
