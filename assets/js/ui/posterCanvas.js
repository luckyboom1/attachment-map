/**
 * 海报绘制（浏览器层）
 * ===========================================================================
 * 只负责把 core/poster.js 给出的规格画到 canvas 上。
 * 规格与绘制分离的原因见 core/poster.js 文件头：规格可单测，绘制不可。
 *
 * 移动端的正确交付方式不是 download，而是把图渲染成 <img> 让用户长按保存——
 * 微信内置浏览器对 dataURL 下载的支持不可靠，长按保存才是那里的通用路径。
 * 所以这里同时提供两种：download 链接 + 可长按的 img。
 */

import { POSTER_SCALE } from '../core/poster.js';

const FONT = '"PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "Source Han Sans SC", sans-serif';

const font = (weight, size) => `${weight} ${size}px ${FONT}`;

/** 句末标点不允许起新行——否则会出现「。」单独成行这种很难看的结果。 */
const NO_LINE_START = '。，、！？；：）」』】》';

/** 按最大宽度折行。用 measureText 实测，不按字符数估——中英文混排时估会错。 */
function wrapText(ctx, text, maxWidth) {
  const lines = [];
  let current = '';
  for (const ch of String(text)) {
    const next = current + ch;
    if (ctx.measureText(next).width > maxWidth && current) {
      if (NO_LINE_START.includes(ch)) {
        current = next;                       // 标点留在行尾，允许轻微超宽
        continue;
      }
      lines.push(current);
      current = ch;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * 把规格画成 canvas。内部按 POSTER_SCALE 放大，导出的 PNG 因此足够清晰。
 * @param {object} spec  buildPosterSpec 的返回值
 * @returns {HTMLCanvasElement}
 */
export function drawPoster(spec) {
  const { palette: p, layout: L } = spec;
  const card = { x: L.pad, y: L.cardY, w: L.width - L.pad * 2, h: L.cardH };
  const inner = { x: card.x + 36, w: card.w - 72 };

  const canvas = document.createElement('canvas');
  canvas.width = spec.width * spec.scale;
  canvas.height = spec.height * spec.scale;

  const ctx = canvas.getContext('2d');
  ctx.scale(spec.scale, spec.scale);

  // 纸
  ctx.fillStyle = p.paper;
  ctx.fillRect(0, 0, spec.width, spec.height);

  // 品牌行：黄色方标 + 站名
  ctx.fillStyle = p.yellow;
  ctx.fillRect(L.pad, L.cardY - 136, 56, 56);
  ctx.lineWidth = 3;
  ctx.strokeStyle = p.ink;
  ctx.strokeRect(L.pad, L.cardY - 136, 56, 56);
  ctx.fillStyle = p.ink;
  ctx.font = font(900, 30);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(spec.brand.mark, L.pad + 28, L.cardY - 108);
  ctx.textAlign = 'left';
  ctx.font = font(900, 34);
  ctx.fillText(spec.brand.title, L.pad + 74, L.cardY - 108);
  ctx.textBaseline = 'alphabetic';

  // 大卡片：先画硬阴影，再画卡面
  ctx.fillStyle = p.shade;
  ctx.fillRect(card.x + 10, card.y + 10, card.w, card.h);
  ctx.fillStyle = p.surface;
  ctx.fillRect(card.x, card.y, card.w, card.h);
  ctx.strokeRect(card.x, card.y, card.w, card.h);

  // 类型编码标签
  ctx.fillStyle = p.yellow;
  ctx.fillRect(inner.x, card.y + L.codeTop, 170, 44);
  ctx.strokeRect(inner.x, card.y + L.codeTop, 170, 44);
  ctx.fillStyle = p.ink;
  ctx.font = font(900, 24);
  ctx.textAlign = 'center';
  ctx.fillText(spec.type.code, inner.x + 85, card.y + L.codeTop + 22);
  ctx.textAlign = 'left';

  // 类型名（全站最大字）
  ctx.font = font(900, 104);
  ctx.fillText(spec.type.name, inner.x, card.y + L.nameBaseline);

  // 一句话
  ctx.font = font(500, 30);
  const taglineLines = wrapText(ctx, spec.type.tagline, inner.w - 8);
  taglineLines.slice(0, 2).forEach((line, i) => {
    ctx.fillText(line, inner.x, card.y + L.taglineBaseline + i * 46);
  });

  // 分隔线
  ctx.strokeStyle = p.ink;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(inner.x, card.y + L.dividerY);
  ctx.lineTo(inner.x + inner.w, card.y + L.dividerY);
  ctx.stroke();
  ctx.lineWidth = 3;

  // 两个维度条
  const trackH = 30;
  spec.dims.forEach((d, i) => {
    const y = card.y + L.dimsTop + i * L.dimHeight;

    // 每一块都显式重置颜色：上一块的档位说明把 fillStyle 留在了 muted，
    // 不重置的话第二块的名称与分数会被画成灰色。
    ctx.fillStyle = p.ink;
    ctx.font = font(900, 26);
    ctx.fillText(d.name, inner.x, y + 10);

    ctx.font = font(900, 34);
    ctx.textAlign = 'right';
    ctx.fillText(d.score, inner.x + inner.w - 150, y + 12);
    ctx.font = font(500, 20);
    ctx.fillText(d.percentile, inner.x + inner.w, y + 12);
    ctx.textAlign = 'left';

    // 轨道
    const trackW = inner.w;
    ctx.fillStyle = p.surface;
    ctx.fillRect(inner.x, y + 34, trackW, trackH);
    ctx.lineWidth = 2;
    ctx.strokeRect(inner.x, y + 34, trackW, trackH);
    ctx.lineWidth = 3;

    // 已填部分
    ctx.fillStyle = d.color;
    ctx.fillRect(inner.x, y + 34, (trackW * d.fillPct) / 100, trackH);

    // 切分点（实线）与参照均值（点线）
    const cutX = inner.x + (trackW * d.cutPct) / 100;
    const refX = inner.x + (trackW * d.refPct) / 100;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cutX, y + 30); ctx.lineTo(cutX, y + 34 + trackH + 4);
    ctx.stroke();
    ctx.beginPath();
    for (let yy = y + 30; yy <= y + 34 + trackH + 4; yy += 8) {
      ctx.moveTo(refX, yy); ctx.lineTo(refX, Math.min(yy + 4, y + 34 + trackH + 4));
    }
    ctx.stroke();
    ctx.lineWidth = 3;

    // 档位说明
    ctx.font = font(500, 18);
    ctx.fillStyle = p.muted;
    ctx.fillText('1 低', inner.x, y + 34 + trackH + 26);
    ctx.textAlign = 'center';
    ctx.fillText(`切分点 ${d.cut}`, inner.x + (trackW * d.cutPct) / 100, y + 34 + trackH + 26);
    ctx.textAlign = 'right';
    ctx.fillText('7 高', inner.x + trackW, y + 34 + trackH + 26);
    ctx.textAlign = 'left';
  });

  // 卡片底部：二维码（若有）+ 说明文字
  const qrY = card.y + L.qrTop;
  if (spec.qr) {
    drawQr(ctx, spec.qr.matrix, spec.qr.size, inner.x, qrY, L.qrSize, p);
  }
  const textX = spec.qr ? inner.x + L.qrSize + 40 : inner.x;
  ctx.font = font(900, 26);
  ctx.fillStyle = p.ink;
  ctx.fillText('想知道你们为什么会卡在同一个地方？', textX, qrY + 30);
  ctx.font = font(500, 20);
  ctx.fillStyle = p.muted;
  ctx.fillText(spec.footer.source, textX, qrY + 66);
  ctx.fillText(spec.footer.disclaimer, textX, qrY + 96);
  if (spec.footer.host) {
    ctx.fillText(spec.footer.host, textX, qrY + 126);
  }

  // 页脚
  ctx.font = font(500, 18);
  ctx.fillStyle = p.muted;
  ctx.fillText('依恋地图 · 扫码测一测你的依恋类型', L.pad, L.footerY + 30);

  return canvas;
}

/** 把二维码矩阵画进 canvas（黑色模块，白底），规格来自 core/qr.js */
function drawQr(ctx, matrix, size, x, y, dim, p) {
  const margin = 2;                       // 海报自身是白纸，2 模块静默区已足够
  const total = size + margin * 2;
  const cell = dim / total;

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(x, y, dim, dim);
  ctx.lineWidth = 3;
  ctx.strokeStyle = p.ink;
  ctx.strokeRect(x, y, dim, dim);
  ctx.fillStyle = p.ink;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c]) {
        ctx.fillRect(x + (c + margin) * cell, y + (r + margin) * cell, cell + 0.5, cell + 0.5);
      }
    }
  }
}

/**
 * 生成海报：等字体就绪 → 绘制 → 返回 dataURL。
 * @returns {Promise<string>}
 */
export async function renderPosterDataUrl(spec) {
  if (document.fonts?.ready) await document.fonts.ready;
  const canvas = drawPoster(spec);
  return canvas.toDataURL('image/png');
}

/**
 * 在容器里铺出可长按保存的海报图 + 下载入口。
 * @param {HTMLElement} host
 * @param {object} spec
 */
export async function mountPoster(host, spec) {
  const url = await renderPosterDataUrl(spec);

  host.innerHTML = '';
  const img = document.createElement('img');
  img.src = url;
  img.alt = '你的依恋类型海报';
  img.style.cssText = 'display:block;width:100%;height:auto;border:3px solid #000;box-shadow:6px 6px 0 #000';
  host.appendChild(img);

  const link = document.createElement('a');
  link.href = url;
  link.download = `依恋地图-${spec.type.name}.png`;
  link.textContent = '下载长图';
  link.className = 'btn btn--white btn--sm';
  link.style.cssText = 'margin-top:16px';
  host.appendChild(link);

  return url;
}
