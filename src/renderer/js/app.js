/**
 * app.js —— 应用内核
 *
 * 职责（其余模块都只做展示，不碰全局）：
 *   1. 启动序列：并行拉取内核/状态/队列/日志，期间显示骨架；失败给出可重试错误态。
 *   2. 路由：location.hash 驱动，视图按需 import() 懒加载；默认进「转换」（没有欢迎页）。
 *   3. 全局状态：一个 store 保存外壳需要的数字与共享数据（待转换列表、作业表、日志）。
 *   4. 事件桥：把主进程的 evt:* 事件翻译成状态变更，并派生通知（转换完成/失败）。
 *   5. 快捷键与原生菜单命令：统一在这里注册，视图只声明「我需要什么」。
 *   6. 测试钩子 window.__khsTest（见 docs/ui-spec-swiss.md 第 7 节）。
 *
 * 约束：本文件（以及所有渲染进程文件）不允许 require/process/fs，
 * 一切主进程能力只经 window.khs。
 */

import { qs, clear, on, h } from './dom.js';
import { toast } from './toast.js';
import { modal } from './modal.js';
import { state, pushLogEntry, replaceLogs, countsFromJobs } from './state.js';
import { createLayout, NAV_ITEMS } from './layout.js';
import { setPlatform, shortcut } from './format.js';
import { icon } from './icons.js';

/* ------------------------------------------------------------- 能力探测 */

const bridge = window.khs;
const bridged = Boolean(bridge && bridge.app);

/**
 * 视图注册表：id → 懒加载工厂。
 * 没有「欢迎」页：默认直接进转换视图（信息优先，少一次点击）。
 */
const VIEWS = {
  convert: () => import('./views/convert.js'),
  batch: () => import('./views/batch.js'),
  kernels: () => import('./views/kernels.js'),
  plugins: () => import('./views/plugins.js'),
  formats: () => import('./views/formats.js'),
  protocol: () => import('./views/protocol.js'),
  settings: () => import('./views/settings.js'),
  logs: () => import('./views/logs.js'),
};

const DEFAULT_VIEW = 'convert';

/** 最近一次 job:update 前的状态，用于判断「刚进入终态」从而只提示一次 */
const jobStateSeen = new Map();

/** 界面级错误收集（供 __khsTest.errors() 读取；只收集，不上报网络） */
const uiErrors = [];

/* --------------------------------------------------------------- 工具 */

/** 统一的错误上报：toast + 控制台（保证错误永远有展示路径） */
function reportError(title, err) {
  const message = err && err.message ? err.message : String(err === undefined ? '未知错误' : err);
  const detail = err && err.detail ? String(err.detail) : '';
  console.error(`[ui] ${title}：${message}`);
  uiErrors.push(`${title}：${message}`);
  toast.error(title, {
    text: message,
    actions: detail ? [{ label: '查看详情', run: () => modal.detail(title, detail), keepOpen: true }] : undefined,
  });
}

/** 把 IPC 返回的异常包装成带 code/detail 的 Error，方便统一展示 */
function wrapError(err, fallback = '调用主进程失败') {
  if (err instanceof Error) {
    if (!err.message || err.message === 'Error invoking remote method') err.message = fallback;
    return err;
  }
  const e = new Error(typeof err === 'string' ? err : fallback);
  if (err && typeof err === 'object') {
    e.code = err.code;
    e.detail = err.detail;
  }
  return e;
}

/**
 * 主题归一化。
 * 瑞士风格以白底为主，因此「未设置 / 历史值 aurora / system」一律按浅色处理；
 * 只有显式选过深色的用户才会得到深色。
 */
function normalizeTheme(value) {
  const v = String(value || '').toLowerCase();
  return v === 'dark' ? 'dark' : 'light';
}

function applyTheme(value) {
  const theme = normalizeTheme(value);
  document.documentElement.setAttribute('data-theme', theme);
  if (layout) layout.setTheme(theme);
  return theme;
}

/** 设置补丁：写回主进程并同步本地状态 */
async function patchSettings(patch, options = {}) {
  try {
    const next = await bridge.settings.set(patch);
    state.set({
      settings: next,
      lastOutputDir: next.lastOutputDir || '',
      parallel: Number(next.maxParallel) || state.pick('parallel'),
    });
    if (patch && patch.theme !== undefined) applyTheme(next.theme);
    if (options.silent !== true) toast.success('设置已保存');
    return next;
  } catch (err) {
    reportError('保存设置失败', wrapError(err));
    return null;
  }
}

/** 切换主题（顶栏按钮与设置页共用） */
function toggleTheme() {
  const next = (state.pick('settings') || {}).theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  return patchSettings({ theme: next }, { silent: true });
}

