/**
 * views/convert.js —— 转换（默认视图）
 *
 * 版面（docs/ui-spec-swiss.md 4.1）：
 *   标题「转换」+ 一句话说明 + 1px 分隔线
 *   工具栏：[添加文件] [清空列表] …右侧：目标格式 ▾  [高级]  [开始转换]
 *   左 5 栏：待转换文件表（文件名 / 格式 / 大小 / 移除，移除是行内图标操作）
 *            底部一行：N 个文件 · 合计 X · 主格式 FMT
 *   右 7 栏：任务摘要（目标格式 / 将使用 / 输出 / 上次结果）+ 进行中的进度
 *   高级（抽屉）：使用内核 / 输出目录 / 参数区 / 命令行预览 / 复位为默认值
 *
 * 数据流（全部经 window.khs，UI 不持有任何格式/参数知识）：
 *   pending(文件池) ─┬─→ plan.targets()     → 目标格式下拉
 *                    ├─→ plan.candidates()  → 「将使用」+ 候选
 *                    └─→ plan.params()      → controls.js 生成参数控件
 *   (op, dstFmt, kernelId) 任一变化都会重跑上面三步，并用序号守卫丢弃过期结果。
 *
 * 兜底分支（宿主返回 fallback: true）：还没加入文件时，宿主按「该操作下的代表性内核」
 * 给出目标格式与参数，界面会明确标注来源，加入文件后立刻换成按真实源格式选核的结果。
 */

import { h, clear, on, copyText, iconAction } from '../dom.js';
import { icon } from '../icons.js';
import { createParamPanel } from '../controls.js';
import { createSheet } from '../sheet.js';
import { humanSize, thousands, formatLabel, orDash, percent } from '../format.js';

