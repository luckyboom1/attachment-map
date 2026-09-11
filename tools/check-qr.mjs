/**
 * QR 编码器 / 解码器交叉验证（Node 运行）
 * ---------------------------------------------------------------------------
 * 用法：node tools/check-qr.mjs
 *
 * 为什么需要它
 * 自研二维码编码器最危险的失败模式是「看起来像二维码、扫不出来」。
 * 结构、掩码、数据填充、纠错分块，任一处写错都会产生一个外形正常但无法扫描的码，
 * 而这种错误在浏览器里肉眼完全看不出来。
 *
 * 三段验证，互不依赖：
 *
 *   A. 编码器 × python-qrcode：8 个用例 × 8 种掩码，共 64 次逐模块比对。
 *      基准由独立的 python-qrcode 生成（tools/qr-reference.json）。
 *      比对时强制使用同一掩码，因此排除了「掩码择优不同」这一合法差异——
 *      比对的是完全相同的产物。
 *
 *   B. 解码器 × segno：把 segno（另一个独立实现）生成的矩阵喂给我们的解码器，
 *      必须读回原文、且每个纠错块的 Reed-Solomon 校验子为零。
 *      这样编码与解码两条路径各有外部锚点，而不是互相自证。
 *
 *   C. 边界与结构不变量：容量表自洽、超长返回 null、定位/时序图形、格式信息可读回等。
 *
 * 关于两个基准的差异，见 tools/qr-reference-gen.py 顶部的说明。
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  encodeQr, byteCapacity, pickVersion, readFormatInfo, matrixToBinary,
  qrToSvg, penaltyScore, QR_TABLES, MAX_VERSION,
} from '../assets/js/core/qr.js';
import { encodeAnswers } from '../assets/js/core/encode.js';
import { TOTAL_QUESTIONS } from '../assets/js/data/questions.js';

const { TOTAL_CODEWORDS, BLOCKS_M, EC_PER_BLOCK_M } = QR_TABLES;

const ROOT = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..'));

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ' — ' + detail : ''}`); }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

/* ============ B 段所需的独立解码器（不复用编码器的任何计算路径） ============ */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

/** 多项式在 x 处求值；coeffs[0] 为最高次项 */
function polyEval(coeffs, x) {
  let y = 0;
  for (const c of coeffs) y = gfMul(y, x) ^ c;
  return y;
}

/** 校验子：全部为零 ⟺ 该码字序列是一个合法的 RS 码字 */
function syndromes(codewords, ecLen) {
  const out = [];
  for (let i = 0; i < ecLen; i++) out.push(polyEval(codewords, GF_EXP[i]));
  return out;
}

function maskBit(mask, row, col) {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: return false;
  }
}

/**
 * 功能模块判定，按几何规则独立推导（不引用编码器的 reserved 网格，
 * 否则解码就会依赖被验证对象的内部状态）。
 */
function functionMap(version) {
  const size = version * 4 + 17;
  const fn = Array.from({ length: size }, () => new Uint8Array(size));
  const mark = (r, c) => {
    if (r >= 0 && r < size && c >= 0 && c < size) fn[r][c] = 1;
  };

  // 三个定位图形各占 8×8（含外侧分隔符）。注意左上以外两个的锚点是 size-7——
  // 写成 size-8 会多圈进一列/一行（共 16 个模块），表现为取回码字少 2 个。
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) mark(r0 + dr, c0 + dc);
  }
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }          // 时序

  const centers = QR_TABLES.ALIGN_CENTERS[version];
  const last = centers.length - 1;
  for (let i = 0; i < centers.length; i++) {                          // 校正图形
    for (let j = 0; j < centers.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(centers[i] + dr, centers[j] + dc);
    }
  }

  for (let i = 0; i < 15; i++) {                                      // 格式信息
    const r = i < 6 ? i : (i < 8 ? i + 1 : size - 15 + i);
    mark(r, 8);
    const c = i < 8 ? size - i - 1 : (i === 8 ? 7 : 15 - i - 1);
    mark(8, c);
  }
  if (version >= 7) {                                                 // 版本信息
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3);
      const c = (i % 3) + size - 11;
      mark(r, c); mark(c, r);
    }
  }
  mark(size - 8, 8);                                                  // 固定深色模块
  return fn;
}

