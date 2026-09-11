/**
 * 答题页（quiz.html）
 * ===========================================================================
 * 交互决策及其依据（改这里之前先读）
 * 1. 一次一题：降低单屏认知负荷。
 * 2. 进度显示「还剩 N 题」而不是「完成 X%」：用户想知道的是剩余成本。
 * 3. 点选项即进下一题，不设「下一题」按钮：少一次点击 = 少一次流失。
 * 4. 反馈分两层：选中态即时出现（0ms，CSS），题目推进等 90ms 后发生（见 ADVANCE_DELAY）。
 *    实测：新题 90ms 开始入场、160ms 达到可读亮度，动作起点比原来的 180ms 提前一倍。
 * 5. 入场动画只作用于题干文字，**不动选项按钮**——按钮必须停在原处，
 *    否则连续快速作答时手指会落在移动中的目标上。
 * 6. 允许回退、允许中途离开：localStorage 自动存，不做「你还没答完」拦截。
 * 7. 键盘可全程操作：1–7 选项，←/Backspace 上一题。
 * 8. 中途给一句陪伴语：#cushion。36 题里 28 题在让用户确认自己的不安，
 *    连续确认是一种情绪负荷。不打断作答、不增加点击，只随进度换文字。
 */

import { mountChrome, $, $$, h, toast, setLoading } from '../ui/ui.js';
import { QUESTIONS, TOTAL_QUESTIONS, LIKERT_ANCHORS } from '../data/questions.js';
import { store, newId } from '../core/store.js';
import { encodeAnswers, answersToArray } from '../core/encode.js';
import { submitQuiz, track, FUNNEL } from '../api/index.js';

/* ------------------------------ 时序常量 ------------------------------ */

/**
 * 选中态停留多久再推进到下一题。
 * 为什么是 80ms：足够看见自己点了哪一档（约 5 帧），
 * 又让「画面开始变化」落在 100ms 这条瞬时线以内。
 * 它同时充当「防止一次误触答掉两题」的保护期——人手连点间隔通常 >150ms。
 */
const ADVANCE_DELAY = 80;

/**
 * 新题入场时长。
 * 存在的理由不是好看，是**让眼睛知道内容换了**：36 题连续作答时，
 * 题干位置固定、选项按钮位置也固定，若只是硬切，快速作答的人容易
 * 把上一题的判断落到下一题上。120ms 的轻微淡入给出这个信号。
 * 时长刻意压得短——入场只是提示，不能拖慢「下一题什么时候能读」。
 */
const ENTER_DURATION = 120;

/** 尊重系统的「减少动态效果」偏好：此时不做任何入场动画，直接换文字。 */
const prefersReducedMotion = typeof matchMedia === 'function'
  && matchMedia('(prefers-reduced-motion: reduce)').matches;

mountChrome({ page: 'quiz' });

/* ------------------------------ 状态 ------------------------------ */

const params = new URLSearchParams(location.search);
// 邀请编码放在 URL 片段里（#a=…），片段不会随请求发往服务器。
// 同时兼容旧链接的查询串形式（?a=…）。
const hashParams = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
const incomingInvite = hashParams.get('a') || params.get('a');   // 对方是发起方，我是被邀请方
const isResume = params.get('resume') === '1';

const state = {
  index: 0,
  answers: isResume ? store.loadAnswers() : {},
  inviteCode: incomingInvite || null,
  locked: false,
};

if (!isResume) store.clearProgress();

/* ------------------------------ DOM ------------------------------ */

const el = {
  remaining: $('#remaining'),
  bar: $('#bar'),
  counter: $('#counter'),
  text: $('#q-text'),
  scale: $('#scale'),
  anchors: $('#anchors'),
  back: $('#btn-back'),
  quit: $('#btn-quit'),
  roleBanner: $('#role-banner'),
  roleText: $('#role-text'),
  cushion: $('#cushion'),
};

/**
 * 中途陪伴语。按已答题数切换，不设交互、不打断作答。
 * 措辞原则：承认这些题不好答，明确没有对错，并预告答完能得到什么。
 * 不许写「加油」「马上就好」这类催促——那会把陪伴变成压力。
 */
