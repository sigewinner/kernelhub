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
import { dismissSplash, setSplashCkp, setSplashStatus } from './splash.js';
import { modal } from './modal.js';
import { state, pushLogEntry, replaceLogs, countsFromJobs } from './state.js';
import { createLayout, NAV_ITEMS } from './layout.js';
import { setPlatform, shortcut } from './format.js';
import { icon } from './icons.js';
import { t, getLocale, initLocale, translationCount, hasTranslation, statusText } from './i18n.js';

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
    actions: detail ? [{ label: t('查看详情'), run: () => modal.detail(title, detail), keepOpen: true }] : undefined,
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
    if (options.silent !== true) toast.success(t('设置已保存'));
    return next;
  } catch (err) {
    reportError(t('保存设置失败'), wrapError(err));
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
  setSplashStatus(t('读取运行环境'), 12);

  try {
    const [info, layout2] = await Promise.all([
      bridge.app.info(),
      bridge.app.layout(),
    ]);
    setPlatform(info && info.platform);
    const settings = await bridge.settings.get();

    /**
     * 语言（2.2.1）：设置里存的是权威值，localStorage 只是给模块顶层同步读取的镜像。
     * 两者不一致 → 写回镜像并重载一次，让所有模块按新语言重新构建
     * （比逐个重渲染安全得多；写完镜像后再进来就一致了，不会来回重载）。
     */
    const wanted = settings && settings.locale === 'en-US' ? 'en-US' : 'zh-CN';
    if (wanted !== getLocale()) {
      initLocale(wanted);
      location.reload();
      return;
    }

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
    setSplashCkp((info && info.ckp) || '');
    setSplashStatus(t('载入内核与队列'), 45);
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

  setSplashStatus(t('准备界面'), 85);
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
    if (!silent) reportError(t('读取内核信息失败'), wrapError(err));
    state.set({
      kernelsTotal: 0,
      kernelsReady: 0,
      kernelByStatus: [],
      kernelErrors: [wrapError(err).message],
    });
    return false;
  }
}

/**
 * 刷新格式缓存（命令面板的「格式直达」数据源）。
 *
 * 装了插件之后可用格式会变，这个缓存必须跟着更新 —— 否则命令面板里
 * 搜不到新插件提供的格式，「格式」页也要等下次进入才刷新。
 */
async function loadFormatsCache() {
  try {
    const list = await bridge.kernels.formats();
    if (Array.isArray(list) && list.length) state.set({ formatsCache: list });
  } catch {
    /* 拿不到最新格式不影响主流程，命令面板退化为用旧缓存 */
  }
}

/**
 * 手动刷新内核（重新扫描 + 重新探测），带 loading 反馈。
 *
 * 用「共享在途 promise」而不是 refreshing 布尔量：之前那种写法在刷新进行中
 * 再调一次会直接返回 false，调用方（比如刚装完插件的页面）会以为刷新失败了。
 * 现在并发调用会一起等同一个刷新完成。
 */
