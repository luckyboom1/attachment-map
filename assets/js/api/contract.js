/**
 * API 契约（Contract）
 * ===========================================================================
 * 这是前后端之间的唯一约定。任何适配器（local / remote / mock）都必须
 * 满足本契约。切换后端时，只实现这些方法即可，页面代码零改动。
 *
 * 约定
 * 1. 所有方法返回 Promise。
 * 2. 失败一律 reject 一个 ApiError（见下方 ApiError 定义），不要抛裸字符串。
 * 3. 页面层不得依赖任何适配器的内部实现细节（如 localStorage 的键名）。
 * 4. 计分仍以前端 core/scoring.js 为准。服务端复算是为了留档与常模积累，
 *    结果与前端应当一致；若不一致，以 core 为准并上报差异（说明契约漂移）。
 */

/* ------------------------------------------------------------------ *
 * 数据结构
 * ------------------------------------------------------------------ */

/**
 * @typedef {Object} NormsPayload
 * @property {string} version            常模版本号
 * @property {'provisional'|'published'|'site-sample'} source
 * @property {{mean:number, sd:number}} anxiety    百分位参照（不是切分点）
 * @property {{mean:number, sd:number}} avoidance  百分位参照（不是切分点）
 * @property {{anxiety:number, avoidance:number, basis:string, band:number}} cut
 *           类型判定的切分点。必须与 anxiety/avoidance 的 mean 分开维护，
 *           两者回答不同问题（见 core/norms.js 文件头）。
 * @property {string|null} citation
 * @property {string} [citationLabel]
 * @property {string} [referenceShort]
 * @property {string} [sampleNote]
 * @property {string} [provisionalNote]
 */

/**
 * @typedef {Object} SubmitPayload
 * @property {Record<number, number>} answers  { [题目id]: 1..7 }
 */

/**
 * @typedef {Object} SubmitResponse
 * @property {string} resultId
 * @property {number} A
 * @property {number} V
 * @property {number} zA
 * @property {number} zV
 * @property {string} type
 * @property {string} normsVersion
 */

/**
 * @typedef {Object} Entitlements
 * @property {boolean} single   是否已解锁单人深度报告
 * @property {boolean} duo      是否已解锁双人合盘
 * @property {string[]} orders  已完成的订单号
 */

/**
 * @typedef {Object} OrderPayload
 * @property {'single'|'duo'} plan
 * @property {string} [resultId]
 * @property {string} [channel]   'redeem-code' | 'stripe' | 'wechat' | 'manual'
 */

/**
 * @typedef {Object} OrderResponse
 * @property {string} orderId
 * @property {'single'|'duo'} plan
 * @property {number} amountCents     以分为单位，避免浮点误差
 * @property {string} currency
 * @property {'pending'|'paid'|'failed'|'expired'} status
 * @property {string|null} payUrl     若为空，说明走兑换码流程
 * @property {string} createdAt       ISO 8601
 */

/**
 * @typedef {Object} ReportPayload
 * @property {string} resultId
 * @property {string} typeKey
 * @property {Array<{title:string, body:string}>} sections
 * @property {string} generatedBy     'template' | 'llm'
 * @property {string} disclaimer
 */

/**
 * @typedef {Object} TrackPayload
 * @property {string} name
 * @property {Record<string, any>} props
 * @property {string} ts              ISO 8601
 */

/* ------------------------------------------------------------------ *
 * 错误
 * ------------------------------------------------------------------ */

export const ERROR_CODES = {
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',   // 该能力尚未实装（当前阶段预期会出现）
  NETWORK: 'NETWORK',
  TIMEOUT: 'TIMEOUT',
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  CONFLICT: 'CONFLICT',                 // 例：订单已支付后再兑
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVER: 'SERVER',
};

export class ApiError extends Error {
  /**
   * @param {string} code
   * @param {string} message   面向用户的中文提示
   * @param {object} [meta]
   */
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.meta = meta;
  }
  get isNotImplemented() { return this.code === ERROR_CODES.NOT_IMPLEMENTED; }
}

/** 便捷构造：未实装 */
export function notImplemented(method) {
  return new ApiError(
    ERROR_CODES.NOT_IMPLEMENTED,
    `「${method}」尚未接入后端。当前为免费本地运行模式，该功能会在后端就绪后开放。`,
    { method },
  );
}

/* ------------------------------------------------------------------ *
 * 适配器接口
 * ------------------------------------------------------------------ */

/**
 * @typedef {Object} ApiAdapter
 * @property {string} name
 * @property {(force?: boolean) => Promise<NormsPayload>} getNorms
 * @property {(payload: SubmitPayload) => Promise<SubmitResponse>} submitAnswers
 * @property {() => Promise<Entitlements>} getEntitlements
 * @property {(payload: OrderPayload) => Promise<OrderResponse>} createOrder
 * @property {(orderId: string) => Promise<OrderResponse>} getOrder
 * @property {(code: string, plan: 'single'|'duo') => Promise<Entitlements>} redeem
 * @property {(resultId: string) => Promise<ReportPayload>} getReport
 * @property {(payload: TrackPayload|TrackPayload[]) => Promise<{accepted:number}>} track
 */

/** 契约方法名单，供运行时自检：适配器缺方法会立刻报出来，而不是等页面崩 */
export const REQUIRED_METHODS = [
  'getNorms', 'submitAnswers', 'getEntitlements', 'createOrder',
  'getOrder', 'redeem', 'getReport', 'track',
];

/** 启动时自检适配器是否符合契约 */
export function assertAdapter(adapter) {
  const missing = REQUIRED_METHODS.filter((m) => typeof adapter?.[m] !== 'function');
  if (missing.length) {
    throw new Error(`API 适配器「${adapter?.name || 'unknown'}」缺少方法：${missing.join(', ')}`);
  }
  return true;
}
