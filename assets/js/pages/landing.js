/**
 * 入口页（index.html）
 * 目标：让用户在 5 秒内回答「这是什么 / 要多久 / 要不要钱 / 要不要登录」，
 * 并且一键开始。首屏绝不出现付费信息。
 */

import { mountChrome, $, h, param, toast, copyText } from '../ui/ui.js';
import { track, FUNNEL, CONFIG } from '../api/index.js';
import { decodeAnswers, arrayToAnswers } from '../core/encode.js';
import { store } from '../core/store.js';
import { NORMS, normsDisclosure } from '../core/norms.js';

mountChrome({ page: 'landing', home: true });
track(FUNNEL.landingView);

/* -------------------- 恢复上次未完成的作答 -------------------- */
const progress = store.loadProgress();
const resumeBox = $('#resume-box');

if (progress && progress.answeredCount > 0 && progress.answeredCount < 36) {
  resumeBox.classList.remove('hide');
  $('#resume-text').textContent =
    `上次你答到第 ${progress.answeredCount + 1} 题，进度已经存在这台设备上。`;
  $('#btn-resume').addEventListener('click', () => {
    track('landing_resume_click', { at: progress.answeredCount });
    location.href = 'quiz.html?resume=1';
  });
  $('#btn-restart').addEventListener('click', () => {
    store.clearProgress();
    store.saveAnswers({});
    location.href = 'quiz.html';
  });
}

/* -------------------- 主入口：开始测试 -------------------- */
$('#btn-start').addEventListener('click', () => {
  track(FUNNEL.quizStart, { from: 'landing_primary' });
  location.href = 'quiz.html';
});

/* -------------------- 次级入口：我收到了邀请 -------------------- */
const inviteInput = $('#invite-input');
const inviteBtn = $('#btn-invite');

inviteBtn.addEventListener('click', () => handleInvite(inviteInput.value));
inviteInput.addEventListener('paste', (e) => {
  const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
  if (text.includes('a=')) {
    setTimeout(() => handleInvite(inviteInput.value || text), 0);
  }
});

function handleInvite(raw) {
  const value = String(raw || '').trim();
  if (!value) {
    toast('请先粘贴对方发给你的邀请链接。', 'error');
    inviteInput.setAttribute('aria-invalid', 'true');
    inviteInput.focus();
    return;
  }
  inviteInput.removeAttribute('aria-invalid');

  // 容忍用户只粘了?后面的部分，或整段文案里夹着链接
  const match = value.match(/[?&]a=([A-Za-z0-9\-_]+)/);
  const code = match ? match[1] : null;
  const decoded = decodeAnswers(code);

  if (!decoded) {
    toast('这个链接看起来不完整，请让对方在结果页重新复制一次。', 'error');
    inviteInput.setAttribute('aria-invalid', 'true');
    return;
  }

  track(FUNNEL.inviteAccepted, { source: 'landing_input' });
  location.href = `quiz.html?a=${encodeURIComponent(code)}`;
}

/* -------------------- 免费模式的如实告知 -------------------- */
if (CONFIG.freeMode) {
  $('#free-badge').classList.remove('hide');
}

/* -------------------- 常模标注：必须说清分数是跟谁比出来的 -------------------- */
{
  const d = normsDisclosure();
  $('#norms-note').innerHTML =
    `<strong>${d.label}（${NORMS.version}）</strong>：${d.short} ` +
    '<a href="about.html">了解算法与常模 →</a>';
}

/* -------------------- 如果 URL 直接带了 b=（合盘完成） -------------------- */
if (param('a') && param('b')) {
  location.replace(`duo.html${location.search}`);
}
