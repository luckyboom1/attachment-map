/**
 * RemoteAdapter —— 后端就绪后使用（当前不实装）
 * ===========================================================================
 * 代码已完整实现，只是 CONFIG.mode 默认不是 'remote'，所以不会被调用。
 * 切换到后端时要做的事只有三件：
 *   1. assets/js/api/index.js 里把 CONFIG.mode 改成 'remote'
 *   2. 填 CONFIG.baseUrl
 *   3. 部署 server/ 下 openapi.yaml 定义的服务
 * 页面代码一行都不用改。
 *
 * 约定：所有失败都映射成 ApiError，页面层只看到中文提示 + 错误码。
 */

import { ENDPOINTS, REQUEST_DEFAULTS } from './endpoints.js';
import { ApiError, ERROR_CODES } from './contract.js';

/**
 * @param {string} baseUrl
 * @returns {import('./contract.js').ApiAdapter}
 */
export function createRemoteAdapter(baseUrl = '') {
  const root = String(baseUrl).replace(/\/$/, '');

  /** 统一的请求封装：超时、重试、错误映射 */
  async function request(path, { method = 'GET', body, retries = REQUEST_DEFAULTS.retries } = {}) {
    const url = `${root}${path}`;
    let lastErr = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_DEFAULTS.timeoutMs);
      try {
        const res = await fetch(url, {
          method,
          headers: { ...REQUEST_DEFAULTS.headers },
          body: body ? JSON.stringify(body) : undefined,
          signal: ctrl.signal,
          credentials: 'include',
        });
        clearTimeout(timer);

        if (res.status === 204) return null;
        const data = await res.json().catch(() => null);

        if (res.ok) return data;

        const code = mapStatus(res.status);
        // 4xx 不重试，重试也不会变好
        if (res.status < 500) {
          throw new ApiError(code, data?.message || '请求未被接受。', { status: res.status, path });
        }
        lastErr = new ApiError(code, data?.message || '服务暂时不可用。', { status: res.status, path });
      } catch (e) {
        clearTimeout(timer);
        if (e instanceof ApiError && e.code !== ERROR_CODES.SERVER) throw e;
        lastErr =
          e.name === 'AbortError'
            ? new ApiError(ERROR_CODES.TIMEOUT, '网络有点慢，请再试一次。', { path })
            : new ApiError(ERROR_CODES.NETWORK, '网络连接失败，请检查网络后重试。', { path });
        if (e instanceof ApiError) lastErr = e;
      }
    }
    throw lastErr || new ApiError(ERROR_CODES.SERVER, '服务暂时不可用。');
  }

  function mapStatus(status) {
    return (
      {
        400: ERROR_CODES.BAD_REQUEST,
        401: ERROR_CODES.UNAUTHORIZED,
        403: ERROR_CODES.UNAUTHORIZED,
        404: ERROR_CODES.NOT_FOUND,
        409: ERROR_CODES.CONFLICT,
        429: ERROR_CODES.RATE_LIMITED,
      }[status] || ERROR_CODES.SERVER
    );
  }

  return {
    name: 'remote',
    baseUrl: root,

    getNorms: () => request(ENDPOINTS.norms),

    submitAnswers: (payload) => request(ENDPOINTS.submit, { method: 'POST', body: payload }),

    getEntitlements: () => request(ENDPOINTS.entitlements),

    createOrder: (payload) => request(ENDPOINTS.createOrder, { method: 'POST', body: payload }),

    getOrder: (orderId) => request(ENDPOINTS.order(orderId)),

    redeem: (code, plan) => request(ENDPOINTS.redeem, { method: 'POST', body: { code, plan } }),

    getReport: (resultId, options = {}) =>
      request(`${ENDPOINTS.result(resultId)}/report?mode=${options.mode || 'single'}${options.partnerId ? `&partnerId=${encodeURIComponent(options.partnerId)}` : ''}`),

    track: (payload) =>
      request(ENDPOINTS.track, { method: 'POST', body: Array.isArray(payload) ? { events: payload } : payload, retries: 0 }),
  };
}

export default createRemoteAdapter;
