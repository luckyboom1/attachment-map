/**
 * 交互回归测试（无头 Chrome + CDP）
 * ---------------------------------------------------------------------------
 * 用法：
 *   npm run dev                          # 另开终端（或用 AM_BASE_URL 指向线上）
 *   npm run check:interaction
 *   AM_BASE_URL=https://xiaoceyixia.cn npm run check:interaction
 *
 * 为什么必须有这个文件
 * ---------------------------------------------------------------------------
 * 本项目的其余检查全是静态的：check-html 查配平、check-dom 查 id 契约、
 * selftest 查算法、check-qr 查编码。它们都看不见一件事——**按钮点了有没有反应**。
 *
 * 2026-09-11 实际发生过：ui.js 的 h() 把 onClick 注册成 'Click'（大写），
 * DOM 事件名区分大小写，于是答题页的 7 个选项「看得见、点不动」，
 * 而上面所有静态检查全部显示通过。上线到自有域名后才被用户发现。
 *
 * 判据（确定性）：
 *   1. 答题页渲染出 7 个选项
 *   2. 点击第 3 档后：题目推进到第 2 题、localStorage 记录 1 条作答
 *   3. h() 创建的主题切换按钮点击后 data-theme 发生变化
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const BASE = process.env.AM_BASE_URL || 'http://127.0.0.1:5173';
const PORT = 9229;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

if (!CHROME) {
  console.log('未找到 Chrome / Edge，跳过交互测试。');
  process.exit(0);
}

let passed = 0;
let failed = 0;
const problems = [];
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; problems.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ' — ' + detail : ''}`); }
};

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
  } catch { /* 等浏览器起来 */ }
}

if (!ws) {
  console.error('无法连接无头浏览器，跳过交互测试。');
  child.kill();
  process.exit(0);
}

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

const go = async (path) => {
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: `${BASE}/${path}` });
  // 等待加载完成 + 站点框架挂载。线上域名要走 307 规范化与模块加载，
  // 固定 sleep 会在慢网络下量到半初始化的页面，得出假失败。
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const r = await send('Runtime.evaluate', { expression: `JSON.stringify({
      ready: document.readyState,
      mounted: !!document.querySelector('.site-header') && !!document.getElementById('main'),
    })`, returnByValue: true });
    const s = JSON.parse(r.result.value);
    if (s.ready === 'complete' && s.mounted) break;
    await sleep(300);
  }
  await sleep(400);
};
const evalJson = async (expression) => {
  // 调用处传入的是「已执行的 IIFE」，这里只负责序列化
  const { result } = await send('Runtime.evaluate', { expression: `JSON.stringify((${expression}))`, returnByValue: true });
  return JSON.parse(result.value);
};

console.log(`\n\x1b[1m交互回归测试\x1b[0m  ${BASE}\n`);

/* ---- 1. 答题页：渲染 + 点击推进 + 本地留档 ---- */
await go('quiz.html');
{
  const s = await evalJson(`(() => ({
    btns: document.querySelectorAll('.likert__btn').length,
    q: (document.getElementById('q-text')?.textContent || '').slice(0, 12),
    counter: document.getElementById('counter')?.textContent || '',
  }))()`);
  ok('答题页渲染出 7 个选项', s.btns === 7, `实际 ${s.btns} 个`);
  ok('题干已渲染', s.q.length > 0, `「${s.q}」`);
}

const c1 = await evalJson(`(() => {
  const b = document.querySelectorAll('.likert__btn')[2];
  if (!b) return { err: 'no-button' };
  b.click();
  return { ok: true };
})()`);
ok('点击第 3 档被接受', !c1.err, c1.err || '');
await sleep(400);

const c2 = await evalJson(`(() => ({
  counter: document.getElementById('counter')?.textContent || '',
  saved: Object.keys(JSON.parse(localStorage.getItem('am:answers') || '{}')).length,
}))()`);
ok('点击后题目推进到第 2 题', /2\s*\/\s*36/.test(c2.counter), `计数器仍是「${c2.counter}」`);
ok('作答已写入本地（localStorage）', c2.saved === 1, `记录 ${c2.saved} 条`);

/* ---- 2. 主题切换按钮（h() 创建的另一类交互）---- */
await go('index.html');
{
  const before = await evalJson(`(() => document.documentElement.dataset.theme || 'light')()`);
  const clicked = await evalJson(`(() => {
    const b = document.querySelector('.site-header button');
    if (!b) return { err: 'no-button' };
    b.click();
    return { ok: true };
  })()`);
  ok('主题切换按钮存在且可点击', !clicked.err, clicked.err || '');
  const after = await evalJson(`(() => document.documentElement.dataset.theme || 'light')()`);
  ok('点击后主题发生切换', before !== after, `${before} → ${after}`);
}

console.log('\n' + '─'.repeat(64));
if (failed === 0) {
  console.log(`\x1b[32m\x1b[1m全部通过\x1b[0m  ${passed} 项交互检查`);
} else {
  console.log(`\x1b[31m\x1b[1m${failed} 项失败\x1b[0m  / 通过 ${passed} 项`);
  problems.forEach((p) => console.log(`  · ${p}`));
  process.exitCode = 1;
}
console.log('');

ws.close();
child.kill();
