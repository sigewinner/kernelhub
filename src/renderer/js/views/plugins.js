/**
 * views/plugins.js —— 插件（已安装 + 可安装，合一）
 *
 * 2.0.0 起壳里没有内核，内核全部来自插件。所以「看已装的内核」和「装新插件」
 * 是同一件事的两面，分成两个页面只会让人来回找 —— 这里合成一页两个标签：
 *
 *   已安装  → 直接复用 views/kernels.js（状态、能力、依赖、详情抽屉、启停、优先级）
 *   可安装  → 插件仓库目录：体积、依赖、外部程序、安装/更新/卸载、实时进度
 *
 * 装完会做三件事，缺一不可（少任何一件都表现为「装完用不了」）：
 *   1. 主进程 reloadRegistry()（IPC 里已经做了）
 *   2. 刷新渲染层的内核列表 → ctx.refreshKernels()
 *   3. 刷新格式缓存 → refreshKernels 内部会一起做（否则新格式进不了「格式」页与命令面板）
 * 另外转换页监听内核签名变化后会重算目标格式（见 views/convert.js 的 syncFromStore）。
 */

import { h, clear, on, iconAction } from '../dom.js';
import { icon } from '../icons.js';
import { statusBadge } from '../layout.js';

/** 插件安装状态 → 文案与色调 */
const STATE_META = {
  installed: { label: '已安装', tone: 'ok' },
  'update-available': { label: '可更新', tone: 'accent' },
  modified: { label: '内容已改动', tone: 'warn' },
  'not-installed': { label: '未安装', tone: 'mute' },
  'local-only': { label: '非官方来源', tone: 'warn' },
};

const STATE_FILTERS = [
  { value: 'all', label: '全部状态' },
  { value: 'installed', label: '已安装' },
  { value: 'not-installed', label: '未安装' },
  { value: 'update-available', label: '可更新' },
  { value: 'modified', label: '内容已改动' },
  { value: 'local-only', label: '非官方来源' },
];

