/*
 * 生成「AI 思考中」三种视觉方案的实机效果图。
 *
 * 不是设计稿：直接用真实页面、真实棋盘和真实样式渲染，注入的只是候选方案
 * 的临时 DOM/CSS，截图后不做任何持久化修改。
 *
 * 用法：
 *   python -m http.server 8765 --directory web
 *   node tools/mockup-thinking.mjs
 * 产物：docs/thinking-a.png / thinking-b.png / thinking-c.png
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGE_URL = process.env.PAGE_URL || 'http://127.0.0.1:8765/';
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DEBUG_PORT = 9223;
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'docs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error(`本地服务未就绪：${url}`);
}

async function findTarget(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:8765'));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch { /* 浏览器还没监听 */ }
    await sleep(300);
  }
  throw new Error('找不到浏览器调试目标');
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 0;

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });

  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });

  function send(method, params = {}, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  return { opened, send, close: () => ws.close() };
}

const MOCK_CSS = `
#white-card.is-active { animation: mock-breathe 1.6s ease-in-out infinite; }
@keyframes mock-breathe {
  0%, 100% { box-shadow: 0 0 0 1px var(--accent); }
  50% { box-shadow: 0 0 0 1px var(--accent), 0 0 18px rgba(242,196,92,.28); }
}
.mock-status {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  margin: -4px 0 14px;
  font-size: 12px;
  color: var(--text-dim);
}
.mock-status .dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 8px rgba(242,196,92,.8);
  animation: mock-pulse 1.2s ease-in-out infinite;
}
.mock-status > span { white-space: nowrap; }
.mock-status > span:nth-of-type(1) { color: var(--text-mid); }
@keyframes mock-pulse { 0%,100% { opacity:.35 } 50% { opacity:1 } }
.mock-status .track {
  flex: 1; height: 3px; border-radius: 999px;
  background: rgba(255,255,255,.10); overflow: hidden;
}
.mock-status .fill {
  height: 100%; border-radius: 999px;
  background: linear-gradient(90deg, #f2c45c, #e6b34a);
}
.mock-status .meta {
  color: var(--text-mid);
  font-variant-numeric: tabular-nums;
}
.mock-card {
  position: absolute;
  top: 22px; right: 22px;
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px 10px 10px;
  border-radius: 14px;
  background: rgba(14,19,31,.86);
  border: 1px solid var(--border-strong);
  box-shadow: 0 10px 30px rgba(0,0,0,.45);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  z-index: 3;
}
.mock-card .txt { display: flex; flex-direction: column; gap: 1px; }
.mock-card b { font-size: 12px; color: var(--text-main); }
.mock-card span { font-size: 11px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.mock-card .ring { transform: rotate(-90deg); }
.mock-card .ring .bg { fill: none; stroke: rgba(255,255,255,.14); stroke-width: 3; }
.mock-card .ring .fg { fill: none; stroke: var(--accent); stroke-width: 3; stroke-linecap: round; }
.mock-tag {
  display: inline-flex; align-items: center;
  padding: 3px 8px; border-radius: 999px;
  background: rgba(242,196,92,.12);
  color: var(--accent); font-size: 11px;
  white-space: nowrap;
  flex: 0 0 auto;
}

/* H1：进度放进 AI 自己的卡片和回合徽章，零额外占位 */
#white-card.is-thinking {
  border-color: rgba(242,196,92,.75);
  box-shadow: 0 0 0 1px rgba(242,196,92,.55), 0 0 20px rgba(242,196,92,.18);
  animation: mock-breathe 1.6s ease-in-out infinite;
}
#white-card.is-thinking::after {
  content: '';
  position: absolute; left: 0; right: 0; bottom: 0; height: 40%;
  background: linear-gradient(180deg, rgba(242,196,92,0), rgba(242,196,92,.16));
  pointer-events: none;
}
.mock-ring-sm {
  display: inline-block; width: 16px; height: 16px; border-radius: 50%;
  background: conic-gradient(var(--accent) 0 40%, rgba(0,0,0,.14) 40% 100%);
  position: relative; margin-right: 7px; vertical-align: -3px;
}
.mock-ring-sm::after {
  content: ''; position: absolute; inset: 3px; border-radius: 50%; background: #fff;
}

/* H2：棋盘上方独立状态条，有环有进度但不遮棋盘 */
.mock-h2 {
  width: 100%; display: flex; align-items: center; gap: 10px;
  margin: -4px 0 12px; padding: 7px 12px;
  border: 1px solid var(--border-strong); border-radius: 12px;
  background: var(--panel);
}
.mock-h2 b { font-size: 12.5px; color: var(--text-main); white-space: nowrap; }
.mock-h2 .bar {
  flex: 1; height: 4px; border-radius: 999px;
  background: rgba(255,255,255,.10); overflow: hidden;
}
.mock-h2 .bar i { display: block; height: 100%; background: linear-gradient(90deg, #f2c45c, #e6b34a); }
.mock-h2 .meta {
  font-size: 11.5px; color: var(--text-dim);
  white-space: nowrap; font-variant-numeric: tabular-nums;
}
.mock-h2 .ring { transform: rotate(-90deg); flex: 0 0 auto; }
.mock-h2 .ring .bg { fill: none; stroke: rgba(255,255,255,.15); stroke-width: 3; }
.mock-h2 .ring .fg { fill: none; stroke: var(--accent); stroke-width: 3; stroke-linecap: round; }

.board-wrap.is-thinking {
  border-color: rgba(242,196,92,.55);
  animation: mock-board 1.8s ease-in-out infinite;
}
@keyframes mock-board {
  0%, 100% { box-shadow: 0 18px 44px rgba(0,0,0,.45); }
  50% { box-shadow: 0 18px 44px rgba(0,0,0,.45), 0 0 26px rgba(242,196,92,.18); }
}
`;

