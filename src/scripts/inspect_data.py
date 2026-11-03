"""数据自查脚本：打印 data/train_data.pt 里的张量形状与样本数。

注意：这**不是**单元测试，所以放在 src/scripts/ 而不是 tests/。

用法（在项目根目录执行）：
    python -m src.scripts.inspect_data
"""
import torch
from torch.utils.data import TensorDataset, DataLoader


def main():
    data = torch.load("data/train_data.pt")
    states = data["states"]
    policies = data["policies"]
    values = data["values"]

    print(f"states shape: {states.shape}")
    print(f"policies shape: {policies.shape}")
    print(f"values shape: {values.shape}")
    print(f"实际加载样本数量 = {states.shape[0]}")

    dataset = TensorDataset(states, policies, values)
    dataloader = DataLoader(dataset, batch_size=64, shuffle=True)
    print(f"dataset len: {len(dataset)}")
    print(f"dataloader总batch数量: {len(dataloader)}")


if __name__ == "__main__":
    main()
