/**
 * HTML 结构检查（Node 运行）
 * ---------------------------------------------------------------------------
 * 用法：node tools/check-html.mjs
 *
 * 检查两件事：
 *   1. 常用容器标签是否配平（开合数量一致）
 *   2. 是否存在空 id、重复 id
 *
 * 为什么需要：手改 HTML 时最容易漏掉一个 </div>。浏览器会默默容错并渲染出
 * 错位的页面，肉眼往往看不出来，但布局会莫名其妙地塌掉。
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..'));

const FILES = [
  'index.html', 'quiz.html', 'result.html', 'duo.html', 'report.html', 'about.html',
];

/** 参与配平检查的标签。void 元素（input/br/img/link/meta）不在此列。 */
const PAIRED = [
  'div', 'section', 'main', 'header', 'footer', 'nav', 'aside',
  'p', 'h1', 'h2', 'h3', 'h4', 'span', 'strong', 'em', 'a', 'button',
  'ol', 'ul', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
  'details', 'summary', 'blockquote', 'code', 'pre', 'label', 'nav',
];

function strip(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')      // 注释
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
}

function countTag(src, tag) {
  const open = (src.match(new RegExp(`<${tag}(?=[\\s>/])`, 'gi')) || []).length;
  const close = (src.match(new RegExp(`</${tag}\\s*>`, 'gi')) || []).length;
  return { open, close };
}

let problems = 0;

console.log('\n\x1b[1mHTML 结构检查\x1b[0m\n');

for (const file of FILES) {
  const raw = await readFile(join(ROOT, file), 'utf8');
  const src = strip(raw);
  const errs = [];

  // 1. 标签配平
  for (const tag of [...new Set(PAIRED)]) {
    const { open, close } = countTag(src, tag);
    if (open !== close) errs.push(`${tag} 开 ${open} / 闭 ${close}`);
  }

  // 2. id 检查：重复与空值
  const ids = [...src.matchAll(/\bid\s*=\s*["']([^"']*)["']/g)].map((m) => m[1]);
  const emptyIds = ids.filter((v) => v.trim() === '').length;
  if (emptyIds) errs.push(`存在 ${emptyIds} 个空 id`);

  const dupes = ids.filter((v, i) => ids.indexOf(v) !== i);
  if (dupes.length) errs.push(`重复 id：${[...new Set(dupes)].join(', ')}`);

  // 3. 必需要素
  if (!/<main id="main"/.test(src)) errs.push('缺少 <main id="main">');
  if (!/lang="zh-CN"/.test(raw)) errs.push('缺少 lang="zh-CN"');
  if (!/name="viewport"/.test(src)) errs.push('缺少 viewport meta');

  const mark = errs.length ? '\x1b[31m✗\x1b[0m' : '\x1b[32m✓\x1b[0m';
  console.log(`${mark} ${file.padEnd(14)} id ${String(ids.length).padStart(2)} 个`);
  if (errs.length) {
    problems += 1;
    errs.forEach((e) => console.log(`    \x1b[31m${e}\x1b[0m`));
  }
  console.log('');
}

console.log('─'.repeat(60));
console.log(problems === 0
  ? '\x1b[32m\x1b[1m结构检查全部通过\x1b[0m\n'
  : `\x1b[31m\x1b[1m${problems} 个文件存在问题\x1b[0m\n`);
if (problems) process.exitCode = 1;
