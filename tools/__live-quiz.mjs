import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const TARGET = process.argv[2] || 'https://xiaoceyixia.cn/quiz.html';
const PORT = 9226;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(ROOT, '.chrome-layout')}`,
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

let id = 0;
const pending = new Map();
const listeners = new Map();           // method -> 回调数组（可多个并存）

ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id != null && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id);
    if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
  } else if (m.method) {
    const list = listeners.get(m.method);
    if (list) list.forEach((fn) => fn(m.params));
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params }));
});
const on = (method, fn) => {
  const list = listeners.get(method) || [];
  list.push(fn); listeners.set(method, list);
};
const once = (method, timeoutMs = 20000) => new Promise((res, rej) => {
  const list = listeners.get(method) || [];
  list.push((p) => { res(p); });
  listeners.set(method, list);
  setTimeout(() => rej(new Error(`等待 ${method} 超时`)), timeoutMs);
});
const collect = (method, ms) => new Promise((res) => {
  const list = listeners.get(method) || [];
  const got = [];
  list.push((p) => got.push(p));
  listeners.set(method, list);
  setTimeout(() => res(got), ms);
});

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Network.enable');

const errs = collect('Runtime.exceptionThrown', 5000);
const cons = collect('Runtime.consoleAPICalled', 5000);
const fails = collect('Network.loadingFailed', 5000);
const resps = collect('Network.responseReceived', 5000);

await send('Page.navigate', { url: TARGET });
await sleep(5000);

const probe = await send('Runtime.evaluate', { expression: `(() => JSON.stringify({
  url: location.href,
  title: document.title,
  qText: document.getElementById('q-text') ? document.getElementById('q-text').textContent.slice(0, 30) : null,
  likertButtons: document.querySelectorAll('.likert__btn').length,
  anchors: [...document.querySelectorAll('.likert__anchors span')].map(s => s.textContent),
  cushion: document.getElementById('cushion') ? document.getElementById('cushion').textContent.slice(0, 20) : null,
  moduleScripts: [...document.scripts].filter(s => s.type === 'module').map(s => s.src),
  mainExists: !!document.getElementById('main'),
}))()`, returnByValue: true });
console.log('=== 页面 DOM 状态 ===');
console.log(probe.result.value);

console.log('\n=== 未捕获异常 ===');
const errList = await errs;
if (!errList.length) console.log('（无）');
for (const e of errList) {
  const d = e.exceptionDetails || {};
  console.log(`  ${d.text || '异常'}`);
  if (d.exception?.description) console.log(`    ${String(d.exception.description).slice(0, 400)}`);
}

console.log('\n=== 控制台输出 ===');
const consList = await cons;
if (!consList.length) console.log('（无）');
for (const c of consList) {
  const text = (c.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
  console.log(`  [${c.type}] ${String(text).slice(0, 300)}`);
}

console.log('\n=== 加载失败的请求 ===');
const failList = await fails;
if (!failList.length) console.log('（无）');
for (const f of failList) console.log(`  ${f.errorText} ${f.type}`);

console.log('\n=== 4xx/5xx 响应 ===');
const respList = await resps;
let any = false;
for (const r of respList) {
  if (r.response && r.response.status >= 400) {
    any = true;
    console.log(`  ${r.response.status} ${r.response.mimeType} ${r.response.url}`);
  }
}
if (!any) console.log('（无）');

ws.close();
child.kill();
