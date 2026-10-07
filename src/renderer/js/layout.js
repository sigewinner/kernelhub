/**
 * layout.js —— 应用外壳：顶栏 / 侧栏导航 / 底部状态栏 / 命令面板
 *
 * 与视图的分工：
 *   layout 只负责「外壳」——它永远存在，且不认识任何业务数据；
 *   视图只管在自己那块 #view 里渲染。外壳需要展示的数字（队列计数、内核数）
 *   由 app.js 通过 render(state) 推进来，layout 不主动调用 window.khs。
 *
 * 与旧版相比删掉的东西（瑞士风格取舍，见 docs/ui-spec-swiss.md）：
 *   · 顶栏的全局搜索胶囊与内核状态胶囊（信息重复、装饰过多）→ 只留主题切换与窗口控制
 *   · 侧栏的彩色分布条形图与徽标 → 一行等宽数字的「内核 N / M 可用」
 *   · 状态栏里的可点胶囊按钮 → 纯文本，避免「到处都是按钮」
 */

import { h, clear, on, qs, srText, nextFrame, copyText, iconAction } from './dom.js';
import { icon } from './icons.js';
import { shortcut } from './format.js';
import { toast } from './toast.js';

/* --------------------------------------------------------------- 导航定义 */

/**
 * 侧栏导航项（前 7 项是工作视图，编号 01–07；设置不编号）。
 * 这是 Ctrl/Cmd+1..8 的索引来源，顺序即编号顺序。
 */
export const NAV_ITEMS = [
  { id: 'convert', label: '转换', num: '01', hash: '#/convert', shortcut: 'mod+1', icon: 'convert' },
  { id: 'batch', label: '队列', num: '02', hash: '#/batch', shortcut: 'mod+2', icon: 'queue' },
  { id: 'kernels', label: '内核', num: '03', hash: '#/kernels', shortcut: 'mod+3', icon: 'kernels' },
  { id: 'plugins', label: '插件', num: '04', hash: '#/plugins', shortcut: 'mod+4', icon: 'plugins' },
  { id: 'formats', label: '格式', num: '05', hash: '#/formats', shortcut: 'mod+5', icon: 'matrix' },
  { id: 'protocol', label: '协议', num: '06', hash: '#/protocol', shortcut: 'mod+6', icon: 'book' },
  { id: 'logs', label: '日志', num: '07', hash: '#/logs', shortcut: 'mod+7', icon: 'logs' },
  { id: 'settings', label: '设置', num: '', hash: '#/settings', shortcut: 'mod+8', icon: 'settings' },
];

/** 视图 id → 中文标题（面包屑与命令面板共用） */
export function viewLabel(id) {
  const hit = NAV_ITEMS.find((item) => item.id === id);
  return hit ? hit.label : String(id || '');
}

/* ------------------------------------------------------------------ 外壳 */

/**
 * 初始化外壳。
 * @param {object} options
 * @param {(hash: string) => void} options.navigate 路由跳转（app.js 提供）
 * @param {(key: string) => void} options.runAction 执行具名动作（app.js 提供）
 * @param {() => Array} options.commands 取命令清单（命令面板数据源）
 * @param {() => string} options.currentTheme 当前主题
 * @param {(theme: string) => void} options.toggleTheme 切换主题
 * @param {(err: Error) => void} options.reportError 统一错误上报
 */