let refreshPromise = null;
async function refreshKernels({ announce = true } = {}) {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const tip = announce ? toast.info(t('正在重新扫描内核…'), { text: t('会重新探测每个内核的运行时依赖'), ttl: 0 }) : null;
    try {
      const res = await bridge.kernels.refresh();
      state.set({
        kernels: (res && res.kernels) || [],
        kernelsSummary: (res && res.summary) || null,
      });
      await loadKernels({ silent: true });
      // 内核集合变了 → 可用格式也随之改变，缓存要一起刷新
      await loadFormatsCache();
      if (announce) toast.success(t('内核已刷新'), { text: t('可用 {0} / 共 {1}', { 0: state.pick('kernelsReady'), 1: state.pick('kernelsTotal') }) });
      return true;
    } catch (err) {
      reportError(t('刷新内核失败'), wrapError(err));
      return false;
    } finally {
      if (tip) tip.close();
    }
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

/** 拉取队列快照 */
async function loadQueue({ silent = false } = {}) {
  try {
    const res = await bridge.queue.list();
    applyJobsSnapshot((res && res.jobs) || [], res && res.counts, res && res.paused);
    return true;
  } catch (err) {
    if (!silent) reportError(t('读取队列失败'), wrapError(err));
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
    if (!silent) reportError(t('读取日志失败'), wrapError(err));
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
      toast.success(t('转换完成：{0}', { 0: job.outputName || job.sourceName || '' }), {
        text: `${job.sourceFormat || '?'} → ${job.targetFormat || '?'} · ${job.size || ''} · ${job.kernelName || job.kernelUsed || ''}`,
        actions: job.output ? [{
          label: t('打开产物'),
          run: () => Promise.resolve(bridge.fs.openPath(job.output)).catch((err) => reportError(t('打开产物失败'), wrapError(err))),
        }] : undefined,
      });
    } else if (job.state === 'failed') {
      toast.error(t('转换失败：{0}', { 0: job.sourceName || job.id }), {
        text: (job.error && job.error.message) || '内核返回失败',
        actions: [
          {
            label: t('重试'),
            run: () => Promise.resolve(bridge.queue.retry(job.id)).catch((err) => reportError(t('重试失败'), wrapError(err))),
          },
          job.error && job.error.detail
            ? { label: t('详情'), keepOpen: true, run: () => modal.detail('失败详情', job.error.detail) }
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
    const res = await bridge.fs.pickFiles({ title: t('添加到待转换列表') });
    const files = (res && res.files) || [];
    if (!files.length) return 0;
    const { added, skipped } = addPendingFiles(files);
    if (added) {
      if (navigateAfter) navigate('#/convert');
      toast.success(t('已添加 {0} 个文件', { 0: added }), skipped ? { text: t('{0} 个重复文件已忽略', { 0: skipped }) } : undefined);
    } else {
      toast.warn(t('没有新增文件'), { text: skipped ? t('{0} 个文件已在列表中', { 0: skipped }) : '所选内容不是文件' });
    }
    return added;
  } catch (err) {
    reportError(t('选择文件失败'), wrapError(err));
    return 0;
  }
}

/** 添加目录（目录会被递归展开，展开逻辑在主进程 fs:expand） */
async function pickFolder({ navigateAfter = true } = {}) {
  try {
    const res = await bridge.fs.pickFolder({ title: t('添加目录（递归展开）') });
    const folder = res && res.folder;
    if (!folder) return 0;
    return expandPaths([folder], { navigateAfter, label: t('目录') });
  } catch (err) {
    reportError(t('添加目录失败'), wrapError(err));
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
      if (!opts.silent) toast.warn(t('没有可用的文件'), { text: t('所选路径下没有可识别的文件（或全部为隐藏项）') });
      return 0;
    }
    const { added, skipped } = addPendingFiles(files);
    if (added && opts.navigateAfter !== false) navigate('#/convert');
    if (!opts.silent) {
      if (added) {
        toast.success(t('已添加 {0} 个文件', { 0: added }), {
          text: [skipped ? t('{0} 个重复已忽略', { 0: skipped }) : '', t('共 {0} 个文件', { 0: files.length })].filter(Boolean).join(' · '),
        });
      } else {
        toast.info(t('文件已在列表中'), { text: t('{0} 个文件此前已加入', { 0: skipped }) });
      }
    }
    return added;
  } catch (err) {
    reportError(t('展开{0}失败', { 0: opts.label || '路径' }), wrapError(err));
    return 0;
  }
}

/* --------------------------------------------------------------- 路由 */

let currentViewId = null;
let currentInstance = null;
let pendingAction = null;

/** 视图别名：2.0.0 把「内核」合并进了「插件」页，老链接和老习惯都要能落到新页面 */
const VIEW_ALIASES = {
  kernels: 'plugins',
};

function parseHash() {
  const raw = String(location.hash || '').replace(/^#\/?/, '').split('?')[0].trim();
  const id = VIEW_ALIASES[raw] || raw || DEFAULT_VIEW;
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
    /** 只重取内核列表（不重新探测）——插件目录拉到后显示名可能变，用它轻量同步 */
    loadKernels,
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

    /**
     * 把本视图的实时信息推到右下角状态栏（2.0.4）。
     * 视图底部的 .footline 已经取消，实时信息统一走这里。
     * @param {Array<string|{text:string,title?:string,tone?:string}>} items 传 [] 表示清空
     */
    setStatusInfo(items) {
      // 只有**当前激活**的视图能写右下角。视图实例万一没被及时卸载，
      // 它也不能再改状态栏（与 renderRoute 的令牌一起构成双重保险）。
      if (state.pick('activeView') !== viewId) return;
      const list = (Array.isArray(items) ? items : [items])
        .filter(Boolean)
        .map((it) => (typeof it === 'object' ? it : { text: String(it) }))
        .filter((it) => it && it.text !== '' && it.text != null);
      // 内容没变就不重绘状态栏：视图可能在每次进度回调里都推一次，
      // 无脑重建会让右下角一直闪
      if (JSON.stringify(list) === JSON.stringify(state.pick('statusInfo') || [])) return;
      state.set({ statusInfo: list });
    },
    openPalette: () => layout.openPalette(),
    registerAction,
    toast,
    modal,
    opMeta: opMetaOf,
    goConvert: () => navigate('#/convert'),
  };
}

/**
 * 路由渲染令牌。
 *
 * renderRoute 中间有两个 await（动态 import、视图 mount），这期间完全可能又来一次
 * 导航请求。没有令牌的话两边都会 mount，后完成的那个覆盖 currentInstance，
 * 先完成的实例就永远不会被 unmount —— 它的 store 订阅会一直活着，
 * 之后每次状态变化都继续跑（表现为「切走之后旧视图还在改状态栏」）。
 */
let routeToken = 0;

async function renderRoute() {
  const token = ++routeToken;
  const viewId = parseHash();
  const host = qs('#view');
  if (!host) return false;

  if (currentInstance && typeof currentInstance.unmount === 'function') {
    try {
      currentInstance.unmount();
    } catch (err) {
      console.error('[ui] 视图卸载异常', err);
    }
  }
  currentInstance = null;
  currentViewId = viewId;
  // 换视图时把右下角的实时信息清空，避免上一个视图的数字残留
  state.set({ activeView: viewId, statusInfo: [] });
  layout.setActive(viewId);

  clear(host);
  host.scrollTop = 0;
  host.appendChild(buildSkeleton());

  let mod = null;
  try {
    mod = await VIEWS[viewId]();
  } catch (err) {
    if (token !== routeToken) return false;
    clear(host);
    host.appendChild(buildViewError(viewId, wrapError(err, t('加载视图「{0}」失败', { 0: viewId }))));
    reportError(t('视图加载失败'), wrapError(err));
    return false;
  }
  // 动态 import 期间可能又有新的导航，本次渲染作废
  if (token !== routeToken) return false;

  const mount = mod && (mod.mount || (mod.default && mod.default.mount));
  if (typeof mount !== 'function') {
    clear(host);
    host.appendChild(buildViewError(viewId, new Error(t('视图模块 {0}.js 没有导出 mount()', { 0: viewId }))));
    return false;
  }

  clear(host);
  let mounted = false;
  try {
    const instance = await mount(host, makeContext(viewId));
    if (token !== routeToken) {
      // 已被更新的导航取代：把刚挂上的实例卸掉，别留下活着的订阅
      if (instance && typeof instance.unmount === 'function') {
        try {
          instance.unmount();
        } catch {
          /* 忽略 */
        }
      }
      return false;
    }
    currentInstance = instance || null;
    mounted = true;
  } catch (err) {
    if (token !== routeToken) return false;
    clear(host);
    host.appendChild(buildViewError(viewId, wrapError(err, t('渲染视图「{0}」失败', { 0: viewId }))));
    reportError(t('视图渲染失败'), wrapError(err));
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
        h('div', { textContent: t('视图「{0}」无法显示', { 0: viewId }) }),
        h('div', { textContent: err.message || String(err) })
      ),
      h('button.linkbtn', { type: 'button', on: { click: () => renderRoute() } }, h('span', { textContent: t('重试') })),
      h('button.linkbtn', { type: 'button', on: { click: () => navigate('#/convert') } }, h('span', { textContent: t('回到转换') }))
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
        message: t('作业 {0} 退出码 {1}：{2}', { 0: job.id, 1: outcome.exit_code, 2: String(outcome.stderr).slice(0, 400) }),
        jobId: job.id,
      });
    }
  }));

  disposers.push(bridge.on('evt:queue:idle', (counts) => {
    state.set({ queueCounts: counts || countsFromJobs(state.pick('jobs')) });
    const c = counts || {};
    if (c.total) {
      const bits = [t('完成 {0}', { 0: c.done || 0 })];
      if (c.failed) bits.push(t('失败 {0}', { 0: c.failed }));
      if (c.cancelled) bits.push(t('取消 {0}', { 0: c.cancelled }));
      toast.info(t('队列已空闲'), { text: bits.join(' · ') });
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
      toast.warn(t('没有识别到文件路径'), { text: t('请改用「添加文件」按钮，或把文件拖到待转换列表上。') });
      return;
    }
    await expandPaths(paths, { label: t('拖入内容') });
  });
}

