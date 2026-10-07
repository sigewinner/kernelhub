/**
 * views/formats.js —— 格式
 *
 * 版面（docs/ui-spec-swiss.md 4.4）：**0 个按钮**
 *   工具栏：操作 ▾ + 视图 ▾（格式表 / 操作表）+ 搜索输入框
 *   内容 A（格式表）：格式 / 可作输入的操作 / 可作输出的操作 / 内核数
 *   内容 B（操作表）：操作 / 输入格式数 / 输出格式数 / 内核数
 *   点某一行选中（左侧 2px 红条），下方面板显示可达目标格式（纯文本标签流，不是按钮）
 *
 * 数据全部来自 window.khs.kernels.formats() / kernels.ops()，界面不预设任何格式名。
 * 另外会把格式矩阵广播给命令面板（khs:formats-cache），避免重复 IPC。
 */

import { h, clear, on } from '../dom.js';
import { formatLabel, thousands } from '../format.js';

export async function mount(host, ctx) {
  const { store } = ctx;
  const disposers = [];

  const vs = {
    view: 'formats', // formats | ops
    op: 'all',
    query: '',
    formats: [],
    ops: [],
    selected: '', // 格式名或 op id
    loading: true,
    error: null,
  };

  /* --------------------------------------------------------------- 结构 */

  const viewSelect = h('select.select', { 'aria-label': '视图' });
  viewSelect.appendChild(h('option', { value: 'formats', textContent: '格式表' }));
  viewSelect.appendChild(h('option', { value: 'ops', textContent: '操作表' }));

  const opSelect = h('select.select', { 'aria-label': '操作筛选' });
  opSelect.appendChild(h('option', { value: 'all', textContent: '全部操作' }));

  const searchInput = h('input.input', {
    type: 'text',
    placeholder: '搜索格式或操作',
    'aria-label': '搜索格式或操作',
  });

  const tableHost = h('div.tablewrap');
  const detailHost = h('div.matrix-detail');

  const wrap = h('div.view-inner', { dataset: { view: 'formats' } },
    h('div.view-head', null,
      h('div.view-crumb', { textContent: 'KernelHub Studio' }),
      h('h1.view-title', { textContent: '格式' }),
      h('div.view-sub', { textContent: '格式 × 操作 的可达关系，全部由内核清单的能力矩阵推出。' }),
      h('div.view-rule')
    ),
    h('div.toolbar', null,
      h('div.selectwrap', { style: { width: '160px' } }, opSelect),
      h('div.selectwrap', { style: { width: '140px' } }, viewSelect),
      h('div', { style: { width: '240px' } }, searchInput)
    ),
    tableHost,
    detailHost
  );
  host.appendChild(wrap);

  /* --------------------------------------------------------------- 数据 */

  async function load() {
    vs.loading = true;
    vs.error = null;
    render();
    try {
      const [formats, ops] = await Promise.all([
        window.khs.kernels.formats(),
        window.khs.kernels.ops(),
      ]);
      vs.formats = Array.isArray(formats) ? formats : [];
      vs.ops = Array.isArray(ops) ? ops : [];
      vs.loading = false;
      // 命令面板的格式直达数据源（app.js 监听这个事件）
      window.dispatchEvent(new CustomEvent('khs:formats-cache', { detail: { formats: vs.formats } }));
      renderOpSelect();
      render();
    } catch (err) {
      vs.loading = false;
      vs.error = ctx.wrapError(err, '读取格式矩阵失败');
      render();
    }
  }

  function renderOpSelect() {
    const current = vs.op;
    clear(opSelect);
    opSelect.appendChild(h('option', { value: 'all', textContent: '全部操作' }));
    for (const row of vs.ops) {
      if (!row || !row.op) continue;
      opSelect.appendChild(h('option', {
        value: row.op,
        textContent: `${row.label || row.op}（${row.kernelCount || 0}）`,
      }));
    }
    const exists = Array.from(opSelect.options).some((o) => o.value === current);
    vs.op = exists ? current : 'all';
    opSelect.value = vs.op;
  }

  function opLabel(op) {
    const hit = vs.ops.find((row) => row && row.op === op);
    return hit && hit.label ? hit.label : String(op || '');
  }

  /* --------------------------------------------------------------- 过滤 */

  function matchText(query, values) {
    if (!query) return true;
    const q = query.toLowerCase();
    return values.some((v) => String(v || '').toLowerCase().includes(q));
  }

  function visibleFormats() {
    return vs.formats.filter((row) => {
      if (!row || !row.format) return false;
      if (vs.op !== 'all' && !row.asInput.includes(vs.op) && !row.asOutput.includes(vs.op)) return false;
      return matchText(vs.query, [row.format]);
    });
  }

  function visibleOps() {
    return vs.ops.filter((row) => {
      if (!row || !row.op) return false;
      if (vs.op !== 'all' && row.op !== vs.op) return false;
      return matchText(vs.query, [row.op, row.label]);
    });
  }

  /* --------------------------------------------------------------- 渲染 */

  function render() {
    clear(tableHost);
    clear(detailHost);

    if (vs.error) {
      tableHost.appendChild(h('div.error-state', null,
        h('div.error-state__msg', { textContent: vs.error.message || String(vs.error) }),
        h('button.linkbtn', { type: 'button', on: { click: () => load() } }, h('span', { textContent: '重试' }))
      ));
      return;
    }
    if (vs.loading) {
      tableHost.appendChild(h('div', null,
        h('div.skeleton', { style: { width: '100%' } }),
        h('div.skeleton', { style: { width: '100%', marginTop: 'var(--sp-2)' } }),
        h('div.skeleton', { style: { width: '60%', marginTop: 'var(--sp-2)' } })
      ));
      return;
    }

    if (vs.view === 'formats') renderFormatsTable();
    else renderOpsTable();

    renderDetail();
  }

  /** 表格行：整行可点（tr 而非 button —— 本屏按钮数为 0） */
  function makeRow(key, cells, onPick) {
    const tr = h('tr', {
      tabindex: '0',
      role: 'button',
      'aria-selected': key === vs.selected ? 'true' : 'false',
      on: {
        click: () => onPick(),
        keydown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onPick();
          }
        },
      },
    }, ...cells);
    return tr;
  }

  function renderFormatsTable() {
    const rows = visibleFormats();
    if (!rows.length) {
      tableHost.appendChild(h('div.empty', null,
        h('div.empty__title', { textContent: '没有匹配的格式' }),
        h('div.empty__text', { textContent: '换个操作或关键词再试。' })
      ));
      return;
    }
    const tbody = h('tbody');
    for (const row of rows) {
      tbody.appendChild(makeRow(row.format, [
        h('td', null, h('span.mono', { textContent: formatLabel(row.format) })),
        h('td', null, h('span.matrix-cell', { textContent: row.asInput.map(opLabel).join('、') || '—' })),
        h('td', null, h('span.matrix-cell', { textContent: row.asOutput.map(opLabel).join('、') || '—' })),
        h('td', { class: 'num mono', textContent: thousands(row.kernelCount || 0) }),
      ], () => {
        vs.selected = vs.selected === row.format ? '' : row.format;
        render();
      }));
    }
    tableHost.appendChild(h('table.table', null,
      h('colgroup', null,
        h('col', { style: { width: '14%' } }),
        h('col', { style: { width: '36%' } }),
        h('col', { style: { width: '36%' } }),
        h('col', { style: { width: '14%' } })
      ),
      h('thead', null, h('tr', null,
        h('th', { textContent: '格式' }),
        h('th', { textContent: '可作输入的操作' }),
        h('th', { textContent: '可作输出的操作' }),
        h('th', { class: 'num', textContent: '内核数' })
      )),
      tbody
    ));
  }

  function renderOpsTable() {
    const rows = visibleOps();
    if (!rows.length) {
      tableHost.appendChild(h('div.empty', null,
        h('div.empty__title', { textContent: '没有匹配的操作' }),
        h('div.empty__text', { textContent: '换个关键词再试。' })
      ));
      return;
    }
    const tbody = h('tbody');
    for (const row of rows) {
      tbody.appendChild(makeRow(row.op, [
        h('td', null,
          h('div.kernel-name', null,
            h('span', { textContent: row.label || row.op }),
            h('span.kernel-name__id', { textContent: row.op })
          )
        ),
        h('td', { class: 'num mono', textContent: thousands((row.from || []).length) }),
        h('td', { class: 'num mono', textContent: thousands((row.to || []).length) }),
        h('td', { class: 'num mono', textContent: thousands(row.kernelCount || 0) }),
      ], () => {
        vs.selected = vs.selected === row.op ? '' : row.op;
        render();
      }));
    }
    tableHost.appendChild(h('table.table', null,
      h('colgroup', null,
        h('col', { style: { width: '40%' } }),
        h('col', { style: { width: '20%' } }),
        h('col', { style: { width: '20%' } }),
        h('col', { style: { width: '20%' } })
      ),
      h('thead', null, h('tr', null,
        h('th', { textContent: '操作' }),
        h('th', { class: 'num', textContent: '输入格式数' }),
        h('th', { class: 'num', textContent: '输出格式数' }),
        h('th', { class: 'num', textContent: '内核数' })
      )),
      tbody
    ));
  }

  /** 下方面板：选中项的可用目标格式（纯文本标签流） */
  function renderDetail() {
    clear(detailHost);
    if (!vs.selected) {
      detailHost.appendChild(h('div.field__hint', { textContent: '点选一行查看该格式 / 操作的可达关系。' }));
      return;
    }

    const tagFlow = (list, emptyText) => {
      const flow = h('div.tagflow');
      const values = Array.isArray(list) ? list : [];
      if (!values.length) return h('div.field__hint', { textContent: emptyText });
      for (const value of values) flow.appendChild(h('span.tag', { textContent: formatLabel(value) }));
      return flow;
    };

    if (vs.view === 'formats') {
      const row = vs.formats.find((f) => f && f.format === vs.selected);
      if (!row) return;
      // 该格式可作为输入的操作所能产出的目标格式（由操作目录推导，不硬编码任何格式）
      const targets = new Set();
      for (const opId of row.asInput) {
        const op = vs.ops.find((o) => o && o.op === opId);
        for (const fmt of (op && op.to) || []) if (fmt !== '*') targets.add(fmt);
      }
      targets.delete(row.format);
      detailHost.appendChild(h('div.section__title', null,
        h('span', { textContent: '格式 ' }),
        h('span.mono', { textContent: formatLabel(row.format) })
      ));
      detailHost.appendChild(h('div.kv', null,
        h('div.kv__k', { textContent: '可作输入' }),
        h('div.kv__v', { textContent: row.asInput.map(opLabel).join('、') || '—' }),
        h('div.kv__k', { textContent: '可作输出' }),
        h('div.kv__v', { textContent: row.asOutput.map(opLabel).join('、') || '—' }),
        h('div.kv__k', { textContent: '涉及内核' }),
        h('div.kv__v', { textContent: `${thousands(row.kernelCount || 0)} 个` })
      ));
      detailHost.appendChild(h('div.field__hint', { textContent: '作为输入时的可用目标格式（由参与的操作推出）：' }));
      detailHost.appendChild(tagFlow(Array.from(targets).sort(), '没有可推出的目标格式'));
      return;
    }

    const row = vs.ops.find((o) => o && o.op === vs.selected);
    if (!row) return;
    detailHost.appendChild(h('div.section__title', null,
      h('span', { textContent: row.label || row.op }),
      h('span.mono.dim', { textContent: row.op })
    ));
    if (row.description) detailHost.appendChild(h('div.field__hint', { textContent: row.description }));
    detailHost.appendChild(h('div.kv', null,
      h('div.kv__k', { textContent: '输入格式' }),
      h('div.kv__v', { textContent: `${thousands((row.from || []).length)} 种` }),
      h('div.kv__k', { textContent: '输出格式' }),
      h('div.kv__v', { textContent: `${thousands((row.to || []).length)} 种` }),
      h('div.kv__k', { textContent: '参与内核' }),
      h('div.kv__v', { textContent: `${thousands(row.kernelCount || 0)} 个` })
    ));
    detailHost.appendChild(h('div.field__hint', { textContent: '输入格式：' }));
    detailHost.appendChild(tagFlow(row.from, '—'));
    detailHost.appendChild(h('div.field__hint', { textContent: '输出格式：' }));
    detailHost.appendChild(tagFlow(row.to, '—'));
  }

  /* --------------------------------------------------------------- 事件 */

  disposers.push(on(viewSelect, 'change', () => {
    vs.view = viewSelect.value;
    vs.selected = '';
    render();
  }));
  disposers.push(on(opSelect, 'change', () => {
    vs.op = opSelect.value;
    render();
  }));
  disposers.push(on(searchInput, 'input', () => {
    vs.query = searchInput.value;
    render();
  }));

  disposers.push(ctx.registerAction('focus-format', (fmt) => {
    const value = String(fmt || '');
    if (!value) return;
    vs.view = 'formats';
    viewSelect.value = 'formats';
    vs.op = 'all';
    opSelect.value = 'all';
    vs.query = '';
    searchInput.value = '';
    vs.selected = value;
    render();
    const row = tableHost.querySelector('tr[aria-selected="true"]');
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center' });
  }));

  void store;
  await load();

  return {
    unmount() {
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
