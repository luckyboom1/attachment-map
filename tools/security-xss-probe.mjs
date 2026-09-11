/**
 * XSS 攻击面验证（无头 Chrome + CDP）
 * ---------------------------------------------------------------------------
 * 用法：
 *   npm run dev
 *   node tools/security-xss-probe.mjs
 *
 * 目的：验证「URL 参数 / 外部数据是否会经 innerHTML 变成可执行脚本」。
 * 所有用例都是对**本机 dev-server** 发起的，不触碰线上站点。
 *
 * 判据：注入一个标记元素（不弹窗、不破坏页面），检查它是否真的出现在 DOM 里。
 * 用标记而不是 alert()，是为了在无头环境里也能确定性判定，且可重复执行。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const BASE = process.env.AM_BASE_URL || 'http://127.0.0.1:5173';
const PORT = 9250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!CHROME) { console.log('未找到浏览器，跳过。'); process.exit(0); }

/**
 * 用例设计。
 * payload 会以**原样**拼进 URL（不预先编码）——因为攻击者控制的正是原始 URL。
 * 浏览器拿到 URL 后的行为（是否规范化 location.search）正是要验证的对象。
 */
const PAYLOAD = '"><img src=x onerror=window.__pwn=1>';
const PAYLOAD_ATTR = '"><svg onload=window.__pwn=2>';

const CASES = [
  {
    name: 'report 页 duo 模式：location.search 拼进 href 属性',
    url: `${BASE}/report.html?mode=duo&r=x&z=${PAYLOAD}`,
    wait: 1600,
  },
  {
    name: 'report 页 duo 模式：另一种标签载荷',
    url: `${BASE}/report.html?mode=duo&r=x&z=${PAYLOAD_ATTR}`,
    wait: 1600,
  },
  {
    name: 'result 页：location.host 拼进文本',
    url: `${BASE}/result.html?r=${PAYLOAD}`,
    wait: 1200,
  },
  {
    name: 'report 页：结果编号拼接',
    url: `${BASE}/report.html?r=${PAYLOAD}`,
    wait: 1200,
  },
  {
    name: 'duo 页：a/b 参数（应为严格数值校验）',
    url: `${BASE}/duo.html?a=${PAYLOAD}&b=${PAYLOAD}`,
    wait: 1200,
  },
  {
    name: 'quiz 页：invite 参数',
    url: `${BASE}/quiz.html?a=${PAYLOAD}`,
    wait: 1200,
  },
];

const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpdir(), 'am-sec')}`,
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

console.log(`\n\x1b[1mXSS 攻击面验证\x1b[0m  ${BASE}`);
console.log(`   载荷：${PAYLOAD}\n`);

let vulnerable = 0;

for (const c of CASES) {
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(150);
  await send('Runtime.evaluate', { expression: 'window.__pwn = 0;' });
  await send('Page.navigate', { url: c.url });
  await sleep(c.wait);

  const probe = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `JSON.stringify({
      pwn: window.__pwn || 0,
      injectedImg: document.querySelectorAll('img[src="x"]').length,
      injectedSvg: document.querySelectorAll('svg[onload]').length,
      rawSearchLen: location.search.length,
      searchHead: location.search.slice(0, 60),
      brokenHref: (() => {
        const a = [...document.querySelectorAll('a')].find((x) => (x.getAttribute('href') || '').includes('duo.html'));
        return a ? a.getAttribute('href').slice(0, 80) : null;
      })(),
    })`,
  });
  const r = JSON.parse(probe.result.value);
  const hit = r.pwn !== 0 || r.injectedImg > 0 || r.injectedSvg > 0;
  if (hit) vulnerable++;

  console.log(`${hit ? '\x1b[31m✗ 存在注入\x1b[0m' : '\x1b[32m✓ 未检出注入\x1b[0m'}  ${c.name}`);
  console.log(`    执行标记=${r.pwn}  注入img=${r.injectedImg}  注入svg=${r.injectedSvg}`);
  console.log(`    location.search 是否保留引号：${r.searchHead}`);
  if (r.brokenHref) console.log(`    生成的 href：${r.brokenHref}`);
  console.log('');
}

console.log('─'.repeat(64));
console.log(vulnerable === 0
  ? '\x1b[32m\x1b[1m全部通过\x1b[0m  未发现 URL 注入导致的脚本执行'
  : `\x1b[31m\x1b[1m${vulnerable} 个用例可注入\x1b[0m`);
console.log('');

ws.close();
child.kill();