/** 从 setting 里取 op 元信息（描述/图标） */
function opMetaOf(op) {
  const map = state.pick('opsMap') || {};
  return map[op] || { op, label: op, icon: '', description: '' };
}

/* --------------------------------------------------------- 待转换文件池 */

/** 加入待转换列表：去重 + 过滤目录，返回实际新增数量 */
function addPendingFiles(files) {
  const list = Array.isArray(files) ? files.filter((f) => f && f.path && !f.isDir) : [];
  if (!list.length) return { added: 0, skipped: 0 };
  const existing = state.pick('pending');
  const seen = new Set(existing.map((f) => f.path.toLowerCase()));
  const next = existing.slice();
  let added = 0;
  let skipped = 0;
  for (const file of list) {
    const key = file.path.toLowerCase();
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    next.push(file);
    added += 1;
  }
  if (added) state.set({ pending: next });
  return { added, skipped };
}

function removePendingFile(path) {
  const key = String(path || '').toLowerCase();
  const next = state.pick('pending').filter((f) => f.path.toLowerCase() !== key);
  state.set({ pending: next });
}

function clearPending() {
  state.set({ pending: [] });
}

/* --------------------------------------------------------------- 启动 */

/** 启动序列：关键调用失败 → 错误态（可重试），绝不白屏 */
async function boot() {
  state.set({ bootPhase: 'loading', bootError: null });
  renderShell();

  try {
    const [info, layout2] = await Promise.all([
      bridge.app.info(),
      bridge.app.layout(),
    ]);
    setPlatform(info && info.platform);
    const settings = await bridge.settings.get();
    state.set({
      info,
      layout: layout2,
      settings,
      version: (info && info.version) || '',
      ckp: (info && info.ckp) || '',
      theme: normalizeTheme(settings && settings.theme),
      lastOutputDir: (settings && settings.lastOutputDir) || '',
      parallel: Number(settings && settings.maxParallel) || 2,
    });
    applyTheme(settings && settings.theme);
    renderShell();
  } catch (err) {
    state.set({ bootPhase: 'error', bootError: wrapError(err, '读取应用信息失败') });
    renderShell();
    return;
  }

  // 并行拉取内核 / 队列 / 日志；这一批失败不阻塞应用（可单独刷新）
  await Promise.all([
    loadKernels({ silent: true }),
    loadQueue({ silent: true }),
    loadLogs({ silent: true }),
  ]);

  state.set({ bootPhase: 'ready' });
  renderShell();
}

/** 拉取内核清单与状态 */
async function loadKernels({ silent = false } = {}) {
  try {
    const [list, status, ops] = await Promise.all([
      bridge.kernels.list(),
      bridge.kernels.status(),
      bridge.kernels.ops(),
    ]);
    const opsList = Array.isArray(ops) ? ops : [];
    const opsMap = {};
    for (const row of opsList) if (row && row.op) opsMap[row.op] = row;

    state.set({
      kernels: (list && list.kernels) || [],
      kernelsSummary: (list && list.summary) || null,
      kernelsTotal: Number(status && status.total) || 0,
      kernelsReady: Number(status && status.ready) || 0,
      kernelByStatus: (status && status.byStatus) || [],
      kernelErrors: (status && status.errors) || (list && list.summary && list.summary.errors) || [],
      kernelSearchPaths: (status && status.searchPaths) || [],
      ops: opsList,
      opsMap,
    });
    return true;
  } catch (err) {
    if (!silent) reportError('读取内核信息失败', wrapError(err));
    state.set({
      kernelsTotal: 0,
      kernelsReady: 0,
      kernelByStatus: [],
      kernelErrors: [wrapError(err).message],
    });
    return false;
  }
}

/** 手动刷新内核（重新扫描 + 重新探测），带 loading 反馈 */
let refreshing = false;
async function refreshKernels({ announce = true } = {}) {
  if (refreshing) return false;
  refreshing = true;
  const tip = announce ? toast.info('正在重新扫描内核…', { text: '会重新探测每个内核的运行时依赖', ttl: 0 }) : null;
  try {
    const res = await bridge.kernels.refresh();
    state.set({
      kernels: (res && res.kernels) || [],
      kernelsSummary: (res && res.summary) || null,
    });
    await loadKernels({ silent: true });
    if (announce) toast.success('内核已刷新', { text: `可用 ${state.pick('kernelsReady')} / 共 ${state.pick('kernelsTotal')}` });
    return true;
  } catch (err) {
    reportError('刷新内核失败', wrapError(err));
    return false;
  } finally {
    if (tip) tip.close();
    refreshing = false;
  }
}

/** 拉取队列快照 */
async function loadQueue({ silent = false } = {}) {
  try {
    const res = await bridge.queue.list();
    applyJobsSnapshot((res && res.jobs) || [], res && res.counts, res && res.paused);
    return true;
  } catch (err) {
    if (!silent) reportError('读取队列失败', wrapError(err));
    return false;
  }
}

