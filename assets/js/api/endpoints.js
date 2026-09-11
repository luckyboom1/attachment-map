/**
 * API 端点表
 * ===========================================================================
 * 当前阶段：前端以 LocalAdapter 运行（纯本地，免费）。本表仅登记契约，
 * 不会被调用。等后端就绪后，把 CONFIG.mode 改成 'remote' 即可切换，
 * 业务代码一行不用改（见 api/index.js 的适配器切换）。
 *
 * 所有端点以 API_PREFIX 为前缀。版本放在路径里，便于将来并行发布。
 */

export const API_VERSION = 'v1';
export const API_PREFIX = `/api/${API_VERSION}`;

/** 端点清单。键名与 RemoteAdapter 的方法一一对应。 */
export const ENDPOINTS = {
  /** GET  —— 拉取当前常模参数。用于日后在服务端热更新切分点，无需重新部署前端。 */
  norms: `${API_PREFIX}/stats/norms`,

  /** POST —— 提交作答，服务端复算并留档（用于样本积累与常模重算）。 */
  submit: `${API_PREFIX}/results`,

  /** GET  —— 按 resultId 取回结果。用于跨设备查看与分享。 */
  result: (resultId) => `${API_PREFIX}/results/${encodeURIComponent(resultId)}`,

  /** GET  —— 查询当前会话的权益（是否已解锁单人报告 / 双人合盘）。 */
  entitlements: `${API_PREFIX}/entitlements`,

  /** POST —— 创建订单。 */
  createOrder: `${API_PREFIX}/orders`,

  /** GET  —— 轮询订单状态（支付是异步的，前端必须轮询或等待回调）。 */
  order: (orderId) => `${API_PREFIX}/orders/${encodeURIComponent(orderId)}`,

  /** POST —— 用兑换码解锁。过渡方案，绕开营业执照限制。 */
  redeem: `${API_PREFIX}/redeem`,

  /** POST —— 合盘数据的服务端版（可选）。若不用服务端，走 URL 编码即可。 */
  duo: `${API_PREFIX}/duo`,

  /** POST —— 行为埋点。批量上报，前端做本地缓冲。 */
  track: `${API_PREFIX}/events`,
};

/** 未启用后端时的请求配置（保留，便于切流） */
export const REQUEST_DEFAULTS = {
  timeoutMs: 8000,
  retries: 1,
  headers: { 'Content-Type': 'application/json' },
};
