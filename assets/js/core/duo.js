/**
 * 双人适配 —— 距离算法 + 规则层
 * ===========================================================================
 * 为什么要两层，而不是只给一个适配分
 * ---------------------------------------------------------------------------
 * 单看距离分会把「焦虑 × 回避」这一对和普通差异混为一谈。而这一对在文献里
 * 是最稳定的负性互动循环（追逃循环 / anxious–avoidant trap），它的中等距离
 * 分极具误导性。所以命中这一对时，我们不给通用适配分，而是直接输出专属模块。
 *
 * 基线层（本文件实现）：
 *   d = √(ΔA² + ΔV²)，再用最大可能距离归一化
 * 严谨层（V1 实现，接口已预留）：
 *   APIM 主体-客体互依模型，分离 actor effect 与 partner effect
 */

import { MAX_DISTANCE } from './scoring.js';
import { getType } from './types.js';

/** 适配度分档 */
function fitBand(score) {
  if (score >= 80) return { key: 'high', label: '高契合', hint: '你们的互动节奏大概率是省力的。' };
  if (score >= 60) return { key: 'mid-high', label: '较契合', hint: '差异不大，个别场景需要磨合。' };
  if (score >= 40) return { key: 'mid', label: '中等', hint: '你们的差异点集中在某一两个维度上，可以针对性聊开。' };
  return { key: 'low', label: '差异较大', hint: '你们对亲密的默认设定不太一样，需要更明确地协商。' };
}

/**
 * 十组配对的互动规律。键为两个 type key 排序后用 | 连接。
 * 文案红线：不评判谁对谁错，不给「分手/在一起」的结论，只描述机制与可操作动作。
 */
const PAIR_NOTES = {
  'secure|secure': {
    title: '双安全型：低摩擦组合',
    dynamics: '两个人都能开口要，也都能各自安好。你们最大的风险不是冲突，而是"都太客气"，把一些小问题一直搁着不谈，直到某天突然发现积了厚厚一层。',
    advice: ['每两周留一次 20 分钟，专门聊"最近有没有什么没说出口的"。', '别把稳定当成理所当然，主动表达欣赏。'],
  },
  'anxious|secure': {
    title: '安全底座 + 高敏感雷达',
    dynamics: '安全型那一方如果能稳定回应，焦虑型的不安全感会被显著缓冲——这是所有配对里预后较好的一组。但只要安全型那方开始"懒得解释"，焦虑方会迅速升级动作。',
    advice: ['焦虑方把"试探"换成"直说"：我需要你现在回我一句，而不是等对方猜。', '安全方不要用"你想多了"回应，改成"我在，你继续说"。'],
  },
  'avoidant|secure': {
    title: '稳定陪伴 + 需要空间',
    dynamics: '安全型不追不逼的时候，回避型会慢慢把距离收回来。反过来，一旦安全方开始要求"你得多表达"，回避方会退得更快。',
    advice: ['回避方把"消失"换成"预告"：我需要两小时，之后我找你。', '安全方接受"少而真"的表达，不要用表达频率衡量在不在意。'],
  },
  'fearful|secure': {
    title: '可预期性是最好的药',
    dynamics: '恐惧型的推拉需要一个不因推拉而崩溃的人。安全型恰好能提供这个底。这是四组里改善空间最大的一组，但也最考验安全方的耐心。',
    advice: ['把关系里的模糊地带尽量清空：固定联系节奏、明确边界。', '安全方要守住自己的情绪边界，长期做"情绪垃圾桶"会耗损。'],
  },
  'anxious|anxious': {
    title: '双高焦虑：情绪共振放大器',
    dynamics: '两个人都极度敏感，也都极度需要确认。好处是共情极快，坏处是任何一方情绪波动都会被另一方瞬间放大，争吵密度会很高。',
    advice: ['给冲突设一个暂停键：任一方说"停 30 分钟"就真的停。', '把确认需求写下来，改成固定节奏的"报到"，而不是随时随地的试探。'],
  },
  'anxious|avoidant': {
    title: '追逃循环：最需要被点破的一组',
    trap: true,
    dynamics: '这是文献里最稳定、也最消耗的负性互动模式。焦虑方一感到疏远就升级靠近（追问、加码付出），回避方一感到压力就后退（沉默、忙碌、消失）。焦虑方把后退解读为"他不在乎"，回避方把靠近解读为"她太黏人"，双方都在用自己最害怕的方式解释对方的行为，于是循环自我加固。关键认识是：你们的痛苦不是"爱不爱"的问题，而是两套依恋策略在互相触发。',
    advice: [
      '给循环命名：当它再次启动时，任一方说出"我们现在在追逃"，命名本身就能降低强度。',
      '回避方给"预告"而非"消失"；焦虑方把追问推迟 30 分钟，先做一件与对方无关的事。',
      '把"我要你多陪我"翻译成具体请求（今晚 9 点聊 15 分钟），模糊的需求是循环的燃料。',
    ],
  },
  'anxious|fearful': {
    title: '高焦虑 × 恐惧：双方都在要确认',
    dynamics: '两个人都在高强度地渴望确认，也都在不同层面上害怕被抛弃。区别在于恐惧型会先退再追，焦虑型会一直追。这组的关系体验常常是"过山车"。',
    advice: ['把节奏拉慢：减少高强度沟通的时长，增加频率的稳定性。', '冲突后不要立刻复盘，给彼此 2 小时冷静期再谈。'],
  },
  'avoidant|avoidant': {
    title: '双回避：安静但容易空心',
    dynamics: '很少吵架，表面稳定，但两个人可能长期各过各的。风险不是冲突，而是关系慢慢失去温度，最后两个人都觉得"像室友"。',
    advice: ['每周安排一次必须共同完成的小事，制造非自愿的靠近。', '练习说一件"今天我有点难受"，不需要解决方案，只需要被听到。'],
  },
  'avoidant|fearful': {
    title: '退缩 × 推拉：容易错过',
    dynamics: '恐惧型在靠近时，回避型正好在后退；恐惧型退开后，回避型才松一口气。两个人的节拍常常错开，容易互相判定为"不合适"。',
    advice: ['把"什么时候能谈"提前约好，而不是随情绪临时决定。', '双方都要练习把"我需要空间"和"我不想要你"分开说清楚。'],
  },
  'fearful|fearful': {
    title: '双恐惧：高张力组合',
    dynamics: '两个人都同时想靠近又怕受伤，关系里会出现双重的推拉。短期内强度很高，长期极耗心力，需要双方都有较强的自我觉察才能维持。',
    advice: ['把可预期性做到极致：固定节奏、明确承诺、说到做到。', '各自建立关系之外的支持系统，不要把全部情绪重量压在对方身上。'],
  },
};

