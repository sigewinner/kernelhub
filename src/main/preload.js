'use strict';
/**
 * 预加载桥：把主进程的中枢能力收敛成一份显式、可审计的 API 契约。
 *
 * 渲染进程的全局对象：window.khs
 *   window.khs.app / layout / settings / kernels / plan / queue / fs / logs / doctor / protocol / win / events
 *
 * 事件（主进程 → 渲染进程，经 evt:* 通道）：
 *   evt:job:log      { jobId, at, level, message }
 *   evt:job:update    Job
 *   evt:job:finish   { job, outcome }
 *   evt:queue        Job[]
 *   evt:queue:enqueue Job[]
 *   evt:queue:idle   { queued, running, done, failed, cancelled, total }
 *   evt:log          { at, level, message }
 *   evt:window       { maximized }
 *   cmd              'pick-files' | 'pick-folder' | 'refresh' | 'protocol'
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

/**
 * 取拖拽进来的 File 对象对应的磁盘路径。
 *
 * Electron 32 起 File.path 被移除，官方替代品是 webUtils.getPathForFile；
 * 这里两者都试，保证拖拽投放功能在新旧 Electron 上都能拿到真实路径。
 * 返回空字符串表示拿不到（调用方应提示用户改用「选择文件」按钮）。
 */
function pathForFile(file) {
  if (!file) return '';
  try {
    if (webUtils && typeof webUtils.getPathForFile === 'function') {
      const p = webUtils.getPathForFile(file);
      if (p) return String(p);
    }
  } catch {
    /* 落到旧字段 */
  }
  if (typeof file.path === 'string' && file.path) return file.path;
  return '';
}

const EVENT_CHANNELS = [
  'evt:job:log',
  'evt:job:update',
  'evt:job:finish',
  'evt:queue',
  'evt:queue:enqueue',
  'evt:queue:idle',
  'evt:log',
  'evt:window',
  'evt:plugin:progress',
  'cmd',
];

const listeners = new Map();
for (const channel of EVENT_CHANNELS) {
  ipcRenderer.on(channel, (_event, payload) => {
    const set = listeners.get(channel);
    if (set) for (const cb of set) {
      try {
        cb(payload);
      } catch (err) {
        console.error(`[preload] listener error on ${channel}`, err);
      }
    }
  });
}

/** 订阅主进程事件；返回取消订阅函数 */
function on(channel, cb) {
  if (!EVENT_CHANNELS.includes(channel)) throw new Error(`未知事件通道: ${channel}`);
  if (!listeners.has(channel)) listeners.set(channel, new Set());
  listeners.get(channel).add(cb);
  return () => listeners.get(channel).delete(cb);
}

const api = {
  /* -- 应用 / 环境 -------------------------------------------------------- */
  app: {
    info: () => invoke('app:info'),
    layout: () => invoke('app:layout'),
  },

  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
  },

  /* -- 内核 --------------------------------------------------------------- */
  kernels: {
    list: () => invoke('kernels:list'),
    refresh: () => invoke('kernels:refresh'),
    detail: (id) => invoke('kernels:detail', id),
    setEnabled: (id, enabled) => invoke('kernels:setEnabled', { id, enabled }),
    setPriority: (id, priority) => invoke('kernels:setPriority', { id, priority }),
    status: () => invoke('kernels:status'),
    ops: () => invoke('kernels:ops'),
    formats: () => invoke('kernels:formats'),
    openDir: (id) => invoke('kernels:openDir', id),
  },

  /* -- 插件商店 ----------------------------------------------------------- */
  plugins: {
    list: (opts) => invoke('plugins:list', opts),
    install: (id, mode) => invoke('plugins:install', { id, mode }),
    update: (id, mode) => invoke('plugins:update', { id, mode }),
    uninstall: (id) => invoke('plugins:uninstall', id),
    verify: () => invoke('plugins:verify'),
    openDir: () => invoke('plugins:openDir'),
    reveal: (id) => invoke('plugins:reveal', id),
    settings: () => invoke('plugins:settings'),
    /** 查该插件缺哪些依赖（Python 模块 / 外部程序）——2.1.0 */
    deps: (id) => invoke('plugins:deps', id),
    /** 把缺的 Python 依赖装进插件自己的 vendor 目录；indexUrl 可选（镜像 / 官方源）——2.1.0 */
    installDeps: (payload) => invoke('plugins:installDeps', payload),
  },

  /* -- 计划 --------------------------------------------------------------- */
  plan: {
    targets: (payload) => invoke('plan:targets', payload),
    params: (payload) => invoke('plan:params', payload),
    candidates: (payload) => invoke('plan:candidates', payload),
    preview: (req) => invoke('plan:preview', req),
  },

  /* -- 队列 --------------------------------------------------------------- */
  queue: {
    enqueue: (req) => invoke('queue:enqueue', req),
    list: () => invoke('queue:list'),
    cancel: (id) => invoke('queue:cancel', id),
    cancelAll: () => invoke('queue:cancelAll'),
    pause: () => invoke('queue:pause'),
    resume: () => invoke('queue:resume'),
    remove: (id) => invoke('queue:remove', id),
    clear: (finishedOnly = true) => invoke('queue:clear', finishedOnly),
    retry: (id) => invoke('queue:retry', id),
    retryFailed: () => invoke('queue:retryFailed'),
    setParallel: (n) => invoke('queue:setParallel', n),
    jobLogs: (id) => invoke('queue:jobLogs', id),
  },

  /* -- 文件系统 ----------------------------------------------------------- */
  fs: {
    pickFiles: (opts) => invoke('fs:pickFiles', opts),
    pickFolder: (opts) => invoke('fs:pickFolder', opts),
    describe: (paths) => invoke('fs:describe', paths),
    expand: (paths) => invoke('fs:expand', paths),
    openPath: (p) => invoke('fs:openPath', p),
    openExternal: (url) => invoke('fs:openExternal', url),
    exists: (p) => invoke('fs:exists', p),
    readImage: (p) => invoke('fs:readImage', p),
    revealOutput: (p) => invoke('fs:revealOutput', p),
    /** 同步：取拖拽 File 的磁盘路径（webUtils 实现，不经 IPC） */
    pathForFile,
  },

  /* -- 日志 / 自检 / 协议 -------------------------------------------------- */
  logs: {
    list: () => invoke('logs:list'),
    clear: () => invoke('logs:clear'),
  },
  doctor: () => invoke('doctor'),
  protocol: {
    doc: () => invoke('protocol:doc'),
    schemas: () => invoke('protocol:schemas'),
  },

  /* -- 窗口控制 ----------------------------------------------------------- */
  win: {
    minimize: () => invoke('win:minimize'),
    toggleMaximize: () => invoke('win:toggleMaximize'),
    close: () => invoke('win:close'),
    state: () => invoke('win:state'),
    openConsole: () => invoke('win:openConsole'),
  },

  /* -- 事件 --------------------------------------------------------------- */
  on,
  channels: EVENT_CHANNELS,
};

contextBridge.exposeInMainWorld('khs', api);

// 拖拽进窗口时不要触发浏览器默认的「打开文件」行为
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