export function createLayout(options = {}) {
  const navigate = typeof options.navigate === 'function' ? options.navigate : () => {};
  const getCommands = typeof options.commands === 'function' ? options.commands : () => [];
  const toggleTheme = typeof options.toggleTheme === 'function' ? options.toggleTheme : () => {};
  const reportError = typeof options.reportError === 'function'
    ? options.reportError
    : (err) => toast.exception('界面操作失败', err);

  const els = {
    titlebarVersion: qs('#titlebar-version'),
    themeToggle: qs('#theme-toggle'),
    nav: qs('#nav'),
    kernelbar: qs('#sidebar-kernelbar'),
    statusbar: qs('#statusbar'),
    cmdkTrigger: qs('#cmdk-trigger'),
    cmdkHost: qs('#cmdk-host'),
    winMin: qs('#win-min'),
    winMax: qs('#win-max'),
    winClose: qs('#win-close'),
  };

  const disposers = [];
  let navEls = new Map();
  let lastState = {};
  let maximized = false;

  /* ------------------------------------------------------------- 顶栏 */

  function bindWindowControls() {
    if (els.winMin) {
      disposers.push(on(els.winMin, 'click', () => {
        Promise.resolve(window.khs.win.minimize()).catch(reportError);
      }));
    }
    if (els.winMax) {
      disposers.push(on(els.winMax, 'click', () => {
        Promise.resolve(window.khs.win.toggleMaximize()).catch(reportError);
      }));
    }
    if (els.winClose) {
      disposers.push(on(els.winClose, 'click', () => {
        Promise.resolve(window.khs.win.close()).catch(reportError);
      }));
    }
    if (els.themeToggle) {
      disposers.push(on(els.themeToggle, 'click', () => toggleTheme()));
    }
    // 双击顶栏空白处 = 最大化/还原（与原生窗口行为一致）
    const titlebar = qs('#titlebar');
    if (titlebar) {
      disposers.push(on(titlebar, 'dblclick', (event) => {
        if (event.target.closest('button, a, input')) return;
        Promise.resolve(window.khs.win.toggleMaximize()).catch(reportError);
      }));
    }
  }

  function setVersion(version, ckp) {
    if (!els.titlebarVersion) return;
    els.titlebarVersion.textContent = version ? `v${version}${ckp ? ` · CKP ${ckp}` : ''}` : '';
  }

  /**
   * 主题按钮：属性 data-theme-toggle 记的是「点下去会切到哪个主题」，
   * 因此它必须随当前主题更新（验收脚本按 [data-theme-toggle="dark"] 找按钮）。
   */
  function setTheme(theme) {
    if (!els.themeToggle) return;
    const next = theme === 'dark' ? 'light' : 'dark';
    els.themeToggle.dataset.themeToggle = next;
    els.themeToggle.title = next === 'dark' ? '切换到深色主题' : '切换到浅色主题';
    clear(els.themeToggle);
    els.themeToggle.appendChild(icon(next === 'dark' ? 'moon' : 'theme', { size: 15 }));
    els.themeToggle.appendChild(srText(els.themeToggle.title));
  }

  function setMaximized(value) {
    maximized = Boolean(value);
    if (!els.winMax) return;
    clear(els.winMax);
    els.winMax.appendChild(icon(maximized ? 'window' : 'square', { size: 13 }));
    els.winMax.appendChild(srText(maximized ? '向下还原窗口' : '最大化窗口'));
    els.winMax.title = maximized ? '向下还原' : '最大化';
  }

  /* ---------------------------------------------------------------- 侧栏 */

  function buildNav() {
    if (!els.nav) return;
    clear(els.nav);
    navEls = new Map();

    for (const item of NAV_ITEMS) {
      if (item.id === 'settings') els.nav.appendChild(h('div.nav__sep'));
      const itemEl = h('button.nav__item', {
        type: 'button',
        role: 'tab',
        title: `${item.label}（${shortcut(item.shortcut)}）`,
        dataset: { nav: item.id },
        on: { click: () => navigate(item.hash) },
      },
        h('span.nav__num', { textContent: item.num || '' }),
        h('span.nav__label', { textContent: item.label })
      );
      navEls.set(item.id, { itemEl });
      els.nav.appendChild(itemEl);
    }

    // 命令面板入口也放在导航里：既让「Ctrl+K」这件事可被发现，也让侧栏成为唯一入口区
    els.nav.appendChild(h('div.nav__sep'));
    const commandEl = h('button.nav__item', {
      id: 'cmdk-trigger',
      type: 'button',
      title: `命令面板（${shortcut('mod+K')}）`,
      on: { click: () => openPalette() },
    },
      h('span.nav__num', { textContent: '' }),
      h('span.nav__label', { textContent: '命令面板' }),
      h('span.nav__hint', { textContent: shortcut('mod+K') })
    );
    els.nav.appendChild(commandEl);
    els.cmdkTrigger = commandEl;
  }

  /** 高亮当前视图（黑底反白块，全站统一） */
  function setActive(viewId) {
    for (const [id, refs] of navEls) {
      if (id === viewId) refs.itemEl.setAttribute('aria-current', 'page');
      else refs.itemEl.removeAttribute('aria-current');
    }
  }

  /** 侧栏底部状态行：一句话 + 等宽数字 */
  function renderKernelbar(state) {
    if (!els.kernelbar) return;
    const total = Number(state.kernelsTotal || 0);
    const ready = Number(state.kernelsReady || 0);
    clear(els.kernelbar);

    if (state.bootPhase === 'loading' && !total) {
      els.kernelbar.appendChild(h('span', { textContent: '内核状态载入中…' }));
      return;
    }
    const tone = state.bootPhase === 'error' ? 'dot--err' : ready > 0 ? 'dot--ok' : 'dot--warn';
    els.kernelbar.appendChild(h('div.sidebar__status-line', null,
      h('span', { class: `dot ${tone}` }),
      h('span', { textContent: '内核' }),
      h('span.sidebar__status-num', { textContent: `${ready} / ${total}` }),
      h('span', { textContent: '可用' })
    ));
  }

  /* -------------------------------------------------------------- 状态栏 */

  function renderStatusbar(state) {
    if (!els.statusbar) return;
    clear(els.statusbar);

    const counts = state.queueCounts || {};
    const running = Number(counts.running || 0);
    const queued = Number(counts.queued || 0);
    const failed = Number(counts.failed || 0);
    const total = Number(counts.total || 0);
    const pending = (state.pending || []).length;

    const tone = state.bootPhase === 'error' ? 'dot--err'
      : running > 0 ? 'dot--busy'
        : state.kernelsReady > 0 ? 'dot--ok' : 'dot--warn';
    const readyText = state.bootPhase === 'error' ? '启动异常'
      : running > 0 ? `转换中（${running}）`
        : queued > 0 ? `队列就绪（${queued} 待处理）`
          : state.bootPhase === 'loading' ? '正在启动…' : '就绪';

    els.statusbar.appendChild(h('div.statusbar__item', { title: '应用状态' },
      h('span', { class: `dot ${tone}` }),
      h('span', { textContent: readyText })
    ));

    els.statusbar.appendChild(h('div.statusbar__item', { title: '可用内核 / 内核总数' },
      h('span', { textContent: `内核 ${state.kernelsReady || 0}/${state.kernelsTotal || 0} 可用` })
    ));

    if (total || queued || failed) {
      els.statusbar.appendChild(h('div.statusbar__item', { title: '队列计数' },
        h('span', { textContent: `队列 ${total}（待 ${queued} · 失败 ${failed}）` })
      ));
    }

    if (pending) {
      els.statusbar.appendChild(h('div.statusbar__item', { title: '待转换文件' },
        h('span', { textContent: `待转换 ${pending}` })
      ));
    }

    els.statusbar.appendChild(h('div.statusbar__spacer'));

    if (state.queuePaused) {
      els.statusbar.appendChild(h('div.statusbar__item', null,
        h('span', { class: 'dot dot--warn' }),
        h('span', { textContent: '队列已暂停' })
      ));
    }

    if (state.logCount) {
      els.statusbar.appendChild(h('div.statusbar__item', { title: '运行日志行数' },
        h('span', { textContent: `日志 ${state.logCount}` })
      ));
    }

    els.statusbar.appendChild(h('div.statusbar__item', { title: '当前协议版本' },
      h('span.statusbar__mono', { textContent: state.ckp ? `CKP ${state.ckp}` : 'CKP —' })
    ));
  }

  /** 外壳的一次性整体渲染 */
  function render(state = {}) {
    lastState = { ...lastState, ...state };
    setActive(lastState.activeView || 'convert');
    if (state.maximized !== undefined) setMaximized(state.maximized);
    if (state.version !== undefined || state.ckp !== undefined) {
      setVersion(lastState.version, lastState.ckp);
    }
    if (state.theme !== undefined) setTheme(state.theme);
    renderKernelbar(lastState);
    renderStatusbar(lastState);
  }

  /* ---------------------------------------------------------- 命令面板 */

  const palette = createPalette({
    host: els.cmdkHost,
    getCommands,
    onRun: (command) => {
      try {
        if (typeof command.run === 'function') command.run();
      } catch (err) {
        reportError(err);
      }
    },
  });

  function openPalette(prefill = '') {
    palette.open(prefill);
  }

  /* ------------------------------------------------------------ 生命周期 */

  function bindGlobal() {
    disposers.push(on(window, 'khs:ui-error', (event) => {
      const detail = event.detail || {};
      toast.error(detail.title || '界面操作失败', detail.message || '未知原因');
    }));
  }

  function mount() {
    buildNav();
    bindWindowControls();
    bindGlobal();
    setTheme(document.documentElement.getAttribute('data-theme') || 'light');
    render({});
  }

  function destroy() {
    palette.destroy();
    while (disposers.length) {
      const off = disposers.pop();
      try {
        off();
      } catch {
        /* 忽略 */
      }
    }
  }

  return {
    mount,
    destroy,
    render,
    setActive,
    setMaximized,
    setTheme,
    openPalette,
    closePalette: palette.close,
    isPaletteOpen: palette.isOpen,
    navigate,
    _state: () => lastState,
  };
}