function pairKey(typeA, typeB) {
  return [typeA, typeB].sort().join('|');
}

/**
 * 取某一组配对的互动规律。
 * 报告模块也用它来生成「与不同类型相处」一章，保证文案只有一份来源。
 */
export function getPairNote(typeA, typeB) {
  return PAIR_NOTES[pairKey(typeA, typeB)] || PAIR_NOTES['secure|secure'];
}

/** 供报告模块遍历四类型 */
export const TYPE_KEYS = ['secure', 'anxious', 'avoidant', 'fearful'];

/**
 * @typedef {Object} DuoResult
 * @property {number} distance        欧氏距离（1–7 单位的二维平面）
 * @property {number} normalized      归一化距离 0–1
 * @property {number} fitScore        适配度 0–100
 * @property {boolean} trap           是否命中追逃循环
 * @property {string} pairKey
 * @property {object} note            互动规律文案
 * @property {object} delta           两个维度的差值（带符号）
 * @property {string} headline
 */

/**
 * 计算双人适配
 * @param {import('./scoring.js').ScoreResult} resA
 * @param {import('./scoring.js').ScoreResult} resB
 * @returns {DuoResult}
 */
export function computeDuo(resA, resB) {
  const dA = round2(resA.A - resB.A);
  const dV = round2(resA.V - resB.V);

  const distance = Math.hypot(dA, dV);
  const normalized = Math.min(1, distance / MAX_DISTANCE);
  let fitScore = Math.round((1 - normalized) * 100);

  const key = pairKey(resA.type, resB.type);
  const note = PAIR_NOTES[key] || PAIR_NOTES['secure|secure'];
  const trap = !!note.trap;

  // 追逃循环是规则优先：命中时不展示通用适配分，避免中等距离分造成误导。
  const band = trap ? { key: 'trap', label: '追逃模式', hint: '先看下面的循环解析，比看分数有用。' } : fitBand(fitScore);

  const headline = buildHeadline(dA, dV, resA, resB, trap);

  return {
    distance: round2(distance),
    normalized: round2(normalized),
    fitScore: trap ? null : fitScore,       // trap 时不给分
    rawFitScore: fitScore,                   // 保留原始值，便于埋点分析
    trap,
    band,
    pairKey: key,
    note,
    delta: { anxiety: dA, avoidance: dV },
    types: { a: getType(resA.type), b: getType(resB.type) },
    headline,
  };
}

/** 用一句人话指出最大的差距在哪里 */
function buildHeadline(dA, dV, resA, resB, trap) {
  if (trap) return '你们大概率不是不爱，而是两套依恋策略在互相触发。';

  const absA = Math.abs(dA);
  const absV = Math.abs(dV);
  const who = dA > 0 ? '前者' : '后者';

  if (absA < 0.5 && absV < 0.5) {
    return '你们在「要不要靠近」这件事上的默认设定几乎一致。';
  }
  if (Math.abs(absA - absV) < 0.4) {
    return '你们在两个维度上的差异比较均衡，没有哪一项特别突出。';
  }
  if (absA > absV) {
    return `你们最大的差别在「对失去的敏感程度」上——${who}更需要确定的回应。`;
  }
  return `你们最大的差别在「对亲密的舒适区」上——${who}更需要保留自己的空间。`;
}

function round2(n) { return Math.round(n * 100) / 100; }

/** 供结果页绘制四象限散点使用 */
export function toQuadPoint(res) {
  return { anxiety: res.A, avoidance: res.V, type: res.type };
}

/**
 * 预留：APIM 严谨版的接入点。
 * 背景要求 30 对以上的配对样本才能估参数，当前不实装。
 * @returns {null}
 */
export function computeApim() {
  return null;
}
