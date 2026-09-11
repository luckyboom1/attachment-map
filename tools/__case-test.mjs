import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const PORT = 9228;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(ROOT, '.chrome-layout')}`, 'about:blank'],
  { stdio: 'ignore' });

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
await send('Page.navigate', { url: 'https://xiaoceyixia.cn/quiz.html' });
await sleep(2500);

const probe = await send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
  const out = {};
  let capFired = false, lowFired = false;
  const d = document.createElement('div');
  d.addEventListener('Click', () => { capFired = true; });
  d.addEventListener('click', () => { lowFired = true; });
  d.dispatchEvent(new MouseEvent('click', { bubbles: false }));
  out.capitalListenerFiresOnLowercaseClick = capFired;
  out.lowercaseListenerFires = lowFired;

  const btn = document.querySelectorAll('.likert__btn')[0];
  out.btnTag = btn ? btn.tagName : null;
  out.btnHasAriaPressed = btn ? btn.getAttribute('aria-pressed') : null;
  return JSON.stringify(out);
})()` });
console.log(probe.result.value);

ws.close();
child.kill();
