/**
 * 答案编解码 —— 双人合盘的「零后端」实现基础
 * ===========================================================================
 * 设计意图
 * 把两个人的答案直接编码进 URL，而不是存进数据库。收益是五个零：
 *   零后端 · 零数据库 · 零用户数据存储 · 零泄露风险 · 零服务器成本
 * 并且天然满足「对方没测之前不显示结果」——因为对方的数据物理上还不存在，
 * 不需要任何权限校验，架构本身就把这件事解决了。
 *
 * 编码方案：每个答案 1..7 → 0..6，占 3 bit；36 题共 108 bit → 14 byte
 *          → base64url ≈ 19 字符。加上两个答案，链接增量约 40 字符。
 *
 * 兼容性：依赖 btoa / atob。浏览器与 Node 16+ 均可用。
 */

import { TOTAL_QUESTIONS, QUESTIONS } from '../data/questions.js';

const BITS_PER_ANSWER = 3;                                  // 0..6 需要 3 bit
const TOTAL_BITS = TOTAL_QUESTIONS * BITS_PER_ANSWER;        // 108
const BYTE_LEN = Math.ceil(TOTAL_BITS / 8);                 // 14

const B64_URL_SAFE = /[+/=]/;

/* ------------------------------- base64url ------------------------------- */

function toBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  const clean = String(str).trim();
  if (!clean) return null;
  const pad = clean.length % 4 === 0 ? '' : '='.repeat(4 - (clean.length % 4));
  const b64 = clean.replace(/-/g, '+').replace(/_/g, '/') + pad;
  let bin;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ------------------------------- 编解码 ------------------------------- */

/**
 * 合法编码串的字符长度。由编码器自身推导，题量变化时会自动跟着变。
 * 为什么要校验长度：base64url 对任意字符串都能解出字节，长度不对的输入
 * 会"成功"解出一串看似合法的答案（例如 'aaaa…' 也能解出数字）。
 * 不做长度校验，就等于把垃圾当成用户的真实作答。
 */
const EXPECTED_CHARS = toBase64Url(new Uint8Array(BYTE_LEN)).length;

/**
 * 把 36 个原始答案（按 QUESTIONS 顺序，值 1..7）编码成短串
 * @param {number[]} values
 * @returns {string}
 */
export function encodeAnswers(values) {
  if (!Array.isArray(values) || values.length !== TOTAL_QUESTIONS) {
    throw new Error(`答案数量必须是 ${TOTAL_QUESTIONS}，实际 ${values?.length}`);
  }
  const bytes = new Uint8Array(BYTE_LEN);
  let pos = 0;

  for (const v of values) {
    const n = Math.max(0, Math.min(6, Math.round(Number(v)) - 1));
    for (let shift = BITS_PER_ANSWER - 1; shift >= 0; shift--) {
      if ((n >> shift) & 1) bytes[pos >> 3] |= 1 << (7 - (pos & 7));
      pos++;
    }
  }
  return toBase64Url(bytes);
}

/**
 * 解码回 36 个答案。任何非法输入一律返回 null，绝不抛异常上抛到 UI。
 * @param {string} code
 * @returns {number[]|null}  长度 36，值 1..7
 */
export function decodeAnswers(code) {
  if (!code || typeof code !== 'string') return null;
  const clean = code.trim();
  // 长度必须与编码器产出一致，否则一律视为无效链接
  if (clean.length !== EXPECTED_CHARS) return null;

  const bytes = fromBase64Url(clean);
  if (!bytes || bytes.length !== BYTE_LEN) return null;

  const out = [];
  let pos = 0;
  for (let k = 0; k < TOTAL_QUESTIONS; k++) {
    let n = 0;
    for (let i = 0; i < BITS_PER_ANSWER; i++) {
      n = (n << 1) | ((bytes[pos >> 3] >> (7 - (pos & 7))) & 1);
      pos++;
    }
    if (n > 6) return null;        // 越界 → 说明不是本方案产出的串
    out.push(n + 1);
  }
  return out;
}

/* --------------------------- 与答案对象的互转 --------------------------- */

/** { [id]: 1..7 } → [1..7] × 36（按 QUESTIONS 顺序） */
export function answersToArray(rawMap) {
  return QUESTIONS.map((q) => {
    const v = rawMap?.[q.id];
    return v == null ? null : Math.max(1, Math.min(7, Math.round(Number(v))));
  });
}

/** [1..7] × 36 → { [id]: 1..7 } */
export function arrayToAnswers(values) {
  const out = {};
  QUESTIONS.forEach((q, i) => {
    if (values[i] != null) out[q.id] = values[i];
  });
  return out;
}

/** 是否已答满 */
export function isComplete(rawMap) {
  return QUESTIONS.every((q) => rawMap?.[q.id] != null);
}

/* ------------------------------- URL 组装 ------------------------------- */

/**
 * 生成「邀请另一半」的链接。
 * 此时只带发起方的答案，对方的数据物理上还不存在 —— 所以对方没测完，
 * 合盘结果无处可算。这是设计约束，不是权限校验。
 * @param {string} baseUrl  当前页面地址（不含 query）
 * @param {number[]} aValues 发起方答案
 */
export function buildInviteUrl(baseUrl, aValues) {
  const url = new URL(baseUrl, window.location.href);
  url.search = '';
  url.searchParams.set('a', encodeAnswers(aValues));
  return url.toString();
}

/**
 * 生成最终合盘链接（双方答案都齐了）
 */
export function buildDuoUrl(baseUrl, aValues, bValues) {
  const url = new URL(baseUrl, window.location.href);
  url.search = '';
  url.searchParams.set('a', encodeAnswers(aValues));
  url.searchParams.set('b', encodeAnswers(bValues));
  return url.toString();
}

/** 从 URL 读取双方答案 */
export function readDuoFromUrl(search = window.location.search) {
  const p = new URLSearchParams(search);
  const a = decodeAnswers(p.get('a'));
  const b = decodeAnswers(p.get('b'));
  return { a, b, ready: !!(a && b) };
}

export const ENCODED_LENGTH = { bytes: BYTE_LEN, bits: TOTAL_BITS };
export { B64_URL_SAFE };
