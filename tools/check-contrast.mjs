/**
 * 对比度校验（无头 Chrome + CDP）
 * ---------------------------------------------------------------------------
 * 用法：
 *   npm run dev
 *   npm run check:contrast
 *
 * 为什么必须程序化校验
 * ---------------------------------------------------------------------------
 * 「看起来还行」在颜色上完全不可靠：明度差一点点，对比度可能从 4.5 掉到 3.0。
 * 本次修掉的一个真实缺陷就是靠这个发现的——类型卡底色是固定强调色（不随主题反转），
 * 而文字原本用 var(--text)，暗色主题下 --text 变成近白色，
 * 于是得到「浅底浅字」。肉眼扫一眼截图很可能漏掉。
 *
 * 判据：WCAG 2.1
 *   正文（< 18.66px 常规 / < 24px 粗体）≥ 4.5:1
 *   大字号（≥ 24px 或 ≥ 18.66px 粗体）≥ 3:1
 * 这里统一按 4.5:1 要求，从严。
 *
 * 实现：取元素自身的 color 与「实际可见背景色」。
 * 背景色需要向上遍历祖先，因为很多元素自身是 transparent。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const BASE = process.env.AM_BASE_URL || 'http://127.0.0.1:5173';
const PORT = 9234;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从严阈值：正文一律按 4.5:1 要求 */
const MIN_RATIO = 4.5;

const PAGES = [
  { name: '入口页', path: 'index.html' },
  { name: '结果页', path: 'result.html', seed: true },
  { name: '答题页', path: 'quiz.html' },
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

/** 在页面里跑：取每个可见文本节点的前景/背景，算 WCAG 对比度 */
const AUDIT = `(() => {
  const parse = (c) => {
    const m = String(c).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const L1 = lum(a), L2 = lum(b);
    return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  // 向上找第一个不透明背景；若全是透明则用页面底色
  const bgOf = (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0.95) return c;
      node = node.parentElement;
    }
    return parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
  };

  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  let node;
  while ((node = walk.nextNode())) {
    const txt = (node.textContent || '').trim();
    if (txt.length < 2) continue;
    const el = node.parentElement;
    if (!el || seen.has(el)) continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.1) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) continue;

    const fg = parse(cs.color);
    if (!fg) continue;
    const bg = bgOf(el);
    const eff = fg.a < 1 ? over(fg, bg) : fg;
    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : ${MIN_RATIO};
    const r = ratio(eff, bg);
    if (r < need) {
      out.push({
        sel: el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).join('.') : ''),
        text: txt.slice(0, 18),
        ratio: Number(r.toFixed(2)),
        need,
        size, weight,
        fg: cs.color, bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')',
      });
    }
  }
  return JSON.stringify(out);
})()`;

const SEED = `(async () => {
  const base = new URL('./', document.baseURI).href;
  const { score } = await import(base + 'assets/js/core/scoring.js');
  const { QUESTIONS } = await import(base + 'assets/js/data/questions.js');
  const ans = {}; QUESTIONS.forEach((q, i) => { ans[q.id] = (i % 7) + 1; });
  const res = score(ans);
  const rec = Object.assign({}, res, { answers: ans, resultId: 'r_ct', savedAt: new Date().toISOString() });
  const all = {}; all['r_ct'] = rec;
  localStorage.setItem('am:results', JSON.stringify(all));
  localStorage.setItem('am:lastResultId', JSON.stringify('r_ct'));
  localStorage.setItem('am:entitlements', JSON.stringify({ single: true, duo: true, orders: [] }));
})()`;

console.log(`\n\x1b[1m对比度校验\x1b[0m  ${BASE}`);
console.log(`   阈值：正文 ≥ ${MIN_RATIO}:1 ｜ 大字号 ≥ 3:1（WCAG 2.1）\n`);

let total = 0;
const failures = [];

for (const theme of ['light', 'dark']) {
  console.log(`\x1b[1m${theme === 'light' ? '浅色主题' : '深色主题'}\x1b[0m`);
  for (const page of PAGES) {
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
    await send('Page.navigate', { url: `${BASE}/index.html` });
    await sleep(500);
    await send('Runtime.evaluate', {
      expression: `try{localStorage.setItem('am:theme', JSON.stringify('${theme}'))}catch(e){}`,
    });
    if (page.seed) {
      await send('Runtime.evaluate', { expression: SEED, awaitPromise: true, returnByValue: true });
    }
    await send('Page.navigate', { url: `${BASE}/${page.path}${page.seed ? '?r=r_ct' : ''}` });
    await sleep(800);

    const res = await send('Runtime.evaluate', { expression: AUDIT, returnByValue: true });
    const bad = JSON.parse(res.result.value);
    total += bad.length;
    if (bad.length) failures.push(...bad.map((b) => ({ ...b, page: page.name, theme })));
    const tag = bad.length ? `\x1b[31m${bad.length} 处不达标\x1b[0m` : '\x1b[32m全部达标\x1b[0m';
    console.log(`   ${page.name.padEnd(6)} ${tag}`);
  }
}

console.log('\n' + '─'.repeat(64));
if (total === 0) {
  console.log('\x1b[32m\x1b[1m全部通过\x1b[0m  两种主题下所有文本对比度达标');
} else {
  console.log(`\x1b[31m\x1b[1m${total} 处对比度不足\x1b[0m`);
  failures.slice(0, 14).forEach((f) => {
    console.log(`  · [${f.theme}/${f.page}] ${f.sel}  ${f.ratio}:1（需 ${f.need}）  「${f.text}」`);
    console.log(`      前景 ${f.fg}  背景 ${f.bg}  ${f.size}px/${f.weight}`);
  });
  if (failures.length > 14) console.log(`  …… 另有 ${failures.length - 14} 处`);
}
console.log('');

ws.close();
child.kill();
