/**
 * 结果页（result.html）—— 转化生死线
 * ===========================================================================
 * 3 秒法则：进入即看到 ①类型名（4 个大字）②一句扎心描述 ③可截图卡片。
 * 信息顺序严格：类型 → 维度分 → 3 条行为模式 → [付费墙] → 合盘。
 * 付费按钮必须说清买到什么，不允许写「立即解锁」「马上开通」。
 * 截图引导显眼但不遮挡结果——用户截图是为了发出去，遮挡等于掐断裂变。
 */

import { mountChrome, $, h, richText, toast, copyText, setLoading, noteNode, qrFigure } from '../ui/ui.js';
import { store } from '../core/store.js';
import { getType, TYPE_TABLE } from '../core/types.js';
import { NORMS, normsDisclosure } from '../core/norms.js';
import { bandText } from '../core/scoring.js';
import { buildInviteUrl, answersToArray } from '../core/encode.js';
import { buildPosterSpec } from '../core/poster.js';
import { mountPoster } from '../ui/posterCanvas.js';
import { CONFIG, purchase, redeemCode, track, FUNNEL, getEntitlements } from '../api/index.js';

mountChrome({ page: 'result' });

const params = new URLSearchParams(location.search);
const resultId = params.get('r') || store.lastResultId();
const result = resultId ? store.getResult(resultId) : null;

if (result) {
  await main(result);
} else {
  renderMissing();
}

/* ========================================================================== */

async function main(result) {
  const type = getType(result.type);
  const ent = await getEntitlements();
  const currentId = result.resultId;

  document.title = `我是${type.name} · 依恋地图`;

  /* ---------------------------- 类型卡（可截图） ---------------------------- */

  const card = $('#typecard');
  card.classList.add(`typecard--${result.type}`);
  card.innerHTML = `
    <p class="typecard__eyebrow">我的依恋类型</p>
    <h1 class="typecard__name">${type.name}</h1>
    <p class="typecard__tagline">${type.tagline}</p>
    <div class="typecard__foot">
      <span>焦虑 ${result.A} ｜ 回避 ${result.V}</span>
      <span>${location.host || '依恋地图'} · attachment</span>
    </div>`;

  /* ---------------------------- 维度条 ---------------------------- */

  renderDims();

  /* ---------------------------- 作答质量提示 ---------------------------- */

  const qualityHost = $('#quality');
  (result.quality?.flags || []).forEach((f) => {
    qualityHost.appendChild(noteNode('warn', '!', f.message));
  });

  /* ---------------------------- 3 条行为模式（免费） ---------------------------- */

  const behaviorHost = $('#behaviors');
  type.behaviors.forEach((b, i) => {
    behaviorHost.appendChild(h('div', { class: 'card card--flat' }, [
      h('div', { class: 'row', style: 'align-items:flex-start' }, [
        h('span', { class: 'tag tag--yellow', text: `0${i + 1}` }),
        h('p', { style: 'flex:1;min-width:0;font-size:15px', text: b }),
      ]),
    ]));
  });

  /* ---------------------------- 常模标注 ----------------------------
     无论哪种来源都必须展示：用户有权知道自己的分数是跟谁比出来的。
     但呈现方式要克制——页面第一屏已经承载了类型标签和维度分，
     这里只需要回答「4.0 是切分点、百分位参照谁」，完整口径折叠进详情。
     实测在 390px 上，若把完整说明平铺，这块会占掉首屏下方 700px 以上，
     并且以红框告警样式出现，把「常模出处」和「作答有问题」混成同一种视觉语言。 */

  {
    const d = normsDisclosure();
    $('#norms-banner').classList.remove('hide');
    $('#norms-banner-text').innerHTML =
      `${d.short}
       <details class="acc mt-3">
         <summary>常模口径与局限</summary>
         <div class="acc__body">
           ${richText(d.text)}
           ${d.citation ? `<p class="tiny">出处：${d.citation}</p>` : ''}
         </div>
       </details>`;
  }

  /* ---------------------------- 分享长图（MVP 交付物） ----------------------------
     规格由 core/poster.js 生成（可单测），这里只负责触发绘制与交付。
     生成后保留可长按的 <img>，因为微信内置浏览器对 dataURL 下载不可靠。 */
  $('#btn-poster').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true, '生成中…');
    track('poster_generate', { type: result.type });
    try {
      // 二维码的基准必须是「当前目录」，不能用 location.origin——
      // GitHub Pages 的项目站点部署在子路径（…/attachment-map/）下时，
      // 用 origin 生成的码会指向不存在的地址。
      const baseUrl = new URL('./', location.href).href;
      const spec = buildPosterSpec(result, { host: location.host, baseUrl });
      await mountPoster($('#poster-host'), spec);
      $('#poster-host').classList.remove('hide');
      setLoading(btn, false);
      btn.disabled = true;
      btn.textContent = '已生成，长按图片即可保存';
      $('#poster-host').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (err) {
      console.error(err);
      setLoading(btn, false);
      toast(err?.message || '海报没能生成，请再试一次。', 'error');
    }
  });

  /* ---------------------------- 可改变的出口（免费） ---------------------------- */
  // 必须在付费墙之前渲染。理由见 core/types.js 的内容红线第 2 条：
  // 只给类型名和行为模式、不给任何出路，用户读到的是判决而不是关心。
  renderExit(type);

  /* ---------------------------- 付费墙 ---------------------------- */

  renderPaywall(ent, currentId);

  /* ---------------------------- 双人合盘 ---------------------------- */

  renderDuoBox(result);

  /* ---------------------------- 分享 ---------------------------- */

  $('#btn-save-card').addEventListener('click', async () => {
    track(FUNNEL.resultShare, { via: 'copy_text' });
    const text =
      `我的依恋类型：${type.name}\n` +
      `「${type.tagline}」\n` +
      `焦虑 ${result.A} / 7 ｜ 回避 ${result.V} / 7\n` +
      `—— 依恋地图`;
    const ok = await copyText(text);
    toast(ok ? '结果文字已复制，可直接粘贴发布。' : '复制失败，请手动截图。', ok ? 'info' : 'error');
  });

  /* ---------------------------- 四类型速查 ---------------------------- */

  const tableHost = $('#type-table');
  TYPE_TABLE.forEach((t) => {
    const ty = getType(t.key);
    const mine = t.key === result.type;
    tableHost.appendChild(h('tr', { class: mine ? 'is-primary' : '' }, [
      h('td', {}, [
        h('strong', { text: ty.name }),
        mine ? h('span', { class: 'tag tag--red ml-2', text: '你' }) : null,
      ]),
      h('td', { class: 'mono t-xs', text: t.rule }),
      h('td', { text: t.core }),
    ]));
  });

  track('result_view', { resultId: currentId, type: result.type, A: result.A, V: result.V });
}

