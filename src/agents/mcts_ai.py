from src.alphazero.mcts import MCTS

def mcts_ai(board, player, num_simulations=50):
    mcts = MCTS(c_puct=1.0, num_simulations=num_simulations)
    move = mcts.search(board, player)
    return move
