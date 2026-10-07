import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import TensorDataset, DataLoader
from src.alphazero.network import AlphaZeroNet


def train():
    data = torch.load('data/train_data.pt')
    dataset = TensorDataset(data['states'], data['policies'], data['values'])
    dataloader = DataLoader(dataset, batch_size=64, shuffle=True)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"使用设备: {device}")

    model = AlphaZeroNet().to(device)
    optimizer = optim.Adam(model.parameters(), lr=0.001)

    epochs = 20
    for epoch in range(epochs):
        model.train()
        total_loss = 0
        for batch_states, batch_policies, batch_values in dataloader:
            batch_states, batch_policies, batch_values = batch_states.to(device), batch_policies.to(
                device), batch_values.to(device)
            pred_policy, pred_value = model(batch_states)

            policy_loss = nn.functional.cross_entropy(pred_policy, batch_policies)
            value_loss = nn.functional.mse_loss(pred_value.squeeze(), batch_values)
            loss = policy_loss + value_loss

            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            total_loss += loss.item()

        print(f"Epoch {epoch + 1:02d}/{epochs} | Loss: {total_loss / len(dataloader):.4f}")

    torch.save(model.state_dict(), 'models/baseline/alphazero_net_baseline.pth')
    print("模型已保存到 models/baseline/alphazero_net_baseline.pth")


if __name__ == "__main__":
    train()