/* ========================================================================== */

function renderDims() {
  const host = $('#dims');
  host.innerHTML = '';

  const rows = [
    { name: '依恋焦虑', value: result.A, pct: result.pctA, cls: 'dimbar__fill--anx', band: result.bandA, dim: 'anxiety' },
    { name: '依恋回避', value: result.V, pct: result.pctV, cls: 'dimbar__fill--avo', band: result.bandV, dim: 'avoidance' },
  ];

  const span = NORMS.scaleMax - NORMS.scaleMin;
  const toPct = (v) => ((v - NORMS.scaleMin) / span) * 100;

  rows.forEach((r) => {
    // 两个不同的参照，画两条线，各自标清楚。混作一条会误导。
    const cut = NORMS.cut[r.dim];
    const ref = NORMS[r.dim].mean;

    host.appendChild(h('div', { class: 'dimbar' }, [
      h('div', { class: 'dimbar__head' }, [
        h('span', { class: 'dimbar__name', text: r.name }),
        h('span', { class: 'dimbar__val', text: `${r.value} / 7 ｜ 百分位 ${r.pct}` }),
      ]),
      h('div', {
        class: 'dimbar__track',
        role: 'img',
        'aria-label':
          `${r.name} ${r.value} 分（满分 7）；切分点 ${cut}；参照样本均值 ${ref}；百分位 ${r.pct}`,
      }, [
        h('div', { class: `dimbar__fill ${r.cls}`, style: `width:${toPct(r.value)}%` }),
        h('div', { class: 'dimbar__ref', style: `left:${toPct(ref)}%` }),
        h('div', { class: 'dimbar__cut', style: `left:${toPct(cut)}%` }),
      ]),
      h('div', { class: 'dimbar__scale' }, [
        h('span', { text: '1 低' }),
        h('span', { text: `切分点 ${cut}` }),
        h('span', { text: '7 高' }),
      ]),
      h('div', { class: 'dimbar__legend' }, [
        h('span', {}, [h('i', { class: 'cut' }), `切分点 ${cut}（量表中点，决定类型）`]),
        h('span', {}, [h('i', { class: 'ref' }), `参照均值 ${ref}（只决定百分位）`]),
      ]),
      h('p', { class: 'mt-3', style: 'font-size:14px;color:var(--text-2)', text: bandText(r.band, r.dim) }),
    ]));
  });
}

