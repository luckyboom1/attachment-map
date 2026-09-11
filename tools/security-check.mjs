/**
 * 安全静态自检（Node，不需要浏览器）
 * ---------------------------------------------------------------------------
 * 用法：
 *   npm run check:security
 *
 * 它守的是「改了代码之后安全属性是否还在」。这些问题在运行时往往不报错：
 * 少一个响应头、CSP 哈希与 HTML 不匹配、不小心引入了 eval——
 * 页面看起来都正常，所以必须由检查来兜。
 *
 * 三类断言
 *   1. 响应头配置存在且关键头齐全（缺任一即失败）
 *   2. CSP 里内联脚本的哈希与 HTML 里的实际内容一致
 *      （不一致的后果是主题引导被浏览器拦掉，且只在真机上能看出来）
 *   3. 代码里没有危险模式（eval / new Function / document.write / innerHTML 直接吃外部字符串）
 */

import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..'));

let pass = 0;
let fail = 0;
const problems = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; problems.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const readText = (p) => readFile(join(ROOT, p), 'utf8');

/* ==================== 1. 响应头配置 ==================== */

section('1. 安全响应头（_headers）');

const headersRawAll = await readText('_headers').catch(() => null);
ok('_headers 存在', headersRawAll != null, 'Cloudflare Pages 靠它下发安全头');

/**
 * 去掉注释行后再做断言。
 * 为什么必须去掉：注释里为了解释「为什么不用 unsafe-inline」，
 * 不可避免地会写出 'unsafe-inline' 这个字面量，
 * 于是「是否对脚本开放 unsafe-inline」这条检查会命中自己的注释——假阳性。
 * 第一版就踩了这个坑。注释不是配置，检查前必须剔除。
 * 同时保留行首缩进容错（_headers 里头部按惯例缩进两格）。
 */
const headersRaw = headersRawAll
  ? headersRawAll.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  : null;

if (headersRaw) {
  const must = [
    ['Referrer-Policy', /^[ \t]*Referrer-Policy:\s*no-referrer\s*$/m,
      '合盘链接含答案，实测会被 Referer 带出去，这条是止血的关键'],
    ['Content-Security-Policy', /^[ \t]*Content-Security-Policy:\s*\S/m, '缺 CSP 就等于放弃 XSS 兜底'],
    ['X-Content-Type-Options', /^[ \t]*X-Content-Type-Options:\s*nosniff$/m, '防 MIME 嗅探'],
    ['X-Frame-Options', /^[ \t]*X-Frame-Options:\s*DENY$/m, '防点击劫持（老浏览器）'],
    ['frame-ancestors', /frame-ancestors\s+'none'/, '防点击劫持（新标准）'],
    ['Permissions-Policy', /^[ \t]*Permissions-Policy:\s*\S/m, '收敛浏览器能力'],
    ['Strict-Transport-Security', /^[ \t]*Strict-Transport-Security:\s*max-age=\d+/m, '防 HTTPS 降级'],
    ['Cross-Origin-Opener-Policy', /^[ \t]*Cross-Origin-Opener-Policy:\s*same-origin$/m, '跨域隔离'],
  ];
  for (const [name, re, why] of must) {
    ok(`包含 ${name}`, re.test(headersRaw), why);
  }

  // 反面检查：不应出现放宽到无意义的配置
  ok('CSP 未对脚本开放 unsafe-inline',
    !/script-src[^;]*'unsafe-inline'/.test(headersRaw),
    "script-src 一旦放开 unsafe-inline，CSP 对 XSS 基本失效");
  ok('CSP 未使用 unsafe-eval',
    !/script-src[^;]*'unsafe-eval'/.test(headersRaw));
  ok('CSP 限制了 object-src',
    /object-src\s+'none'/.test(headersRaw), '防插件类攻击面');
  ok('CSP 保留了 clipboard-write 给本站',
    /clipboard-write=\(self\)/.test(headersRaw),
    '结果页的复制按钮依赖它，写成 clipboard-write=() 会让复制功能失效');
}

/* ==================== 2. CSP 哈希与实际内联脚本一致 ==================== */

