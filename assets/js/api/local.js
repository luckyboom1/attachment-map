/**
 * LocalAdapter —— 当前运行模式（免费、纯本地、零后端）
 * ===========================================================================
 * 它实现了完整契约，所以页面代码与「将来接了后端」时完全一致。
 * 计分在这里直接调用 core/scoring.js，不上传任何数据。
 *
 * 免费模式下的付费墙行为（刻意如此）
 * ---------------------------------------------------------------------------
 * 免费体验期内，createOrder 直接返回 status:'paid'、amount 为 0，
 * 并立即发放权益。目的是让整条漏斗（结果页 → 付费墙 → 报告页）可以被
 * 真实走通并埋点，而不是做一个点不动的假按钮。
 * UI 上必须如实标注「免费体验期」，不得伪装成已支付。
 */

import { ApiError, ERROR_CODES } from './contract.js';
import { NORMS } from '../core/norms.js';
import { score } from '../core/scoring.js';
import { buildReport, buildDuoReport } from '../core/report.js';
import { store, newId } from '../core/store.js';

const PLANS = {
  single: { amountCents: 990, label: '单人深度报告' },
  duo: { amountCents: 2990, label: '双人合盘报告' },
};

/** 免费模式：订单直接置为已支付 */
const FREE_MODE = true;

function delay(ms) {
  // 保留一点点延迟，让 loading 态在开发期可见；不要用于生产手感
  return new Promise((r) => setTimeout(r, ms));
}

export const LocalAdapter = {
  name: 'local',

  /* ---------------------------- 常模 ---------------------------- */
  async getNorms(force = false) {
    if (!force) {
      const cached = store.loadNormsCache();
      if (cached && cached.version === NORMS.version) return cached;
    }
    const payload = {
      version: NORMS.version,
      source: NORMS.source,
      anxiety: { ...NORMS.anxiety },
      avoidance: { ...NORMS.avoidance },
      cut: { ...NORMS.cut },
      citation: NORMS.citation,
      citationLabel: NORMS.citationLabel,
      referenceShort: NORMS.referenceShort,
      sampleNote: NORMS.sampleNote,
      provisionalNote: NORMS.provisionalNote,
    };
    store.cacheNorms(payload);
    return payload;
  },

  /* ---------------------------- 提交作答 ---------------------------- */
  async submitAnswers({ answers }) {
    const result = score(answers);
    const resultId = store.saveResult({
      ...result,
      resultId: undefined,          // 交给 saveResult 生成
      answers,                      // 本地留存，便于「跨设备」以外的场景复用
    });
    return {
      resultId,
      A: result.A, V: result.V, zA: result.zA, zV: result.zV,
      type: result.type,
      normsVersion: result.normsVersion,
    };
  },

  /* ---------------------------- 权益 ---------------------------- */
  async getEntitlements() {
    return store.getEntitlements();
  },

  /* ---------------------------- 订单 ---------------------------- */
  async createOrder({ plan = 'single', resultId = null, channel = 'free-mode' }) {
    if (!PLANS[plan]) {
      throw new ApiError(ERROR_CODES.BAD_REQUEST, '未知的产品类型。');
    }
    if (FREE_MODE) {
      const order = {
        orderId: newId('o'),
        plan,
        amountCents: 0,
        listAmountCents: PLANS[plan].amountCents,
        currency: 'CNY',
        status: 'paid',
        channel: 'free-mode',
        payUrl: null,
        resultId,
        note: '免费体验期：未接入支付通道，本次不产生费用。',
        createdAt: new Date().toISOString(),
      };
      store.saveOrder(order);
      const ent = store.getEntitlements();
      store.setEntitlements({
        [plan]: true,
        orders: [...(ent.orders || []), order.orderId],
      });
      await delay(180);
      return order;
    }

    // 正式支付流程的结构（当前不可达，保留以便切换）
    const order = {
      orderId: newId('o'),
      plan,
      amountCents: PLANS[plan].amountCents,
      currency: 'CNY',
      status: 'pending',
      channel,
      payUrl: null,
      resultId,
      createdAt: new Date().toISOString(),
    };
    store.saveOrder(order);
    return order;
  },

  async getOrder(orderId) {
    const order = store.getOrder(orderId);
    if (!order) throw new ApiError(ERROR_CODES.NOT_FOUND, '找不到这笔订单。');
    return order;
  },

  /* ---------------------------- 兑换码 ---------------------------- */
  async redeem(code) {
    const clean = String(code || '').trim().toUpperCase();
    if (!clean) throw new ApiError(ERROR_CODES.BAD_REQUEST, '请输入兑换码。');

    // 免费期的演示码；正式环境由服务端校验
    const DEMO = { FREEMODE: 'single', DUO2026: 'duo' };
    const plan = DEMO[clean];
    if (!plan) {
      throw new ApiError(ERROR_CODES.NOT_FOUND, '兑换码无效或已过期。');
    }
    const ent = store.getEntitlements();
    const next = store.setEntitlements({ [plan]: true, orders: [...(ent.orders || []), `redeem:${clean}`] });
    return next;
  },

  /* ---------------------------- 报告 ---------------------------- */
  /**
   * @param {string} resultId
   * @param {{mode?:'single'|'duo', partnerId?:string}} [options]
   */
  async getReport(resultId, options = {}) {
    const { mode = 'single', partnerId = null } = options;

    const mine = store.getResult(resultId);
    if (!mine) throw new ApiError(ERROR_CODES.NOT_FOUND, '找不到这份结果，请重新测试。');

    const ent = store.getEntitlements();
    const price = mode === 'duo' ? ent.duo : ent.single;
    if (!price) {
      throw new ApiError(ERROR_CODES.UNAUTHORIZED, '这份报告尚未解锁。');
    }

    if (mode === 'duo') {
      const partner = partnerId ? store.getResult(partnerId) : null;
      if (!partner) {
        throw new ApiError(ERROR_CODES.NOT_FOUND, '找不到对方的测试结果。');
      }
      // 合盘结果由页面直接算；报告只负责文案章节
      const { computeDuo } = await import('../core/duo.js');
      const duo = computeDuo(mine, partner);
      return { resultId, typeKey: mine.type, ...buildDuoReport(mine, partner, duo) };
    }

    return { resultId, typeKey: mine.type, ...buildReport(mine) };
  },

  /* ---------------------------- 埋点 ---------------------------- */
  async track(payload) {
    const list = Array.isArray(payload) ? payload : [payload];
    list.forEach((e) => store.bufferEvent(e));
    if (typeof console !== 'undefined' && console.debug) {
      console.debug('[track:local]', list.map((e) => e.name).join(', '));
    }
    return { accepted: list.length };
  },
};

export { PLANS, FREE_MODE };