/** 拉取主进程日志 */
async function loadLogs({ silent = false } = {}) {
  try {
    const res = await bridge.logs.list();
    replaceLogs((res && res.logs) || []);
    return true;
  } catch (err) {
    if (!silent) reportError('读取日志失败', wrapError(err));
    return false;
  }
}

/* --------------------------------------------------------- 队列状态归并 */

function applyJobsSnapshot(jobs, counts, paused) {
  const map = new Map();
  for (const job of jobs || []) {
    if (!job || !job.id) continue;
    map.set(job.id, job);
    jobStateSeen.set(job.id, job.state);
  }
  for (const id of Array.from(jobStateSeen.keys())) {
    if (!map.has(id)) jobStateSeen.delete(id);
  }
  state.set({
    jobs: map,
    queueCounts: counts || countsFromJobs(map),
    queuePaused: Boolean(paused),
  });
}

/** 增量更新单个作业（避免整表重建导致闪烁/滚动丢失） */
function applyJobUpdate(job) {
  if (!job || !job.id) return;
  const prevState = jobStateSeen.get(job.id);
  const next = new Map(state.pick('jobs'));
  next.set(job.id, job);
  jobStateSeen.set(job.id, job.state);
  state.set({ jobs: next, queueCounts: countsFromJobs(next) });

  const terminal = job.state === 'done' || job.state === 'failed' || job.state === 'cancelled';
  if (terminal && prevState !== job.state) {
    if (job.state === 'done') {
      toast.success(`转换完成：${job.outputName || job.sourceName || ''}`, {
        text: `${job.sourceFormat || '?'} → ${job.targetFormat || '?'} · ${job.size || ''} · ${job.kernelName || job.kernelUsed || ''}`,
        actions: job.output ? [{
          label: '打开产物',
          run: () => Promise.resolve(bridge.fs.openPath(job.output)).catch((err) => reportError('打开产物失败', wrapError(err))),
        }] : undefined,
      });
    } else if (job.state === 'failed') {
      toast.error(`转换失败：${job.sourceName || job.id}`, {
        text: (job.error && job.error.message) || '内核返回失败',
        actions: [
          {
            label: '重试',
            run: () => Promise.resolve(bridge.queue.retry(job.id)).catch((err) => reportError('重试失败', wrapError(err))),
          },
          job.error && job.error.detail
            ? { label: '详情', keepOpen: true, run: () => modal.detail('失败详情', job.error.detail) }
            : null,
        ].filter(Boolean),
      });
    }
  }
}

/* ----------------------------------------------------------- 文件与命令 */

/** 添加文件（快捷键 / 命令面板 / 视图按钮共用一条路径） */
async function pickFiles({ navigateAfter = true } = {}) {
  try {
    const res = await bridge.fs.pickFiles({ title: '添加到待转换列表' });
    const files = (res && res.files) || [];
    if (!files.length) return 0;
    const { added, skipped } = addPendingFiles(files);
    if (added) {
      if (navigateAfter) navigate('#/convert');
      toast.success(`已添加 ${added} 个文件`, skipped ? { text: `${skipped} 个重复文件已忽略` } : undefined);
    } else {
      toast.warn('没有新增文件', { text: skipped ? `${skipped} 个文件已在列表中` : '所选内容不是文件' });
    }
    return added;
  } catch (err) {
    reportError('选择文件失败', wrapError(err));
    return 0;
  }
}

/** 添加目录（目录会被递归展开，展开逻辑在主进程 fs:expand） */
async function pickFolder({ navigateAfter = true } = {}) {
  try {
    const res = await bridge.fs.pickFolder({ title: '添加目录（递归展开）' });
    const folder = res && res.folder;
    if (!folder) return 0;
    return expandPaths([folder], { navigateAfter, label: '目录' });
  } catch (err) {
    reportError('添加目录失败', wrapError(err));
    return 0;
  }
}

/** 展开任意路径（拖拽投放、示例素材、目录都走这里） */
async function expandPaths(paths, opts = {}) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (!list.length) return 0;
  try {
    const res = await bridge.fs.expand(list);
    const files = (res && res.files) || [];
    if (!files.length) {
      if (!opts.silent) toast.warn('没有可用的文件', { text: '所选路径下没有可识别的文件（或全部为隐藏项）' });
      return 0;
    }
    const { added, skipped } = addPendingFiles(files);
    if (added && opts.navigateAfter !== false) navigate('#/convert');
    if (!opts.silent) {
      if (added) {
        toast.success(`已添加 ${added} 个文件`, {
          text: [skipped ? `${skipped} 个重复已忽略` : '', `共 ${files.length} 个文件`].filter(Boolean).join(' · '),
        });
      } else {
        toast.info('文件已在列表中', { text: `${skipped} 个文件此前已加入` });
      }
    }
    return added;
  } catch (err) {
    reportError(`展开${opts.label || '路径'}失败`, wrapError(err));
    return 0;
  }
}

