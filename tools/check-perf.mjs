/**
 * 交互流畅度度量（无头 Chrome + CDP）
 * ---------------------------------------------------------------------------
 * 用法：
 *   npm run dev
 *   npm run check:perf
 *   AM_BASE_URL=https://xiaoceyixia.cn npm run check:perf
 *
 * 为什么要有这个文件
 * ---------------------------------------------------------------------------
 * 「流畅度」是主观词，先把它变成可测的三个数：
 *   1. 响应延迟 —— 从点击到新题目可见经过多久（人眼 100ms 内视为瞬时）
 *   2. 长任务   —— 主线程被阻塞超过 50ms 的次数（卡顿的直接来源）
 *   3. 布局偏移 —— CLS 累计值（内容跳动，最容易被感知为「不流畅」）
 *
 * 另外核验两条工程事实：
 *   4. 动画是否只跑在合成层（transform / opacity），有没有在动画 width/height
 *   5. 是否响应了系统的「减少动态效果」偏好
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const BASE = process.env.AM_BASE_URL || 'http://127.0.0.1:5173';
const PORT = 9230;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

if (!CHROME) { console.log('未找到 Chrome / Edge，跳过。'); process.exit(0); }

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
    const l = listeners.get(m.method); if (l) l.forEach((f) => f(m.params));
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
await send('Performance.enable');

/* 收集长任务与布局偏移 */
const longTasks = [];
const shifts = [];
on('Performance.metrics', () => {});
await send('Runtime.evaluate', { expression: `
  window.__lt = []; window.__cls = 0;
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); })
      .observe({ entryTypes: ['longtask'] });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; })
      .observe({ entryTypes: ['layout-shift'] });
  } catch (e) {}
` });

const go = async (path) => {
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
  // 关键：无头 Chrome 默认把 prefers-reduced-motion 报成 reduce，
  // 不显式覆盖的话，所有入场动画都会被站点的无障碍分支关掉，
  // 量到的是「动画关闭时的流畅度」——那不是真实用户看到的画面。
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  });
  await send('Page.navigate', { url: `${BASE}/${path}` });
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const r = await send('Runtime.evaluate', { expression: `JSON.stringify({r:document.readyState,m:!!document.getElementById('main')})`, returnByValue: true });
    const s = JSON.parse(r.result.value);
    if (s.r === 'complete' && s.m) break;
    await sleep(300);
  }
  await sleep(500);
  await send('Runtime.evaluate', { expression: `window.__lt = []; window.__cls = 0;` });
};

console.log(`\n\x1b[1m交互流畅度度量\x1b[0m  ${BASE}\n`);

/* ---------- 1. 点击响应延迟 ----------
   分两个时刻测，因为它们是两件事：
     起点 —— 画面开始变化（用户感知到「我这一下生效了」）
     可读 —— 新题达到可读亮度（用户能开始读）
   只测前者会高估体验，只测后者会低估响应感。 */
await go('quiz.html');
const latency = await send('Runtime.evaluate', {
  returnByValue: true,
  awaitPromise: true,
  expression: `(async () => {
    const start = [], legible = [];
    const qText = document.getElementById('q-text');
    for (let i = 0; i < 5; i++) {
      const before = qText.textContent;
      const btns = document.querySelectorAll('.likert__btn');
      if (!btns.length) break;
      const t0 = performance.now();
      btns[2].click();
      let tStart = -1;
      let framesAfterStart = 0;
      await new Promise((res) => {
        const deadline = performance.now() + 3000;
        const tick = () => {
          if (tStart < 0 && qText.textContent !== before) {
            tStart = performance.now();
          } else if (tStart > 0) {
            // 关键：跳过「文本刚变」的那一帧再读不透明度。
            // 动画对象刚创建时还未进入活动阶段，此刻读到的仍是基础值 1，
            // 会把「可读时刻」错误地等同于「起点」。等一帧后动画才真正生效。
            framesAfterStart++;
            if (framesAfterStart >= 2) {
              const op = Number(getComputedStyle(qText).opacity);
              if (op >= 0.9) return res();
            }
          }
          if (performance.now() > deadline) return res();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      start.push(Math.round(tStart - t0));
      legible.push(Math.round(performance.now() - t0));
    }
    return JSON.stringify({ start, legible });
  })()`,
});
const lat = JSON.parse(latency.result.value);
const mean = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : -1);
const onset = mean(lat.start);
const legibleAvg = mean(lat.legible);
const rate = (v, good, ok) => (v <= good ? '\x1b[32m' : v <= ok ? '\x1b[33m' : '\x1b[31m');
console.log(`1. 点击 → 下一题`);
console.log(`   起点（画面开始变化）：${onset} ms   ${rate(onset, 100, 150)}${onset <= 100 ? '（≤100ms，属瞬时）' : onset <= 150 ? '（可感知，但仍在跟手范围）' : '（明显迟钝）'}\x1b[0m`);
console.log(`   可读（新题达到可读亮度）：${legibleAvg} ms   ${rate(legibleAvg, 180, 260)}${legibleAvg <= 180 ? '（良好）' : legibleAvg <= 260 ? '（可接受）' : '（偏慢）'}\x1b[0m`);
console.log(`   样本：起点 ${lat.start.join('/')} ｜ 可读 ${lat.legible.join('/')}`);

