/**
 * 自检脚本（Node 运行，不依赖浏览器）
 * ---------------------------------------------------------------------------
 * 用途：在浏览器之外验证计分、编码、合盘、报告四条核心链路。
 * 用法：node tools/selftest.mjs
 *
 * 为什么必须有这个文件
 * 计分和编解码是全站的确定性内核。它们一旦出错，前端所有页面都会"看起来正常
 * 但结果全错"，而这类错误极难在界面上被发现。所以核心逻辑必须有脱离 UI 的测试。
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { QUESTIONS, TOTAL_QUESTIONS, auditQuestions } from '../assets/js/data/questions.js';
import { NORMS, toZ, zToPercentile, overCut, normsDisclosure } from '../assets/js/core/norms.js';
import { score, MAX_DISTANCE, bandText } from '../assets/js/core/scoring.js';
import { classify, TYPES, TYPE_TABLE } from '../assets/js/core/types.js';
import { encodeAnswers, decodeAnswers, answersToArray, arrayToAnswers, isComplete } from '../assets/js/core/encode.js';
import { computeDuo, getPairNote, TYPE_KEYS } from '../assets/js/core/duo.js';
import { buildReport, buildDuoReport } from '../assets/js/core/report.js';
import { buildPosterSpec, POSTER_LAYOUT, POSTER_PALETTE } from '../assets/js/core/poster.js';

const ROOT = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..'));

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ' — ' + detail : ''}`); }
}

function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

/* ===================== 1. 题库自检 ===================== */

section('1. 题库自检');
{
  const a = auditQuestions();
  console.log(`   题量 ${a.total} ｜ 焦虑 ${a.anxiety} ｜ 回避 ${a.avoidance} ｜ 反向 ${a.reverse}`);
  ok('无结构性告警', a.problems.length === 0, a.problems.join('；'));
  ok('题干均非空', QUESTIONS.every((q) => q.text && q.text.trim().length >= 6));
  ok('题干无重复', new Set(QUESTIONS.map((q) => q.text)).size === TOTAL_QUESTIONS);
  ok('id 连续 1..36', QUESTIONS.every((q, i) => q.id === i + 1));
}

/* ===================== 2. 计分正确性 ===================== */

