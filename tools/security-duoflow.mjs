/**
 * 合盘流程端到端验证（无头 Chrome + CDP）
 * ---------------------------------------------------------------------------
 * 用法：
 *   npm run dev
 *   node tools/security-duoflow.mjs
 *
 * 为什么单独测这一条链路
 * ---------------------------------------------------------------------------
 * 为了堵住答案外泄，本次把编码从查询串（?a=…&b=…）搬到了 URL 片段（#a=…&b=…）。
 * 这动的是合盘功能的传输格式：只要有一处读取点漏改，用户就会看到
 * 「链接不完整」——而这类问题在单元层面看不出来，必须走完整条流程。
 *
 * 覆盖：发起方测完 → 生成邀请链接 → 被邀请方粘贴 → 答题 → 双方答案合流 → 合盘页渲染
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const BASE = process.env.AM_BASE_URL || 'http://127.0.0.1:5173';
const PORT = 9252;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!CHROME) { console.log('未找到浏览器，跳过。'); process.exit(0); }

const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpdir(), 'am-duo')}`,
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

/**
 * 求值并取回 JSON。
 * 注意：不能写成 JSON.stringify(<表达式>)——表达式是 async IIFE，
 * 返回的是 Promise，直接 stringify 会得到 "{}"（踩过这个坑）。
 * 正确做法是先 Promise.resolve 等它落定，再序列化。
 */
const evalJson = async (expr) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression: `Promise.resolve(${expr}).then((v) => JSON.stringify(v))`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) {
    throw new Error(`页面内求值异常：${JSON.stringify(exceptionDetails).slice(0, 300)}`);
  }
  return JSON.parse(result.value);
};

let pass = 0, fail = 0;
const problems = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; problems.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ' — ' + detail : ''}`); }
};

console.log(`\n\x1b[1m合盘流程端到端验证\x1b[0m  ${BASE}\n`);

/* ---------- 1. 生成邀请链接（纯函数，直接调用页面模块） ---------- */
await send('Page.navigate', { url: `${BASE}/result.html` });
await sleep(1200);

const built = await evalJson(`(async () => {
  const base = new URL('./', document.baseURI).href;
  const { buildInviteUrl, buildDuoUrl, readDuoFromUrl, decodeAnswers, encodeAnswers } =
    await import(base + 'assets/js/core/encode.js');
  const a = Array.from({ length: 36 }, (_, i) => (i % 7) + 1);
  const b = Array.from({ length: 36 }, (_, i) => ((i + 3) % 7) + 1);
  const invite = buildInviteUrl('duo.html', a);
  const duo = buildDuoUrl('duo.html', a, b);
  const raw = readDuoFromUrl('', '#' + invite.split('#')[1]);
  return { invite, duo, rawA: raw.a ? raw.a.slice(0, 5) : null, expectA: a.slice(0, 5), ready: raw.ready };
})()`);

if (!built || !built.invite) {
  console.log("  [31m模块调用失败，原始返回：[0m", JSON.stringify(built));
  ws.close(); child.kill(); process.exit(1);
}
ok('邀请链接不含查询串', !built.invite.includes('?'), `实际 ${built.invite}`);
ok('邀请链接把编码放在片段里', built.invite.includes('#a='), `实际 ${built.invite}`);
ok('合盘链接的 a、b 都在片段里',
  built.duo.includes('#a=') && built.duo.includes('&b=') && !built.duo.includes('?'),
  `实际 ${built.duo}`);
ok('片段能被正确解回答案',
  JSON.stringify(built.rawA) === JSON.stringify(built.expectA),
  `解出 ${JSON.stringify(built.rawA)}，期望 ${JSON.stringify(built.expectA)}`);

/* ---------- 2. 走真实 DOM：从邀请链接进入答题页 ---------- */
const inviteHash = built.invite.split('#')[1];
const codeA = inviteHash.replace(/^a=/, '');

await send('Page.navigate', { url: `${BASE}/quiz.html#a=${codeA}` });
await sleep(1400);

const quizState = await evalJson(`(() => ({
  roleBannerVisible: !document.getElementById('role-banner')?.classList.contains('hide'),
  roleText: document.getElementById('role-text')?.textContent || '',
  btns: document.querySelectorAll('.likert__btn').length,
  url: location.href,
}))()`);
ok('被邀请方进入答题页并识别到邀请身份', quizState.roleBannerVisible, `提示：${quizState.roleText}`);
ok('答题选项正常渲染', quizState.btns === 7, `实际 ${quizState.btns} 个`);

/* ---------- 3. 答完 36 题，验证跳转到 duo 且答案在片段 ----------
   注意：最后一道题答完会 location.replace 跳到合盘页，
   正在执行的那个求值上下文随之失效（CDP 报 target navigated）。
   这不是错误，是预期行为——所以要容错，然后在新文档里读取结果。 */
let navigated = false;
try {
  await evalJson(`(async () => {
    const btns = () => document.querySelectorAll('.likert__btn');
    for (let i = 0; i < 40; i++) {
      const b = btns()[3];
      if (!b) break;
      b.click();
      await new Promise((r) => setTimeout(r, 130));
    }
    return { done: true };
  })()`);
} catch (e) {
  if (/navigated or closed/.test(String(e.message))) navigated = true;
  else throw e;
}
await sleep(1500);

const finished = await evalJson(`(() => ({
  url: location.href,
  search: location.search,
  hash: location.hash,
}))()`);

ok('答完后发生跳转（上下文失效即跳转发生的证据）', navigated || finished.url.includes('duo'),
  `跳转=${navigated}，URL=${finished.url}`);
ok('跳转后的 URL 片段里带双方答案',
  finished.hash.includes('a=') && finished.hash.includes('b='),
  `片段 ${finished.hash.slice(0, 40)}…`);
ok('跳转后的查询串里没有答案',
  !finished.search.includes('a=') && !finished.search.includes('b='),
  `查询串 ${finished.search || '（空）'}`);

/* ---------- 4. 合盘页真的渲染出结果（不是「链接不完整」） ---------- */
await sleep(1200);
const duoView = await evalJson(`(() => {
  const t = document.getElementById('main')?.textContent || '';
  return {
    len: t.length,
    hasIncomplete: /链接不完整|无法读取|不完整/.test(t),
    head: t.trim().slice(0, 60).replace(/\\s+/g, ' '),
  };
})()`);
ok('合盘页渲染出内容而非报错态', !duoView.hasIncomplete, `页面开头：${duoView.head}`);
ok('合盘页有实质内容', duoView.len > 200, `正文 ${duoView.len} 字`);

console.log('\n' + '─'.repeat(64));
console.log(fail === 0
  ? `\x1b[32m\x1b[1m全部通过\x1b[0m  ${pass} 项`
  : `\x1b[31m\x1b[1m${fail} 项未通过\x1b[0m  / 通过 ${pass} 项`);
problems.forEach((p) => console.log(`  · ${p}`));
console.log('');

ws.close();
child.kill();
