/**
 * 本地存储封装
 * ===========================================================================
 * 目的：把「存储」这件事收敛到一个文件，将来接后端时只需替换 api 适配器，
 * 页面层不直接碰 localStorage。
 *
 * 设计要点
 * 1. 隐私模式 / 无痕模式下 localStorage 可能抛异常，必须降级到内存，
 *    否则整个站点会在某些浏览器里直接白屏。
 * 2. 所有读取都带 try/catch，任何脏数据都当作"没有"处理，不让历史垃圾卡死用户。
 * 3. 键名统一在这里登记，禁止在业务代码里出现字符串字面量。
 */

const KEYS = {
  answers: 'am:answers',
  progress: 'am:progress',
  results: 'am:results',
  lastResultId: 'am:lastResultId',
  entitlements: 'am:entitlements',
  orders: 'am:orders',
  events: 'am:events',
  norms: 'am:norms-cache',
  theme: 'am:theme',
  history: 'am:history',
};

/* --------------------------- 存储后端选择 --------------------------- */

const memory = new Map();

function probe() {
  try {
    const k = '__am_probe__';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

const hasLS = typeof window !== 'undefined' && typeof window.localStorage !== 'undefined' && probe();
export const storageMode = hasLS ? 'localStorage' : 'memory';

/* ------------------------------- 基础读写 ------------------------------- */

export function get(key, fallback = null) {
  try {
    const raw = hasLS ? window.localStorage.getItem(key) : memory.get(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function set(key, value) {
  try {
    const raw = JSON.stringify(value);
    if (hasLS) window.localStorage.setItem(key, raw);
    else memory.set(key, raw);
    return true;
  } catch {
    // 配额满或隐私限制：静默降级到内存，不让用户看到报错
    try { memory.set(key, JSON.stringify(value)); } catch { /* 彻底放弃 */ }
    return false;
  }
}

export function remove(key) {
  try {
    if (hasLS) window.localStorage.removeItem(key);
    else memory.delete(key);
  } catch { /* ignore */ }
}

/** 只清理本应用的键，绝不碰其他站点/其他应用的数据 */
export function clearAll() {
  Object.values(KEYS).forEach(remove);
  memory.clear();
}

/* ------------------------------- 领域封装 ------------------------------- */

export const store = {
  KEYS,

  /* --- 作答 --- */
  saveAnswers(map) { return set(KEYS.answers, map); },
  loadAnswers() { return get(KEYS.answers, {}); },

  saveProgress(state) { return set(KEYS.progress, state); },
  loadProgress() { return get(KEYS.progress, null); },
  clearProgress() { remove(KEYS.progress); },

  /* --- 结果 --- */
  saveResult(result) {
    const id = result.resultId || newId('r');
    const all = get(KEYS.results, {});
    all[id] = { ...result, resultId: id, savedAt: new Date().toISOString() };
    set(KEYS.results, all);
    set(KEYS.lastResultId, id);

    const hist = get(KEYS.history, []);
    hist.unshift({ id, type: result.type, A: result.A, V: result.V, at: new Date().toISOString() });
    set(KEYS.history, hist.slice(0, 30));
    return id;
  },
  getResult(id) { return get(KEYS.results, {})[id] || null; },
  lastResultId() { return get(KEYS.lastResultId, null); },
  getHistory() { return get(KEYS.history, []); },

  /* --- 权益与订单 --- */
  getEntitlements() {
    return get(KEYS.entitlements, { single: false, duo: false, orders: [] });
  },
  setEntitlements(patch) {
    const cur = store.getEntitlements();
    const next = { ...cur, ...patch };
    set(KEYS.entitlements, next);
    return next;
  },
  saveOrder(order) {
    const all = get(KEYS.orders, {});
    all[order.orderId] = order;
    set(KEYS.orders, all);
    return order;
  },
  getOrder(orderId) { return get(KEYS.orders, {})[orderId] || null; },

  /* --- 常模缓存 --- */
  cacheNorms(payload) { return set(KEYS.norms, { ...payload, cachedAt: new Date().toISOString() }); },
  loadNormsCache() { return get(KEYS.norms, null); },

  /* --- 埋点缓冲 --- */
  bufferEvent(evt) {
    const list = get(KEYS.events, []);
    list.push(evt);
    set(KEYS.events, list.slice(-200));   // 只留最近 200 条，避免撑爆配额
  },
  drainEvents() {
    const list = get(KEYS.events, []);
    set(KEYS.events, []);
    return list;
  },

  /* --- 主题 --- */
  saveTheme(theme) { return set(KEYS.theme, theme); },
  loadTheme() { return get(KEYS.theme, null); },
};

/* ------------------------------- 工具 ------------------------------- */

export function newId(prefix = 'x') {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
    }
  } catch { /* ignore */ }
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
