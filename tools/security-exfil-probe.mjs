/**
 * 第三方请求与数据外泄探测（无头 Chrome + CDP）
 * ---------------------------------------------------------------------------
 * 用法：
 *   node tools/security-exfil-probe.mjs                                     # 打线上
 *   AM_BASE_URL=http://127.0.0.1:5173 node tools/security-exfil-probe.mjs    # 打本地
 *
 * 要回答的问题
 * ---------------------------------------------------------------------------
 * 合盘链接形如 duo.html?a=<我的答案>&b=<对方的答案>，
 * 也就是说 **URL 里就是两个人的依恋测评答案**（敏感心理数据）。
 * 必须查清：这个 URL 会不会在页面加载过程中离开浏览器、去了哪里。
 *
 * 判定原则
 * ---------------------------------------------------------------------------
 * 逐字段判定，不把 URL / 请求体 / Referer 混成一个字符串去搜。
 * 第一版就是混着搜的，结果请求体里明明没有答案也被报成「请求体含答案」——
 * 假阳性会把排查引向错误方向。所以这里对每个渠道分别报告。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const BASE = process.env.AM_BASE_URL || 'https://xiaoceyixia.cn';
const PORT = 9251;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一个合法的 duo 链接：a/b 都是长度正确的编码串 */
const DUO_A = 'BTlwKcuBTlwKcuBTlwA';
const DUO_B = 'TUVWXYZ0123456789ABC';

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!CHROME) { console.log('未找到浏览器，跳过。'); process.exit(0); }

const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpdir(), 'am-sec2')}`,
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

const requests = [];
on('Network.requestWillBeSent', (p) => {
  requests.push({
    url: p.request.url,
    method: p.request.method,
    postData: p.request.postData || null,
    referer: p.request.headers?.Referer || p.request.headers?.referer || null,
    headers: p.request.headers || {},
  });
});

const target = `${BASE}/duo.html?a=${DUO_A}&b=${DUO_B}`;
console.log(`\n\x1b[1m第三方请求与数据外泄探测\x1b[0m`);
console.log(`   目标页：${BASE}/duo.html?a=<答案A>&b=<答案B>\n`);

await send('Page.navigate', { url: target });
await sleep(9000);   // 分析脚本先加载、后异步上报，等待要足够长

const origin = new URL(BASE).origin;
const crossOrigin = requests.filter((r) => {
  try { return new URL(r.url).origin !== origin; } catch { return false; }
});
/** 同源但属于上报类的端点（Cloudflare 的 RUM 走 /cdn-cgi/，经其代理后表现为同源） */
const sameOriginBeacons = requests.filter((r) => {
  try {
    const u = new URL(r.url);
    return u.origin === origin && /\/cdn-cgi\/|beacon|\/rum|collect|analytics/i.test(u.pathname + u.search);
  } catch { return false; }
});

console.log(`\x1b[1m跨站请求：${crossOrigin.length} 个\x1b[0m`);
const byHost = new Map();
for (const r of crossOrigin) {
  const h = new URL(r.url).host;
  if (!byHost.has(h)) byHost.set(h, 0);
  byHost.set(h, byHost.get(h) + 1);
}
for (const [h, n] of byHost) console.log(`  ${h}  （${n} 个）`);
if (!crossOrigin.length) console.log('  无');

console.log(`\n\x1b[1m同源上报端点：${sameOriginBeacons.length} 个\x1b[0m`);
for (const r of sameOriginBeacons) {
  console.log(`  ${r.method} ${r.url.replace(origin, '').slice(0, 100)}`);
}

/* ---------------- 逐渠道判定 ----------------
   为什么必须分渠道：第一版把 URL / 请求体 / Referer 混成一个字符串去搜，
   请求体里明明没有答案也被报成「请求体含答案编码」。
   假阳性会把排查引向错误方向，也会让「哪里泄露」这个关键结论失真。 */
const hitAnswer = (v) => v != null && (String(v).includes(DUO_A) || String(v).includes(DUO_B));

const leakChannels = (r) => {
  const out = [];
  if (hitAnswer(r.url)) out.push('请求 URL');
  if (hitAnswer(r.postData)) out.push('请求体');
  if (hitAnswer(r.referer)) out.push('Referer 请求头');
  for (const [k, v] of Object.entries(r.headers)) {
    if (/^referer$/i.test(k)) continue;
    if (hitAnswer(v)) out.push(`请求头 ${k}`);
  }
  return out;
};

console.log(`\n\x1b[1m答案泄露逐项判定\x1b[0m`);
let leaked = 0;
const channelCount = {};
for (const r of [...crossOrigin, ...sameOriginBeacons]) {
  const ch = leakChannels(r);
  if (!ch.length) continue;
  leaked++;
  ch.forEach((c) => { channelCount[c] = (channelCount[c] || 0) + 1; });
  console.log(`  \x1b[31m泄露\x1b[0m ${r.method} ${r.url.slice(0, 70).replace(origin, '')}`);
  console.log(`       经：${ch.join(' + ')}`);
  if (ch.includes('Referer 请求头')) {
    console.log(`       Referer = ${String(r.referer).slice(0, 120)}`);
  }
  if (ch.includes('请求体')) {
    const body = String(r.postData);
    const idx = body.indexOf(DUO_A) >= 0 ? body.indexOf(DUO_A) : body.indexOf(DUO_B);
    console.log(`       请求体第 ${idx} 字节附近：…${body.slice(Math.max(0, idx - 70), idx + 40)}…`);
  }
}
if (!leaked) console.log('  未发现任何请求携带答案');

console.log('\n' + '─'.repeat(64));
console.log(`携带答案的请求：\x1b[1m${leaked}\x1b[0m 个`);
if (Object.keys(channelCount).length) {
  console.log('泄露渠道分布：');
  for (const [c, n] of Object.entries(channelCount)) console.log(`  · ${c} —— ${n} 个请求`);
}
console.log(leaked === 0
  ? '\x1b[32m\x1b[1m未发现答案外泄\x1b[0m'
  : '\x1b[31m\x1b[1m存在答案外泄\x1b[0m —— URL 中的测评答案离开了浏览器');
console.log('');

ws.close();
child.kill();
