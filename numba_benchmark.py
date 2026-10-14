import time
from src.game_engine.board import Board
from src.game_engine.numba_board import NumbaBoard

# 测试 Python 版
b1 = Board()
start = time.time()
for _ in range(10000):
    b1.legal_moves(1)
print(f"Python 棋盘 10000 次 legal_moves 耗时: {time.time() - start:.4f} 秒")

# 测试 Numba 版
b2 = NumbaBoard()
# 预热（第一次调用会编译）
b2.legal_moves(1)
start = time.time()
for _ in range(10000):
    b2.legal_moves(1)
print(f"Numba 棋盘 10000 次 legal_moves 耗时: {time.time() - start:.4f} 秒")