/** 按标准顺序取回码字 */
function extractCodewords(rows, fn, mask) {
  const size = rows.length;
  const bits = [];
  let row = size - 1;
  let direction = -1;

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (;;) {
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (fn[row][c]) continue;
        let bit = rows[row][c] & 1;
        if (maskBit(mask, row, c)) bit ^= 1;
        bits.push(bit);
      }
      row += direction;
      if (row < 0 || row >= size) { row -= direction; direction = -direction; break; }
    }
  }

  const codewords = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  return codewords;
}

/** 反交错：还原出各数据块与纠错块 */
function deinterleave(codewords, version) {
  const [g1, d1, g2, d2] = BLOCKS_M[version];
  const ecLen = EC_PER_BLOCK_M[version];
  const dataLens = [...Array(g1).fill(d1), ...Array(g2).fill(d2)];
  const blocks = dataLens.map(() => []);
  const ecBlocks = dataLens.map(() => []);
  let p = 0;

  for (let i = 0; i < Math.max(d1, d2); i++) {
    for (let b = 0; b < dataLens.length; b++) {
      if (i < dataLens[b]) blocks[b].push(codewords[p++]);
    }
  }
  for (let i = 0; i < ecLen; i++) {
    for (let b = 0; b < dataLens.length; b++) ecBlocks[b].push(codewords[p++]);
  }
  return { blocks, ecBlocks, ecLen, consumed: p };
}

/** 从矩阵完整解出文本；任何一步不合法返回 { ok:false, reason } */
function decodeQr(rows) {
  const size = rows.length;
  const version = (size - 17) / 4;
  if (!Number.isInteger(version) || version < 1 || version > 40) {
    return { ok: false, reason: `尺寸 ${size} 不是合法的二维码边长` };
  }

  const info = readFormatInfo(rows);
  if (!info.valid) return { ok: false, reason: '格式信息 BCH 校验失败' };
  if (info.ecBits !== 0b00) return { ok: false, reason: `纠错等级编码不是 M（读到 ${info.ecBits}）` };

  const codewords = extractCodewords(rows, functionMap(version), info.mask);
  const expected = TOTAL_CODEWORDS[version];
  if (expected == null) return { ok: false, reason: `未支持的版本 ${version}` };
  if (codewords.length !== expected) {
    return { ok: false, reason: `取回码字数 ${codewords.length}，期望 ${expected}` };
  }

  const { blocks, ecBlocks, ecLen } = deinterleave(codewords, version);

  // 硬证据：每个块的 (数据 + 纠错) 必须构成合法 RS 码字
  for (let i = 0; i < blocks.length; i++) {
    const syn = syndromes([...blocks[i], ...ecBlocks[i]], ecLen);
    if (syn.some((s) => s !== 0)) {
      return { ok: false, reason: `第 ${i + 1} 块 RS 校验子非零：${syn.join(',')}` };
    }
  }

  const data = blocks.flat();
  if (data.length < 2) return { ok: false, reason: '数据段过短' };
  if ((data[0] >> 4) !== 0b0100) {
    return { ok: false, reason: `模式位不是 Byte（读到 ${(data[0] >> 4).toString(2)}）` };
  }

  const length = ((data[0] & 0x0f) << 4) | (data[1] >> 4);
  if (length > data.length - 2) return { ok: false, reason: '长度字段越界' };

  const payload = [];
  let bitPos = 12;
  for (let i = 0; i < length; i++) {
    let byte = 0;
    for (let j = 0; j < 8; j++) {
      const idx = bitPos + j;
      byte = (byte << 1) | ((data[idx >> 3] >> (7 - (idx & 7))) & 1);
    }
    payload.push(byte);
    bitPos += 8;
  }

  // 终止符之后应当是 0（补齐到字节边界），再是 0xEC / 0x11 交替的填充码字
  const padStart = Math.ceil((12 + length * 8) / 8);
  const tail = data.slice(padStart);
  const padOk = tail.every((byte, i) => byte === (i % 2 === 0 ? 0xec : 0x11));

  return {
    ok: true,
    version,
    mask: info.mask,
    text: new TextDecoder().decode(Uint8Array.from(payload)),
    padOk,
    tailLength: tail.length,
  };
}

