import sys
import os
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))


# 1. 加载数据
import torch
from torch.utils.data import TensorDataset, DataLoader

data = torch.load('data/train_data.pt')
states = data['states']
policies = data['policies']
values = data['values']

# =========新增调试打印========
print(f"states shape: {states.shape}")
print(f"policies shape: {policies.shape}")
print(f"values shape: {values.shape}")
print(f"实际加载样本数量 = {states.shape[0]}")
dataset = TensorDataset(states, policies, values)
dataloader = DataLoader(dataset, batch_size=64, shuffle=True)
print(f"dataset len: {len(dataset)}")
print(f"dataloader总batch数量: {len(dataloader)}")
# ==============================
