/*
 * 当前浏览器 AI vs Python Alpha-Beta 深度 5 的对局脚本。
 *
 * 设计原则：对手用原封不动的 Python AB5（子进程 + JSON 行协议），
 * 被测对象是线上同一套 JS 引擎（网络 + MCTS + 树复用 + 残局精算）。
 * 每局前随机走 4 手开局，避免两个确定性引擎反复下出同一盘棋。
 *
 * 用法：
 *   node tools/match-ab5.mjs --games 20 --sims 160 --depth 5 --openings 4
 * 产物：
 *   dist/match-ab5-<games>x.json
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import readline from 'node:readline';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const { Board } = require(join(root, 'web', 'engine.js'));
const { Net } = require(join(root, 'web', 'net.js'));
const { MCTS } = require(join(root, 'web', 'mcts.js'));
const { solve } = require(join(root, 'web', 'endgame.js'));

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : fallback;
};

const games = Number(arg('games', 20));
const sims = Number(arg('sims', 160));
const depth = Number(arg('depth', 5));
const openings = Number(arg('openings', 0));
const book = Number(arg('book', 0));
const colorMode = arg('js-color', 'alternate'); // alternate | black | white
const seed = Number(arg('seed', 2026));
const useEndgame = arg('endgame', '1') !== '0';
const useReuse = arg('reuse', '1') !== '0';
const useNoise = arg('noise', '0') === '1';
const label = arg('label', '');
const bookFile = arg('book-file', '');
let bookLines = null;
if (bookFile) {
  const data = JSON.parse(readFileSync(resolve(root, bookFile), 'utf8'));
  if (!Array.isArray(data.lines) || data.lines.length === 0) {
    throw new Error(`开局库为空或格式不对：${bookFile}`);
  }
  bookLines = data.lines;
}
const python = process.env.PYTHON || 'D:/anaconda3/envs/torch_env/python.exe';

// ---------- 网络 ----------
const meta = JSON.parse(readFileSync(join(root, 'web', 'weights.json'), 'utf8'));
const bin = readFileSync(join(root, 'web', 'weights.bin'));
const net = new Net(meta, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const mcts = new MCTS(net, { cPuct: 1.5 });

// ---------- Python AB5 子进程 ----------
const py = spawn(python, ['-u', join(root, 'tools', 'ab5_server.py')], {
  stdio: ['pipe', 'pipe', 'ignore']
});

const rl = readline.createInterface({ input: py.stdout });
const lineQueue = [];
let pending = null;

rl.on('line', (line) => {
  if (pending) {
    const p = pending;
    pending = null;
    p(line);
  } else {
    lineQueue.push(line);
  }
});

py.on('error', (err) => {
  console.error('无法启动 Python AB5：', err.message);
  process.exit(1);
});

function ask(payload) {
  py.stdin.write(JSON.stringify(payload) + '\n');
  return new Promise((resolve, reject) => {
    const take = (line) => {
      try {
        resolve(JSON.parse(line));
      } catch (err) {
        reject(new Error('AB5 返回了非 JSON：' + line));
      }
    };
    if (lineQueue.length > 0) take(lineQueue.shift());
    else pending = take;
  });
}

// ---------- 工具 ----------
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fmtPct = (x) => (x * 100).toFixed(1) + '%';

// ---------- 一局 ----------
async function playGame(index, jsColor, bookLine) {
  const board = new Board();
  const rng = mulberry32(seed + index * 9973);
  let plies = 0;

  if (bookLine && bookLine.length) {
    // 使用开局库：每局一条，按顺序逐手校验合法性
    for (const move of bookLine) {
      const legal = board.legalMoves();
      if (!legal.includes(move)) {
        throw new Error(`开局库第 ${index + 1} 条在 ${plies} 手非法：${move}`);
      }
      board.stepIndex(move);
      plies++;
    }
  } else if (book > 0) {
    // 结构化开局：前 book 手按“局号 + 手数”轮换合法走法
    for (let i = 0; i < book && !board.isTerminal(); i++) {
      const moves = board.legalMoves();
      if (moves.length === 0) {
        board.currentPlayer = -board.currentPlayer;
        continue;
      }
      const pick = (index + i * 3) % moves.length;
      board.stepIndex(moves[pick]);
      plies++;
    }
  } else {
    // 纯随机开局：会明显打散局面，仅用于压力测试
    for (let i = 0; i < openings && !board.isTerminal(); i++) {
      const moves = board.legalMoves();
      if (moves.length === 0) {
        board.currentPlayer = -board.currentPlayer;
        continue;
      }
      board.stepIndex(moves[Math.floor(rng() * moves.length)]);
      plies++;
    }
  }

  mcts.resetCache();
  let jsMs = 0;
  let abMs = 0;
  let jsMoves = 0;
  let abMoves = 0;

  while (!board.isTerminal() && plies < 200) {
    const player = board.currentPlayer;
    const legal = board.legalMoves(player);
    if (legal.length === 0) {
      board.currentPlayer = -player;
      continue;
    }

    let move;
    if (player === jsColor) {
      const t0 = performance.now();
      if (useEndgame && board.emptyCount() <= 11) {
        const r = solve(board, player, { maxEmpty: 11, budgetMs: 1000 });
        move = r ? r.move : null;
      } else {
        const r = await mcts.search(board, player, { sims, reuse: useReuse, noise: useNoise });
        move = r.move;
      }
      jsMs += performance.now() - t0;
      jsMoves++;
    } else {
      const t0 = performance.now();
      const resp = await ask({
        board: Array.from(board.cells),
        player,
        depth
      });
      if (resp.move === undefined) {
        board.currentPlayer = -player;
        continue;
      }
      move = resp.move;
      abMs += performance.now() - t0;
      abMoves++;
    }

    if (move === null || move === undefined || !legal.includes(move)) {
      throw new Error(`第 ${index + 1} 局第 ${plies} 手出现非法步：${move}`);
    }
    board.stepIndex(move);
    plies++;
  }

  const [black, white] = board.score();
  const winner = board.winner();
  const jsScore = jsColor === 1 ? black : white;
  const abScore = jsColor === 1 ? white : black;

  return {
    index,
    jsColor,
    winner,
    black,
    white,
    jsScore,
    abScore,
    plies,
    jsMs,
    abMs,
    jsMoves,
    abMoves
  };
}

// ---------- 主流程 ----------
async function main() {
  const started = Date.now();
  const results = [];
  let jsWins = 0;
  let abWins = 0;
  let draws = 0;

  const colorText = colorMode === 'white' ? '固定执白' :
    colorMode === 'black' ? '固定执黑' : '黑白交替';
  console.log(
    `对局配置：${games} 局，JS ${sims} 次模拟（${colorText}），AB5 深度 ${depth}，` +
    `开局库 ${bookLines ? bookLines.length + ' 条' : '未使用'}，` +
    `结构化开局 ${book} 手 / 随机开局 ${openings} 手，` +
    `残局精算 ${useEndgame ? '开' : '关'}，树复用 ${useReuse ? '开' : '关'}，` +
    `根噪声 ${useNoise ? '开' : '关'}`
  );

  for (let i = 0; i < games; i++) {
    const jsColor = colorMode === 'white' ? -1 : colorMode === 'black' ? 1 : (i % 2 === 0 ? 1 : -1);
    const line = bookLines ? bookLines[i % bookLines.length] : null;
    const r = await playGame(i, jsColor, line);
    results.push(r);

    const jsWin = r.winner === jsColor;
    const draw = r.winner === 0;
    if (draw) draws++;
    else if (jsWin) jsWins++;
    else abWins++;

    const colorText = jsColor === 1 ? '执黑' : '执白';
    const resultText = draw ? '平' : (jsWin ? '胜' : '负');
    console.log(
      `第 ${String(i + 1).padStart(2)} 局：JS ${colorText} ${r.jsScore}:${r.abScore} ${resultText}` +
      `（${r.plies} 手，JS ${(r.jsMs / Math.max(1, r.jsMoves)).toFixed(0)}ms/步，` +
      `AB5 ${(r.abMs / Math.max(1, r.abMoves)).toFixed(0)}ms/步）`
    );
  }

  const totalMs = Date.now() - started;
  const margin = results.reduce((s, r) => s + (r.jsScore - r.abScore), 0) / Math.max(1, games);
  const jsMsPer = results.reduce((s, r) => s + r.jsMs, 0) /
    Math.max(1, results.reduce((s, r) => s + r.jsMoves, 0));
  const abMsPer = results.reduce((s, r) => s + r.abMs, 0) /
    Math.max(1, results.reduce((s, r) => s + r.abMoves, 0));

  const summary = {
    games,
    sims,
    depth,
    openings,
    endgame: useEndgame,
    jsWins,
    abWins,
    draws,
    winRate: jsWins / games,
    avgMargin: margin,
    jsMsPerMove: jsMsPer,
    abMsPerMove: abMsPer,
    totalMs
  };

  console.log('\n================ 结果 ================');
  console.log(`JS 胜 ${jsWins} / 负 ${abWins} / 平 ${draws}`);
  console.log(`JS 胜率：${fmtPct(summary.winRate)}`);
  console.log(`平均子差（JS - AB5）：${margin.toFixed(2)}`);
  console.log(`每步耗时：JS ${jsMsPer.toFixed(0)}ms，AB5 ${abMsPer.toFixed(0)}ms`);
  console.log(`总耗时：${(totalMs / 60000).toFixed(1)} 分钟`);

  const outDir = join(root, 'dist');
  mkdirSync(outDir, { recursive: true });
  const name = ['match-ab5', label, `${games}x`].filter(Boolean).join('-');
  const outPath = join(outDir, `${name}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        config: {
          sims,
          depth,
          openings,
          book,
          bookFile: bookFile || null,
          bookLines: bookLines ? bookLines.length : 0,
          jsColor: colorMode,
          endgame: useEndgame,
          reuse: useReuse,
          noise: useNoise,
          seed
        },
        summary,
        games: results
      },
      null,
      2
    )
  );
  console.log(`明细：${outPath}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      py.stdin.write('{"quit":true}\n');
    } catch { /* 忽略 */ }
    setTimeout(() => py.kill(), 200);
  });
