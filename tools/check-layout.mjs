/**
 * 布局度量检查（Node + 无头 Chrome，零 npm 依赖）
 * ---------------------------------------------------------------------------
 * 用法：
 *   npm run dev            # 先起本地服务（另开一个终端）
 *   npm run check:layout   # 在常见手机宽度上逐页量横向溢出
 *
 * 为什么要这个文件
 * ---------------------------------------------------------------------------
 * 这是一个手机优先的产品（主要入口是微信内打开），但项目里所有静态检查都是
 * 「读源码」级别的：check-html 查标签配平、check-dom 查 id 契约、selftest 查算法。
 * 它们都看不见一件事——**页面在 390px 宽的手机上会不会横向溢出**。
 *
 * 而这类错误在本项目里是静默的：assets/css/app.css 里有 `body { overflow-x: hidden }`，
 * 所以溢出不会出现滚动条，只会把右侧内容直接裁掉。用户看到的是「第 7 档不见了」，
 * 而开发者本地用宽屏浏览器完全看不出来。
 *
 * 为什么用 CDP 而不是 `chrome --screenshot --window-size`
 * ---------------------------------------------------------------------------
 * --window-size 只设窗口尺寸，不保证布局视口与媒体查询按该宽度生效，
 * 实测截图会呈现「按某个更宽的视口排版、再按窗口裁切」的结果，
 * 据此判断溢出会得出**假阳性**。所以这里用 DevTools Protocol 显式下发
 * Emulation.setDeviceMetricsOverride，拿到真实的 clientWidth / scrollWidth 对比。
 *
 * 判据（确定性，不含主观判断）：
 *   document.documentElement.scrollWidth - clientWidth > 1  → 判为横向溢出
 * 并输出越界元素清单，直接指明是谁把页面撑宽的。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const BASE = process.env.AM_BASE_URL || 'http://127.0.0.1:5173';
const PORT = 9222;

/** 常见手机 CSS 宽度。360 与 390 覆盖了国内安卓与 iPhone 的主流机型。 */
const WIDTHS = [320, 360, 375, 390, 414, 430];

/** 需要检查的页面。duo 页带上一个合法邀请码，才能走到真实的等待态。 */
const PAGES = [
  { name: '入口页', path: 'index.html' },
  { name: '答题页', path: 'quiz.html' },
  { name: '结果页', path: 'result.html', seed: 'result' },
  { name: '双人合盘', path: 'duo.html?a=BTlwKcuBTlwKcuBTlwA' },
  { name: '深度报告', path: 'report.html?r=r_layout', seed: 'entitled' },
  { name: '方法说明', path: 'about.html' },
];

/**
 * 播种测试状态。
 * 为什么必须播种：result / report 两个页面在无存档时会渲染「找不到结果」空态，
 * 那种状态下量出的布局毫无意义（正文只有 47 字，怎么量都不溢出）。
 * 这里直接调用应用自己的计分模块造一份真实结果，避免手写假数据与真实结构漂移。
 */
const SEED = (entitled) => `(async () => {
  const { score } = await import('/assets/js/core/scoring.js');
  const { QUESTIONS } = await import('/assets/js/data/questions.js');
  const ans = {};
  QUESTIONS.forEach((q, i) => { ans[q.id] = (i % 7) + 1; });
  const res = score(ans);
  const id = 'r_layout';
  const rec = Object.assign({}, res, { answers: ans, resultId: id, savedAt: new Date().toISOString() });
  const results = {}; results[id] = rec;
  localStorage.setItem('am:results', JSON.stringify(results));
  localStorage.setItem('am:lastResultId', JSON.stringify(id));
  if (${entitled}) {
    localStorage.setItem('am:entitlements', JSON.stringify({ single: true, duo: true, orders: [] }));
  } else {
    localStorage.setItem('am:entitlements', JSON.stringify({ single: false, duo: false, orders: [] }));
  }
  return JSON.stringify({ type: res.type, A: res.A, V: res.V });
})()`;

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

