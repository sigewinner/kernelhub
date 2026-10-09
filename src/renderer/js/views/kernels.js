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
import { t, statusText, kindText, opText } from '../i18n.js';
import { depsFailureDetail } from '../depsReason.js';

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
    placeholder: t('搜索名称 / id / 格式'),
    'aria-label': t('搜索内核'),
  });
  const statusSelect = h('select.select', { 'aria-label': t('状态筛选') });
  const kindSelect = h('select.select', { 'aria-label': t('类型筛选') });
  const sortSelect = h('select.select', { 'aria-label': t('排序') });

  const rescanBtn = h('button.btn', {
    type: 'button',
    title: t('重新扫描内核目录并重新探测依赖'),
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
  }, h('span', { textContent: t('重新扫描') }));

  const openDirBtn = h('button.btn', {
    type: 'button',
    title: t('在资源管理器中打开内核仓库目录'),
    on: { click: () => ctx.openPathSafe((store.pick('layout') || {}).hubRoot, '内核仓库') },
  }, h('span', { textContent: t('打开目录') }));

  const tableHost = h('div');

  /**
   * embed：被「插件」页当成一个标签页挂载时，页面自己已经有标题栏了，
   * 这里就不再重复渲染一份 view-head（否则会出现两层标题）。
   */
  const head = ctx && ctx.embed
    ? null
    : h('div.view-head', null,
        h('h1.view-title', { textContent: t('内核') }),
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
    tableHost
  );
  host.appendChild(wrap);

  /* --------------------------------------------------------- 详情（抽屉） */

  const sheet = createSheet(host, { id: 'kernel-detail', title: t('内核详情') });
  const sheetBody = sheet.body;

  /* --------------------------------------------------------------- 筛选 */

  function allKernels() {
    return (store.pick('kernels') || []).filter(Boolean);
  }

  /** 操作名：优先用内核自己声明的标签，否则退回操作目录里的标签；英文模式按 op id 取英文 */
  function opLabelOf(kernel, op) {
    const rows = (kernel.descriptions && kernel.descriptions.op) || [];
    const hit = rows.find((row) => row && row.op === op);
    if (hit && hit.label) return opText(op, hit.label);
    const opsMap = store.pick('opsMap') || {};
    return opText(op, (opsMap[op] && opsMap[op].label) || String(op || ''));
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
    statusSelect.appendChild(h('option', { value: 'all', textContent: t('全部状态') }));
    const statusSeen = new Map();
    // 筛选下拉的选项来自**数据里的状态/类型**，所以要按 id 取显示名（英文模式下是英文）
    for (const k of kernels) if (!statusSeen.has(k.status)) statusSeen.set(k.status, statusText(k.status, k.statusLabel));
    for (const [value, label] of statusSeen) statusSelect.appendChild(h('option', { value, textContent: label }));
    vs.status = Array.from(statusSelect.options).some((o) => o.value === currentStatus) ? currentStatus : 'all';
    statusSelect.value = vs.status;

    const currentKind = vs.kind;
    clear(kindSelect);
    kindSelect.appendChild(h('option', { value: 'all', textContent: t('全部类型') }));
    const kindSeen = new Map();
    for (const k of kernels) if (!kindSeen.has(String(k.kind || ''))) kindSeen.set(String(k.kind || ''), kindText(k.kind, k.kindLabel));
    for (const [value, label] of kindSeen) kindSelect.appendChild(h('option', { value, textContent: label }));
    vs.kind = Array.from(kindSelect.options).some((o) => o.value === currentKind) ? currentKind : 'all';
    kindSelect.value = vs.kind;

    if (!sortSelect.childNodes.length) {
      sortSelect.appendChild(h('option', { value: 'status', textContent: t('按状态') }));
      sortSelect.appendChild(h('option', { value: 'name', textContent: t('按名称') }));
      sortSelect.appendChild(h('option', { value: 'priority', textContent: t('按优先级') }));
      sortSelect.appendChild(h('option', { value: 'capability', textContent: t('按能力数') }));
      sortSelect.value = vs.sort;
    }
  }

  /* --------------------------------------------------------------- 渲染 */

  /** 当前筛选后实际显示的行数（render 更新，publishStatus 用） */
  let listedCount = 0;

  /**
   * 把实时信息推到状态栏右下角（2.0.4 起不再各视图自己放一行 .footline）。
   * 单独抽出来是因为它有两个调用点：render() 之后，以及被「插件」页切回本标签时。
   */
  function publishStatus() {
    const total = allKernels().length;
    const ready = Number(store.pick('kernelsReady') || 0);
    const searchPaths = store.pick('kernelSearchPaths') || [];
    ctx.setStatusInfo([
      t('可用 {0} / 共 {1}', { 0: ready, 1: total }),
      t('当前显示 {0} 个', { 0: listedCount }),
      searchPaths.length ? t('搜索路径 {0} 处', { 0: searchPaths.length }) : null,
    ]);
  }

  function render() {
    renderFilters();
    const rows = sorted();
    const total = allKernels().length;
    listedCount = rows.length;

    clear(tableHost);

    const errors = store.pick('kernelErrors') || [];
    if (errors.length) {
      tableHost.appendChild(h('div.strip.strip--err', null,
        h('span', { textContent: t('扫描过程中有 {0} 条问题：{1}', { 0: errors.length, 1: errors.slice(0, 2).join('；') }) })
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
          'aria-label': t('查看内核 {0} 的详情', { 0: kernel.name || kernel.id }),
          dataset: { kernelId: kernel.id, action: 'kernel-detail' },
          title: t('{0}\\n（点击整行查看详情）', { 0: kernel.description || kernel.name || kernel.id }),
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
          h('td', null, statusBadge(statusText(kernel.status, kernel.statusLabel), kernelStateTone(kernel.status))),
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

      tableHost.appendChild(h('table.table.table--center', null,
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
          h('th', { textContent: t('名称') }),
          h('th', { textContent: t('状态') }),
          h('th', { textContent: t('操作') }),
          h('th', { class: 'num', textContent: t('能力') }),
          h('th', { class: 'num', textContent: t('参数') }),
          h('th', { textContent: t('版本') }),
          h('th', { class: 'num', textContent: t('详情') })
        )),
        tbody
      ));
    }

    publishStatus();
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
    if (values.length > limit) flow.appendChild(h('span.tag', { textContent: t('等 {0} 项', { 0: values.length }) }));
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
        if (ok) ctx.toast.success(t('已复制'), { text: t('{0} 个字符', { 0: String(text || '').length }) });
        else ctx.toast.warn(t('复制失败'), '当前环境不允许访问剪贴板');
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
        h('button.linkbtn', { type: 'button', on: { click: () => openDetail(id) } }, h('span', { textContent: t('重试') }))
      ));
      return;
    }

    const kernel = detail.kernel || {};

    /* 概览 */
    sheetBody.appendChild(h('div.param-section', null,
      h('div.param-section__title', null, h('span', { textContent: t('概览') })),
      kvRows([
        // 显示名是软件层面的叫法；原名与 id 是代码层面的，一并列出便于对照
        ['名称', orDash(kernel.displayName || kernel.name)],
        ['插件原名', orDash(kernel.codeName)],
        ['插件 id', orDash(kernel.id)],
        ['状态', orDash(statusText(kernel.status, kernel.statusLabel))],
        ['类型', orDash(kindText(kernel.kind, kernel.kindLabel))],
        ['优先级', String(orDash(kernel.priority))],
        ['许可证', orDash(kernel.license)],
        ['目录', orDash(kernel.directory)],
        ['入口', orDash(kernel.entryPath)],
        ['清单', orDash(kernel.manifestPath)],
      ]),
      kernel.description ? h('div.note-line.dim', { textContent: kernel.description }) : null
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
        ctx.reportError(t('切换内核启停失败'), ctx.wrapError(err));
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
        ctx.toast.success(t('优先级已更新'), { text: `${kernel.name || kernel.id} → ${value}` });
      } catch (err) {
        ctx.reportError(t('更新优先级失败'), ctx.wrapError(err));
      }
    });

    sheetBody.appendChild(h('div.param-section', null,
      h('div.param-section__title', null, h('span', { textContent: t('调度') })),
      h('div.row.gap-5', null,
        h('label.check-row', null, enableCheck, h('span', { textContent: t('启用该内核') })),
        h('div.field', null,
          h('label.label', { textContent: t('优先级（越大越优先）') }),
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
        h('td', { class: 'truncate', textContent: opText(cap.op, cap.label) || cap.id || '' }),
        h('td', null, tagsOf(cap.from, 12)),
        h('td', null, tagsOf(cap.to, 12)),
        h('td', { class: 'num mono', textContent: `${orDash(cap.quality)} / ${orDash(cap.output_mode)}` })
      ));
    }
    sheetBody.appendChild(h('div.param-section', null,
      h('div.param-section__title', null,
        h('span', { textContent: t('能力矩阵') }),
        h('span.badge.badge--mono', { textContent: t('{0} 条', { 0: caps.length }) })
      ),
      caps.length
        ? h('table.table.table--center.caps-table', null,
          h('colgroup', null,
            h('col', { style: { width: '26%' } }),
            h('col', { style: { width: '30%' } }),
            h('col', { style: { width: '30%' } }),
            h('col', { style: { width: '14%' } })
          ),
          h('thead', null, h('tr', null,
            h('th', { textContent: t('能力') }),
            h('th', { textContent: t('输入格式') }),
            h('th', { textContent: t('输出格式') }),
            h('th', { class: 'num', textContent: t('质量/模式') })
          )),
          capBody
        )
        : h('div.note-line.dim', { textContent: t('该内核没有声明能力。') })
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
        h('span', { textContent: t('参数表') }),
        h('span.badge.badge--mono', { textContent: t('{0} 项', { 0: params.length }) })
      ),
      params.length
        ? h('table.table.table--center.params-table', null,
          h('colgroup', null,
            h('col', { style: { width: '22%' } }),
            h('col', { style: { width: '12%' } }),
            h('col', { style: { width: '18%' } }),
            h('col', { style: { width: '48%' } })
          ),
          h('thead', null, h('tr', null,
            h('th', { textContent: 'id' }),
            h('th', { textContent: t('类型') }),
            h('th', { textContent: t('默认值') }),
            h('th', { textContent: t('说明') })
          )),
          paramBody
        )
        : h('div.note-line.dim', { textContent: t('该内核没有声明参数。') })
    ));

    /* 引擎与依赖 */
    const executables = kernel.executableSpec && typeof kernel.executableSpec === 'object'
      ? Object.entries(kernel.executableSpec)
      : [];
    sheetBody.appendChild(h('div.param-section', null,
      h('div.param-section__title', null, h('span', { textContent: t('引擎与依赖') })),
      kvRows([
        ['运行时', orDash(kernel.runtimeType || (kernel.engine && kernel.engine.type))],
        ['入口', orDash(kernel.engine && kernel.engine.entry)],
        ['引擎备注', orDash(kernel.engineNote || (kernel.engine && kernel.engine.note))],
        ['依赖声明', joinLimited(kernel.requires, 8, '、')],
        ['可执行解析', executables.length ? executables.map(([k, v]) => `${k}：${v}`).join('；') : '—'],
        ['探测方式', kernel.probe ? `${orDash(kernel.probe.type)} → ${orDash(kernel.probe.target)}` : '—'],
      ]),
      executableHint(kernel, executables),
      depsFix(kernel),
      externalFix(kernel),
      kernel.installHint
        ? h('div', null,
          h('div.codeblock.codeblock--wrap', null,
            h('div.codeblock__bar', null,
              h('span', { textContent: t('安装命令') }),
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
      h('div.fold__head', null, h('span', { textContent: t('原始 kernel.json') })),
      h('div.fold__body', null,
        h('div.codeblock.codeblock--wrap', null,
          h('div.codeblock__bar', null,
            h('span', { textContent: t('{0} 字符', { 0: raw.length }) }),
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
      h('span', {
        textContent: t('该内核的状态是「{0}」。缺 Python 模块点上面的「自动安装依赖」即可；外部程序需要自己装好后重新扫描。', {
          0: orDash(kernel.statusLabel || kernel.status),
        }),
      })
    );
  }

  /**
   * 缺 Python 模块时给一个按钮（2.3.0）。
   *
   * 以前这里只有一句「请按上面的安装命令补齐依赖后重新扫描」——
   * 等于把用户赶去终端自己 pip install。现在直接调 plugins.installDeps：
   * 装进该插件自己的 vendor 目录，设置的镜像不通会自动回退官方源，
   * 装完自动重新探测，用户只需要点一下。
   */
  function depsFix(kernel) {
    const requires = Array.isArray(kernel.requires) ? kernel.requires.filter(Boolean) : [];
    if (!requires.length || kernel.status === 'ready') return null;

    const label = h('span', { textContent: t('自动安装依赖') });
    const btn = h('button.btn.btn--primary', { type: 'button' }, label);
    const strip = h('div.strip.strip--warn', null,
      h('span', { textContent: t('缺少 Python 模块：{0}', { 0: requires.join('、') }) }),
      btn,
      h('span.dim', { style: { fontSize: '12px' }, textContent: t('装进插件自己的目录，卸载时一并删除') })
    );

    let busy = false;
    const idle = () => {
      busy = false;
      btn.disabled = false;
      label.textContent = t('自动安装依赖');
    };
    btn.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      btn.disabled = true;
      label.textContent = t('正在安装依赖…');
      try {
        const res = await window.khs.plugins.installDeps({ id: kernel.id });
        if (!res || !res.ok) {
          ctx.toast.error(t('依赖安装失败'), depsFailureDetail(res));
          idle();
          return;
        }
        /*
         * 2.3.3：Python 依赖齐了不等于能用 —— 还可能缺外部程序。
         * 以前这里无条件说「依赖已齐全」，于是和内核那句「找不到可执行文件 'gs'」
         * 自相矛盾（用户看到的就是「说齐全却用不了」）。
         */
        const missingExes = Array.isArray(res.externalMissing) ? res.externalMissing : [];
        if (res.alreadyOk && missingExes.length) {
          ctx.toast.success(t('Python 依赖已齐全'), {
            text: t('但还缺外部程序：{0}', { 0: missingExes.map((x) => x.label || x.name).join('、') }),
          });
        } else {
          ctx.toast.success(res.alreadyOk ? '依赖已齐全' : '依赖安装完成', {
            text: res.indexUsed ? t('来源 {0}', { 0: res.indexUsed }) : kernel.id,
          });
        }
        await ctx.refreshKernels({ announce: false });
        openDetail(kernel.id);   // 重新探测之后把详情刷新一遍
      } catch (err) {
        ctx.reportError(t('依赖安装异常'), ctx.wrapError(err));
        idle();
      }
    });
    return strip;
  }

  /* ------------------------------------------------- 外部程序（2.3.2） */

  /** 这些工具 pip 装不了，只能去官网下；给个直达链接省得用户自己搜 */
  const EXE_HOME = {
    gs: 'https://www.ghostscript.com/releases/gsdnld.html',
    gswin64c: 'https://www.ghostscript.com/releases/gsdnld.html',
    gswin32c: 'https://www.ghostscript.com/releases/gsdnld.html',
    magick: 'https://imagemagick.org/script/download.php#windows',
    convert: 'https://imagemagick.org/script/download.php#windows',
    ffmpeg: 'https://ffmpeg.org/download.html',
    soffice: 'https://www.libreoffice.org/download/download-libreoffice/',
    pandoc: 'https://pandoc.org/installing.html',
  };

  /**
   * 内核起不来是因为缺**外部程序**时，给三件事：
   *   1. 选择可执行文件…（写进设置，探测与执行都优先用它）
   *   2. 打开下载页（pip 装不了，只能去官网）
   *   3. 不需要外部程序的替代内核（一键安装，含依赖）
   *
   * 第 3 条是实测出来的最省事路径：ghostscript-pdf 要求系统装 Ghostscript
   * （不在 PATH 里、可能还要管理员权限），而 pymupdf-pdf 只要 pip 一个包 ——
   * 而 pip 依赖我们本来就能一键装。
   */
  function externalFix(kernel) {
    const spec = kernel.executables && typeof kernel.executables === 'object' ? kernel.executables : null;
    if (!spec) return null;
    const names = Object.keys(spec).filter(Boolean);
    if (!names.length || kernel.status === 'ready') return null;

    const first = names[0];
    const pick = h('button.btn.btn--sm', { type: 'button' }, h('span', { textContent: t('选择可执行文件…') }));
    /**
     * 2.3.3：能自动装就直接给一个按钮。
     * Ghostscript 走官方安装包静默安装（会弹一次管理员确认），Pandoc 走官方免安装 zip
     * （完全不需要权限）—— 都在主进程里按配方执行。
     */
    const autoLabel = h('span', { textContent: t('自动安装（官方，需一次确认）') });
    const auto = h('button.btn.btn--sm.btn--primary', { type: 'button' }, autoLabel);
    const autoNote = h('span.dim', { style: { fontSize: '12px' }, textContent: '' });
    const home = EXE_HOME[String(first).toLowerCase()] || '';
    const openHome = home
      ? h('button.btn.btn--sm', {
        type: 'button',
        on: { click: () => window.khs.fs.openExternal(home) },
      }, h('span', { textContent: t('打开下载页') }))
      : null;

    const altHost = h('div', { style: { marginTop: '10px' } });
    const box = h('div.strip.strip--warn', null,
      h('span', { textContent: t('需要外部程序：{0}（pip 装不了）', { 0: names.join('、') }) }),
      auto,
      pick,
      openHome
    );
    box.appendChild(autoNote);
    box.appendChild(altHost);

    // 自动安装：进度经 evt:exe:progress 回到这一行文字上
    const offExeProgress = window.khs.on('evt:exe:progress', (payload) => {
      if (!payload || !names.includes(payload.name)) return;
      if (payload.message) autoNote.textContent = payload.message;
    });
    disposers.push(offExeProgress);

    auto.addEventListener('click', async () => {
      auto.disabled = true;
      pick.disabled = true;
      autoLabel.textContent = t('正在安装…');
      autoNote.textContent = t('正在准备…');
      try {
        const res = await window.khs.kernels.installExe({ name: first, id: kernel.id });
        if (!res || !res.ok) {
          const msg = (res && res.error) || '安装失败';
          autoNote.textContent = msg;
          ctx.toast.error(t('自动安装失败'), msg);
          autoLabel.textContent = t('自动安装（官方，需一次确认）');
          auto.disabled = false;
          pick.disabled = false;
          return;
        }
        ctx.toast.success(t('{0} 已安装', { 0: first }), { text: res.path });
        await ctx.refreshKernels({ announce: false });
        openDetail(kernel.id);
      } catch (err) {
        ctx.reportError(t('自动安装异常'), ctx.wrapError(err));
        autoLabel.textContent = t('自动安装（官方，需一次确认）');
        auto.disabled = false;
        pick.disabled = false;
      }
    });

    pick.addEventListener('click', async () => {
      pick.disabled = true;
      try {
        const res = await window.khs.kernels.pickExe({ name: first, id: kernel.id });
        if (!res || res.canceled) {
          pick.disabled = false;
          return;
        }
        if (!res.ok) {
          ctx.reportError(t('设置可执行文件失败'), ctx.wrapError(new Error(res.error || '未知错误')));
          pick.disabled = false;
          return;
        }
        ctx.toast.success(t('已指定 {0}', { 0: first }), { text: res.path });
        await ctx.refreshKernels({ announce: false });
        openDetail(kernel.id);
      } catch (err) {
        ctx.reportError(t('设置可执行文件失败'), ctx.wrapError(err));
        pick.disabled = false;
      }
    });

    // 替代内核：目录里同样能干这件事、但不需要外部程序的插件
    (async () => {
      let data = null;
      try {
        data = await window.khs.kernels.alternatives({ id: kernel.id, limit: 3 });
      } catch {
        return;
      }
      const list = (data && data.alternatives) || [];
      if (!list.length) return;
      altHost.appendChild(h('div.param-section__title', null, h('span', { textContent: t('不需要外部程序的替代内核') })));
      for (const alt of list) {
        const label = h('span', {
          textContent: alt.installed
            ? t('使用它（已安装）')
            : t('安装 {0}（含依赖）', { 0: alt.displayName || alt.id }),
        });
        const btn = h('button.btn.btn--sm', { type: 'button' }, label);
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          const setLabel = (text) => {
            label.textContent = text;
          };
          try {
            if (!alt.installed) {
              setLabel(t('正在安装插件…'));
              const res = await window.khs.plugins.install(alt.id);
              if (!res || !res.ok) throw new Error((res && res.error) || '插件安装失败');
            }
            // 依赖：缺什么装什么（镜像不通会自动回退官方源）
            setLabel(t('正在安装依赖…'));
            const probe = await window.khs.plugins.deps(alt.id);
            if (probe && probe.ok && (probe.missing || []).length) {
              const dep = await window.khs.plugins.installDeps({ id: alt.id });
              if (!dep || !dep.ok) throw new Error((dep && dep.error) || '依赖安装失败');
            }
            ctx.toast.success(t('{0} 已就绪', { 0: alt.displayName || alt.id }), {
              text: t('回「转换」页即可用它，不再需要外部程序'),
            });
            await ctx.refreshKernels({ announce: false });
            openDetail(kernel.id);
          } catch (err) {
            ctx.reportError(t('安装失败'), ctx.wrapError(err));
            setLabel(t('重试'));
            btn.disabled = false;
          }
        });
        altHost.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '6px' } },
          h('span', { textContent: `${alt.displayName || alt.id}（${(alt.ops || []).join(' / ')}）` }),
          btn
        ));
      }
    })();

    return box;
  }

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
    /** 重新把实时信息推给状态栏：被「插件」页切回本标签时调用，避免显示上一个标签的数字 */
    publishStatus,
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
