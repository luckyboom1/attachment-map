/**
 * 题库 —— 36 题，焦虑 18 / 回避 18，其中反向题 8 道。
 *
 * 设计约束（改题前必读）
 * ---------------------------------------------------------------------------
 * 1. 题干全部自编。仅沿用「依恋焦虑 / 依恋回避」两个学术构念——
 *    构念不受版权保护，具体题目文本受保护，禁止逐字抄录 ECR-R 原题。
 * 2. 场景必须本土化：通勤、合租、异地、家长群、加班、相亲——
 *    不要出现"海滩散步""感恩节晚餐"这类翻译腔场景。
 * 3. 一律 7 点李克特。禁止改成"是/否"，二值题会压缩方差、直接降信度。
 * 4. reverse: true 表示该题在语义上是所在维度的反向陈述，
 *    计分时按 x' = 8 - x 处理（见 core/scoring.js）。
 * 5. 呈现顺序按 code 的排布刻意打散，避免同一维度连续出现 3 题以上，
 *    防止作答者形成"规律感"而按模式作答。
 */

/** 选项锚点：1 → 7 */
export const LIKERT_ANCHORS = [
  { value: 1, short: '完全不符合', long: '完全不符合我' },
  { value: 2, short: '比较不符合', long: '比较不符合我' },
  { value: 3, short: '有点不符合', long: '有点不符合我' },
  { value: 4, short: '说不上', long: '说不上符合或不符合' },
  { value: 5, short: '有点符合', long: '有点符合我' },
  { value: 6, short: '比较符合', long: '比较符合我' },
  { value: 7, short: '完全符合', long: '完全符合我' },
];

/**
 * @typedef {Object} Question
 * @property {number}  id        呈现顺序编号 1..36
 * @property {string}  code      题目编码 a1..a18 / v1..v18，用于溯源与调题
 * @property {'anxiety'|'avoidance'} dimension
 * @property {boolean} reverse   是否反向计分
 * @property {string}  text      题干
 */

