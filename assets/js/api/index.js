/**
 * API 入口 —— 全站唯一的数据出入口
 * ===========================================================================
 * 页面层只允许从这里拿数据：`import { api } from '../api/index.js'`
 * 禁止页面直接 import local.js / remote.js / store.js 做业务数据操作。
 *
 * 切换后端 = 改 CONFIG.mode。这是刻意的设计：让"接后端"变成一次配置变更，
 * 而不是一次重构。
 */

import { LocalAdapter } from './local.js';
import { createRemoteAdapter } from './remote.js';
import { assertAdapter, ApiError, ERROR_CODES } from './contract.js';
import { storageMode } from '../core/store.js';

/**
 * 全局配置。部署时通过 window.__AM_CONFIG__ 覆盖，无需改代码。
 * 例：<script>window.__AM_CONFIG__ = { mode:'remote', baseUrl:'https://api.example.com' }</script>
 */
export const CONFIG = Object.freeze({
  /** 'local' 纯前端本地运行（当前） | 'remote' 接后端 | 'mock' 同上但强制走模拟延迟 */
  mode: 'local',
  baseUrl: '',
  /** 免费体验期开关。true 时付费墙走"0 元直接解锁 + 如实标注" */
  freeMode: true,
  /** 输出详细日志 */
  debug: false,
  /** 是否上报埋点。免费期本地模式只写缓冲，发不出去 */
  analytics: true,
  ...(typeof window !== 'undefined' && window.__AM_CONFIG__ ? window.__AM_CONFIG__ : {}),
});

let _adapter = null;

/** 按 CONFIG 装配适配器 */
function build() {
  switch (CONFIG.mode) {
    case 'remote':
      if (!CONFIG.baseUrl) {
        console.warn('[api] mode=remote 但未配置 baseUrl，已回退到 local。');
        _adapter = LocalAdapter;
        break;
      }
      _adapter = createRemoteAdapter(CONFIG.baseUrl);
      break;
    case 'local':
    case 'mock':
    default:
      _adapter = LocalAdapter;
      break;
  }
  assertAdapter(_adapter);

  if (CONFIG.debug) {
    console.info(`[api] adapter=${_adapter.name} storage=${storageMode} freeMode=${CONFIG.freeMode}`);
  }
  return _adapter;
}

export function getApi() {
  if (!_adapter) build();
  return _adapter;
}

/** 运行时切换适配器（仅调试用）。正式切后端请改 CONFIG.mode。 */
export function useAdapter(mode, baseUrl) {
  const prev = CONFIG.mode;
  if (mode === prev) return getApi();
  console.warn('[api] 调试切换适配器：', prev, '→', mode);
  _adapter = mode === 'remote'
    ? createRemoteAdapter(baseUrl || CONFIG.baseUrl)
    : LocalAdapter;
  assertAdapter(_adapter);
  return _adapter;
}

/* ------------------------------------------------------------------ *
 * 业务门面：在适配器之上补一层页面真正需要的能力
 * ------------------------------------------------------------------ */

/** 一次作答 → 计分 → 落库，返回 resultId */
export async function submitQuiz(answers) {
  return getApi().submitAnswers({ answers });
}

/** 读取报告；未解锁时抛 ApiError(UNAUTHORIZED) */
export async function fetchReport(resultId, options) {
  return getApi().getReport(resultId, options);
}

/**
 * 创建订单。免费模式下立即返回已支付订单并发放权益。
 * @param {'single'|'duo'} plan
 */
export async function purchase(plan, resultId) {
  return getApi().createOrder({ plan, resultId });
}

export async function getEntitlements() {
  return getApi().getEntitlements();
}

export async function redeemCode(code, plan) {
  return getApi().redeem(code, plan);
}

/* ------------------------------ 埋点 ------------------------------ */

/** 页面上下文，随每个事件带上，便于漏斗归因 */
const PAGE_CONTEXT = {
  get page() { return document?.body?.dataset?.page || 'unknown'; },
  get path() { return location.pathname + location.search.replace(/([?&](a|b)=)[^&]+/g, '$1<enc>'); },
  get ref() { return document.referrer || ''; },
  get viewport() { return `${window.innerWidth}x${window.innerHeight}`; },
};

/**
 * 上报一个事件。失败绝不影响用户体验，也绝不阻塞 UI。
 * @param {string} name
 * @param {Record<string, any>} [props]
 */
export function track(name, props = {}) {
  if (!CONFIG.analytics) return;
  const event = {
    name,
    ts: new Date().toISOString(),
    props: { ...PAGE_CONTEXT, ...props },
  };
  try {
    getApi().track(event).catch(() => {});
  } catch { /* 埋点失败静默 */ }
}

/**
 * 漏斗五步的常量。名字固定，方便看板配置。
 * 顺序即用户旅程，改顺序等于改漏斗定义，需同步更新计划文档。
 */
export const FUNNEL = {
  landingView: 'funnel_1_landing_view',
  quizStart: 'funnel_2_quiz_start',
  quizComplete: 'funnel_3_quiz_complete',
  resultShare: 'funnel_4_result_share',
  inviteSent: 'funnel_4b_invite_sent',
  inviteAccepted: 'funnel_4c_invite_accepted',
  payClick: 'funnel_5_pay_click',
  paySuccess: 'funnel_5b_pay_success',
};

export { ApiError, ERROR_CODES };
export { storageMode };
export default { getApi, track, FUNNEL, CONFIG };