async function main() {
  await waitForServer(PAGE_URL);
  mkdirSync(outDir, { recursive: true });

  const profile = mkdtempSync(join(tmpdir(), 'othello-mock-'));
  const child = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=900,1000',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    PAGE_URL
  ], { stdio: 'ignore' });

  let cdp;
  try {
    const target = await findTarget();
    cdp = connect(target.webSocketDebuggerUrl);
    await cdp.opened;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const evaluate = async (expression, awaitPromise = true) => {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      }
      return r.result.value;
    };

    const waitUntil = async (expr, label, timeoutMs = 60000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expr, false)) return;
        await sleep(150);
      }
      throw new Error(`等待超时：${label}`);
    };

    await waitUntil(
      "document.readyState === 'complete' && !!document.getElementById('model-info') && document.getElementById('model-info').textContent.includes('参数')",
      '模型加载'
    );
    await evaluate("document.getElementById('btn-rules-start').click()", false);
    await sleep(200);

    // 摆一个中盘局面，切到「AI 思考中」
    await evaluate(`(() => {
      const api = window.__OTHELLO__;
      const b = api.board();
      let seed = 20261117;
      const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
      let guard = 0;
      while (b.emptyCount() > 44 && !b.isTerminal() && guard++ < 200) {
        const moves = b.legalMoves();
        if (!moves.length) { b.currentPlayer = -b.currentPlayer; continue; }
        b.stepIndex(moves[Math.floor(rnd() * moves.length)]);
      }
      if (!b.legalMoves(-1).length) b.currentPlayer = 1;
      api.state.thinking = true;
      api.state.gameOver = false;
      api.state.lastSearch = null;
      api.state.hover = -1;
      api.render();
      return { empties: b.emptyCount(), player: b.currentPlayer };
    })()`, false);

    // 注入临时样式
    await evaluate(`(() => {
      const s = document.createElement('style');
      s.id = 'mock-style';
      s.textContent = ${JSON.stringify(MOCK_CSS)};
      document.head.appendChild(s);
    })()`, false);

    const cleanup = async () => {
      await evaluate(`(() => {
        ['mock-status', 'mock-card', 'mock-overlay'].forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.remove();
        });
      })()`, false);
    };

    const statusHtml =
      '<span class="dot"></span><span>AI 思考中</span>' +
      '<div class="track"><div class="fill" style="width:40%"></div></div>' +
      '<span class="meta">64 / 160 · 0.4s</span>';

    const addStatus = async (extraTag = '') => {
      await evaluate(`(() => {
        const host = document.querySelector('.win-rate');
        const el = document.createElement('div');
        el.id = 'mock-status';
        el.className = 'mock-status';
        el.innerHTML = ${JSON.stringify(statusHtml)} + ${JSON.stringify(extraTag)};
        host.after(el);
      })()`, false);
    };

    const shot = async (name) => {
      const img = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(join(outDir, name), Buffer.from(img.data, 'base64'));
      console.log('saved', join(outDir, name));
    };

    // A：轻量状态条，不遮棋盘
    await addStatus();
    await sleep(300);
    await shot('thinking-a.png');
    await cleanup();

    // B：悬浮进度环
    await evaluate(`(() => {
      const card = document.createElement('div');
      card.id = 'mock-card';
      card.className = 'mock-card';
      card.innerHTML = '<svg class="ring" width="44" height="44" viewBox="0 0 44 44">' +
        '<circle class="bg" cx="22" cy="22" r="18"></circle>' +
        '<circle class="fg" cx="22" cy="22" r="18" stroke-dasharray="113.1" stroke-dashoffset="67.9"></circle>' +
        '</svg><div class="txt"><b>AI 思考中</b><span>64 / 160</span><span>0.4s</span></div>';
      document.querySelector('.board-wrap').appendChild(card);
    })()`, false);
    await sleep(300);
    await shot('thinking-b.png');
    await cleanup();

    // C：状态条 + 前 3 候选点
    await addStatus('<span class="mock-tag">前 3 候选</span>');
    await evaluate(`(() => {
      const board = document.getElementById('board');
      const wrap = document.querySelector('.board-wrap');
      const br = board.getBoundingClientRect();
      const wr = wrap.getBoundingClientRect();

      const cv = document.createElement('canvas');
      cv.id = 'mock-overlay';
      cv.width = 480;
      cv.height = 480;
      cv.style.position = 'absolute';
      cv.style.pointerEvents = 'none';
      cv.style.zIndex = '2';
      cv.style.left = (br.left - wr.left) + 'px';
      cv.style.top = (br.top - wr.top) + 'px';
      cv.style.width = br.width + 'px';
      cv.style.height = br.height + 'px';
      wrap.appendChild(cv);

      const ctx = cv.getContext('2d');
      const api = window.__OTHELLO__;
      const b = api.board();
      const moves = b.legalMoves(b.currentPlayer);
      if (moves.length < 3) return 'too-few';
      const picks = [moves[0], moves[Math.floor(moves.length / 2)], moves[moves.length - 1]];
      const pct = [52, 31, 17];
      const radii = [27, 21, 16];

      picks.forEach((idx, i) => {
        const cx = (idx & 7) * 60 + 30;
        const cy = (idx >> 3) * 60 + 30;
        ctx.beginPath();
        ctx.arc(cx, cy, radii[i], 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(242,196,92,' + (0.10 - i * 0.02) + ')';
        ctx.fill();
        ctx.lineWidth = 2.4;
        ctx.strokeStyle = 'rgba(242,196,92,' + (0.95 - i * 0.18) + ')';
        ctx.stroke();

        const label = pct[i] + '%';
        ctx.font = 'bold 13px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(8,12,20,.75)';
        ctx.strokeText(label, cx, cy + radii[i] + 13);
        ctx.fillStyle = '#f2c45c';
        ctx.fillText(label, cx, cy + radii[i] + 13);
      });
      return picks.join(',');
    })()`, false);
    await sleep(300);
    await shot('thinking-c.png');
    await cleanup();

    const reset = async () => {
      await evaluate(`(() => {
        ['mock-status', 'mock-card', 'mock-overlay'].forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.remove();
        });
        document.getElementById('white-card').classList.remove('is-thinking');
        document.querySelector('.board-wrap').classList.remove('is-thinking');
        window.__OTHELLO__.state.thinking = true;
        window.__OTHELLO__.render();
      })()`, false);
    };

    // H1：进度进 AI 卡片 + 回合徽章，不占额外空间
    await evaluate(`(() => {
      document.getElementById('white-card').classList.add('is-thinking');
      document.querySelector('.board-wrap').classList.add('is-thinking');
      const badge = document.getElementById('turn-indicator');
      badge.innerHTML = '<span class="mock-ring-sm"></span>AI 思考中 40%';
    })()`, false);
    await sleep(300);
    await shot('thinking-h1.png');
    await reset();

    // H2：棋盘上方独立状态条，有环有进度
    await evaluate(`(() => {
      const host = document.querySelector('.win-rate');
      const el = document.createElement('div');
      el.id = 'mock-status';
      el.className = 'mock-h2';
      el.innerHTML = '<svg class="ring" width="30" height="30" viewBox="0 0 30 30">' +
        '<circle class="bg" cx="15" cy="15" r="12"></circle>' +
        '<circle class="fg" cx="15" cy="15" r="12" stroke-dasharray="75.4" stroke-dashoffset="45.2"></circle>' +
        '</svg><b>AI 思考中</b><div class="bar"><i style="width:40%"></i></div>' +
        '<span class="meta">64 / 160 · 0.4s</span>';
      host.after(el);
      document.querySelector('.board-wrap').classList.add('is-thinking');
    })()`, false);
    await sleep(300);
    await shot('thinking-h2.png');
    await cleanup();

    console.log('done');
  } finally {
    if (cdp) cdp.close();
    child.kill();
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略占用 */ }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
