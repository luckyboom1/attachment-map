/**
 * 常模与切分参数
 * ===========================================================================
 * 这是全站唯一可以「改变用户测出什么类型」的文件。改动前请读完本注释。
 *
 * 现状（2026-09-11 更新）
 * ---------------------------------------------------------------------------
 * 已从「暂定值」升级为**引用公开发表的中国大学生样本**。
 * 但必须分清两件事，它们在数学上是两个不同的东西：
 *
 *   cut（切分点 = 4.0）
 *       回答「你在本站题目上算不算高」。
 *       取量表理论中点，依据有两条：
 *         (1) 本站 36 题按 1–7 同意度编制，4 = 中性，这是量表设计本身的中点；
 *         (2) 中文文献对 ECR/ECR-R 四型的定界惯例就是「取两维度均分，以 4 分为界」。
 *       不用他方样本的均值当切分点——那等于假设本站题目与 ECR 原题逐题等价，
 *       而本站题目是该构念的改写版本，这个假设不成立。
 *
 *   mean / sd（= 3.77/0.85 与 3.40/0.82）
 *       回答「你相对已发表的中国大学生样本处在什么位置」。
 *       只用于百分位，UI 上必须写明参照的是哪个样本。
 *
 * 为什么必须分开：若两者混用，会出现「百分位 77，却被判为低回避」这类自相矛盾的
 * 输出——因为本站题本没有自己的实测分布，而借用来的样本均值（3.40）低于量表中点（4.0）。
 *
 * 升级路径（按优先级）
 * ---------------------------------------------------------------------------
 * 1. 目前状态：引用公开发表的中国样本 → source = 'published'。
 * 2. 用本站真实样本的中位数重算切分 → 服务端实现 GET /api/v1/stats/norms，
 *    把 source 改为 'site-sample'。这一步会把 cut 从「量表中点」换成
 *    「本站样本中位数」，届时站内百分位与类型判定才真正统一到同一参照系。
 * 3. 两者都拿不到 → 不输出四类型标签，只展示两个维度分与百分位。
 *
 * 明令禁止
 * ---------------------------------------------------------------------------
 * 1. 禁止直接套用美国/西方样本的 mean / sd。中文样本的依恋焦虑均值系统性偏高，
 *    用错常模会把大批用户误判为焦虑型。
 * 2. 禁止在没有本站数据的情况下把 cut 改成引用样本的均值。见上文「为什么必须分开」。
 */

export const NORMS = {
  version: 'cn-ecr-2010',
  /** 'provisional' | 'published' | 'site-sample' */
  source: 'published',
  updatedAt: '2026-09-11',

  /* ---------------- 百分位参照：已发表的中国大学生样本 ---------------- */

  /** 焦虑维度参照值 */
  anxiety: { mean: 3.77, sd: 0.85 },
  /** 回避维度参照值 */
  avoidance: { mean: 3.40, sd: 0.82 },

  /* ---------------- 类型判定：量表中点 ---------------- */

  cut: {
    anxiety: 4.0,
    avoidance: 4.0,
    /** 'scale-midpoint' | 'sample-median' */
    basis: 'scale-midpoint',
    /** 分档带：cut ± band 之外才判高/低，中间留给「说不清」 */
    band: 0.5,
  },

  /** 量表跨度，用于距离归一化 */
  scaleMin: 1,
  scaleMax: 7,

  /* ---------------- 出处 ---------------- */

  citation:
    '李梦霞, 周蓓蓓, 何新芳, 章海鸥, 俞婷婷. 大学生成人依恋与网络依赖关系[J]. 中国公共卫生, 2010, 26(7): 864-866.',
  citationLabel: '李梦霞等（2010）· 中国公共卫生 26(7): 864-866',
  /** 空间紧张处（维度条、图表标注）用的一句话参照名 */
  referenceShort: '中国大学生样本 N=547（李梦霞等，2010）',

  sampleNote:
    '百分位参照：浙江省 6 所高校有恋爱经历的大学生，有效样本 547 人（男 263 / 女 284），年龄 18–24 岁；' +
    '题本为李同归、加藤和生（2006）修订的 ECR 中文版（36 题，7 点计分，心理学报 38(3): 399-406）。',

  /**
   * 同期中国大学生样本的交叉核对。
   * 存在的意义：不给出一个孤零零的点估计，让人能看到波动范围有多大。
   */
  crossCheck: [
    {
      label: '田瑞琪. 大学生成人依恋测量及相关人格研究[D]. 上海师范大学硕士学位论文, 2004: 48-49.',
      short: '田瑞琪（2004）· 上海师大硕士论文',
      n: null,
      anxiety: 3.54, anxietySd: 0.84,
      avoidance: 3.14, avoidanceSd: 0.82,
      note: '国内 ECR 早期基线，被后续文献广泛引用',
    },
    {
      label: '李梦霞, 周蓓蓓, 何新芳, 章海鸥, 俞婷婷. 大学生成人依恋与网络依赖关系[J]. 中国公共卫生, 2010, 26(7): 864-866.',
      short: '李梦霞等（2010）· 中国公共卫生 26(7)',
      n: 547,
      anxiety: 3.77, anxietySd: 0.85,
      avoidance: 3.40, avoidanceSd: 0.82,
      primary: true,
      note: '本站采用的参照样本',
    },
    {
      label: 'The influence of insecure attachment on undergraduates\' jealousy: the mediating effect of self-differentiation[J]. Frontiers in Psychology, 2023, 14: 1153866.',
      short: 'Frontiers in Psychology（2023）· 昆明医科大学',
      n: 477,
      anxiety: 3.60, anxietySd: 0.81,
      avoidance: 3.47, avoidanceSd: 0.80,
      note: '普通大学生样本',
    },
    {
      label: '李晓敏, 高文斌, 罗静, 杜玉凤. 农村留守经历大学生成人依恋及影响因素分析[J]. 中国公共卫生, 2010, 26(6): 748-750.',
      short: '李晓敏等（2010）· 中国公共卫生 26(6)',
      n: 1062,
      anxiety: 3.82, anxietySd: 0.82,
      avoidance: 4.16, avoidanceSd: 0.53,
      note: '特殊亚群体（童年留守经历），回避维度显著高于普通样本',
    },
  ],

  spreadNote:
    '其中普通大学生样本（前三条）：依恋焦虑 3.54–3.77，依恋回避 3.14–3.47，跨研究差异约 ±0.2，属正常范围。' +
    '亚群体（如童年留守经历）会明显偏移——这说明「群体定位」本身有不确定性，不宜当成精确刻度。',

  itemSetCaveat:
    '本站 36 题是该构念的改写版本，不是 ECR 原题。所以百分位是「参照上述已发表样本」的位置，' +
    '不是在本题本上重新标定的结果；类型判定用的是量表中点 4.0，不是样本中位数。' +
    '两者口径已在结果页分别写明。',

  /* ---------------- 兜底：source 为 provisional 时的文案 ---------------- */

  provisionalLabel: '暂定切分',
  provisionalNote:
    '当前切分点基于量表理论中点计算，尚未使用本土实证常模。它足以判断你的倾向方向，但不宜当作精确的群体定位。',

  /** 仅供报告页/关于页头部一句话摘要使用 */
  summary: '类型以量表中点 4.0 为界；百分位参照李梦霞等（2010）中国大学生样本（N=547）。',
};

