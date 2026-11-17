/*
 * 生成单文件离线版：dist/othello-offline.html
 *
 * 把 CSS、四个 JS、权重（base64）全部内联进一个 HTML。
 * 目标场景：微信直接发给同学、答辩现场没网、U 盘拷贝——双击即玩。
 *
 * 用法：node tools/build_single.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const web = join(root, 'web');

const read = (p) => readFileSync(join(web, p), 'utf8');
const raw = (p) => readFileSync(join(web, p));

const meta = JSON.parse(read('weights.json'));
const weightsB64 = raw('weights.bin').toString('base64');

const css = read('style.css');
const scripts = ['engine.js', 'endgame.js', 'net.js', 'mcts.js', 'app.js'];

for (const name of scripts) {
  if (read(name).includes('</script')) {
    throw new Error(`${name} 里有 </script，内联会截断 HTML`);
  }
}

let html = read('index.html');

html = html.replace(
  '<link rel="stylesheet" href="style.css">',
  () => `<style>\n${css}\n</style>`
);

// 权重放在 app.js 之前即可；这里紧挨着 engine.js 注入
const weightsTag =
  '<script>window.__OTHELLO_INLINE__ = {meta: ' +
  JSON.stringify(meta) +
  ', b64: "' + weightsB64 + '"};</script>';

html = html.replace(
  '<script src="engine.js"></script>',
  () => weightsTag + '\n    <script>\n' + read('engine.js') + '\n    </script>'
);

for (const name of ['endgame.js', 'net.js', 'mcts.js', 'app.js']) {
  html = html.replace(
    `<script src="${name}"></script>`,
    () => `<script>\n${read(name)}\n    </script>`
  );
}

// 自检：不允许残留任何外部引用
const leftovers = html.match(/<(script|link)[^>]+(src|href)="(?!data:)[^"]+"/g);
if (leftovers) {
  throw new Error('仍有外部引用：\n' + leftovers.join('\n'));
}

const outDir = join(root, 'dist');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'othello-offline.html');
writeFileSync(outPath, html, 'utf8');

const size = statSync(outPath).size;
console.log(`单文件离线版：${outPath}`);
console.log(`大小：${(size / 1024 / 1024).toFixed(2)} MB（其中权重 base64 ${(weightsB64.length / 1024 / 1024).toFixed(2)} MB）`);