/* --------------------------------------------------------------- 路由 */

let currentViewId = null;
let currentInstance = null;
let pendingAction = null;

function parseHash() {
  const raw = String(location.hash || '').replace(/^#\/?/, '').split('?')[0].trim();
  const id = raw || DEFAULT_VIEW;
  return Object.prototype.hasOwnProperty.call(VIEWS, id) ? id : DEFAULT_VIEW;
}

function navigate(hash, action) {
  const target = String(hash || '').startsWith('#') ? String(hash) : `#/${hash}`;
  if (action) pendingAction = action;
  if (location.hash === target) {
    renderRoute();
    return;
  }
  location.hash = target;
}

/** 视图上下文：视图能用的全部能力都在这里显式列出 */
function makeContext(viewId) {
  return {
    viewId,
    store: state,
    navigate,
    reportError,
    wrapError,
    openPathSafe,
    patchSettings,
    toggleTheme,
    addPendingFiles,
    removePendingFile,
    clearPending,
    expandPaths,
    pickFiles,
    pickFolder,
    pathForFile: (file) => {
      try {
        const fn = bridge && bridge.fs && bridge.fs.pathForFile;
        if (typeof fn === 'function') return String(fn(file) || '');
      } catch {
        /* 落到旧字段 */
      }
      return file && typeof file.path === 'string' ? file.path : '';
    },
    refreshKernels,
    openPalette: () => layout.openPalette(),
    registerAction,
    toast,
    modal,
    opMeta: opMetaOf,
    goConvert: () => navigate('#/convert'),
  };
}

async function renderRoute() {
  const viewId = parseHash();
  const host = qs('#view');
  if (!host) return;

  if (currentInstance && typeof currentInstance.unmount === 'function') {
    try {
      currentInstance.unmount();
    } catch (err) {
      console.error('[ui] 视图卸载异常', err);
    }
  }
  currentInstance = null;
  currentViewId = viewId;
  state.set({ activeView: viewId });
  layout.setActive(viewId);

  clear(host);
  host.scrollTop = 0;
  host.appendChild(buildSkeleton());

  let mod = null;
  try {
    mod = await VIEWS[viewId]();
  } catch (err) {
    clear(host);
    host.appendChild(buildViewError(viewId, wrapError(err, `加载视图「${viewId}」失败`)));
    reportError('视图加载失败', wrapError(err));
    return;
  }

  const mount = mod && (mod.mount || (mod.default && mod.default.mount));
  if (typeof mount !== 'function') {
    clear(host);
    host.appendChild(buildViewError(viewId, new Error(`视图模块 ${viewId}.js 没有导出 mount()`)));
    return;
  }

  clear(host);
  let mounted = false;
  try {
    const instance = await mount(host, makeContext(viewId));
    currentInstance = instance || null;
    mounted = true;
  } catch (err) {
    clear(host);
    host.appendChild(buildViewError(viewId, wrapError(err, `渲染视图「${viewId}」失败`)));
    reportError('视图渲染失败', wrapError(err));
  }

  if (mounted && pendingAction) {
    const queued = pendingAction;
    pendingAction = null;
    runAction(queued.name, queued.payload);
  }
  return mounted;
}

/** 骨架屏：灰底块，无动画条纹 */
function buildSkeleton() {
  return h('div.view-inner', null,
    h('div.skeleton', { style: { height: '28px', width: '220px' } }),
    h('div.skeleton', { style: { height: '13px', width: '360px' } }),
    h('div.skeleton', { style: { height: '32px', width: '420px', marginTop: 'var(--sp-4)' } }),
    h('div.skeleton', { style: { height: '14px', width: '100%', marginTop: 'var(--sp-5)' } }),
    h('div.skeleton', { style: { height: '14px', width: '100%' } }),
    h('div.skeleton', { style: { height: '14px', width: '60%' } })
  );
}

/** 视图级错误态：一整行红条 + 重试文字按钮 */
function buildViewError(viewId, err) {
  return h('div.view-inner', null,
    h('div.error-state', null,
      icon('error', { size: 16 }),
      h('div.error-state__msg', null,
        h('div', { textContent: `视图「${viewId}」无法显示` }),
        h('div', { textContent: err.message || String(err) })
      ),
      h('button.linkbtn', { type: 'button', on: { click: () => renderRoute() } }, h('span', { textContent: '重试' })),
      h('button.linkbtn', { type: 'button', on: { click: () => navigate('#/convert') } }, h('span', { textContent: '回到转换' }))
    )
  );
}

/* ------------------------------------------------------------- 事件桥 */

function bindBridgeEvents() {
  const disposers = [];

  disposers.push(bridge.on('evt:queue', (jobs) => {
    applyJobsSnapshot(jobs || [], null, state.pick('queuePaused'));
  }));

  disposers.push(bridge.on('evt:queue:enqueue', (jobs) => {
    const next = new Map(state.pick('jobs'));
    for (const job of jobs || []) {
      if (!job || !job.id) continue;
      next.set(job.id, job);
      jobStateSeen.set(job.id, job.state);
    }
    state.set({ jobs: next, queueCounts: countsFromJobs(next) });
  }));

  disposers.push(bridge.on('evt:job:update', (job) => applyJobUpdate(job)));

  disposers.push(bridge.on('evt:job:finish', (payload) => {
    const job = payload && payload.job;
    const outcome = (payload && payload.outcome) || {};
    if (job && outcome && outcome.ok === false && outcome.stderr) {
      pushLog({
        at: Date.now(),
        level: 'error',
        message: `作业 ${job.id} 退出码 ${outcome.exit_code}：${String(outcome.stderr).slice(0, 400)}`,
        jobId: job.id,
      });
    }
  }));

  disposers.push(bridge.on('evt:queue:idle', (counts) => {
    state.set({ queueCounts: counts || countsFromJobs(state.pick('jobs')) });
    const c = counts || {};
    if (c.total) {
      const bits = [`完成 ${c.done || 0}`];
      if (c.failed) bits.push(`失败 ${c.failed}`);
      if (c.cancelled) bits.push(`取消 ${c.cancelled}`);
      toast.info('队列已空闲', { text: bits.join(' · ') });
    }
  }));

  disposers.push(bridge.on('evt:job:log', (line) => {
    if (!line) return;
    pushLog({ at: line.at || Date.now(), level: line.level || 'info', message: line.message || '', jobId: line.jobId });
  }));

  disposers.push(bridge.on('evt:log', (line) => {
    if (!line) return;
    pushLog({ at: line.at || Date.now(), level: line.level || 'info', message: line.message || '', source: 'main' });
  }));

  disposers.push(bridge.on('evt:window', (payload) => {
    state.set({ maximized: Boolean(payload && payload.maximized) });
  }));

  disposers.push(bridge.on('cmd', (command) => {
    switch (command) {
      case 'pick-files': pickFiles(); break;
      case 'pick-folder': pickFolder(); break;
      case 'refresh': refreshKernels(); break;
      case 'protocol': navigate('#/protocol'); break;
      default:
        console.warn('[ui] 未处理的原生命令', command);
    }
  }));

  return () => disposers.forEach((off) => {
    try {
      off();
    } catch {
      /* 忽略 */
    }
  });
}

function pushLog(entry) {
  pushLogEntry(entry);
}

/* ----------------------------------------------------------- 拖拽投放 */

/**
 * 从拖拽事件里取出磁盘路径。
 * Electron 32 起 File.path 被移除，统一走 preload 的 webUtils 包装；
 * 另外还兼容 text/uri-list（部分来源只会给 URI）。
 */
function collectDropPaths(event) {
  const paths = [];
  const dt = event.dataTransfer;
  if (!dt) return paths;
  for (const file of Array.from(dt.files || [])) {
    try {
      const fn = bridge.fs && bridge.fs.pathForFile;
      const p = typeof fn === 'function' ? fn(file) : (file && file.path);
      if (p) paths.push(String(p));
    } catch {
      /* 忽略单个文件 */
    }
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
  return paths;
}

/**
 * 全局投放：欢迎页删掉之后，文件可以拖到窗口的任何位置。
 * 同时也是安全网 —— 不拦截默认行为的话，Chromium 会直接导航到被拖入的文件，
 * 界面会被文件内容顶掉。
 */
function bindGlobalDrop() {
  document.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('drop', async (event) => {
    // 视图自己已经处理过（它绑在投放区上，且先于冒泡到这里）
    if (event.defaultPrevented) return;
    event.preventDefault();
    const paths = collectDropPaths(event);
    if (!paths.length) {
      toast.warn('没有识别到文件路径', { text: '请改用「添加文件」按钮，或把文件拖到待转换列表上。' });
      return;
    }
    await expandPaths(paths, { label: '拖入内容' });
  });
}

/* ------------------------------------------------------------ 快捷键 */

const HOTKEYS = [
  { id: 'pick-files', keys: 'mod+o', label: '添加文件', run: () => pickFiles() },
  { id: 'pick-folder', keys: 'mod+shift+o', label: '添加目录', run: () => pickFolder() },
  { id: 'start-convert', keys: 'mod+enter', label: '开始转换', run: () => runAction('start-convert') },
  { id: 'refresh-kernels', keys: 'f5', label: '刷新内核', run: () => refreshKernels() },
  { id: 'palette', keys: 'mod+k', label: '命令面板', run: () => layout.openPalette() },
];

/** 具名动作：视图注册自己能响应的动作（如「开始转换」），快捷键只负责触发 */
const actions = new Map();

function registerAction(name, fn) {
  actions.set(name, fn);
  return () => actions.delete(name);
}

function runAction(name, payload) {
  const fn = actions.get(name);
  if (typeof fn !== 'function') {
    toast.warn('该操作当前不可用', {
      text: name === 'start-convert'
        ? '请先切换到转换视图并选择文件与目标格式。'
        : `没有视图注册动作「${name}」。`,
    });
    return false;
  }
  try {
    fn(payload);
    return true;
  } catch (err) {
    reportError('执行操作失败', wrapError(err));
    return false;
  }
}

function keySignature(event) {
  const parts = [];
  if (event.ctrlKey || event.metaKey) parts.push('mod');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  let key = String(event.key || '').toLowerCase();
  if (key === ' ') key = 'space';
  if (key === 'escape') key = 'esc';
  parts.push(key);
  return parts.join('+');
}

function bindHotkeys() {
  return on(document, 'keydown', (event) => {
    if (event.defaultPrevented) return;
    const sig = keySignature(event);

    // Ctrl/Cmd+1..8：直接切换视图（索引即 NAV_ITEMS 的顺序）
    if (/^mod\+[1-9]$/.test(sig)) {
      const index = Number(sig.slice(-1)) - 1;
      const item = NAV_ITEMS[index];
      if (item) {
        event.preventDefault();
        navigate(item.hash);
      }
      return;
    }

    if (sig === 'esc') {
      if (layout.isPaletteOpen()) {
        event.preventDefault();
        layout.closePalette();
        return;
      }
      if (modal.isOpen()) {
        event.preventDefault();
        modal.closeCurrent();
        return;
      }
      // 让视图自己处理（高级面板、展开行等）
      window.dispatchEvent(new CustomEvent('khs:escape'));
      return;
    }

    const entry = HOTKEYS.find((k) => k.keys === sig);
    if (!entry) return;

    const inField = isEditable(event.target);
    if (inField && !/^f\d+$/.test(entry.keys)) return;

    event.preventDefault();
    try {
      entry.run();
    } catch (err) {
      reportError(`快捷键「${entry.label}」执行失败`, wrapError(err));
    }
  });
}

function isEditable(el) {
  if (!el || !(el instanceof Element)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable === true;
}

/* --------------------------------------------------------- 命令面板数据 */

/** 把所有可执行的东西统一成面板条目 */
function buildCommands() {
  const commands = [];
  const ks = state.pick('kernels') || [];
  const ops = state.pick('ops') || [];
  const formatsCache = state.pick('formatsCache') || null;

  for (const item of NAV_ITEMS) {
    commands.push({
      id: `view:${item.id}`,
      group: '前往',
      title: item.label,
      subtitle: item.hash,
      kbd: shortcut(item.shortcut),
      keywords: `view navigate ${item.id}`,
      run: () => navigate(item.hash),
    });
  }

  commands.push({
    id: 'act:pick-files', group: '操作', title: '添加文件', subtitle: '选择文件加入待转换列表',
    kbd: shortcut('mod+O'), keywords: 'add file open', run: () => pickFiles(),
  });
  commands.push({
    id: 'act:pick-folder', group: '操作', title: '添加目录', subtitle: '递归展开目录并加入待转换列表',
    kbd: shortcut('mod+Shift+O'), keywords: 'add folder directory', run: () => pickFolder(),
  });
  commands.push({
    id: 'act:start', group: '操作', title: '开始转换', subtitle: '把当前待转换列表提交到队列',
    kbd: shortcut('mod+Enter'), keywords: 'start convert run', run: () => runAction('start-convert'),
  });
  commands.push({
    id: 'act:clear-pending', group: '操作', title: '清空待转换列表', subtitle: '不移除磁盘上的文件',
    keywords: 'clear pending list', run: () => clearPending(),
  });
  commands.push({
    id: 'act:advanced', group: '操作', title: '打开高级面板', subtitle: '内核参数 / 输出目录 / 命令行预览',
    keywords: 'advanced sheet params', run: () => navigate('#/convert', { name: 'open-advanced' }),
  });
  commands.push({
    id: 'act:refresh', group: '操作', title: '刷新内核', subtitle: '重新扫描并重新探测依赖',
    kbd: 'F5', keywords: 'refresh rescan kernel', run: () => refreshKernels(),
  });
  commands.push({
    id: 'act:theme', group: '操作',
    title: `切换到${(state.pick('settings') || {}).theme === 'dark' ? '浅色' : '深色'}主题`,
    subtitle: '主题会写入设置并持久化', keywords: 'theme dark light 主题', run: () => toggleTheme(),
  });
  commands.push({
    id: 'act:output-dir', group: '操作', title: '打开最近输出目录', subtitle: state.pick('lastOutputDir') || '尚未设置',
    keywords: 'output dir open', run: () => openPathSafe(state.pick('lastOutputDir'), '最近输出目录'),
  });
  commands.push({
    id: 'act:hub-root', group: '操作', title: '打开内核仓库目录', subtitle: (state.pick('layout') || {}).hubRoot || '',
    keywords: 'hub root kernel dir', run: () => openPathSafe((state.pick('layout') || {}).hubRoot, '内核仓库'),
  });
  commands.push({
    id: 'act:doctor', group: '操作', title: '运行自检并查看结果', subtitle: 'Node / Electron / Python / 内核探测摘要',
    keywords: 'doctor diagnose health',
    run: async () => {
      try {
        const report = await bridge.doctor();
        await modal.json('自检结果（doctor）', report, { subtitle: `CKP ${report.protocol || '—'}` });
      } catch (err) {
        reportError('自检失败', wrapError(err));
      }
    },
  });
  commands.push({
    id: 'act:clear-logs', group: '操作', title: '清空运行日志', subtitle: '同时清理主进程日志缓冲',
    keywords: 'clear log', run: () => clearLogs(),
  });

  for (const op of ops) {
    if (!op || !op.op) continue;
    commands.push({
      id: `op:${op.op}`,
      group: '操作类型',
      title: `切到「${op.label || op.op}」`,
      subtitle: `${op.op} · ${op.kernelCount || 0} 个内核`,
      keywords: `op ${op.op} ${op.label || ''}`,
      run: () => navigate('#/convert', { name: 'set-op', payload: op.op }),
    });
  }

  for (const kernel of ks.slice(0, 400)) {
    commands.push({
      id: `kernel:${kernel.id}`,
      group: '内核',
      title: kernel.name || kernel.id,
      subtitle: `${kernel.id} · ${kernel.statusLabel || kernel.status}`,
      keywords: `kernel ${kernel.id} ${(kernel.tags || []).join(' ')} ${(kernel.inputFormats || []).join(' ')} ${(kernel.outputFormats || []).join(' ')}`,
      run: () => navigate('#/kernels', { name: 'focus-kernel', payload: kernel.id }),
    });
  }

  if (formatsCache) {
    for (const row of formatsCache.slice(0, 400)) {
      commands.push({
        id: `format:${row.format}`,
        group: '格式',
        title: String(row.format || '').toUpperCase(),
        subtitle: `${row.kernelCount} 个内核`,
        keywords: `format ${row.format}`,
        run: () => navigate('#/formats', { name: 'focus-format', payload: row.format }),
      });
    }
  }

  return commands;
}

/** 打开路径（目录/文件），失败必上报 */
async function openPathSafe(path, label) {
  if (!path) {
    toast.warn(`没有可打开的${label || '路径'}`, { text: '该路径尚未设置。' });
    return;
  }
  try {
    const res = await bridge.fs.openPath(path);
    if (res && res.ok === false) toast.warn(`打开${label || '路径'}失败`, { text: String(path) });
  } catch (err) {
    reportError(`打开${label || '路径'}失败`, wrapError(err));
  }
}

/** 清空日志（主进程 + 本地缓冲） */
async function clearLogs() {
  try {
    await bridge.logs.clear();
    replaceLogs([]);
    toast.success('日志已清空');
  } catch (err) {
    reportError('清空日志失败', wrapError(err));
  }
}

/* ----------------------------------------------------------- 外壳渲染 */

let layout = null;

function renderShell() {
  layout.render({ ...state.get(), theme: document.documentElement.getAttribute('data-theme') });
}

/* ----------------------------------------------------------- 测试钩子 */

/** 等某个具名动作被注册（视图挂载完成后才会注册） */
async function waitForAction(name, timeoutMs = 8000) {
  const t0 = Date.now();
  while (!actions.has(name)) {
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

/**
 * 当前视图里「算得上按钮」的元素文本。
 *
 * 口径（与 tools/uiverify.js 第 9 节一致）：屏幕上看得见的所有 <button> 都算，
 * 包括表格行里的操作按钮。这也是为什么列表类界面采用「整行可点 + 行内图标用
 * role="button" 的 span」——行操作不占用按钮预算。
 *
 * 过滤掉：hidden / display:none / visibility:hidden / opacity:0 / 宽高为 0。
 * 返回 innerText.trim()，为空时退回 aria-label。
 */
function visibleButtons() {
  const root = qs('#view');
  if (!root) return [];
  const out = [];
  for (const btn of root.querySelectorAll('button')) {
    if (btn.closest('[hidden]')) continue;
    const cs = window.getComputedStyle(btn);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    const rect = btn.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const label = String(btn.innerText || '').trim() || btn.getAttribute('aria-label') || '';
    if (label) out.push(label);
  }
  return out;
}

function installTestHooks() {
  window.__khsTest = {
    pendingCount: () => state.pick('pending').length,

    /** 把路径加进待转换列表（走应用自己的 expand + 去重逻辑），返回新增数量 */
    async addPaths(paths) {
      const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
      if (!list.length) return 0;
      const res = await bridge.fs.expand(list);
      const { added } = addPendingFiles((res && res.files) || []);
      if (added) navigate('#/convert');
      return added;
    },

    /** 选择目标格式（会自动切到转换视图并等待视图就绪） */
    async setTarget(fmt) {
      await window.__khsTest.goto('#/convert');
      if (!(await waitForAction('set-target'))) throw new Error('转换视图未就绪，无法设置目标格式');
      runAction('set-target', String(fmt || ''));
      await new Promise((r) => setTimeout(r, 200));
    },

    /** 打开高级面板（内核参数 / 输出目录 / 命令行预览） */
    openAdvanced() {
      if (!runAction('open-advanced')) {
        const done = waitForAction('open-advanced');
        done.then((ok) => {
          if (ok) runAction('open-advanced');
        });
      }
    },

    visibleButtons,

    /** 路由跳转并等待视图挂载完成 */
    async goto(hash) {
      const target = String(hash || '#/convert');
      if (location.hash !== target) {
        location.hash = target;
        await new Promise((r) => setTimeout(r, 60));
      } else {
        renderRoute();
      }
      const id = parseHash();
      const t0 = Date.now();
      while (state.pick('activeView') !== id || !qs('#view .view-inner')) {
        if (Date.now() - t0 > 8000) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      return id;
    },

    theme: () => document.documentElement.getAttribute('data-theme') || 'light',
    errors: () => uiErrors.slice(),
  };
}

/* --------------------------------------------------------------- 启动 */

async function main() {
  const appRoot = qs('#app');
  const fallback = qs('#bridge-fallback');

  if (!bridged) {
    if (fallback) fallback.hidden = false;
    console.warn('[ui] 未检测到 window.khs，运行在浏览器降级模式');
    return;
  }

  if (fallback) fallback.hidden = true;
  if (appRoot) appRoot.hidden = false;

  layout = createLayout({
    navigate,
    runAction,
    commands: buildCommands,
    currentTheme: () => document.documentElement.getAttribute('data-theme') || 'light',
    toggleTheme,
    reportError: (err) => reportError('界面操作失败', wrapError(err)),
  });
  layout.mount();

  window.addEventListener('khs:formats-cache', (event) => {
    const list = event.detail && Array.isArray(event.detail.formats) ? event.detail.formats : [];
    if (list.length) state.set({ formatsCache: list });
  });

  // 主题跟随设置：任何来源改动了 theme 都要同步 <html data-theme> 与顶栏按钮
  state.subscribe((s, changed) => {
    if (!changed.includes('settings')) return;
    applyTheme((s.settings || {}).theme);
  });

  window.addEventListener('hashchange', () => renderRoute());
  if (!location.hash) location.replace(`#/${DEFAULT_VIEW}`);

  bindHotkeys();
  bindBridgeEvents();

  await boot();
  await renderRoute();

  installTestHooks();

  window.__khsState = state;
  window.__khsUi = Object.freeze({
    version: (state.pick('info') || {}).version || '',
    state,
    navigate,
    runAction,
    actions: () => Array.from(actions.keys()),
    hotkeys: () => HOTKEYS.slice(),
  });
}

/* 页面加载完成即启动；任何未捕获异常都要可见，绝不静默 */
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  const message = reason && reason.message ? reason.message : String(reason);
  uiErrors.push(`unhandledrejection: ${message}`);
  console.warn('[ui] unhandledrejection', reason);
  toast.error('未处理的异步错误', { text: message });
});
window.addEventListener('error', (event) => {
  uiErrors.push(`error: ${event.message}`);
  console.warn('[ui] error', event.error || event.message);
});

export { registerAction, runAction, navigate, state, reportError, openPathSafe, patchSettings };

main().catch((err) => {
  console.error('[ui] 启动失败', err);
  const host = qs('#view');
  if (host) {
    clear(host);
    host.appendChild(h('div.view-inner', null,
      h('div.error-state', null,
        icon('error', { size: 16 }),
        h('div.error-state__msg', { textContent: `应用启动失败：${err && err.message ? err.message : String(err)}` }),
        h('button.linkbtn', { type: 'button', on: { click: () => location.reload() } }, h('span', { textContent: '重新加载' }))
      )
    ));
  }
});