/* 确认入场动画真的在跑，而且只动合成层属性 */
const animCheck = await send('Runtime.evaluate', {
  returnByValue: true,
  awaitPromise: true,
  expression: `(async () => {
    const qText = document.getElementById('q-text');
    const btn = document.querySelectorAll('.likert__btn')[3];
    const before = qText.textContent;
    btn.click();
    await new Promise((r) => {
      const tick = () => (qText.textContent !== before ? r() : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });
    const anims = (qText.getAnimations ? qText.getAnimations() : []).map((a) => {
      const kf = a.effect.getKeyframes();
      // composite / computedOffset / offset / easing 是关键帧的元信息，不是被动画的属性
      const META = ['offset', 'computedOffset', 'easing', 'composite'];
      const props = Object.keys(kf[0]).filter((k) => !META.includes(k));
      return { duration: a.effect.getTiming().duration, props, fill: a.effect.getTiming().fill };
    });
    return JSON.stringify(anims);
  })()`,
});
const anims = JSON.parse(animCheck.result.value);
const onlyComposited = anims.length > 0
  && anims.every((a) => a.props.every((p) => ['opacity', 'transform'].includes(p)));
console.log(`   入场动画：${anims.length ? anims.map((a) => a.duration + 'ms [' + a.props.join(',') + ']').join(' / ') : '\x1b[33m未检测到（可能已被减少动态效果偏好关闭）\x1b[0m'}`);
if (anims.length) {
  console.log(`   动画属性：${onlyComposited ? '\x1b[32m仅 opacity / transform（合成层，不触发布局）\x1b[0m' : '\x1b[31m含布局属性\x1b[0m'}`);
}

/* ---------- 2. 长任务与布局偏移 ---------- */
const metrics = await send('Runtime.evaluate', {
  returnByValue: true,
  expression: `JSON.stringify({ lt: window.__lt || [], cls: Number((window.__cls || 0).toFixed(4)) })`,
});
const m = JSON.parse(metrics.result.value);
console.log(`\n2. 主线程与布局稳定`);
console.log(`   长任务（>50ms）：${m.lt.length} 次${m.lt.length ? ' → ' + m.lt.join(' / ') + ' ms' : '  \x1b[32m（无阻塞）\x1b[0m'}`);
console.log(`   累计布局偏移 CLS：${m.cls}   ${m.cls < 0.1 ? '\x1b[32m（良好）\x1b[0m' : '\x1b[33m（偏高，内容有跳动）\x1b[0m'}`);

/* ---------- 3. 动画属性 ---------- */
await go('quiz.html');
const anim = await send('Runtime.evaluate', {
  returnByValue: true,
  expression: `(() => {
    const widened = [];
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      for (const r of rules) {
        if (!r.style || !r.style.transition) continue;
        const t = r.style.transition;
        if (/\\b(width|height|top|left|right|bottom|margin|padding)\\b/.test(t) && !/transform/.test(t)) {
          widened.push((r.selectorText || '?') + ' → ' + t);
        }
      }
    }
    return JSON.stringify(widened);
  })()`,
});
const widened = JSON.parse(anim.result.value);
console.log(`\n3. 动画属性（是否只跑在合成层）`);
if (!widened.length) console.log('   \x1b[32m全部只动 transform / opacity / box-shadow\x1b[0m');
else {
  console.log('   以下会触发布局计算（若元素已用 contain 隔离，开销被限制在自身）：');
  widened.forEach((w) => console.log(`     · ${w}`));
}

/* ---------- 4. 触屏适配 ---------- */
const touch = await send('Runtime.evaluate', {
  returnByValue: true,
  expression: `(() => {
    const probe = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const s = getComputedStyle(el);
      return { ta: s.touchAction, hl: s.webkitTapHighlightColor };
    };
    // 统计仍暴露给触屏的 :hover 规则（应当为 0）
    let looseHover = 0;
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      const walk = (list, insideHoverMQ) => {
        for (const r of list) {
          if (r.media) { walk(r.cssRules, insideHoverMQ || String(r.media.mediaText).includes('hover')); continue; }
          if (r.selectorText && r.selectorText.includes(':hover') && !insideHoverMQ) looseHover++;
        }
      };
      walk(rules, false);
    }
    return JSON.stringify({ btn: probe('.likert__btn'), looseHover });
  })()`,
});
const t = JSON.parse(touch.result.value);
console.log(`\n4. 触屏适配`);
console.log(`   选项按钮 touch-action：${t.btn ? t.btn.ta : '未找到按钮'}   ${t.btn && t.btn.ta === 'manipulation' ? '\x1b[32m（已关闭双击缩放判定）\x1b[0m' : '\x1b[33m（可能影响连点手感）\x1b[0m'}`);
console.log(`   屏幕未限定作用域的 :hover 规则：${t.looseHover} 条   ${t.looseHover === 0 ? '\x1b[32m（触屏不会残留悬停态）\x1b[0m' : '\x1b[33m（触屏上可能粘住）\x1b[0m'}`);