/* ------------------------------------------------------------ 快捷键 */

const HOTKEYS = [
  { id: 'pick-files', keys: 'mod+o', label: t('添加文件'), run: () => pickFiles() },
  { id: 'pick-folder', keys: 'mod+shift+o', label: t('添加目录'), run: () => pickFolder() },
  { id: 'start-convert', keys: 'mod+enter', label: t('开始转换'), run: () => runAction('start-convert') },
  { id: 'refresh-kernels', keys: 'f5', label: t('刷新内核'), run: () => refreshKernels() },
  { id: 'palette', keys: 'mod+k', label: t('命令面板'), run: () => layout.openPalette() },
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
    toast.warn(t('该操作当前不可用'), {
      text: name === 'start-convert'
        ? '请先切换到转换视图并选择文件与目标格式。'
        : t('没有视图注册动作「{0}」。', { 0: name }),
    });
    return false;
  }
  try {
    fn(payload);
    return true;
  } catch (err) {
    reportError(t('执行操作失败'), wrapError(err));
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
      reportError(t('快捷键「{0}」执行失败', { 0: entry.label }), wrapError(err));
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
      group: t('前往'),
      title: item.label,
      subtitle: item.hash,
      kbd: shortcut(item.shortcut),
      keywords: `view navigate ${item.id}`,
      run: () => navigate(item.hash),
    });
  }

  commands.push({
    id: 'act:pick-files', group: '操作', title: t('添加文件'), subtitle: t('选择文件加入待转换列表'),
    kbd: shortcut('mod+O'), keywords: 'add file open', run: () => pickFiles(),
  });
  commands.push({
    id: 'act:pick-folder', group: '操作', title: t('添加目录'), subtitle: t('递归展开目录并加入待转换列表'),
    kbd: shortcut('mod+Shift+O'), keywords: 'add folder directory', run: () => pickFolder(),
  });
  commands.push({
    id: 'act:start', group: '操作', title: t('开始转换'), subtitle: t('把当前待转换列表提交到队列'),
    kbd: shortcut('mod+Enter'), keywords: 'start convert run', run: () => runAction('start-convert'),
  });
  commands.push({
    id: 'act:clear-pending', group: '操作', title: t('清空待转换列表'), subtitle: t('不移除磁盘上的文件'),
    keywords: 'clear pending list', run: () => clearPending(),
  });
  commands.push({
    id: 'act:advanced', group: '操作', title: t('打开高级面板'), subtitle: t('内核参数 / 输出目录 / 命令行预览'),
    keywords: 'advanced sheet params', run: () => navigate('#/convert', { name: 'open-advanced' }),
  });
  commands.push({
    id: 'act:refresh', group: '操作', title: t('刷新内核'), subtitle: t('重新扫描并重新探测依赖'),
    kbd: 'F5', keywords: 'refresh rescan kernel', run: () => refreshKernels(),
  });
  commands.push({
    id: 'act:theme', group: '操作',
    title: t('切换到{0}主题', { 0: (state.pick('settings') || {}).theme === 'dark' ? '浅色' : '深色' }),
    subtitle: t('主题会写入设置并持久化'), keywords: 'theme dark light 主题', run: () => toggleTheme(),
  });
  commands.push({
    id: 'act:output-dir', group: '操作', title: t('打开最近输出目录'), subtitle: state.pick('lastOutputDir') || '尚未设置',
    keywords: 'output dir open', run: () => openPathSafe(state.pick('lastOutputDir'), '最近输出目录'),
  });
  commands.push({
    id: 'act:hub-root', group: '操作', title: t('打开内核仓库目录'), subtitle: (state.pick('layout') || {}).hubRoot || '',
    keywords: 'hub root kernel dir', run: () => openPathSafe((state.pick('layout') || {}).hubRoot, '内核仓库'),
  });
  commands.push({
    id: 'act:doctor', group: '操作', title: t('运行自检并查看结果'), subtitle: t('Node / Electron / Python / 内核探测摘要'),
    keywords: 'doctor diagnose health',
    run: async () => {
      try {
        const report = await bridge.doctor();
        await modal.json('自检结果（doctor）', report, { subtitle: `CKP ${report.protocol || '—'}` });
      } catch (err) {
        reportError(t('自检失败'), wrapError(err));
      }
    },
  });
  commands.push({
    id: 'act:clear-logs', group: '操作', title: t('清空运行日志'), subtitle: t('同时清理主进程日志缓冲'),
    keywords: 'clear log', run: () => clearLogs(),
  });

  for (const op of ops) {
    if (!op || !op.op) continue;
    commands.push({
      id: `op:${op.op}`,
      group: '操作类型',
      title: t('切到「{0}」', { 0: op.label || op.op }),
      subtitle: t('{0} · {1} 个内核', { 0: op.op, 1: op.kernelCount || 0 }),
      keywords: `op ${op.op} ${op.label || ''}`,
      run: () => navigate('#/convert', { name: 'set-op', payload: op.op }),
    });
  }

  for (const kernel of ks.slice(0, 400)) {
    commands.push({
      id: `kernel:${kernel.id}`,
      group: '内核',
      title: kernel.name || kernel.id,
      subtitle: `${kernel.id} · ${statusText(kernel.status, kernel.statusLabel)}`,
      keywords: `kernel ${kernel.id} ${(kernel.tags || []).join(' ')} ${(kernel.inputFormats || []).join(' ')} ${(kernel.outputFormats || []).join(' ')}`,
      run: () => navigate('#/plugins', { name: 'focus-kernel', payload: kernel.id }),
    });
  }

  if (formatsCache) {
    for (const row of formatsCache.slice(0, 400)) {
      commands.push({
        id: `format:${row.format}`,
        group: '格式',
        title: String(row.format || '').toUpperCase(),
        subtitle: t('{0} 个内核', { 0: row.kernelCount }),
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
    toast.warn(t('没有可打开的{0}', { 0: label || '路径' }), { text: t('该路径尚未设置。') });
    return;
  }
  try {
    const res = await bridge.fs.openPath(path);
    if (res && res.ok === false) toast.warn(t('打开{0}失败', { 0: label || '路径' }), { text: String(path) });
  } catch (err) {
    reportError(t('打开{0}失败', { 0: label || '路径' }), wrapError(err));
  }
}

/** 清空日志（主进程 + 本地缓冲） */
async function clearLogs() {
  try {
    await bridge.logs.clear();
    replaceLogs([]);
    toast.success(t('日志已清空'));
  } catch (err) {
    reportError(t('清空日志失败'), wrapError(err));
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

    /** 可用格式清单（由内核能力派生，装/卸插件后会变）——用于验证格式缓存刷新 */
    formats: () => bridge.kernels.formats(),

    /** 内核在界面上的显示名（软件层面的命名：类型 + 最典型的两个扩展名） */
    kernelNames: () => (state.pick('kernels') || []).map((k) => k && k.name).filter(Boolean),

    /** 内核的代码层面原名与 id，用来核对「改名只影响界面」 */
    kernelCodeNames: () =>
      (state.pick('kernels') || []).map((k) => k && { id: k.id, codeName: k.codeName }).filter(Boolean),

    /** 转换页当前渲染出的目标格式下拉项（空值过滤掉） */
    targetOptions: () =>
      Array.from(document.querySelectorAll('select[data-role="target"] option'))
        .map((o) => o.value)
        .filter(Boolean),

    /** 重扫内核 + 刷新格式缓存：与「插件」页装完/卸完后的动作完全一致 */
    refreshKernels: (opts) => refreshKernels(opts || { announce: false }),

    /* ------------------------------------------------------- 通知与动效
     * 2.0.3 新增：通知是「同类型互相覆盖」而不是堆叠，这里给自检一个可观测的入口。
     */
    toastCounts: () => toast.counts(),
    toastCount: () => toast.count(),
    toastClear: () => toast.clear(),
    /** 手动弹一条通知（动效验证工具用，也可在调试时手动造场景） */
    toastShow: (type, title, text) => toast[type] ? toast[type](title, text ? { text } : undefined) : null,

    /**
     * 连发两条同类型 + 一条不同类型，返回每一步的计数。
     * 期望：两条成功 → 成功只有 1 条（覆盖）；再来一条错误 → 总共 2 条。
     */
    toastProbe() {
      toast.clear();
      toast.success(t('第一条成功'));
      const afterOne = toast.counts();
      toast.success(t('第二条成功'));
      const afterSame = toast.counts();
      toast.error(t('一条错误'));
      const afterDiff = toast.counts();
      return { afterOne, afterSame, afterDiff, total: toast.count() };
    },

    /** 进度条的关键计算样式（验证加粗与缓进缓出是否生效） */
    progressStyle() {
      const track = document.createElement('div');
      track.className = 'progress';
      const fill = document.createElement('div');
      fill.className = 'progress__fill';
      track.appendChild(fill);
      document.body.appendChild(track);
      const cs = getComputedStyle(track);
      const cf = getComputedStyle(fill);
      const out = {
        height: cs.height,
        transitionProperty: cf.transitionProperty,
        transitionDuration: cf.transitionDuration,
        transitionTimingFunction: cf.transitionTimingFunction,
      };
      track.remove();
      return out;
    },

    /** 分段选项卡的完整状态（自检用：定位「指示条没动」这类问题） */
    segmentedInfo() {
      const buttons = Array.from(document.querySelectorAll('.segmented__btn'));
      const indicators = Array.from(document.querySelectorAll('.segmented__indicator'));
      return {
        buttonCount: buttons.length,
        indicatorCount: indicators.length,
        buttons: buttons.map((b) => ({
          label: b.innerText.trim(),
          active: b.dataset.active === 'true',
          offsetLeft: b.offsetLeft,
          offsetWidth: b.offsetWidth,
          connected: b.isConnected,
          offsetParent: b.offsetParent ? b.offsetParent.className : null,
        })),
        indicators: indicators.map((i) => ({
          transform: getComputedStyle(i).transform,
          width: getComputedStyle(i).width,
          // 内联样式是「目标值」。自检窗口不可见时 Chromium 不产生帧，
          // 过渡会停在起点，computed transform 读不到终值 —— 判断是否移动要看这个。
          inlineTransform: i.style.transform,
          transitionDuration: getComputedStyle(i).transitionDuration,
          transitionTimingFunction: getComputedStyle(i).transitionTimingFunction,
          connected: i.isConnected,
        })),
      };
    },

    /** 点击「可安装 / 已安装」分段按钮；返回按钮信息或 null */
    clickSegment(label) {
      const btn = Array.from(document.querySelectorAll('.segmented__btn')).find(
        (b) => b.innerText.trim() === label
      );
      if (!btn) return null;
      btn.click();
      return { label: btn.innerText.trim(), active: btn.dataset.active === 'true' };
    },

    /** 侧栏选中指示块的状态（自检用：验证它滑到了当前项上） */
    navIndicator() {
      const ind = document.querySelector('.nav__indicator');
      const active = document.querySelector('.nav__item[aria-current="page"]');
      if (!ind) return null;
      const cs = getComputedStyle(ind);
      return {
        inlineTransform: ind.style.transform,
        inlineHeight: ind.style.height,
        activeLabel: active ? active.innerText.replace(/\s+/g, ' ').trim() : null,
        activeOffsetTop: active ? active.offsetTop : null,
        activeOffsetHeight: active ? active.offsetHeight : null,
        transitionDuration: cs.transitionDuration,
        transitionTimingFunction: cs.transitionTimingFunction,
      };
    },

    /** 开启动画当前状态（自检用：验证它已收起、不挡界面） */
    splashState() {
      const el = document.getElementById('splash');
      if (!el) return { present: false };
      const bar = document.getElementById('splash-bar');
      const status = document.getElementById('splash-status');
      return {
        present: true,
        done: el.classList.contains('splash--done'),
        opacity: getComputedStyle(el).opacity,
        status: status ? status.textContent : '',
        barWidth: bar ? bar.style.width : '',
      };
    },

    /** 右下角实时信息当前的内容（自检用：验证它跟着视图走） */
    statusInfo() {
      return Array.from(document.querySelectorAll('#statusbar .statusbar__seg')).map((el) =>
        el.textContent.trim()
      );
    },

    /** 设置页分类指示块的状态（自检用） */
    settingsNavIndicator() {
      const ind = document.querySelector('.settings-nav__indicator');
      const active = document.querySelector('.settings-nav__item[aria-current="page"]');
      if (!ind) return null;
      return {
        inlineTransform: ind.style.transform,
        inlineHeight: ind.style.height,
        activeLabel: active ? active.innerText.trim() : null,
        activeOffsetTop: active ? active.offsetTop : null,
        activeOffsetHeight: active ? active.offsetHeight : null,
        transitionTimingFunction: getComputedStyle(ind).transitionTimingFunction,
        transitionDuration: getComputedStyle(ind).transitionDuration,
      };
    },

    /** 点击设置页的某个分类 */
    clickSettingsCategory(label) {
      const item = Array.from(document.querySelectorAll('.settings-nav__item')).find(
        (el) => el.innerText.trim() === label
      );
      if (!item) return false;
      item.click();
      return true;
    },

    /** 抽屉（高级面板）当前状态：是否打开、计算后的透明度与位移 */
    sheetState() {
      const root = document.querySelector('.sheet-host');
      const panel = document.querySelector('.sheet');
      if (!root || !panel) return null;
      const cs = getComputedStyle(panel);
      return {
        hidden: Boolean(root.hidden),
        open: root.dataset.open === 'true',
        opacity: cs.opacity,
        transform: cs.transform,
        hasTransition: /transform/.test(cs.transitionProperty),
        transitionDuration: cs.transitionDuration,
      };
    },

    /** i18n 状态（自检用）：当前语言、词典条目数、导航标签 */
    i18nInfo() {
      return {
        locale: getLocale(),
        entries: translationCount(),
        hasConvert: hasTranslation('转换'),
        navLabel: (NAV_ITEMS[0] || {}).label || '',
        docLang: document.documentElement.getAttribute('lang') || '',
      };
    },

    /** 当前视图里可见的文本（自检用：验证中文路径在界面上不被截断/乱码） */
    viewText() {
      const view = document.querySelector('#view');
      return view ? view.innerText.replace(/\s+/g, ' ').trim().slice(0, 600) : '';
    },

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
    // 没有桥接时也要收起开启动画，否则降级提示页被挡在后面看不见
    dismissSplash();
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
    reportError: (err) => reportError(t('界面操作失败'), wrapError(err)),
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

  // 视图把实时信息推到状态栏右下角时，重绘一次外壳（只重画状态栏那一段数据）
  state.subscribe((s, changed) => {
    if (changed.includes('statusInfo')) renderShell();
  });

  bindHotkeys();
  bindBridgeEvents();

  await boot();
  await renderRoute();

  installTestHooks();

  // 界面已就绪：收起开启动画（有最短展示时间，避免快机器上一闪而过）
  dismissSplash();

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
  toast.error(t('未处理的异步错误'), { text: message });
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
        h('div.error-state__msg', { textContent: t('应用启动失败：{0}', { 0: err && err.message ? err.message : String(err) }) }),
        h('button.linkbtn', { type: 'button', on: { click: () => location.reload() } }, h('span', { textContent: t('重新加载') }))
      )
    ));
  }
});