section('2. 计分正确性');
{
  // 全选 1：焦虑题全 1 分、回避题全 1 分，但反向题会被翻转成 7
  const all1 = arrayToAnswers(Array(TOTAL_QUESTIONS).fill(1));
  const r1 = score(all1);
  // 焦虑 18 题中有 4 道反向（code a3,a7,a10,a13）→ 得分 7，其余 14 道得分 1
  const expectA1 = (14 * 1 + 4 * 7) / 18;
  const expectV1 = (14 * 1 + 4 * 7) / 18;
  ok('全选 1：焦虑维度按反向题翻转', Math.abs(r1.A - expectA1) < 0.01, `实际 ${r1.A}，期望 ${expectA1.toFixed(2)}`);
  ok('全选 1：回避维度按反向题翻转', Math.abs(r1.V - expectV1) < 0.01, `实际 ${r1.V}，期望 ${expectV1.toFixed(2)}`);

  // 全选 7：镜像结果
  const all7 = arrayToAnswers(Array(TOTAL_QUESTIONS).fill(7));
  const r7 = score(all7);
  ok('全选 7 与全选 1 之和恒为 8', Math.abs((r1.A + r7.A) - 8) < 0.01, `${r1.A} + ${r7.A} = ${r1.A + r7.A}`);

  // 全选 4：落在正中
  const all4 = arrayToAnswers(Array(TOTAL_QUESTIONS).fill(4));
  const r4 = score(all4);
  ok('全选 4：焦虑均分为 4', Math.abs(r4.A - 4) < 0.01);
  ok('全选 4：回避均分为 4', Math.abs(r4.V - 4) < 0.01);
  ok('全选 4：z 分数等于相对参照样本均值的偏离',
     Math.abs(r4.zA - toZ(4, NORMS.anxiety)) < 0.01 &&
     Math.abs(r4.zV - toZ(4, NORMS.avoidance)) < 0.01,
     `zA=${r4.zA}（参照均值 ${NORMS.anxiety.mean}），zV=${r4.zV}（参照均值 ${NORMS.avoidance.mean}）`);
  ok('全选 4：判为安全型（4.0 未越过切分点 4.0）', r4.type === 'secure', `实际 ${r4.type}`);
  ok('全选 4：百分位高于 50（4 分高于参照样本均值）', r4.pctA > 50 && r4.pctV > 50,
     `pctA=${r4.pctA}，pctV=${r4.pctV}`);
  ok('全选 4：强度分档为 mid（落在切分点 ±0.5 带内）',
     r4.bandA === 'mid' && r4.bandV === 'mid', `${r4.bandA} / ${r4.bandV}`);

  // 确定性：同输入必须同输出
  const a1 = score(all1);
  const a2 = score(all1);
  eq('确定性：两次计分结果完全一致', a1.A, a2.A);
  eq('确定性：类型完全一致', a1.type, a2.type);

  // 构造一个明确的焦虑型：焦虑题全 7，回避题全 1
  const anxOnly = {};
  QUESTIONS.forEach((q) => {
    anxOnly[q.id] = (q.dimension === 'anxiety') === !q.reverse ? 7 : 1;
  });
  const rAnx = score(anxOnly);
  ok('构造焦虑型：焦虑高、回避低', rAnx.type === 'anxious', `实际 ${rAnx.type}（A=${rAnx.A}, V=${rAnx.V}）`);

  // 构造一个明确的回避型
  const avoOnly = {};
  QUESTIONS.forEach((q) => {
    avoOnly[q.id] = (q.dimension === 'avoidance') === !q.reverse ? 7 : 1;
  });
  const rAvo = score(avoOnly);
  ok('构造回避型：回避高、焦虑低', rAvo.type === 'avoidant', `实际 ${rAvo.type}（A=${rAvo.A}, V=${rAvo.V}）`);

  // 构造恐惧型
  const both = {};
  QUESTIONS.forEach((q) => { both[q.id] = q.reverse ? 1 : 7; });
  const rBoth = score(both);
  ok('构造恐惧型：两个维度都高', rBoth.type === 'fearful', `实际 ${rBoth.type}（A=${rBoth.A}, V=${rBoth.V}）`);

  // 所有取值都在合法区间
  [r1, r7, r4, rAnx, rAvo, rBoth].forEach((r, i) => {
    ok(`结果 ${i + 1} 数值区间合法`, r.A >= 1 && r.A <= 7 && r.V >= 1 && r.V <= 7 && r.pctA >= 0 && r.pctA <= 100);
  });
}

/* ===================== 3. 反向题定义正确性 ===================== */

section('3. 反向题定义');
{
  const rev = QUESTIONS.filter((q) => q.reverse);
  eq('反向题共 8 道', rev.length, 8);
  eq('焦虑反向题 4 道', rev.filter((q) => q.dimension === 'anxiety').length, 4);
  eq('回避反向题 4 道', rev.filter((q) => q.dimension === 'avoidance').length, 4);

  // 逐条验证：把某一道反向题从 1 改成 7，该维度均分应当下降
  const base = arrayToAnswers(Array(TOTAL_QUESTIONS).fill(4));
  const b0 = score(base);
  rev.forEach((q) => {
    const altered = { ...base, [q.id]: 7 };
    const r = score(altered);
    const dim = q.dimension === 'anxiety' ? [r.A, b0.A] : [r.V, b0.V];
    ok(`反向题 ${q.code} 拉高原始分后维度分下降`, dim[0] < dim[1], `${dim[0]} vs ${dim[1]}`);
  });
}

/* ===================== 4. 百分位 ===================== */

section('4. 百分位转换');
{
  eq('z=0 → 百分位 50', zToPercentile(0), 50);
  ok('z=1.96 → 约 97.5', Math.abs(zToPercentile(1.96) - 98) <= 1, `${zToPercentile(1.96)}`);
  ok('z=-1.96 → 约 2.5', Math.abs(zToPercentile(-1.96) - 2) <= 1, `${zToPercentile(-1.96)}`);
  ok('极端 z 不越界', zToPercentile(10) === 100 && zToPercentile(-10) === 0);
}

/* ===================== 5. 编解码 ===================== */

