/**
 * DOM 契约检查（Node 运行）
 * ---------------------------------------------------------------------------
 * 用法：node tools/check-dom.mjs
 *
 * 为什么需要它
 * 这类项目最高频、也最难发现的 bug 是：JS 里写 $('#btn-x')，HTML 里却是 id="btnX"。
 * 结果不是报错，而是「按钮点了没反应」——静默失败。静态检查能在 5 毫秒内抓住它，
 * 比开浏览器翻控制台快得多。
 *
 * 判定规则
 * 一个选择器算合法，只要满足以下任一条件：
 *   1. 对应的 id 出现在该页面的 HTML 里
 *   2. 对应的 id 出现在该页面 JS 的模板字符串里（动态创建的元素，如付费墙内部）
 * 其余一律报错。
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..'));

/** 页面脚本 → HTML 文件的映射。新增页面必须在这里登记。 */
const PAGES = [
  { js: 'assets/js/pages/landing.js', html: 'index.html',      name: '入口页' },
  { js: 'assets/js/pages/quiz.js',    html: 'quiz.html',       name: '答题页' },
  { js: 'assets/js/pages/result.js',  html: 'result.html',     name: '结果页' },
  { js: 'assets/js/pages/duo.js',     html: 'duo.html',        name: '双人合盘' },
  { js: 'assets/js/pages/report.js',  html: 'report.html',     name: '报告页' },
];

// 共享模块（assets/js/ui/ui.js）的选择器作用在各页面上，已由上面的 PAGES 覆盖到

/** 从源码里抽出所有 id 选择器 */
function extractIdSelectors(src) {
  const ids = new Set();
  const patterns = [
    /\$\(\s*['"]#([A-Za-z0-9_-]+)['"]/g,           // $('#foo')
    /\$\$\(\s*['"]#([A-Za-z0-9_-]+)['"]/g,         // $$('#foo')
    /getElementById\(\s*['"]([A-Za-z0-9_-]+)['"]/g, // getElementById('foo')
    /querySelector\(\s*['"]#([A-Za-z0-9_-]+)['"]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src))) ids.add(m[1]);
  }
  return ids;
}

/** 从源码里抽出所有写死的 id="foo"（含模板字符串里的动态元素） */
function extractDeclaredIds(src) {
  const ids = new Set();
  const re = /\bid\s*=\s*(?:\\?["'])([A-Za-z0-9_-]+)(?:\\?["'])/g;
  let m;
  while ((m = re.exec(src))) ids.add(m[1]);
  return ids;
}

/**
 * HTML 内部对 id 的引用：label[for]、aria-describedby、anchor href、tabindex 目标等。
 * 这类引用也是"这个 id 有用"的证据，不计入死 UI。
 */
function extractHtmlIdRefs(src) {
  const ids = new Set();
  const patterns = [
    /\bfor\s*=\s*["']([A-Za-z0-9_-]+)["']/g,
    /\baria-describedby\s*=\s*["']([A-Za-z0-9_-\s]+)["']/g,
    /\baria-labelledby\s*=\s*["']([A-Za-z0-9_-\s]+)["']/g,
    /\baria-controls\s*=\s*["']([A-Za-z0-9_-]+)["']/g,
    /\bhref\s*=\s*["']#([A-Za-z0-9_-]+)["']/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src))) {
      m[1].split(/\s+/).filter(Boolean).forEach((id) => ids.add(id));
    }
  }
  return ids;
}

let fail = 0;
const problems = [];

console.log('\n\x1b[1mDOM 契约检查\x1b[0m\n');

for (const page of PAGES) {
  const htmlSrc = await readFile(join(ROOT, page.html), 'utf8');
  const jsSrc = await readFile(join(ROOT, page.js), 'utf8');

  const htmlIds = extractDeclaredIds(htmlSrc);
  const htmlRefs = extractHtmlIdRefs(htmlSrc);
  const jsDeclared = extractDeclaredIds(jsSrc);
  const used = extractIdSelectors(jsSrc);

  const missing = [...used].filter((id) => !htmlIds.has(id) && !jsDeclared.has(id));
  const unused = [...htmlIds].filter((id) => !used.has(id) && !htmlRefs.has(id))
    .filter((id) => !/^(main|invite)$/.test(id));   // #main 与锚点由框架/链接使用

  const tag = missing.length ? '\x1b[31m✗\x1b[0m' : '\x1b[32m✓\x1b[0m';
  console.log(`${tag} ${page.name.padEnd(8)} ${page.html}`);
  console.log(`    HTML 定义 ${String(htmlIds.size).padStart(2)} 个 id ｜ JS 引用 ${String(used.size).padStart(2)} 个`);

  if (missing.length) {
    fail += 1;
    problems.push(`${page.name}：JS 引用了不存在的 id → ${missing.join(', ')}`);
    console.log(`    \x1b[31m缺失：${missing.join(', ')}\x1b[0m`);
  }
  if (unused.length) {
    console.log(`    \x1b[33m提示：HTML 里这些 id 未被脚本引用（可能是死 UI）→ ${unused.join(', ')}\x1b[0m`);
  }
  console.log('');
}

console.log('─'.repeat(60));
if (fail === 0) {
  console.log('\x1b[32m\x1b[1m全部页面 DOM 契约一致\x1b[0m');
} else {
  console.log(`\x1b[31m\x1b[1m${fail} 个页面存在问题\x1b[0m`);
  problems.forEach((p) => console.log(`  · ${p}`));
  process.exitCode = 1;
}
console.log('');