/* ========================================================================== */

/**
 * 免费区展示「可改变的出口」。
 *
 * 为什么这一块不能省、也不能挪到付费墙后面：
 * 用户刚刚花 3 分钟逐条确认了「我会这样」「我很少那样」。此时页面给出的东西
 * 决定他关掉页面的心情。只给类型名 + 三条问题，读起来是判决；
 * 给出「下一步可以做什么」，才构成关心。这也是 core/types.js 写死的内容红线。
 *
 * @param {ReturnType<typeof getType>} type
 */
function renderExit(type) {
  const host = $('#exit-card');
  if (!host) return;

  host.innerHTML = `
    <p class="tag tag--mint">现在就可以做的一件事</p>
    <p class="mt-4 t-body" style="line-height:1.75">${type.profile.exit}</p>
    <p class="tiny mt-4">
      这一段不用付费就能看到。深度报告里还有压力状态下的预警、最容易反复出现的三个地方，
      以及每条各配一个具体改法。
    </p>`;
}

/* ========================================================================== */

function renderPaywall(ent, currentId) {
  const paywall = $('#paywall');
  const reportHref = `report.html?r=${encodeURIComponent(currentId)}`;

  if (ent.single) {
    paywall.innerHTML = `
      <div class="paywall__head">
        <div>
          <p class="tag tag--lime">已解锁</p>
          <h3 class="mt-3">你的深度报告已经打开</h3>
          <p class="muted mt-2 t-sm">8 个章节：模式溯源、压力预警、反复出现的模式、应对动作、往安全侧移动的路径。</p>
        </div>
      </div>
      <a class="btn btn--lg mt-5" href="${reportHref}">查看我的报告 →</a>`;
    return;
  }

  paywall.innerHTML = `
    <div class="paywall__head">
      <div>
        <p class="tag tag--blue">深度报告</p>
        <p class="paywall__price mt-3">${CONFIG.freeMode ? '¥0' : '¥9.9'}
          <small>${CONFIG.freeMode ? '（免费体验期）' : '一次性，永久可看'}</small></p>
      </div>
    </div>
    <ul class="paywall__list">
      <li>你的这套模式是怎么长出来的（不是归罪于原生家庭）</li>
      <li>压力状态下你会升级成什么样子，以及前兆信号</li>
      <li>最容易反复出现的三个地方，每一处配一个具体改法</li>
      <li>和四类人相处时的互动规律，各给一条可执行建议</li>
      <li>三个可以立刻开始做的动作（建议一次只做一个）</li>
      <li>把依恋模式往安全侧移动的路径</li>
      <li>什么情况下，找专业帮助比自助更划算</li>
    </ul>
    <button class="btn btn--lg btn--block" id="btn-buy" type="button">
      ${CONFIG.freeMode ? '免费解锁这 8 章报告 →' : '解锁 8 页报告｜¥9.9 →'}
    </button>
    <p class="tiny mt-3">
      ${CONFIG.freeMode
        ? '当前为免费体验期：不会向你收取任何费用，也不会要求登录或绑定手机号。'
        : '支付后立即生效，无需注册。'}
    </p>`;

  $('#btn-buy')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setLoading(btn, true, '正在打开…');
    track(FUNNEL.payClick, { plan: 'single', resultId: currentId });
    try {
      await purchase('single', currentId);
      track(FUNNEL.paySuccess, { plan: 'single', resultId: currentId, amount: CONFIG.freeMode ? 0 : 990 });
      location.href = reportHref;
    } catch (err) {
      setLoading(btn, false);
      toast(err?.message || '暂时没能打开，请稍后再试。', 'error');
    }
  });

  // 非免费期才露出兑换码入口；免费期露出反而徒增噪音
  if (!CONFIG.freeMode) {
    $('#redeem-row').classList.remove('hide');
    $('#btn-redeem').addEventListener('click', async (e) => {
      const code = $('#redeem-input').value.trim();
      if (!code) { toast('请先填写兑换码。', 'error'); return; }
      const btn = e.currentTarget;
      setLoading(btn, true, '兑换中…');
      try {
        await redeemCode(code, 'single');
        toast('兑换成功，正在打开报告。');
        setTimeout(() => { location.href = reportHref; }, 600);
      } catch (err) {
        setLoading(btn, false);
        toast(err?.message || '兑换失败，请检查兑换码。', 'error');
      }
    });
  }
}

