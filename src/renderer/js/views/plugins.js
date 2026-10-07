/**
 * views/plugins.js —— 插件
 *
 * 2.0.0 的核心变化：**壳里没有任何内核**，插件按需从独立仓库下载到用户工作区。
 * 这一页就是那个「按需」的入口：拉目录、看体积、装 / 更新 / 卸 / 校验。
 *
 * 版面：工具栏 3 个控件（搜索 / 状态筛选 / 刷新+打开目录），表格每行 2 个图标动作。
 *
 * 数据全部来自 window.khs.plugins.*（主进程 PluginStore），界面不预设任何插件名。
 * 安装过程的进度通过 evt:plugin:progress 实时推过来。
 */

import { h, clear, on, iconAction } from '../dom.js';
import { icon } from '../icons.js';
import { statusBadge } from '../layout.js';

/** 插件状态 → 文案与色调 */
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

  const vs = { query: '', state: 'all' };
  let data = null; // plugins.list() 的结果

  /* --------------------------------------------------------------- 结构 */

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
  const progressStrip = h('div.strip');
  const tableHost = h('div');
  const footEl = h('div.footline');

  const wrap = h('div.view-inner', { dataset: { view: 'plugins' } },
    h('div.view-head', null,
      h('div.view-crumb', { textContent: 'KernelHub Studio' }),
      h('h1.view-title', { textContent: '插件' }),
      h('div.view-sub', {
        textContent: '壳本身不含内核；插件从独立仓库按需下载到用户工作区，每个插件自带自己的依赖。',
      }),
      h('div.view-rule')
    ),
    h('div.toolbar', null,
      h('div', { style: { width: '260px' } }, searchInput),
      h('div.selectwrap', { style: { width: '150px' } }, stateSelect),
      h('div.toolbar__right', null, refreshBtn, openDirBtn)
    ),
    infoStrip,
    progressStrip,
    tableHost,
    footEl
  );
  host.appendChild(wrap);

  /* --------------------------------------------------------------- 渲染 */

  function iconButton(iconName, title, onClick, disabled) {
    return iconAction({
      label: title,
      disabled,
      stop: true,
      children: [icon(iconName, { size: 14 })],
      onClick,
    });
  }

  function rows() {
    const list = (data && data.plugins) || [];
    const q = vs.query.trim().toLowerCase();
    return list.filter((p) => {
      if (vs.state !== 'all' && p.state !== vs.state) return false;
      if (!q) return true;
      const hay = [
        p.id, p.name, p.description,
        (p.tags || []).join(' '),
        (p.ops || []).join(' '),
        (p.external || []).join(' '),
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  function renderInfo() {
    clear(infoStrip);
    if (!data) return;
    const bits = [];
    bits.push(`下载方式：${data.mode === 'git' ? 'git 稀疏克隆' : 'HTTPS 下载'}${data.git ? '' : '（未检测到 git）'}`);
    bits.push(`已安装 ${data.installedCount} / 共 ${data.plugins.length}`);
    if (data.catalog) bits.push(`目录更新于 ${data.catalog.updated || '未知'}`);
    infoStrip.appendChild(h('span', { textContent: bits.join('　·　') }));
    if (data.error) {
      infoStrip.className = 'strip strip--warn';
      infoStrip.appendChild(h('span', { textContent: `　目录拉取失败：${data.error}（显示的是本地缓存）` }));
    } else if (data.source === 'cache') {
      infoStrip.className = 'strip strip--warn';
      infoStrip.appendChild(h('span', { textContent: '　用的是本地缓存的目录' }));
    } else {
      infoStrip.className = 'strip strip--ok';
    }
  }

  function renderProgress(payload) {
    clear(progressStrip);
    if (!payload) return;
    const pct = Number(payload.percent) || 0;
    progressStrip.className = payload.phase === 'error' ? 'strip strip--err' : 'strip strip--ok';
    progressStrip.appendChild(h('span', { textContent: `${payload.message || payload.phase} ` }));
    if (pct > 0 && pct < 100) {
      progressStrip.appendChild(h('div.progress', { style: { width: '180px', display: 'inline-block', marginLeft: '8px' } },
        h('div.progress__fill', { style: { width: `${Math.max(2, pct)}%` } })
      ));
    }
  }

  function dependencyText(p) {
    const bits = [];
    if (p.requires && p.requires.length) bits.push(`Python: ${p.requires.join(', ')}`);
    if (p.vendorSize) bits.push(`自带依赖 ${humanMB(p.vendorSize)}`);
    if (p.external && p.external.length) bits.push(`需外部程序: ${p.external.join(' / ')}`);
    return bits.join('；') || '无额外依赖';
  }

  function render() {
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
      const isInstalled = p.state === 'installed' || p.state === 'update-available' || p.state === 'modified' || p.state === 'local-only';
      const canInstall = Boolean(p.path);
      const needsUpdate = p.state === 'update-available' || p.state === 'modified';

      tbody.appendChild(h('tr', {
        dataset: { plugin: p.id },
        title: p.description || p.id,
        class: 'jobrow',
      },
        h('td', null, statusBadge(meta.label, meta.tone)),
        h('td', { class: 'truncate' },
          h('div', null,
            h('span', { textContent: p.name || p.id }),
            h('span.dim', { textContent: ' ' }),
            h('span.mono.dim', { textContent: p.id })
          ),
          h('div.dim', { style: { fontSize: '11px' }, textContent: dependencyText(p) })
        ),
        h('td', { class: 'num mono', textContent: p.version || '—' }),
        h('td', { class: 'num mono', textContent: humanMB(p.size) }),
        h('td', { class: 'num mono', textContent: String(p.capabilities || 0) }),
        h('td', { class: 'num mono', textContent: (p.ops || []).join(' / ') || '—' }),
        h('td', null,
          h('div.rowactions', null,
            iconButton('download', canInstall ? `安装 ${p.id}（约 ${humanMB(p.size)}）` : '不在官方目录中，无法安装',
              () => installOne(p), !canInstall || isInstalled),
            iconButton('retry', `重新安装 / 更新到 ${p.version}`,
              () => installOne(p, true), !canInstall || !isInstalled),
            iconButton('trash', `卸载 ${p.id}`, () => uninstallOne(p), !isInstalled),
            iconButton('external', '在资源管理器中打开该插件目录', () => revealOne(p), !isInstalled)
          )
        )
      ));
    }

    tableHost.appendChild(h('table.table', null,
      h('thead', null,
        h('tr', null,
          h('th', { textContent: '状态' }),
          h('th', { textContent: '插件' }),
          h('th', { textContent: '版本' }),
          h('th', { textContent: '体积' }),
          h('th', { textContent: '能力' }),
          h('th', { textContent: '操作类型' }),
          h('th', { textContent: '操作' })
        )
      ),
      tbody
    ));

    clear(footEl);
    footEl.appendChild(h('span', { textContent: `显示 ${list.length} / 共 ${data.plugins.length} 个插件` }));
    footEl.appendChild(h('span', { textContent: `· 安装位置 ${data.pluginsDir || ''}` }));
  }

  /* --------------------------------------------------------------- 动作 */

  async function reload(refresh) {
    refreshBtn.disabled = true;
    try {
      data = await window.khs.plugins.list({ refresh: Boolean(refresh) });
      render();
    } catch (err) {
      ctx.reportError('读取插件目录失败', ctx.wrapError(err));
    } finally {
      refreshBtn.disabled = false;
    }
  }

  async function installOne(p, isUpdate) {
    const verb = isUpdate ? '重新安装' : '安装';
    const ok = await ctx.modal.confirm(
      `${verb}插件「${p.name || p.id}」？`,
      {
        okLabel: verb,
        detail: [
          `版本：${p.version}`,
          `需要下载：${humanMB(p.size)}${p.vendorSize ? `（其中自带依赖 ${humanMB(p.vendorSize)}）` : ''}`,
          p.external && p.external.length ? `装完还需要系统 PATH 里有：${p.external.join(' / ')}` : '不需要额外的外部程序',
        ].join('\n'),
      }
    );
    if (!ok) return;

    progressStrip.className = 'strip';
    clear(progressStrip);
    progressStrip.appendChild(h('span', { textContent: `${verb} ${p.id}…` }));

    try {
      const res = isUpdate && p.state !== 'not-installed'
        ? await window.khs.plugins.update(p.id)
        : await window.khs.plugins.install(p.id);
      if (!res || !res.ok) {
        ctx.reportError(`${verb}失败`, ctx.wrapError(new Error((res && res.error) || '未知错误')));
        renderProgress({ phase: 'error', percent: 0, message: `${verb}失败：${(res && res.error) || '未知错误'}` });
      } else {
        ctx.toast.success(`${verb}完成`, { text: `${p.id} ${res.version || ''}　${humanMB(res.bytes)}${res.fallback ? '（HTTPS 回退）' : ''}` });
        renderProgress({ phase: 'done', percent: 100, message: `${p.id} 已安装` });
        await reload(false);
        // 内核表也要跟着变，通知 app 层去刷新（refreshKernels 收的是选项对象）
        if (typeof ctx.refreshKernels === 'function') await ctx.refreshKernels({ announce: false });
      }
    } catch (err) {
      ctx.reportError(`${verb}异常`, ctx.wrapError(err));
    } finally {
      renderProgress(null);
    }
  }

  async function uninstallOne(p) {
    const ok = await ctx.modal.confirm(`卸载插件「${p.name || p.id}」？`, {
      okLabel: '卸载',
      danger: true,
      detail: `会删除 ${p.dir || p.id} 目录（${humanMB(p.installedBytes || p.size)}）。\n对应的内核会立刻从「内核」页消失。`,
    });
    if (!ok) return;
    try {
      const res = await window.khs.plugins.uninstall(p.id);
      if (!res || !res.ok) {
        ctx.reportError('卸载失败', ctx.wrapError(new Error((res && res.error) || '未知错误')));
        return;
      }
      ctx.toast.success('已卸载', { text: p.id });
      await reload(false);
      if (typeof ctx.refreshKernels === 'function') await ctx.refreshKernels({ announce: false });
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

  /* --------------------------------------------------------------- 事件 */

  disposers.push(on(searchInput, 'input', () => {
    vs.query = searchInput.value;
    render();
  }));
  disposers.push(on(stateSelect, 'change', () => {
    vs.state = stateSelect.value;
    render();
  }));
  disposers.push(window.khs.on('evt:plugin:progress', (payload) => renderProgress(payload)));

  await reload(false);

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
