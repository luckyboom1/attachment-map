/**
 * 报告页（report.html）
 * ===========================================================================
 * 履约要求：解锁后的报告必须即时可见。任何延迟都会让用户认为被骗。
 * 本页不做任何动画等待，拿到数据立刻渲染。
 */

import { mountChrome, $, h, richText, toast, copyText, downloadFile, escapeHtml } from '../ui/ui.js';
import { store } from '../core/store.js';
import { getType } from '../core/types.js';
import { CONFIG, fetchReport, ApiError, track } from '../api/index.js';

mountChrome({ page: 'report' });

const params = new URLSearchParams(location.search);
const resultId = params.get('r') || store.lastResultId();
const partnerId = params.get('partner');
const mode = params.get('mode') === 'duo' ? 'duo' : 'single';

const main = $('#main');

if (!resultId) {
  renderError('缺少结果编号', '请从结果页进入，或重新测试一次。');
} else {
  boot();
}

async function boot() {
  main.innerHTML = `
    <section class="section wrap wrap--narrow">
      <div class="row row--snug">
        <span class="spinner" aria-hidden="true"></span>
        <p class="muted">正在打开报告…</p>
      </div>
    </section>`;

  try {
    const report = await fetchReport(resultId, { mode, partnerId });
    render(report);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'UNAUTHORIZED') {
      renderLocked();
    } else {
      renderError('没能打开报告', err?.message || '请稍后重试。');
    }
  }
}

/* ------------------------------ 渲染 ------------------------------ */

function render(report) {
  const type = getType(report.typeKey);
  const isDuo = mode === 'duo';

  document.title = (isDuo ? '双人合盘报告' : `${type.name} · 深度报告`) + ' · 依恋地图';

  main.innerHTML = `
    <section class="section wrap wrap--narrow">
      <div class="row row--between no-print">
        <a class="btn btn--ghost btn--sm" href="${isDuo ? `duo.html${location.hash}` : `result.html?r=${encodeURIComponent(resultId)}`}">← 返回结果</a>
        <div class="row row--xs">
          <button class="btn btn--sm btn--white" id="btn-copy-report" type="button">复制全文</button>
          <button class="btn btn--sm btn--white" id="btn-print" type="button">打印 / 存 PDF</button>
        </div>
      </div>

      <header class="mt-6">
        <p class="tag ${isDuo ? 'tag--purple' : 'tag--mint'}">${isDuo ? '双人合盘报告' : '深度报告'}</p>
        <h1 class="mt-4">${isDuo ? '你们之间，正在发生什么' : type.name + '：一份只关于你的说明书'}</h1>
        <p class="lead mt-3">${isDuo ? '这份报告不评判谁对谁错，只描述机制，以及可以立刻动手改的部分。' : type.tagline}</p>
      </header>

      <nav class="card card--flat mt-6 no-print">
        <p class="field__label">目录</p>
        <ol class="mt-3 list--inline list--num t-sm" id="toc"></ol>
      </nav>

      <div class="stack stack--lg mt-7" id="sections"></div>

      <hr class="divider">
      <div class="card card--paper2">
        <h3>关于这份报告</h3>
        <p class="mt-3 t-sm muted">${escapeHtml(report.disclaimer)}</p>
        <p class="mt-3 tiny">
          生成方式：${report.generatedBy === 'template' ? '模板化生成（确定性输出，同一份结果每次打开内容完全一致）' : 'AI 润色'}。
          结果编号 ${resultId}。${CONFIG.freeMode ? '当前为免费体验期，未产生任何费用。' : ''}
        </p>
      </div>
    </section>`;

  const toc = $('#toc');
  const host = $('#sections');

  report.sections.forEach((sec, i) => {
    const id = `sec-${i + 1}`;
    toc.appendChild(h('li', {}, [h('a', { href: `#${id}`, text: sec.title })]));

    host.appendChild(h('section', { class: 'card card--lg', id }, [
      h('h2', { style: 'font-size:22px', text: sec.title }),
      h('div', { class: 'mt-4', style: 'font-size:15px;color:var(--text-2)', html: richText(sec.body) }),
    ]));
  });

  $('#btn-copy-report').addEventListener('click', async () => {
    const text = report.sections.map((s) => `${s.title}\n${s.body}`).join('\n\n———\n\n') +
      `\n\n${report.disclaimer}`;
    const ok = await copyText(text);
    toast(ok ? '全文已复制。' : '复制失败，请手动选择文本。', ok ? 'info' : 'error');
  });

  $('#btn-print').addEventListener('click', () => window.print());

  track('report_view', { resultId, mode, typeKey: report.typeKey });
}

/* ------------------------------ 未解锁 ------------------------------ */

function renderLocked() {
  main.innerHTML = `
    <section class="section wrap wrap--narrow">
      <div class="card card--lg tc">
        <p class="tag tag--red">未解锁</p>
        <h1 class="mt-4">这份报告还没有打开</h1>
        <p class="lead mt-3">报告是付费内容。回到结果页解锁后，就能立刻看到全部章节。</p>
        <a class="btn btn--lg mt-6" href="result.html?r=${encodeURIComponent(resultId)}">回到结果页解锁 →</a>
      </div>
    </section>`;
}

/* ------------------------------ 异常 ------------------------------ */

function renderError(title, desc) {
  // title / desc 都可能来自外部（desc 来自 ApiError.message，远程模式下即服务端返回）。
  // 拼进 innerHTML 前必须转义——否则一个可控的错误文案就是一处 XSS。
  const safeTitle = escapeHtml(title);
  const safeDesc = escapeHtml(desc);
  main.innerHTML = `
    <section class="section wrap wrap--narrow">
      <div class="empty">
        <h1>${safeTitle}</h1>
        <p class="mt-4 muted">${safeDesc}</p>
        <p class="mt-5"><a class="btn btn--lg" href="index.html">回到首页</a></p>
      </div>
    </section>`;
}