/* ------------------------------ 极简 CDP 客户端 ------------------------------ */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      } else if (msg.method) {
        const waiters = this.events.get(msg.method) || [];
        this.events.delete(msg.method);
        waiters.forEach((fn) => fn(msg.params));
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, reject) => {
      this.pending.set(id, { resolve: res, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method, timeoutMs = 15000) {
    return new Promise((res, reject) => {
      const list = this.events.get(method) || [];
      list.push(res);
      this.events.set(method, list);
      setTimeout(() => reject(new Error(`等待 ${method} 超时`)), timeoutMs);
    });
  }
}

/* ------------------------------ 度量表达式 ------------------------------ */

const MEASURE = `(() => {
  const de = document.documentElement;
  const cw = de.clientWidth;
  const out = {
    innerWidth: window.innerWidth,
    clientWidth: cw,
    scrollWidth: de.scrollWidth,
    overflow: de.scrollWidth - cw,
    mainText: (document.getElementById('main') || document.body).innerText.trim().length,
    offenders: [],
  };
  if (out.overflow > 1) {
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > cw + 1) {
        const cls = (typeof el.className === 'string' && el.className)
          ? '.' + el.className.trim().split(/\\s+/).join('.') : '';
        out.offenders.push(
          el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls +
          ' [right=' + Math.round(r.right) + ' w=' + Math.round(r.width) + ']'
        );
        if (out.offenders.length >= 6) break;
      }
    }
  }
  return JSON.stringify(out);
})()`;

/** 页面至少要有这么多可见文字，否则视为「量了一个空白页」 */
const MIN_TEXT = 120;

/* ------------------------------ 主流程 ------------------------------ */

const browser = findBrowser();
if (!browser) {
  console.log('未找到 Chrome / Edge，跳过布局检查。');
  process.exit(0);
}

try {
  const probe = await fetch(`${BASE}/index.html`, { method: 'HEAD' });
  if (!probe.ok) throw new Error(String(probe.status));
} catch {
  console.error(`本地服务不可达：${BASE}\n请先在另一个终端执行：npm run dev`);
  process.exit(1);
}

// 浏览器用户配置放系统临时目录：无头 Chrome 会往里写几百 MB 缓存，
// 放在项目里会污染仓库，也会被 dev-server 当成静态资源对外暴露。
const userDataDir = join(tmpdir(), 'am-layout-chrome');
mkdirSync(userDataDir, { recursive: true });

const child = spawn(browser, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDataDir}`,
  'about:blank',
], { stdio: 'ignore' });

let cdp = null;
let targets = null;
for (let i = 0; i < 40; i++) {
  await sleep(250);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    targets = await res.json();
    const page = targets.find((t) => t.type === 'page');
    if (page) {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res2, rej) => {
        ws.addEventListener('open', res2);
        ws.addEventListener('error', rej);
      });
      cdp = new Cdp(ws);
      break;
    }
  } catch { /* 浏览器还没起来，继续等 */ }
}

if (!cdp) {
  child.kill();
  console.error('无法连接无头浏览器，跳过布局检查。');
  process.exit(0);
}

await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

const wantShots = process.argv.includes('--shots');
const shotDir = join(ROOT, '.shots');

console.log(`\n\x1b[1m布局度量检查\x1b[0m  ${BASE}\n   视口宽度：${WIDTHS.join(' / ')} px\n`);

let fail = 0;
const problems = [];

/** 计量是否真的成立。少了这道自检，量到空白页或视口没生效都会「全绿」。 */
let gaugeOk = true;
let gaugeNote = '';

for (const page of PAGES) {
  const rows = [];

  // 播种状态（同源先落到入口页，再写 localStorage，然后才去量目标页）
  if (page.seed) {
    const seeded = cdp.once('Page.loadEventFired').catch(() => {});
    await cdp.send('Page.navigate', { url: `${BASE}/index.html` });
    await seeded;
    const seedRes = await cdp.send('Runtime.evaluate', {
      expression: SEED(page.seed === 'entitled'), awaitPromise: true, returnByValue: true,
    });
    if (seedRes.exceptionDetails) {
      console.error(`播种失败：${JSON.stringify(seedRes.exceptionDetails).slice(0, 200)}`);
      process.exitCode = 1;
    }
  }

  for (const width of WIDTHS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width, height: 800, deviceScaleFactor: 1, mobile: true,
    });
    const loaded = cdp.once('Page.loadEventFired').catch(() => {});
    await cdp.send('Page.navigate', { url: `${BASE}/${page.path}` });
    await loaded;
    await sleep(320);

    const { result } = await cdp.send('Runtime.evaluate', {
      expression: MEASURE, returnByValue: true,
    });
    const m = JSON.parse(result.value);
    rows.push({ width, ...m });

    // 防伪 1：视口必须真的等于请求宽度，否则「无溢出」是假的
    if (Math.abs(m.clientWidth - width) > 1) {
      gaugeOk = false;
      gaugeNote += `${page.name}@${width}:视口实为${m.clientWidth} `;
    }
    // 防伪 2：页面必须真的有内容，否则量的是空白
    if (m.mainText < MIN_TEXT) {
      gaugeOk = false;
      gaugeNote += `${page.name}@${width}:正文仅${m.mainText}字 `;
    }

    if (m.overflow > 1) {
      fail += 1;
      problems.push(`${page.name} @${width}px 横向溢出 ${m.overflow}px → ${m.offenders.join(' ; ')}`);
    }
  }

  const bad = rows.filter((r) => r.overflow > 1);
  const tag = bad.length ? '\x1b[31m✗\x1b[0m' : '\x1b[32m✓\x1b[0m';
  const detail = rows.map((r) => `${r.width}${r.overflow > 1 ? '!' : ''}(${r.mainText})`).join(' ');
  console.log(`${tag} ${page.name.padEnd(6)} 宽度(正文字数) ${detail}`);
  if (bad.length) {
    console.log(`    \x1b[31m${bad[0].offenders.slice(0, 3).join(' ; ')}\x1b[0m`);
  }

  if (wantShots) {
    mkdirSync(shotDir, { recursive: true });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 900, deviceScaleFactor: 1, mobile: true,
    });
    const loaded = cdp.once('Page.loadEventFired').catch(() => {});
    await cdp.send('Page.navigate', { url: `${BASE}/${page.path}` });
    await loaded;
    await sleep(320);
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
    });
    const file = join(shotDir, `${page.path.replace(/[?=&.]/g, '_')}.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`    快照 ${file}`);
  }
}

console.log('\n' + '─'.repeat(64));
if (!gaugeOk) {
  fail += 1;
  console.log('\x1b[31m\x1b[1m度量本身不成立\x1b[0m —— 结果不可信，不是页面通过');
  console.log(`  ${gaugeNote}`);
} else if (fail === 0) {
  console.log(`\x1b[32m\x1b[1m全部通过\x1b[0m  所有页面在 ${WIDTHS.join('–')} px 下均无横向溢出`);
  console.log(`  自检：视口宽度均已生效，每页正文均 ≥ ${MIN_TEXT} 字`);
} else {
  console.log(`\x1b[31m\x1b[1m${fail} 处横向溢出\x1b[0m`);
  problems.forEach((p) => console.log(`  · ${p}`));
  process.exitCode = 1;
}
console.log('');

cdp.ws.close();
child.kill();
