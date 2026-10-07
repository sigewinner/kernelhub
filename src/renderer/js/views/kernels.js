/**
 * views/kernels.js —— 内核
 *
 * 版面（docs/ui-spec-swiss.md 4.3）：2 个按钮
 *   工具栏（左）：搜索输入框 + 状态 ▾ + 类型 ▾ + 排序 ▾
 *   工具栏（右）：[重新扫描] [打开目录]
 *   表格：名称 / 状态 / 操作 / 能力 / 参数 / 版本，行末「详情」文字链
 *   详情面板（高级抽屉）：概览 / 能力矩阵 / 参数表 / 引擎与依赖 / 启停与优先级 / 原始清单
 *
 * 一切字段都来自 window.khs 的返回（app.js 已把 kernels.kernelView 的结果放进 store），
 * 界面不预设任何内核名、格式名或状态名。
 */

import { h, clear, on, copyText, iconAction } from '../dom.js';
import { icon } from '../icons.js';
import { createSheet } from '../sheet.js';
import { statusBadge, kernelStateTone } from '../layout.js';
import { thousands, prettyJson, orDash, joinLimited } from '../format.js';

export async function mount(host, ctx) {
  const { store } = ctx;
  const disposers = [];

  const vs = {
    query: '',
    status: 'all',
    kind: 'all',
    sort: 'status',
    selected: '',
  };

  /* --------------------------------------------------------------- 结构 */

  const searchInput = h('input.input', {
    type: 'text',
    placeholder: '搜索名称 / id / 格式',
    'aria-label': '搜索内核',
  });
  const statusSelect = h('select.select', { 'aria-label': '状态筛选' });
  const kindSelect = h('select.select', { 'aria-label': '类型筛选' });
  const sortSelect = h('select.select', { 'aria-label': '排序' });

  const rescanBtn = h('button.btn', {
    type: 'button',
    title: '重新扫描内核目录并重新探测依赖',
    on: {
      click: async () => {
        rescanBtn.disabled = true;
        try {
          await ctx.refreshKernels();
        } finally {
          rescanBtn.disabled = false;
        }
      },
    },
  }, h('span', { textContent: '重新扫描' }));

  const openDirBtn = h('button.btn', {
    type: 'button',
    title: '在资源管理器中打开内核仓库目录',
    on: { click: () => ctx.openPathSafe((store.pick('layout') || {}).hubRoot, '内核仓库') },
  }, h('span', { textContent: '打开目录' }));

  const tableHost = h('div');
  const footEl = h('div.footline');

  /**
   * embed：被「插件」页当成一个标签页挂载时，页面自己已经有标题栏了，
   * 这里就不再重复渲染一份 view-head（否则会出现两层标题）。
   */
  const head = ctx && ctx.embed
    ? null
    : h('div.view-head', null,
        h('div.view-crumb', { textContent: 'KernelHub Studio' }),
        h('h1.view-title', { textContent: '内核' }),
        h('div.view-sub', { textContent: '每个内核 = 一份 CKP 清单 + 一个适配器入口；状态与能力全部来自探测结果。' }),
        h('div.view-rule')
      );

  const wrap = h('div.view-inner', { dataset: { view: 'kernels' } },
    head,
    h('div.toolbar', null,
      h('div', { style: { width: '240px' } }, searchInput),
      h('div.selectwrap', { style: { width: '130px' } }, statusSelect),
      h('div.selectwrap', { style: { width: '130px' } }, kindSelect),
      h('div.selectwrap', { style: { width: '150px' } }, sortSelect),
      h('div.toolbar__right', null, rescanBtn, openDirBtn)
    ),
    tableHost,
    footEl
  );
  host.appendChild(wrap);

  /* --------------------------------------------------------- 详情（抽屉） */

  const sheet = createSheet(host, { id: 'kernel-detail', title: '内核详情' });
  const sheetBody = sheet.body;

  /* --------------------------------------------------------------- 筛选 */

  function allKernels() {
    return (store.pick('kernels') || []).filter(Boolean);
  }

  function opLabelOf(kernel, op) {
    const rows = (kernel.descriptions && kernel.descriptions.op) || [];
    const hit = rows.find((row) => row && row.op === op);
    if (hit && hit.label) return hit.label;
    const opsMap = store.pick('opsMap') || {};
    return (opsMap[op] && opsMap[op].label) || String(op || '');
  }

  function matches(kernel) {
    if (vs.status !== 'all' && kernel.status !== vs.status) return false;
    if (vs.kind !== 'all' && String(kernel.kind || '') !== vs.kind) return false;
    const q = vs.query.trim().toLowerCase();
    if (!q) return true;
    const hay = [
      kernel.name, kernel.id, kernel.description,
      (kernel.tags || []).join(' '),
      (kernel.inputFormats || []).join(' '),
      (kernel.outputFormats || []).join(' '),
    ].join(' ').toLowerCase();
    return hay.includes(q);
  }

  function sorted() {
    const list = allKernels().filter(matches);
    const rank = (k) => (k.status === 'ready' ? 0 : k.status === 'degraded' ? 1 : k.status === 'unavailable' ? 2 : k.status === 'disabled' ? 3 : 4);
    switch (vs.sort) {
      case 'name':
        return list.slice().sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), 'zh-CN'));
      case 'priority':
        return list.slice().sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
      case 'capability':
        return list.slice().sort((a, b) => Number(b.capabilityCount || 0) - Number(a.capabilityCount || 0));
      case 'status':
      default:
        return list.slice().sort((a, b) => (rank(a) - rank(b)) || String(a.name || a.id).localeCompare(String(b.name || b.id), 'zh-CN'));
    }
  }

  function renderFilters() {
    const kernels = allKernels();

    const currentStatus = vs.status;
    clear(statusSelect);
    statusSelect.appendChild(h('option', { value: 'all', textContent: '全部状态' }));
    const statusSeen = new Map();
    for (const k of kernels) if (!statusSeen.has(k.status)) statusSeen.set(k.status, k.statusLabel || k.status);
    for (const [value, label] of statusSeen) statusSelect.appendChild(h('option', { value, textContent: label }));
    vs.status = Array.from(statusSelect.options).some((o) => o.value === currentStatus) ? currentStatus : 'all';
    statusSelect.value = vs.status;

    const currentKind = vs.kind;
    clear(kindSelect);
    kindSelect.appendChild(h('option', { value: 'all', textContent: '全部类型' }));
    const kindSeen = new Map();
    for (const k of kernels) if (!kindSeen.has(String(k.kind || ''))) kindSeen.set(String(k.kind || ''), k.kindLabel || k.kind);
    for (const [value, label] of kindSeen) kindSelect.appendChild(h('option', { value, textContent: label }));
    vs.kind = Array.from(kindSelect.options).some((o) => o.value === currentKind) ? currentKind : 'all';
    kindSelect.value = vs.kind;

    if (!sortSelect.childNodes.length) {
      sortSelect.appendChild(h('option', { value: 'status', textContent: '按状态' }));
      sortSelect.appendChild(h('option', { value: 'name', textContent: '按名称' }));
      sortSelect.appendChild(h('option', { value: 'priority', textContent: '按优先级' }));
      sortSelect.appendChild(h('option', { value: 'capability', textContent: '按能力数' }));
      sortSelect.value = vs.sort;
    }
  }

  /* --------------------------------------------------------------- 渲染 */

  function render() {
    renderFilters();
    const rows = sorted();
    const total = allKernels().length;
    const ready = Number(store.pick('kernelsReady') || 0);

    clear(tableHost);

    const errors = store.pick('kernelErrors') || [];
    if (errors.length) {
      tableHost.appendChild(h('div.strip.strip--err', null,
        h('span', { textContent: `扫描过程中有 ${errors.length} 条问题：${errors.slice(0, 2).join('；')}` })
      ));
    }

    if (!rows.length) {
      tableHost.appendChild(h('div.empty', null,
        h('div.empty__title', { textContent: total ? '没有匹配的内核' : '没有发现内核' }),
        h('div.empty__text', {
          textContent: total
            ? '换个关键词或把筛选条件设为「全部」。'
            : '请检查内核仓库目录，或点「重新扫描」。',
        })
      ));
    } else {
      const tbody = h('tbody');
      for (const kernel of rows) {
        // 整行可点：行操作不渲染成 <button>，否则 19 行就是 19 个按钮
        const open = () => openDetail(kernel.id);
        tbody.appendChild(h('tr', {
          tabindex: '0',
          role: 'button',
          'aria-label': `查看内核 ${kernel.name || kernel.id} 的详情`,
          dataset: { kernelId: kernel.id, action: 'kernel-detail' },
          title: `${kernel.description || kernel.name || kernel.id}\n（点击整行查看详情）`,
          on: {
            click: open,
            keydown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                open();
              }
            },
          },
        },
          h('td', { class: 'truncate' },
            h('div.kernel-name', null,
              h('span', { textContent: kernel.name || kernel.id }),
              h('span.kernel-name__id', { textContent: kernel.id })
            )
          ),
          h('td', null, statusBadge(kernel.statusLabel || kernel.status, kernelStateTone(kernel.status))),
          h('td', null,
            h('div.tagflow', null,
              ...(kernel.ops || []).slice(0, 3).map((op) => h('span.tag', { textContent: opLabelOf(kernel, op) }))
            )
          ),
          h('td', { class: 'num mono', textContent: thousands(kernel.capabilityCount || 0) }),
          h('td', { class: 'num mono', textContent: thousands(kernel.paramCount || 0) }),
          h('td', { class: 'mono', textContent: orDash(kernel.version) }),
          h('td', { class: 'num' }, h('span.dim', { 'aria-hidden': 'true', textContent: '›' }))
        ));
      }

      tableHost.appendChild(h('table.table', null,
        h('colgroup', null,
          h('col', { style: { width: '26%' } }),
          h('col', { style: { width: '12%' } }),
          h('col', { style: { width: '22%' } }),
          h('col', { style: { width: '10%' } }),
          h('col', { style: { width: '10%' } }),
          h('col', { style: { width: '12%' } }),
          h('col', { style: { width: '8%' } })
        ),
        h('thead', null, h('tr', null,
          h('th', { textContent: '名称' }),
          h('th', { textContent: '状态' }),
          h('th', { textContent: '操作' }),
          h('th', { class: 'num', textContent: '能力' }),
          h('th', { class: 'num', textContent: '参数' }),
          h('th', { textContent: '版本' }),
          h('th', { class: 'num', textContent: '详情' })
        )),
        tbody
      ));
    }

    clear(footEl);
    footEl.appendChild(h('span', { textContent: `可用 ${ready} / 共 ${total}` }));
    footEl.appendChild(h('span', { textContent: '·' }));
    footEl.appendChild(h('span', { textContent: `当前显示 ${rows.length} 个` }));
    const searchPaths = store.pick('kernelSearchPaths') || [];
    if (searchPaths.length) footEl.appendChild(h('span', { textContent: `· 搜索路径 ${searchPaths.length} 处` }));
  }

  /* --------------------------------------------------------------- 详情 */

  function kvRows(pairs) {
    const box = h('div.kv');
    for (const [key, value] of pairs) {
      box.appendChild(h('div.kv__k', { textContent: key }));
      box.appendChild(h('div.kv__v', { textContent: value }));
    }
    return box;
  }

  function tagsOf(list, limit = 24) {
    const flow = h('div.tagflow');
    const values = Array.isArray(list) ? list : [];
    for (const value of values.slice(0, limit)) flow.appendChild(h('span.tag', { textContent: String(value) }));
    if (values.length > limit) flow.appendChild(h('span.tag', { textContent: `等 ${values.length} 项` }));
    return flow;
  }