function humanMB(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

export async function mount(host, ctx) {
  const { store } = ctx;
  const disposers = [];

  let tab = 'installed';
  let data = null; // plugins.list() 的结果
  let kernelsInstance = null;
  const vs = { query: '', state: 'all' };

  /* --------------------------------------------------------------- 结构 */

  const installedTabBtn = h('button.btn', {
    type: 'button',
    title: '查看已安装的插件（等于原来「内核」页的内容）',
    on: { click: () => switchTab('installed') },
  }, h('span', { textContent: '已安装' }));

  const catalogTabBtn = h('button.btn', {
    type: 'button',
    title: '从插件仓库安装新插件',
    on: { click: () => switchTab('catalog') },
  }, h('span', { textContent: '可安装' }));

  const tabBar = h('div.toolbar', null, installedTabBtn, catalogTabBtn);

  const progressStrip = h('div.strip');
  const installedHost = h('div');
  const catalogHost = h('div');

  const wrap = h('div.view-inner', { dataset: { view: 'plugins' } },
    h('div.view-head', null,
      h('div.view-crumb', { textContent: 'KernelHub Studio' }),
      h('h1.view-title', { textContent: '插件' }),
      h('div.view-sub', {
        textContent: '壳本身不含内核；插件从独立仓库按需下载到用户工作区，每个插件自带自己的依赖。',
      }),
      h('div.view-rule')
    ),
    tabBar,
    progressStrip,
    installedHost,
    catalogHost
  );
  host.appendChild(wrap);

  /* ------------------------------------------------- 可安装：目录界面 */

  const searchInput = h('input.input', {
    type: 'text',
    placeholder: '搜索插件名 / id / 格式',
    'aria-label': '搜索插件',
  });

  const stateSelect = h('select.select', { 'aria-label': '插件状态' });
  for (const item of STATE_FILTERS) stateSelect.appendChild(h('option', { value: item.value, textContent: item.label }));

  const refreshBtn = h('button.btn', {
    type: 'button',
    title: '重新拉取插件目录（catalog.json）',
    on: { click: () => reload(true) },
  }, h('span', { textContent: '刷新目录' }));

  const openDirBtn = h('button.btn', {
    type: 'button',
    title: '在资源管理器中打开插件目录',
    on: { click: () => openDir() },
  }, h('span', { textContent: '打开插件目录' }));

  const infoStrip = h('div.strip');
  const tableHost = h('div');
  const footEl = h('div.footline');

  catalogHost.appendChild(h('div.toolbar', null,
    h('div', { style: { width: '260px' } }, searchInput),
    h('div.selectwrap', { style: { width: '150px' } }, stateSelect),
    h('div.toolbar__right', null, refreshBtn, openDirBtn)
  ));
  catalogHost.appendChild(infoStrip);
  catalogHost.appendChild(tableHost);
  catalogHost.appendChild(footEl);

  /* --------------------------------------------------- 标签页切换 */

  async function switchTab(next) {
    tab = next;
    installedTabBtn.className = tab === 'installed' ? 'btn btn--primary' : 'btn';
    catalogTabBtn.className = tab === 'catalog' ? 'btn btn--primary' : 'btn';
    installedHost.hidden = tab !== 'installed';
    catalogHost.hidden = tab !== 'catalog';

    if (tab === 'installed') {
      if (!kernelsInstance) {
        // 复用原来的内核页，只是把它的标题栏去掉（embed），避免两层标题
        const mod = await import('./kernels.js');
        kernelsInstance = await mod.mount(installedHost, { ...ctx, embed: true });
      }
    } else {
      if (!data) await reload(false);
    }
  }

  /* ------------------------------------------------- 可安装：渲染 */

  function iconButton(iconName, title, onClick, disabled) {
    return iconAction({
      label: title,
      disabled,
      stop: true,
      children: [icon(iconName, { size: 14 })],
      onClick,
    });
  }

  /** 目录行 × 本机内核状态（装了但不一定能用，原因要能看见） */
  function kernelOf(id) {
    return (store.pick('kernels') || []).find((k) => k && k.id === id) || null;
  }

  function rows() {
    const list = (data && data.plugins) || [];
    const q = vs.query.trim().toLowerCase();
    return list.filter((p) => {
      if (vs.state !== 'all' && p.state !== vs.state) return false;
      if (!q) return true;
      const hay = [p.id, p.name, p.description, (p.tags || []).join(' '), (p.ops || []).join(' '), (p.external || []).join(' ')]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }

  function renderInfo() {
    clear(infoStrip);
    if (!data) return;
    if (data.error) {
      infoStrip.className = 'strip strip--warn';
      infoStrip.appendChild(h('span', { textContent: `目录拉取失败：${data.error}（显示的是本地缓存）` }));
      return;
    }
    infoStrip.className = data.source === 'cache' ? 'strip strip--warn' : 'strip strip--ok';
    const bits = [
      `下载方式：${data.mode === 'git' ? 'git 稀疏克隆' : `HTTPS 多连接（${(store.pick('settings') || {}).pluginDownloadConns || 4} 连接）`}${data.git ? '' : '（未检测到 git）'}`,
      `已安装 ${data.installedCount} / 共 ${data.plugins.length}`,
    ];
    if (data.catalog && data.catalog.updated) bits.push(`目录更新于 ${data.catalog.updated}`);
    if (data.source === 'cache') bits.push('用的是本地缓存的目录');
    infoStrip.appendChild(h('span', { textContent: bits.join('　·　') }));
  }

  function renderProgress(payload) {
    clear(progressStrip);
    if (!payload) {
      progressStrip.hidden = true;
      return;
    }
    progressStrip.hidden = false;
    const pct = Number(payload.percent) || 0;
    progressStrip.className = payload.phase === 'error' ? 'strip strip--err' : 'strip strip--ok';
    progressStrip.appendChild(h('span', { textContent: `${payload.message || payload.phase} ` }));
    if (pct > 0 && pct < 100) {
      progressStrip.appendChild(
        h('div.progress', { style: { width: '200px', display: 'inline-block', marginLeft: '8px' } },
          h('div.progress__fill', { style: { width: `${Math.max(2, pct)}%` } })
        )
      );
    }
  }

  function dependencyText(p) {
    const bits = [];
    if (p.requires && p.requires.length) bits.push(`Python: ${p.requires.join(', ')}`);
    if (p.vendorSize) bits.push(`自带依赖 ${humanMB(p.vendorSize)}`);
    if (p.external && p.external.length) bits.push(`需外部程序: ${p.external.join(' / ')}`);
    return bits.join('；') || '无额外依赖';
  }

  function renderCatalog() {
    renderInfo();
    clear(tableHost);
    const list = rows();

    if (!data) {
      tableHost.appendChild(h('div.empty', null,
        h('div.empty__title', { textContent: '正在读取插件目录…' }),
        h('div.empty__text', { textContent: '首次会自动从 GitHub 拉取 catalog.json。' })
      ));
      return;
    }
    if (!list.length) {
      tableHost.appendChild(h('div.empty', null,
        h('div.empty__title', { textContent: '没有匹配的插件' }),
        h('div.empty__text', { textContent: '换个关键词或状态筛选再试。' })
      ));
      return;
    }

    const tbody = h('tbody');
    for (const p of list) {
      const meta = STATE_META[p.state] || { label: p.state, tone: 'mute' };
      const isInstalled = ['installed', 'update-available', 'modified', 'local-only'].includes(p.state);
      const canInstall = Boolean(p.path);
      const k = isInstalled ? kernelOf(p.id) : null;

      tbody.appendChild(h('tr', { dataset: { plugin: p.id }, title: p.description || p.id, class: 'jobrow' },
        h('td', null, statusBadge(meta.label, meta.tone)),
        h('td', { class: 'truncate' },
          h('div', null,
            h('span', { textContent: p.name || p.id }),
            h('span.dim', { textContent: ' ' }),
            h('span.mono.dim', { textContent: p.id })
          ),
          h('div.dim', { style: { fontSize: '11px' }, textContent: dependencyText(p) })
        ),
        // 装了不等于能用：这一列直接给出内核状态与原因，省得去别处找
        h('td', { class: 'truncate' },
          k
            ? h('span', {
                textContent: `${k.statusLabel || k.status}${k.detail && k.status !== 'ready' ? '：' + k.detail : ''}`,
                title: k.detail || k.engineNote || '',
              })
            : h('span.dim', { textContent: '—' })
        ),
        h('td', { class: 'num mono', textContent: p.version || '—' }),
        h('td', { class: 'num mono', textContent: humanMB(p.size) }),
        h('td', { class: 'num mono', textContent: String(p.capabilities || 0) }),
        h('td', null,
          h('div.rowactions', null,
            iconButton('download', canInstall ? `安装 ${p.id}（约 ${humanMB(p.size)}）` : '不在官方目录中，无法安装',
              () => installOne(p, false), !canInstall || isInstalled),
            iconButton('retry', `重新安装 / 更新到 ${p.version}`,
              () => installOne(p, true), !canInstall || !isInstalled),
            iconButton('trash', `卸载 ${p.id}`, () => uninstallOne(p), !isInstalled),
            iconButton('external', '在资源管理器中打开该插件目录', () => revealOne(p), !isInstalled)
          )
        )
      ));
    }

    tableHost.appendChild(h('table.table', null,
      h('thead', null, h('tr', null,
        h('th', { textContent: '状态' }),
        h('th', { textContent: '插件' }),
        h('th', { textContent: '内核状态' }),
        h('th', { textContent: '版本' }),
        h('th', { textContent: '体积' }),
        h('th', { textContent: '能力' }),
        h('th', { textContent: '操作' })
      )),
      tbody
    ));

    clear(footEl);
    footEl.appendChild(h('span', { textContent: `显示 ${list.length} / 共 ${data.plugins.length} 个插件` }));
    footEl.appendChild(h('span', { textContent: `· 安装位置 ${data.pluginsDir || ''}` }));
  }

  /* ------------------------------------------------- 可安装：动作 */

  async function reload(refresh) {
    refreshBtn.disabled = true;
    try {
      data = await window.khs.plugins.list({ refresh: Boolean(refresh) });
      renderCatalog();
    } catch (err) {
      ctx.reportError('读取插件目录失败', ctx.wrapError(err));
    } finally {
      refreshBtn.disabled = false;
    }
  }

  /**
   * 装完必须刷新内核与格式，否则新插件提供的格式选不到 —— 那就是「装完用不了」。
   * 刷新后如果内核仍不可用，直接把原因说出来（多半是缺外部程序）。
   */
  async function afterChange(id, verb) {
    await ctx.refreshKernels({ announce: false });
    await reload(false);
    const k = kernelOf(id);
    if (k && k.status === 'ready') {
      ctx.toast.success(`${verb}完成，内核已可用`, { text: `${k.name || id}　${k.engineNote || ''}` });
    } else if (k) {
      ctx.toast.warn(`${verb}完成，但内核当前不可用`, {
        text: `${k.statusLabel || k.status}：${k.detail || '原因未知'}${k.installHint ? `\n需要：${k.installHint}` : ''}`,
      });
    } else {
      ctx.toast.info(`${verb}完成`, { text: '该插件未提供内核，或清单异常；到「已安装」标签查看。' });
    }
  }

  async function installOne(p, isUpdate) {
    const verb = isUpdate ? '重新安装' : '安装';
    const ok = await ctx.modal.confirm(`${verb}插件「${p.name || p.id}」？`, {
      okLabel: verb,
      detail: [
        `版本：${p.version}`,
        `需要下载：${humanMB(p.size)}${p.vendorSize ? `（其中自带依赖 ${humanMB(p.vendorSize)}）` : ''}`,
        p.external && p.external.length ? `装完还需要系统 PATH 里有：${p.external.join(' / ')}` : '不需要额外的外部程序',
      ].join('\n'),
    });
    if (!ok) return;

    renderProgress({ phase: 'start', percent: 0, message: `${verb} ${p.id}…` });
    try {
      const res = isUpdate && p.state !== 'not-installed'
        ? await window.khs.plugins.update(p.id)
        : await window.khs.plugins.install(p.id);
      if (!res || !res.ok) {
        const msg = (res && res.error) || '未知错误';
        ctx.reportError(`${verb}失败`, ctx.wrapError(new Error(msg)));
        renderProgress({ phase: 'error', percent: 0, message: `${verb}失败：${msg}` });
        return;
      }
      renderProgress({ phase: 'done', percent: 100, message: `${p.id} 已就绪` });
      await afterChange(p.id, verb);
    } catch (err) {
      ctx.reportError(`${verb}异常`, ctx.wrapError(err));
    } finally {
      setTimeout(() => renderProgress(null), 4000);
    }
  }

  async function uninstallOne(p) {
    const ok = await ctx.modal.confirm(`卸载插件「${p.name || p.id}」？`, {
      okLabel: '卸载',
      danger: true,
      detail: `会删除 ${p.dir || p.id} 目录（${humanMB(p.installedBytes || p.size)}）。\n对应的内核会立刻从转换页消失。`,
    });
    if (!ok) return;
    try {
      const res = await window.khs.plugins.uninstall(p.id);
      if (!res || !res.ok) {
        ctx.reportError('卸载失败', ctx.wrapError(new Error((res && res.error) || '未知错误')));
        return;
      }
      await ctx.refreshKernels({ announce: false });
      await reload(false);
      ctx.toast.success('已卸载', { text: p.id });
    } catch (err) {
      ctx.reportError('卸载异常', ctx.wrapError(err));
    }
  }

  async function revealOne(p) {
    try {
      await window.khs.plugins.reveal(p.id);
    } catch (err) {
      ctx.reportError('打开目录失败', ctx.wrapError(err));
    }
  }

  async function openDir() {
    try {
      await window.khs.plugins.openDir();
    } catch (err) {
      ctx.reportError('打开插件目录失败', ctx.wrapError(err));
    }
  }

  /* ------------------------------------------------- 事件 */

  disposers.push(on(searchInput, 'input', () => {
    vs.query = searchInput.value;
    renderCatalog();
  }));
  disposers.push(on(stateSelect, 'change', () => {
    vs.state = stateSelect.value;
    renderCatalog();
  }));
  disposers.push(window.khs.on('evt:plugin:progress', (payload) => {
    if (tab === 'catalog') renderProgress(payload);
  }));
  // 内核列表变化时，已安装数量与目录里的「内核状态」列都要跟着更新
  disposers.push(store.subscribe((s, changed) => {
    if (tab === 'catalog' && changed.includes('kernels')) renderCatalog();
  }));

  await switchTab('installed');

  return {
    unmount() {
      if (kernelsInstance) {
        try {
          kernelsInstance.unmount();
        } catch {
          /* ignore */
        }
        kernelsInstance = null;
      }
      while (disposers.length) {
        const dispose = disposers.pop();
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
      clear(host);
    },
  };
}
