import torch
from src.game_engine.board import BLACK, WHITE
from src.alphazero.encoder import board_to_tensor
from src.alphazero.network import AlphaZeroNet
from src.paths import BEST_MODEL

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
model = AlphaZeroNet().to(device)

# baseline/ 下的是早期 32/64 通道权重，与当前 64/128 网络不兼容，
# 因此这里只加载最佳模型；缺失时抛出明确错误，而不是静默回退到不兼容的权重。
if not BEST_MODEL.exists():
    raise FileNotFoundError(
        f"缺少最佳模型 {BEST_MODEL}；models/baseline/ 下的权重是旧架构（32/64 通道），"
        "无法加载到当前 64/128 网络，请先训练生成模型。"
    )
model.load_state_dict(torch.load(BEST_MODEL, map_location=device))
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
