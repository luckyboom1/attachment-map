/**
 * UI 通用层
 * ===========================================================================
 * 只放跨页面复用的东西：DOM 工具、站点框架注入、Toast、文本渲染、剪贴板、二维码。
 * 页面专属逻辑一律放 pages/ 下，不要往这里加。
 */

import { encodeQr, qrToSvg } from '../core/qr.js';

/* ------------------------------ DOM 工具 ------------------------------ */

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      // 事件类型必须转小写：DOM 事件名区分大小写，click 事件匹配不上 'Click'。
      // 这里曾经漏了 toLowerCase，导致所有经 h() 创建的按钮「点了没反应」。
      el.addEventListener(k.slice(2).toLowerCase(), v);
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c == null) return;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return el;
}

export const param = (name, search = location.search) => new URLSearchParams(search).get(name);

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* --------------------------- 轻量文本渲染 --------------------------- */
/**
 * 支持极小的子集：**粗体** / - 无序列表 / 1. 有序列表 / > 引用 / 空行分段。
 * 先转义再解析，杜绝注入。
 */
export function richText(src) {
  const safe = escapeHtml(String(src || ''));
  const blocks = safe.split(/\n{2,}/);

  return blocks.map((block) => {
    const lines = block.split('\n').filter((l) => l.trim() !== '');

    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      return `<ul class="list--inline">${
        lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')
      }</ul>`;
    }
    if (lines.every((l) => /^\s*\d+\.\s+/.test(l))) {
      return `<ol class="list--inline list--num">${
        lines.map((l) => `<li>${inline(l.replace(/^\s*\d+\.\s+/, ''))}</li>`).join('')
      }</ol>`;
    }
    if (lines.every((l) => /^\s*&gt;\s?/.test(l))) {
      return `<blockquote class="quote">${
        lines.map((l) => inline(l.replace(/^\s*&gt;\s?/, ''))).join('<br>')
      }</blockquote>`;
    }
    return `<p class="t-sm">${lines.map(inline).join('<br>')}</p>`;
  }).join('');
}

function inline(s) {
  return s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

/* ------------------------------ Toast ------------------------------ */

let toastHost = null;

export function toast(message, type = 'info', ms = 3200) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const node = h('div', { class: `toast${type === 'error' ? ' toast--err' : ''}`, text: message });
  toastHost.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity 200ms';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, ms);
}

/* ------------------------------ 剪贴板 ------------------------------ */

export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 降级 */ }

  try {
    const ta = h('textarea', { style: 'position:fixed;left:-9999px' });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function downloadFile(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* ------------------------------ 按钮 loading ------------------------------ */

export function setLoading(btn, loading, loadingText = '处理中…') {
  if (!btn) return;
  if (loading) {
    btn.dataset._label = btn.textContent;
    btn.textContent = loadingText;
    btn.setAttribute('aria-busy', 'true');
    btn.setAttribute('aria-disabled', 'true');
  } else {
    btn.textContent = btn.dataset._label || btn.textContent;
    btn.removeAttribute('aria-busy');
    btn.removeAttribute('aria-disabled');
  }
}

/* ------------------------------ 主题 ------------------------------ */

const THEME_KEY = 'am:theme';

export function initTheme() {
  const saved = (() => { try { return JSON.parse(localStorage.getItem(THEME_KEY)); } catch { return null; } })();
  const theme = saved || 'light';
  document.documentElement.dataset.theme = theme;
  return theme;
}

export function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  return next;
}

/* ------------------------------ 二维码 ------------------------------ */

/**
 * 生成一张二维码卡片。
 *
 * 为什么必须本地生成：邀请链接里带着作答编码，等价于用户的答案原文。
 * 交给任何第三方二维码服务，都等于把答案发给第三方。
 * 所以二维码由 core/qr.js 在本地算，页面只负责画。
 *
 * 内容超出编码器容量时返回一段说明，而不是一个扫不出来的码。
 *
 * @param {string} text
 * @param {{caption?: string, size?: number}} [opts]
 * @returns {HTMLElement}
 */
export function qrFigure(text, opts = {}) {
  const { caption = '让对方用相机扫这个码', size = 232 } = opts;

  const qr = encodeQr(text);
  if (!qr) {
    return h('div', { class: 'note note--warn', style: `max-width:${size}px` }, [
      h('span', { class: 'note__icon', text: '!', 'aria-hidden': 'true' }),
      h('div', { html: '这个链接超出了本页二维码的容量上限，改用「复制链接」发送即可。' }),
    ]);
  }

  const box = h('div', { class: 'qr', style: `width:${size}px` });
  box.innerHTML = qrToSvg(qr, { margin: 4, title: '邀请二维码' });

  return h('figure', { class: 'qr-figure' }, [
    box,
    h('figcaption', { class: 'qr-caption', text: caption }),
  ]);
}

/* ------------------------------ 站点框架 ------------------------------ */

const NAV = [
  { href: 'index.html', label: '开始' },
  { href: 'about.html', label: '方法说明' },
];

/**
 * 注入页头与页脚。
 * @param {{page:string, home?:boolean}} opts
 */
export function mountChrome({ page, home = false } = {}) {
  document.body.dataset.page = page;
  initTheme();

  const skip = h('a', { class: 'skip-link', href: '#main', text: '跳到主内容' });
  document.body.insertBefore(skip, document.body.firstChild);

  const nav = h('nav', { class: 'site-nav', 'aria-label': '站点导航' },
    NAV.map((item) => h('a', {
      href: item.href,
      text: item.label,
      'aria-current': location.pathname.endsWith(item.href) ? 'page' : null,
    })),
  );

  const themeBtn = h('button', {
    class: 'btn btn--sm btn--white',
    type: 'button',
    title: '切换主题',
    'aria-label': '切换深色／浅色主题',
    text: document.documentElement.dataset.theme === 'dark' ? '☀ 浅色' : '☾ 深色',
    onClick: (e) => {
      const t = toggleTheme();
      e.currentTarget.textContent = t === 'dark' ? '☀ 浅色' : '☾ 深色';
    },
  });

  const header = h('header', { class: 'site-header' },
    h('div', { class: 'wrap site-header__inner' }, [
      h('a', { class: 'brand', href: 'index.html' }, [
        h('span', { class: 'brand__mark', text: '依', 'aria-hidden': 'true' }),
        h('span', { text: '依恋地图' }),
      ]),
      h('span', { class: 'spacer' }),
      nav,
      themeBtn,
    ]),
  );

  const footer = h('footer', { class: 'site-footer' },
    h('div', { class: 'wrap' }, [
      h('p', { html:
        '<strong>依恋地图</strong> · 基于成人依恋理论的自评工具。' +
        '本测试不构成心理诊断，也不能替代专业心理咨询或治疗。' }),
      h('p', { class: 'mt-3', html:
        '所有作答在你的浏览器内计算，我们不上传、不存储你的答案。' +
        ' · <a href="about.html">方法说明与免责</a>' }),
    ]),
  );

  const main = $('#main');
  if (main) {
    document.body.insertBefore(header, main);
    document.body.appendChild(footer);
  } else {
    document.body.insertBefore(header, document.body.firstChild);
    document.body.appendChild(footer);
  }
}

/** 渲染一个 note 提示条 */
export function noteNode(kind, icon, html) {
  return h('div', { class: `note note--${kind}` }, [
    h('span', { class: 'note__icon', text: icon, 'aria-hidden': 'true' }),
    h('div', { html }),
  ]);
}

/** 渲染进度条文本 */
export function remainingText(answered, total) {
  return `还剩 ${Math.max(0, total - answered)} 题`;
}