/** 详情面板里的次级操作（复制），刻意不是 <button>：不占用每屏按钮预算 */
  function inlineCopyButton(text, label, title) {
    return iconAction({
      classes: ['textbtn'],
      label: title || label || '复制',
      children: [h('span', { textContent: label || '复制' })],
      onClick: async () => {
        const ok = await copyText(text);
        if (ok) ctx.toast.success('已复制', { text: `${String(text || '').length} 个字符` });
        else ctx.toast.warn('复制失败', '当前环境不允许访问剪贴板');
      },
    });
  }

  async function openDetail(id) {
    vs.selected = id;
    sheet.setTitle('内核详情');
    sheet.setSubtitle(id);
    sheet.open();
    clear(sheetBody);
    sheetBody.appendChild(h('div.skeleton', { style: { width: '100%' } }));
    sheetBody.appendChild(h('div.skeleton', { style: { width: '70%', marginTop: 'var(--sp-2)' } }));

    let detail = null;
    try {
      detail = await window.khs.kernels.detail(id);
    } catch (err) {
      detail = { ok: false, message: err && err.message ? err.message : String(err) };
    }
    if (!sheet.isOpen() || vs.selected !== id) return;

    clear(sheetBody);
    if (!detail || detail.ok === false) {
      sheetBody.appendChild(h('div.error-state', null,
        h('div.error-state__msg', { textContent: (detail && detail.message) || '读取内核详情失败' }),
        h('button.linkbtn', { type: 'button', on: { click: () => openDetail(id) } }, h('span', { textContent: '重试' }))
      ));
      return;
    }

    const kernel = detail.kernel || {};

    /* 概览 */
    sheetBody.appendChild(h('div.param-section', null,
      h('div.param-section__title', null, h('span', { textContent: '概览' })),
      kvRows([
        // 显示名是软件层面的叫法；原名与 id 是代码层面的，一并列出便于对照
        ['名称', orDash(kernel.displayName || kernel.name)],
        ['插件原名', orDash(kernel.codeName)],
        ['插件 id', orDash(kernel.id)],
        ['状态', orDash(kernel.statusLabel || kernel.status)],
        ['类型', orDash(kernel.kindLabel || kernel.kind)],
        ['优先级', String(orDash(kernel.priority))],
        ['许可证', orDash(kernel.license)],
        ['目录', orDash(kernel.directory)],
        ['入口', orDash(kernel.entryPath)],
        ['清单', orDash(kernel.manifestPath)],
      ]),
      kernel.description ? h('div.field__hint', { textContent: kernel.description }) : null
    ));

    /* 启停与优先级 */
    const enableCheck = h('input.check', { type: 'checkbox', checked: kernel.status !== 'disabled' });
    enableCheck.addEventListener('change', async () => {
      const want = enableCheck.checked;
      enableCheck.disabled = true;
      try {
        await window.khs.kernels.setEnabled(kernel.id, want);
        await ctx.refreshKernels();
        ctx.toast.success(want ? '内核已启用' : '内核已停用', { text: kernel.name || kernel.id });
        openDetail(kernel.id);
      } catch (err) {
        enableCheck.checked = !want;
        ctx.reportError('切换内核启停失败', ctx.wrapError(err));
      } finally {
        enableCheck.disabled = false;
      }
    });

    const priorityInput = h('input.input.input--num', { type: 'number', value: String(Number(kernel.priority) || 0) });
    priorityInput.addEventListener('change', async () => {
      const value = Number(priorityInput.value);
      if (!Number.isFinite(value)) {
        priorityInput.value = String(Number(kernel.priority) || 0);
        return;
      }
      try {
        await window.khs.kernels.setPriority(kernel.id, value);
        await ctx.refreshKernels();
        ctx.toast.success('优先级已更新', { text: `${kernel.name || kernel.id} → ${value}` });
      } catch (err) {
        ctx.reportError('更新优先级失败', ctx.wrapError(err));
      }
    });

    sheetBody.appendChild(h('div.param-section', null,
      h('div.param-section__title', null, h('span', { textContent: '调度' })),
      h('div.row.gap-5', null,
        h('label.check-row', null, enableCheck, h('span', { textContent: '启用该内核' })),
        h('div.field', null,
          h('label.label', { textContent: '优先级（越大越优先）' }),
          priorityInput
        )
      )
    ));

    /* 能力矩阵 */
    const caps = Array.isArray(kernel.capabilityMatrix) && kernel.capabilityMatrix.length
      ? kernel.capabilityMatrix
      : (kernel.capabilities || []);
    const capBody = h('tbody');
    for (const cap of caps.slice(0, 200)) {
      capBody.appendChild(h('tr', null,
        h('td', { class: 'truncate', textContent: cap.label || cap.id || '' }),
        h('td', null, tagsOf(cap.from, 12)),
        h('td', null, tagsOf(cap.to, 12)),
        h('td', { class: 'num mono', textContent: `${orDash(cap.quality)} / ${orDash(cap.output_mode)}` })
      ));
    }
    sheetBody.appendChild(h('div.param-section', null,
      h('div.param-section__title', null,
        h('span', { textContent: '能力矩阵' }),
        h('span.badge.badge--mono', { textContent: `${caps.length} 条` })
      ),
      caps.length
        ? h('table.table.caps-table', null,
          h('colgroup', null,
            h('col', { style: { width: '26%' } }),
            h('col', { style: { width: '30%' } }),
            h('col', { style: { width: '30%' } }),
            h('col', { style: { width: '14%' } })
          ),
          h('thead', null, h('tr', null,
            h('th', { textContent: '能力' }),
            h('th', { textContent: '输入格式' }),
            h('th', { textContent: '输出格式' }),
            h('th', { class: 'num', textContent: '质量/模式' })
          )),
          capBody
        )
        : h('div.field__hint', { textContent: '该内核没有声明能力。' })
    ));

    /* 参数表 */
    const params = Array.isArray(kernel.params) ? kernel.params : [];
    const paramBody = h('tbody');
    for (const param of params) {
      paramBody.appendChild(h('tr', null,
        h('td', { class: 'truncate', textContent: orDash(param.id) }),
        h('td', { class: 'mono', textContent: orDash(param.type) }),
        h('td', { class: 'mono truncate', textContent: param.default === undefined || param.default === null ? '—' : String(param.default) }),
        h('td', { textContent: orDash(param.description || param.label) })
      ));
    }
    sheetBody.appendChild(h('div.param-section', null,
      h('div.param-section__title', null,
        h('span', { textContent: '参数表' }),
        h('span.badge.badge--mono', { textContent: `${params.length} 项` })
      ),
      params.length
        ? h('table.table.params-table', null,
          h('colgroup', null,
            h('col', { style: { width: '22%' } }),
            h('col', { style: { width: '12%' } }),
            h('col', { style: { width: '18%' } }),
            h('col', { style: { width: '48%' } })
          ),
          h('thead', null, h('tr', null,
            h('th', { textContent: 'id' }),
            h('th', { textContent: '类型' }),
            h('th', { textContent: '默认值' }),
            h('th', { textContent: '说明' })
          )),
          paramBody
        )
        : h('div.field__hint', { textContent: '该内核没有声明参数。' })
    ));

    /* 引擎与依赖 */
    const executables = kernel.executableSpec && typeof kernel.executableSpec === 'object'
      ? Object.entries(kernel.executableSpec)
      : [];
    sheetBody.appendChild(h('div.param-section', null,
      h('div.param-section__title', null, h('span', { textContent: '引擎与依赖' })),
      kvRows([
        ['运行时', orDash(kernel.runtimeType || (kernel.engine && kernel.engine.type))],
        ['入口', orDash(kernel.engine && kernel.engine.entry)],
        ['引擎备注', orDash(kernel.engineNote || (kernel.engine && kernel.engine.note))],
        ['依赖声明', joinLimited(kernel.requires, 8, '、')],
        ['可执行解析', executables.length ? executables.map(([k, v]) => `${k}：${v}`).join('；') : '—'],
        ['探测方式', kernel.probe ? `${orDash(kernel.probe.type)} → ${orDash(kernel.probe.target)}` : '—'],
      ]),
      executableHint(kernel, executables),
      kernel.installHint
        ? h('div', null,
          h('div.codeblock.codeblock--wrap', null,
            h('div.codeblock__bar', null,
              h('span', { textContent: '安装命令' }),
              inlineCopyButton(kernel.installHint, '复制')
            ),
            h('pre', { textContent: String(kernel.installHint) })
          )
        )
        : null
    ));

    /* 原始 kernel.json（折叠） */
    const raw = prettyJson(kernel.manifest, '');
    const rawFold = h('div.fold', { dataset: { open: 'false' } },
      h('div.fold__head', null, h('span', { textContent: '原始 kernel.json' })),
      h('div.fold__body', null,
        h('div.codeblock.codeblock--wrap', null,
          h('div.codeblock__bar', null,
            h('span', { textContent: `${raw.length} 字符` }),
            inlineCopyButton(raw, '复制')
          ),
          h('pre', { textContent: raw })
        )
      )
    );
    rawFold.querySelector('.fold__head').addEventListener('click', () => {
      rawFold.dataset.open = rawFold.dataset.open === 'true' ? 'false' : 'true';
    });
    sheetBody.appendChild(rawFold);
  }

  /** 一个内核如果有「可执行文件解析来源」但探测失败，给出可操作提示 */
  function executableHint(kernel, executables) {
    if (!executables.length) return null;
    if (kernel.status === 'ready') return null;
    return h('div.strip.strip--warn', null,
      h('span', { textContent: `该内核的状态是「${orDash(kernel.statusLabel || kernel.status)}」，请按上面的安装命令补齐依赖后重新扫描。` })
    );
  }

  /* --------------------------------------------------------------- 事件 */

  disposers.push(on(searchInput, 'input', () => {
    vs.query = searchInput.value;
    render();
  }));
  disposers.push(on(statusSelect, 'change', () => {
    vs.status = statusSelect.value;
    render();
  }));
  disposers.push(on(kindSelect, 'change', () => {
    vs.kind = kindSelect.value;
    render();
  }));
  disposers.push(on(sortSelect, 'change', () => {
    vs.sort = sortSelect.value;
    render();
  }));

  let lastSignature = '';
  disposers.push(store.subscribe(() => {
    const sig = (store.pick('kernels') || []).map((k) => `${k.id}:${k.status}:${k.priority}`).join(',');
    if (sig === lastSignature) return;
    lastSignature = sig;
    render();
  }));

  disposers.push(ctx.registerAction('focus-kernel', (id) => {
    const value = String(id || '');
    if (!value) return;
    vs.query = '';
    searchInput.value = '';
    vs.status = 'all';
    vs.kind = 'all';
    render();
    const row = tableHost.querySelector(`tr[data-kernel-id="${value}"]`);
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center' });
    openDetail(value);
  }));

  lastSignature = (store.pick('kernels') || []).map((k) => `${k.id}:${k.status}:${k.priority}`).join(',');
  render();

  return {
    unmount() {
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
