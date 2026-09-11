/**
 * 双人合盘（duo.html）
 * ===========================================================================
 * 核心机制：对方没测之前，页面不显示任何合盘结果。
 * 这不是权限校验，是数据层面的必然——对方答案编码在 URL 的 b 参数里，
 * b 不存在，结果就无处可算。
 */

import { mountChrome, $, h, richText, toast, copyText, setLoading, noteNode, qrFigure } from '../ui/ui.js';
import { decodeAnswers, arrayToAnswers, encodeAnswers, buildDuoUrl } from '../core/encode.js';
import { score } from '../core/scoring.js';
import { computeDuo } from '../core/duo.js';
import { getType } from '../core/types.js';
import { NORMS } from '../core/norms.js';
import { store } from '../core/store.js';
import { CONFIG, purchase, track, FUNNEL, getEntitlements } from '../api/index.js';

mountChrome({ page: 'duo' });

const params = new URLSearchParams(location.search);
const codeA = params.get('a');
const codeB = params.get('b');
const arrA = decodeAnswers(codeA);
const arrB = decodeAnswers(codeB);

/* ===================== 情况一：对方还没测 ===================== */

if (arrA && !arrB) {
  renderWaiting(arrA);
} else if (arrA && arrB) {
  renderDuo(arrA, arrB);
} else {
  renderBroken();
}

/* ---------------------- 等待对方完成 ---------------------- */

function renderWaiting(values) {
  track('duo_waiting_view');

  const inviteUrl = buildDuoUrl('duo.html', values, values).split('&b=')[0];
  const host = $('#main');

  host.innerHTML = `
    <section class="section wrap wrap--narrow">
      <span class="sticker">等待对方</span>
      <h1 class="mt-5">你答完了。现在需要对方也测一次。</h1>
      <p class="lead mt-4">
        合盘结果需要两个人的数据同时存在才能算出来。所以在你把链接发给对方、
        并且对方完成测试之前，这个页面不会显示任何结果——不是不给你看，
        是现在还真的没有结果可看。
      </p>

      <div class="card card--lg mt-7">
        <h3>把下面这段发给对方</h3>
        <p class="muted mt-2" style="font-size:14px">建议附一句："我测完了，你也测一下，我们才能看到合盘。"</p>

        <div class="qr-block mt-5">
          <div class="qr-block__text">
            <div class="field">
              <label class="field__label" for="link-out">邀请链接</label>
              <textarea class="textarea" id="link-out" readonly rows="4"></textarea>
              <p class="field__hint">链接里只有作答的编码，不含姓名、手机号或任何身份信息。二维码在本机生成，不经过任何第三方。</p>
            </div>
            <div class="btn-group mt-4">
              <button class="btn" id="btn-copy" type="button">复制链接</button>
              <button class="btn btn--white" id="btn-share" type="button">系统分享</button>
              <a class="btn btn--ghost" href="result.html" id="back-result">先看我的单人结果 →</a>
            </div>
          </div>
          <div id="qr-host"></div>
        </div>
      </div>

      <div class="card card--lg mt-6">
        <h3>等的时候可以做什么</h3>
        <div class="stack stack--sm mt-4" id="waiting-tips"></div>
      </div>
    </section>`;

  $('#link-out').value = inviteUrl;
  $('#qr-host').appendChild(qrFigure(inviteUrl, { caption: '当面的话，让对方直接扫这个码' }));

  $('#btn-copy').addEventListener('click', async () => {
    const ok = await copyText(inviteUrl);
    track(FUNNEL.inviteSent, { via: 'duo_page_copy' });
    toast(ok ? '链接已复制。' : '复制失败，请手动选中复制。', ok ? 'info' : 'error');
  });

  $('#btn-share').addEventListener('click', async () => {
    track(FUNNEL.inviteSent, { via: 'duo_page_share' });
    if (navigator.share) {
      try { await navigator.share({ title: '我做完了一个依恋类型测试', url: inviteUrl }); } catch { /* 取消 */ }
    } else {
      const ok = await copyText(inviteUrl);
      toast(ok ? '已复制链接（当前浏览器不支持系统分享）。' : '请手动复制。');
    }
  });

  const myType = getType(score(arrayToAnswers(values)).type);
  [
    '先看自己的单人结果，报告里有一章专门讲「你和不同类型相处时的互动规律」。',
    '如果你们已经猜到彼此大概是什么类型，可以先读一下那一章，等结果出来再对照。',
    '别催对方。被催着做测试的那一方，答出来的结果往往不是真实状态——这会让合盘失去意义。',
  ].forEach((t) => {
    $('#waiting-tips').appendChild(h('p', { style: 'font-size:14px;color:var(--text-2)', text: t }));
  });
}