/**
 * 用户能否看到四类型标签。source === 'provisional' 时仍展示，但必须带标注。
 */
export const SHOW_TYPE_LABEL = true;

/** 是否强制展示常模说明。三种 source 都必须展示，只是文案不同。 */
export const MUST_DISCLOSE_NORMS = true;

/** 是否处于「暂定切分」状态（用于选中不同文案，不是「要不要展示」的开关） */
export const MUST_DISCLOSE_PROVISIONAL = NORMS.source === 'provisional';

/**
 * 常模说明文案，供结果页 / 入口页 / 方法说明页共用，避免三处各写一遍导致口径漂移。
 * @returns {{label:string, text:string, short:string, citation:string|null, citationLabel:string|null}}
 */
export function normsDisclosure() {
  if (NORMS.source === 'published') {
    return {
      label: '常模参照',
      text: `${NORMS.sampleNote}${NORMS.spreadNote}${NORMS.itemSetCaveat}`,
      short:
        `类型以量表中点 ${NORMS.cut.anxiety} 为界；百分位参照${NORMS.referenceShort}。` +
        '本站题目是该构念的改写版，所以百分位是「参照」而不是在本站题目上标定的结果。',
      citation: NORMS.citation,
      citationLabel: NORMS.citationLabel,
    };
  }
  if (NORMS.source === 'site-sample') {
    const text = '百分位与切分点均基于本站累积作答样本重算，会随样本量增长而更新。';
    return { label: '本站样本', text, short: text, citation: null, citationLabel: null };
  }
  return {
    label: NORMS.provisionalLabel,
    text: NORMS.provisionalNote,
    short: NORMS.provisionalNote,
    citation: null,
    citationLabel: null,
  };
}

/**
 * 把 1–7 的原始均分转成标准分（Z）。
 * 注意：z 只用于「百分位」——即相对已发表样本的位置，不用于类型判定。
 * @param {number} raw  维度均分
 * @param {{mean:number, sd:number}} norm
 */
export function toZ(raw, norm) {
  const sd = norm.sd > 0 ? norm.sd : 1;
  return (raw - norm.mean) / sd;
}

/**
 * 判断某维度是否越过切分点。切分点与常模均值是两个不同概念，见文件头。
 * @param {number} raw
 * @param {'anxiety'|'avoidance'} dimension
 */
export function overCut(raw, dimension) {
  return raw > NORMS.cut[dimension];
}

/**
 * 由 Z 分数估算百分位（正态近似）。
 * 用于给用户一个「你在这群人里大概什么位置」的参照。
 * @param {number} z
 * @returns {number} 0–100
 */
export function zToPercentile(z) {
  // Abramowitz & Stegun 7.1.26 近似，误差 < 7.5e-8
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  const cdf = z > 0 ? 1 - p : p;
  return Math.round(Math.max(0, Math.min(1, cdf)) * 100);
}

/**
 * 运行时替换常模（用于从 /api/v1/stats/norms 拉取后热更新，无需重新部署）。
 * @param {Partial<typeof NORMS>} patch
 */
export function applyRemoteNorms(patch) {
  if (!patch || typeof patch !== 'object') return NORMS;
  if (patch.anxiety) Object.assign(NORMS.anxiety, patch.anxiety);
  if (patch.avoidance) Object.assign(NORMS.avoidance, patch.avoidance);
  if (patch.cut) Object.assign(NORMS.cut, patch.cut);
  if (patch.source) NORMS.source = patch.source;
  if (patch.version) NORMS.version = patch.version;
  if (patch.citation !== undefined) NORMS.citation = patch.citation;
  if (patch.citationLabel !== undefined) NORMS.citationLabel = patch.citationLabel;
  if (patch.sampleNote !== undefined) NORMS.sampleNote = patch.sampleNote;
  if (patch.provisionalNote) NORMS.provisionalNote = patch.provisionalNote;
  return NORMS;
}
