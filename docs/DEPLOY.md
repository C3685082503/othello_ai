# 部署与分享

## 一句话

这个项目的 AI 现在**在浏览器里运行**：模型权重 4.3 MB，单次前向约 5 ms，一次 160 次模拟的搜索约 1 秒。因此部署不需要服务器，GitHub Pages 就能托管一个永久在线、固定网址、可随时分享的版本；另有一个 5.8 MB 的单文件版，可以离线、可以直接发微信。

| 产物 | 位置 | 需要服务器 | 适用场景 |
| --- | --- | --- | --- |
| 在线版 | GitHub Pages（`web/`） | 否 | 发链接给同学、写进简历/答辩 PPT |
| 单文件离线版 | `dist/othello-offline.html` | 否 | 没网、微信直发、U 盘拷贝 |
| 本地 FastAPI 版 | `src/web/server.py` | 是（本机） | 想保留 Python 后端、换模型调试 |

三者共用同一份权重与同一套规则，棋力一致。

---

## 1. 本地预览

```bash
python -m http.server 8765 --directory web
# 浏览器打开 http://127.0.0.1:8765/
```

> ⚠️ **不要直接双击 `web/index.html`**。页面要用 `fetch` 读 `weights.bin`，`file://` 协议下浏览器会拦截，页面会提示「模型加载失败」。想双击打开就用单文件离线版（见第 3 节）。

---

## 2. 发布到 GitHub Pages

只需配置一次，之后每次 push 自动发布。

### 2.1 确认权重已入库

`web/weights.bin`（4.3 MB）和 `web/weights.json` 必须提交进仓库 —— CI 不跑 Python，直接读这两个文件。

```bash
git add web/weights.bin web/weights.json tests/js/reference.json
git add web/ tests/js/ tools/ .github/workflows/pages.yml
git commit -m "feat: 浏览器端推理版本 + Pages 部署"
git push
```

### 2.2 打开 Pages

仓库 **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**（不要选 “Deploy from a branch”）。

### 2.3 等待工作流

`.github/workflows/pages.yml` 会做三件事：

1. `verify`：跑规则测试、JS/PyTorch 数值对齐、完整对局冒烟；
2. 构建 `dist/othello-offline.html` 并作为 Actions artifact 上传；
3. 把 `web/` 发布到 Pages。

发布成功后的地址形如：

```
https://<你的用户名>.github.io/othello_ai/
```

> 免费账户的 Pages 限制：站点 ≤ 1 GB、软带宽 100 GB/月；用 Actions 发布不受「每小时 10 次构建」限制。详见 [GitHub Pages 限制](https://docs.github.com/zh/pages/getting-started-with-github-pages/github-pages-limits)。

---

## 3. 单文件离线版

```bash
node tools/build_single.mjs
# 产物：dist/othello-offline.html（约 5.8 MB）
```

它把 CSS、四个 JS、权重（base64）全部内联进一个 HTML：双击即玩、断网可用、发给别人不会缺文件。代价是体积比在线版大（base64 有 33% 膨胀），首次打开稍慢。

> 想进一步瘦身：把权重做 int8 量化可以降到约 1.5 MB，但需要重新评估棋力，目前没有做。

---

## 4. 更新模型之后

训练出新模型后，浏览器版必须重新导出权重，否则线上还是旧棋力：

```bash
# 1. 导出（同时刷新 tests/js/reference.json 的 PyTorch 参考值）
python -m src.scripts.export_web_weights

# 2. 验证 JS 与 PyTorch 仍然逐值一致
node --test tests/js/engine.test.mjs tests/js/net.test.mjs tests/js/e2e.test.mjs

# 3. 重新构建离线版
node tools/build_single.mjs

# 4. 提交
git add web/weights.bin web/weights.json tests/js/reference.json
git commit -m "chore: 更新浏览器端权重"
git push
```

`weights.json` 里带 sha256，`tests/js/net.test.mjs` 会校验权重文件与元信息是否匹配，避免「换了 bin 忘了换 json」。

---

## 5. 性能与限制

本机（Windows / Node 24 / Edge 无头）实测：

| 指标 | 数值 |
| --- | --- |
| 单次前向 | 5.07 ms |
| 160 次模拟 / 步 | 约 1.0 s |
| 320 次模拟 / 步 | 约 2.0 s |
| 在线版权重 | 4.32 MB（首次加载后浏览器缓存） |
| 单文件版 | 5.81 MB |

- 手机上通常慢 2–4 倍，建议用「轻松 / 标准」两档；页面上的「思考强度」随时可调，下一手生效。
- 每步搜索都是同步 CPU 计算，页面通过 `yieldEvery` 分片让出主线程，思考期间遮罩上有进度条。
- **刷新会丢局**：状态只存在内存里，这是刻意的无状态设计（也意味着多标签页互不干扰）。
- 首次进入需要下载 4.3 MB 权重；GitHub Pages 走 CDN，通常 1–3 秒。

---

## 6. 为什么不用 onnxruntime-web

试过的方案是 `torch.onnx.export` + `onnxruntime-web`（WebGPU/WASM）。最终没选它：

- 这个网络只有 113 万参数、两层 3×3 卷积 + 三层全连接，手写 JS 前向只有约 150 行，**5 ms 一次**；
- `onnxruntime-web` 的 wasm 运行时约 10 MB，要么进仓库、要么依赖 CDN —— 对「单文件离线」是负担，国内 CDN 还不稳定；
- 零依赖意味着没有版本漂移、没有 wasm 兼容问题，也更容易审计。

数值一致性由 `tests/js/net.test.mjs` 保证：JS 的 policy/value 必须和 PyTorch 在 5 个局面上逐值吻合（容差 2e-4）。

---

## 7. 国内访问的现实问题

`*.github.io` 在国内经常打不开或很慢。建议：

1. **优先用单文件离线版**：微信/网盘分发，完全不受网络策略影响，答辩现场最稳；
2. 需要在线可访问时，把 `web/` 传到国内对象存储 + CDN（需已备案域名）；
3. 临时演示可以继续用 `cpolar` 隧道指向本机，但域名每次会变，不适合长期分享。

---

## 8. 常见问题

**页面显示「模型加载失败」**
用 `file://` 直接打开了 `index.html`。改用 `python -m http.server` 或单文件离线版。

**AI 落子很慢**
在「思考强度」里降到「轻松」（80 次模拟）；或换性能更好的设备。低端手机上 320 次模拟可能需要 5 秒以上。

**发布后 404**
Actions 里 `pages` 工作流是否成功；Settings → Pages 的 Source 是否选了 GitHub Actions；仓库是否 public（免费账户的 Pages 只对 public 仓库开放）。

**改了模型但线上没变**
重新执行第 4 节的导出流程，并确认 `web/weights.bin` 的 sha256 变了。