/* ---------------------- 双方都已完成 ---------------------- */

async function renderDuo(valuesA, valuesB) {
  const resA = score(arrayToAnswers(valuesA));
  const resB = score(arrayToAnswers(valuesB));
  const duo = computeDuo(resA, resB);

  const tA = getType(resA.type);
  const tB = getType(resB.type);

  // 本地留档，方便解锁后去报告页
  const idA = store.saveResult({ ...resA, answers: arrayToAnswers(valuesA) });
  const idB = store.saveResult({ ...resB, answers: arrayToAnswers(valuesB) });

  const ent = await getEntitlements();

  track(FUNNEL.quizComplete, { role: 'duo_pair', pair: duo.pairKey, trap: duo.trap });

  const host = $('#main');
  host.innerHTML = `
    <section class="section wrap">
      <div class="row row--between">
        <div>
          <p class="tag tag--purple">双人合盘</p>
          <h1 class="mt-3">${duo.trap ? '你们在追逃循环里' : duo.band.label}</h1>
          <p class="lead mt-3">${duo.headline}</p>
        </div>
        <div class="stat" style="min-width:180px">
          <p class="stat__label">${duo.trap ? '模式判定' : '适配度'}</p>
          <p class="stat__value">${duo.trap ? '追逃' : `${duo.rawFitScore}%`}</p>
          <p class="stat__sub">${duo.band.hint}</p>
        </div>
      </div>

      <div class="grid grid--2 mt-7" style="align-items:start">
        <div class="quad">${quadSvg(resA, resB)}</div>
        <div class="stack">
          <div class="card">
            <h3>${tA.name} × ${tB.name}</h3>
            <table class="mt-4" style="font-size:14px">
              <tbody>
                <tr><td style="width:35%">前者</td><td><strong>${tA.name}</strong>（焦虑 ${resA.A} / 回避 ${resA.V}）</td></tr>
                <tr><td>后者</td><td><strong>${tB.name}</strong>（焦虑 ${resB.A} / 回避 ${resB.V}）</td></tr>
                <tr><td>焦虑差</td><td class="mono">${duo.delta.anxiety > 0 ? '+' : ''}${duo.delta.anxiety}</td></tr>
                <tr><td>回避差</td><td class="mono">${duo.delta.avoidance > 0 ? '+' : ''}${duo.delta.avoidance}</td></tr>
                <tr><td>平面距离</td><td class="mono">${duo.distance} / ${Math.hypot(6, 6).toFixed(2)}</td></tr>
              </tbody>
            </table>
          </div>
          <div id="duo-quality"></div>
        </div>
      </div>

      <div class="card card--lg mt-7">
        <h2>${duo.trap ? '为什么你们老卡在同一个地方' : '你们的互动机制'}</h2>
        <div class="mt-4" style="font-size:15px;color:var(--text-2)">${richText(duo.note.dynamics)}</div>
      </div>

      <div class="grid grid--2 mt-6" style="align-items:start">
        <div class="card">
          <p class="tag tag--mint">给前者的建议</p>
          <div class="stack stack--sm mt-4" id="adv-a"></div>
        </div>
        <div class="card">
          <p class="tag tag--blue">给后者的建议</p>
          <div class="stack stack--sm mt-4" id="adv-b"></div>
        </div>
      </div>

      <div class="paywall mt-7" id="duo-paywall"></div>

      <hr class="divider">
      <div class="row row--between no-print">
        <div>
          <h3>把这段抄下来贴起来</h3>
          <p class="muted mt-2" style="font-size:14px">循环下次启动时，这段话比任何分析都有用。</p>
        </div>
        <button class="btn btn--white" id="btn-copy-plan" type="button">复制行动约定</button>
      </div>
      <div class="card card--lg mt-4" id="loop-plan"></div>

      <p class="tiny mt-7">
        本页结果基于成人依恋理论的自评量表，是自我探索工具，不构成心理诊断，
        也不能替代专业心理咨询或治疗。双方类型均来自各自的主观作答，不代表对任何一方的评价。
      </p>
    </section>`;

  // 建议
  duo.note.advice.forEach((a) => {
    $('#adv-a').appendChild(h('p', { style: 'font-size:14px;color:var(--text-2)', text: a }));
  });
  const second = duo.trap
    ? [
        '你不需要立刻变得愿意袒露，只需要把「消失」改成「预告」。给出时间点的退开，和没有预告的退开，在对方体验里是两件事。',
        '当对方追问时，先说一句「我听到了」，再决定要不要回答。跳过这一步直接沉默，会让对方把最坏的解释填进空白。',
        '把「我需要空间」和「我不想要你」分开说清楚。这两句在你心里是同一件事，在对方心里是天壤之别。',
      ]
    : [
        '把你最在意却说不出口的那件事，写成具体的请求。模糊的期待是关系里最常见的慢性损耗。',
        '对方情绪上来时，先复述你听到的内容，再决定要不要给建议。',
        '约定一个固定的复盘时间，不要在情绪最高点解决问题。',
      ];
  second.forEach((a) => {
    $('#adv-b').appendChild(h('p', { style: 'font-size:14px;color:var(--text-2)', text: a }));
  });

  // 作答质量提示
  [['前者', resA], ['后者', resB]].forEach(([label, r]) => {
    (r.quality.flags || []).forEach((f) => {
      $('#duo-quality').appendChild(noteNode('warn', '!', `<strong>${label}：</strong>${f.message}`));
    });
  });

  // 行动约定
  const planText =
    '当我们要开始重复那套动作时——\n' +
    '1. 察觉的人先说出「我们现在在循环里」，不用解释，不用道歉。\n' +
    '2. 需要空间的人给出时间点：「我 X 小时后回来。」\n' +
    '3. 感到不安的人把需求说成具体请求：「今晚 X 点，我们聊 X 分钟。」\n' +
    '4. 到点了就真的回来，真的聊。';
  $('#loop-plan').innerHTML = richText(planText);

  $('#btn-copy-plan').addEventListener('click', async () => {
    const ok = await copyText(planText);
    toast(ok ? '已复制。' : '复制失败，请手动选中。', ok ? 'info' : 'error');
  });

  // 付费墙
  const pw = $('#duo-paywall');
  if (ent.duo) {
    pw.innerHTML = `
      <div class="paywall__head">
        <div>
          <p class="tag tag--lime">已解锁</p>
          <h3 class="mt-3">你们的合盘报告已经打开</h3>
        </div>
      </div>
      <a class="btn btn--lg mt-5" href="report.html?r=${encodeURIComponent(idA)}&partner=${encodeURIComponent(idB)}&mode=duo">
        查看你们的合盘报告 →
      </a>`;
  } else {
    pw.innerHTML = `
      <div class="paywall__head">
        <div>
          <p class="tag tag--purple">双人合盘报告</p>
          <p class="paywall__price mt-3">${CONFIG.freeMode ? '¥0' : '¥29.9'} <small>${CONFIG.freeMode ? '（免费体验期）' : '一次性'}</small></p>
        </div>
      </div>
      <ul class="paywall__list">
        <li>你们在依恋平面上的坐标，以及差异集中在哪里</li>
        <li>追逃循环的逐段拆解：靠近 → 警觉 → 撤退 → 回流</li>
        <li>最值得提前约定的三个具体场景</li>
        <li>分别给两个人的各三条建议</li>
        <li>下一次循环启动时的行动约定（可直接抄用）</li>
      </ul>
      <button class="btn btn--lg btn--block" id="btn-buy-duo" type="button">
        ${CONFIG.freeMode ? '免费解锁合盘报告 →' : '解锁合盘报告｜¥29.9 →'}
      </button>
      <p class="tiny mt-3">
        ${CONFIG.freeMode
          ? '免费体验期：不收费、不登录、不保存你的作答。'
          : '支付后立即生效。'}
      </p>`;

    $('#btn-buy-duo')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      setLoading(btn, true, '正在打开…');
      track(FUNNEL.payClick, { plan: 'duo', pair: duo.pairKey });
      try {
        await purchase('duo', idA);
        track(FUNNEL.paySuccess, { plan: 'duo', amount: CONFIG.freeMode ? 0 : 2990 });
        location.href = `report.html?r=${encodeURIComponent(idA)}&partner=${encodeURIComponent(idB)}&mode=duo`;
      } catch (err) {
        setLoading(btn, false);
        toast(err?.message || '暂时没能打开，请稍后再试。', 'error');
      }
    });
  }

  track('duo_result_view', { pair: duo.pairKey, trap: duo.trap, distance: duo.distance });
}

