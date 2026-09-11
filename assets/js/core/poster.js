/**
 * 结果海报 —— 内容与几何规格（确定性内核）
 * ===========================================================================
 * 分层原因
 * 这份文件只负责「海报上有什么、画在哪里、用什么颜色」，不碰任何 DOM。
 * 真正的绘制在 ui/posterCanvas.js。这样规格可以在 Node 里单测
 * （文案是否越线、数值是否来自计分结果、几何是否越界），
 * 而绘制层的 bug（字体没加载、DPR 缩放错）不会污染规格。
 *
 * 为什么海报固定用浅色调，不跟随主题
 * 海报的归宿是聊天窗口与朋友圈，观看者看不到本站的主题状态。
 * 黑字白纸在任何聊天背景下都可读；跟随深色主题会把可读性交给对方的环境。
 * 与二维码同理：可读性优先于主题一致性。
 *
 * 为什么不放付费内容
 * 海报是被转发出去的，看到它的人大多还没测过。它只承载
 * 「我是什么 + 两个维度分 + 怎么来测」——这是裂变入口，不是转化页面。
 */

import { getType } from './types.js';
import { NORMS } from './norms.js';
import { encodeQr } from './qr.js';

/** 固定浅色调色板。改这里的值等于改所有已生成海报的外观。 */
export const POSTER_PALETTE = {
  paper: '#FFFDF7',
  surface: '#FFFFFF',
  ink: '#000000',
  shade: '#000000',
  muted: '#6E685C',
  yellow: '#FFEB3B',
  /** 各类型的强调色，与 tokens.css 的浅色值一致 */
  accents: { secure: '#4ECDC4', anxious: '#FF9EC4', avoidant: '#2196F3', fearful: '#B69CFF' },
  /** 两个维度条的颜色，与结果页一致 */
  dimColors: { anxiety: '#FF9EC4', avoidance: '#2196F3' },
};

/**
 * 逻辑尺寸与各区块位置。
 * 除 width / pad / footerY 外，其余均为**相对卡顶**的距离——
 * 绘制层按卡顶平移，规格层据此做越界断言。
 * height 由 footerY 推导，不单独手填。
 */
export const POSTER_LAYOUT = {
  width: 750,
  pad: 48,
  cardY: 180,
  cardH: 980,
  codeTop: 48,
  nameBaseline: 250,
  taglineBaseline: 316,
  dividerY: 400,
  dimsTop: 440,
  dimHeight: 190,
  qrTop: 800,
  qrSize: 140,
  footerY: 1230,
};

POSTER_LAYOUT.height = POSTER_LAYOUT.footerY + 100;

/** 画布内部放大倍数。2 倍保证分享出去的长图在小屏上不糊。 */
export const POSTER_SCALE = 2;

/** 海报上的免责与品牌文案。集中在这里，便于用测试守住红线。 */
export const POSTER_COPY = {
  disclaimer: '自我探索工具 · 不构成心理诊断',
  source: '基于成人依恋理论（ECR 双维度）',
};

/**
 * 由计分结果生成海报规格。
 * @param {import('./scoring.js').ScoreResult} result
 * @param {{host?: string, baseUrl?: string}} [options]
 *        host 用于海报页脚；baseUrl 用于生成海报上的二维码（分享后的裂变入口）。
 *        baseUrl 必须是**目录前缀**（以 / 结尾），例如
 *        `https://user.github.io/attachment-map/`——不能用 location.origin，
 *        否则项目站点部署到子路径时，二维码会指向不存在的地址。
 * @returns {object}
 */
export function buildPosterSpec(result, options = {}) {
  const type = getType(result.type);
  const palette = POSTER_PALETTE;
  const L = POSTER_LAYOUT;
  const scaleMax = NORMS.scaleMax;
  const span = scaleMax - NORMS.scaleMin;
  const toPct = (v) => ((v - NORMS.scaleMin) / span) * 100;

  const dims = [
    {
      name: '依恋焦虑',
      score: `${result.A} / 7`,
      percentile: `百分位 ${result.pctA}`,
      value: result.A,
      fillPct: toPct(result.A),
      cutPct: toPct(NORMS.cut.anxiety),
      refPct: toPct(NORMS.anxiety.mean),
      cut: NORMS.cut.anxiety,
      color: palette.dimColors.anxiety,
    },
    {
      name: '依恋回避',
      score: `${result.V} / 7`,
      percentile: `百分位 ${result.pctV}`,
      value: result.V,
      fillPct: toPct(result.V),
      cutPct: toPct(NORMS.cut.avoidance),
      refPct: toPct(NORMS.avoidance.mean),
      cut: NORMS.cut.avoidance,
      color: palette.dimColors.avoidance,
    },
  ];

  return {
    version: 1,
    width: L.width,
    height: L.height,
    scale: POSTER_SCALE,
    palette,
    layout: L,
    brand: { mark: '依', title: '依恋地图' },
    type: {
      name: type.name,
      code: type.code,
      tagline: type.tagline,
      accent: palette.accents[result.type],
    },
    dims,
    cut: { anxiety: NORMS.cut.anxiety, avoidance: NORMS.cut.avoidance },
    reference: { anxiety: NORMS.anxiety.mean, avoidance: NORMS.avoidance.mean },
    footer: {
      host: String(options.host || ''),
      disclaimer: POSTER_COPY.disclaimer,
      source: POSTER_COPY.source,
    },
    /** 海报右下角的二维码指向站点入口；没有 baseUrl 或内容放不下时不画 */
    qr: options.baseUrl ? buildQrSpec(options.baseUrl) : null,
  };
}

/**
 * 海报上的二维码是裂变入口：收到长图的人扫码直达测试页。
 * 编不出就返回 null（宁可没有，也不放一个扫不出的码），由绘制层跳过。
 */
function buildQrSpec(baseUrl) {
  const text = `${String(baseUrl).replace(/\/*$/, '/')}index.html`;
  const qr = encodeQr(text);
  if (!qr) return null;
  return {
    text,
    size: qr.size,
    matrix: qr.modules.map((row) => Array.from(row)),
  };
}