const toRows = (matrix) => matrix.split('\n').map((s) => Uint8Array.from(s, (ch) => (ch === '1' ? 1 : 0)));

/* ======================= A. 编码器 × python-qrcode ======================= */

section('A. 编码器比对：与独立实现 python-qrcode 逐模块一致');

const reference = JSON.parse(await readFile(join(ROOT, 'tools/qr-reference.json'), 'utf8'));
console.log(`   编码基准 ${reference.generatorA.name} ${reference.generatorA.version}`);
console.log(`   解码基准 ${reference.generatorB.name} ${reference.generatorB.version}`);
console.log(`   用例 ${reference.cases.length} 个 ｜ 每例比对 8 种掩码\n`);

let maskAgreement = 0;

for (const testCase of reference.cases) {
  const ref = testCase.a;
  const result = { ok: true, detail: [] };

  for (let mask = 0; mask < 8; mask++) {
    const mine = encodeQr(testCase.text, { forceMask: mask });
    if (!mine) { result.ok = false; result.detail.push(`掩码${mask}:返回null`); continue; }

    if (mine.version !== ref.version || mine.size !== ref.size) {
      result.ok = false;
      result.detail.push(`掩码${mask}:V${mine.version}/${mine.size} ≠ V${ref.version}/${ref.size}`);
      continue;
    }

    const bin = matrixToBinary(mine);
    const expected = ref.matrices[String(mask)];
    if (bin !== expected) {
      result.ok = false;
      const a = bin.split('\n');
      const b = expected.split('\n');
      let diffs = 0;
      const samples = [];
      for (let r = 0; r < a.length; r++) {
        for (let c = 0; c < a[r].length; c++) {
          if (a[r][c] !== b[r][c]) { diffs++; if (samples.length < 5) samples.push(`(${r},${c})`); }
        }
      }
      result.detail.push(`掩码${mask}:差异${diffs}处 ${samples.join(' ')}`);
    }
  }

  ok(`A · ${testCase.name}（${testCase.byteLength}字节，V${ref.version}）8 种掩码全部逐模块一致`,
     result.ok, result.detail.join('；'));

  // 罚分实现的一致性：我们的择优结果必须等于 python-qrcode 罚分函数在最终矩阵上的 argmin，
  // 且我们算出的每一档罚分要与它逐值相同
  const auto = encodeQr(testCase.text);
  const mineScores = [];
  for (let mask = 0; mask < 8; mask++) {
    mineScores.push(penaltyScore(encodeQr(testCase.text, { forceMask: mask }).modules));
  }
  const scoresMatch = mineScores.every((v, i) => v === ref.penaltyScores[i]);
  const pickMatch = auto.mask === ref.penaltyArgmin;
  if (scoresMatch && pickMatch) maskAgreement++;
  ok(`A · ${testCase.name} 罚分逐档数值与择码结果均与 python-qrcode 一致`,
     scoresMatch && pickMatch,
     `${scoresMatch ? '' : `罚分不同（我 ${mineScores.join(',')} / 它 ${ref.penaltyScores.join(',')}）`}` +
     `${pickMatch ? '' : `；择码 我${auto.mask} / 它${ref.penaltyArgmin}`}`);
}

console.log(`\n   罚分与择码均与 python-qrcode 一致：${maskAgreement} / ${reference.cases.length}`);

{
  // 基准自身的自洽性：8 个掩码必须产出互不相同的矩阵，否则说明掩码没被强制住
  const distinct = reference.cases.every((c) => new Set(Object.values(c.a.matrices)).size === 8);
  ok('A · 基准自身的 8 个掩码矩阵互不相同（说明掩码确实被强制）', distinct);
}

/* ======================= B. 解码器 × segno ======================= */

section('B. 解码器比对：读回另一个独立实现 segno 产出的二维码');

for (const testCase of reference.cases) {
  const b = testCase.b;
  if (!b) { console.log(`  \x1b[33m·\x1b[0m ${testCase.name} 无 segno 基准，跳过`); continue; }

  const rows = toRows(b.matrix);
  const decoded = decodeQr(rows);

  if (!decoded.ok) { ok(`B · ${testCase.name} 可解码`, false, decoded.reason); continue; }

  ok(`B · ${testCase.name} 读回原文一致（V${b.version} 掩码${b.mask}）`, decoded.text === testCase.text,
     `读到「${decoded.text.slice(0, 40)}」`);
  ok(`B · ${testCase.name} 纠错块 RS 校验子全为零`, true);
}

