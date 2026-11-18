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

    // 0. 慢网模式：只验证「规则先出现、按钮处于加载中」这一条
    //    用 CDP 把带宽压到 20 KB/s 后强制重载，模拟国内首次访问。
    if (process.env.SLOW === '1') {
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 300,
        downloadThroughput: 20 * 1024,
        uploadThroughput: 20 * 1024
      });
      await evaluate('window.__SLOW_MARK__ = 1', false);
      await cdp.send('Page.reload', { ignoreCache: true });
      // 重载是异步的：旧文档仍然 complete，必须等新文档（不再带标记）出现
      await waitUntil(
        "typeof window.__SLOW_MARK__ === 'undefined' && document.readyState === 'complete' && !!document.getElementById('rules') && !!document.getElementById('model-info')",
        '慢速重载完成'
      );
      await sleep(600);
      const early = await evaluate(
        "(() => { const b = document.getElementById('btn-rules-start'); return { rules: !document.getElementById('rules').hidden, aria: b.getAttribute('aria-disabled'), text: b.textContent.trim(), status: document.getElementById('rules-status').textContent.trim(), model: document.getElementById('model-info').textContent.trim() }; })()",
        false
      );
      record(
        '慢网下规则先出现、按钮为加载中',
        early.rules && early.aria === 'true' && early.text === '模型加载中…' && /加载/.test(early.model),
        JSON.stringify(early)
      );

      // 等进度文本出现，证明用户能看到「正在下载多少」
      let progressText = '';
      try {
        await waitUntil(
          "document.getElementById('rules-status').textContent.includes(' / ')",
          '下载进度出现',
          20000
        );
        progressText = await evaluate("document.getElementById('rules-status').textContent.trim()", false);
      } catch {
        progressText = '';
      }
      record('慢网下显示下载进度', /\/ 4\.3 MB/.test(progressText), progressText || '未出现');

      // 再等一会儿，让截图里的进度数字更有代表性
      await sleep(1500);

      const slowOut = join(root, 'docs');
      mkdirSync(slowOut, { recursive: true });
      const slowShot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(join(slowOut, 'slow-load.png'), Buffer.from(slowShot.data, 'base64'));
      record('慢速首屏截图', true, join(slowOut, 'slow-load.png'));
      console.log('\nSLOW 模式只验证首屏，提前结束');
      return;
    }

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

    // 1.5 规则弹窗：模型就绪后按钮应可用，且加载提示隐藏
    const startBtn = await evaluate(
      "(() => { const b = document.getElementById('btn-rules-start'); const n = document.getElementById('rules-status'); return { aria: b.getAttribute('aria-disabled'), text: b.textContent.trim(), noteHidden: n.hidden }; })()",
      false
    );
    record(
      '模型就绪后「开始对局」可用',
      startBtn.aria === null && startBtn.text === '开始对局' && startBtn.noteHidden === true,
      JSON.stringify(startBtn)
    );

    // 1.6 开局规则弹窗：应当先出现，点「开始对局」后关闭
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

    // 1.9 点击蓝光：tap highlight 与默认焦点框都应关闭
    const canvasStyle = await evaluate(
      "(() => { const s = getComputedStyle(document.getElementById('board')); return { tap: s.getPropertyValue('-webkit-tap-highlight-color'), outline: s.outlineStyle }; })()",
      false
    );
    record(
      '棋盘已禁用点击高亮与默认焦点框',
      (canvasStyle.tap === 'rgba(0, 0, 0, 0)' || canvasStyle.tap === 'transparent') && canvasStyle.outline === 'none',
      JSON.stringify(canvasStyle)
    );

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

    // 2.1 翻子动画：应有旧色→新色的记录，且按距离错峰
    const animState = await evaluate(
      "(() => { const a = window.__OTHELLO__.state.anims; return { n: a.length, hasFrom: a.every((x) => 'from' in x && 'to' in x), maxDelay: a.reduce((m, x) => Math.max(m, x.delay), 0), flips: a.filter((x) => x.from !== 0).length, animating: window.__OTHELLO__.state.animating }; })()",
      false
    );
    record(
      '落子后触发分波翻子动画',
      animState.n > 1 && animState.hasFrom && animState.maxDelay > 0 && animState.flips > 0 && animState.animating === true,
      JSON.stringify(animState)
    );

    await sleep(140);
    const flipShot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(root, 'docs', 'flip-animation.png'), Buffer.from(flipShot.data, 'base64'));

    // 2.5 思考反馈：进度环 + AI 卡片呼吸 + 棋盘描边
    await waitUntil(
      "!!document.getElementById('turn-text') && document.getElementById('turn-text').textContent.includes('%')",
      '思考进度出现',
      10000
    );
    const thinkingState = await evaluate(
      "(() => ({ text: document.getElementById('turn-text').textContent.trim(), ring: !document.getElementById('turn-ring').hidden, card: document.getElementById('white-card').classList.contains('is-thinking'), board: document.getElementById('board-wrap').classList.contains('is-thinking') }))()",
      false
    );
    record(
      '思考中显示进度环 + 卡片呼吸 + 棋盘描边',
      thinkingState.ring && thinkingState.card && thinkingState.board,
      JSON.stringify(thinkingState)
    );

    const liveShot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(root, 'docs', 'thinking-live.png'), Buffer.from(liveShot.data, 'base64'));

    await waitUntil(
      "!!document.getElementById('timing') && document.getElementById('timing').textContent.includes('ms') && window.__OTHELLO__.state.thinking === false",
      'AI 回应完成',
      90000
    );
    await sleep(550); // 等 AI 落子的翻子动画播完（最长约 420ms）
    const settled = await evaluate(
      "(() => ({ ringHidden: document.getElementById('turn-ring').hidden, card: document.getElementById('white-card').classList.contains('is-thinking'), text: document.getElementById('turn-text').textContent.trim(), anims: window.__OTHELLO__.state.anims.length, animating: window.__OTHELLO__.state.animating }))()",
      false
    );
    record('思考结束后视觉复位', settled.ringHidden && !settled.card && settled.anims === 0 && settled.animating === false, JSON.stringify(settled));
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

    // 3.5 「AI 思路」开关：打开后应能看到 3 个候选
    await evaluate("document.getElementById('toggle-candidates').click()", false);
    const candMove = await evaluate("window.__OTHELLO__.board().legalMoves(1)[0]", false);
    await evaluate(`window.__OTHELLO__.playHuman(${candMove})`, false);
    await waitUntil(
      "document.getElementById('turn-text').textContent.includes('%')",
      '思路开关下的思考',
      10000
    );
    const candState = await evaluate(
      "(() => ({ on: document.getElementById('toggle-candidates').getAttribute('aria-pressed'), n: window.__OTHELLO__.state.candidates.length, shares: window.__OTHELLO__.state.candidates.map((c) => Math.round(c.share * 100)) }))()",
      false
    );
    record(
      '「AI 思路」开关显示 3 个候选',
      candState.on === 'true' && candState.n === 3,
      JSON.stringify(candState)
    );
    const candShot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(root, 'docs', 'thinking-c-live.png'), Buffer.from(candShot.data, 'base64'));
    await waitUntil("window.__OTHELLO__.state.thinking === false", '思路测试完成', 60000);
    await evaluate("document.getElementById('toggle-candidates').click()", false);

    // 4. 新对局
    await evaluate("document.getElementById('btn-new').click()", false);
    await sleep(300);
    const afterNew = await evaluate(
      "(() => ({b: +document.getElementById('black-score').textContent, w: +document.getElementById('white-score').textContent}))()",
      false
    );
    record('新对局重置为 2:2', afterNew.b === 2 && afterNew.w === 2, JSON.stringify(afterNew));

    // 4.5 残局：把棋盘随机快进到 11 空位，确认走的是精确求解而不是 MCTS
    const egSetup = await evaluate(
      `(() => {
        const api = window.__OTHELLO__;
        const b = api.board();
        let seed = 12345;
        const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
        let guard = 0;
        while (b.emptyCount() > 11 && !b.isTerminal() && guard++ < 200) {
          const moves = b.legalMoves();
          if (!moves.length) { b.currentPlayer = -b.currentPlayer; continue; }
          b.stepIndex(moves[Math.floor(rnd() * moves.length)]);
        }
        if (b.isTerminal()) return { ok: false, reason: 'terminal' };
        b.currentPlayer = -1;
        if (b.legalMoves(-1).length === 0) return { ok: false, reason: 'white-has-no-move' };
        api.state.gameOver = false;
        api.state.lastSearch = null;
        return { ok: true, empties: b.emptyCount(), player: b.currentPlayer };
      })()`,
      false
    );
    record('构造 11 空位残局', egSetup.ok, JSON.stringify(egSetup));

    if (egSetup.ok) {
      await evaluate('window.__OTHELLO__.aiTurn()');
      const egTiming = await evaluate("document.getElementById('timing').textContent", false);
      record('残局切换为精确求解', /残局精算/.test(egTiming), egTiming);

      await evaluate("document.getElementById('btn-new').click()", false);
      await sleep(300);
    }

    // 4.6 移动端思考态：375px 下进度环不能把布局撑破
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 812,
      deviceScaleFactor: 2,
      mobile: true
    });
    await sleep(300);
    const mobileMove = await evaluate("window.__OTHELLO__.board().legalMoves(1)[0]", false);
    await evaluate(`window.__OTHELLO__.playHuman(${mobileMove})`, false);
    await waitUntil(
      "document.getElementById('turn-text').textContent.includes('%')",
      '移动端思考进度',
      10000
    );
    const mobileThink = await evaluate(
      "(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, text: document.getElementById('turn-text').textContent.trim() }))()",
      false
    );
    record('375px 思考态无横向溢出', mobileThink.sw <= mobileThink.iw + 1, JSON.stringify(mobileThink));
    const shotThinkingMobile = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(root, 'docs', 'thinking-mobile.png'), Buffer.from(shotThinkingMobile.data, 'base64'));
    await waitUntil("window.__OTHELLO__.state.thinking === false", '移动端 AI 完成', 60000);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(300);

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

    // 7. 终局提示：状态行必须在视口内，且徽章显示胜负
    const terminal = await evaluate(
      `(() => {
        const api = window.__OTHELLO__;
        const b = api.board();
        for (let i = 0; i < 64; i++) b.cells[i] = i < 40 ? 1 : -1;
        b.currentPlayer = 1;
        b.gameOver = true;
        api.state.gameOver = true;
        api.state.thinking = false;
        api.state.anims = [];
        api.state.animating = false;
        api.render();
        const status = document.getElementById('status');
        const rect = status.getBoundingClientRect();
        return {
          status: status.textContent.trim(),
          turn: document.getElementById('turn-text').textContent.trim(),
          top: Math.round(rect.top),
          vh: window.innerHeight
        };
      })()`,
      false
    );
    record(
      '终局提示可见且显示胜负',
      /获胜|平局/.test(terminal.status) &&
        /赢了|获胜|平局/.test(terminal.turn) &&
        terminal.top < terminal.vh,
      JSON.stringify(terminal)
    );
    await evaluate('window.__OTHELLO__.newGame()', false);
    await sleep(200);

    // 8. 无 JS 异常
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