section('5. 答案编解码（双人合盘的零后端基础）');
{
  const samples = [
    Array(TOTAL_QUESTIONS).fill(1),
    Array(TOTAL_QUESTIONS).fill(7),
    Array(TOTAL_QUESTIONS).fill(4),
    Array.from({ length: TOTAL_QUESTIONS }, (_, i) => (i % 7) + 1),
    Array.from({ length: TOTAL_QUESTIONS }, () => Math.floor(Math.random() * 7) + 1),
  ];

  samples.forEach((vals, i) => {
    const code = encodeAnswers(vals);
    const back = decodeAnswers(code);
    eq(`样本 ${i + 1} 往返一致`, back, vals);
  });

  const code = encodeAnswers(samples[3]);
  console.log(`   编码长度：${code.length} 字符（36 题 × 3 bit → 14 byte → base64url）`);
  ok('编码长度在 19 字符以内', code.length <= 19, `实际 ${code.length}`);
  ok('编码只含 URL 安全字符', /^[A-Za-z0-9\-_]+$/.test(code));

  // 随机 300 组往返
  let rtFail = 0;
  for (let i = 0; i < 300; i++) {
    const vals = Array.from({ length: TOTAL_QUESTIONS }, () => Math.floor(Math.random() * 7) + 1);
    if (JSON.stringify(decodeAnswers(encodeAnswers(vals))) !== JSON.stringify(vals)) rtFail++;
  }
  eq('随机 300 组往返零失败', rtFail, 0);

  // 非法输入必须安全返回 null，不得抛异常
  ['', null, undefined, 'x', '!!!!', 'a'.repeat(200)].forEach((bad) => {
    let threw = false;
    let out;
    try { out = decodeAnswers(bad); } catch { threw = true; }
    ok(`非法输入安全处理：${JSON.stringify(String(bad).slice(0, 12))}`, !threw && out === null);
  });

  // 题量不符必须抛错（这是开发期错误，需要被立刻发现）
  let threw = false;
  try { encodeAnswers([1, 2, 3]); } catch { threw = true; }
  ok('题量不符时抛错', threw);

  // 互转
  const map = { 1: 5, 2: 3 };
  const arr = answersToArray(map);
  eq('answersToArray 长度', arr.length, TOTAL_QUESTIONS);
  ok('answersToArray 未作答处为 null', arr[0] === 5 && arr[1] === 3 && arr[2] === null);
  ok('isComplete 对不完整作答返回 false', isComplete(map) === false);
}

/* ===================== 6. 双人合盘 ===================== */

section('6. 双人合盘');
{
  // 构造一对焦虑 × 回避（追逃循环）
  const anx = {}; const avo = {};
  QUESTIONS.forEach((q) => {
    anx[q.id] = (q.dimension === 'anxiety') === !q.reverse ? 7 : 1;
    avo[q.id] = (q.dimension === 'avoidance') === !q.reverse ? 7 : 1;
  });
  const rAnx = score(anx);
  const rAvo = score(avo);
  const duo = computeDuo(rAnx, rAvo);

  ok('识别出焦虑型 × 回避型', duo.types.a.key === 'anxious' && duo.types.b.key === 'avoidant');
  ok('命中追逃循环', duo.trap === true);
  ok('追逃时不给出适配分', duo.fitScore === null);
  ok('保留原始适配分供埋点', typeof duo.rawFitScore === 'number');
  ok('追逃时 band 为 trap', duo.band.key === 'trap');
  ok('distance 为有限数值', Number.isFinite(duo.distance) && duo.distance > 0);

  // 同类型：距离应为 0
  const same = computeDuo(rAnx, rAnx);
  eq('同一份结果的距离为 0', same.distance, 0);
  eq('同一份结果的适配度为 100', same.rawFitScore, 100);

  // 距离的三角不等式与上界
  const rSec = score(arrayToAnswers(Array(TOTAL_QUESTIONS).fill(4)));
  const d1 = computeDuo(rSec, rAnx).distance;
  const d2 = computeDuo(rSec, rAvo).distance;
  ok('距离不超过最大可能距离', d1 <= MAX_DISTANCE + 0.01 && d2 <= MAX_DISTANCE + 0.01,
     `max=${MAX_DISTANCE.toFixed(2)}`);

  // 全部 10 组配对都要有文案，且不得为空
  const pairs = [];
  for (let i = 0; i < TYPE_KEYS.length; i++) {
    for (let j = i; j < TYPE_KEYS.length; j++) pairs.push([TYPE_KEYS[i], TYPE_KEYS[j]]);
  }
  eq('配对组合共 10 组', pairs.length, 10);
  ok('10 组配对全部有互动文案', pairs.every(([a, b]) => {
    const n = getPairNote(a, b);
    return n && n.title && n.dynamics && Array.isArray(n.advice) && n.advice.length >= 1;
  }));
  ok('配对文案与顺序无关（对称）', pairs.every(([a, b]) => getPairNote(a, b).title === getPairNote(b, a).title));

  // 报告章节数量
  const duoReport = buildDuoReport(rAnx, rAvo, duo);
  eq('合盘报告 6 章', duoReport.sections.length, 6);
  ok('合盘报告免责声明含「不构成心理诊断」', duoReport.disclaimer.includes('不构成心理诊断'));
  ok('合盘报告不含「诊断」以外的效力宣称', !/本报告可诊断|具有诊断/.test(JSON.stringify(duoReport)));
}

