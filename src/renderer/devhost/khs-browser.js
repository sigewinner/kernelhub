/**
 * 浏览器开发宿主的 window.khs 实现。
 *
 * 只在「用系统 Chrome/Edge 打开 src/renderer/devhost.html」时加载：
 * 它把与 Electron preload 完全相同的 API 契约用 WebSocket 转发给
 * tools/devserver.js（那一端跑的是真实的内核引擎）。
 *
 * 生产包（Electron）绝对不会加载这个文件。
 */

(() => {
  // 标记自己不是生产宿主：index.html 顶部的 data-khs-bridge 默认是 "missing"，
  // 真正的探测由 js/boot.js 在模块阶段完成（它只看 window.khs 在不在）。
  document.documentElement.setAttribute('data-devhost', '1');

  const sockets = [];
  const pending = new Map();
  const listeners = new Map();
  const CHANNELS = [
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
  let seq = 0;
  let readyResolve;
  const readyPromise = new Promise((r) => {
    readyResolve = r;
  });

  function emit(channel, payload) {
    const set = listeners.get(channel);
    if (set) for (const cb of set) {
      try {
        cb(payload);
      } catch (err) {
        console.error(`[devhost] 事件监听器异常 ${channel}`, err);
      }
    }
  }

  function connect() {
    const ws = new WebSocket(`ws://${location.host}/bridge`);
    sockets.push(ws);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ event: 'ready' }));
      readyResolve(ws);
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.event) {
        if (msg.event === 'evt:ready') {
          emit('evt:ready', msg.payload);
          return;
        }
        emit(msg.event, msg.payload);
        return;
      }
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error || '宿主调用失败'));
    });
    ws.addEventListener('close', () => {
      emit('evt:log', { at: Date.now(), level: 'warn', message: '与开发宿主的连接已断开' });
    });
  }
  connect();

  function call(channel, payload) {
    return readyPromise.then(
      (ws) =>
        new Promise((resolve, reject) => {
          const id = `c${++seq}`;
          pending.set(id, { resolve, reject });
          ws.send(JSON.stringify({ id, channel, payload }));
          setTimeout(() => {
            if (pending.has(id)) {
              pending.delete(id);
              reject(new Error(`宿主调用超时: ${channel}`));
            }
          }, 120000);
        })
    );
  }

  function on(channel, cb) {
    if (!CHANNELS.includes(channel)) throw new Error(`未知事件通道: ${channel}`);
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(cb);
    return () => listeners.get(channel).delete(cb);
  }

  window.khs = {
    devhost: true,
    app: { info: () => call('app:info'), layout: () => call('app:layout') },
    settings: { get: () => call('settings:get'), set: (p) => call('settings:set', p) },
    plugins: {
      list: (o) => call('plugins:list', o),
      install: (id, mode) => call('plugins:install', { id, mode }),
      update: (id, mode) => call('plugins:update', { id, mode }),
      uninstall: (id) => call('plugins:uninstall', id),
      verify: () => call('plugins:verify'),
      openDir: () => call('plugins:openDir'),
      reveal: (id) => call('plugins:reveal', id),
      settings: () => call('plugins:settings'),
    },
    kernels: {
      list: () => call('kernels:list'),
      refresh: () => call('kernels:refresh'),
      detail: (id) => call('kernels:detail', id),
      setEnabled: (id, enabled) => call('kernels:setEnabled', { id, enabled }),
      setPriority: (id, priority) => call('kernels:setPriority', { id, priority }),
      status: () => call('kernels:status'),
      ops: () => call('kernels:ops'),
      formats: () => call('kernels:formats'),
      openDir: (id) => call('kernels:openDir', id),
    },
    plan: {
      targets: (p) => call('plan:targets', p),
      params: (p) => call('plan:params', p),
      candidates: (p) => call('plan:candidates', p),
      preview: (req) => call('plan:preview', req),
    },
    queue: {
      enqueue: (req) => call('queue:enqueue', req),
      list: () => call('queue:list'),
      cancel: (id) => call('queue:cancel', id),
      cancelAll: () => call('queue:cancelAll'),
      pause: () => call('queue:pause'),
      resume: () => call('queue:resume'),
      remove: (id) => call('queue:remove', id),
      clear: (f) => call('queue:clear', f),
      retry: (id) => call('queue:retry', id),
      retryFailed: () => call('queue:retryFailed'),
      setParallel: (n) => call('queue:setParallel', n),
      jobLogs: (id) => call('queue:jobLogs', id),
    },
    fs: {
      pickFiles: (o) => call('fs:pickFiles', o),
      pickFolder: (o) => call('fs:pickFolder', o),
      describe: (p) => call('fs:describe', p),
      expand: (p) => call('fs:expand', p),
      openPath: (p) => call('fs:openPath', p),
      openExternal: (u) => call('fs:openExternal', u),
      exists: (p) => call('fs:exists', p),
      readImage: (p) => call('fs:readImage', p),
      revealOutput: (p) => call('fs:revealOutput', p),
      // 浏览器里没有 webUtils：退回 File.path（开发宿主/自动化里构造的 File 会带上它）
      pathForFile: (file) => (file && typeof file.path === 'string' ? file.path : ''),
    },
    logs: { list: () => call('logs:list'), clear: () => call('logs:clear') },
    doctor: () => call('doctor'),
    protocol: { doc: () => call('protocol:doc'), schemas: () => call('protocol:schemas') },
    win: {
      minimize: () => call('win:minimize'),
      toggleMaximize: () => call('win:toggleMaximize'),
      close: () => call('win:close'),
      state: () => call('win:state'),
      openConsole: () => call('win:openConsole'),
    },
    on,
    channels: CHANNELS,
  };

  /* ---- 自动化验收钩子（仅开发宿主存在） ------------------------------- */

  window.__khsDev = {
    ready: () => readyPromise.then(() => true),
    /** 直接入队（绕过 UI，用于跑真实转换） */
    enqueue: (req) => window.khs.queue.enqueue(req),
    /** 等待队列空闲：等所有作业都不再 queued/running */
    awaitIdle: async (timeoutMs = 300000) => {
      const t0 = Date.now();
      for (;;) {
        const { jobs } = await window.khs.queue.list();
        if (jobs.every((j) => j.state !== 'queued' && j.state !== 'running')) return window.khs.queue.list();
        if (Date.now() - t0 > timeoutMs) throw new Error('等待队列空闲超时');
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    /** 等一个表达式为真（在页面上下文里求值） */
    waitFor: async (expr, timeoutMs = 30000, interval = 200) => {
      const t0 = Date.now();
      for (;;) {
        // eslint-disable-next-line no-new-func
        const v = await Promise.resolve(new Function(`return (${expr})`)());
        if (v) return v;
        if (Date.now() - t0 > timeoutMs) throw new Error(`等待条件超时: ${expr}`);
        await new Promise((r) => setTimeout(r, interval));
      }
    },
    errors: [],
  };
  window.addEventListener('error', (e) => window.__khsDev.errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => window.__khsDev.errors.push('unhandledrejection: ' + String(e.reason)));

  document.documentElement.dataset.host = 'browser-devhost';
})();
