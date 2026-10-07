📦 AlphaZero 项目日常运行与演示手册
📌 前置准备（确保已安装）
Python 环境：D:\anaconda3\envs\torch_env\python.exe

公网穿透工具：D:\cpolar\cpolar.exe（已绑定 Token）

代码仓库：本地 D:\python_all\othello_ai

🚀 场景一：本地测试与网页对战（日常玩）
目标：让 AI 在本机网页上跑起来。

启动后端服务（打开 PyCharm 终端，输入以下命令并回车）：

powershell
D:\anaconda3\envs\torch_env\python.exe -m uvicorn src.web.server:app --host 0.0.0.0 --port 8000
（看到 Uvicorn running on http://0.0.0.0:8000 说明启动成功，此终端千万别关！）

浏览器访问：
打开电脑浏览器，输入 http://localhost:8000，即可开始与你的 AI 对战。

🌐 场景二：公网演示（大创答辩/发给同学挑战）
目标：让外网的人也能访问你的网页。

确保后端已启动（即完成场景一的第一步，且终端未关闭）。

启动公网隧道（在 PyCharm 里新开一个终端标签页，输入并回车）：

powershell
D:\cpolar\cpolar.exe http 8000
获取公网链接：
在终端输出里找到 Forwarding 那一行，复制 https://xxxx.cpolar.cn 的网址。

发给同学/评委：手机流量也能直接打开，无需连同一个 WiFi。

⚠️ 避坑提醒：cpolar 免费版每次重新启动，域名都会变。答辩当天请提前生成好，并把最终链接写进 PPT 或二维码中。

💾 场景三：代码更新与 Git 备份
目标：把新写的代码同步到 Gitee/GitHub，防止丢失。

在 PyCharm 终端依次执行（不依赖 uvicorn 和 cpolar）：

bash
git add .
git commit -m "fix: 描述你这次修改了什么"
git push
🧠 场景四：模型自我进化（想让它变得更强）
目标：重新生成数据，训练更强的网络。建议在睡前挂机运行。

生成自我对弈数据（会覆盖旧数据，耗时较长）：

powershell
D:\anaconda3\envs\torch_env\python.exe src\alphazero\self_play.py
执行进化训练与评估（跑完后，AI 会评估新模型是否替换旧模型）：

powershell
D:\anaconda3\envs\torch_env\python.exe src\alphazero\evolution.py
重新测试：
回到【场景一】重启后端服务，浏览器刷新，感受进化后 AI 的棋力。

⚠️ 常见问题急救包（Troubleshooting）
网页打不开、报错 connection refused：
检查跑 uvicorn 的那个终端是不是被关掉或报错了。重新执行场景一即可。

公网链接进不去，或一直转圈：
检查跑 cpolar 的终端是否还在运行，或重新执行场景二换一个新的域名。

AI 落子特别慢（>5 秒）：
可以打开 src/web/server.py，把第 20 行左右的 num_simulations=100 改为 num_simulations=50，然后重启服务。如果使用了带 --reload 的启动命令，它还会自动热加载。

终端报错 ModuleNotFoundError：
确保你是在 D:\python_all\othello_ai 这个项目根目录下执行命令的（看终端前面的路径提示）。