const CUSHION_LINES = [
  { from: 0,  text: '这些题问的是关系里最难说出口的那部分。没有对错，也没有更好或更差的答案。' },
  { from: 11, text: '三分之一了。如果刚才那些描述有点扎人，那是正常的——说明题问到了真的事情上。' },
  { from: 23, text: '还剩三分之一。答完你会拿到两个维度分，以及一件现在就能做的事。' },
];

if (state.inviteCode) {
  el.roleBanner.classList.remove('hide');
  el.roleText.textContent = '对方已经答完了。你答完之后，两个人的结果会一起显示。';
}

/* ------------------------------ 渲染 ------------------------------ */

function render(opts = {}) {
  const q = QUESTIONS[state.index];
  const answered = Object.keys(state.answers).filter((k) => state.answers[k] != null).length;

  el.remaining.textContent = `还剩 ${TOTAL_QUESTIONS - state.index} 题`;
  el.counter.textContent = `第 ${state.index + 1} / ${TOTAL_QUESTIONS} 题`;
  el.bar.style.width = `${(state.index / TOTAL_QUESTIONS) * 100}%`;
  el.bar.parentElement.setAttribute('aria-valuenow', String(state.index));
  el.bar.parentElement.setAttribute('aria-valuemax', String(TOTAL_QUESTIONS));

  el.text.textContent = q.text;
  el.text.setAttribute('aria-label', `第 ${state.index + 1} 题：${q.text}`);

  // 入场动画：默认只在「推进到下一题」时播放（opts.enter），
  // 首次进入和回退都不播——首次播放会让人以为页面在闪，回退播放会拖慢纠错。
  // 只动题干文字，不碰选项按钮：按钮必须留在原地，否则快速作答时手指会落空。
  if (opts.enter && !prefersReducedMotion && el.text.animate) {
    el.text.animate(
      [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
      // fill: 'both' —— 动画在「就绪前」的那一帧也套用起始值，
      // 否则理论上有极小概率以完全不透明的状态渲染一帧，看起来像闪一下。
      { duration: ENTER_DURATION, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'both' },
    );
  }

  // 7 个选项
  el.scale.innerHTML = '';
  const current = state.answers[q.id];
  LIKERT_ANCHORS.forEach((a) => {
    const selected = current === a.value;
    const btn = h('button', {
      class: 'likert__btn',
      type: 'button',
      role: 'radio',
      'aria-checked': String(selected),
      'aria-pressed': String(selected),
      'aria-label': `${a.value} 分，${a.long}`,
      title: a.long,
      text: String(a.value),
      dataset: { value: String(a.value) },
      onClick: () => choose(a.value),
    });
    el.scale.appendChild(btn);
  });

  // 档位标注：标出 1 / 4 / 7 三点，用同一套 7 列网格对齐按钮。
  // 为什么必须标：7 档里如果只有两端有字，中间五档全靠猜；而在一道关于被抛弃恐惧的
  // 题上，「有点符合」和「比较符合」是有实质差别的。猜出来的答案会变成噪声，
  // 噪声会变成用户不认的类型标签——那就不再是被理解，而是被误标。
  // 数据侧 LIKERT_ANCHORS 七档都写好了 short，此前一档都没渲染。
  el.anchors.innerHTML = '';
  [
    { index: 0, cls: 'is-first' },
    { index: 3, cls: 'is-mid' },
    { index: 6, cls: 'is-last' },
  ].forEach(({ index, cls }) => {
    el.anchors.appendChild(h('span', {
      class: cls,
      text: LIKERT_ANCHORS[index].short,
      title: LIKERT_ANCHORS[index].long,
    }));
  });

  el.back.disabled = state.index === 0;
  el.quit.classList.toggle('hide', state.index === 0);

  // 陪伴语：只在跨过分段时改文字，避免每次渲染都变动
  if (el.cushion) {
    const line = [...CUSHION_LINES].reverse().find((l) => state.index >= l.from);
    if (el.cushion.textContent !== line.text) el.cushion.textContent = line.text;
  }

  // 进度持久化
  store.saveProgress({
    index: state.index,
    answeredCount: state.index,
    updatedAt: new Date().toISOString(),
  });

  // 焦点交给题干，读屏能立刻读到新题
  el.text.setAttribute('tabindex', '-1');
  el.text.focus({ preventScroll: true });
}

/* ------------------------------ 作答 ------------------------------ */

function choose(value) {
  if (state.locked) return;
  const q = QUESTIONS[state.index];
  state.answers[q.id] = value;
  store.saveAnswers(state.answers);

  // 先给反馈（选中态），再推进
  const btns = $$('.likert__btn', el.scale);
  btns.forEach((b) => {
    const on = Number(b.dataset.value) === value;
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-checked', String(on));
  });

  state.locked = true;
  setTimeout(() => {
    state.locked = false;
    if (state.index < TOTAL_QUESTIONS - 1) {
      state.index += 1;
      render({ enter: true });
    } else {
      finish();
    }
  }, ADVANCE_DELAY);
}

function goBack() {
  if (state.index === 0 || state.locked) return;
  state.index -= 1;
  render();
}

/* ------------------------------ 完成 ------------------------------ */

async function finish() {
  const arr = answersToArray(state.answers);
  if (arr.some((v) => v == null)) {
    toast('还有题目没有作答，请检查一遍。', 'error');
    const firstMissing = arr.findIndex((v) => v == null);
    state.index = firstMissing;
    render();
    return;
  }

  el.bar.style.width = '100%';
  const btn = $('#btn-back');
  setLoading(btn, true, '计算中…');
  btn.disabled = true;

  try {
    const res = await submitQuiz(state.answers);
    track(FUNNEL.quizComplete, {
      resultId: res.resultId,
      type: res.type,
      A: res.A, V: res.V,
      role: state.inviteCode ? 'invitee' : 'initiator',
    });

    store.clearProgress();

    if (state.inviteCode) {
      // 我是被邀请方：把双方答案拼进链接，一起看合盘
      const myCode = encodeAnswers(arr);
      // 双方答案都放进 URL 片段：片段不会随请求发往服务器（见 core/encode.js 的说明）。
      // 若写进查询串，答案会进入托管方访问日志，并被 Referer 带给第三方。
      location.replace(`duo.html#a=${encodeURIComponent(state.inviteCode)}&b=${encodeURIComponent(myCode)}`);
    } else {
      location.replace(`result.html?r=${encodeURIComponent(res.resultId)}`);
    }
  } catch (err) {
    console.error(err);
    toast(err?.message || '计算失败，请重试。', 'error');
    setLoading(btn, false);
    btn.disabled = false;
  }
}

/* ------------------------------ 键盘 ------------------------------ */

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (/^[1-7]$/.test(e.key)) {
    e.preventDefault();
    choose(Number(e.key));
    return;
  }
  if (e.key === 'ArrowLeft' || e.key === 'Backspace') {
    e.preventDefault();
    goBack();
    return;
  }
  // 上下键在左侧锚点间移动焦点
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    const btns = $$('.likert__btn', el.scale);
    const idx = btns.indexOf(document.activeElement);
    (btns[Math.min(btns.length - 1, idx + 1)] || btns[0]).focus();
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    const btns = $$('.likert__btn', el.scale);
    const idx = btns.indexOf(document.activeElement);
    (btns[Math.max(0, idx - 1)] || btns[0]).focus();
  }
});

/* ------------------------------ 绑定与启动 ------------------------------ */

el.back.addEventListener('click', goBack);
el.quit.addEventListener('click', () => {
  store.saveProgress({ index: state.index, answeredCount: state.index });
  toast('进度已保存，下次打开可以接着答。');
  setTimeout(() => { location.href = 'index.html'; }, 700);
});

window.addEventListener('beforeunload', () => {
  store.saveProgress({ index: state.index, answeredCount: state.index });
});

track(FUNNEL.quizStart, { role: state.inviteCode ? 'invitee' : 'initiator', resumed: isResume });
render();
