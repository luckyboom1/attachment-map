/**
 * 纯前端 QR Code 编码器
 * ===========================================================================
 * 为什么必须自己写，而不是引一个库或者调一个接口
 *
 * 双人合盘的邀请链接里带着 36 道题的作答编码（`?a=<19字符>`）。把这个链接交给
 * 第三方二维码服务，等于把用户的答案原文发给了第三方。所以二维码只能在本地算。
 * 服务端渲染同样不行——本项目零后端。
 *
 * 采用的规格
 *   编码模式   Byte（UTF-8 字节）——链接里必然出现小写字母，Num/Alnum 模式都不适用
 *   纠错等级   M（约 15% 冗余；屏幕→摄像头的场景对污损不敏感，M 是稳妥选择）
 *   版本       1–7（V1-M 14 字节 … V7-M 122 字节）。合盘链接实测 ≤ 90 字节，
 *              上限留了 35% 余量；超出上限一律返回 null，由 UI 降级为「复制链接」，
 *              不生成一个扫不出来的码。
 *   掩码       8 种全试，按 ISO/IEC 18004 罚分规则取最低分
 *   静默区     由调用方通过 margin 指定，默认 4 模块（规格最小值）
 *
 * 确定性：纯函数，同输入必得同输出。不含随机数、网络请求、时间戳。
 * 所以它可以放在 core/ 层并被 Node 单测覆盖。
 *
 * 正确性怎么保证：见 tools/check-qr.mjs —— 用独立实现 segno 生成的基准矩阵逐模块比对。
 */

/* ============================ 常量表 ============================ */

/** 各版本的总码字数（数据 + 纠错），索引即版本号 */
const TOTAL_CODEWORDS = [null, 26, 44, 70, 100, 134, 172, 196];

/** 纠错等级 M 下，每个纠错块的纠错码字数 */
const EC_PER_BLOCK_M = [null, 10, 16, 26, 18, 24, 16, 18];

/** 纠错等级 M 的分块结构：[组1块数, 组1每块数据码字, 组2块数, 组2每块数据码字] */
const BLOCKS_M = [
  null,
  [1, 16, 0, 0],
  [1, 28, 0, 0],
  [1, 44, 0, 0],
  [2, 32, 0, 0],
  [2, 43, 0, 0],
  [4, 27, 0, 0],
  [4, 31, 0, 0],
];

/** 校正图形的中心坐标；版本 1 没有校正图形 */
const ALIGN_CENTERS = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38]];

/** 纠错等级 M 在格式信息里的两位编码（L=01 / M=00 / Q=11 / H=10） */
const EC_BITS_M = 0b00;

/** BCH 生成多项式与格式信息的固定掩码 */
const G15 = 0b10100110111;        // x^10 + x^8 + x^5 + x^4 + x^2 + x + 1
const G15_MASK = 0b101010000010010;
const G18 = 0b1111100100101;      // 版本信息的 BCH 生成多项式

/** 填充码字，交替使用 */
const PAD_CODEWORDS = [0xEC, 0x11];

export const MAX_VERSION = 7;
export const DEFAULT_EC_LEVEL = 'M';

/** 供测试与调试使用；调用方不应依赖其内部结构 */
export const QR_TABLES = { TOTAL_CODEWORDS, EC_PER_BLOCK_M, BLOCKS_M, ALIGN_CENTERS };

/* ============================ GF(256) 运算 ============================ */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(function initGaloisField() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;      // 本原多项式 x^8 + x^4 + x^3 + x^2 + 1
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/**
 * 生成 degree 次的 Reed-Solomon 生成多项式 ∏(x - α^i)，i = 0..degree-1。
 * 返回数组长度 degree，索引 0 为最高次项，首项系数 1 省略。
 */
function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;                       // 从单项式 x^0 开始
  let root = 1;                                 // α^0
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);                   // 下一个 α
  }
  return result;
}

/** 计算数据码字的纠错码字（多项式取余） */
function rsRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

/* ============================ BCH 校验位 ============================ */

function bitLength(value) {
  let n = 0;
  let v = value;
  while (v !== 0) { n++; v >>>= 1; }
  return n;
}

/** 格式信息：5 位数据 + 10 位 BCH，再异或固定掩码 */
function bchTypeInfo(data) {
  const shifted = data << 10;
  let rest = shifted;
  while (bitLength(rest) - bitLength(G15) >= 0) {
    rest ^= G15 << (bitLength(rest) - bitLength(G15));
  }
  return (shifted | rest) ^ G15_MASK;
}