/* ---------- 5. 是否响应「减少动态效果」 ---------- */
const rm = await send('Runtime.evaluate', {
  returnByValue: true,
  expression: `(() => {
    let n = 0;
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      for (const r of rules) {
        if (r.media && String(r.media.mediaText).includes('prefers-reduced-motion')) {
          for (const inner of r.cssRules) if (inner.style && inner.style.transitionDuration) n++;
        }
      }
    }
    return JSON.stringify({ handled: n > 0, count: n });
  })()`,
});
const rmr = JSON.parse(rm.result.value);
console.log(`\n5. 无障碍：减少动态效果偏好`);
console.log(`   ${rmr.handled ? '\x1b[32m已处理\x1b[0m' : '\x1b[31m未处理\x1b[0m'}（CSS 命中规则 ${rmr.count} 条；JS 入场动画单独判断）`);

/* 切到 reduce 模式，确认动画确实被关掉（而不是只写了一行 CSS 规则却没人用） */
await send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
});
const rmActive = await send('Runtime.evaluate', {
  returnByValue: true,
  awaitPromise: true,
  expression: `(async () => {
    // 重新载入让模块里的偏好判断重新求值
    location.reload();
    return 'reloading';
  })()`,
});
await sleep(2000);
const rmCheck = await send('Runtime.evaluate', {
  returnByValue: true,
  awaitPromise: true,
  expression: `(async () => {
    const qText = document.getElementById('q-text');
    const btn = document.querySelectorAll('.likert__btn')[1];
    if (!qText || !btn) return JSON.stringify({ err: 'no-quiz' });
    const before = qText.textContent;
    btn.click();
    await new Promise((r) => {
      const tick = () => (qText.textContent !== before ? r() : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });
    const n = (qText.getAnimations ? qText.getAnimations() : []).length;
    return JSON.stringify({ running: n });
  })()`,
});
const rmc = JSON.parse(rmCheck.result.value);
console.log(`   reduce 模式下入场动画数量：${rmc.running ?? '?'}   ${rmc.running === 0 ? '\x1b[32m（已正确关闭）\x1b[0m' : '\x1b[31m（仍在播放）\x1b[0m'}`);

/* 恢复 no-preference，供后续小节使用 */
await send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
});

/* ---------- 6. 海报生成的主线程开销 ----------
   结果页最重的一次交互：把 750×1330 的版式按 2 倍分辨率画到 canvas（约 400 万像素）。
   如果它阻塞主线程，用户点「生成分享长图」后会看到界面僵住。 */
await go('result.html');
await send('Runtime.evaluate', {
  awaitPromise: true,
  expression: `(async () => {
    const base = new URL('./', document.baseURI).href;
    const { score } = await import(base + 'assets/js/core/scoring.js');
    const { QUESTIONS } = await import(base + 'assets/js/data/questions.js');
    const ans = {}; QUESTIONS.forEach((q, i) => { ans[q.id] = (i % 7) + 1; });
    const res = score(ans);
    const rec = Object.assign({}, res, { answers: ans, resultId: 'r_perf', savedAt: new Date().toISOString() });
    const all = {}; all['r_perf'] = rec;
    localStorage.setItem('am:results', JSON.stringify(all));
    localStorage.setItem('am:lastResultId', JSON.stringify('r_perf'));
    localStorage.setItem('am:entitlements', JSON.stringify({ single: false, duo: false, orders: [] }));
  })()`,
});
await go('result.html?r=r_perf');
const poster = await send('Runtime.evaluate', {
  returnByValue: true,
  awaitPromise: true,
  expression: `(async () => {
    window.__lt = []; window.__cls = 0;
    const btn = document.getElementById('btn-poster');
    if (!btn) return JSON.stringify({ err: 'no-button' });
    const t0 = performance.now();
    btn.click();
    // 等按钮文字变成已完成（说明绘制 + 转 dataURL 都结束了）
    await new Promise((r) => {
      const deadline = performance.now() + 15000;
      const tick = () => (btn.disabled || performance.now() > deadline ? r() : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });
    const total = Math.round(performance.now() - t0);
    const img = document.querySelector('#poster-host img');
    return JSON.stringify({
      total,
      lt: window.__lt || [],
      drawn: !!img,
      size: img ? img.naturalWidth + 'x' + img.naturalHeight : null,
    });
  })()`,
});
const p = JSON.parse(poster.result.value);
console.log(`\n6. 海报生成（结果页最重的一次交互）`);
if (p.err) console.log(`   \x1b[33m跳过：${p.err}\x1b[0m`);
else {
  console.log(`   总耗时：${p.total} ms ｜ 产出：${p.size || '未生成'}`);
  const worst = p.lt.length ? Math.max(...p.lt) : 0;
  console.log(`   期间长任务：${p.lt.length} 次${p.lt.length ? `（最长 ${worst}ms）` : ''}   ${worst > 50 ? '\x1b[33m（有阻塞，按钮期间应显示加载态）\x1b[0m' : '\x1b[32m（无阻塞）\x1b[0m'}`);
}

console.log('');
ws.close();
child.kill();
