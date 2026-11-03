"""项目内资源路径。

所有对 models/ 和 data/ 的引用都从这里取，避免使用相对当前工作目录的
硬编码字符串——那样只有在项目根目录下运行才有效。

本文件位于 src/，因此 parents[1] 是项目根目录。
"""
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]

MODELS_DIR = PROJECT_ROOT / "models"
DATA_DIR = PROJECT_ROOT / "data"

# 模型权重
BEST_MODEL = MODELS_DIR / "alphazero_net.pth"
NEW_MODEL = MODELS_DIR / "alphazero_net_new.pth"
BASELINE_MODEL = MODELS_DIR / "baseline" / "alphazero_net_baseline.pth"

# 训练数据与断点
SELF_PLAY_DATA = DATA_DIR / "self_play_data.pt"
SELF_PLAY_CHECKPOINT = DATA_DIR / "self_play_checkpoint.pt"
TRAIN_DATA = DATA_DIR / "train_data.pt"
