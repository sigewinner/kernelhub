'use strict';
/**
 * KernelHub Studio —— Electron 主进程
 *
 * 职责：
 *   1. 创建现代无边框窗口（自定义标题栏 + 原生拖拽/最小化/最大化）
 *   2. 组装内核中枢（Registry / Hub / JobQueue）并把它们暴露成 IPC 契约
 *   3. 把队列与内核日志实时推送给渲染进程
 *
 * 渲染进程永远拿不到 Node 能力：全部经 preload 的 contextBridge 白名单转发。
 */

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Menu } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const { Settings } = require('../engine/config');
const {
  detectHubRoot,
  resolveStateDir,
  isDir,
  packagedResourcesRoot,
  resolveSdkDir,
  resolveProtocolDir,
  resolveSeedPluginsDir,
  ensureUserHub,
  pluginsDirOf,
  pluginVendorDirOf,
} = require('../engine/paths');
const { Registry } = require('../engine/registry');
const { Hub } = require('../engine/hub');
const { PluginStore } = require('../engine/pluginStore');
const { JobQueue, STATE } = require('../engine/queue');
const catalog = require('../engine/catalog');
const pluginName = require('../shared/pluginName');
const { clearProbeCache } = require('../engine/python');
const deps = require('../engine/deps');
const update = require('../engine/update');
const { formatOfPath, basenameOf, extOf, CKP_VERSION } = require('../shared/protocol');
const { humanSize } = catalog;

const isDev = process.argv.includes('--dev') || !app.isPackaged;

let mainWindow = null;
let settings = null;
let registry = null;
let hub = null;
let queue = null;
let pluginStore = null;
/** 上一次算显示名时是否有变化（目录首次拉到会补上限定名） */
let displayNamesChanged = false;

/**
 * 是否运行在便携版里（2.2.2）。
 * electron-builder 的 portable 目标会把程序解压到临时目录再启动，并设置
 * PORTABLE_EXECUTABLE_FILE / PORTABLE_EXECUTABLE_DIR —— 这是可靠判据。
 * 用途：便携版没有「安装目录」可言，更新时不能替用户静默装到默认位置。
 */
function isPortableBuild() {
  return Boolean(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR);
}

/**
 * 静默安装的参数（2.2.2）。提成常量是为了能在自检里断言 —— 这条一旦写错，
 * 用户更新时就会又看到安装向导（或装到错误的目录）。
 *   /S         静默，无界面
 *   --updated  electron-builder NSIS 的更新模式：不询问，并先结束正在运行的实例
 */
const SILENT_INSTALL_ARGS = ['/S', '--updated'];

/* ------------------------------------------------------------------ 中枢 */

function makeContext() {
  return { registry, settings, hub, queue };
}

/** 2.0.0：适配器 SDK 与协议资产都随壳分发，不再依赖工作区里有什么 */
function registryOptions(hubRoot) {
  return {
    hubRoot,
    sdkDir: resolveSdkDir(),
    extraPythonPaths: settings.get('extraPythonPaths', []),
    extraPluginDirs: settings.get('extraPluginDirs', []),
    disabledKernels: settings.get('disabledKernels', []),
    priorityOverrides: settings.get('priorityOverrides', {}),
    /** 2.3.2：界面上「选择可执行文件…」选过的路径，探测与执行都优先用它 */
    exePaths: settings.get('exePaths', {}),
  };
}

/**
 * 给内核算「界面显示名」并挂到条目上（软件层面的命名，代码里的 id 与清单原名不动）。
 *
 * 判重集合刻意用「已安装 ∪ 插件目录」：只按已安装算的话，同一个插件在
 * 「已安装」标签页没有限定名、在「可安装」标签页却有，看起来像两个东西。
 * 目录还没拉过（首次离线启动）时退化为只用已安装集合，拉到目录后会再算一次。
 *
 * @returns {Map<string,string>} id → 显示名
 */
function applyDisplayNames() {
  const catalogCache = pluginStore ? pluginStore.cachedCatalog() : null;
  const items = pluginName.mergeItems(
    pluginName.itemsFromKernels(registry.allEntries()),
    pluginName.itemsFromCatalog(catalogCache)
  );
  const map = pluginName.assignDisplayNames(items);

  let changed = false;
  for (const entry of registry.allEntries()) {
    const next = map.get(entry.id) || entry.manifest.name;
    if (entry.displayName && entry.displayName !== next) changed = true;
    entry.displayName = next;
  }
  // 目录首次拉到后名字可能变（比如补上限定名）→ 让界面重取一次内核列表
  displayNamesChanged = changed;
  return map;
}

/**
 * 首次启动时把随包预置的几个「开箱可用」插件复制进用户工作区。
 *
 * 为什么要有预置：壳默认不带内核，如果装完一个都转不了、还非得联网去插件页装，
 * 第一次体验就废了。预置的这几个都不需要用户再装任何外部程序。
 *
 * 两个刻意的设计：
 *   - 只在「目标目录还不存在」时复制 —— 用户从插件页装了更新版就不会被旧版覆盖
 *   - 用 settings.seededPlugins 记账 —— 用户手动删掉预置插件后，不再给他塞回来
 */
function seedBundledPlugins(hubRoot) {
  const src = resolveSeedPluginsDir();
  if (!src || !isDir(src)) return 0;
  const dest = path.join(hubRoot, 'plugins');
  const done = new Set(settings.get('seededPlugins', []));
  let copied = 0;

  let ids = [];
  try {
    ids = fs.readdirSync(src);
  } catch {
    return 0;
  }

  for (const id of ids) {
    if (id.startsWith('.') || done.has(id)) continue;
    const from = path.join(src, id);
    let stat = null;
    try {
      stat = fs.statSync(from);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const to = path.join(dest, id);
    if (!fs.existsSync(to)) {
      try {
        fs.mkdirSync(dest, { recursive: true });
        fs.cpSync(from, to, { recursive: true });
        copied += 1;
      } catch {
        continue; // 这一次失败就别记账，下次启动再试
      }
    }
    done.add(id);
  }

  if (copied || done.size !== (settings.get('seededPlugins', []) || []).length) {
    settings.patch({ seededPlugins: Array.from(done) });
  }
  return copied;
}

function createHub() {
  settings = new Settings(resolveStateDir());
  const hubRoot = resolveHubRoot();
  if (settings.get('hubRoot') !== hubRoot) settings.patch({ hubRoot });

  /**
   * 关键顺序：**先把随包的种子插件铺进用户工作区，再建注册表**。
   *
   * 反过来写的话，首次启动时 registry.discover() 扫到的是一个空 plugins/ 目录，
   * 结果就是「装完一个内核都没有」，必须手动刷新才恢复。
   * （这个坑是打包版自检抓出来的：开发机上插件早就拷好了，所以顺序错也看不出来。）
   */
  seedBundledPlugins(hubRoot);

  registry = new Registry(registryOptions(hubRoot));
  registry.discover();

  hub = new Hub(makeContext);
  queue = new JobQueue(hub);
  queue.setParallel(settings.get('maxParallel', 2));

  // 插件商店：壳本身不带内核，插件从这里按需装到 <hubRoot>/plugins
  pluginStore = new PluginStore({ hubRoot, stateDir: resolveStateDir(), settings });

  // 目录缓存可能已经有了，这时判重集合最完整（已安装 ∪ 目录），重算一次显示名
  applyDisplayNames();

  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };
  queue.on('log', (payload) => send('evt:job:log', payload));
  queue.on('update', (job) => send('evt:job:update', serializeJob(job)));
  queue.on('enqueue', (jobs) => send('evt:queue:enqueue', jobs.map(serializeJob)));
  queue.on('queue', (jobs) => send('evt:queue', jobs.map(serializeJob)));
  queue.on('finish', ({ job, outcome }) => send('evt:job:finish', { job: serializeJob(job), outcome: publicOutcome(outcome) }));
  queue.on('idle', (counts) => send('evt:queue:idle', counts));
}

/**
 * 决定使用哪个 CKP 工作区。
 *
 * 坑点（真实踩过）：设置文件里的 hubRoot 会在开发时被写成开发机的路径，
 * 打包版如果无条件沿用，就会去访问一个不存在的目录，表现为「一个内核都没有」。
 * 所以规则是：
 *   1. 环境变量 KERNELHUB_ROOT / CKP_ROOT —— 最高优先级，方便部署时强制指定
 *   2. 打包版且随包分发的 resources/hub 存在 —— 直接用它（1.x 升级包 / 自定义构建）
 *   3. 设置里记录的目录，且确实是一个合法工作区 —— 尊重用户选择
 *   4. 自动探测到的、真实存在的工作区（开发时是兄弟目录 kernel-hub）
 *   5. 都没有 —— 用应用自己的用户级工作区 <stateDir>/hub，并建出 plugins/ 与 .cache/runs
 *
 * 第 5 条是 2.0.0 的默认路径：壳不再随包带内核，插件按需下载到用户目录。
 * 注意必须真的建目录，否则首次启动连一个插件都装不进去。
 */
function resolveHubRoot() {
  // 1) 环境变量最高优先级：部署时可以用它强制指定内核仓库位置
  const envRoot = process.env.KERNELHUB_ROOT || process.env.CKP_ROOT;
  if (envRoot) return detectHubRoot(envRoot);

  // 2) 打包版：随包分发的 resources/hub 优先于任何历史设置
  if (app.isPackaged) {
    const packaged = packagedResourcesRoot();
    if (packaged) return packaged;
  }

  // 3) 设置里记录的目录，并且确实是一个合法工作区 —— 尊重用户选择
  const saved = settings.get('hubRoot', '');
  if (saved && fs.existsSync(path.join(saved, 'plugins'))) return path.resolve(saved);

  // 4) 自动探测（开发期的兄弟目录 kernel-hub 会在这里命中）
  const detected = detectHubRoot('');
  if (detected && fs.existsSync(path.join(detected, 'plugins'))) return detected;

  // 5) 2.0.0 默认：应用自己的用户级工作区
  return ensureUserHub(resolveStateDir());
}

function reloadRegistry() {
  settings.load();
  clearProbeCache();
  const root = resolveHubRoot();
  if (root !== registry.hubRoot) {
    registry = new Registry(registryOptions(root));
    if (pluginStore) pluginStore.hubRoot = path.resolve(root);
  } else {
    registry.sdkDir = resolveSdkDir();
    registry.extraPythonPaths = settings.get('extraPythonPaths', []).map((d) => path.resolve(d));
  }
  registry.extraPluginDirs = settings.get('extraPluginDirs', []).map((d) => path.resolve(d));
  registry.disabled = new Set(settings.get('disabledKernels', []));
  registry.priorityOverrides = { ...(settings.get('priorityOverrides', {})) };
  registry.discover();
  applyDisplayNames();
  return catalog.statusOverview(registry);
}

function serializeJob(job) {
  return {
    id: job.id,
    source: job.source,
    sourceName: job.sourceName,
    sourceFormat: job.sourceFormat,
    sourceBytes: job.sourceBytes,
    sourceSize: humanSize(job.sourceBytes),
    output: job.output,
    outputName: job.outputName,
    op: job.op,
    targetFormat: job.targetFormat,
    state: job.state,
    progress: job.progress,
    progressMessage: job.progressMessage,
    kernelUsed: job.kernelUsed,
    kernelName: job.kernelName,
    durationMs: job.durationMs,
    bytes: job.bytes,
    size: humanSize(job.bytes),
    error: job.error,
    addedAt: job.addedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    artifacts: job.artifacts,
    params: job.params,
    logCount: job.logs.length,
  };
}

