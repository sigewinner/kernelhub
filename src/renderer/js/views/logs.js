/**
 * views/logs.js —— 日志
 *
 * 版面（docs/ui-spec-swiss.md 4.6）：2 个按钮
 *   工具栏：级别 ▾ + 来源 ▾ + 搜索输入框 …右侧：[清空] [复制]
 *   内容：等宽字列表（时间 / 级别 / 内容），出错行文字用强调色
 *   底部：当前行数 / 上限
 *
 * 数据来自 app.js 维护的本地环形缓冲（store.pick('logs')，由 evt:log 与 evt:job:log 追加）。
 */

import { h, clear, on, copyText } from '../dom.js';
import { clockTime } from '../format.js';

const LEVELS = [
  { value: 'all', label: '全部级别' },
  { value: 'debug', label: '调试' },
  { value: 'info', label: '信息' },
  { value: 'warn', label: '警告' },
  { value: 'error', label: '错误' },
];

const SOURCES = [
  { value: 'all', label: '全部来源' },
  { value: 'main', label: '主进程' },
  { value: 'job', label: '作业' },
];

const LEVEL_TEXT = { debug: '调试', info: '信息', warn: '警告', error: '错误' };

export async function mount(host, ctx) {
  const { store } = ctx;
  const disposers = [];

  const vs = { level: 'all', source: 'all', query: '' };
  let pinned = true;

  /* --------------------------------------------------------------- 结构 */

  const levelSelect = h('select.select', { 'aria-label': '日志级别' });
  for (const item of LEVELS) levelSelect.appendChild(h('option', { value: item.value, textContent: item.label }));

  const sourceSelect = h('select.select', { 'aria-label': '日志来源' });
  for (const item of SOURCES) sourceSelect.appendChild(h('option', { value: item.value, textContent: item.label }));

  const searchInput = h('input.input', {
    type: 'text',
    placeholder: '搜索内容',
    'aria-label': '搜索日志内容',
  });

  const clearBtn = h('button.btn', {
    type: 'button',
    title: '清空主进程与本地的日志缓冲',
    on: { click: () => clearLogs() },
  }, h('span', { textContent: '清空' }));

  const copyBtn = h('button.btn', {
    type: 'button',
    title: '复制当前过滤结果',
    on: { click: () => copyVisible() },
  }, h('span', { textContent: '复制' }));

  const listEl = h('div.loglist');

  const wrap = h('div.view-inner', { dataset: { view: 'logs' } },
    h('div.view-head', null,
      h('h1.view-title', { textContent: '日志' }),
      h('div.view-rule')
    ),
    h('div.toolbar', null,
      h('div.selectwrap', { style: { width: '140px' } }, levelSelect),
      h('div.selectwrap', { style: { width: '140px' } }, sourceSelect),
      h('div', { style: { width: '240px' } }, searchInput),
      h('div.toolbar__right', null, clearBtn, copyBtn)
    ),
    listEl
  );
  host.appendChild(wrap);

  /* --------------------------------------------------------------- 过滤 */

  function sourceOf(entry) {
    return entry && entry.jobId ? 'job' : 'main';
  }

  function filtered() {
    const q = vs.query.trim().toLowerCase();
    return (store.pick('logs') || []).filter((entry) => {
      if (!entry) return false;
      if (vs.level !== 'all' && String(entry.level || 'info') !== vs.level) return false;
      if (vs.source !== 'all' && sourceOf(entry) !== vs.source) return false;
      if (q && !String(entry.message || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function lineOf(entry) {
    return `${clockTime(entry.at)} [${LEVEL_TEXT[entry.level] || entry.level || '信息'}] ${entry.message || ''}`;
  }

  /* --------------------------------------------------------------- 渲染 */

  function render() {
    const rows = filtered();
    const total = (store.pick('logs') || []).length;
    clear(listEl);

    if (!rows.length) {
      listEl.appendChild(h('div.empty', null,
        h('div.empty__title', { textContent: total ? '没有匹配的日志行' : '还没有日志' }),
        h('div.empty__text', {
          textContent: total
            ? '换个级别、来源或关键词再试。'
            : '主进程与作业的日志会实时出现在这里。',
        })
      ));
    } else {
      const frag = document.createDocumentFragment();
      for (const entry of rows) {
        const level = String(entry.level || 'info');
        frag.appendChild(h('div', {
          class: `logrow${level === 'error' ? ' logrow--error' : level === 'warn' ? ' logrow--warn' : ''}`,
          title: entry.jobId ? `作业 ${entry.jobId}` : '主进程',
        },
          h('span.logrow__time', { textContent: clockTime(entry.at) }),
          h('span.logrow__level', { textContent: LEVEL_TEXT[level] || level }),
          h('span.logrow__msg', { textContent: String(entry.message || '') })
        ));
      }
      listEl.appendChild(frag);
    }

    // 实时信息推到状态栏右下角（2.0.4 起不再各视图自己放一行 .footline）
    const limit = Number((store.pick('settings') || {}).keepLogLines) || 4000;
    ctx.setStatusInfo([
      `显示 ${rows.length} 行 / 共 ${total} 行`,
      `最多保留 ${limit} 行`,
      pinned ? null : { text: '已暂停跟随，滚动到底部可恢复', tone: 'warn' },
    ]);

    if (pinned) host.scrollTop = host.scrollHeight;
  }

  /* --------------------------------------------------------------- 动作 */

  async function clearLogs() {
    if (!(store.pick('logs') || []).length) {
      ctx.toast.info('日志已经是空的');
      return;
    }
    if (!(await ctx.modal.confirm('清空全部日志？', { okLabel: '清空', danger: true }))) return;
    try {
      await window.khs.logs.clear();
      store.set({ logs: [], logCount: 0, logErrorCount: 0 });
      ctx.toast.success('日志已清空');
    } catch (err) {
      ctx.reportError('清空日志失败', ctx.wrapError(err));
    }
  }

  async function copyVisible() {
    const rows = filtered();
    if (!rows.length) {
      ctx.toast.warn('没有可复制的内容');
      return;
    }
    const ok = await copyText(rows.map(lineOf).join('\n'));
    if (ok) ctx.toast.success('日志已复制', { text: `${rows.length} 行` });
    else ctx.toast.warn('复制失败', '当前环境不允许访问剪贴板，请手动选择文本');
  }

  /* --------------------------------------------------------------- 事件 */

  disposers.push(on(levelSelect, 'change', () => {
    vs.level = levelSelect.value;
    render();
  }));
  disposers.push(on(sourceSelect, 'change', () => {
    vs.source = sourceSelect.value;
    render();
  }));
  disposers.push(on(searchInput, 'input', () => {
    vs.query = searchInput.value;
    render();
  }));
  disposers.push(on(host, 'scroll', () => {
    pinned = host.scrollTop + host.clientHeight >= host.scrollHeight - 24;
  }));
  disposers.push(store.subscribe((state, changed) => {
    if (changed.includes('logs') || changed.includes('logCount')) render();
  }));

  render();

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