/* ===================== 7. 报告与伦理红线 ===================== */

section('7. 报告输出与伦理红线');
{
  const r = score(arrayToAnswers(Array(TOTAL_QUESTIONS).fill(4)));
  const report = buildReport(r);
  eq('单人报告 8 章', report.sections.length, 8);
  ok('报告为模板生成（可复现优先）', report.generatedBy === 'template');
  ok('章节标题均非空', report.sections.every((s) => s.title && s.body && s.body.length > 40));

  // 四个类型都要能出报告且不报错
  TYPE_KEYS.forEach((k) => {
    const fake = { ...r, type: k };
    const rep = buildReport(fake);
    ok(`${TYPES[k].name} 报告可生成（${rep.sections.length} 章）`, rep.sections.length === 8);
  });

  // 伦理红线：全文不得出现贬损词与诊断效力表述
  const BANNED = ['缺陷', '不正常', '有病', '冷漠', '心理疾病', '诊断', '治疗',
    // 归罪式框架：把模式说成「用户踩的坑」，与「这不是刻痕，是当年合理的适应」的
    // 全文立场自相矛盾。措辞本身就是在判人。
    '踩的坑'];
  const allText = TYPE_KEYS.map((k) => {
    const rep = buildReport({ ...r, type: k });
    return rep.sections.map((s) => s.title + s.body).join('\n');
  }).join('\n');

  const hits = BANNED.filter((w) => allText.includes(w));
  // 「诊断」与「治疗」允许出现在"不构成诊断""替代治疗"这类否定语境中，单独人工确认
  const softAllowed = ['诊断', '治疗'];
  const hardHits = hits.filter((w) => !softAllowed.includes(w));
  ok('报告无贬损性词汇', hardHits.length === 0, hardHits.join('、'));

  const disclaimerOk = report.disclaimer.includes('不构成心理诊断');
  ok('免责声明明确否认诊断效力', disclaimerOk);

  // 每个类型都必须给出「可改变的出口」
  const hasExit = TYPE_KEYS.every((k) => TYPES[k].profile.exit && TYPES[k].profile.exit.length > 20);
  ok('四个类型均包含「可改变的出口」文案', hasExit);

  // 类型表完整性
  eq('类型速查表 4 行', TYPE_TABLE.length, 4);
  ok('类型表规则与类型一一对应', TYPE_TABLE.every((t) => TYPES[t.key]));

  // classify 覆盖全部象限（用维度均分与切分点，不用 z 分数）
  const CUT = NORMS.cut;
  eq('classify(高焦虑 高回避) → fearful', classify(5, 5, CUT), 'fearful');
  eq('classify(高焦虑 低回避) → anxious', classify(5, 3, CUT), 'anxious');
  eq('classify(低焦虑 高回避) → avoidant', classify(3, 5, CUT), 'avoidant');
  eq('classify(低焦虑 低回避) → secure', classify(3, 3, CUT), 'secure');
  eq('恰好落在切分点上不算越线 → secure',
     classify(CUT.anxiety, CUT.avoidance, CUT), 'secure');
}