/* ======================= C. 边界与结构不变量 ======================= */

section('C. 边界与结构不变量');

{
  // 容量表自洽：数据码字 + 纠错码字 = 总码字数
  let tableOk = true;
  for (let v = 1; v <= MAX_VERSION; v++) {
    const [g1, d1, g2, d2] = BLOCKS_M[v];
    const data = g1 * d1 + g2 * d2;
    if (data + EC_PER_BLOCK_M[v] * (g1 + g2) !== TOTAL_CODEWORDS[v]) {
      tableOk = false;
      console.log(`    V${v} 分块表与总码字数不符`);
    }
  }
  ok('C · 分块表与总码字数自洽（V1–V7）', tableOk);

  // 容量边界
  ok('C · V1-M 容量为 14 字节', byteCapacity(1) === 14, `实际 ${byteCapacity(1)}`);
  ok('C · V7-M 容量为 122 字节', byteCapacity(7) === 122, `实际 ${byteCapacity(7)}`);
  ok('C · 版本随长度单调不减', pickVersion(14) === 1 && pickVersion(15) === 2 && pickVersion(122) === 7);
  ok('C · 超出容量返回 0', pickVersion(123) === 0);
  ok('C · 超长内容返回 null 而非坏码', encodeQr('x'.repeat(123)) === null);

  // 版本 7 的版本信息必须等于规格固定值
  const v7 = encodeQr('x'.repeat(122));
  const size = v7.size;
  let versionInfo = 0;
  for (let i = 17; i >= 0; i--) {
    const r = Math.floor(i / 3);
    const c = (i % 3) + size - 11;
    versionInfo = (versionInfo << 1) | (v7.modules[r][c] & 1);
  }
  ok('C · 版本 7 的版本信息块 = 0x07C94', versionInfo === 0x07c94,
     `实际 0x${versionInfo.toString(16).toUpperCase()}`);

  // 结构不变量
  ok('C · 三个定位图形结构正确',
     v7.modules[0][0] === 1 && v7.modules[3][3] === 1 && v7.modules[6][6] === 1 &&
     v7.modules[0][6] === 1 && v7.modules[6][0] === 1 &&
     v7.modules[1][1] === 0 && v7.modules[5][5] === 0 && v7.modules[7][7] === 0);

  let timingOk = true;
  for (let i = 8; i < size - 8; i++) {
    if (v7.modules[6][i] !== (i % 2 === 0 ? 1 : 0)) timingOk = false;
    if (v7.modules[i][6] !== (i % 2 === 0 ? 1 : 0)) timingOk = false;
  }
  ok('C · 时序图形交替正确', timingOk);
  ok('C · 固定深色模块在位', v7.modules[size - 8][8] === 1);

  // V7 共有 6 个校正图形（3×3 组合减去与定位图形重叠的 3 个）
  {
    const centers = QR_TABLES.ALIGN_CENTERS[7];
    let counted = 0;
    for (let i = 0; i < centers.length; i++) {
      for (let j = 0; j < centers.length; j++) {
        const r = centers[i];
        const c = centers[j];
        if ((i === 0 && j === 0) || (i === 0 && j === 2) || (i === 2 && j === 0)) continue;
        // 校正图形中心必为深色，且其上下左右第二格为深色、第一格为浅色
        if (v7.modules[r][c] === 1 && v7.modules[r - 1][c] === 0 && v7.modules[r - 2][c] === 1) counted++;
      }
    }
    ok('C · V7 的 6 个校正图形全部就位', counted === 6, `实际 ${counted} 个`);
  }

  // 格式信息：8 种掩码都要能正确读回
  let formatOk = true;
  for (let mask = 0; mask < 8; mask++) {
    const info = readFormatInfo(encodeQr('HELLO', { forceMask: mask }).modules);
    if (!info.valid || info.mask !== mask) formatOk = false;
  }
  ok('C · 8 种掩码的格式信息均可正确读回', formatOk);

  // 自动择优必须是 8 个候选里罚分最低的
  let bestOk = true;
  for (const text of ['HELLO', reference.cases[4].text, 'x'.repeat(122)]) {
    const auto = encodeQr(text);
    const scores = [];
    for (let mask = 0; mask < 8; mask++) scores.push(penaltyScore(encodeQr(text, { forceMask: mask }).modules));
    if (scores[auto.mask] !== Math.min(...scores)) bestOk = false;
  }
  ok('C · 自动择优选中的掩码罚分最低', bestOk);

  // 空串
  const empty = encodeQr('');
  ok('C · 空串可编码且可解码', !!empty && decodeQr(empty.modules).ok && decodeQr(empty.modules).text === '');

  // 自产自解：随机合盘链接
  {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const randCode = (n) => Array.from({ length: n }, () =>
      alphabet[Math.floor(Math.random() * alphabet.length)]).join('');

    let bad = 0;
    const covered = new Set();
    for (let i = 0; i < 200; i++) {
      const url = `https://attachment-map.pages.dev/duo.html?a=${randCode(19)}&b=${randCode(19)}`;
      const qr = encodeQr(url);
      if (!qr) { bad++; continue; }
      covered.add(qr.version);
      const d = decodeQr(qr.modules);
      if (!d.ok || d.text !== url) bad++;
    }
    ok('C · 随机 200 条合盘链接自产自解零失败', bad === 0, `失败 ${bad} 条`);
    ok('C · 随机样本覆盖 V5–V7', [...covered].every((v) => v >= 5),
       `覆盖版本 ${[...covered].sort((a, b) => a - b).join(',')}`);
  }

  {
    const cn = '依恋地图：焦虑 5 / 回避 3 ｜ 邀请码 ABCDEFGHIJKLMNOPQRS';
    const qr = encodeQr(cn);
    const d = decodeQr(qr.modules);
    ok('C · 中文多字节内容往返一致', d.ok && d.text === cn, d.ok ? '' : d.reason);
  }

  // 跨模块容量实测：真实作答 → 答案编码 → 合盘链接 → 二维码，必须装得下。
  // 这是「二维码会不会在真实场景下失效」的唯一硬证据。
  {
    const worst = Array.from({ length: TOTAL_QUESTIONS }, (_, i) => (i % 7) + 1);
    const codeA = encodeAnswers(worst);
    const codeB = encodeAnswers([...worst].reverse());

    // 用偏长的域名做保守估计（当前没有正式域名，取 60 字符的路径+域名）
    const longOrigin = 'https://attachment-map-demo.example.pages.dev/sub/dir/';
    const invite = `${longOrigin}duo.html?a=${codeA}`;
    const duo = `${longOrigin}duo.html?a=${codeA}&b=${codeB}`;

    const inviteQr = encodeQr(invite);
    const duoQr = encodeQr(duo);

    ok('C · 真实邀请链接装得进二维码', !!inviteQr && inviteQr.version <= MAX_VERSION,
       `${invite.length} 字节` + (inviteQr ? ` → V${inviteQr.version}` : ' → 装不下'));
    ok('C · 真实合盘链接装得进二维码', !!duoQr && duoQr.version <= MAX_VERSION,
       `${duo.length} 字节` + (duoQr ? ` → V${duoQr.version}` : ' → 装不下'));
    ok('C · 真实链接编码后仍可解码',
       !!duoQr && decodeQr(duoQr.modules).ok && decodeQr(duoQr.modules).text === duo,
       `剩余余量 ${byteCapacity(MAX_VERSION) - duo.length} 字节`);
  }

  // SVG 输出
  const svg = qrToSvg(v7, { margin: 4 });
  const darkCount = Array.from(matrixToBinary(v7)).filter((ch) => ch === '1').length;
  ok('C · SVG 每条深色模块都画了一个方块', (svg.match(/M/g) || []).length === darkCount,
     `SVG ${(svg.match(/M/g) || []).length} 个，深色模块 ${darkCount} 个`);
  ok('C · SVG 含 4 模块静默区', svg.includes(`viewBox="0 0 ${size + 8} ${size + 8}"`));
  ok('C · SVG 使用 crispEdges 保证边缘锐利', svg.includes('shape-rendering="crispEdges"'));
  ok('C · SVG 固定黑白高对比（不随主题反转）',
     svg.includes('fill="#FFFFFF"') && svg.includes('fill="#000000"'));
}