/** @type {Question[]} */
export const QUESTIONS = [
  { id: 1,  code: 'a1',  dimension: 'anxiety',   reverse: false, text: '对方回复消息慢了，我会忍不住反复点开手机看。' },
  { id: 2,  code: 'v1',  dimension: 'avoidance', reverse: false, text: '我不太习惯向别人袒露自己真实的感受。' },
  { id: 3,  code: 'a5',  dimension: 'anxiety',   reverse: false, text: '对方一忙起来，我就会觉得自己被丢在一边了。' },
  { id: 4,  code: 'v5',  dimension: 'avoidance', reverse: false, text: '我更喜欢保留自己的独立空间，不希望被卷得太深。' },
  { id: 5,  code: 'a12', dimension: 'anxiety',   reverse: false, text: '对方对我好的时候，我偶尔会担心这种好不会持续太久。' },
  { id: 6,  code: 'v12', dimension: 'avoidance', reverse: true,  text: '我可以很自然地把自己的软弱展现给对方。' },
  { id: 7,  code: 'a3',  dimension: 'anxiety',   reverse: true,  text: '我很少担心对方会离开我。' },
  { id: 8,  code: 'v3',  dimension: 'avoidance', reverse: true,  text: '向对方示弱这件事，对我来说很自然。' },
  { id: 9,  code: 'a16', dimension: 'anxiety',   reverse: false, text: '我会怀疑是不是自己不够好，才让对方不够热情。' },
  { id: 10, code: 'v16', dimension: 'avoidance', reverse: false, text: '我很少主动去碰关系里那些沉重的话题。' },
  { id: 11, code: 'a8',  dimension: 'anxiety',   reverse: false, text: '心里翻腾的时候，我倾向于全都告诉对方。' },
  { id: 12, code: 'v8',  dimension: 'avoidance', reverse: true,  text: '我很容易跟对方聊起自己的私事。' },
  { id: 13, code: 'a2',  dimension: 'anxiety',   reverse: false, text: '我常常担心对方其实没有我那么在乎这段关系。' },
  { id: 14, code: 'v2',  dimension: 'avoidance', reverse: false, text: '遇到麻烦的时候，我倾向于自己扛着，不告诉对方。' },
  { id: 15, code: 'a14', dimension: 'anxiety',   reverse: false, text: '看到对方跟别人聊得很开心，我心里会有点不舒服。' },
  { id: 16, code: 'v14', dimension: 'avoidance', reverse: false, text: '分开一段时间，我通常不会特别难受。' },
  { id: 17, code: 'a6',  dimension: 'anxiety',   reverse: false, text: '对方一个语气变化，我能琢磨很久，想是不是自己做错了什么。' },
  { id: 18, code: 'v6',  dimension: 'avoidance', reverse: false, text: '我很少和对方聊起我心里真正的想法。' },
  { id: 19, code: 'a18', dimension: 'anxiety',   reverse: false, text: '关系刚有点冷下来，我就会主动去修补，哪怕问题不在我。' },
  { id: 20, code: 'v18', dimension: 'avoidance', reverse: false, text: '情绪不好的时候，我宁愿一个人待着，也不想被安慰。' },
  { id: 21, code: 'a10', dimension: 'anxiety',   reverse: true,  text: '我不太担心自己在这段关系里付出得比对方多。' },
  { id: 22, code: 'v10', dimension: 'avoidance', reverse: false, text: '我习惯自己解决问题，不太需要别人插手。' },
  { id: 23, code: 'a4',  dimension: 'anxiety',   reverse: false, text: '我需要经常从对方那里听到"我在乎你"这样的确认。' },
  { id: 24, code: 'v4',  dimension: 'avoidance', reverse: false, text: '别人太靠近我的时候，我会本能地想往后退一点。' },
  { id: 25, code: 'a13', dimension: 'anxiety',   reverse: true,  text: '我很少需要对方反复向我保证他／她是在意我的。' },
  { id: 26, code: 'v13', dimension: 'avoidance', reverse: false, text: '我不太愿意把重要的事情托付给别人。' },
  { id: 27, code: 'a7',  dimension: 'anxiety',   reverse: true,  text: '我很放心对方对我的感情，不需要反复确认。' },
  { id: 28, code: 'v7',  dimension: 'avoidance', reverse: false, text: '依赖对方这件事，让我有点不自在。' },
  { id: 29, code: 'a17', dimension: 'anxiety',   reverse: false, text: '关系里稍微有点疏远，我马上就能察觉到，并且会紧张。' },
  { id: 30, code: 'v17', dimension: 'avoidance', reverse: true,  text: '我很享受和对方毫无保留地分享一切。' },
  { id: 31, code: 'a9',  dimension: 'anxiety',   reverse: false, text: '对方有一段时间没主动找我，我就会开始不安。' },
  { id: 32, code: 'v9',  dimension: 'avoidance', reverse: false, text: '对方想要更亲密的时候，我有时候会觉得有压力。' },
  { id: 33, code: 'a11', dimension: 'anxiety',   reverse: false, text: '我会主动要求对方多花点时间陪我。' },
  { id: 34, code: 'v11', dimension: 'avoidance', reverse: false, text: '关系一旦变得很黏，我就想抽身喘口气。' },
  { id: 35, code: 'a15', dimension: 'anxiety',   reverse: false, text: '我常常希望我们之间的联系能再紧密一些。' },
  { id: 36, code: 'v15', dimension: 'avoidance', reverse: false, text: '我倾向于用"最近太忙"来避开一些需要深聊的时刻。' },
];

export const TOTAL_QUESTIONS = QUESTIONS.length;

/** 自检：题量、维度配比、反向题数量。开发期会在控制台输出结果。 */
export function auditQuestions() {
  const anx = QUESTIONS.filter((q) => q.dimension === 'anxiety');
  const avo = QUESTIONS.filter((q) => q.dimension === 'avoidance');
  const rev = QUESTIONS.filter((q) => q.reverse);
  const dupIds = QUESTIONS.length - new Set(QUESTIONS.map((q) => q.id)).size;
  const dupCodes = QUESTIONS.length - new Set(QUESTIONS.map((q) => q.code)).size;

  const problems = [];
  if (QUESTIONS.length !== 36) problems.push(`题量应为 36，实际 ${QUESTIONS.length}`);
  if (anx.length !== 18) problems.push(`焦虑题应为 18，实际 ${anx.length}`);
  if (avo.length !== 18) problems.push(`回避题应为 18，实际 ${avo.length}`);
  if (rev.length < 6) problems.push(`反向题偏少（${rev.length}），易产生惯性作答`);
  if (dupIds) problems.push(`存在重复 id：${dupIds}`);
  if (dupCodes) problems.push(`存在重复 code：${dupCodes}`);

  // 同一维度连续出现不得超过 3 题
  let run = 1;
  for (let i = 1; i < QUESTIONS.length; i++) {
    run = QUESTIONS[i].dimension === QUESTIONS[i - 1].dimension ? run + 1 : 1;
    if (run > 3) { problems.push(`第 ${i - 2}–${i} 题同一维度连续出现，需打散`); break; }
  }

  return { total: QUESTIONS.length, anxiety: anx.length, avoidance: avo.length, reverse: rev.length, problems };
}