/** 版本信息：6 位版本号 + 12 位 BCH（版本 ≥ 7 才有） */
function bchTypeNumber(version) {
  const shifted = version << 12;
  let rest = shifted;
  while (bitLength(rest) - bitLength(G18) >= 0) {
    rest ^= G18 << (bitLength(rest) - bitLength(G18));
  }
  return shifted | rest;
}

/* ============================ 容量 ============================ */

/** 指定版本的数据码字数 */
export function dataCodewords(version) {
  const [g1, d1, g2, d2] = BLOCKS_M[version] || [];
  if (g1 == null) throw new Error(`不支持的版本：${version}`);
  return g1 * d1 + g2 * d2;
}

/** 指定版本在 Byte 模式下可容纳的字节数（已扣除 4 bit 模式位 + 8 bit 计数位） */
export function byteCapacity(version) {
  return Math.floor((dataCodewords(version) * 8 - (4 + 8)) / 8);
}

/** 能装下 len 字节的最小版本；装不下返回 0 */
export function pickVersion(len, maxVersion = MAX_VERSION) {
  for (let v = 1; v <= maxVersion; v++) {
    if (len <= byteCapacity(v)) return v;
  }
  return 0;
}

/* ============================ 数据编码 ============================ */

function toUtf8Bytes(text) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
  // 兜底：手写 UTF-8（仅用于极老的运行环境）
  const out = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(
      0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
      0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f),
    );
  }
  return Uint8Array.from(out);
}

/** 模式位 + 计数位 + 载荷 → 终止符 → 补字节边界 → 填充码字 */
function buildDataCodewords(bytes, version) {
  const total = dataCodewords(version);
  const bits = [];
  const pushBits = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  pushBits(0b0100, 4);                     // Byte 模式
  pushBits(bytes.length, 8);               // 版本 1–9 的字符计数为 8 bit
  for (const b of bytes) pushBits(b, 8);

  const capacityBits = total * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    out.push(byte);
  }

  let k = 0;
  while (out.length < total) out.push(PAD_CODEWORDS[k++ % 2]);
  return out;
}

/** 分块 → 逐块算纠错 → 交错排列（这是 QR 抵抗局部污损的关键） */
function interleave(dataCodewords, version) {
  const [g1, d1, g2, d2] = BLOCKS_M[version];
  const ecLen = EC_PER_BLOCK_M[version];
  const divisor = rsDivisor(ecLen);

  const blocks = [];
  let cursor = 0;
  for (let i = 0; i < g1; i++) { blocks.push(dataCodewords.slice(cursor, cursor + d1)); cursor += d1; }
  for (let i = 0; i < g2; i++) { blocks.push(dataCodewords.slice(cursor, cursor + d2)); cursor += d2; }

  const ecBlocks = blocks.map((block) => rsRemainder(block, divisor));

  const out = [];
  const maxDataLen = Math.max(d1, d2);
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of blocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const block of ecBlocks) out.push(block[i]);
  }

  const expected = TOTAL_CODEWORDS[version];
  if (out.length !== expected) {
    throw new Error(`交错后码字数 ${out.length}，期望 ${expected}（版本 ${version} 的分块表可能有误）`);
  }
  return out;
}

/* ============================ 掩码 ============================ */

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

/* ============================ 矩阵构造 ============================ */

function emptyGrid(size) {
  return Array.from({ length: size }, () => new Uint8Array(size));
}

function placeFinder(modules, reserved, r0, c0) {
  const size = modules.length;
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const r = r0 + dr;
      const c = c0 + dc;
      if (r < 0 || r >= size || c < 0 || c >= size) continue;
      const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
      const dark = inside && (
        dr === 0 || dr === 6 || dc === 0 || dc === 6 ||      // 外框
        (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4)           // 中心实心块
      );
      modules[r][c] = dark ? 1 : 0;                          // 外框之外即分隔符，留白
      reserved[r][c] = 1;
    }
  }
}

function placeTiming(modules, reserved) {
  const size = modules.length;
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0 ? 1 : 0;
    modules[6][i] = dark; reserved[6][i] = 1;
    modules[i][6] = dark; reserved[i][6] = 1;
  }
}