/* ============ D. UI 集成：qrFigure() 真的能渲染出二维码 ============ */

section('D. UI 集成（用最小 DOM 桩实际调用 qrFigure）');

{
  // 最小 DOM 桩。只实现 ui.js 用到的部分，目的是让 qrFigure() 能被真实调用一次，
  // 从而覆盖「编码器 → SVG → 挂进 DOM」这条链路，
  // 而不是只验证编码器本身（那会漏掉 ui.js 里的拼装错误）。
  function makeEl(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      children: [],
      attrs: {},
      dataset: {},
      _html: '',
      _text: '',
      classList: { add() {}, remove() {}, toggle() {} },
      set className(v) { this.attrs.class = v; },
      get className() { return this.attrs.class || ''; },
      set innerHTML(v) { this._html = String(v); },
      get innerHTML() { return this._html; },
      set textContent(v) { this._text = String(v); },
      get textContent() { return this._text; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k]; },
      removeAttribute(k) { delete this.attrs[k]; },
      appendChild(c) { this.children.push(c); return c; },
      insertBefore(c) { this.children.unshift(c); return c; },
      remove() {},
      addEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };
  }

  globalThis.document = {
    createElement: makeEl,
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    documentElement: { dataset: {} },
    body: makeEl('body'),
    addEventListener() {},
  };
  globalThis.location = { search: '', pathname: '/', href: 'http://localhost/', host: 'localhost' };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  // navigator 在 Node 里是只读的，且 qrFigure 用不到，故不覆盖。

  const { qrFigure } = await import('../assets/js/ui/ui.js');

  const url = 'https://attachment-map.pages.dev/duo.html?a=ABCDEFGHIJKLMNOPQRS&b=TUVWXYZ0123456789ABC';
  const figure = qrFigure(url);

  ok('D · qrFigure 返回 figure.qr-figure', figure.attrs.class === 'qr-figure', `实际「${figure.attrs.class}」`);

  const box = figure.children[0];
  ok('D · 内部卡片使用 qr 类', !!box && box.attrs.class === 'qr');
  ok('D · 卡片内联了 SVG', !!box && box.innerHTML.includes('<svg') && box.innerHTML.includes('</svg>'));

  const expectedDark = Array.from(matrixToBinary(encodeQr(url))).filter((ch) => ch === '1').length;
  ok('D · SVG 方块数与矩阵深色模块数一致',
     !!box && (box.innerHTML.match(/M/g) || []).length === expectedDark,
     box ? `SVG ${(box.innerHTML.match(/M/g) || []).length} / 矩阵 ${expectedDark}` : '');

  const caption = figure.children[1];
  ok('D · 带二维码说明文字', !!caption && caption.attrs.class === 'qr-caption' && caption.textContent.length > 0);

  // 超长内容必须降级为说明，而不是空白或坏码
  const degraded = qrFigure('x'.repeat(500));
  ok('D · 超长内容降级为提示而非空白',
     degraded.attrs.class === 'note note--warn' && degraded.children.length === 2,
     `实际「${degraded.attrs.class}」`);

  // 样式类必须真实存在，否则二维码会没有尺寸/边框
  const css = await readFile(join(ROOT, 'assets/css/app.css'), 'utf8');
  const required = ['.qr-block', '.qr-block__text', '.qr-figure', '.qr ', '.qr-caption'];
  const missing = required.filter((sel) => !css.includes(`${sel}{`) && !css.includes(`${sel} {`));
  ok('D · 二维码所用样式类在 app.css 中均已定义', missing.length === 0, `缺失 ${missing.join(' ')}`);
}

/* ======================= 汇总 ======================= */

console.log('\n' + '─'.repeat(64));
if (fail === 0) {
  console.log(`\x1b[32m\x1b[1m全部通过\x1b[0m  ${pass} 项检查`);
} else {
  console.log(`\x1b[31m\x1b[1m${fail} 项失败\x1b[0m  / 通过 ${pass} 项`);
  failures.forEach((f) => console.log(`  · ${f}`));
  process.exitCode = 1;
}
console.log('');