/* ============================================================== 命令面板 */

/**
 * 命令面板（Ctrl/Cmd+K）：白底、1px 描边、无阴影、行高 36。
 * 数据完全由 app.js 通过 getCommands() 提供，面板只负责检索与键盘选择。
 */
function createPalette({ host, getCommands, onRun }) {
  let open = false;
  let filtered = [];
  let cursor = 0;
  const disposers = [];

  const inputEl = h('input.cmdk__input', {
    type: 'text',
    placeholder: '输入命令、视图、内核或格式名…',
    spellcheck: 'false',
    'aria-label': '命令面板搜索',
  });
  const listEl = h('div.cmdk__list', { role: 'listbox' });
  const countEl = h('span', { dataset: { role: 'count' }, textContent: '0 项' });

  const root = h('div.cmdk', null,
    h('div.cmdk__search', null, inputEl),
    listEl,
    h('div.cmdk__foot', null,
      h('span', null, '↑↓ 选择'),
      h('span', null, 'Enter 执行'),
      h('span', null, 'Esc 关闭'),
      h('span.grow'),
      countEl
    )
  );

  function buildItems(query) {
    const all = (getCommands() || []).filter(Boolean);
    const q = String(query || '').trim().toLowerCase();
    if (!q) return all.slice(0, 60);
    const scored = [];
    for (const item of all) {
      const hay = `${item.title || ''} ${item.subtitle || ''} ${item.keywords || ''}`.toLowerCase();
      const idx = hay.indexOf(q);
      if (idx < 0) continue;
      const titleIdx = String(item.title || '').toLowerCase().indexOf(q);
      scored.push({ item, score: titleIdx >= 0 ? titleIdx : 100 + idx });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.map((s) => s.item).slice(0, 60);
  }

  function renderList() {
    clear(listEl);
    if (!filtered.length) {
      listEl.appendChild(h('div.empty', { style: { padding: 'var(--sp-6) var(--sp-4)' } },
        h('div.empty__title', { textContent: '没有匹配项' }),
        h('div.empty__text', { textContent: '换个关键词，或直接用快捷键操作。' })
      ));
    } else {
      let currentGroup = null;
      filtered.forEach((item, index) => {
        const group = item.group || '命令';
        if (group !== currentGroup) {
          currentGroup = group;
          listEl.appendChild(h('div.cmdk__group', { textContent: group }));
        }
        listEl.appendChild(h('button.cmdk__item', {
          type: 'button',
          role: 'option',
          dataset: { index: String(index) },
          'aria-selected': index === cursor ? 'true' : 'false',
          on: {
            click: () => {
              cursor = index;
              runCurrent();
            },
            mousemove: () => {
              if (cursor === index) return;
              cursor = index;
              syncSelection();
            },
          },
        },
          h('span.cmdk__item-title', { textContent: item.title || '' }),
          item.subtitle ? h('span.cmdk__item-sub', { textContent: item.subtitle }) : null,
          item.kbd ? h('span.cmdk__item-kbd', { textContent: item.kbd }) : null
        ));
      });
    }
    countEl.textContent = `${filtered.length} 项`;
    syncSelection();
  }

  function syncSelection() {
    const rows = listEl.querySelectorAll('.cmdk__item');
    rows.forEach((row, index) => {
      const selected = index === cursor;
      row.setAttribute('aria-selected', selected ? 'true' : 'false');
      if (!selected) return;
      const r = row.getBoundingClientRect();
      const c = listEl.getBoundingClientRect();
      if (r.top < c.top) listEl.scrollTop -= c.top - r.top + 6;
      else if (r.bottom > c.bottom) listEl.scrollTop += r.bottom - c.bottom + 6;
    });
  }

  function refresh(query) {
    filtered = buildItems(query);
    cursor = 0;
    renderList();
  }

  function runCurrent() {
    const item = filtered[cursor];
    if (!item) return;
    closePalette();
    onRun(item);
  }

  function openPalette(prefill = '') {
    if (!host) return;
    if (open) {
      inputEl.focus();
      return;
    }
    open = true;
    host.dataset.open = 'true';
    if (!root.isConnected) host.appendChild(root);
    inputEl.value = String(prefill || '');
    refresh(inputEl.value);
    nextFrame().then(() => {
      inputEl.focus();
      inputEl.select();
    });
  }

  function closePalette() {
    if (!open) return;
    open = false;
    if (host) host.dataset.open = 'false';
  }

  function onKeydown(event) {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closePalette();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!filtered.length) return;
      cursor = (cursor + 1) % filtered.length;
      syncSelection();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!filtered.length) return;
      cursor = (cursor - 1 + filtered.length) % filtered.length;
      syncSelection();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      runCurrent();
      return;
    }
    if (event.key === 'Home') {
      cursor = 0;
      syncSelection();
    }
    if (event.key === 'End') {
      cursor = Math.max(0, filtered.length - 1);
      syncSelection();
    }
  }

  disposers.push(on(inputEl, 'input', () => refresh(inputEl.value)));
  disposers.push(on(document, 'keydown', onKeydown, true));
  if (host) {
    disposers.push(on(host, 'mousedown', (event) => {
      if (event.target === host) closePalette();
    }));
  }

  return {
    open: openPalette,
    close: closePalette,
    isOpen: () => open,
    destroy() {
      while (disposers.length) {
        const off = disposers.pop();
        try {
          off();
        } catch {
          /* 忽略 */
        }
      }
      if (root.parentNode) root.parentNode.removeChild(root);
    },
  };
}