function placeAlignment(modules, reserved, version) {
  const centers = ALIGN_CENTERS[version];
  const last = centers.length - 1;
  for (let i = 0; i < centers.length; i++) {
    for (let j = 0; j < centers.length; j++) {
      // 只跳过与三个定位图形重叠的位置。注意：不能用 reserved 判断——
      // 第 6 行/列是时序图形，(6,22) 与 (22,6) 会被误判为已占用，
      // 而它们其实是必须放置的校正图形。
      const overlapsFinder =
        (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0);
      if (overlapsFinder) continue;

      const r = centers[i];
      const c = centers[j];
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          modules[r + dr][c + dc] = dark ? 1 : 0;
          reserved[r + dr][c + dc] = 1;
        }
      }
    }
  }
}

/**
 * 格式信息落位。位置顺序与 readFormatInfo 的读取顺序严格一致——
 * 两处一旦不一致，读出来的掩码就是错的，解码整段崩掉。
 */
function placeFormatInfo(modules, reserved, mask) {
  const size = modules.length;
  const bits = bchTypeInfo((EC_BITS_M << 3) | mask);

  for (let i = 0; i < 15; i++) {
    const bit = (bits >> i) & 1;

    // 左上角竖列（跳过第 6 行，那是时序图形）
    let r;
    if (i < 6) r = i;
    else if (i < 8) r = i + 1;
    else r = size - 15 + i;
    modules[r][8] = bit; reserved[r][8] = 1;

    // 左上角横行 + 右上角横行（跳过第 6 列）
    let c;
    if (i < 8) c = size - i - 1;
    else if (i === 8) c = 7;
    else c = 15 - i - 1;
    modules[8][c] = bit; reserved[8][c] = 1;
  }

  // 固定深色模块
  modules[size - 8][8] = 1;
  reserved[size - 8][8] = 1;
}

function placeVersionInfo(modules, reserved, version) {
  if (version < 7) return;
  const size = modules.length;
  const bits = bchTypeNumber(version);
  for (let i = 0; i < 18; i++) {
    const bit = (bits >> i) & 1;
    const r = Math.floor(i / 3);
    const c = (i % 3) + size - 11;
    modules[r][c] = bit; reserved[r][c] = 1;
    modules[c][r] = bit; reserved[c][r] = 1;
  }
}

/**
 * 数据填充：从右下角起，两列一组，自下而上／自上而下交替，跳过功能模块。
 * 这是规格里最容易被写错的一段——列序、方向翻转、第 6 列的跳过，三者错一个都会
 * 让码"看起来像二维码"但扫不出来，而单测很难发现。所以它有独立基准做逐模块比对。
 */
function placeData(modules, reserved, bitStream, mask) {
  const size = modules.length;
  let index = 0;
  let row = size - 1;
  let direction = -1;                                        // -1 向上

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;                                  // 跳过时序列
    for (;;) {
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (reserved[row][c]) continue;
        let dark = 0;
        if (index < bitStream.length) dark = bitStream[index];
        index++;
        if (maskBit(mask, row, c)) dark ^= 1;
        modules[row][c] = dark;
      }
      row += direction;
      if (row < 0 || row >= size) {                          // 撞到边界 → 反向
        row -= direction;
        direction = -direction;
        break;
      }
    }
  }
}

/* ============================ 罚分 ============================ */

const PATTERN_A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];        // 1:1:3:1:1 + 4 浅色
const PATTERN_B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];        // 4 浅色 + 1:1:3:1:1

/**
 * ISO/IEC 18004 的四条掩码罚分规则。
 * 得分越低越好；不同实现可能在 N4 的取整方式上略有差异，
 * 因此掩码选择不作为正确性判据（任何掩码都是合法且可扫描的）。
 */
export function penaltyScore(modules) {
  const size = modules.length;
  let score = 0;

  // N1：行／列中 ≥5 个连续同色模块
  for (let i = 0; i < size; i++) {
    let runRow = 1;
    let runCol = 1;
    for (let j = 1; j < size; j++) {
      if (modules[i][j] === modules[i][j - 1]) runRow++;
      else { if (runRow >= 5) score += 3 + (runRow - 5); runRow = 1; }
      if (modules[j][i] === modules[j - 1][i]) runCol++;
      else { if (runCol >= 5) score += 3 + (runCol - 5); runCol = 1; }
    }
    if (runRow >= 5) score += 3 + (runRow - 5);
    if (runCol >= 5) score += 3 + (runCol - 5);
  }

  // N2：2×2 同色块
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) score += 3;
    }
  }

  // N3：形似定位图形的 1:1:3:1:1（含任一侧 4 模块静默区）
  const countPattern = (get) => {
    let n = 0;
    for (let i = 0; i + 11 <= size; i++) {
      let hitA = true;
      let hitB = true;
      for (let k = 0; k < 11; k++) {
        const v = get(i + k);
        if (v !== PATTERN_A[k]) hitA = false;
        if (v !== PATTERN_B[k]) hitB = false;
      }
      if (hitA) n++;
      if (hitB) n++;
    }
    return n;
  };
  for (let r = 0; r < size; r++) score += 40 * countPattern((k) => modules[r][k]);
  for (let c = 0; c < size; c++) score += 40 * countPattern((k) => modules[k][c]);

  // N4：深色模块比例的偏离度，每偏离 5% 记 10 分
  let dark = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) dark += modules[r][c];
  }
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/* ============================ 对外接口 ============================ */

