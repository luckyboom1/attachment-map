/**
 * 排版可读性度量（无头 Chrome + CDP）
 * ---------------------------------------------------------------------------
 * 用法：
 *   npm run dev
 *   npm run check:type
 *
 * 为什么不用列宽
 * ---------------------------------------------------------------------------
 * 第一版量的是「栅格每列多少 px」，结果出现误报：入口页那几块 245px 的卡片里
 * 装的是「成人依恋类型」「两个维度、四个类型」这种短标签，读起来毫不费力。
 * 列宽只是容器尺寸，**真正决定读起来累不累的是每行多少个字**。
 *
 * 判据（中文排版惯例）
 *   25–40 字／行  舒适
 *   41–50 字／行  偏宽，眼睛换行时容易错行
 *   > 50 字／行   过宽
 *   < 12 字／行   过窄，频繁折行、语句被切碎
 *
 * 实现方式：用 Range.getClientRects() 数出每个段落实际占了几行，
 * 再除以字符数，得到真实的每行字数（不受字号、字距、容器宽度影响）。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const BASE = process.env.AM_BASE_URL || 'http://127.0.0.1:5173';
const PORT = 9233;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COMFORT_MIN = 25;
const COMFORT_MAX = 40;
const HARD_MAX = 50;
const HARD_MIN = 12;

const WIDTHS = [360, 390, 430, 640, 768, 834, 1024, 1280, 1440];
const PAGES = [
  { name: '入口页', path: 'index.html' },
  { name: '结果页', path: 'result.html', seed: true },
  { name: '方法说明', path: 'about.html' },
];

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!CHROME) { console.log('未找到浏览器，跳过。'); process.exit(0); }

const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpdir(), 'am-layout-chrome')}`,
  'about:blank'], { stdio: 'ignore' });

let ws = null;
for (let i = 0; i < 40; i++) {
  await sleep(250);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) {
      ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
      break;
    }
  } catch { /* 等 */ }
}
if (!ws) { console.error('无法连接浏览器'); child.kill(); process.exit(0); }

let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id != null && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id);
    if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++seq; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params }));
});

await send('Runtime.enable');
await send('Page.enable');

const SEED = `(async () => {
  const base = new URL('./', document.baseURI).href;
  const { score } = await import(base + 'assets/js/core/scoring.js');
  const { QUESTIONS } = await import(base + 'assets/js/data/questions.js');
  const ans = {}; QUESTIONS.forEach((q, i) => { ans[q.id] = (i % 7) + 1; });
  const res = score(ans);
  const rec = Object.assign({}, res, { answers: ans, resultId: 'r_read', savedAt: new Date().toISOString() });
  const all = {}; all['r_read'] = rec;
  localStorage.setItem('am:results', JSON.stringify(all));
  localStorage.setItem('am:lastResultId', JSON.stringify('r_read'));
  localStorage.setItem('am:entitlements', JSON.stringify({ single: false, duo: false, orders: [] }));
})()`;

/** 量每个可见段落的每行字数 */
const MEASURE = `(() => {
  const out = [];
  const nodes = document.querySelectorAll('p, .card__body, li, .acc__body p, .note > div');
  for (const el of nodes) {
    const txt = (el.textContent || '').replace(/\\s+/g, '');
    if (txt.length < 20) continue;                    // 太短的标签不参与统计
    // 排除非散文内容。每行字数只对「可换行的自然语言」有意义：
    //   · 等宽字体（.mono / .code-plain）＝ 代码、链接、编码
    //   · 整段没有空格的单一词元（长度 > 30）＝ URL、哈希、长串标识
    // 这类内容是一整个不可分割的单元，按容器宽度换行，
    // 用「每行几个字」去衡量它只会产生误报。
    const cls = typeof el.className === 'string' ? el.className : '';
    if (/\\bmono\\b|code-plain/.test(cls)) continue;
    const raw = el.textContent || '';
    if (!/\\s/.test(raw.trim()) && raw.trim().length > 30) continue;
    if (/^https?:\\/\\//.test(raw.trim())) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 80 || r.height < 10) continue;      // 不可见
    // 用 Range 数真实行数。
    // 注意：不能直接取 rects.length —— 一行里若含 <strong> 等行内元素，
    // 同一行会返回多个矩形，行数被算多、每行字数被算少，会得出大量假的「过窄」。
    // 正确做法是按矩形顶边去重，一个顶边算一行。
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter((x) => x.height > 4 && x.width > 4);
    const tops = new Set(rects.map((x) => Math.round(x.top)));
    const lines = tops.size;
    if (lines < 1) continue;
    const perLine = txt.length / lines;
    out.push({ perLine: Number(perLine.toFixed(1)), lines, len: txt.length, sample: txt.slice(0, 14) });
  }
  return JSON.stringify(out);
})()`;

