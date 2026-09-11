/**
 * 线上安全策略有效性验证（无头 Chrome + CDP）
 * ---------------------------------------------------------------------------
 * 用法：
 *   node tools/security-live-verify.mjs
 *   AM_BASE_URL=https://xiaoceyixia.cn node tools/security-live-verify.mjs
 *
 * 它验证三件事，每件都必须打线上——本地 dev-server 不下发 _headers，
 * 用 localhost 的结果代替线上验证会得出完全错误的结论。
 *
 *   1. 内联脚本未被 CSP 拦截
 *      （哈希写错时浏览器会静默拦截，页面「看起来正常」但主题引导失效）
 *   2. 页面加载过程中没有 CSP 违规
 *   3. 答案不再随请求离开浏览器（Referer / 请求行 / 上报体）
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const BASE = process.env.AM_BASE_URL || 'https://attachment-map.pages.dev';
const PORT = 9253;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DUO_A = 'BTlwKcuBTlwKcuBTlwA';
const DUO_B = 'TUVWXYZ0123456789ABC';

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!CHROME) { console.log('未找到浏览器，跳过。'); process.exit(0); }

const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpdir(), 'am-seclive')}`,
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
const listeners = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id != null && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id);
    if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
  } else if (m.method) {
    (listeners.get(m.method) || []).forEach((f) => f(m.params));
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++seq; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params }));
});
const on = (method, fn) => {
  const l = listeners.get(method) || []; l.push(fn); listeners.set(method, l);
};

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Log.enable');

const evalJson = async (expr) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression: `Promise.resolve(${expr}).then((v) => JSON.stringify(v))`,
    returnByValue: true, awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails).slice(0, 300));
  return JSON.parse(result.value);
};

let pass = 0, fail = 0;
const problems = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; problems.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ' — ' + detail : ''}`); }
};

console.log(`\n\x1b[1m线上安全策略有效性验证\x1b[0m  ${BASE}\n`);

/* ---------- 1. 内联脚本是否被 CSP 放行 ---------- */
// 手法：先把主题设为 dark，再刷新。若内联脚本被拦，data-theme 不会变成 dark。
console.log('1. CSP 是否放行内联脚本');
await send('Page.navigate', { url: `${BASE}/index.html` });
await sleep(1500);
await send('Runtime.evaluate', {
  expression: `try { localStorage.setItem('am:theme', JSON.stringify('dark')); } catch (e) {}`,
});

const cspViolations = [];
on('Log.entryAdded', (p) => {
  const t = p.entry?.text || '';
  if (/Content Security Policy|Refused to (execute|load|apply)/i.test(t)) cspViolations.push(t);
});

await send('Page.navigate', { url: `${BASE}/index.html` });
await sleep(2000);

const themeState = await evalJson(`(() => ({
  theme: document.documentElement.dataset.theme || null,
  stored: (() => { try { return JSON.parse(localStorage.getItem('am:theme')); } catch { return null; } })(),
}))()`);
ok('内联主题脚本被执行（data-theme 跟随本地存储）',
  themeState.theme === themeState.stored,
  `HTML 上是 ${themeState.theme}，本地存储是 ${themeState.stored}；不一致说明内联脚本被 CSP 拦了`);

/* ---------- 2. 页面功能未受 CSP 影响 ---------- */
console.log('\n2. CSP 未破坏页面功能');
const appState = await evalJson(`(() => ({
  headerMounted: !!document.querySelector('.site-header'),
  navLinks: document.querySelectorAll('.site-nav a').length,
  themeBtn: !!document.querySelector('.site-header button'),
  footerMounted: !!document.querySelector('.site-footer'),
  mainText: (document.getElementById('main')?.textContent || '').trim().length,
}))()`);
ok('站点框架正常挂载', appState.headerMounted && appState.footerMounted);
ok('导航与主题按钮存在', appState.navLinks >= 2 && appState.themeBtn,
  `导航 ${appState.navLinks} 项，主题按钮 ${appState.themeBtn}`);
ok('正文已渲染', appState.mainText > 300, `正文 ${appState.mainText} 字`);

await send('Page.navigate', { url: `${BASE}/quiz.html` });
await sleep(1800);
const quizState = await evalJson(`(() => ({
  btns: document.querySelectorAll('.likert__btn').length,
  q: (document.getElementById('q-text')?.textContent || '').length,
}))()`);
ok('答题页模块脚本正常执行', quizState.btns === 7 && quizState.q > 5,
  `选项 ${quizState.btns} 个，题干 ${quizState.q} 字`);

/* ---------- 3. 答案是否还会离开浏览器 ---------- */
console.log('\n3. 答案是否随请求离开浏览器');
const reqs = [];
on('Network.requestWillBeSent', (p) => {
  reqs.push({
    url: p.request.url,
    method: p.request.method,
    postData: p.request.postData || null,
    referer: p.request.headers?.Referer || p.request.headers?.referer || null,
    headers: p.request.headers || {},
  });
});
reqs.length = 0;

await send('Page.navigate', { url: `${BASE}/duo.html#a=${DUO_A}&b=${DUO_B}` });
await sleep(9000);

const hit = (v) => v != null && (String(v).includes(DUO_A) || String(v).includes(DUO_B));
const leaks = [];
for (const r of reqs) {
  const ch = [];
  if (hit(r.url)) ch.push('请求 URL');
  if (hit(r.postData)) ch.push('请求体');
  if (hit(r.referer)) ch.push('Referer 请求头');
  for (const [k, v] of Object.entries(r.headers)) {
    if (/^referer$/i.test(k)) continue;
    if (hit(v)) ch.push(`请求头 ${k}`);
  }
  if (ch.length) leaks.push(`${r.method} ${r.url.slice(0, 60)} → ${ch.join(' + ')}`);
}
ok('没有任何请求携带答案编码', leaks.length === 0,
  leaks.length ? leaks.slice(0, 3).join(' ｜ ') : '');

const duoRendered = await evalJson(`(() => {
  const t = (document.getElementById('main')?.textContent || '').trim();
  return { len: t.length, broken: /链接不完整|无法读取/.test(t) };
})()`);
ok('合盘页正常渲染（片段格式可用）', !duoRendered.broken && duoRendered.len > 100,
  `正文 ${duoRendered.len} 字`);

/* ---------- 4. CSP 违规汇总 ---------- */
console.log('\n4. CSP 违规检查');
ok('未出现 CSP 违规日志', cspViolations.length === 0,
  cspViolations.slice(0, 2).join(' ｜ '));

console.log('\n' + '─'.repeat(64));
console.log(fail === 0
  ? `\x1b[32m\x1b[1m全部通过\x1b[0m  ${pass} 项`
  : `\x1b[31m\x1b[1m${fail} 项未通过\x1b[0m  / 通过 ${pass} 项`);
problems.forEach((p) => console.log(`  · ${p}`));
console.log('');

ws.close();
child.kill();