/* ===================== 8. 常模一致性 ===================== */

section('8. 常模与切分');
{
  /* ---- 基本性质 ---- */
  eq('toZ 在均值处为 0', toZ(NORMS.anxiety.mean, NORMS.anxiety), 0);
  ok('toZ 随原始分单调递增',
     toZ(4.5, NORMS.anxiety) > toZ(4.0, NORMS.anxiety) && toZ(4.0, NORMS.anxiety) > toZ(3.5, NORMS.anxiety));
  ok('常模标明了来源状态', ['provisional', 'published', 'site-sample'].includes(NORMS.source));
  ok('四个象限均有类型定义', TYPE_KEYS.length === 4);

  /* ---- 两套口径必须分开维护（这是本模块最容易搞错的地方） ---- */
  ok('切分点是独立字段，与常模均值不共用',
     Number.isFinite(NORMS.cut.anxiety) && Number.isFinite(NORMS.cut.avoidance));
  ok('回归：高于参照样本均值 ≠ 越过切分点',
     toZ(3.6, NORMS.avoidance) > 0 && overCut(3.6, 'avoidance') === false,
     `3.60 相对均值 ${NORMS.avoidance.mean} 的 z=${toZ(3.6, NORMS.avoidance).toFixed(2)}，切分点 ${NORMS.cut.avoidance}`);

  const r = score(arrayToAnswers(Array(TOTAL_QUESTIONS).fill(4)));
  ok('均分 4 时：z > 0 但类型仍由切分点决定 → 判为低',
     r.zA > 0 && r.zV > 0 && r.type === 'secure',
     `zA=${r.zA}，zV=${r.zV}，type=${r.type}`);

  // 分档与类型必须同一基准，否则会出现「类型低、分档高」的自相矛盾
  ok('分档与类型同基准：未越切分点的分数不得被标为 high',
     r.bandA !== 'high' && r.bandV !== 'high', `${r.bandA} / ${r.bandV}`);

  /* ---- 按来源状态校验 ---- */
  if (NORMS.source === 'published') {
    ok('published 必须带出处', typeof NORMS.citation === 'string' && NORMS.citation.length > 20);
    ok('出处含年份', /(19|20)\d{2}/.test(NORMS.citation || ''), NORMS.citation || '（空）');
    ok('published 不再展示「暂定」标注', normsDisclosure().label !== NORMS.provisionalLabel);
    ok('published 必须写明题本差异（不是 ECR 原题）',
       typeof NORMS.itemSetCaveat === 'string' &&
       /改写|不是 ECR/.test(NORMS.itemSetCaveat));
    ok('published 必须写明参照样本', typeof NORMS.referenceShort === 'string' && NORMS.referenceShort.length > 5);
  }
  if (NORMS.source === 'provisional') {
    ok('暂定常模必须带标注文案', !!NORMS.provisionalLabel && !!NORMS.provisionalNote);
    ok('暂定常模不得声称有出处', NORMS.citation === null);
  }

  /* ---- 数值量级守卫：防止录入错位数（例如把 1.2 当成 7 点量表的均值） ---- */
  [['anxiety', '焦虑'], ['avoidance', '回避']].forEach(([key, cn]) => {
    const n = NORMS[key];
    ok(`${cn}参照均值在合理区间 2.5–4.5`, n.mean >= 2.5 && n.mean <= 4.5, `实际 ${n.mean}`);
    ok(`${cn}参照标准差在合理区间 0.3–1.5`, n.sd >= 0.3 && n.sd <= 1.5, `实际 ${n.sd}`);
  });
  ok('切分点落在量表内部',
     NORMS.cut.anxiety > NORMS.scaleMin && NORMS.cut.anxiety < NORMS.scaleMax &&
     NORMS.cut.avoidance > NORMS.scaleMin && NORMS.cut.avoidance < NORMS.scaleMax);
  ok('分档带宽为正且小于半量程', NORMS.cut.band > 0 && NORMS.cut.band < (NORMS.scaleMax - NORMS.scaleMin) / 2);
  ok('切分点标明依据', typeof NORMS.cut.basis === 'string' && NORMS.cut.basis.length > 0, NORMS.cut.basis);

  /* ---- 交叉核对表 ---- */
  ok('交叉核对至少 3 个来源',
     Array.isArray(NORMS.crossCheck) && NORMS.crossCheck.length >= 3,
     `实际 ${NORMS.crossCheck?.length} 条`);
  ok('交叉核对每条数值量级合理', NORMS.crossCheck.every((c) =>
     c.anxiety >= 2.5 && c.anxiety <= 4.5 && c.avoidance >= 2.5 && c.avoidance <= 4.5 &&
     c.anxietySd >= 0.3 && c.anxietySd <= 1.5 && c.avoidanceSd >= 0.3 && c.avoidanceSd <= 1.5));
  ok('交叉核对恰好一条被标为主参照',
     NORMS.crossCheck.filter((c) => c.primary).length === 1);
  ok('主参照与切分点引用的数值一致',
     (() => {
       const p = NORMS.crossCheck.find((c) => c.primary);
       return p && p.anxiety === NORMS.anxiety.mean && p.avoidance === NORMS.avoidance.mean;
     })(),
     '防止改了 NORMS.anxiety 却忘了同步交叉核对表，导致页面自相矛盾');

  /* ---- 所有类型都能出结果且分档文案齐全 ---- */
  ['low', 'mid', 'high'].forEach((band) => {
    ok(`分档文案齐全：${band}`,
       !!bandText(band, 'anxiety') && !!bandText(band, 'avoidance'));
  });
}