/** 用指定版本与掩码构造完整矩阵 */
function buildMatrix(version, bitStream, mask) {
  const size = version * 4 + 17;
  const modules = emptyGrid(size);
  const reserved = emptyGrid(size);

  placeFinder(modules, reserved, 0, 0);
  placeFinder(modules, reserved, 0, size - 7);
  placeFinder(modules, reserved, size - 7, 0);
  placeTiming(modules, reserved);
  placeAlignment(modules, reserved, version);
  placeVersionInfo(modules, reserved, version);
  placeFormatInfo(modules, reserved, mask);
  placeData(modules, reserved, bitStream, mask);

  return { modules, reserved };
}

/**
 * 生成二维码矩阵。
 *
 * @param {string} text                  要编码的内容（按 UTF-8 处理）
 * @param {object} [options]
 * @param {number} [options.maxVersion=7] 允许的最大版本
 * @param {number|null} [options.forceMask=null] 强制使用某个掩码；null 表示自动择优
 * @returns {object|null}  内容超出容量时返回 null（绝不返回一个扫不出来的码）
 */
export function encodeQr(text, options = {}) {
  const { maxVersion = MAX_VERSION, forceMask = null } = options;
  const source = String(text ?? '');
  const bytes = toUtf8Bytes(source);

  const version = pickVersion(bytes.length, maxVersion);
  if (!version) return null;

  const dataCodewords_ = buildDataCodewords(bytes, version);
  const interleaved = interleave(dataCodewords_, version);

  const bitStream = [];
  for (const codeword of interleaved) {
    for (let i = 7; i >= 0; i--) bitStream.push((codeword >> i) & 1);
  }

  const masks = forceMask == null ? [0, 1, 2, 3, 4, 5, 6, 7] : [forceMask];
  let best = null;
  for (const mask of masks) {
    const { modules, reserved } = buildMatrix(version, bitStream, mask);
    const penalty = penaltyScore(modules);
    if (!best || penalty < best.penalty) best = { modules, reserved, mask, penalty };
  }

  return {
    text: source,
    bytes,
    version,
    size: version * 4 + 17,
    ecLevel: DEFAULT_EC_LEVEL,
    capacity: byteCapacity(version),
    dataCodewords: dataCodewords_,
    codewords: interleaved,
    ...best,
  };
}

/**
 * 读回格式信息，返回纠错等级编码与掩码编号。
 * 用途：让测试能独立验证「写进去的格式信息能被标准读法读出来」。
 * @returns {{raw:number, data:number, ecBits:number, mask:number, valid:boolean}}
 */
export function readFormatInfo(modules) {
  const size = modules.length;
  let raw = 0;

  for (let i = 0; i < 15; i++) {
    let r;
    if (i < 6) r = i;
    else if (i < 8) r = i + 1;
    else r = size - 15 + i;
    raw |= (modules[r][8] & 1) << i;
  }

  const data = (raw ^ G15_MASK) >> 10;
  return {
    raw,
    data,
    ecBits: (data >> 3) & 0b11,
    mask: data & 0b111,
    valid: bchTypeInfo(data) === raw && data <= 0b11111,
  };
}

/** 把矩阵转成 0/1 文本，便于测试比对与肉眼排查 */
export function matrixToBinary(qr) {
  return qr.modules.map((row) => Array.from(row).join('')).join('\n');
}

/**
 * 渲染为 SVG。
 * 静默区（margin）默认 4 模块，这是规格要求的最小值；调小会导致扫不出来。
 */
export function qrToSvg(qr, options = {}) {
  const { margin = 4, dark = '#000000', light = '#FFFFFF', title = '二维码' } = options;
  const dim = qr.size + margin * 2;

  let path = '';
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.modules[r][c]) path += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" ` +
    `width="100%" height="100%" shape-rendering="crispEdges" ` +
    `role="img" aria-label="${title}">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/>` +
    `</svg>`
  );
}