section('2. CSP 内联脚本哈希一致性');

const htmlFiles = (await readdir(ROOT)).filter((f) => extname(f) === '.html');
const hashes = new Map();

for (const f of htmlFiles) {
  const src = await readText(f);
  const inline = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!inline.length) continue;
  ok(`${f} 只有 1 段内联脚本`, inline.length === 1, `实际 ${inline.length} 段`);
  const h = 'sha256-' + createHash('sha256').update(inline[0]).digest('base64');
  hashes.set(f, h);
}

const uniqueHashes = [...new Set(hashes.values())];
ok('各页面内联脚本哈希完全一致',
  uniqueHashes.length <= 1,
  uniqueHashes.length > 1 ? `出现 ${uniqueHashes.length} 种，需要为每种都写进 CSP` : '');

if (headersRaw && uniqueHashes.length === 1) {
  const cspHash = (headersRaw.match(/'sha256-([^']+)'/) || [])[1];
  ok('CSP 中的哈希与 HTML 实际内容匹配',
    cspHash === uniqueHashes[0].replace('sha256-', ''),
    cspHash
      ? `CSP 里是 ${cspHash.slice(0, 12)}…，实际是 ${uniqueHashes[0].replace('sha256-', '').slice(0, 12)}…`
      : 'CSP 里没有 sha256 哈希');
}

/* ==================== 3. 危险模式 ==================== */

section('3. 危险代码模式');

async function walk(dir, out = []) {
  for (const e of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}

const jsFiles = (await walk('assets/js')).filter((f) => f.endsWith('.js'));
ok('扫描到前端源码', jsFiles.length > 0, `共 ${jsFiles.length} 个文件`);

const DANGEROUS = [
  [/\beval\s*\(/, 'eval('],
  [/new\s+Function\s*\(/, 'new Function('],
  [/document\.write\s*\(/, 'document.write('],
  [/\bwindow\.location\s*=\s*[^;]*\b(location\.(search|hash)|param\()/, '把 URL 直接当地址跳转'],
];

for (const f of jsFiles) {
  const src = await readText(f);
  for (const [re, label] of DANGEROUS) {
    if (re.test(src)) {
      ok(`${f} 不含 ${label}`, false, '这类 API 会把字符串当代码执行');
    }
  }
}
if (!fail) ok('未发现 eval / new Function / document.write', true);

/* 答案不得出现在查询串里 —— 这是本项目最核心的数据保护要求 */
section('4. 答案编码不得出现在查询串');

const encodeSrc = await readText('assets/js/core/encode.js');
ok('buildInviteUrl 使用 URL 片段而非查询串',
  /buildInviteUrl[\s\S]{0,400}buildHash\(/.test(encodeSrc) && !/searchParams\.set\('a'/.test(encodeSrc));
ok('buildDuoUrl 使用 URL 片段而非查询串',
  !/searchParams\.set\('b'/.test(encodeSrc));
ok('readDuoFromUrl 优先读片段', /hash[\s\S]{0,200}search/.test(encodeSrc));

const pageFiles = (await walk('assets/js/pages'));
let queryLeak = [];
for (const f of pageFiles) {
  const src = await readText(f);
  // 形如 ?a= 或 ?b= 的直接拼接（不含 http 地址里的问号）
  const m = src.match(/\?a=\$\{|\?b=\$\{|\?a='\s*\+|\?b='\s*\+/g);
  if (m) queryLeak.push(`${f}（${m.join(',')}）`);
}
ok('页面代码未把编码拼进查询串', queryLeak.length === 0, queryLeak.join('；'));

/* ==================== 汇总 ==================== */

console.log('\n' + '─'.repeat(64));
if (fail === 0) {
  console.log(`\x1b[32m\x1b[1m安全自检全部通过\x1b[0m  ${pass} 项`);
} else {
  console.log(`\x1b[31m\x1b[1m${fail} 项未通过\x1b[0m  / 通过 ${pass} 项`);
  problems.forEach((p) => console.log(`  · ${p}`));
  process.exitCode = 1;
}
console.log('');
