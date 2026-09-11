/**
 * 导出二维码 SVG，供 tools/check-qr-scan.py 做真实扫描器解码验证。
 * 用法：node tools/qr-svg-dump.mjs
 */
import { writeFile } from 'node:fs/promises';

import { encodeQr, qrToSvg } from '../assets/js/core/qr.js';
import { encodeAnswers } from '../assets/js/core/encode.js';
import { QUESTIONS } from '../assets/js/data/questions.js';

const answers = QUESTIONS.map((q, i) => (i % 7) + 1);
const answersAlt = [...answers].reverse();
const codeA = encodeAnswers(answers);
const codeB = encodeAnswers(answersAlt);
const ORIGIN = 'https://attachment-map.pages.dev/';

const cases = [
  { label: 'V1 短内容', url: 'HELLO' },
  { label: 'V3 中文', url: '依恋地图 · 双人合盘' },
  { label: 'V5 真实邀请链接', url: `${ORIGIN}duo.html?a=${codeA}` },
  { label: 'V6 真实合盘链接', url: `${ORIGIN}duo.html?a=${codeA}&b=${codeB}` },
  { label: 'V7 长链接', url: `${ORIGIN}duo.html?a=${codeA}&b=${codeB}&from=scan_verification_run` },
];

const out = [];
for (const c of cases) {
  const qr = encodeQr(c.url);
  if (!qr) {
    console.error(`✗ ${c.label} 超出容量，无法导出`);
    process.exitCode = 1;
    continue;
  }
  out.push({
    label: c.label,
    url: c.url,
    version: qr.version,
    mask: qr.mask,
    svg: qrToSvg(qr, { margin: 4, title: c.label }),
  });
}

await writeFile('/tmp/qr-scan-cases.json', JSON.stringify(out), 'utf8');
console.log(`已导出 ${out.length} 个用例到 /tmp/qr-scan-cases.json`);
out.forEach((c) => console.log(`  ${c.label}  V${c.version} 掩码${c.mask}  ${c.url.length} 字符`));
