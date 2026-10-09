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

import { h, clear, on, iconAction, copyText } from '../dom.js';
import { icon } from '../icons.js';
import { statusBadge } from '../layout.js';
import { createSegmented } from '../segmented.js';
import { t, statusText } from '../i18n.js';
import { depsFailureDetail } from '../depsReason.js';

/** 插件安装状态 → 文案与色调 */
const STATE_META = {
  installed: { label: t('已安装'), tone: 'ok' },
  'update-available': { label: t('可更新'), tone: 'accent' },
  modified: { label: t('内容已改动'), tone: 'warn' },
  'not-installed': { label: t('未安装'), tone: 'mute' },
  'local-only': { label: t('非官方来源'), tone: 'warn' },
};

const STATE_FILTERS = [
  { value: 'all', label: t('全部状态') },
  { value: 'installed', label: t('已安装') },
  { value: 'not-installed', label: t('未安装') },
  { value: 'update-available', label: t('可更新') },
  { value: 'modified', label: t('内容已改动') },
  { value: 'local-only', label: t('非官方来源') },
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

  // 分段选项卡：指示条会滑过去，而不是两个按钮硬切背景色
  const tabBar = createSegmented({
    ariaLabel: t('插件视图'),
    value: 'installed',
    items: [
      { value: 'installed', label: t('已安装'), title: t('查看已安装的插件（等于原来「内核」页的内容）') },
      { value: 'catalog', label: t('可安装'), title: t('从插件仓库安装新插件') },
    ],
    onChange: (next) => switchTab(next),
  });

  const progressStrip = h('div.strip');
  const installedHost = h('div');
  const catalogHost = h('div');

  const wrap = h('div.view-inner', { dataset: { view: 'plugins' } },
    h('div.view-head', null,
      h('h1.view-title', { textContent: t('插件') }),
      h('div.view-rule')
    ),
    h('div.toolbar', null, tabBar.el),
    progressStrip,
    installedHost,
    catalogHost
  );
  host.appendChild(wrap);

  /* ------------------------------------------------- 可安装：目录界面 */

  const searchInput = h('input.input', {
    type: 'text',
    placeholder: t('搜索插件名 / id / 格式'),
    'aria-label': t('搜索插件'),
  });

  const stateSelect = h('select.select', { 'aria-label': t('插件状态') });
  for (const item of STATE_FILTERS) stateSelect.appendChild(h('option', { value: item.value, textContent: item.label }));

  const refreshBtn = h('button.btn', {
    type: 'button',
    title: t('重新拉取插件目录（catalog.json）'),
    on: { click: () => reload(true) },
  }, h('span', { textContent: t('刷新目录') }));

  const openDirBtn = h('button.btn', {
    type: 'button',
    title: t('在资源管理器中打开插件目录'),
    on: { click: () => openDir() },
  }, h('span', { textContent: t('打开插件目录') }));

  const infoStrip = h('div.strip');
  const tableHost = h('div');

  catalogHost.appendChild(h('div.toolbar', null,
    h('div', { style: { width: '260px' } }, searchInput),
    h('div.selectwrap', { style: { width: '150px' } }, stateSelect),
    h('div.toolbar__right', null, refreshBtn, openDirBtn)
  ));
  catalogHost.appendChild(infoStrip);
  catalogHost.appendChild(tableHost);

  /* --------------------------------------------------- 标签页切换 */

  async function switchTab(next) {
    tab = next;
    // 让指示条滑过去（代码切换时也要同步，否则指示条会停在旧位置）
    tabBar.select(next, true);
    installedHost.hidden = tab !== 'installed';
    catalogHost.hidden = tab !== 'catalog';

    if (tab === 'installed') {
      if (!kernelsInstance) {
        // 复用原来的内核页，只是把它的标题栏去掉（embed），避免两层标题
        const mod = await import('./kernels.js');
        kernelsInstance = await mod.mount(installedHost, { ...ctx, embed: true });
      } else if (typeof kernelsInstance.publishStatus === 'function') {
        // 切回「已安装」时把它的实时信息重新推上去，否则右下角还留着「可安装」的数字
        kernelsInstance.publishStatus();
      }
    } else {
      if (!data) await reload(false);
      else publishCatalogStatus();
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
      // 搜索同时命中显示名与代码层面的原名 / id，两种叫法都能搜到
      const hay = [p.id, p.name, p.displayName, p.description, (p.tags || []).join(' '), (p.ops || []).join(' '), (p.external || []).join(' ')]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }

  /**
   * 目录状态条。
   *
   * 2.0.4 起这里**只在异常时出现**：正常情况的「下载方式 / 已安装 N / 共 M / 目录更新于」
   * 都是实时信息，统一推到状态栏右下角了（见 renderCatalog 末尾）。
   * 否则每条正常信息都占一行，页面顶部永远挂着一块没人看的横条。
   */
  function renderInfo() {
    clear(infoStrip);
    infoStrip.hidden = true;
    if (!data) return;

    if (data.error) {
      infoStrip.hidden = false;
      infoStrip.className = 'strip strip--warn';
      infoStrip.appendChild(h('span', { textContent: t('目录拉取失败：{0}（显示的是本地缓存）', { 0: data.error }) }));
      return;
    }
    if (data.source === 'cache') {
      infoStrip.hidden = false;
      infoStrip.className = 'strip strip--warn';
      const bits = ['用的是本地缓存的目录——点「刷新目录」可重新拉取'];
      if (data.catalog && data.catalog.updated) bits.push(t('缓存更新于 {0}', { 0: data.catalog.updated }));
      infoStrip.appendChild(h('span', { textContent: bits.join('　·　') }));
    }
  }

  /** 把目录信息推进状态栏右下角（正常态的那部分实时信息） */
  function publishCatalogStatus(filteredCount) {
    if (!data) return;
    const bits = [
      t('已安装 {0} / 共 {1} 个插件', { 0: data.installedCount, 1: data.plugins.length }),
      t('当前显示 {0} 个', { 0: Number.isFinite(filteredCount) ? filteredCount : data.plugins.length }),
      t('下载方式 {0}', { 0: data.mode === 'git' ? 'git 稀疏克隆' : 'HTTPS 多连接' }),
    ];
    if (data.catalog && data.catalog.updated) bits.push(t('目录更新于 {0}', { 0: data.catalog.updated }));
    ctx.setStatusInfo(bits);
  }

  /**
   * 安装进度条。
   *
   * 2.0.3 的三点改动：
   *   1. 进度条加粗（CSS 里 .progress 4→6px）、加宽，进度不再是一根看不清的细线
   *   2. 百分比数字单列一栏、等宽字体，数字变化时不会把文字挤来挤去（tabular-nums）
   *   3. 还没收到第一个进度事件时用「未知进度」呼吸态，而不是显示一条空轨道
   */
  const progressFill = h('div.progress__fill');
  const progressPct = h('span.progress__pct', { textContent: '' });
  const progressBar = h('div.progress.progress--install', null, progressFill);
  const progressRow = h('div.progress-row', null, progressBar, progressPct);
  let progressVisiblePct = null;

  function renderProgress(payload) {
    if (!payload) {
      progressStrip.hidden = true;
      progressVisiblePct = null;
      return;
    }
    progressStrip.hidden = false;
    const pct = Number(payload.percent);
    const known = Number.isFinite(pct) && pct > 0;
    progressStrip.className = payload.phase === 'error' ? 'strip strip--err' : 'strip strip--ok';

    // 文案用 textContent 就地更新，避免整块重建导致进度条重新播放动画
    let label = progressStrip.querySelector('.progress-label');
    if (!label) {
      label = h('span.progress-label');
      clear(progressStrip);
      progressStrip.appendChild(label);
      progressStrip.appendChild(progressRow);
    }
    label.textContent = payload.message || payload.phase || '';

    if (payload.phase === 'error' || payload.phase === 'done' || !known) {
      progressBar.classList.toggle('progress--indeterminate', payload.phase !== 'error' && payload.phase !== 'done');
      progressPct.textContent = '';
      if (payload.phase === 'done') {
        progressBar.classList.remove('progress--indeterminate');
        progressFill.style.width = '100%';
      }
      progressVisiblePct = null;
      return;
    }

    progressBar.classList.remove('progress--indeterminate');
    progressFill.style.width = `${Math.min(100, Math.max(2, pct))}%`;
    // 只在整数百分比变化时写 DOM，减少无谓更新
    const rounded = Math.round(pct);
    if (rounded !== progressVisiblePct) {
      progressVisiblePct = rounded;
      progressPct.textContent = `${rounded}%`;
    }
  }

  function dependencyText(p) {
    const bits = [];
    if (p.requires && p.requires.length) bits.push(`Python: ${p.requires.join(', ')}`);
    if (p.vendorSize) bits.push(t('自带依赖 {0}', { 0: humanMB(p.vendorSize) }));
    if (p.external && p.external.length) bits.push(t('需外部程序: {0}', { 0: p.external.join(' / ') }));
    return bits.join('；') || '无额外依赖';
  }

  function renderCatalog() {
    renderInfo();
    clear(tableHost);
    const list = rows();

    if (!data) {
      tableHost.appendChild(h('div.empty', null,
        h('div.empty__title', { textContent: t('正在读取插件目录…') }),
        h('div.empty__text', { textContent: t('首次会自动从 GitHub 拉取 catalog.json。') })
      ));
      return;
    }
    if (!list.length) {
      tableHost.appendChild(h('div.empty', null,
        h('div.empty__title', { textContent: t('没有匹配的插件') }),
        h('div.empty__text', { textContent: t('换个关键词或状态筛选再试。') })
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
            h('span', { textContent: p.displayName || p.name || p.id }),
            h('span.dim', { textContent: ' ' }),
            h('span.mono.dim', { textContent: p.id })
          ),
          h('div.dim', { style: { fontSize: '11px' }, textContent: dependencyText(p) })
        ),
        // 装了不等于能用：这一列直接给出内核状态与原因，省得去别处找
        h('td', { class: 'truncate' },
          k
            ? h('span', {
                textContent: `${statusText(k.status, k.statusLabel)}${k.detail && k.status !== 'ready' ? '：' + k.detail : ''}`,
                title: k.detail || k.engineNote || '',
              })
            : h('span.dim', { textContent: '—' })
        ),
        h('td', { class: 'num mono', textContent: p.version || '—' }),
        h('td', { class: 'num mono', textContent: humanMB(p.size) }),
        h('td', { class: 'num mono', textContent: String(p.capabilities || 0) }),
        h('td', null,
          h('div.rowactions', null,
            iconButton('download', canInstall ? t('安装 {0}（约 {1}）', { 0: p.id, 1: humanMB(p.size) }) : '不在官方目录中，无法安装',
              () => installOne(p, false), !canInstall || isInstalled),
            iconButton('retry', t('重新安装 / 更新到 {0}', { 0: p.version }),
              () => installOne(p, true), !canInstall || !isInstalled),
            /*
             * 2.3.0：装了但内核起不来（多半是缺依赖）时，给一个**带文字**的按钮。
             * 以前这里是个下载图标（并列在 5 个图标里、只有悬停才说明），
             * 用户根本看不出这里是「自动补装依赖」，于是自己去终端 pip install。
             */
            isInstalled && k && k.status !== 'ready'
              ? h('button.btn.btn--sm', {
                type: 'button',
                title: t('自动安装依赖'),
                on: {
                  click: (ev) => {
                    ev.stopPropagation();
                    runDepsInstall(p.id, null);
                  },
                },
              }, h('span', { textContent: t('安装依赖') }))
              : null,
            iconButton('trash', t('卸载 {0}', { 0: p.id }), () => uninstallOne(p), !isInstalled),
            iconButton('external', t('在资源管理器中打开该插件目录'), () => revealOne(p), !isInstalled)
          )
        )
      ));
    }

    tableHost.appendChild(h('table.table.table--center', null,
      h('thead', null, h('tr', null,
        h('th', { textContent: t('状态') }),
        h('th', { textContent: t('插件') }),
        h('th', { textContent: t('内核状态') }),
        h('th', { textContent: t('版本') }),
        h('th', { textContent: t('体积') }),
        h('th', { textContent: t('能力') }),
        h('th', { textContent: t('操作') })
      )),
      tbody
    ));

    publishCatalogStatus(list.length);
  }

  /* ------------------------------------------------- 可安装：动作 */

  async function reload(refresh) {
    refreshBtn.disabled = true;
    try {
      data = await window.khs.plugins.list({ refresh: Boolean(refresh) });
      renderCatalog();
      // 首次拉到插件目录时，判重集合才完整（可能补上限定名），内核列表要轻量重取一次
      if (data && data.namesChanged && typeof ctx.loadKernels === 'function') {
        await ctx.loadKernels({ silent: true });
      }
    } catch (err) {
      ctx.reportError(t('读取插件目录失败'), ctx.wrapError(err));
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
      ctx.toast.success(t('{0}完成，内核已可用', { 0: verb }), { text: `${k.name || id}　${k.engineNote || ''}` });
    } else if (k) {
      ctx.toast.warn(t('{0}完成，但内核当前不可用', { 0: verb }), {
        text: `${statusText(k.status, k.statusLabel)}：${k.detail || '原因未知'}${k.installHint ? `\n需要：${k.installHint}` : ''}`,
      });
    } else {
      ctx.toast.info(t('{0}完成', { 0: verb }), { text: t('该插件未提供内核，或清单异常；到「已安装」标签查看。') });
    }
  }

  async function installOne(p, isUpdate) {
    const verb = isUpdate ? '重新安装' : '安装';
    const ok = await ctx.modal.confirm(t('{0}插件「{1}」？', { 0: verb, 1: p.displayName || p.name || p.id }), {
      okLabel: verb,
      detail: [
        t('版本：{0}', { 0: p.version }),
        `需要下载：${humanMB(p.size)}${p.vendorSize ? `（其中自带依赖 ${humanMB(p.vendorSize)}）` : ''}`,
        p.external && p.external.length ? t('装完还需要系统 PATH 里有：{0}', { 0: p.external.join(' / ') }) : '不需要额外的外部程序',
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
        ctx.reportError(t('{0}失败', { 0: verb }), ctx.wrapError(new Error(msg)));
        renderProgress({ phase: 'error', percent: 0, message: t('{0}失败：{1}', { 0: verb, 1: msg }) });
        return;
      }
      renderProgress({ phase: 'done', percent: 100, message: t('{0} 已就绪', { 0: p.id }) });
      await afterChange(p.id, verb);
      // 2.1.0：装完顺手查一次依赖，缺东西就问用户要不要自动装
      await promptInstallDeps(p.id, res && res.kernel);
    } catch (err) {
      ctx.reportError(t('{0}异常', { 0: verb }), ctx.wrapError(err));
    } finally {
      setTimeout(() => renderProgress(null), 4000);
    }
  }

  /* ------------------------------------------- 依赖检测与自动补装（2.1.0） */

  /**
   * 查这个插件缺什么依赖；缺了就用对话框问用户是否自动安装。
   * Python 依赖可以自动装（装进插件自己的 vendor），外部程序只能给出安装提示。
   */
  async function promptInstallDeps(id, kernel) {
    let info = null;
    try {
      info = await window.khs.plugins.deps(id);
    } catch {
      return;
    }
    if (!info || !info.ok) return;
    const missing = info.missing || [];
    const external = info.external || [];
    if (!missing.length && !external.length) return;

    const lines = [];
    if (missing.length) {
      lines.push(t('缺少 Python 模块：{0}', { 0: missing.join('、') }));
      lines.push(t('将安装的包：{0}', { 0: (info.packages || []).join(' ') }));
      lines.push(t('安装位置：{0}（插件自带依赖目录，卸载时会一并删除）', { 0: info.vendorDir }));
      lines.push(t('解释器：{0}', { 0: info.python || '未找到' }));
    }
    if (external.length) {
      lines.push('');
      lines.push(t('另外还需要系统里已有：{0}（外部程序无法用 pip 安装）', { 0: external.join(' / ') }));
    }
    if (info.installHint) {
      lines.push('');
      lines.push(String(info.installHint));
    }

    const actions = [];
    if (missing.length) {
      // 2.3.0：只留一个「自动安装依赖」——镜像不通会自动回退官方源，
      // 不再让用户先选源（实测多数人并不关心源，只关心能不能装上）
      actions.push({
        label: t('自动安装依赖'),
        primary: true,
        run: () => runDepsInstall(id, null),
      });
      // 想在终端自己装的，命令仍然给出来，但不再是唯一出路
      actions.push({
        label: t('复制手动安装命令'),
        run: () => {
          copyText(depsCommand(info));
          ctx.toast.success(t('已复制安装命令'), { text: t('可直接粘贴到终端执行') });
        },
      });
    }
    actions.push({ label: missing.length ? '稍后手动处理' : '知道了', kind: 'ghost' });

    ctx.modal.open({
      title: t('{0} 缺少依赖', { 0: kernel && kernel.name ? kernel.name : id }),
      subtitle: id,
      body: ctx.modal.codeBlock(lines.join('\n'), { lang: missing.length ? '缺少依赖' : '需要外部程序' }),
      actions,
    });
  }

  /** 手抄到终端用的 pip 命令（给还想自己装的人，不再是唯一出路） */
  function depsCommand(info) {
    if (!info) return '';
    const py = info.python || 'python';
    const pkgs = (info.packages || []).join(' ');
    const index = info.indexPreferred || 'https://pypi.org/simple';
    return `"${py}" -m pip install --upgrade --target "${info.vendorDir}" -i ${index} ${pkgs}`;
  }

  /** 真正执行补装：pip 输出会经 evt:plugin:progress 逐行回到进度条上 */
  async function runDepsInstall(id, indexUrl) {
    renderProgress({ phase: 'deps', percent: 0, message: t('正在安装 {0} 的依赖…', { 0: id }) });
    try {
      const res = await window.khs.plugins.installDeps({ id, indexUrl });
      if (!res || !res.ok) {
        const msg = depsFailureDetail(res) || '未知错误';
        renderProgress({ phase: 'error', percent: 0, message: t('依赖安装失败：{0}', { 0: msg }) });
        ctx.toast.error(t('依赖安装失败'), msg);
        return;
      }
      renderProgress({
        phase: 'done',
        percent: 100,
        message: res.alreadyOk ? '依赖已齐全' : t('依赖已安装：{0}', { 0: (res.installed || []).join(' ') }),
      });
      ctx.toast.success(res.alreadyOk ? '依赖已齐全' : '依赖安装完成', {
        text: res.indexUsed ? t('来源 {0}', { 0: res.indexUsed }) : id,
      });
      await ctx.refreshKernels({ announce: false });
      await reload(false);
    } catch (err) {
      ctx.reportError(t('依赖安装异常'), ctx.wrapError(err));
    } finally {
      setTimeout(() => renderProgress(null), 5000);
    }
  }

  async function uninstallOne(p) {
    const ok = await ctx.modal.confirm(t('卸载插件「{0}」？', { 0: p.displayName || p.name || p.id }), {
      okLabel: t('卸载'),
      danger: true,
      detail: t('会删除 {0} 目录（{1}）。\\n对应的内核会立刻从转换页消失。', { 0: p.dir || p.id, 1: humanMB(p.installedBytes || p.size) }),
    });
    if (!ok) return;
    try {
      const res = await window.khs.plugins.uninstall(p.id);
      if (!res || !res.ok) {
        ctx.reportError(t('卸载失败'), ctx.wrapError(new Error((res && res.error) || '未知错误')));
        return;
      }
      await ctx.refreshKernels({ announce: false });
      await reload(false);
      ctx.toast.success(t('已卸载'), { text: p.id });
    } catch (err) {
      ctx.reportError(t('卸载异常'), ctx.wrapError(err));
    }
  }

  async function revealOne(p) {
    try {
      await window.khs.plugins.reveal(p.id);
    } catch (err) {
      ctx.reportError(t('打开目录失败'), ctx.wrapError(err));
    }
  }

  async function openDir() {
    try {
      await window.khs.plugins.openDir();
    } catch (err) {
      ctx.reportError(t('打开插件目录失败'), ctx.wrapError(err));
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
  // 挂载后才量得到按钮位置，这里把指示条摆好（首次不动画）
  tabBar.sync(false);
  requestAnimationFrame(() => tabBar.relayout());

  return {
    unmount() {
      tabBar.dispose();
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
