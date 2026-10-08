/**
 * views/formats.js —— 格式
 *
 * 版面（docs/ui-spec-swiss.md 4.4）：**0 个按钮**
 *   工具栏：操作 ▾ + 视图 ▾（格式表 / 操作表）+ 搜索输入框
 *   内容 A（格式表）：格式 / 可作输入的操作 / 可作输出的操作 / 内核数
 *   内容 B（操作表）：操作 / 输入格式数 / 输出格式数 / 内核数
 *
 * 2.2.4 版面调整：
 *   · 表格元素**居中**，整页不再左对齐堆在左上角
 *   · 详情不再常驻页面下方（那里原本是一大片空白），改成**点行从右侧弹出缓动卡片**
 *     —— 复用 sheet.js，弹出/收起本来就带缓动
 *   · 卡片里补上**格式说明**：性质（是否无损、有没有透明通道…）与**二进制排版**
 *     （文件头签名、整体结构、编码与算法），内容来自 formatInfo.js
 *
 * 数据全部来自 window.khs.kernels.formats() / kernels.ops()，界面不预设任何格式名。
 * 另外会把格式矩阵广播给命令面板（khs:formats-cache），避免重复 IPC。
 */

import { h, clear, on } from '../dom.js';
import { formatLabel, thousands } from '../format.js';
import { t, opText, listSeparator, getLocale } from '../i18n.js';
import { createSheet } from '../sheet.js';
import { formatInfoOf } from '../formatInfo.js';

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

  const viewSelect = h('select.select', { 'aria-label': t('视图') });
  viewSelect.appendChild(h('option', { value: 'formats', textContent: t('格式表') }));
  viewSelect.appendChild(h('option', { value: 'ops', textContent: t('操作表') }));

  const opSelect = h('select.select', { 'aria-label': t('操作筛选') });
  opSelect.appendChild(h('option', { value: 'all', textContent: t('全部操作') }));

  const searchInput = h('input.input', {
    type: 'text',
    placeholder: t('搜索格式或操作'),
    'aria-label': t('搜索格式或操作'),
  });

  const tableHost = h('div.tablewrap.tablewrap--center');

  /**
   * 详情卡片：从右侧滑出（缓动在 sheet.js / components.css 里）。
   * 点某一行才出现 —— 页面下方因此空出来，整页是一张居中、留白均匀的表。
   *
   * onToggle：用户用 Esc / 点遮罩 / 点「关闭」收起卡片时，要把行选中一起取消，
   * 否则会出现「卡片关了但那一行还是选中态」的不一致。
   */
  const detail = createSheet(host, {
    id: 'format-detail',
    title: t('格式详情'),
    onToggle: (open) => {
      if (!open && vs.selected) {
        vs.selected = '';
        render();
      }
    },
  });
  const detailBody = h('div.detail-center');
  detail.body.appendChild(detailBody);

  const wrap = h('div.view-inner', { dataset: { view: 'formats' } },
    h('div.view-head', null,
      h('h1.view-title', { textContent: t('格式') }),
      h('div.view-rule')
    ),
    h('div.toolbar.toolbar--center', null,
      h('div.selectwrap', { style: { width: '160px' } }, opSelect),
      h('div.selectwrap', { style: { width: '140px' } }, viewSelect),
      h('div', { style: { width: '240px' } }, searchInput)
    ),
    tableHost
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
    opSelect.appendChild(h('option', { value: 'all', textContent: t('全部操作') }));
    for (const row of vs.ops) {
      if (!row || !row.op) continue;
      opSelect.appendChild(h('option', {
        value: row.op,
        textContent: `${opText(row.op, row.label)} （${row.kernelCount || 0}）`,
      }));
    }
    const exists = Array.from(opSelect.options).some((o) => o.value === current);
    vs.op = exists ? current : 'all';
    opSelect.value = vs.op;
  }

  /** 操作名的显示名：按 op id 走 i18n（中文用主进程给的中文标签） */
  function opLabel(op) {
    const hit = vs.ops.find((row) => row && row.op === op);
    return opText(op, hit && hit.label ? hit.label : String(op || ''));
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

    if (vs.error) {
      tableHost.appendChild(h('div.error-state', null,
        h('div.error-state__msg', { textContent: vs.error.message || String(vs.error) }),
        h('button.linkbtn', { type: 'button', on: { click: () => load() } }, h('span', { textContent: t('重试') }))
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

    // 详情只在选中时出现：点行 → 右侧滑出缓动卡片；再点同一行 → 收起
    if (vs.selected) renderDetailCard();
    else detail.close();
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
        h('div.empty__title', { textContent: t('没有匹配的格式') }),
        h('div.empty__text', { textContent: t('换个操作或关键词再试。') })
      ));
      return;
    }
    const tbody = h('tbody');
    for (const row of rows) {
      tbody.appendChild(makeRow(row.format, [
        h('td', null, h('span.mono', { textContent: formatLabel(row.format) })),
        h('td', null, h('span.matrix-cell', { textContent: row.asInput.map(opLabel).join(listSeparator()) || '—' })),
        h('td', null, h('span.matrix-cell', { textContent: row.asOutput.map(opLabel).join(listSeparator()) || '—' })),
        h('td', { class: 'num mono', textContent: thousands(row.kernelCount || 0) }),
      ], () => {
        vs.selected = vs.selected === row.format ? '' : row.format;
        render();
      }));
    }
    tableHost.appendChild(h('table.table.table--center', null,
      h('colgroup', null,
        h('col', { style: { width: '14%' } }),
        h('col', { style: { width: '36%' } }),
        h('col', { style: { width: '36%' } }),
        h('col', { style: { width: '14%' } })
      ),
      h('thead', null, h('tr', null,
        h('th', { textContent: t('格式') }),
        h('th', { textContent: t('可作输入的操作') }),
        h('th', { textContent: t('可作输出的操作') }),
        h('th', { class: 'num', textContent: t('内核数') })
      )),
      tbody
    ));
  }

  function renderOpsTable() {
    const rows = visibleOps();
    if (!rows.length) {
      tableHost.appendChild(h('div.empty', null,
        h('div.empty__title', { textContent: t('没有匹配的操作') }),
        h('div.empty__text', { textContent: t('换个关键词再试。') })
      ));
      return;
    }
    const tbody = h('tbody');
    for (const row of rows) {
      tbody.appendChild(makeRow(row.op, [
        h('td', null,
          h('div.kernel-name', null,
            h('span', { textContent: opText(row.op, row.label) }),
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
    tableHost.appendChild(h('table.table.table--center', null,
      h('colgroup', null,
        h('col', { style: { width: '40%' } }),
        h('col', { style: { width: '20%' } }),
        h('col', { style: { width: '20%' } }),
        h('col', { style: { width: '20%' } })
      ),
      h('thead', null, h('tr', null,
        h('th', { textContent: t('操作') }),
        h('th', { class: 'num', textContent: t('输入格式数') }),
        h('th', { class: 'num', textContent: t('输出格式数') }),
        h('th', { class: 'num', textContent: t('内核数') })
      )),
      tbody
    ));
  }

  /**
   * 详情卡片（2.2.4）：从右侧滑出，内容整块居中。
   *
   * 里面分两段：
   *   · 这个格式**是什么**（说明 + 性质标签）
   *   · **二进制怎么排版**（文件头签名、整体结构、编码与算法）—— 来自 formatInfo.js
   * 末尾接上可达关系（可作输入/输出的操作、能推出来的目标格式、涉及几个内核）。
   */
  function renderDetailCard() {
    clear(detailBody);

    const tagFlow = (list, emptyText) => {
      const flow = h('div.tagflow.tagflow--center');
      const values = Array.isArray(list) ? list : [];
      if (!values.length) return h('div.note-line.dim', { textContent: emptyText });
      for (const value of values) flow.appendChild(h('span.tag', { textContent: formatLabel(value) }));
      return flow;
    };

    /** 卡片里的一节：小标题 + 内容，整体居中 */
    const section = (title, ...children) =>
      h('section.detail-section', null,
        h('h3.detail-section__title', { textContent: title }),
        ...children.filter(Boolean)
      );

    if (vs.view === 'formats') {
      const row = vs.formats.find((f) => f && f.format === vs.selected);
      if (!row) {
        detail.close();
        return;
      }

      detail.setTitle(t('格式 {0}', { 0: formatLabel(row.format) }));
      const info = formatInfoOf(row.format, getLocale());
      detail.setSubtitle(info ? info.summary : t('暂无该格式的说明'));

      // ① 性质标签
      if (info && Array.isArray(info.traits) && info.traits.length) {
        const flow = h('div.tagflow.tagflow--center');
        for (const trait of info.traits) flow.appendChild(h('span.tag', { textContent: trait }));
        detailBody.appendChild(section(t('性质'), flow));
      }

      // ② 二进制排版
      if (info && info.layout) {
        detailBody.appendChild(section(t('二进制排版'),
          h('p.detail-text', { textContent: info.layout })
        ));
      }

      // ③ 可达关系
      const targets = new Set();
      for (const opId of row.asInput) {
        const op = vs.ops.find((o) => o && o.op === opId);
        for (const fmt of (op && op.to) || []) if (fmt !== '*') targets.add(fmt);
      }
      targets.delete(row.format);

      detailBody.appendChild(section(t('在转换中的位置'),
        h('div.kv.kv--center', null,
          h('div.kv__k', { textContent: t('可作输入') }),
          h('div.kv__v', { textContent: row.asInput.map(opLabel).join(listSeparator()) || '—' }),
          h('div.kv__k', { textContent: t('可作输出') }),
          h('div.kv__v', { textContent: row.asOutput.map(opLabel).join(listSeparator()) || '—' }),
          h('div.kv__k', { textContent: t('涉及内核') }),
          h('div.kv__v', { textContent: t('{0} 个', { 0: thousands(row.kernelCount || 0) }) })
        ),
        h('div.note-line', { textContent: t('作为输入时的可用目标格式（由参与的操作推出）：') }),
        tagFlow(Array.from(targets).sort(), t('没有可推出的目标格式'))
      ));

      detail.open();
      return;
    }

    const row = vs.ops.find((o) => o && o.op === vs.selected);
    if (!row) {
      detail.close();
      return;
    }

    detail.setTitle(opText(row.op, row.label));
    detail.setSubtitle(row.description || '');

    detailBody.appendChild(section(t('规模'),
      h('div.kv.kv--center', null,
        h('div.kv__k', { textContent: t('输入格式') }),
        h('div.kv__v', { textContent: t('{0} 种', { 0: thousands((row.from || []).length) }) }),
        h('div.kv__k', { textContent: t('输出格式') }),
        h('div.kv__v', { textContent: t('{0} 种', { 0: thousands((row.to || []).length) }) }),
        h('div.kv__k', { textContent: t('参与内核') }),
        h('div.kv__v', { textContent: t('{0} 个', { 0: thousands(row.kernelCount || 0) }) })
      )
    ));
    detailBody.appendChild(section(t('输入格式'), tagFlow(row.from, '—')));
    detailBody.appendChild(section(t('输出格式'), tagFlow(row.to, '—')));
    detail.open();
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