/* ============= 9. 关心契约：免费区里必须有出口与求助入口 ============= */

section('9. 关心契约：免费区里必须有出口与求助入口');
{
  const resultJs = await readFile(join(ROOT, 'assets/js/pages/result.js'), 'utf8');
  const resultHtml = await readFile(join(ROOT, 'result.html'), 'utf8');
  const quizJs = await readFile(join(ROOT, 'assets/js/pages/quiz.js'), 'utf8');
  const quizHtml = await readFile(join(ROOT, 'quiz.html'), 'utf8');
  const indexHtml = await readFile(join(ROOT, 'index.html'), 'utf8');

  /* ---- 可改变的出口必须在付费墙之前 ----
     这条防的是「文案里写了出口、但渲染到了付费墙后面」。
     存着不等于给了：对用户而言，看不到就等于不存在。 */
  const exitCall = resultJs.indexOf('renderExit(type);');
  const paywallCall = resultJs.indexOf('renderPaywall(ent, currentId);');
  ok('结果页渲染了「可改变的出口」', exitCall !== -1);
  ok('出口渲染发生在付费墙之前',
     exitCall !== -1 && paywallCall !== -1 && exitCall < paywallCall,
     `exit@${exitCall}，paywall@${paywallCall}`);
  ok('出口容器存在于 result.html', resultHtml.includes('id="exit-card"'));

  /* ---- 危机求助资源必须免费可见，且不被变现动作挡在后面 ----
     这些题问的是被抛弃的恐惧和关系里的自我怀疑，答完的情绪强度可能高于答题之前。 */
  const hotline = resultHtml.indexOf('12356');
  const paywallHtml = resultHtml.indexOf('id="paywall"');
  ok('结果页含危机求助热线（12356）', hotline !== -1);
  ok('求助热线在付费墙之前', hotline !== -1 && paywallHtml !== -1 && hotline < paywallHtml,
     `hotline@${hotline}，paywall@${paywallHtml}`);

  /* ---- 答题过程必须有中途陪伴语 ----
     36 题里 28 题在让用户确认自己的不安，连续确认本身就是情绪负荷。 */
  ok('答题页有陪伴语容器', quizHtml.includes('id="cushion"'));
  const cushionStart = quizJs.indexOf('const CUSHION_LINES');
  const cushionBlock = cushionStart === -1
    ? ''
    : quizJs.slice(cushionStart, quizJs.indexOf('];', cushionStart));
  const cushionTexts = [...cushionBlock.matchAll(/text:\s*'([^']+)'/g)].map((m) => m[1]);
  ok('陪伴语至少 3 段', cushionTexts.length >= 3, `实际 ${cushionTexts.length} 段`);
  // 只扫真正的文案，不扫源码注释——否则注释里举例的催促词会造成误报
  ok('陪伴语不含催促性措辞',
     cushionTexts.length > 0 && cushionTexts.every((t) => !/加油|马上就好|很快就好|别放弃|坚持一下/.test(t)),
     cushionTexts.join(' / '));

  /* ---- 章节标题不得归罪 ---- */
  const TITLE_BANNED = ['踩的坑', '毛病', '你的问题'];
  const base = score(arrayToAnswers(Array(TOTAL_QUESTIONS).fill(4)));
  const titles = TYPE_KEYS.flatMap((k) => buildReport({ ...base, type: k }).sections.map((s) => s.title));
  const badTitles = titles.filter((t) => TITLE_BANNED.some((w) => t.includes(w)));
  ok('报告章节标题无归罪式措辞', badTitles.length === 0, badTitles.join('；'));

  /* ---- 时长承诺不得低于实际体感 ---- */
  ok('入口页不再承诺单值「约 3 分钟」',
     !indexHtml.includes('约 3 分钟'), '36 题按每题 5 秒以上计，单值 3 分钟会制造催促感');
  ok('入口页给出区间并说明可以慢慢答',
     /约 3–5 分钟/.test(indexHtml) && indexHtml.includes('答慢一点没关系'));
}