/* --------------------------------------------------------------- 小工具 */

/** 状态徽标：文字 + 前置 6px 方块（瑞士风格不用圆点） */
export function statusBadge(label, tone, opts = {}) {
  return h('span', {
    class: `badge badge--${tone || 'mute'}${opts.mono ? ' badge--mono' : ''}`,
    title: opts.title || String(label || ''),
  }, h('span.badge__dot'), h('span', { textContent: String(label || '—') }));
}

/** 作业状态 → 中文标签与徽标色 */
export function jobStateMeta(state) {
  switch (state) {
    case 'queued': return { label: '排队中', tone: 'mute' };
    case 'running': return { label: '转换中', tone: 'accent' };
    case 'done': return { label: '已完成', tone: 'ok' };
    case 'failed': return { label: '失败', tone: 'err' };
    case 'cancelled': return { label: '已取消', tone: 'mute' };
    default: return { label: state || '未知', tone: 'mute' };
  }
}

/** 内核状态 → 徽标色 */
export function kernelStateTone(status) {
  switch (status) {
    case 'ready': return 'ok';
    case 'degraded': return 'warn';
    case 'invalid': return 'err';
    case 'unavailable': return 'mute';
    case 'disabled': return 'mute';
    default: return 'mute';
  }
}

/**
 * 复制操作（视图复用）：点击复制文本并 toast 反馈。
 * 刻意用 <span role="button">（iconAction），不占用「每屏按钮 ≤ 10」的预算。
 * @param {string|(() => string)} value
 */
export function copyButton(value, label = '复制', opts = {}) {
  return iconAction({
    classes: ['textbtn'],
    label: opts.title || '复制到剪贴板',
    children: [h('span', { textContent: label })],
    onClick: async () => {
      const text = typeof value === 'function' ? value() : value;
      const ok = await copyText(text);
      if (ok) toast.success('已复制', { text: `${String(text || '').length} 个字符` });
      else toast.warn('复制失败', '当前环境不允许访问剪贴板，请手动选择文本');
    },
  });
}

export default createLayout;