export async function mount(host, ctx) {
  const { store, navigate } = ctx;
  const disposers = [];

  /* --------------------------------------------------------------- 状态 */

  const vs = {
    op: '',
    dstFmt: '',
    kernelId: '', // '' = 自动选择
    outDir: '',
    sameDir: true, // 规范默认：与源文件同目录
    targets: [],
    sourceFormat: '',
    targetsFallback: false,
    candidates: [],
    chosen: null,
    kernelNote: null,
    paramsFallback: false,
    seq: 0,
    preview: null,
  };

  const settings = store.pick('settings') || {};
  vs.op = String(settings.defaultOp || '');
  vs.outDir = String(settings.lastOutputDir || '');

  /* --------------------------------------------------------------- 结构 */

  /* --- 目标格式下拉（工具栏右侧，唯一入口） --- */
  const dstSelect = h('select.select', { dataset: { role: 'target' }, 'aria-label': '目标格式' });

  const addBtn = h('button.btn', {
    type: 'button',
    title: '添加文件到待转换列表',
    on: { click: () => ctx.pickFiles() },
  }, h('span', { textContent: '添加文件' }));

  const clearBtn = h('button.btn', {
    type: 'button',
    title: '清空待转换列表（不会删除磁盘文件）',
    on: {
      click: async () => {
        if (!store.pick('pending').length) return;
        if (await ctx.modal.confirm('清空待转换列表？', { okLabel: '清空', danger: true })) ctx.clearPending();
      },
    },
  }, h('span', { textContent: '清空列表' }));

  const advancedBtn = h('button.btn', {
    type: 'button',
    title: '内核参数、输出目录、命令行预览',
    on: {
      click: () => {
        sheet.open();
        refreshPreviewIfOpen();
      },
    },
  }, h('span', { textContent: '高级' }));

  const startBtn = h('button.btn.btn--primary', {
    type: 'button',
    title: '把待转换列表提交到队列（Ctrl/Cmd+Enter）',
    on: { click: () => startConversion() },
  }, h('span', { textContent: '开始转换' }));

  const toolbar = h('div.toolbar', null,
    addBtn,
    clearBtn,
    h('div.toolbar__right', null,
      h('label.label', { style: { marginBottom: '0' }, textContent: '目标格式' }),
      h('div.selectwrap', { style: { width: '160px' } }, dstSelect),
      h('div.toolbar__sep'),
      advancedBtn,
      startBtn
    )
  );

  /* --- 左：待转换文件 --- */
  const fileBody = h('tbody');
  const fileTable = h('table.table', null,
    h('colgroup', null,
      h('col', { style: { width: '56%' } }),
      h('col', { style: { width: '16%' } }),
      h('col', { style: { width: '20%' } }),
      h('col', { style: { width: '8%' } })
    ),
    h('thead', null, h('tr', null,
      h('th', { textContent: '文件名' }),
      h('th', { textContent: '格式' }),
      h('th', { class: 'num', textContent: '大小' }),
      h('th', { class: 'num', textContent: '移除' })
    )),
    fileBody
  );
  const fileEmpty = h('div.empty', null,
    h('div.empty__title', { textContent: '还没有待转换文件' }),
    h('div.empty__text', { textContent: '把文件或文件夹拖到这里，或点「选择文件」。目录会被递归展开。' }),
    h('div.empty__actions', null,
      h('button.btn.btn--primary', {
        type: 'button',
        on: { click: () => ctx.pickFiles() },
      }, h('span', { textContent: '选择文件' }))
    )
  );
  const fileSummaryEl = h('div.filelist__summary');
  const dropzone = h('div.filelist', null, fileTable, fileEmpty, fileSummaryEl);

  /* --- 右：任务摘要 --- */
  const chosenValueEl = h('span.summary-line__v', { textContent: '—' });
  const outputValueEl = h('span.summary-line__v', { textContent: '与源文件同目录' });
  const lastResultEl = h('div.field__hint');
  const progressHost = h('div.panel.hidden');

  const sameDirCheck = h('input.check', { type: 'checkbox', checked: true });
  sameDirCheck.addEventListener('change', () => {
    vs.sameDir = sameDirCheck.checked;
    syncOutDirUi();
    renderSummary();
    refreshPreviewIfOpen();
  });

  const summaryPanel = h('section.panel', null,
    h('div.panel__head', null, h('div.panel__title', { textContent: '任务摘要' })),
    h('div.summary-list', null,
      h('div.summary-line', null,
        h('span.summary-line__k', { textContent: '目标格式' }),
        h('span.summary-line__v', { dataset: { role: 'target-summary' }, textContent: '—' })
      ),
      h('div.summary-line', null,
        h('span.summary-line__k', { textContent: '将使用' }),
        chosenValueEl
      ),
      h('div.summary-line', null,
        h('span.summary-line__k', { textContent: '输出' }),
        outputValueEl
      ),
      h('label.check-row', null, sameDirCheck, h('span', { textContent: '与源文件同目录' }))
    ),
    lastResultEl,
    progressHost
  );

  const wrap = h('div.view-inner', null,
    h('div.view-head', null,
      h('h1.view-title', { textContent: '转换' }),
      h('div.view-rule')
    ),
    toolbar,
    h('div.grid12', null,
      h('div.c5', null, dropzone),
      h('div.c7', null, summaryPanel)
    )
  );
  host.appendChild(wrap);

  /* ------------------------------------------------ 高级面板（右侧抽屉） */

  const sheet = createSheet(host, {
    id: 'convert-advanced',
    title: '高级',
    subtitle: '内核参数 / 输出目录 / 命令行预览',
  });

  const kernelSelect = h('select.select', { 'aria-label': '使用内核' });
  const kernelHint = h('div.field__hint');
  const candidateFlow = h('div.tagflow');
  const kernelSection = h('div.param-section', null,
    h('div.param-section__title', null, h('span', { textContent: '使用内核' })),
    h('div.field', null, h('label.label', { textContent: '内核' }), h('div.selectwrap', null, kernelSelect)),
    candidateFlow,
    kernelHint
  );

  const outDirInput = h('input.input.input--mono', {
    type: 'text',
    value: vs.outDir,
    placeholder: '未指定（与源文件同目录）',
    'aria-label': '输出目录',
  });
  outDirInput.addEventListener('change', () => {
    vs.outDir = outDirInput.value.trim();
    syncOutDirUi();
    renderSummary();
    refreshPreviewIfOpen();
  });
  const outDirPickBtn = iconAction({
    classes: ['iconbtn'],
    label: '选择输出目录',
    children: [icon('folderOpen', { size: 15 })],
    onClick: async () => {
      try {
        const res = await window.khs.fs.pickFolder({ title: '选择输出目录', defaultPath: vs.outDir || undefined });
        if (res && res.folder) {
          vs.outDir = res.folder;
          outDirInput.value = res.folder;
          syncOutDirUi();
          renderSummary();
          refreshPreviewIfOpen();
        }
      } catch (err) {
        ctx.reportError('选择输出目录失败', ctx.wrapError(err));
      }
    },
  });
  const outDirSection = h('div.param-section', null,
    h('div.param-section__title', null, h('span', { textContent: '输出目录' })),
    h('div.field', null,
      h('label.label', { textContent: '目录' }),
      h('div.path-row', null, outDirInput, outDirPickBtn)
    ),
    h('div.field__hint', { textContent: '勾选「与源文件同目录」时，每个产物留在各自源文件所在目录。' })
  );

  const paramHost = h('div');
  const paramPanel = createParamPanel(paramHost, { onChange: () => {} });
  const paramSection = h('div.param-section', null,
    h('div.param-section__title', null,
      h('span', { textContent: '内核参数' }),
      h('span.badge.badge--mono', { dataset: { role: 'param-count' }, textContent: '0' })
    ),
    paramHost
  );

  const previewPre = h('pre', { textContent: '—' });
  const previewNote = h('div.field__hint', { textContent: '还没有可预览的组合：先添加文件并选择目标格式。' });
  const previewCopyBtn = h('button.btn.btn--quiet.btn--sm', {
    type: 'button',
    title: '复制命令行',
    on: {
      click: async () => {
        const text = previewCommandText();
        if (!text) return;
        const ok = await copyText(text);
        if (ok) ctx.toast.success('已复制命令行');
        else ctx.toast.warn('复制失败', '当前环境不允许访问剪贴板');
      },
    },
  }, h('span', { textContent: '复制' }));
  const previewSection = h('div.param-section', null,
    h('div.param-section__title', null,
      h('span', { textContent: '命令行预览' }),
      h('span.grow'),
      previewCopyBtn
    ),
    h('div.codeblock.codeblock--wrap', null, h('div.codeblock__bar', null, h('span', { textContent: '只读 · 不会执行' })), previewPre),
    previewNote
  );

  const resetBtn = h('button.btn', {
    type: 'button',
    title: '把全部参数恢复为该内核声明的默认值',
    on: {
      click: () => {
        paramPanel.reset();
        ctx.toast.info('参数已复位为默认值');
      },
    },
  }, h('span', { textContent: '复位为默认值' }));

  sheet.body.appendChild(kernelSection);
  sheet.body.appendChild(outDirSection);
  sheet.body.appendChild(paramSection);
  sheet.body.appendChild(previewSection);
  sheet.foot.appendChild(resetBtn);

  /* --------------------------------------------------------------- 事件 */

  disposers.push(on(dstSelect, 'change', () => {
    vs.dstFmt = dstSelect.value;
    refreshPlan();
  }));
  disposers.push(on(kernelSelect, 'change', () => {
    vs.kernelId = kernelSelect.value;
    refreshTargets({ resetParams: true });
  }));

  bindFileDrop(dropzone);

  /* --------------------------------------------------------- 目标格式/选核 */

  async function refreshTargets({ resetParams = false } = {}) {
    const seq = ++vs.seq;
    const sources = store.pick('pending');

    if (!sources.length) {
      let res = null;
      try {
        res = await window.khs.plan.targets({ op: vs.op || undefined, kernelId: vs.kernelId || undefined });
      } catch (err) {
        if (seq !== vs.seq) return;
        ctx.reportError('读取目标格式失败', ctx.wrapError(err));
      }
      if (seq !== vs.seq) return;
      vs.sourceFormat = '';
      vs.targets = res && Array.isArray(res.targets) ? res.targets.slice() : [];
      vs.targetsFallback = Boolean(res && res.fallback);
      if (!vs.targets.includes(vs.dstFmt)) vs.dstFmt = vs.targets[0] || '';
      renderTargets();
      await refreshPlan({ seq });
      renderSummary();
      return;
    }

    const first = sources[0];
    let res = null;
    try {
      res = await window.khs.plan.targets({ sourcePath: first.path, op: vs.op || undefined, kernelId: vs.kernelId || undefined });
    } catch (err) {
      if (seq !== vs.seq) return;
      ctx.reportError('读取目标格式失败', ctx.wrapError(err));
      return;
    }
    // 指定内核却拿不到目标时，退化为自动选择再试一次，避免死路
    if (vs.kernelId && (!res || !Array.isArray(res.targets) || !res.targets.length)) {
      try {
        const limited = await window.khs.plan.targets({ sourcePath: first.path, op: vs.op || undefined });
        if (seq !== vs.seq) return;
        if (limited && Array.isArray(limited.targets) && limited.targets.length) {
          ctx.toast.warn('所选内核没有可用目标格式', { text: '已自动切回「自动选择内核」。' });
          vs.kernelId = '';
          kernelSelect.value = '';
          res = limited;
        }
      } catch {
        /* 保持原结果 */
      }
    }
    if (seq !== vs.seq) return;

    vs.targetsFallback = false;
    vs.sourceFormat = (res && res.sourceFormat) || first.format || '';
    vs.targets = (res && Array.isArray(res.targets)) ? res.targets.slice() : [];
    if (!vs.targets.includes(vs.dstFmt)) vs.dstFmt = vs.targets[0] || '';
    renderTargets();
    if (resetParams) paramPanel.setSpecs([]);
    await refreshPlan({ seq });
    renderSummary();
  }

  async function refreshPlan({ seq: outerSeq = null } = {}) {
    const seq = outerSeq === null ? ++vs.seq : outerSeq;
    const sources = store.pick('pending');

    if (!sources.length && !vs.dstFmt) {
      vs.chosen = null;
      vs.candidates = [];
      paramPanel.setSpecs([]);
      renderChosen();
      updateStart();
      return;
    }

    // 没有文件但已选目标格式：拿「代表性内核」的参数声明，并明确标注来源
    if (!sources.length) {
      let paramsRes = null;
      try {
        paramsRes = await window.khs.plan.params({ op: vs.op, dstFmt: vs.dstFmt, kernelId: '' });
      } catch (err) {
        if (seq !== vs.seq) return;
        ctx.reportError('读取参数声明失败', ctx.wrapError(err));
      }
      if (seq !== vs.seq) return;
      vs.chosen = null;
      vs.candidates = [];
      vs.paramsFallback = Boolean(paramsRes && paramsRes.fallback);
      vs.kernelNote = paramsRes && paramsRes.kernel ? paramsRes.kernel : null;
      paramPanel.setSpecs(paramsRes ? paramsRes.params : []);
      paramPanel.setContext({ op: vs.op, srcFmt: (paramsRes && paramsRes.srcFmt) || '', dstFmt: vs.dstFmt });
      renderChosen();
      renderParamCount();
      updateStart();
      return;
    }

    const base = {
      op: vs.op,
      srcFmt: vs.sourceFormat || undefined,
      dstFmt: vs.dstFmt,
      sources: sources.map((f) => f.path),
    };
    vs.paramsFallback = false;

    let candidatesRes = null;
    let paramsRes = null;
    try {
      const tasks = [window.khs.plan.candidates(base)];
      if (vs.kernelId) tasks.push(window.khs.plan.params({ ...base, kernelId: vs.kernelId }));
      const [cand, params] = await Promise.all(tasks);
      candidatesRes = cand;
      paramsRes = params || null;
    } catch (err) {
      if (seq !== vs.seq) return;
      ctx.reportError('计算选核/参数失败', ctx.wrapError(err));
      return;
    }
    if (seq !== vs.seq) return;

    vs.candidates = (candidatesRes && Array.isArray(candidatesRes.candidates)) ? candidatesRes.candidates : [];
    vs.chosen = (candidatesRes && candidatesRes.chosen) || null;
    if (paramsRes && paramsRes.kernel) vs.kernelNote = paramsRes.kernel;

    if (!paramsRes) {
      try {
        paramsRes = await window.khs.plan.params({ ...base, kernelId: '' });
      } catch (err) {
        if (seq !== vs.seq) return;
        ctx.reportError('读取参数声明失败', ctx.wrapError(err));
        paramsRes = null;
      }
      if (seq !== vs.seq) return;
    }

    paramPanel.setSpecs(paramsRes ? paramsRes.params : []);
    paramPanel.setContext({ op: vs.op, srcFmt: vs.sourceFormat, dstFmt: vs.dstFmt });
    renderChosen();
    renderParamCount();
    updateStart();
  }

  /* ------------------------------------------------------------- 渲染 */

  function renderTargets() {
    clear(dstSelect);
    if (!vs.targets.length) {
      dstSelect.appendChild(h('option', {
        value: '',
        textContent: vs.targetsFallback ? '该操作没有可用目标格式' : '当前文件没有可用目标',
      }));
      dstSelect.disabled = true;
    } else {
      dstSelect.disabled = false;
      for (const fmt of vs.targets) {
        dstSelect.appendChild(h('option', { value: fmt, textContent: formatLabel(fmt) }));
      }
      dstSelect.value = vs.dstFmt;
    }
    const summary = wrap.querySelector('[data-role="target-summary"]');
    if (summary) {
      summary.textContent = vs.dstFmt
        ? `${formatLabel(vs.dstFmt)}${vs.sourceFormat ? `（源 ${formatLabel(vs.sourceFormat)}）` : vs.targetsFallback ? '（尚未添加文件）' : ''}`
        : '—';
    }
  }

  function renderKernelSelect() {
    const kernels = (store.pick('kernels') || []).filter((k) => k.status === 'ready');
    const prev = vs.kernelId;
    clear(kernelSelect);
    kernelSelect.appendChild(h('option', { value: '', textContent: '自动选择（按质量与优先级）' }));
    for (const k of kernels) {
      kernelSelect.appendChild(h('option', {
        value: k.id,
        textContent: `${k.name || k.id}${k.engineNote ? ` · ${k.engineNote}` : ''}`,
      }));
    }
    if (prev && !kernels.some((k) => k.id === prev)) vs.kernelId = '';
    kernelSelect.value = vs.kernelId;
    kernelHint.textContent = kernels.length
      ? `共 ${kernels.length} 个可用内核；指定内核后目标格式会按其能力收敛。`
      : '当前没有可用内核：到「插件」页安装插件，或在「已安装」里看依赖缺失的原因。';
  }

  function renderChosen() {
    const chosen = vs.chosen;
    const files = store.pick('pending');

    if (files.length && chosen && chosen.error) {
      chosenValueEl.textContent = `无可用内核：${chosen.error}`;
      chosenValueEl.className = 'summary-line__v accent';
    } else if (chosen) {
      chosenValueEl.textContent = `${chosen.name || chosen.id}${chosen.engineNote ? ` · ${chosen.engineNote}` : ''}`;
      chosenValueEl.className = 'summary-line__v';
    } else if (vs.paramsFallback && vs.kernelNote) {
      chosenValueEl.textContent = '—（尚未添加文件）';
      chosenValueEl.className = 'summary-line__v';
    } else {
      chosenValueEl.textContent = '—';
      chosenValueEl.className = 'summary-line__v';
    }

    clear(candidateFlow);
    const others = (vs.candidates || []).filter((c) => c && c.id !== (chosen && chosen.id));
    for (const c of others.slice(0, 8)) {
      candidateFlow.appendChild(h('span.tag', {
        title: `质量 ${c.quality || 0} · 优先级 ${c.priority || 0}${c.matched && c.matched.label ? ` · 命中能力：${c.matched.label}` : ''}`,
        textContent: c.name || c.id,
      }));
    }
  }

  function renderParamCount() {
    const counts = paramPanel.counts();
    const badge = sheet.el.querySelector('[data-role="param-count"]');
    if (badge) badge.textContent = counts.total ? `${counts.visible} / ${counts.total} 项参数` : '无参数';
  }

  function renderFileList() {
    const files = store.pick('pending');
    clear(fileBody);
    const hasFiles = files.length > 0;
    fileTable.hidden = !hasFiles;
    fileEmpty.hidden = hasFiles;
    // 列表为空时，添加文件这件事由空状态里的主按钮承担，工具栏不再重复提供一个按钮
    addBtn.hidden = !hasFiles;

    files.forEach((file) => {
      fileBody.appendChild(h('tr', { dataset: { path: file.path }, title: file.path },
        h('td', { class: 'truncate' }, h('span', { textContent: file.name || '' })),
        h('td', { class: 'filelist__fmt', textContent: formatLabel(file.format) }),
        h('td', { class: 'num mono', textContent: file.size || humanSize(file.bytes) }),
        h('td', { class: 'num' },
          // 行操作不渲染成 <button>：否则 20 个文件就是 20 个按钮
          iconAction({
            classes: ['iconbtn'],
            label: `移除 ${file.name || ''}`,
            children: [h('span', { textContent: '✕' })],
            onClick: () => ctx.removePendingFile(file.path),
          })
        )
      ));
    });

    renderFileSummary();
  }

  function renderFileSummary() {
    const files = store.pick('pending');
    clear(fileSummaryEl);
    if (!files.length) return;
    const totalBytes = files.reduce((sum, f) => sum + (Number(f.bytes) || 0), 0);
    const counts = new Map();
    for (const f of files) {
      const key = String(f.format || '');
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let dominant = '';
    let best = -1;
    for (const [key, n] of counts) {
      if (n > best) { best = n; dominant = key; }
    }
    fileSummaryEl.appendChild(h('span', { textContent: `${thousands(files.length)} 个文件` }));
    fileSummaryEl.appendChild(h('span', { textContent: '·' }));
    fileSummaryEl.appendChild(h('span', { textContent: `合计 ${humanSize(totalBytes)}` }));
    fileSummaryEl.appendChild(h('span', { textContent: '·' }));
    fileSummaryEl.appendChild(h('span', { textContent: `主格式 ${formatLabel(dominant)}` }));
  }

  function syncOutDirUi() {
    outDirInput.disabled = vs.sameDir;
    outDirPickBtn.disabled = vs.sameDir;
    sameDirCheck.checked = vs.sameDir;
    outDirInput.value = vs.outDir;
    outDirInput.placeholder = vs.sameDir ? '（已选择与源文件同目录）' : '未指定（与源文件同目录）';
  }

  /**
   * 任务摘要里的「输出」，以及页脚提示。
   *
   * 2.0.4：「上次结果：成功 N · 失败 N · 用时 N s」从摘要卡片移到了状态栏右下角
   * （属于实时信息，和队列/内核的数字放一起才对）。摘要卡片只留一行状态提示。
   */
  function renderSummary() {
    outputValueEl.textContent = vs.sameDir ? '与源文件同目录' : (vs.outDir || '源文件所在目录');

    const ids = store.pick('lastRunIds') || [];
    const jobs = store.pick('jobs') || new Map();
    const run = ids.map((id) => jobs.get(id)).filter(Boolean);

    clear(lastResultEl);
    if (!run.length) {
      lastResultEl.textContent = filesHintText();
      // 没有「上次结果」时也要把上一轮残留的数字清掉
      ctx.setStatusInfo(convertStatusInfo());
      return;
    }

    const done = run.filter((j) => j.state === 'done').length;
    const failed = run.filter((j) => j.state === 'failed').length;
    const finished = run.filter((j) => j.state === 'done' || j.state === 'failed' || j.state === 'cancelled');
    const started = Math.min(...finished.map((j) => Number(j.startedAt) || Number(j.addedAt) || Date.now()));
    const ended = Math.max(...finished.map((j) => Number(j.finishedAt) || Date.now()));
    const elapsed = finished.length ? ` · 用时 ${((Math.max(0, ended - started)) / 1000).toFixed(1)} s` : '';

    lastResultEl.textContent = filesHintText();
    ctx.setStatusInfo(convertStatusInfo({
      text: `上次结果：成功 ${done} · 失败 ${failed}${elapsed}`,
      tone: failed ? 'err' : 'ok',
    }));
  }

  /** 转换页推到右下角的状态信息：上次结果 + 当前文件数与输出位置 */
  function convertStatusInfo(lastResult) {
    const pending = store.pick('pending') || [];
    const items = [];
    if (lastResult) items.push(lastResult);
    items.push(`${pending.length} 个待转换文件`);
    items.push(vs.sameDir ? '输出：与源文件同目录' : `输出：${vs.outDir || '源文件所在目录'}`);
    return items;
  }

  function filesHintText() {
    const ready = (store.pick('kernels') || []).filter((k) => k.status === 'ready').length;
    if (!ready) return '没有可用内核：请到「插件」页安装插件，或看「已安装」里依赖缺失的原因。';
    if (!store.pick('pending').length) return '添加文件后即可开始：选核与参数由内核清单决定。';
    if (!vs.dstFmt) return '当前操作下没有可用的目标格式。';
    return '就绪：点「开始转换」提交到队列。';
  }

  function updateStart() {
    const files = store.pick('pending');
    const readyKernels = (store.pick('kernels') || []).filter((k) => k.status === 'ready').length;
    const canStart = files.length > 0 && Boolean(vs.dstFmt) && (vs.chosen ? !vs.chosen.error : true) && readyKernels > 0;
    startBtn.disabled = !canStart;
    clearBtn.disabled = files.length === 0;
    renderProgress();
    renderSummary();
  }

  /** 进度：只展示最近活跃的一个作业（不把工作台变成第二张队列表） */
  function renderProgress() {
    const jobs = Array.from((store.pick('jobs') || new Map()).values())
      .filter((j) => j.state === 'running' || j.state === 'queued')
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));

    clear(progressHost);
    if (!jobs.length) {
      progressHost.classList.add('hidden');
      return;
    }
    progressHost.classList.remove('hidden');
    const job = jobs[0];
    const value = Number(job.progress) || 0;
    progressHost.appendChild(h('div.row', null,
      h('span', { class: 'dot dot--busy' }),
      h('span.truncate', { textContent: `${job.sourceName || job.id} → ${formatLabel(job.targetFormat)}` }),
      h('span.grow'),
      h('span.mono', { textContent: percent(value) })
    ));
    progressHost.appendChild(h('div.progress', null,
      h('div.progress__fill', { style: { width: `${Math.max(2, value * 100)}%` } })
    ));
    progressHost.appendChild(h('div.field__hint', {
      textContent: `${job.progressMessage || (job.state === 'queued' ? '排队中…' : '执行中…')}${jobs.length > 1 ? ` · 另有 ${jobs.length - 1} 个` : ''}`,
    }));
  }

  /* -------------------------------------------------------------- 预览 */

  function buildRequest() {
    return {
      sources: store.pick('pending').map((f) => f.path),
      op: vs.op,
      targetFormat: vs.dstFmt,
      outDir: vs.sameDir ? '' : (vs.outDir || ''),
      sameDir: vs.sameDir,
      params: paramPanel.values(),
      kernelId: vs.kernelId || undefined,
    };
  }

  function previewCommandText() {
    const p = vs.preview;
    if (!p || p.ok === false) return '';
    const argv = Array.isArray(p.argv) ? p.argv : (Array.isArray(p.adapterArgv) ? p.adapterArgv : []);
    return argv.join(' ');
  }

  function renderPreview() {
    const p = vs.preview;
    previewPre.classList.remove('accent');
    if (!p) {
      previewPre.textContent = '—';
      previewNote.textContent = '还没有可预览的组合：先添加文件并选择目标格式。';
      previewCopyBtn.disabled = true;
      return;
    }
    if (p.ok === false) {
      previewPre.textContent = `${p.code || 'ERROR'}：${p.message || '未知原因'}`;
      previewPre.classList.add('accent');
      previewNote.textContent = '预览失败不影响其它配置。';
      previewCopyBtn.disabled = true;
      return;
    }
    const lines = [];
    if (Array.isArray(p.argv) && p.argv.length) {
      lines.push(...p.argv.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)));
    } else if (Array.isArray(p.adapterArgv) && p.adapterArgv.length) {
      lines.push(...p.adapterArgv.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)));
    }
    previewPre.textContent = lines.length ? lines.join(' ') : '（该内核没有可展开的命令行）';
    const base = p.note ? String(p.note) : `内核 ${orDash(p.kernel && (p.kernel.name || p.kernel.id))} · 输出 ${(p.outputs || []).length} 个文件`;
    previewNote.textContent = store.pick('pending').length > 1
      ? `${base}（预览取列表第一个文件为例；队列会按每个文件各自的源格式逐个执行）`
      : base;
    previewCopyBtn.disabled = !lines.length;
  }

  /**
   * 面板打开时才去问宿主，避免无谓的 IPC。
   * 注意：队列是「一个文件一个作业」，而 plan.preview 一次只规划一次调用，
   * 因此预览固定取列表第一个文件（多个文件时会在下面注明）。
   */
  async function refreshPreviewIfOpen() {
    if (!sheet.isOpen()) return;
    const files = store.pick('pending');
    if (!files.length || !vs.dstFmt) {
      vs.preview = null;
      renderPreview();
      return;
    }
    const req = { ...buildRequest(), sources: [files[0].path], sourceFormat: vs.sourceFormat };
    try {
      vs.preview = await window.khs.plan.preview(req);
    } catch (err) {
      vs.preview = { ok: false, message: err && err.message ? err.message : String(err) };
    }
    renderPreview();
  }

  /* -------------------------------------------------------------- 动作 */

  async function startConversion() {
    const req = buildRequest();
    if (!req.sources.length) {
      ctx.toast.warn('没有待转换文件', { text: '请先添加文件。' });
      return;
    }
    if (!req.targetFormat) {
      ctx.toast.warn('没有目标格式', { text: '请先选择目标格式。' });
      return;
    }
    try {
      const res = await window.khs.queue.enqueue(req);
      const jobs = (res && Array.isArray(res.jobs)) ? res.jobs : [];
      if (!jobs.length) {
        ctx.toast.warn('没有作业入队', { text: '主进程没有为这些文件创建作业，请检查文件是否仍然存在。' });
        return;
      }
      store.set({ lastRunIds: jobs.map((j) => j.id) });
      if (!vs.sameDir && vs.outDir && vs.outDir !== (store.pick('settings') || {}).lastOutputDir) {
        ctx.patchSettings({ lastOutputDir: vs.outDir }, { silent: true });
      }
      ctx.toast.success(`已加入队列：${jobs.length} 个作业`, {
        text: `${formatLabel(vs.sourceFormat)} → ${formatLabel(req.targetFormat)} · ${(vs.chosen && vs.chosen.name) || '自动选核'}`,
        actions: [{ label: '查看队列', run: () => navigate('#/batch') }],
      });
      ctx.clearPending();
      renderSummary();
    } catch (err) {
      ctx.reportError('加入队列失败', ctx.wrapError(err));
    }
  }

  /* ------------------------------------------------------- 拖拽投放 */

  function bindFileDrop(target) {
    let depth = 0;
    disposers.push(on(target, 'dragenter', (event) => {
      event.preventDefault();
      depth += 1;
      target.dataset.drag = 'true';
    }));
    disposers.push(on(target, 'dragover', (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      target.dataset.drag = 'true';
    }));
    disposers.push(on(target, 'dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) target.dataset.drag = 'false';
    }));
    disposers.push(on(target, 'drop', async (event) => {
      event.preventDefault();
      depth = 0;
      target.dataset.drag = 'false';
      const paths = [];
      const dt = event.dataTransfer;
      if (dt) {
        for (const file of Array.from(dt.files || [])) {
          const p = ctx.pathForFile ? ctx.pathForFile(file) : file && file.path;
          if (p) paths.push(String(p));
        }
        for (const type of ['text/uri-list', 'text/plain']) {
          let raw = '';
          try {
            raw = dt.getData(type) || '';
          } catch {
            raw = '';
          }
          for (const line of raw.split(/\r?\n/)) {
            const value = line.trim();
            if (!value || value.startsWith('#')) continue;
            paths.push(/^file:\/\//i.test(value)
              ? decodeURIComponent(value.replace(/^file:\/\//i, '').replace(/^\/([a-zA-Z]:)/, '$1'))
              : value);
          }
        }
      }
      if (!paths.length) {
        ctx.toast.warn('没有识别到文件路径', { text: '请改用「添加文件」按钮。' });
        return;
      }
      await ctx.expandPaths(paths, { navigateAfter: false, label: '拖入内容' });
    }));
  }

  /* --------------------------------------------------------- 订阅与生命周期 */

  function pendingSignature() {
    return store.pick('pending').map((f) => f.path).join('|');
  }
  let lastPending = null;
  let lastKernels = '';
  let kernelsPrimed = false;
  let lastOps = '';

  function syncFromStore({ force = false } = {}) {
    const pendingSig = pendingSignature();
    const kernelsSig = (store.pick('kernels') || []).map((k) => `${k.id}:${k.status}`).join(',');
    const opsSig = (store.pick('ops') || []).map((o) => o.op).join(',');

    const kernelsChanged = kernelsPrimed && kernelsSig !== lastKernels;
    kernelsPrimed = true;

    if (force || kernelsSig !== lastKernels) {
      lastKernels = kernelsSig;
      renderKernelSelect();
      /**
       * 内核集合变了 → **目标格式必须重算**。
       *
       * 这是「装完插件却用不了」的根因：原来这里只重渲染内核下拉，
       * 目标格式还停留在装插件之前算出来的那份，新插件提供的格式根本选不到。
       * refreshTargets 内部会在当前选择仍有效时保留它，所以不会打断用户操作。
       */
      if (kernelsChanged) refreshTargets();
    }
    if (force || pendingSig !== lastPending) {
      lastPending = pendingSig;
      renderFileList();
      refreshTargets({ resetParams: true });
      return;
    }
    if (force || opsSig !== lastOps) {
      lastOps = opsSig;
    }
    updateStart();
  }

  disposers.push(store.subscribe(() => syncFromStore()));

  /* ------------------------------------------------------- 注册具名动作 */

  disposers.push(ctx.registerAction('start-convert', () => startConversion()));
  disposers.push(ctx.registerAction('set-op', (op) => {
    if (!op) return;
    if (!(store.pick('ops') || []).some((row) => row.op === op)) return;
    vs.op = op;
    vs.kernelId = '';
    refreshTargets({ resetParams: true });
  }));
  disposers.push(ctx.registerAction('set-target', (fmt) => {
    const value = String(fmt || '');
    if (!vs.targets.includes(value)) {
      // 目标不在当前列表里时，直接写进选择器，随后由 refreshPlan 校验
      vs.dstFmt = value;
      if (!Array.from(dstSelect.options).some((o) => o.value === value)) {
        dstSelect.appendChild(h('option', { value, textContent: formatLabel(value) }));
      }
    }
    vs.dstFmt = value;
    dstSelect.value = value;
    refreshPlan();
    renderSummary();
  }));
  disposers.push(ctx.registerAction('open-advanced', () => {
    sheet.open();
    refreshPreviewIfOpen();
  }));

  /* ------------------------------------------------------------- 首次渲染 */

  // 目标格式变化后刷新预览（面板打开时）
  disposers.push(on(dstSelect, 'change', () => refreshPreviewIfOpen()));

  renderKernelSelect();
  renderTargets();
  renderFileList();
  syncOutDirUi();
  renderPreview();
  updateStart();
  await refreshTargets({ resetParams: true });

  return {
    unmount() {
      paramPanel.dispose();
      sheet.destroy();
      while (disposers.length) {
        const dispose = disposers.pop();
        try {
          dispose();
        } catch {
          /* 忽略 */
        }
      }
      clear(host);
    },
  };
}
