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
} = require('../engine/paths');
const { Registry } = require('../engine/registry');
const { Hub } = require('../engine/hub');
const { PluginStore } = require('../engine/pluginStore');
const { JobQueue, STATE } = require('../engine/queue');
const catalog = require('../engine/catalog');
const { clearProbeCache } = require('../engine/python');
const { formatOfPath, basenameOf, extOf, CKP_VERSION } = require('../shared/protocol');
const { humanSize } = catalog;

const isDev = process.argv.includes('--dev') || !app.isPackaged;

let mainWindow = null;
let settings = null;
let registry = null;
let hub = null;
let queue = null;
let pluginStore = null;

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
  };
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

  handle('plugins:list', (opts) => pluginStore.list({ refresh: Boolean(opts && opts.refresh) }));

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

  handle('plugins:openDir', () => {
    const dir = pluginStore.pluginsDir;
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
  }));

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
      const tabs = await js(
        `Array.from(document.querySelectorAll('#view .toolbar .btn')).map((b) => b.innerText.trim())`
      );
      step('「插件」页含「已安装 / 可安装」两个标签', tabs.includes('已安装') && tabs.includes('可安装'), tabs.join(' / '));

      const installedRows = await js(`document.querySelectorAll('#view table tbody tr').length`);
      step('「已安装」标签渲染出内核列表', installedRows >= 4, `${installedRows} 行`);

      // 老链接 #/kernels 要能落到新页面
      await js(`window.__khsTest ? window.__khsTest.goto('#/kernels') : null`);
      await settle(900);
      const afterAlias = await js(`Array.from(document.querySelectorAll('#view .toolbar .btn')).map((b) => b.innerText.trim())`);
      step('#/kernels 旧链接仍可用（落到插件页）', afterAlias.includes('已安装'), afterAlias.join(' / '));
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
