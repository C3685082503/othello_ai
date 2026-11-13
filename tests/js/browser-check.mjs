/*
 * 真实浏览器端到端验收（本地跑，不进 CI）
 *
 * 用 Edge 无头模式 + CDP 打开页面，验证：
 *   1. 模型真的加载成功（权重 113 万参数）
 *   2. 点棋盘能落子，AI 真的会回应
 *   3. 悔棋、新对局按钮生效
 *   4. 375px 窄屏没有横向溢出
 *   5. 全程没有 JS 异常
 * 并输出一张截图，便于肉眼确认布局。
 *
 * 用法：
 *   1. 另开一个进程：python -m http.server 8765 --directory web
 *   2. node tests/js/browser-check.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGE_URL = process.env.PAGE_URL || 'http://127.0.0.1:8765/';
const PAGE_MATCH = process.env.PAGE_MATCH || '127.0.0.1:8765';
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DEBUG_PORT = 9222;
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

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

async function findPageTarget(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.url.includes(PAGE_MATCH));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch { /* 浏览器还没监听 */ }
    await sleep(300);
  }
  throw new Error('找不到浏览器调试目标');
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const errors = [];
  let nextId = 0;

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push(d.exception?.description || d.text || 'unknown exception');
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
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

  return { opened, send, errors, close: () => ws.close() };
}

async function main() {
  if (!PAGE_URL.startsWith('file:')) await waitForServer(PAGE_URL);

  const profile = mkdtempSync(join(tmpdir(), 'othello-edge-'));
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

  const checks = [];
  const record = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  };

  let cdp;
  try {
    const target = await findPageTarget();
    cdp = connect(target.webSocketDebuggerUrl);
    await cdp.opened;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const evaluate = async (expression, awaitPromise = true) => {
      const r = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise,
        returnByValue: true
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      }
      return r.result.value;
    };

    const waitUntil = async (expr, label, timeoutMs = 45000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expr, false)) return;
        await sleep(150);
      }
      throw new Error(`等待超时：${label}`);
    };

    // 1. 模型加载
    await waitUntil(
      "document.readyState === 'complete' && !!document.getElementById('model-info')",
      '页面 DOM 就绪'
    );
    await waitUntil(
      "!!document.getElementById('model-info') && document.getElementById('model-info').textContent.includes('参数')",
      '模型加载完成',
      90000
    );
    const modelInfo = await evaluate("document.getElementById('model-info').textContent", false);
    record('模型加载', /1,132,737/.test(modelInfo), modelInfo);

    // 1.5 开局规则弹窗：应当先出现，点「开始对局」后关闭
    const rulesShown = await evaluate("!document.getElementById('rules').hidden", false);
    record('开局显示规则弹窗', rulesShown, rulesShown ? '规则可见' : '规则未显示');
    await evaluate("document.getElementById('btn-rules-start').click()", false);
    await sleep(250);
    const rulesClosed = await evaluate("document.getElementById('rules').hidden", false);
    record('「开始对局」关闭规则', rulesClosed === true, rulesClosed ? '已关闭' : '仍显示');

    const initial = await evaluate(
      "(() => ({b: document.getElementById('black-score').textContent, w: document.getElementById('white-score').textContent}))()",
      false
    );
    record('初始局面 2:2', initial.b === '2' && initial.w === '2', JSON.stringify(initial));

    // 2. 通过真实鼠标事件落子（验证 canvas 命中与事件绑定）
    const first = await evaluate(
      '(() => { const m = window.__OTHELLO__.board().legalMoves(1); const rect = document.getElementById("board").getBoundingClientRect(); const i = m[0]; const x = rect.left + ((i & 7) + 0.5) * rect.width / 8; const y = rect.top + ((i >> 3) + 0.5) * rect.height / 8; return { i, x, y }; })()',
      false
    );
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {
        type,
        x: first.x,
        y: first.y,
        button: 'left',
        clickCount: 1
      });
    }

    await waitUntil(
      "!!document.getElementById('timing') && document.getElementById('timing').textContent.includes('ms') && window.__OTHELLO__.state.thinking === false",
      'AI 回应完成',
      90000
    );
    const afterClick = await evaluate(
      "(() => ({b: +document.getElementById('black-score').textContent, w: +document.getElementById('white-score').textContent, status: document.getElementById('status').textContent, timing: document.getElementById('timing').textContent}))()",
      false
    );
    record(
      '鼠标点击落子 + AI 回应',
      afterClick.b + afterClick.w >= 5,
      `黑 ${afterClick.b} : 白 ${afterClick.w} · ${afterClick.timing}`
    );

    // 3. 悔棋
    await evaluate("document.getElementById('btn-undo').click()", false);
    await sleep(400);
    const afterUndo = await evaluate(
      "(() => ({b: +document.getElementById('black-score').textContent, w: +document.getElementById('white-score').textContent}))()",
      false
    );
    record(
      '悔棋撤回一整轮',
      afterUndo.b + afterUndo.w < afterClick.b + afterClick.w,
      `黑 ${afterUndo.b} : 白 ${afterUndo.w}`
    );

    // 4. 新对局
    await evaluate("document.getElementById('btn-new').click()", false);
    await sleep(300);
    const afterNew = await evaluate(
      "(() => ({b: +document.getElementById('black-score').textContent, w: +document.getElementById('white-score').textContent}))()",
      false
    );
    record('新对局重置为 2:2', afterNew.b === 2 && afterNew.w === 2, JSON.stringify(afterNew));

    // 5. 规则可再次打开，并在 375px 下检查弹窗布局
    await evaluate("document.getElementById('btn-rules').click()", false);
    await sleep(250);
    const reopened = await evaluate("!document.getElementById('rules').hidden", false);
    record('「规则」按钮可再次打开', reopened, reopened ? '已打开' : '未打开');

    const outDir = join(root, 'docs');
    mkdirSync(outDir, { recursive: true });
    const shotRules = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(outDir, 'rules-screenshot.png'), Buffer.from(shotRules.data, 'base64'));

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 812,
      deviceScaleFactor: 2,
      mobile: true
    });
    await sleep(500);
    const narrow = await evaluate(
      '(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }))()',
      false
    );
    record('375px 规则弹窗无横向溢出', narrow.sw <= narrow.iw + 1, `scrollWidth=${narrow.sw}, innerWidth=${narrow.iw}`);

    const shotRulesMobile = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(outDir, 'rules-mobile.png'), Buffer.from(shotRulesMobile.data, 'base64'));

    // 6. Esc 关闭，回到棋盘截图
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(300);
    await evaluate(
      "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
      false
    );
    await sleep(250);
    const closedByEsc = await evaluate("document.getElementById('rules').hidden", false);
    record('Esc 关闭规则', closedByEsc === true, closedByEsc ? '已关闭' : '仍显示');

    await sleep(300);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const shotPath = join(outDir, 'browser-screenshot.png');
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    record('截图已保存', true, shotPath);

    // 7. 无 JS 异常
    await sleep(500);
    record('无 JS 异常', cdp.errors.length === 0, cdp.errors.join(' | ') || 'clean');

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
    if (failed.length) process.exitCode = 1;
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