/* ========================================================================== */

function renderDuoBox(result) {
  const box = $('#duo-box');
  const arr = answersToArray(result.answers || {});

  let inviteUrl = '';
  try {
    inviteUrl = buildInviteUrl('duo.html', arr);
  } catch {
    inviteUrl = '';
  }

  if (!inviteUrl) {
    box.innerHTML =
      '<p class="muted t-sm">本机未保留原始作答，无法生成邀请链接。请重新测试一次。</p>';
    return;
  }

  box.innerHTML = `
    <div class="row row--between" style="align-items:flex-start">
      <div style="min-width:220px;flex:1">
        <h3>想知道你们为什么会卡在同一个地方？</h3>
        <p class="muted mt-2 t-sm">
          把链接发给对方。对方答完之前，合盘结果不会显示——
          因为这需要两个人的数据同时存在才能算出来。
        </p>
      </div>
      <span class="tag tag--purple">双人合盘 ${CONFIG.freeMode ? '免费' : '¥29.9'}</span>
    </div>
    <div class="qr-block mt-5">
      <div class="qr-block__text">
        <div class="btn-group">
          <button class="btn" id="btn-copy-invite" type="button">复制邀请链接</button>
          <button class="btn btn--white" id="btn-share-invite" type="button">系统分享</button>
        </div>
        <p class="tiny mt-3 mono break-anywhere" id="invite-preview"></p>
        <p class="tiny mt-3">二维码在本机生成，链接不经过任何第三方。</p>
      </div>
      <div id="qr-host"></div>
    </div>`;

  const preview = $('#invite-preview');
  preview.textContent = inviteUrl.length > 90 ? `${inviteUrl.slice(0, 90)}…` : inviteUrl;

  $('#qr-host').appendChild(qrFigure(inviteUrl, { caption: '当面的话，让对方直接扫这个码' }));

  $('#btn-copy-invite').addEventListener('click', async () => {
    const ok = await copyText(inviteUrl);
    track(FUNNEL.inviteSent, { via: 'copy' });
    toast(ok ? '链接已复制，去发给对方吧。' : '复制失败，请手动长按选择。', ok ? 'info' : 'error');
  });

  $('#btn-share-invite').addEventListener('click', async () => {
    track(FUNNEL.inviteSent, { via: 'share' });
    if (navigator.share) {
      try {
        await navigator.share({
          title: '我做完了一个依恋类型测试',
          text: '你也测一下，我们才能看到合盘结果：',
          url: inviteUrl,
        });
      } catch { /* 用户取消，不算错误 */ }
    } else {
      const ok = await copyText(inviteUrl);
      toast(ok ? '当前浏览器不支持系统分享，已帮你复制链接。' : '复制失败，请手动复制。');
    }
  });
}

/* ========================================================================== */

function renderMissing() {
  document.getElementById('main').innerHTML = `
    <section class="section wrap wrap--narrow">
      <div class="empty">
        <h1>找不到这份结果</h1>
        <p class="mt-4 muted">结果可能已被清理，或者链接不完整。重新测一次只要 3 分钟。</p>
        <p class="mt-5"><a class="btn btn--lg" href="quiz.html">重新测试 →</a></p>
      </div>
    </section>`;
}