/* ---------------------- 链接有问题 ---------------------- */

function renderBroken() {
  $('#main').innerHTML = `
    <section class="section wrap wrap--narrow">
      <div class="empty">
        <h1>这个链接不完整</h1>
        <p class="mt-4 muted">可能是在转发过程中被截断了。请让对方在结果页重新复制一次完整链接。</p>
        <p class="mt-5"><a class="btn btn--lg" href="index.html">回到首页</a></p>
      </div>
    </section>`;
}

/* ---------------------- 四象限图 ---------------------- */

function quadSvg(resA, resB) {
  const X0 = 70, X1 = 570, Y0 = 70, Y1 = 310;
  const px = (a) => X0 + ((a - 1) / 6) * (X1 - X0);
  const py = (v) => Y1 - ((v - 1) / 6) * (Y1 - Y0);
  // 两条切分线分别取各自维度的切分点（量表中点），不是同一个数——它们可以不同
  const cx = px(NORMS.cut.anxiety);
  const cy = py(NORMS.cut.avoidance);

  // 判定谁在上方，避免两个标签重叠
  const ax = px(resA.A), ay = py(resA.V);
  const bx = px(resB.A), by = py(resB.V);
  const aAbove = resA.V >= resB.V;
  const aLabelY = aAbove ? ay - 14 : ay + 22;
  const bLabelY = aAbove ? by + 22 : by - 14;

  const isDark = document.documentElement.dataset.theme === 'dark';
  const line = isDark ? '#FFFDF7' : '#000000';
  const grid = isDark ? 'rgba(255,253,247,.35)' : 'rgba(0,0,0,.3)';
  const muted = isDark ? '#9C978A' : '#6E685C';

  return `
<svg viewBox="0 0 640 380" width="100%" role="img"
     aria-label="四象限图：前者位于焦虑 ${resA.A}、回避 ${resA.V}；后者位于焦虑 ${resB.A}、回避 ${resB.V}">
  <text x="${X0}" y="54" font-size="12" fill="${muted}" font-family="system-ui,sans-serif">依恋回避 ↑</text>
  <rect x="${X0}" y="${Y0}" width="${X1 - X0}" height="${Y1 - Y0}" rx="3"
        fill="none" stroke="${line}" stroke-width="1"/>
  <line x1="${cx}" y1="${Y0}" x2="${cx}" y2="${Y1}" stroke="${grid}" stroke-width="1" stroke-dasharray="4 4"/>
  <line x1="${X0}" y1="${cy}" x2="${X1}" y2="${cy}" stroke="${grid}" stroke-width="1" stroke-dasharray="4 4"/>

  <text x="${X0 + 12}" y="${Y0 + 20}" font-size="12" fill="${muted}" font-family="system-ui,sans-serif">回避型</text>
  <text x="${X1 - 12}" y="${Y0 + 20}" font-size="12" fill="${muted}" text-anchor="end" font-family="system-ui,sans-serif">恐惧型</text>
  <text x="${X0 + 12}" y="${Y1 - 10}" font-size="12" fill="${muted}" font-family="system-ui,sans-serif">安全型</text>
  <text x="${X1 - 12}" y="${Y1 - 10}" font-size="12" fill="${muted}" text-anchor="end" font-family="system-ui,sans-serif">焦虑型</text>

  <line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${grid}" stroke-width="1.5" stroke-dasharray="5 4"/>

  <circle cx="${bx}" cy="${by}" r="8" fill="#B69CFF" stroke="${line}" stroke-width="2"/>
  <text x="${bx}" y="${bLabelY}" font-size="13" font-weight="700" fill="${line}"
        text-anchor="middle" font-family="system-ui,sans-serif">后者</text>

  <circle cx="${ax}" cy="${ay}" r="8" fill="#FF9EC4" stroke="${line}" stroke-width="2"/>
  <text x="${ax}" y="${aLabelY}" font-size="13" font-weight="700" fill="${line}"
        text-anchor="middle" font-family="system-ui,sans-serif">前者</text>

  <text x="${X0}" y="${Y1 + 34}" font-size="12" fill="${muted}" font-family="system-ui,sans-serif">依恋焦虑 →</text>
  <text x="${X1}" y="${Y1 + 34}" font-size="12" fill="${muted}" text-anchor="end" font-family="system-ui,sans-serif">切分点 焦虑 ${NORMS.cut.anxiety} ／ 回避 ${NORMS.cut.avoidance}（量表中点）</text>
</svg>`;
}