/* ============ 10. 渲染评审发现（防止改回原样） ============ */

section('10. 渲染评审发现：这些是看图才发现的，不是读源码能想到的');
{
  const css = await readFile(join(ROOT, 'assets/css/app.css'), 'utf8');
  const quizJs = await readFile(join(ROOT, 'assets/js/pages/quiz.js'), 'utf8');
  const resultHtml = await readFile(join(ROOT, 'result.html'), 'utf8');

  /* ---- 档位标注：只标两端会让中间五档靠猜 ---- */
  ok('答题页至少标出 3 个档位锚点',
     (quizJs.match(/'is-first'|'is-mid'|'is-last'/g) || []).length >= 3,
     '只标 1 与 7 时，中间五档全靠猜；猜出来的答案会变成噪声，噪声会变成用户不认的类型标签');

  /* ---- 禁用态必须收掉硬阴影 ---- */
  const disabledRule = /\.btn\[disabled\][^}]*\}/.exec(css)?.[0] || '';
  ok('禁用按钮收掉硬阴影（这个风格里阴影即可点击语义）',
     disabledRule.includes('--sh-press') && !/box-shadow:\s*var\(--sh\)\s*;/.test(disabledRule),
     disabledRule.replace(/\s+/g, ' ').slice(0, 90));

  /* ---- 折叠正文的选择器要能匹配到真实元素 ---- */
  ok('折叠正文样式的选择器可匹配实际元素',
     /(^|\n)\.acc__body\s*\{/.test(css) && !css.includes('details.acc__body'),
     '写成 details.acc__body 时，<div class="acc__body"> 永远匹配不到，样式静默失效');

  /* ---- 常模说明不得用告警样式 ---- */
  ok('常模说明不使用 warn（红框告警）样式',
     !/id="norms-banner"[\s\S]{0,200}note--warn/.test(resultHtml),
     '常模出处不是用户的作答出了问题；红框会和真正的质量告警混淆');

  /* ---- 文案不得依赖会发生变化的布局位置 ---- */
  ok('结果页文案不依赖左右位置（窄屏会重排成上下）',
     !resultHtml.includes('左边那张'), '窄屏下类型卡片在上方，写「左边」会指错');
}

/* ============= 11. 结果海报规格（MVP 交付物 #5 的确定性部分） ============= */