console.log(`\n\x1b[1m排版可读性度量\x1b[0m  ${BASE}`);
console.log(`   舒适区 ${COMFORT_MIN}–${COMFORT_MAX} 字/行 ｜ 警戒 ${HARD_MIN}–${HARD_MAX}\n`);

let over = 0;
let under = 0;
const worst = [];
const narrowSamples = [];

for (const page of PAGES) {
  console.log(`\x1b[1m${page.name}\x1b[0m`);
  for (const w of WIDTHS) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 768 });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await send('Page.navigate', { url: `${BASE}/${page.path}` });
    await sleep(650);
    if (page.seed) {
      await send('Runtime.evaluate', { expression: SEED, awaitPromise: true, returnByValue: true });
      await send('Page.navigate', { url: `${BASE}/result.html?r=r_read` });
      await sleep(650);
    }
    const res = await send('Runtime.evaluate', { expression: MEASURE, returnByValue: true });
    const rows = JSON.parse(res.result.value);
    if (!rows.length) continue;

    const avg = rows.reduce((s, r) => s + r.perLine, 0) / rows.length;
    const max = Math.max(...rows.map((r) => r.perLine));
    const tooWide = rows.filter((r) => r.perLine > HARD_MAX);
    const tooNarrow = rows.filter((r) => r.perLine < HARD_MIN);

    if (tooWide.length) {
      over += tooWide.length;
      worst.push(`【${page.name}】@${w}px ${tooWide[0].perLine} 字/行：「${tooWide[0].sample}…」`);
    }
    if (tooNarrow.length) {
      // 「过窄」只对**长段落**成立。
      // 卡片里的短描述（20 来字）折成两行、每行 10 字，是完全正常的排版；
      // 只有当一个 40 字以上的段落也被压到 12 字/行（即 4 行以上）时，
      // 才说明容器确实太窄、语句被切碎。判据必须带上长度条件，否则会产生大量误报。
      const realNarrow = tooNarrow.filter((r) => r.len >= 40);
      under += realNarrow.length;
      if (realNarrow.length) {
        narrowSamples.push(`【${page.name}】@${w}px ${realNarrow[0].perLine} 字/行 共 ${realNarrow[0].len} 字：「${realNarrow[0].sample}…」`);
      }
    }

    const flag = tooWide.length ? '\x1b[31m过宽\x1b[0m' : tooNarrow.length ? '\x1b[33m过窄\x1b[0m' : '\x1b[32m  ok\x1b[0m';
    console.log(`   ${String(w).padStart(4)}px  平均 ${avg.toFixed(1)}  最长行 ${String(max).padStart(5)} 字  ${flag}`);
  }
}

console.log('\n' + '─'.repeat(64));
if (over === 0 && under === 0) {
  console.log('\x1b[32m\x1b[1m全部通过\x1b[0m  所有宽度下每行字数均落在可读区间');
} else {
  if (over) { console.log(`\x1b[31m过宽段落 ${over} 处\x1b[0m（> ${HARD_MAX} 字/行，换行时容易错行）`); worst.forEach((x) => console.log(`  · ${x}`)); }
  if (under) {
    console.log(`\x1b[33m过窄段落 ${under} 处\x1b[0m（< ${HARD_MIN} 字/行）`);
    narrowSamples.slice(0, 8).forEach((x) => console.log(`  · ${x}`));
  }
}
console.log('');

ws.close();
child.kill();
