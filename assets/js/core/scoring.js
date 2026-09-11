/**
 * 计分模块 —— 确定性算法，全站唯一的结果来源
 * ===========================================================================
 * 铁律
 * 1. 本文件必须满足「同输入必得同输出」。不得引入随机数、时间戳、网络请求。
 * 2. 大模型（AI）不得参与本文件任何一步。AI 只能在结果算完之后，
 *    拿 (zA, zV, type) 去写解读文案。让模型读原始答案判类型 = P0 事故，
 *    因为同一用户复测会得到不同类型，产品可信度一次性归零。
 * 3. 所有数值计算在浏览器内完成，不上传答案。
 */

import { QUESTIONS } from '../data/questions.js';
import { NORMS, toZ, zToPercentile } from './norms.js';
import { classify } from './types.js';

const MIN = NORMS.scaleMin;
const MAX = NORMS.scaleMax;

const clampScale = (v) => Math.min(MAX, Math.max(MIN, Number(v)));

/**
 * 反向计分：x' = (scaleMin + scaleMax) - x
 * 7 点量表下即 8 - x。
 */
function reverseScore(v) {
  return MIN + MAX - v;
}

/**
 * @typedef {Object} ScoreResult
 * @property {number} A            焦虑维度均分（1–7）
 * @property {number} V            回避维度均分（1–7）
 * @property {number} zA           焦虑标准分（相对已发表参照样本）
 * @property {number} zV           回避标准分（相对已发表参照样本）
 * @property {number} pctA         焦虑百分位 0–100（参照已发表样本）
 * @property {number} pctV         回避百分位 0–100（参照已发表样本）
 * @property {string} type         类型 key
 * @property {'low'|'mid'|'high'} bandA  焦虑强度分档（与类型判定同一基准：量表中点）
 * @property {object} quality      作答质量标记
 * @property {Array}  detail       逐题明细，用于报告与调试
 */

/**
 * 核心计分
 *
 * 两套基准，刻意分开、绝不混用：
 *   类型 + 强度分档 → 与量表中点（NORMS.cut）比较，判定「算不算高」
 *   标准分 + 百分位 → 与已发表样本（NORMS.anxiety/avoidance 的 mean/sd）比较，
 *                    回答「相对参照样本处在什么位置」
 *
 * @param {Record<number, number>} rawAnswers  { [题目id]: 1..7 }
 * @returns {ScoreResult}
 */
export function score(rawAnswers) {
  const detail = [];
  const missing = [];

  let sumA = 0, nA = 0;
  let sumV = 0, nV = 0;
  const rawValues = [];

  for (const q of QUESTIONS) {
    const raw = rawAnswers?.[q.id];
    if (raw == null || Number.isNaN(Number(raw))) {
      missing.push(q.id);
      continue;
    }
    const v = clampScale(raw);
    rawValues.push(v);
    const scored = q.reverse ? reverseScore(v) : v;

    if (q.dimension === 'anxiety') { sumA += scored; nA++; }
    else { sumV += scored; nV++; }

    detail.push({
      id: q.id, code: q.code, dimension: q.dimension,
      reverse: q.reverse, raw: v, scored,
      /** 该题得分相对参照样本均值的偏离，仅用于诊断，不参与判定 */
      contribution: q.dimension === 'anxiety'
        ? (scored - NORMS.anxiety.mean)
        : (scored - NORMS.avoidance.mean),
    });
  }

  const A = nA ? sumA / nA : (MIN + MAX) / 2;
  const V = nV ? sumV / nV : (MIN + MAX) / 2;

  const zA = toZ(A, NORMS.anxiety);
  const zV = toZ(V, NORMS.avoidance);
  const type = classify(A, V);

  return {
    A: round2(A),
    V: round2(V),
    zA: round2(zA),
    zV: round2(zV),
    pctA: zToPercentile(zA),
    pctV: zToPercentile(zV),
    type,
    bandA: bandOf(A, 'anxiety'),
    bandV: bandOf(V, 'avoidance'),
    quality: assessQuality(rawValues, missing, detail),
    detail,
    computedAt: null,          // 刻意留空：本模块不产生时间戳，保证纯函数
    normsVersion: NORMS.version,
  };
}

/**
 * 维度强度分档。基准与类型判定一致——都用切分点（量表中点），
 * 不用样本均值。否则会出现「类型判为低回避，分档却显示高」的自相矛盾。
 * @param {number} raw
 * @param {'anxiety'|'avoidance'} dimension
 */
function bandOf(raw, dimension) {
  const center = NORMS.cut[dimension];
  const half = NORMS.cut.band;
  if (raw <= center - half) return 'low';
  if (raw >= center + half) return 'high';
  return 'mid';
}

function round2(n) { return Math.round(n * 100) / 100; }

/**
 * 作答质量评估。不是为了「指责用户」，而是为了在结果不可靠时
 * 如实告诉用户，避免他们拿一个噪声结果去定义自己。
 */
function assessQuality(rawValues, missing, detail) {
  const total = QUESTIONS.length;
  const answered = rawValues.length;
  const flags = [];

  if (answered < total) {
    flags.push({ code: 'incomplete', level: 'error', message: `还有 ${total - answered} 题未作答。` });
  }

  if (answered >= 5) {
    const first = rawValues[0];
    const straight = rawValues.every((v) => v === first);
    if (straight) {
      flags.push({
        code: 'straight-lining', level: 'warn',
        message: '你的所有选项完全相同。这份结果可能无法反映你的真实倾向，建议换一段时间重测。',
      });
    }
  }

  if (answered >= 5) {
    const uniq = new Set(rawValues).size;
    if (uniq <= 2) {
      flags.push({
        code: 'low-variance', level: 'warn',
        message: '你的选项集中在很小的范围内，维度分辨力会下降。',
      });
    }
  }

  const midCount = rawValues.filter((v) => v === 4).length;
  if (answered >= 10 && midCount / answered > 0.6) {
    flags.push({
      code: 'mid-heavy', level: 'warn',
      message: '超过六成题目你选了「说不上」。这通常是还没想清楚，而不是真的中立。',
    });
  }

  return {
    answered, total, missing,
    ok: flags.every((f) => f.level !== 'error'),
    flags,
  };
}

/**
 * 维度强度文案（供结果页使用，避免各处重复写死阈值）
 */
export function bandText(band, dimension) {
  const isAnx = dimension === 'anxiety';
  const map = {
    anxiety: {
      low: '你不容易因为关系里的风吹草动而动摇。',
      mid: '你有时会在意，但大多能自己缓过来。',
      high: '关系里的不确定感，会明显牵着你的情绪走。',
    },
    avoidance: {
      low: '你能比较自然地依赖别人，也接受别人依赖你。',
      mid: '你愿意靠近，但会保留一部分自己的空间。',
      high: '亲密到一定程度时，你会本能地想退开一点。',
    },
  };
  return (isAnx ? map.anxiety : map.avoidance)[band];
}

/** 距离归一化用的最大可能距离（两个维度各自跨度的直角边） */
export const MAX_DISTANCE = Math.hypot(MAX - MIN, MAX - MIN);