section('11. 结果海报规格');
{
  const base = score(arrayToAnswers(Array(TOTAL_QUESTIONS).fill(4)));

  // 规格必须真实来自计分结果，不能是硬编码的演示数据
  TYPE_KEYS.forEach((k) => {
    const spec = buildPosterSpec({ ...base, type: k }, { host: 'am.example', origin: 'https://am.example' });
    const expectName = TYPES[k].name;
    ok(`海报规格 ${expectName}：名称与强调色来自计分结果`,
       spec.type.name === expectName && spec.type.accent === POSTER_PALETTE.accents[k],
       `name=${spec.type.name} accent=${spec.type.accent}`);
    ok(`海报规格 ${expectName}：维度分来自计分结果`,
       spec.dims[0].score === `${base.A} / 7` && spec.dims[1].score === `${base.V} / 7`);
  });

  // 伦理红线同样适用于海报
  const allSpec = JSON.stringify(
    TYPE_KEYS.map((k) => buildPosterSpec({ ...base, type: k }, { host: 'am.example' })),
  );
  const specHits = ['缺陷', '不正常', '有病', '冷漠', '踩的坑'].filter((w) => allSpec.includes(w));
  ok('海报文案无贬损或归罪式措辞', specHits.length === 0, specHits.join('、'));
  ok('海报免责声明否认诊断效力', allSpec.includes('不构成心理诊断'));

  // 色彩固定为浅色，不跟随主题
  ok('海报固定浅色调（分享到任意聊天背景都可读）',
     POSTER_PALETTE.paper === '#FFFDF7' && POSTER_PALETTE.ink === '#000000',
     '海报的归宿是聊天窗口与朋友圈，观看者看不到本站主题');

  // 几何：height 必须由 footerY 推导，各区块不得越界或互相重叠
  ok('海报高度由 footerY 推导', POSTER_LAYOUT.height === POSTER_LAYOUT.footerY + 100);
  ok('卡片底部不越过页脚', POSTER_LAYOUT.cardY + POSTER_LAYOUT.cardH < POSTER_LAYOUT.height);
  ok('二维码带（含静默区）不越过卡片底边',
     POSTER_LAYOUT.qrTop + POSTER_LAYOUT.qrSize + 30 < POSTER_LAYOUT.cardH,
     `二维码底 ${POSTER_LAYOUT.qrTop + POSTER_LAYOUT.qrSize}，卡高 ${POSTER_LAYOUT.cardH}`);
  ok('第二根维度条的文字不与二维码重叠',
     POSTER_LAYOUT.dimsTop + POSTER_LAYOUT.dimHeight + 60 < POSTER_LAYOUT.qrTop,
     `维度文字底约 ${POSTER_LAYOUT.dimsTop + POSTER_LAYOUT.dimHeight + 60}，二维码顶 ${POSTER_LAYOUT.qrTop}`);
  ok('页脚落在画布内', POSTER_LAYOUT.footerY > 0 && POSTER_LAYOUT.footerY < POSTER_LAYOUT.height);

  // 二维码：baseUrl 是目录前缀（兼容子路径部署），必须落在入口页上
  const withQr = buildPosterSpec(base, { baseUrl: 'https://am.example' });
  ok('海报二维码指向站点入口（自动补齐末尾斜杠）',
     withQr.qr?.text === 'https://am.example/index.html', `实际 ${withQr.qr?.text}`);
  const subpath = buildPosterSpec(base, { baseUrl: 'https://u.github.io/attachment-map/' });
  ok('海报二维码兼容 GitHub Pages 项目站点的子路径',
     subpath.qr?.text === 'https://u.github.io/attachment-map/index.html', `实际 ${subpath.qr?.text}`);
  ok('海报二维码带矩阵且尺寸合法',
     Array.isArray(withQr.qr?.matrix) && withQr.qr.matrix.length === withQr.qr.size &&
     withQr.qr.matrix.every((row) => row.length === withQr.qr.size));
  ok('超出容量时二维码为 null 而非坏码',
     buildPosterSpec(base, { baseUrl: `https://${'x'.repeat(120)}.com/` }).qr === null);
  ok('未提供 baseUrl 时不生成二维码', buildPosterSpec(base).qr === null);
}

/* ===================== 汇总 ===================== */

console.log('\n' + '─'.repeat(60));
if (fail === 0) {
  console.log(`\x1b[32m\x1b[1m全部通过\x1b[0m  ${pass} 项检查`);
} else {
  console.log(`\x1b[31m\x1b[1m${fail} 项失败\x1b[0m  / 通过 ${pass} 项`);
  failures.forEach((f) => console.log(`  · ${f}`));
  process.exitCode = 1;
}