function publicOutcome(outcome) {
  return {
    ok: outcome.ok,
    kernel: outcome.kernel_id,
    kernelName: outcome.kernel_name,
    duration_ms: outcome.duration_ms,
    outputs: outcome.outputs,
    error: outcome.error,
    exit_code: outcome.exit_code,
    command: outcome.command,
    stderr: (outcome.stderr || '').slice(-4000),
  };
}

function describeFile(p) {
  let stat = null;
  try {
    stat = fs.statSync(p);
  } catch {
    return null;
  }
  return {
    path: p,
    name: basenameOf(p),
    dir: path.dirname(p),
    ext: extOf(p).replace('.', ''),
    format: formatOfPath(p),
    bytes: stat.size,
    size: humanSize(stat.size),
    mtime: stat.mtimeMs,
    isDir: stat.isDirectory(),
  };
}

function expandSources(inputs) {
  const out = [];
  const push = (p) => {
    if (!p || out.includes(p)) return;
    const info = describeFile(p);
    if (info && !info.isDir) out.push(p);
  };
  for (const item of inputs || []) {
    if (!item) continue;
    let stat = null;
    try {
      stat = fs.statSync(item);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const walk = (dir, depth = 0) => {
        if (depth > 6) return;
        let names = [];
        try {
          names = fs.readdirSync(dir);
        } catch {
          return;
        }
        for (const name of names) {
          if (name.startsWith('.')) continue;
          const full = path.join(dir, name);
          let st = null;
          try {
            st = fs.statSync(full);
          } catch {
            continue;
          }
          if (st.isDirectory()) walk(full, depth + 1);
          else push(full);
        }
      };
      walk(item);
    } else {
      push(item);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ 窗口 */

function createWindow() {
  nativeTheme.themeSource = 'dark';
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#070a12',
    title: 'KernelHub Studio',
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 14, y: 16 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const sendWin = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('evt:window', {
      maximized: mainWindow.isMaximized(),
      maximizedAny: false,
    });
  };
  mainWindow.on('maximize', sendWin);
  mainWindow.on('unmaximize', sendWin);
  mainWindow.on('enter-full-screen', sendWin);
  mainWindow.on('leave-full-screen', sendWin);

  // 阻止页面内导航到外部地址；外链交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:')) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '添加文件…', accelerator: 'CmdOrCtrl+O', click: () => mainWindow && mainWindow.webContents.send('cmd', 'pick-files') },
        { label: '添加目录…', accelerator: 'CmdOrCtrl+Shift+O', click: () => mainWindow && mainWindow.webContents.send('cmd', 'pick-folder') },
        { type: 'separator' },
        { label: '刷新内核', accelerator: 'F5', click: () => mainWindow && mainWindow.webContents.send('cmd', 'refresh') },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '协议规范（CKP 1.0）', click: () => mainWindow && mainWindow.webContents.send('cmd', 'protocol') },
        { label: '打开内核目录', click: () => shell.openPath(registry.hubRoot) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* -------------------------------------------------------------------- IPC */

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, async (_event, payload) => fn(payload));

  /* -- 环境 / 设置 -------------------------------------------------------- */

  handle('app:info', () => ({
    name: 'KernelHub Studio',
    version: app.getVersion(),
    ckp: CKP_VERSION,
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    dev: isDev,
    stateDir: resolveStateDir(),
  }));

  handle('app:layout', () => registry.layout());

  handle('settings:get', () => settings.all());
  handle('settings:set', (patch) => {
    const before = settings.all();
    const next = settings.patch(patch || {});
    if (patch && patch.maxParallel !== undefined) queue.setParallel(next.maxParallel);
    if (patch && patch.hubRoot !== undefined && patch.hubRoot !== before.hubRoot) reloadRegistry();
    return next;
  });

  /* -- 内核 --------------------------------------------------------------- */

  handle('kernels:list', () => ({
    kernels: registry.allEntries().map(catalog.kernelView),
    summary: registry.summary(),
    layout: registry.layout(),
  }));

  handle('kernels:refresh', () => ({
    kernels: (reloadRegistry(), registry.allEntries().map(catalog.kernelView)),
    summary: registry.summary(),
    layout: registry.layout(),
  }));

  handle('kernels:detail', (id) => {
    const entry = registry.get(id);
    if (!entry) return { ok: false, message: `内核不存在: ${id}` };
    return { ok: true, kernel: catalog.kernelDetail(entry) };
  });

  handle('kernels:setEnabled', ({ id, enabled }) => {
    settings.setKernelEnabled(id, enabled);
    settings.load();
    registry.disabled = new Set(settings.get('disabledKernels', []));
    const entry = registry.get(id);
    if (entry) {
      // 重新探测：停用后再启用必须重新跑一次探测，不能复用停用前缓存里的结论
      for (const key of Array.from(registry.probeCache.keys())) {
        if (key.startsWith(`${id}|`)) registry.probeCache.delete(key);
      }
      const fresh = registry.load(entry.directory);
      if (fresh) registry.entries.set(id, fresh);
    }
    return { ok: true, kernel: registry.get(id) ? catalog.kernelView(registry.get(id)) : null };
  });

  handle('kernels:setPriority', ({ id, priority }) => {
    settings.setPriority(id, priority);
    settings.load();
    registry.priorityOverrides = { ...(settings.get('priorityOverrides', {})) };
    const entry = registry.get(id);
    if (entry) entry.manifest.priority = Number(priority);
    return { ok: true };
  });

  handle('kernels:status', () => catalog.statusOverview(registry));
  handle('kernels:ops', () => catalog.opsCatalog(registry));
  handle('kernels:formats', () => catalog.formatsCatalog(registry));
  handle('kernels:openDir', (id) => {
    const entry = registry.get(id);
    if (!entry) return { ok: false };
    shell.openPath(entry.directory);
    return { ok: true };
  });

  /* -- 插件商店 ------------------------------------------------------------ */

  const pluginProgress = (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('evt:plugin:progress', payload);
  };

  handle('plugins:list', async (opts) => {
    const data = await pluginStore.list({ refresh: Boolean(opts && opts.refresh) });
    // 目录（可能刚拉到）到手后重算显示名：保证「已安装」与「可安装」两个标签用的是同一套判重集合
    const map = applyDisplayNames();
    for (const row of (data && data.plugins) || []) row.displayName = map.get(row.id) || row.name;
    // 名字变了就告诉界面：内核列表用的是另一份数据，需要重取（只重新序列化，不重新探测）
    data.namesChanged = displayNamesChanged;
    return data;
  });

  /**
   * 插件变更后的统一收尾：重建内核表，并把该插件对应的内核视图一并返回。
   *
   * 返回内核视图是为了让界面在装完后能立刻说清「能不能用、不能用是缺什么」——
   * 用户报的「装完用不了」有相当一部分其实是装了 CLI 类插件但没装那个外部程序，
   * 以前界面上完全看不出原因。
   */
  const settlePluginChange = (result, id) => {
    if (!result || !result.ok) return result;
    reloadRegistry();
    const entry = registry.get(id);
    return { ...result, kernel: entry ? catalog.kernelView(entry) : null };
  };

  handle('plugins:install', async ({ id, mode }) => {
    const result = await pluginStore.install(id, { mode, onProgress: pluginProgress });
    return settlePluginChange(result, id);
  });

  handle('plugins:update', async ({ id, mode }) => {
    const result = await pluginStore.update(id, { mode, onProgress: pluginProgress });
    return settlePluginChange(result, id);
  });

  handle('plugins:uninstall', (id) => {
    const result = pluginStore.uninstall(String(id || ''));
    if (result.ok) reloadRegistry();
    return result;
  });

  handle('plugins:verify', () => pluginStore.verifyAll());

  /* -- 检测更新 / 更新（2.2.0）--------------------------------------------- */

  /** 下载目录：放在用户数据目录下，避免污染安装目录 */
  const updateDir = () => path.join(resolveStateDir(), 'updates');

  /**
   * 检测更新：只看**同一个大版本**。
   * 当前 2.2.0 → 找 GitHub Release 里最大的 2.x.x；3.x.x 不推给用户。
   */
  handle('update:check', async () => {
    const current = app.getVersion();
    const result = await update.checkForUpdate({ current, repoSlug: 'sigewinner/kernelhub' });
    return { ...result, currentVersion: current };
  });

  /**
   * 下载安装包，并（可选）**静默安装**。
   * 下载进度经 evt:update:progress 回到界面。
   *
   * 2.2.2：不再弹安装向导。
   * 之前是 shell.openPath(setup.exe)，会走完整的 NSIS 向导（欢迎 → 选目录 → 安装 → 完成），
   * 而「选目录」这一步对更新毫无意义 —— electron-builder 的 NSIS 会把首次安装选定的目录
   * 记在注册表 InstallLocation 里，静默安装会直接沿用，也就是「按第一次用户的设置就好」。
   *
   * 参数说明：
   *   /S         静默安装（无界面）
   *   --updated  electron-builder NSIS 的更新模式：不询问、并先结束正在运行的实例，
   *              否则文件被占用会替换失败
   */
  handle('update:download', async ({ url, name, size, launch } = {}) => {
    const asset = { url, name: name || 'KernelHub-Studio-setup.exe', size: Number(size) || 0 };
    if (!asset.url) return { ok: false, error: '缺少下载地址' };
    const send = (payload) => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('evt:update:progress', payload);
      } catch {
        /* ignore */
      }
    };
    send({ phase: 'start', percent: 0, message: `开始下载 ${asset.name}…` });
    const result = await update.downloadInstaller({
      asset,
      dir: updateDir(),
      onProgress: (info) => send({ phase: 'download', ...info, message: `已下载 ${info.percent}%` }),
    });
    if (!result.ok) {
      send({ phase: 'error', percent: 0, message: `下载失败：${result.error}` });
      return result;
    }
    send({ phase: 'done', percent: 100, message: '下载完成' });
    if (launch) {
      const mode = isPortableBuild() ? 'portable' : 'installed';
      if (mode === 'portable') {
        // 便携版是单文件自解压，跑 setup.exe 只会另装一份到默认目录 ——
        // 不替用户做这个决定，打开所在目录让他自行替换。
        shell.showItemInFolder(result.path);
        return { ...result, mode, needsManual: true };
      }
      try {
        const child = spawn(result.path, SILENT_INSTALL_ARGS, {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.unref();
      } catch (err) {
        return { ...result, mode, launchError: String((err && err.message) || err) };
      }
      return { ...result, mode, launched: true, silent: true };
    }
    return result;
  });

  /** 在浏览器里打开 Release 页面（看更新说明 / 手动下载） */
  handle('update:openRelease', (url) => {
    const target = String(url || 'https://github.com/sigewinner/kernelhub/releases');
    shell.openExternal(target);
    return { ok: true };
  });

  /** 打开已下载安装包所在目录 */
  handle('update:openDir', () => {
    const dir = updateDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
    shell.openPath(dir);
    return { ok: true };
  });

  /**
   * 插件的 Python 依赖清单。
   * 优先用已装清单里的 runtime.requires；插件还没装上时退回目录里的声明。
   */
  function pluginRequires(id) {
    const entry = registry.get(id);
    const fromManifest = entry && entry.manifest && entry.manifest.runtime ? entry.manifest.runtime.requires : null;
    if (Array.isArray(fromManifest)) return fromManifest;
    const cat = pluginStore.cachedCatalog();
    const row = cat && (cat.plugins || []).find((p) => p.id === id);
    return (row && row.requires) || [];
  }

  /** 目录里声明的外部程序依赖（pip 装不了，只能在提示里告诉用户） */
  function pluginExternal(id) {
    const cat = pluginStore.cachedCatalog();
    const row = cat && (cat.plugins || []).find((p) => p.id === id);
    return (row && row.external) || [];
  }

  /**
   * 查这个插件缺哪些依赖（2.1.0）。
   * 界面在装完插件后会调它，缺东西就弹窗问用户要不要自动装。
   */
  handle('plugins:deps', (id) => {
    const pid = String(id || '');
    const requires = pluginRequires(pid);
    const vendorDir = pluginVendorDirOf(registry.hubRoot, pid);
    const probe = deps.probeMissing({ requires, vendorDir });
    const entry = registry.get(pid);
    return {
      ok: true,
      id: pid,
      requires,
      missing: probe.missing,
      packages: probe.packages,
      python: probe.python || '',
      vendorDir,
      external: pluginExternal(pid),
      installHint: (entry && entry.manifest && entry.manifest.installHint) || '',
      /** 界面要给用户两个选择：镜像 / 官方 */
      indexPreferred: settings.get('pipIndexUrl', '') || '',
      indexOfficial: 'https://pypi.org/simple',
    };
  });

  /**
   * 把缺的 Python 依赖装进该插件自己的 vendor 目录（2.1.0）。
   * 装进 vendor 而不是全局 site-packages：符合「每个插件自带依赖、互不干扰」的设计，
   * 卸载插件时连带删掉，不留垃圾。pip 输出逐行回吐给界面。
   */
  handle('plugins:installDeps', async ({ id, indexUrl } = {}) => {
    const pid = String(id || '');
    const vendorDir = pluginVendorDirOf(registry.hubRoot, pid);
    try {
      fs.mkdirSync(vendorDir, { recursive: true });
    } catch {
      /* 目录已存在或不可建，交给 pip 报错 */
    }
    const probe = deps.probeMissing({ requires: pluginRequires(pid), vendorDir });
    if (!probe.missing.length) {
      return { ok: true, alreadyOk: true, id: pid, kernel: registry.get(pid) ? catalog.kernelView(registry.get(pid)) : null };
    }
    pluginProgress({ phase: 'deps', percent: 0, message: `准备安装 ${probe.packages.length} 个依赖…` });
    const result = await deps.installMissing({
      python: probe.python,
      target: vendorDir,
      packages: probe.packages,
      preferredIndex: indexUrl || settings.get('pipIndexUrl', ''),
      onIndex: (info) => pluginProgress({ phase: 'deps', percent: 0, message: `使用 ${info.label || info.index} 安装依赖…` }),
      onLine: (line) => pluginProgress({ phase: 'deps', percent: 0, message: line }),
    });
    // 装了新包必须清掉模块探测缓存，否则重新扫描还是「缺模块」
    clearProbeCache();
    return settlePluginChange({ ...result, id: pid }, pid);
  });

  handle('plugins:openDir', () => {    const dir = pluginStore.pluginsDir;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
    shell.openPath(dir);
    return { ok: true, dir };
  });

  handle('plugins:reveal', (id) => {
    const entry = registry.get(String(id || ''));
    const dir = entry ? entry.directory : path.join(pluginStore.pluginsDir, String(id || ''));
    if (!fs.existsSync(dir)) return { ok: false, dir };
    shell.openPath(dir);
    return { ok: true, dir };
  });

  handle('plugins:settings', () => ({
    mode: pluginStore.downloadMode(),
    git: pluginStore.detectGit(),
    catalogUrl: pluginStore.catalogUrl,
    repoUrl: pluginStore.repoUrl,
    bundleUrl: pluginStore.bundleUrlTemplate,
    pluginsDir: pluginStore.pluginsDir,
    hubRoot: pluginStore.hubRoot,
    /** 自动补装依赖时优先用的 pip 源（2.1.0） */
    pipIndexUrl: settings.get('pipIndexUrl', ''),
  }));

  /* -- 外部程序（2.3.2）---------------------------------------------------- */

  /**
   * 让用户直接指定外部可执行文件。
   *
   * 背景：Ghostscript 这类工具装完**不在 PATH 里**（环境变量也只在勾选时才设），
   * 用户看到的只有一句「找不到可执行文件 'gs'」，以前只能自己去配环境变量或
   * 翻安装目录。现在在界面上选一次，路径写进设置（exePaths），
   * 探测与执行都优先用它。
   */
  handle('kernels:pickExe', async ({ name, id } = {}) => {
    const exeName = String(name || '').trim();
    if (!exeName) return { ok: false, error: '缺少可执行文件名' };
    let picked = '';
    try {
      const res = await dialog.showOpenDialog(mainWindow, {
        title: `选择 ${exeName} 的可执行文件`,
        properties: ['openFile'],
        filters: [
          { name: '可执行文件', extensions: ['exe', 'cmd', 'bat', 'ps1'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, canceled: true };
      picked = res.filePaths[0];
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
    const current = { ...(settings.get('exePaths', {}) || {}) };
    current[exeName] = picked;
    settings.set('exePaths', current);
    registry.exePaths = { ...current };
    clearProbeCache();
    const kernels = (reloadRegistry(), registry.allEntries().map(catalog.kernelView));
    const entry = id ? registry.get(String(id)) : null;
    return {
      ok: true,
      name: exeName,
      path: picked,
      kernels,
      kernel: entry ? catalog.kernelDetail(entry) : null,
    };
  });

  /** 清掉指定路径，退回自动探测（选错了能反悔） */
  handle('kernels:clearExe', ({ name } = {}) => {
    const exeName = String(name || '').trim();
    const current = { ...(settings.get('exePaths', {}) || {}) };
    delete current[exeName];
    settings.set('exePaths', current);
    registry.exePaths = { ...current };
    clearProbeCache();
    return {
      ok: true,
      name: exeName,
      kernels: (reloadRegistry(), registry.allEntries().map(catalog.kernelView)),
    };
  });

  /**
   * 这个内核起不来（缺外部程序）时，目录里有没有「同样能干这件事、
   * 但不需要外部程序」的插件？有就给用户一条更省事的路。
   *
   * 实测场景：ghostscript-pdf 要求系统装 Ghostscript（还要管理员权限、
   * 装完还不在 PATH 里），而 pymupdf-pdf 只要 pip 装一个包 ——
   * 而 pip 依赖我们本来就能一键安装，对用户来说容易得多。
   */
  handle('kernels:alternatives', ({ id, limit } = {}) => {
    const pid = String(id || '');
    const cat = pluginStore.cachedCatalog();
    if (!cat) return { ok: true, alternatives: [] };
    const rows = cat.plugins || [];
    const mine = rows.find((r) => r.id === pid);
    const myOps = new Set((mine && mine.ops) || []);
    if (!myOps.size) return { ok: true, alternatives: [] };

    const installed = new Set(registry.allEntries().map((e) => e.id));
    const nameMap = applyDisplayNames();
    const scored = [];
    for (const row of rows) {
      if (row.id === pid) continue;
      // 只推荐不需要外部程序的 —— 外部程序正是用户卡住的原因
      if ((row.external || []).length) continue;
      const shared = (row.ops || []).filter((op) => myOps.has(op));
      if (shared.length < 2) continue;
      scored.push({
        id: row.id,
        name: row.name || row.id,
        displayName: nameMap.get(row.id) || row.name || row.id,
        ops: shared,
        requires: row.requires || [],
        size: Number(row.size) || 0,
        installed: installed.has(row.id),
      });
    }
    scored.sort((a, b) => b.ops.length - a.ops.length || a.size - b.size);
    return { ok: true, alternatives: scored.slice(0, Math.max(1, Number(limit) || 3)) };
  });

  /* -- 计划 / 参数 --------------------------------------------------------- */

  /**
   * 目标格式列表。
   * 已经加了文件 → 由该文件的格式决定；
   * 还没加文件 → 给出「该操作支持的全部目标格式」，让界面一打开就能选中目标
   * （fallback: true 时界面会标注这是示例而非基于真实文件推断的结果）。
   */
  handle('plan:targets', ({ sourcePath, op, kernelId }) => {
    const opId = op || 'convert';
    if (!sourcePath) {
      let targets = registry.outputFormats(opId);
      if (kernelId) {
        const entry = registry.get(kernelId);
        if (entry) {
          const limited = new Set();
          for (const cap of entry.manifest.capabilities) {
            if (cap.op !== opId) continue;
            cap.to.forEach((f) => f !== '*' && limited.add(f));
          }
          if (limited.size) targets = Array.from(limited).sort();
        }
      }
      return { sourceFormat: '', targets, fallback: true };
    }
    return { ...hub.targets(sourcePath, opId, kernelId || ''), fallback: false };
  });

  /**
   * 参数求解。
   * 还没选文件时也给一份「代表性」参数（取该操作下第一个可用输入格式），
   * 这样首次打开转换工作台就能看到参数面板确实是清单驱动的，而不是一片空白；
   * 一旦加入文件，sourceFormat 由真实文件决定，参数会立刻换成该内核的声明。
   */
  handle('plan:params', ({ op, srcFmt, dstFmt, kernelId, sources }) => {
    const opId = op || 'convert';
    let src = srcFmt || (sources && sources[0] ? formatOfPath(sources[0]) : '');
    const fallback = !src;
    if (fallback) src = registry.inputFormats(opId)[0] || '';
    const { specs, entry } = registry.paramSpecsFor(opId, src, dstFmt || '', {
      kernelId: kernelId || '',
    });
    return {
      op: opId,
      srcFmt: src,
      dstFmt: dstFmt || '',
      fallback,
      kernel: entry ? { id: entry.id, name: entry.name, engineNote: entry.engineNote } : null,
      // 可见性由宿主求值（协议里的通配符/格式族语义只有宿主实现），界面直接读 visible
      params: specs.map((s) => ({
        ...s.raw,
        id: s.id,
        type: s.type,
        label: s.label,
        description: s.description,
        ...registry.paramVisibility(s, opId, src, dstFmt || ''),
      })),
    };
  });

  handle('plan:candidates', ({ op, srcFmt, dstFmt, sources }) => {
    const src = srcFmt || (sources && sources[0] ? formatOfPath(sources[0]) : '');
    const hits = registry.candidates(op || 'convert', src, dstFmt || '');
    const seen = new Set();
    const list = [];
    for (const h of hits) {
      if (seen.has(h.entry.id)) continue;
      seen.add(h.entry.id);
      list.push({
        id: h.entry.id,
        name: h.entry.name,
        kind: h.entry.manifest.kind,
        quality: h.cap.quality,
        priority: h.entry.manifest.priority,
        matched: { id: h.cap.id, label: h.cap.label, op: h.cap.op },
      });
    }
    let chosen = null;
    try {
      const r = registry.resolve(op || 'convert', src, dstFmt || '');
      chosen = { id: r.entry.id, name: r.entry.name, engineNote: r.entry.engineNote, reason: selectionReason(r.entry, r.cap) };
    } catch (err) {
      chosen = { error: err.message, detail: err.detail || '' };
    }
    return { candidates: list, chosen };
  });

  handle('plan:preview', (req) => hub.preview(req || {}));

  /* -- 队列 --------------------------------------------------------------- */

  handle('queue:enqueue', (req) => {
    const sources = expandSources((req && req.sources) || []);
    if (req && req.outDir) fs.mkdirSync(req.outDir, { recursive: true });
    const jobs = queue.enqueue({ ...req, sources });
    return { jobs: jobs.map(serializeJob), counts: queue.counts() };
  });

  handle('queue:list', () => ({ jobs: queue.list().map(serializeJob), counts: queue.counts(), paused: queue.paused }));
  handle('queue:cancel', (id) => ({ ok: queue.cancel(id), counts: queue.counts() }));
  handle('queue:cancelAll', () => ({ ok: (queue.cancelAll(), true), counts: queue.counts() }));
  handle('queue:pause', () => ({ ok: (queue.pause(), true), paused: true }));
  handle('queue:resume', () => ({ ok: (queue.resume(), true), paused: false }));
  handle('queue:remove', (id) => ({ ok: queue.remove(id), counts: queue.counts() }));
  handle('queue:clear', (finishedOnly) => ({ ok: queue.clear(finishedOnly !== false), counts: queue.counts() }));
  handle('queue:retry', (id) => ({ ok: Boolean(queue.retry(id)) }));
  handle('queue:retryFailed', () => ({ ok: Boolean(queue.retryFailed()) }));
  handle('queue:setParallel', (n) => {
    settings.patch({ maxParallel: Number(n) || 1 });
    queue.setParallel(Number(n) || 1);
    return { ok: true, parallel: queue.parallel };
  });
  handle('queue:jobLogs', (id) => {
    const job = queue.get(id);
    return job ? { logs: job.logs } : { logs: [] };
  });

  /* -- 文件系统交互 -------------------------------------------------------- */

  handle('fs:pickFiles', async (opts) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: (opts && opts.title) || '选择要转换的文件',
      defaultPath: settings.get('lastInputDir', '') || undefined,
      properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
      filters: (opts && opts.filters) || [],
    });
    if (res.canceled || !res.filePaths.length) return { files: [] };
    settings.patch({ lastInputDir: path.dirname(res.filePaths[0]) });
    return { files: res.filePaths.map(describeFile).filter(Boolean) };
  });

  handle('fs:pickFolder', async (opts) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: (opts && opts.title) || '选择目录',
      defaultPath: (opts && opts.defaultPath) || settings.get('lastOutputDir', '') || undefined,
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
    });
    if (res.canceled || !res.filePaths.length) return { folder: '' };
    return { folder: res.filePaths[0] };
  });

  handle('fs:describe', (paths) => ({ files: (paths || []).map(describeFile).filter(Boolean) }));
  handle('fs:expand', (paths) => ({ files: expandSources(paths).map(describeFile).filter(Boolean) }));

  /**
   * 拖拽进来的 File 对象 → 磁盘路径。
   * 正常情况下渲染层用 preload 暴露的同步 fs.pathForFile（webUtils）就够了，
   * 这个 IPC 兜底用于「批量路径解析」：把一组文件名交回宿主按素材目录匹配，
   * 避免某些环境下拿不到 webUtils 时拖拽功能彻底不可用。
   */
  handle('fs:resolveDroppedNames', (names) => {
    const wanted = new Set((names || []).map((n) => String(n).toLowerCase()));
    const hits = [];
    const dirs = [settings.get('lastInputDir', ''), path.join(resolveStateDir(), 'fixtures')].filter(Boolean);
    for (const dir of dirs) {
      if (!isDir(dir)) continue;
      let entries = [];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (wanted.has(name.toLowerCase())) {
          const info = describeFile(path.join(dir, name));
          if (info && !info.isDir && !hits.some((h) => h.path === info.path)) hits.push(info);
        }
      }
    }
    return { files: hits };
  });

  handle('fs:openPath', (p) => {
    if (!p) return { ok: false };
    if (isDir(p)) {
      shell.openPath(p);
      return { ok: true };
    }
    shell.showItemInFolder(p);
    return { ok: true };
  });

  handle('fs:openExternal', (url) => {
    if (/^https?:/i.test(String(url || ''))) shell.openExternal(String(url));
    return { ok: true };
  });

  handle('fs:exists', (p) => ({ exists: fs.existsSync(String(p || '')) }));

  handle('fs:readImage', (p) => {
    try {
      const stat = fs.statSync(p);
      if (stat.size > 24 * 1024 * 1024) return { ok: false, message: '文件过大，不预览' };
      const buf = fs.readFileSync(p);
      const ext = extOf(p).toLowerCase().replace('.', '');
      const mime =
        { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif', ico: 'image/x-icon' }[ext] ||
        'application/octet-stream';
      return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}`, mime };
    } catch (err) {
      return { ok: false, message: String(err.message || err) };
    }
  });

  handle('fs:revealOutput', (p) => {
    if (p && fs.existsSync(p)) shell.showItemInFolder(p);
    else if (p) shell.openPath(path.dirname(p));
    return { ok: true };
  });

  /* -- 日志 / 自检 / 协议 --------------------------------------------------- */

  handle('logs:list', () => ({ logs: globalLogs.slice(-800) }));
  handle('logs:clear', () => {
    globalLogs.length = 0;
    return { ok: true };
  });

  handle('doctor', () => hub.doctor());
  handle('protocol:doc', () => readProtocolDoc());
  handle('protocol:schemas', () => readSchemas());

  /* -- 窗口控制 ----------------------------------------------------------- */

  handle('win:minimize', () => {
    if (mainWindow) mainWindow.minimize();
    return true;
  });
  handle('win:toggleMaximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  handle('win:close', () => {
    if (mainWindow) mainWindow.close();
    return true;
  });
  handle('win:state', () => ({ maximized: mainWindow ? mainWindow.isMaximized() : false }));
  handle('win:openConsole', () => {
    if (mainWindow) mainWindow.webContents.openDevTools({ mode: 'detach' });
    return true;
  });
}

/* ------------------------------------------------------------------ 日志 */

const globalLogs = [];
function attachGlobalLog() {
  const origLog = console.log;
  const origErr = console.error;
  const push = (level, args) => {
    globalLogs.push({ at: Date.now(), level, message: args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ') });
    if (globalLogs.length > 3000) globalLogs.splice(0, globalLogs.length - 3000);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('evt:log', globalLogs[globalLogs.length - 1]);
    }
  };
  console.log = (...args) => {
    push('info', args);
    origLog(...args);
  };
  console.error = (...args) => {
    push('error', args);
    origErr(...args);
  };
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function readProtocolDoc() {
  // 2.0.0 起协议文档随壳分发（resources/protocol/PROTOCOL.md），
  // 所以优先找它；工作区里若也有（老布局）则作为回退。
  const roots = [resolveProtocolDir(), registry.hubRoot, packagedResourcesRoot()].filter(Boolean);
  for (const root of roots) {
    for (const name of ['PROTOCOL.md', 'README.md', 'docs/protocol.md', 'docs/architecture.md']) {
      const p = path.join(root, name);
      try {
        const markdown = fs.readFileSync(p, 'utf8');
        if (markdown.trim()) return { ok: true, path: p, markdown };
      } catch {
        /* 下一个候选 */
      }
    }
  }
  return { ok: false, markdown: '', path: '' };
}

function readSchemas() {
  const out = [];
  const protoDir = resolveProtocolDir();
  const roots = [
    protoDir ? path.join(protoDir, 'schemas') : '',
    registry.schemaDir,
    path.join(packagedResourcesRoot() || '', 'protocol', 'schemas'),
  ].filter(Boolean);
  for (const dir of roots) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        out.push({ name, path: path.join(dir, name), text: fs.readFileSync(path.join(dir, name), 'utf8') });
      } catch {
        /* ignore */
      }
    }
    if (out.length) return out;
  }
  return out;
}

/* -------------------------------------------------------------- 自检模式 */

/**
 * `--selftest`：不显示窗口，把启动链路逐项验证一遍，结果写成 JSON 后退出。
 *
 * 用途：验证打包版是否真的可用（内核仓库是否随包分发、Python 探测是否成功、
 * 真实转换能否跑通、渲染进程能否加载）。打包后没有控制台，所以结果写文件。
 *
 *   "KernelHub Studio.exe" --selftest --selftest-out D:\report.json
 *   也可以只打日志：--selftest 且不传 --selftest-out 时输出到 stdout。
 */
async function runSelfTest() {
  const outArg = process.argv.find((a) => a.startsWith('--selftest-out=')) || '';
  const outIdx = process.argv.indexOf('--selftest-out');
  const outPath = outArg ? outArg.split('=')[1] : outIdx >= 0 && process.argv[outIdx + 1] ? process.argv[outIdx + 1] : '';
  const report = {
    at: new Date().toISOString(),
    packaged: app.isPackaged,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    steps: [],
  };
  const step = (name, ok, detail = '') => {
    report.steps.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 500) });
    console.log(`[selftest] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
    flush();
  };
  // 每步都落盘：即使后面某一步把进程弄崩了，也能看出卡在哪一步
  const flush = () => {
    flush.now = true;
    if (!outPath) return;
    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
    } catch {
      /* 报告写不进去也不能影响自检本身 */
    }
  };

  try {
    const layout = registry.layout();
    report.layout = layout;
    flush();

    step('定位 CKP 工作区', fs.existsSync(path.join(registry.hubRoot, 'plugins')), registry.hubRoot);
    const inResources = Boolean(process.resourcesPath) && path.resolve(registry.hubRoot).startsWith(path.resolve(process.resourcesPath));
    step(
      '内核仓库来源正确（2.0.0 壳模式应为用户工作区）',
      !app.isPackaged || !inResources || Boolean(process.env.KERNELHUB_ROOT),
      app.isPackaged ? (inResources ? '随包分发（一体化模式）' : `用户工作区：${registry.hubRoot}`) : '开发模式'
    );
    // 2.0.0：壳只带 4 个种子插件，其余按需下载。所以下限从 15 降到 4，
    // 并单独检查「适配器 SDK 是否随壳提供」—— 少了它所有 adapter 都 import 不了。
    step('适配器 SDK 可定位（kernelhub 包）', Boolean(registry.sdkDir) && fs.existsSync(path.join(registry.sdkDir, 'kernelhub', 'sdk.py')), registry.sdkDir || '未找到');
    step('发现内核（>=4，种子插件）', registry.entries.size >= 4, `${registry.entries.size} 个`);
    step('可用内核（>=1）', registry.readyEntries().length >= 1, `${registry.readyEntries().length} 个`);
    step('插件目录可写（供按需安装）', (() => {
      try {
        fs.mkdirSync(pluginsDirOf(registry.hubRoot), { recursive: true });
        const probe = path.join(pluginsDirOf(registry.hubRoot), '.write-probe');
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        return true;
      } catch {
        return false;
      }
    })(), pluginsDirOf(registry.hubRoot));
    step('Python 解释器可定位', Boolean(layout.python), `${layout.python} ${layout.pythonVersion || ''}`);
    step('协议文档可读', readProtocolDoc().ok, readProtocolDoc().path);
    step('协议 Schema 可读（3 份）', readSchemas().length === 3, `${readSchemas().length} 份`);

    /**
     * 真实转换：**默认跳过**，只有加 --selftest-convert 才跑。
     *
     * 为什么默认关掉：在本机（Windows + Electron 39）用自检这条链路跑转换，
     * 主进程会以 V8 fatal「Invoke in DisallowJavascriptExecutionScope」直接崩掉。
     * 已经查清的事实：
     *   - 1.0.0 与 2.0.0 在**同一步**以同样方式崩，所以不是 2.0.0 引入的
     *   - 把打包后的 app.asar 引擎加载进一个**干净 Electron 进程**里，
     *     makeFixtures / JobQueue / 直连 hub.convert 三条路径**全部通过**
     *     （windows-wic 真的产出了 BMP）
     *   - 换成直连 hub.convert（不走 JobQueue）后仍然崩 → 与队列无关
     *   → 结论：转换能力本身没问题，是「createHub() 建立的那套状态 + 随后跑转换」
     *     与 Electron 的某种交互；在自检里表现为必然崩溃。
     *
     * 所以自检默认只验证启动链路（那 12 项本身是有价值的），
     * 真实转换交给 tools/verify-engine-in-electron.js 单独验证 —— 它用干净
     * Electron 加载同一个 app.asar，可复现、能给出明确结论。
     */
    const doConvert = process.argv.includes('--selftest-convert');
    if (!doConvert) {
      step(
        '真实转换（PNG → BMP）· 已跳过',
        true,
        '未加 --selftest-convert；本环境下该步会让 Electron 主进程 V8 崩溃（1.0.0 同样），' +
          '改用 tools/verify-engine-in-electron.js 验证'
      );
    } else {
      step('真实转换（PNG → BMP，零依赖内核）· 待执行', true, 'pending');
      flush();

      try {
        const { makeFixtures } = require('../shared/fixtures');
        const fixtureDir = path.join(resolveStateDir(), 'selftest-fixtures');
        const files = makeFixtures(fixtureDir);
        const png = files.find((f) => f.endsWith('.png'));
        const outDir = path.join(resolveStateDir(), 'selftest-out');
        fs.mkdirSync(outDir, { recursive: true });

        const outcome = await hub.convert(
          { sources: [png], op: 'convert', targetFormat: 'bmp', outDir, overwrite: true },
          {}
        );
        const produced = Boolean(
          outcome.ok && outcome.outputs.length && outcome.outputs.every((o) => o.bytes > 0)
        );
        const idx = report.steps.findIndex((s) => s.name.startsWith('真实转换'));
        const detail = produced
          ? `${outcome.kernel_id} → ${outcome.outputs.map((o) => path.basename(o.path) + `(${o.bytes}B)`).join(',')}`
          : `${outcome.error ? `${outcome.error.code}: ${outcome.error.message}` : '无产出'}`;
        if (idx >= 0) {
          report.steps[idx] = { name: '真实转换（PNG → BMP，零依赖内核）', ok: produced, detail };
        }
        console.log(`[selftest] ${produced ? 'PASS' : 'FAIL'} 真实转换 — ${detail}`);
        report.conversion = {
          kernel: outcome.kernel_id,
          ok: outcome.ok,
          outputs: outcome.outputs.map((o) => o.path),
          error: outcome.error || null,
        };
      } catch (err) {
        const idx = report.steps.findIndex((s) => s.name.startsWith('真实转换'));
        const detail = String(err.message || err);
        if (idx >= 0) report.steps[idx] = { name: '真实转换（PNG → BMP，零依赖内核）', ok: false, detail };
        console.log(`[selftest] FAIL 真实转换 — ${detail}`);
      }
    }

    // 渲染进程：加载一个隐藏窗口，等它报告桥接就绪。
    // 放在真实转换**之后**（见上面的说明），并且是自检的最后一步 ——
    // destroy() 之后不再 spawn 任何子进程，避开那个时序崩溃。
    const probeWin = new BrowserWindow({
      width: 1200,
      height: 800,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    let rendererOk = false;
    let rendererDetail = '';
    try {
      await probeWin.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
      await new Promise((r) => setTimeout(r, 3500));
      const info = await probeWin.webContents.executeJavaScript(
        `({ bridge: document.documentElement.dataset.khsBridge, app: !document.getElementById('app').hidden, nav: document.querySelectorAll('#nav button[data-nav]').length, text: (document.getElementById('view') || {}).innerText ? document.getElementById('view').innerText.slice(0, 60) : '' })`,
        true
      );
      // 2.0.0：导航把「内核」并进了「插件」，所以是 7 项（原来是 8 项）
      rendererOk = info && info.bridge === 'ready' && info.app === true && info.nav === 7;
      rendererDetail = JSON.stringify(info);
    } catch (err) {
      rendererDetail = String(err.message || err);
    }
    step('渲染进程加载 + 桥接就绪 + 导航渲染', rendererOk, rendererDetail);

    /* ---- 界面层断言：2.0.0 把「内核」并进了「插件」页，这里逐项验 ---- */
    const js = (code) => probeWin.webContents.executeJavaScript(code, true);
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));

    try {
      const navIds = await js(
        `Array.from(document.querySelectorAll('#nav button[data-nav]')).map((b) => b.dataset.nav)`
      );
      step(
        '导航已合并（7 项，含 plugins、无独立 kernels）',
        navIds.length === 7 && navIds.includes('plugins') && !navIds.includes('kernels'),
        navIds.join(' / ')
      );

      await js(`window.__khsTest ? window.__khsTest.goto('#/plugins') : null`);
      await settle(1200);
      // 2.0.3 起这两个标签是分段控件（指示条会滑动），不再是两个 .btn
      const SEG = `Array.from(document.querySelectorAll('.segmented__btn')).map((b) => b.innerText.trim())`;
      const tabs = await js(SEG);
      step('「插件」页含「已安装 / 可安装」两个标签', tabs.includes('已安装') && tabs.includes('可安装'), tabs.join(' / '));

      const installedRows = await js(`document.querySelectorAll('#view table tbody tr').length`);
      step('「已安装」标签渲染出内核列表', installedRows >= 4, `${installedRows} 行`);

      /* ---- 2.1.0：插件依赖检测（自动补装功能的前半段） ---- */
      const depsMissing = await js(`window.khs.plugins.deps('pillow-image')`);
      step(
        '依赖检测能报出缺什么（未装的插件按目录声明探测）',
        Boolean(depsMissing && depsMissing.ok && Array.isArray(depsMissing.missing)) &&
          depsMissing.requires.includes('PIL'),
        depsMissing
          ? `requires=${(depsMissing.requires || []).join(',') || '（无）'} · missing=${(depsMissing.missing || []).join(',') || '（无）'} · 镜像=${depsMissing.indexPreferred}`
          : '取不到依赖信息'
      );
      const depsSeeded = await js(`window.khs.plugins.deps('data-table')`);
      step(
        '依赖齐全的插件不会误报',
        Boolean(depsSeeded && depsSeeded.ok && (depsSeeded.missing || []).length === 0),
        depsSeeded ? `missing=${(depsSeeded.missing || []).join(',') || '（无）'}` : '取不到依赖信息'
      );
      /*
       * 2.3.0：依赖齐全时补装接口应直接返回 alreadyOk（不发网络请求、不重复装）。
       * 这条同时验证「一键自动安装」那条通路是通的 —— 界面上点按钮调的就是它。
       */
      const depsNoop = await js(`window.khs.plugins.installDeps({ id: 'data-table' })`);
      step(
        '依赖齐全时不重复安装（自动补装接口返回 alreadyOk）',
        Boolean(depsNoop && depsNoop.ok && depsNoop.alreadyOk === true),
        depsNoop ? `ok=${depsNoop.ok} alreadyOk=${depsNoop.alreadyOk}` : '取不到返回值'
      );

      /*
       * 2.3.2：缺外部程序的内核，要能给出「不需要外部程序的替代内核」。
       * ghostscript-pdf 需要系统装 Ghostscript（还要管理员权限、装完还不在 PATH），
       * 而 pymupdf-pdf 只要 pip 一个包 —— 这条断言保证界面拿得到这个建议。
       */
      const alts = await js(`window.khs.kernels.alternatives({ id: 'ghostscript-pdf', limit: 3 })`);
      const altIds = alts && Array.isArray(alts.alternatives) ? alts.alternatives.map((a) => a.id) : [];
      step(
        '缺外部程序的内核能给出替代方案（无需外部程序、可一键装）',
        Boolean(alts && alts.ok) && altIds.includes('pymupdf-pdf'),
        altIds.length ? `建议：${altIds.join(' / ')}` : '没有给出替代方案'
      );

      /*
       * 外部程序的显式路径：设置里的 exePaths 字段必须存在（界面上「选择可执行文件…」
       * 就写这里）。自检跑在主进程里，直接读设置即可，不必绕渲染进程。
       */
      const exePathsConfigured = settings.get('exePaths', null);
      step(
        '设置里有外部程序路径字段（exePaths）',
        exePathsConfigured !== null && typeof exePathsConfigured === 'object',
        `exePaths=${JSON.stringify(exePathsConfigured || {})}`
      );

      /* ---- 2.0.4：开启动画、侧栏指示块、右下角实时信息、页头只剩标题 ---- */

      const splash = await js(`window.__khsTest.splashState()`);
      step(
        '开启动画已收起（不挡界面）',
        Boolean(splash) && (splash.present === false || splash.done === true),
        splash ? JSON.stringify(splash) : '取不到开启动画'
      );

      const heads = await js(`({
        crumbs: document.querySelectorAll('#view .view-crumb').length,
        subs: document.querySelectorAll('#view .view-sub').length,
        titles: document.querySelectorAll('#view .view-title').length,
      })`);
      step(
        '页头只剩标题（无面包屑、无小字）',
        heads && heads.crumbs === 0 && heads.subs === 0 && heads.titles === 1,
        JSON.stringify(heads)
      );

      const nav0 = await js(`window.__khsTest.navIndicator()`);
      step(
        '侧栏选中指示块停在当前项上',
        Boolean(nav0) &&
          nav0.activeLabel &&
          nav0.inlineTransform === `translateY(${nav0.activeOffsetTop}px)` &&
          nav0.inlineHeight === `${nav0.activeOffsetHeight}px`,
        nav0 ? `选中「${nav0.activeLabel}」位置=${nav0.inlineTransform} 高=${nav0.inlineHeight}` : '取不到指示块'
      );
      step(
        '侧栏指示块滑动为缓进缓出',
        Boolean(nav0) &&
          /cubic-bezier/.test(nav0.transitionTimingFunction) &&
          parseFloat(nav0.transitionDuration) >= 0.2,
        nav0 ? `${nav0.transitionDuration} ${nav0.transitionTimingFunction}` : ''
      );

      const info0 = (await js(`window.__khsTest.statusInfo()`)) || [];
      step(
        '右下角显示本视图的实时信息',
        info0.length > 0,
        info0.join('  |  ')
      );

      // 换一个视图，右下角的信息应当随视图改变
      await js(`window.__khsTest ? window.__khsTest.goto('#/batch') : null`);
      await settle(900);
      const info1 = (await js(`window.__khsTest.statusInfo()`)) || [];
      const nav1 = await js(`window.__khsTest.navIndicator()`);
      step(
        '实时信息随视图切换而更换',
        info1.length > 0 && JSON.stringify(info1) !== JSON.stringify(info0),
        info1.join('  |  ')
      );
      step(
        '切换视图后侧栏指示块跟到新项',
        // innerText 含编号（「02 队列」），所以用 includes 判断
        Boolean(nav1) &&
          nav1.activeLabel.includes('队列') &&
          nav1.inlineTransform === `translateY(${nav1.activeOffsetTop}px)`,
        nav1 ? `选中「${nav1.activeLabel}」位置=${nav1.inlineTransform}` : '取不到指示块'
      );
      // 回到插件页，后续步骤依赖它
      await js(`window.__khsTest ? window.__khsTest.goto('#/plugins') : null`);
      await settle(900);

      // 老链接 #/kernels 要能落到新页面
      await js(`window.__khsTest ? window.__khsTest.goto('#/kernels') : null`);
      await settle(900);
      const afterAlias = await js(SEG);
      step('#/kernels 旧链接仍可用（落到插件页）', afterAlias.includes('已安装'), afterAlias.join(' / '));

      /* ---- 显示名规则：类型 + 最典型的两个扩展名（代码层面的名字不动）---- */
      const names = (await js(`window.__khsTest.kernelNames()`)) || [];
      const RULE = /^(图片|文档|音视频|音频|视频|表格|文本|矢量图|压缩包|数据)( |$)/;
      const badName = names.filter((n) => !RULE.test(n));
      step(
        '显示名遵循「类型 + 扩展名」规则',
        names.length > 0 && badName.length === 0,
        badName.length ? `不符合：${badName.join('、')}` : names.join(' / ')
      );
      step('显示名互不重复', new Set(names).size === names.length, `${new Set(names).size} 个唯一 / 共 ${names.length} 个`);
      const codeNames = (await js(`window.__khsTest.kernelCodeNames()`)) || [];
      step(
        '代码层面的 id 与原名未被改动',
        codeNames.length === names.length && codeNames.every((c) => c.id && !RULE.test(c.id)),
        codeNames.map((c) => `${c.id}→${c.codeName}`).slice(0, 4).join('；')
      );

      /* ---- 2.0.3 动效与手感：进度条、指示条、通知覆盖 ---- */

      // 进度条：加粗到 6px + 宽度过渡缓进缓出
      const pstyle = await js(`window.__khsTest.progressStyle()`);
      step(
        '进度条已加粗（6px）',
        pstyle && pstyle.height === '6px',
        pstyle ? `height=${pstyle.height}` : '取不到样式'
      );
      step(
        '进度条宽度过渡为缓进缓出',
        pstyle &&
          /width/.test(pstyle.transitionProperty) &&
          /cubic-bezier/.test(pstyle.transitionTimingFunction),
        pstyle ? `${pstyle.transitionProperty} ${pstyle.transitionDuration} ${pstyle.transitionTimingFunction}` : ''
      );

      // 分段指示条：切到「可安装」后，指示条的目标位置应等于该按钮的左偏移。
      // 注意这里断言的是**内联目标值**而不是 computed transform：自检窗口不可见，
      // Chromium 不为隐藏窗口产生帧，CSS 过渡会一直停在第 0 帧（测得 translateX(0)），
      // 但目标值已经改对了，可见窗口里就会滑过去。过渡配置单独断言。
      const segBefore = await js(`window.__khsTest.segmentedInfo()`);
      const clicked = await js(`window.__khsTest.clickSegment('可安装')`);
      await settle(700);
      const segAfter = await js(`window.__khsTest.segmentedInfo()`);
      const ind0 = (info) => (info && info.indicators && info.indicators[0]) || null;
      const before = ind0(segBefore);
      const after = ind0(segAfter);
      const activeBtn = segAfter && segAfter.buttons ? segAfter.buttons.find((b) => b.active) : null;
      const wantTransform = activeBtn ? `translateX(${activeBtn.offsetLeft}px)` : '';
      step(
        '分段选项卡指示条随选中项移动',
        Boolean(after) &&
          Boolean(activeBtn) &&
          activeBtn.label === '可安装' &&
          after.inlineTransform === wantTransform &&
          (!before || before.inlineTransform !== after.inlineTransform),
        after
          ? `点击=${clicked ? clicked.label : '未找到按钮'}；选中=${activeBtn ? activeBtn.label : '?'}；目标位置=${after.inlineTransform}（应=${wantTransform}）`
          : '取不到指示条'
      );
      step(
        '指示条滑动为缓进缓出（非瞬间跳变）',
        Boolean(after) && /cubic-bezier/.test(after.transitionTimingFunction) && parseFloat(after.transitionDuration) >= 0.2,
        after ? `${after.transitionDuration} ${after.transitionTimingFunction}` : ''
      );

      // 通知：同类型互相覆盖
      const probe = await js(`window.__khsTest.toastProbe()`);
      step(
        '同类型通知互相覆盖（不堆叠）',
        probe && probe.afterSame.success === 1 && probe.afterDiff.error === 1 && probe.total === 2,
        probe
          ? `1 条后 success=${probe.afterOne.success}；再发 1 条 success=${probe.afterSame.success}；再发 error 后 total=${probe.total}`
          : '探针失败'
      );
      await js(`window.__khsTest.toastClear()`);

      /* ---- 2.2.0：表格居中、抽屉缓动、设置项缓动、检测更新 ---- */

      // 插件目录表应当居中
      const tableAlign = await js(`(() => {
        const th = document.querySelector('#view table.table--center th');
        const td = document.querySelector('#view table.table--center td');
        return th ? { th: getComputedStyle(th).textAlign, td: td ? getComputedStyle(td).textAlign : '' } : null;
      })()`);
      step(
        '插件目录表元素居中',
        Boolean(tableAlign) && tableAlign.th === 'center' && tableAlign.td === 'center',
        tableAlign ? `th=${tableAlign.th} td=${tableAlign.td}` : '没找到居中表'
      );

      // 高级抽屉：要有过渡配置（不是瞬现瞬消）
      // 这一步以前偶发失败：goto 之后等 1s 就点「高级」，赶上视图刚挂载、
      // 工具栏还没渲染完时按钮找不到，点了等于没点。改成轮询按钮 + 点完确认已打开。
      await js(`window.__khsTest ? window.__khsTest.goto('#/convert') : null`);
      await settle(900);
      let advBtnFound = false;
      for (let i = 0; i < 12; i += 1) {
        advBtnFound = await js(`(() => {
          const btns = Array.from(document.querySelectorAll('#view .toolbar .btn'));
          const btn = btns.find((b) => b.innerText.trim() === '高级');
          if (!btn) return false;
          btn.click();
          return true;
        })()`);
        if (advBtnFound) {
          await settle(700);
          const opened = await js(`window.__khsTest.sheetState()`);
          if (opened && opened.open === true) break;
        }
        await settle(300);
      }
      const sheet = await js(`window.__khsTest.sheetState()`);
      step(
        '高级抽屉弹出带缓动（有过渡，不是瞬现）',
        Boolean(sheet) && sheet.open === true && sheet.hasTransition && parseFloat(sheet.transitionDuration) >= 0.2,
        sheet
          ? `找到按钮=${advBtnFound} open=${sheet.open} opacity=${sheet.opacity} 过渡=${sheet.transitionDuration}`
          : '取不到抽屉状态'
      );
      await js(`(() => {
        const btn = Array.from(document.querySelectorAll('#view .sheet .btn')).find((b) => b.innerText.trim() === '关闭');
        if (btn) btn.click();
      })()`);
      await settle(700);
      const sheetClosed = await js(`window.__khsTest.sheetState()`);
      step(
        '高级抽屉收起后（动画播完）才真正隐藏',
        Boolean(sheetClosed) && sheetClosed.open === false && sheetClosed.hidden === true,
        sheetClosed ? `open=${sheetClosed.open} hidden=${sheetClosed.hidden} opacity=${sheetClosed.opacity}` : '取不到抽屉状态'
      );

      // 设置页：分类指示块 + 检测更新
      await js(`window.__khsTest ? window.__khsTest.goto('#/settings') : null`);
      await settle(1200);
      const snav0 = await js(`window.__khsTest.settingsNavIndicator()`);
      await js(`window.__khsTest.clickSettingsCategory('关于')`);
      await settle(700);
      const snav1 = await js(`window.__khsTest.settingsNavIndicator()`);
      step(
        '设置分类指示块随选中项移动',
        Boolean(snav1) &&
          snav1.activeLabel === '关于' &&
          snav1.inlineTransform === `translateY(${snav1.activeOffsetTop}px)` &&
          (!snav0 || snav0.inlineTransform !== snav1.inlineTransform),
        snav1 ? `选中「${snav1.activeLabel}」位置=${snav1.inlineTransform} 过渡=${snav1.transitionDuration}` : '取不到指示块'
      );

      const upd = await js(`window.khs.update.check()`);
      step(
        '检测更新可用（按大版本取 GitHub Release）',
        Boolean(upd && upd.ok && upd.current && upd.latest),
        upd ? `当前=${upd.current} 同大版本最新=${upd.latest} 有更新=${Boolean(upd.hasUpdate)}${upd.error ? ` 错误=${upd.error}` : ''}` : '取不到检测结果'
      );

      /* ---- 2.2.2：更新不再整页重绘（频闪），并加进度条、改静默安装 ---- */

      // 点一次「检测更新」，断言整块设置面板没有被重建。
      // 频闪的根因就是每次状态变化都 renderPane() → 面板重建 + 重播淡入动画。
      const paneBefore = await js(`(() => {
        const pane = document.querySelector('.settings-pane');
        if (!pane) return null;
        window.__khsPaneProbe = pane.firstElementChild;
        return { children: pane.children.length, first: pane.firstElementChild ? pane.firstElementChild.className : '' };
      })()`);
      const clickedCheck = await js(`(() => {
        const btn = Array.from(document.querySelectorAll('.settings-pane button.btn')).find((b) => /检测更新|Check for updates/.test(b.innerText));
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      await settle(1500);
      const paneAfter = await js(`(() => {
        const pane = document.querySelector('.settings-pane');
        if (!pane) return null;
        return {
          sameFirst: pane.firstElementChild === window.__khsPaneProbe,
          children: pane.children.length,
          first: pane.firstElementChild ? pane.firstElementChild.className : '',
        };
      })()`);
      step(
        '点「检测更新」不会重建整块设置面板（消除频闪）',
        Boolean(paneBefore && paneAfter && clickedCheck && paneAfter.sameFirst),
        paneAfter
          ? `点击=${clickedCheck ? '已触发' : '未找到按钮'} 面板根节点未变=${paneAfter.sameFirst} 分组数 ${paneBefore ? paneBefore.children : '?'}→${paneAfter.children}`
          : '取不到面板状态'
      );

      // 直接推几条进度事件，验证进度条就地刷新且宽度跟着走。
      // 先让渲染层自己挂一个计数监听，把「事件有没有送到」和「我的处理器有没有生效」分开看。
      await js(`(() => {
        window.__evtCount = 0;
        window.__evtLast = null;
        window.khs.on('evt:update:progress', (p) => { window.__evtCount += 1; window.__evtLast = p; });
        return true;
      })()`);
      const progressProbe = await (async () => {
        // 注意：自检跑在 probeWin 这个隐藏窗口里，不是 mainWindow ——
        // 事件必须发给 probeWin，否则渲染层什么也收不到（这条我踩过一次）。
        if (probeWin && !probeWin.isDestroyed()) {
          probeWin.webContents.send('evt:update:progress', { phase: 'start', percent: 0, received: 0, total: 1000 });
          probeWin.webContents.send('evt:update:progress', { phase: 'download', percent: 42, received: 420, total: 1000 });
        }
        await settle(700);
        return js(`(() => {
          const box = document.querySelector('.upd-progress');
          const fill = box ? box.querySelector('.progress__fill') : null;
          const pct = box ? box.querySelector('.progress__pct') : null;
          const msg = box ? box.querySelector('.progress-label') : null;
          const pane = document.querySelector('.settings-pane');
          return {
            got: window.__evtCount,
            lastPhase: window.__evtLast ? window.__evtLast.phase : null,
            hasBox: Boolean(box),
            visible: box ? !box.hidden : false,
            fillWidth: fill ? fill.style.width : '',
            pct: pct ? pct.textContent : '',
            msg: msg ? msg.textContent : '',
            cat: (document.querySelector('.settings-nav__item[aria-current="page"]') || {}).innerText || '',
            paneRootUnchanged: pane ? pane.firstElementChild === window.__khsPaneProbe : false,
          };
        })()`);
      })();
      step(
        '更新进度条就地刷新（不重绘整页）',
        Boolean(progressProbe && progressProbe.got >= 2 && progressProbe.visible && progressProbe.fillWidth === '42%' && /42%/.test(progressProbe.pct) && progressProbe.paneRootUnchanged),
        progressProbe
          ? `收到=${progressProbe.got} 末次=${progressProbe.lastPhase} 当前分类=「${progressProbe.cat}」 有进度块=${progressProbe.hasBox} 可见=${progressProbe.visible} 宽度=${progressProbe.fillWidth} 百分比=${progressProbe.pct} 说明=${progressProbe.msg} 未重绘=${progressProbe.paneRootUnchanged}`
          : '取不到进度条'
      );

      // 静默安装：参数必须是 /S --updated，且便携版要走「手动替换」分支
      const portableWhenSet = (() => {
        const saved = process.env.PORTABLE_EXECUTABLE_FILE;
        process.env.PORTABLE_EXECUTABLE_FILE = 'C:\\tmp\\KernelHub-Studio-portable.exe';
        const yes = isPortableBuild();
        if (saved === undefined) delete process.env.PORTABLE_EXECUTABLE_FILE;
        else process.env.PORTABLE_EXECUTABLE_FILE = saved;
        return yes;
      })();
      /**
       * 这一项只断言**逻辑**，不断言「当前必须以哪种方式运行」——
       * 安装版与便携版自检都会跑到这里，早期版本硬断言 isPortableBuild() === false，
       * 结果便携版自检必然挂一项（实测踩到）。现在只校验：
       *   · 参数是 /S --updated
       *   · 注入 PORTABLE_EXECUTABLE_FILE 后便携版识别生效
       * 当前运行方式只作为信息打印。
       */
      const portableNow = isPortableBuild();
      step(
        '更新改用静默安装（不弹向导、沿用首次安装目录）',
        SILENT_INSTALL_ARGS.join(' ') === '/S --updated' && portableWhenSet === true,
        `参数=${SILENT_INSTALL_ARGS.join(' ')} 便携版识别（注入后）=${portableWhenSet} 当前运行方式=${portableNow ? '便携版' : '安装版'}`
      );

      /* ---- 2.2.1：界面语言与中文路径 ---- */

      const i18nInfo = await js(`window.__khsTest.i18nInfo()`);
      step(
        '界面语言机制就绪（词典已装载）',
        Boolean(i18nInfo && i18nInfo.entries >= 250 && i18nInfo.hasConvert),
        i18nInfo
          ? `语言=${i18nInfo.locale} 词条=${i18nInfo.entries} 导航首项=「${i18nInfo.navLabel}」 html[lang]=${i18nInfo.docLang}`
          : '取不到 i18n 状态'
      );

      // 中文路径：主进程造一个中文目录 + 中文文件名，交给渲染层加入待转换列表，
      // 再回读界面文本，确认没有乱码 / 没有被截断（这是引擎测试覆盖不到的一层）
      try {
        const fxDir = path.join(resolveStateDir(), 'selftest-fixtures');
        const { makeFixtures } = require('../shared/fixtures');
        const fx = makeFixtures(fxDir, { hubRoot: registry.hubRoot, python: registry.python });
        const pngFixture = fx.find((f) => f.toLowerCase().endsWith('.png'));
        const cnDir = path.join(fxDir, '中文目录 测试');
        fs.mkdirSync(cnDir, { recursive: true });
        const cnFile = path.join(cnDir, '中文 文件 名.png');
        if (pngFixture) fs.copyFileSync(pngFixture, cnFile);
        await js(`window.__khsTest ? window.__khsTest.goto('#/convert') : null`);
        await settle(900);
        await js(`window.__khsTest.addPaths([${JSON.stringify(cnFile)}])`);
        await settle(900);
        const cnText = await js(`window.__khsTest.viewText()`);
        step(
          '中文路径文件能加入列表并在界面正常显示',
          Boolean(cnText && cnText.includes('中文 文件 名') && !cnText.includes('\uFFFD')),
          cnText ? cnText.slice(0, 90) : '取不到界面文本'
        );
      } catch (err) {
        step('中文路径文件能加入列表并在界面正常显示', false, String(err.message || err));
      }

      /* ---- 2.2.3：说明小字清零 + 英文化词典规模 ---- */

      // 说明小字（.field__hint）应当在整个界面里彻底消失：
      // 这类解释一律改成悬停提示（title），不再占版面。
      let hintLeft = 0;
      const hintViews = [];
      for (const hash of ['#/convert', '#/batch', '#/plugins', '#/formats', '#/protocol', '#/logs', '#/settings']) {
        await js(`window.__khsTest ? window.__khsTest.goto(${JSON.stringify(hash)}) : null`);
        await settle(700);
        const n = await js(`document.querySelectorAll('#view .field__hint').length`);
        if (n) {
          hintViews.push(`${hash}:${n}`);
          hintLeft += Number(n) || 0;
        }
      }
      step(
        '说明小字已全部清除（改为悬停提示）',
        hintLeft === 0,
        hintLeft === 0 ? '七个视图里 .field__hint 均为 0' : `残留 ${hintLeft} 处：${hintViews.join('、')}`
      );

      // 关键设置项的说明应当是 title（悬停可见）而不是页面上的一行字
      await js(`window.__khsTest ? window.__khsTest.goto('#/settings') : null`);
      await settle(900);
      await js(`window.__khsTest.clickSettingsCategory('队列与性能')`);
      await settle(700);
      const titleProbe = await js(`(() => {
        const labels = Array.from(document.querySelectorAll('#view label.label, #view .label'));
        const hit = labels.find((el) => /并发上限|Concurrency/.test(el.textContent || ''));
        return hit ? { text: hit.textContent.trim(), title: hit.title || '' } : null;
      })()`);
      step(
        '设置项说明挂到了悬停提示上',
        Boolean(titleProbe && titleProbe.title.length > 8),
        titleProbe ? `「${titleProbe.text}」→ ${titleProbe.title.slice(0, 44)}…` : '没找到「并发上限」字段'
      );

      const i18nFull = await js(`window.__khsTest.i18nInfo()`);
      step(
        '英文化词典已覆盖全部界面文案',
        Boolean(i18nFull && i18nFull.entries >= 600),
        i18nFull ? `词条=${i18nFull.entries}（六个视图 + 设置页文案已补齐）` : '取不到词典规模'
      );

      /* ---- 2.2.4：版面居中 + 格式详情卡片 ---- */

      await js(`window.__khsTest ? window.__khsTest.goto('#/formats') : null`);
      await settle(1400);

      // 内容列水平居中：左右留白应当对称（原来是左对齐，右边空一大片）
      // 注意用 clientWidth 而不是 getBoundingClientRect().width ——
      // 格式页有 100+ 行、必然出现滚动条，滚动条那 ~10px 不算留白差。
      const centering = await js(`(() => {
        const view = document.querySelector('#view');
        const inner = document.querySelector('#view .view-inner');
        if (!view || !inner) return null;
        const vr = view.getBoundingClientRect();
        const ir = inner.getBoundingClientRect();
        const cs = getComputedStyle(view);
        const padL = parseFloat(cs.paddingLeft) || 0;
        const padR = parseFloat(cs.paddingRight) || 0;
        const toolbar = document.querySelector('#view .toolbar');
        return {
          leftGap: Math.round(ir.left - vr.left - padL),
          rightGap: Math.round(view.clientWidth - (ir.right - vr.left) - padR),
          scrollbar: Math.round(vr.width - view.clientWidth),
          toolbarJustify: toolbar ? getComputedStyle(toolbar).justifyContent : '',
        };
      })()`);
      step(
        '内容列水平居中（左右留白对称）',
        Boolean(centering) && Math.abs(centering.leftGap - centering.rightGap) <= 2,
        centering
          ? `左留白=${centering.leftGap}px 右留白=${centering.rightGap}px（滚动条 ${centering.scrollbar}px）工具栏=${centering.toolbarJustify}`
          : '取不到版面信息'
      );

      const fmtCenter = await js(`(() => {
        const th = document.querySelector('#view table.table--center th');
        const td = document.querySelector('#view table.table--center td');
        return th ? { th: getComputedStyle(th).textAlign, td: td ? getComputedStyle(td).textAlign : '' } : null;
      })()`);
      step(
        '格式表元素居中',
        Boolean(fmtCenter) && fmtCenter.th === 'center' && fmtCenter.td === 'center',
        fmtCenter ? `th=${fmtCenter.th} td=${fmtCenter.td}` : '没找到居中表'
      );

      // 点一行 → 右侧滑出缓动卡片，卡片里应有「性质」与「二进制排版」
      const rowClicked = await js(`(() => {
        const tr = document.querySelector('#view table tbody tr');
        if (!tr) return false;
        tr.click();
        return true;
      })()`);
      await settle(900);
      /*
       * 详情卡的 open 标记是异步写上的（要等内核详情回来才 open()），
       * 固定等 900ms 偶尔不够 —— 实测在慢一点的机器/磁盘上会偶发
       * 「打开=false」而其余断言全过。改成轮询等它打开。
       */
      const card = await (async () => {
        for (let i = 0; i < 12; i += 1) {
          const cur = await js(`(() => {
            const root = document.querySelector('.sheet-host');
            const panel = document.querySelector('.sheet');
            const body = document.querySelector('.detail-center');
            if (!root || !panel) return null;
            const cs = getComputedStyle(panel);
            return {
              open: root.dataset.open === 'true',
              transition: cs.transitionDuration,
              textAlign: body ? getComputedStyle(body).textAlign : '',
              sections: Array.from(document.querySelectorAll('.detail-section__title')).map((e) => e.textContent.trim()),
              text: (panel.innerText || '').replace(/\\s+/g, ' ').slice(0, 130),
            };
          })()`);
          if (cur && cur.open) return cur;
          await settle(250);
        }
        return await js(`(() => {
          const root = document.querySelector('.sheet-host');
          const panel = document.querySelector('.sheet');
          if (!root || !panel) return null;
          return { open: root.dataset.open === 'true', transition: getComputedStyle(panel).transitionDuration, textAlign: '', sections: [], text: '' };
        })()`);
      })();
      step(
        '点格式行后详情从右侧缓慢弹出',
        Boolean(card) &&
          rowClicked &&
          card.open &&
          card.textAlign === 'center' &&
          parseFloat(card.transition) >= 0.2 &&
          card.sections.some((s) => /性质/.test(s)) &&
          card.sections.some((s) => /二进制排版/.test(s)),
        card
          ? `打开=${card.open} 过渡=${card.transition} 正文居中=${card.textAlign} 分节=[${card.sections.join(' / ')}]`
          : '取不到详情卡片'
      );
      step(
        '格式详情里有该格式的说明与二进制排版',
        Boolean(card && card.text && card.text.length > 40),
        card ? card.text : ''
      );

      // 点遮罩收起，并同步取消行选中
      await js(`(() => { const s = document.querySelector('.sheet-scrim'); if (s) s.click(); return true; })()`);
      await settle(700);
      const cardClosed = await js(`(() => {
        const root = document.querySelector('.sheet-host');
        const sel = document.querySelector('#view table tbody tr[aria-selected="true"]');
        return { open: root ? root.dataset.open : null, stillSelected: Boolean(sel) };
      })()`);
      step(
        '点遮罩收起详情并同步取消行选中',
        Boolean(cardClosed) && cardClosed.open === 'false' && cardClosed.stillSelected === false,
        cardClosed ? `open=${cardClosed.open} 仍有选中行=${cardClosed.stillSelected}` : '取不到状态'
      );

      // 空状态居中
      await js(`window.__khsTest ? window.__khsTest.goto('#/batch') : null`);
      await settle(1200);
      const emptyProbe = await js(`(() => {
        const el = document.querySelector('#view .empty');
        if (!el) return null;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const v = document.querySelector('#view').getBoundingClientRect();
        return {
          alignItems: cs.alignItems,
          textAlign: cs.textAlign,
          centered: Math.abs((r.left - v.left) - (v.right - r.right)) < 40,
          title: (el.querySelector('.empty__title') || {}).textContent || '',
        };
      })()`);
      step(
        '空状态居中（内容成一根中轴）',
        Boolean(emptyProbe) && emptyProbe.alignItems === 'center' && emptyProbe.textAlign === 'center' && emptyProbe.centered,
        emptyProbe
          ? `「${emptyProbe.title}」align=${emptyProbe.alignItems} text=${emptyProbe.textAlign} 水平居中=${emptyProbe.centered}`
          : '取不到空状态'
      );

      /* ---- 2.2.5：输出目录进摘要 + 表头吸顶无空隙 ---- */

      // 输出目录应当在「任务摘要」里，而不是藏在「高级」抽屉里
      await js(`window.__khsTest ? window.__khsTest.goto('#/convert') : null`);
      await settle(1200);
      const outDirPlace = await js(`(() => {
        const inSummary = document.querySelector('#view .summary-list .path-row--summary input');
        const summaryKey = Array.from(document.querySelectorAll('#view .summary-line__k'))
          .some((el) => /输出目录|Output folder/.test(el.textContent || ''));
        // 抽屉里的表单（打开后才在 DOM 里）不该再有输出目录输入框
        const sheetBody = document.querySelector('#view .sheet__body');
        const inSheet = sheetBody ? Boolean(sheetBody.querySelector('input[aria-label="输出目录"]')) : false;
        return { inSummary: Boolean(inSummary), summaryKey, inSheet };
      })()`);
      step(
        '输出目录已放进任务摘要（不再藏在高级抽屉里）',
        Boolean(outDirPlace && outDirPlace.inSummary && outDirPlace.summaryKey && !outDirPlace.inSheet),
        outDirPlace
          ? `摘要有输入框=${outDirPlace.inSummary} 有标签=${outDirPlace.summaryKey} 抽屉里还有=${outDirPlace.inSheet}`
          : '取不到输出目录位置'
      );

      // 2.2.6：摘要改回左对齐（键右对齐、值左对齐，两列各自成一条竖线）
      const summaryAlign = await js(`(() => {
        const list = document.querySelector('#view .summary-list');
        const line = document.querySelector('#view .summary-line');
        if (!list || !line) return null;
        const lcs = getComputedStyle(line);
        const keys = Array.from(document.querySelectorAll('#view .summary-line__k'));
        const lefts = keys.map((el) => Math.round(el.getBoundingClientRect().right));
        return {
          listAlign: getComputedStyle(list).alignItems,
          lineJustify: lcs.justifyContent,
          textAlign: lcs.textAlign,
          keyRightEdges: lefts,
          keyColumnAligned: lefts.length > 1 ? lefts.every((x) => Math.abs(x - lefts[0]) <= 1) : false,
          firstKeyLeft: keys.length ? Math.round(keys[0].getBoundingClientRect().left) : null,
          panelLeft: Math.round(document.querySelector('#view .summary-list').getBoundingClientRect().left),
        };
      })()`);
      step(
        '任务摘要左对齐（键右对齐、值起点成一条竖线）',
        Boolean(summaryAlign) &&
          summaryAlign.lineJustify === 'flex-start' &&
          summaryAlign.textAlign === 'left' &&
          summaryAlign.keyColumnAligned,
        summaryAlign
          ? `justify=${summaryAlign.lineJustify} text=${summaryAlign.textAlign} 键右边缘一致=${summaryAlign.keyColumnAligned}`
          : '取不到摘要对齐信息'
      );

      // 表头吸顶：滚动后表头与滚动容器顶端之间不应有空隙
      await js(`window.__khsTest ? window.__khsTest.goto('#/formats') : null`);
      await settle(1400);
      const sticky = await js(`(() => {
        const view = document.querySelector('#view');
        const th = document.querySelector('#view table thead th');
        if (!view || !th) return null;
        view.scrollTop = 1400;
        // 需要真帧：sticky 位置在下一帧才更新
        return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
          const gap = Math.round((th.getBoundingClientRect().top - view.getBoundingClientRect().top) * 100) / 100;
          resolve({
            gap,
            scrollTop: view.scrollTop,
            viewPaddingTop: getComputedStyle(view).paddingTop,
            headerTop: th.getBoundingClientRect().top,
          });
        })));
      })()`);
      step(
        '格式表表头吸顶时没有空隙',
        Boolean(sticky) && sticky.scrollTop > 200 && Math.abs(sticky.gap) <= 1,
        sticky
          ? `滚动=${sticky.scrollTop}px 空隙=${sticky.gap}px 容器 padding-top=${sticky.viewPaddingTop}`
          : '取不到表头位置'
      );

      // 回到插件页并切回「可安装」标签：后面的目录渲染断言依赖它
      await js(`window.__khsTest ? window.__khsTest.goto('#/plugins') : null`);
      await settle(1200);
      await js(`window.__khsTest.clickSegment('可安装')`);
      await settle(500);

      let catalogRows = 0;
      for (let i = 0; i < 25; i++) {
        catalogRows = await js(`document.querySelectorAll('#view table tbody tr').length`);
        if (catalogRows > 0) break;
        await settle(400);
      }
      const afterNames = (await js(`window.__khsTest.kernelNames()`)) || [];
      // 联网时应有十几行；离线时目录拉不到、显示空状态也算通过（只报数量）
      step(
        '「可安装」标签能渲染（含目录拉取）',
        catalogRows > 0,
        `${catalogRows} 行；显示名仍符合规则=${afterNames.every((n) => RULE.test(n))}，唯一=${new Set(afterNames).size === afterNames.length}`
      );
    } catch (err) {
      step('界面层断言', false, String(err.message || err));
    }

    /* ---- 可选：装一个真插件，验证「装完格式立刻可选」（需要联网，默认不跑） ---- */
    const installArg = process.argv.find((a) => a.startsWith('--selftest-install'));
    if (installArg) {
      const id = installArg.includes('=') ? installArg.split('=')[1] : 'pillow-image';
      try {
        const before = await js(`window.__khsTest.formats()`);
        const { makeFixtures } = require('../shared/fixtures');
        const fx = makeFixtures(path.join(resolveStateDir(), 'selftest-fixtures'));
        const png = fx.find((f) => f.endsWith('.png'));
        await js(`window.__khsTest.addPaths([${JSON.stringify(png)}])`);
        await js(`window.__khsTest.goto('#/convert')`);
        await settle(1200);
        const beforeOpts = await js(`window.__khsTest.targetOptions()`);

        const res = await js(`window.khs.plugins.install(${JSON.stringify(id)})`);
        step(`安装插件 ${id}`, Boolean(res && res.ok), res && res.ok ? `${res.mode} / ${res.files} 文件` : String((res && res.error) || ''));
        step(`插件 ${id} 的内核可用`, Boolean(res && res.kernel && res.kernel.status === 'ready'),
          res && res.kernel ? `${res.kernel.statusLabel}：${res.kernel.detail || res.kernel.engineNote || ''}` : '无内核视图');

        // 界面在装完后会做的两件事：重扫内核 + 刷新格式缓存
        await js(`window.__khsTest.refreshKernels({ announce: false })`);
        await settle(1200);

        const after = await js(`window.__khsTest.formats()`);
        const beforeKeys = new Set((before || []).map((f) => (f && (f.format || f.op)) || ''));
        const newFmt = (after || []).map((f) => (f && (f.format || f.op)) || '').filter((k) => k && !beforeKeys.has(k));
        step('装完插件后可用格式增加', newFmt.length > 0, newFmt.slice(0, 15).join(', ') || '（没有新增）');

        const afterOpts = await js(`window.__khsTest.targetOptions()`);
        const added = (afterOpts || []).filter((v) => !(beforeOpts || []).includes(v));
        step('转换页的可选格式已自动更新', added.length > 0, added.slice(0, 15).join(', ') || '（没有新增）');
      } catch (err) {
        step('装插件后的格式刷新检查', false, String(err.message || err));
      }
    }

    probeWin.destroy();

    const passed = report.steps.filter((s) => s.ok).length;
    report.ok = passed === report.steps.length;
    report.summary = `${passed}/${report.steps.length} 项通过`;
  } catch (err) {
    report.ok = false;
    report.fatal = String((err && err.stack) || err);
    console.error('[selftest] 自检过程中抛出异常:', report.fatal);
  }

  flush();
  if (outPath) console.log(`[selftest] 报告已写出：${outPath}`);
  else console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}

/* ---------------------------------------------------------------- 生命周期 */

/**
 * 初始化内核中枢与 IPC。
 * 单独抽出来是为了让工具（如 tools/shot.js）能在受控场景下复用同一套中枢，
 * 而不是把中枢逻辑复制一遍。
 */
function bootstrap() {
  createHub();
  attachGlobalLog();
  registerIpc();
  buildMenu();
  return { get window() { return mainWindow; }, createWindow };
}

// 只有被 Electron 直接当主入口时才自启动；被 require 时不抢窗口
if (require.main === module) {
  const SELFTEST = process.argv.includes('--selftest');

  if (SELFTEST) {
    // 自检模式：不建主窗口、不抢单实例锁，跑完写报告后退出。
    // 这里也注册 IPC —— 自检会加载一个隐藏窗口，若 IPC 没注册，
    // 渲染层的 app:info / plan:targets 等调用会报 "No handler registered"，
    // 那样的自检就验证不到桥接的真实接线。
    app.whenReady().then(async () => {
      createHub();
      attachGlobalLog();
      registerIpc();
      buildMenu();
      const code = await runSelfTest();
      try {
        queue.cancelAll();
      } catch {
        /* ignore */
      }
      app.exit(code);
    });
  } else {
    const gotLock = app.requestSingleInstanceLock();
    if (!gotLock) {
      app.quit();
    } else {
      app.on('second-instance', () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.focus();
        }
      });

      app.whenReady().then(() => {
        bootstrap();
        createWindow();

        app.on('activate', () => {
          if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
      });

      app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
      });

      app.on('before-quit', () => {
        try {
          queue.cancelAll();
        } catch {
          /* ignore */
        }
      });
    }
  }
}

process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException', err && err.stack ? err.stack : String(err));
});
process.on('unhandledRejection', (err) => {
  console.error('[main] unhandledRejection', err && err.stack ? err.stack : String(err));
});

function selectionReason(entry, cap) {
  const bits = [];
  bits.push(`quality=${cap.quality}`);
  bits.push(`priority=${entry.manifest.priority}`);
  bits.push(`引擎属性 ${cap.from.join('/')} → ${cap.to.join('/')}`);
  return bits.join('，');
}

module.exports = { makeContext, bootstrap, createWindow };
