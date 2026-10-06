# 从零实现 AlphaZero 黑白棋 AI

一个完全从零手写的深度强化学习系统，不依赖任何现成的 MCTS、强化学习库。涵盖：游戏规则引擎、传统博弈 AI、策略/价值双头神经网络、蒙特卡洛树搜索（MCTS）、自我对弈进化闭环。

## 📖 项目简介

本项目是我在大一阶段完成的深度强化学习与博弈算法实战项目。项目以黑白棋（Othello）为载体，完整复现了 DeepMind 的 AlphaZero 核心思想：用神经网络提供直觉（策略），用搜索算法进行计算（MCTS），通过自我对弈实现持续进化。

相比于直接调用 API 或框架，本项目手写了所有核心算法，旨在彻底吃透搜索、强化学习、神经网络和工程部署的底层逻辑。

## 🏗️ 技术架构

项目采用标准 src/ 结构进行模块化管理：

```text
othello_ai/
├── src/
│   ├── game_engine/       # 游戏规则引擎（规则校验、合法走法）
│   ├── agents/            # 传统 AI 智能体（随机、贪心、Minimax、Alpha-Beta）
│   ├── alphazero/         # AlphaZero 核心
│   │   ├── network.py     # PyTorch 双头神经网络
│   │   ├── mcts.py        # MCTS + PUCT 搜索（支持残局特训与 Dirichlet 噪声）
│   │   ├── self_play.py   # 自我对弈生成训练数据（支持断点续跑）
│   │   ├── evolution.py   # 进化训练与评估门控（胜率 > 55% 自动替换）
│   │   └── encoder.py     # 棋盘状态张量编码
│   └── scripts/           # 运行入口脚本（人机对战、模型评估等）
├── data/                  # 训练数据与断点存档
├── models/                # 神经网络模型权重
│   ├── baseline/          # 历史降级备用模型
│   └── alphazero_net.pth  # 当前最佳模型
└── docs/                  # 项目文档与实验报告
```

## ✨ 核心特性

- 纯手写 MCTS：实现了 Selection、Expansion、Evaluation、Backpropagation 四步搜索，并基于 PUCT 公式平衡探索与利用。
- 动态残局特训：在棋盘剩余空格少于 12 个时，自动将 MCTS 模拟次数从 200 提升至 800，极大增强了残局计算能力。
- 完全贪心实战：实战阶段强制选择访问次数最多的走法，杜绝随机失误。
- 数据增强与多样性：采用温度衰减（前10步 1.0，10-20步 0.5，之后 0.1）和 Dirichlet 噪声，保证自我对弈数据的多样化。
- 工程化保障：支持断点续跑、自动评估门控、网络结构动态升级（32/64 升级至 64/128）。

## 📊 实验结果

| 对手 | 模拟次数 | 胜率 | 说明 |
| :--- | :--- | :--- | :--- |
| 贪心 AI | 100 | 100% | 基础测试，快速验证 |
| 旧版模型 | 50 | 86.67% | 进化训练后的自我超越 |
| Alpha-Beta 深度 5 | 800 | 100% | 算力拉满下的绝杀 |

## 🚀 快速开始

### 1. 环境配置
pip install -r requirements.txt

### 2. 运行单元测试
python -m pytest tests/test_board.py -v

### 3. 生成自我对弈数据
python src/alphazero/self_play.py

### 4. 执行进化训练与评估
python src/alphazero/evolution.py

### 5. 挑战传统 AI
python src/scripts/play_evolved.py

## 🛠️ 未来规划

- [ ] Web 部署：基于 FastAPI + WebSocket + HTML/JS，实现浏览器端人机对战，响应时间 < 1 秒。
- [ ] 五子棋迁移：将 8x8 黑白棋扩展至 15x15 五子棋，调整网络输入与 MCTS 分支策略。
- [ ] 多进程自我对弈：利用多进程并行生成数据，提升训练效率。
- [ ] 模型量化：使用 ONNX Runtime 优化推理速度，降低部署资源占用。

## 📚 参考资料
- Mastering the game of Go without human knowledge (AlphaGo Zero)
- Mastering Chess and Shogi by Self-Play with a General Reinforcement Learning Algorithm (AlphaZero)

---
本项目为个人在大一期间的独立探索与实践。