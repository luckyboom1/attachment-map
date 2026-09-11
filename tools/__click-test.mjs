import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const TARGET = process.argv[2] || 'https://xiaoceyixia.cn/quiz.html';
const PORT = 9227;
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
const listeners = new Map();
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
  const list = listeners.get(method) || []; list.push(fn); listeners.set(method, list);
};

await send('Runtime.enable');
await send('Page.enable');

const thrown = [];
on('Runtime.exceptionThrown', (p) => thrown.push(p.exceptionDetails?.text + ' ' + (p.exceptionDetails?.exception?.description || '').slice(0, 200)));

const loaded = onceNav();
function onceNav() {
  return new Promise((res) => {
    on('Page.loadEventFired', () => res());
  });
}
await send('Page.navigate', { url: TARGET });
await loaded;
await sleep(1500);

// 模拟真实点击：先点第 3 个选项，确认题目推进到第 2 题；再点键盘 1，确认继续推进
const r1 = await send('Runtime.evaluate', { expression: `(() => JSON.stringify({
  before: { q: document.getElementById('q-text').textContent.slice(0, 18), counter: document.getElementById('counter').textContent, btns: document.querySelectorAll('.likert__btn').length },
}))()`, returnByValue: true });
console.log('点击前：', r1.result.value);

const click1 = await send('Runtime.evaluate', { expression: `(() => {
  const b = document.querySelectorAll('.likert__btn')[2];
  if (!b) return 'NO_BUTTON';
  b.click();
  return 'CLICKED value=' + b.dataset.value;
})()`, returnByValue: true });
console.log('点击第 3 档：', click1.result.value);
await sleep(500);

const r2 = await send('Runtime.evaluate', { expression: `(() => JSON.stringify({
  after: { q: document.getElementById('q-text').textContent.slice(0, 18), counter: document.getElementById('counter').textContent },
  saved: localStorage.getItem('am:answers') ? Object.keys(JSON.parse(localStorage.getItem('am:answers'))).length : 0,
}))()`, returnByValue: true });
console.log('点击后：', r2.result.value);

const click2 = await send('Runtime.evaluate', { expression: `(() => {
  const b = document.querySelectorAll('.likert__btn')[6];
  b.click();
  return 'CLICKED value=' + b.dataset.value;
})()`, returnByValue: true });
console.log('点击第 7 档：', click2.result.value);
await sleep(500);

const r3 = await send('Runtime.evaluate', { expression: `(() => JSON.stringify({
  counter: document.getElementById('counter').textContent,
  savedCount: Object.keys(JSON.parse(localStorage.getItem('am:answers') || '{}')).length,
}))()`, returnByValue: true });
console.log('再次点击后：', r3.result.value);

console.log('\n=== 期间异常 ===');
if (!thrown.length) console.log('（无）');
thrown.forEach((t) => console.log('  ' + t));

ws.close();
child.kill();
