'use strict';
/**
 * 开发用「浏览器宿主」：把渲染进程跑在系统 Chrome/Edge 里，后端仍然接真实的内核引擎。
 *
 * 用途：在没有 Electron（或被沙箱挡住 Electron GUI）的环境里，依然可以
 *   · 用真实内核数据渲染界面
 *   · 跑真实的转换任务（进度、日志、产物全部走真链路）
 *   · 截图 / 断言 DOM，做 UI 回归
 *
 * 组成：
 *   Chromium(页面)  ──WebSocket──▶  本进程  ──require──▶  src/engine/*
 *
 * 启动：node tools/devserver.js [--port 8791] [--open] [--keep]
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { Settings } = require('../src/engine/config');
const { detectHubRoot, resolveStateDir } = require('../src/engine/paths');
const { Registry } = require('../src/engine/registry');
const { Hub } = require('../src/engine/hub');
const { JobQueue } = require('../src/engine/queue');
const catalog = require('../src/engine/catalog');
const { clearProbeCache } = require('../src/engine/python');
const { formatOfPath, basenameOf, extOf, CKP_VERSION } = require('../src/shared/protocol');

const ROOT = path.resolve(__dirname, '..');
const ARGV = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = ARGV.indexOf(name);
  return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : fallback;
};
const PORT = Number(arg('--port', 8791));
const PORT_FILE = arg('--port-file', '');

/* ------------------------------------------------------------------ 中枢 */

const settings = new Settings(resolveStateDir());
let registry = new Registry({
  hubRoot: detectHubRoot(settings.get('hubRoot', '')),
  extraPluginDirs: settings.get('extraPluginDirs', []),
  disabledKernels: settings.get('disabledKernels', []),
  priorityOverrides: settings.get('priorityOverrides', {}),
});
registry.discover();
if (!settings.get('hubRoot')) settings.patch({ hubRoot: registry.hubRoot });

const hub = new Hub(() => ({ registry, settings }));
const queue = new JobQueue(hub);
queue.setParallel(settings.get('maxParallel', 2));

const clients = new Set();
const broadcast = (channel, payload) => {
  const frame = JSON.stringify({ event: channel, payload });
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(frame);
  }
};

queue.on('log', (p) => broadcast('evt:job:log', p));
queue.on('update', (job) => broadcast('evt:job:update', serializeJob(job)));
queue.on('enqueue', (jobs) => broadcast('evt:queue:enqueue', jobs.map(serializeJob)));
queue.on('queue', (jobs) => broadcast('evt:queue', jobs.map(serializeJob)));
queue.on('finish', ({ job, outcome }) => broadcast('evt:job:finish', { job: serializeJob(job), outcome: publicOutcome(outcome) }));
queue.on('idle', (c) => broadcast('evt:queue:idle', c));

function humanSize(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v < 1024) return `${v} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2)} ${units[i]}`;
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

function publicOutcome(o) {
  return {
    ok: o.ok,
    kernel: o.kernel_id,
    kernelName: o.kernel_name,
    duration_ms: o.duration_ms,
    outputs: o.outputs,
    error: o.error,
    exit_code: o.exit_code,
    command: o.command,
    stderr: (o.stderr || '').slice(-4000),
  };
}

function describeFile(p) {
  let st = null;
  try {
    st = fs.statSync(p);
  } catch {
    return null;
  }
  return {
    path: p,
    name: basenameOf(p),
    dir: path.dirname(p),
    ext: extOf(p).replace('.', ''),
    format: formatOfPath(p),
    bytes: st.size,
    size: humanSize(st.size),
    mtime: st.mtimeMs,
    isDir: st.isDirectory(),
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
    let st = null;
    try {
      st = fs.statSync(item);
    } catch {
      continue;
    }
    if (!st.isDirectory()) {
      push(item);
      continue;
    }
    const walk = (dir, depth) => {
      if (depth > 6) return;
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const n of names) {
        if (n.startsWith('.')) continue;
        const full = path.join(dir, n);
        let s2 = null;
        try {
          s2 = fs.statSync(full);
        } catch {
          continue;
        }
        if (s2.isDirectory()) walk(full, depth + 1);
        else push(full);
      }
    };
    walk(item, 0);
  }
  return out;
}

function reloadRegistry() {
  settings.load();
  clearProbeCache();
  const root = detectHubRoot(settings.get('hubRoot', ''));
  registry = new Registry({
    hubRoot: root,
    extraPluginDirs: settings.get('extraPluginDirs', []),
    disabledKernels: settings.get('disabledKernels', []),
    priorityOverrides: settings.get('priorityOverrides', {}),
  });
  registry.discover();
  return { kernels: registry.allEntries().map(catalog.kernelView), summary: registry.summary(), layout: registry.layout() };
}

/* ------------------------------------------------------- 请求分发（IPC 同构） */

const handlers = {
  'app:info': () => ({
    name: 'KernelHub Studio',
    version: '1.0.0',
    ckp: CKP_VERSION,
    electron: '(浏览器开发宿主)',
    node: process.versions.node,
    chrome: 'system',
    platform: process.platform,
    arch: process.arch,
    dev: true,
    stateDir: resolveStateDir(),
  }),
  'app:layout': () => registry.layout(),
  'settings:get': () => settings.all(),
  'settings:set': (patch) => {
    const next = settings.patch(patch || {});
    if (patch && patch.maxParallel !== undefined) queue.setParallel(next.maxParallel);
    return next;
  },
  'kernels:list': () => ({ kernels: registry.allEntries().map(catalog.kernelView), summary: registry.summary(), layout: registry.layout() }),
  'kernels:refresh': () => reloadRegistry(),
  'kernels:detail': (id) => {
    const e = registry.get(id);
    return e ? { ok: true, kernel: catalog.kernelDetail(e) } : { ok: false, message: `内核不存在: ${id}` };
  },
  'kernels:setEnabled': ({ id, enabled }) => {
    settings.setKernelEnabled(id, enabled);
    settings.load();
    registry.disabled = new Set(settings.get('disabledKernels', []));
    const entry = registry.get(id);
    if (entry) {
      for (const key of Array.from(registry.probeCache.keys())) if (key.startsWith(`${id}|`)) registry.probeCache.delete(key);
      const fresh = registry.load(entry.directory);
      if (fresh) registry.entries.set(id, fresh);
    }
    return { ok: true, kernel: registry.get(id) ? catalog.kernelView(registry.get(id)) : null };
  },
  'kernels:setPriority': ({ id, priority }) => {
    settings.setPriority(id, priority);
    settings.load();
    registry.priorityOverrides = { ...(settings.get('priorityOverrides', {})) };
    const e = registry.get(id);
    if (e) e.manifest.priority = Number(priority);
    return { ok: true };
  },
  'kernels:status': () => catalog.statusOverview(registry),
  'kernels:ops': () => catalog.opsCatalog(registry),
  'kernels:formats': () => catalog.formatsCatalog(registry),
  'kernels:openDir': () => ({ ok: true }),
  'plan:targets': ({ sourcePath, op, kernelId }) => {
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
  },
  'plan:params': ({ op, srcFmt, dstFmt, kernelId, sources }) => {
    const opId = op || 'convert';
    let src = srcFmt || (sources && sources[0] ? formatOfPath(sources[0]) : '');
    const fallback = !src;
    if (fallback) src = registry.inputFormats(opId)[0] || '';
    const { specs, entry } = registry.paramSpecsFor(opId, src, dstFmt || '', { kernelId: kernelId || '' });
    return {
      op: opId,
      srcFmt: src,
      dstFmt: dstFmt || '',
      fallback,
      kernel: entry ? { id: entry.id, name: entry.name, engineNote: entry.engineNote } : null,
      params: specs.map((s) => ({
        ...s.raw,
        id: s.id,
        type: s.type,
        label: s.label,
        description: s.description,
        ...registry.paramVisibility(s, opId, src, dstFmt || ''),
      })),
    };
  },
  'plan:candidates': ({ op, srcFmt, dstFmt, sources }) => {
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
      chosen = {
        id: r.entry.id,
        name: r.entry.name,
        engineNote: r.entry.engineNote,
        reason: `quality=${r.cap.quality}，priority=${r.entry.manifest.priority}`,
      };
    } catch (err) {
      chosen = { error: err.message, detail: err.detail || '' };
    }
    return { candidates: list, chosen };
  },
  'plan:preview': (req) => hub.preview(req || {}),
  'queue:enqueue': (req) => {
    const sources = expandSources((req && req.sources) || []);
    if (req && req.outDir) fs.mkdirSync(req.outDir, { recursive: true });
    const jobs = queue.enqueue({ ...req, sources });
    return { jobs: jobs.map(serializeJob), counts: queue.counts() };
  },
  'queue:list': () => ({ jobs: queue.list().map(serializeJob), counts: queue.counts(), paused: queue.paused }),
  'queue:cancel': (id) => ({ ok: queue.cancel(id), counts: queue.counts() }),
  'queue:cancelAll': () => ({ ok: (queue.cancelAll(), true), counts: queue.counts() }),
  'queue:pause': () => ({ ok: (queue.pause(), true), paused: true }),
  'queue:resume': () => ({ ok: (queue.resume(), true), paused: false }),
  'queue:remove': (id) => ({ ok: queue.remove(id), counts: queue.counts() }),
  'queue:clear': (finishedOnly) => ({ ok: queue.clear(finishedOnly !== false), counts: queue.counts() }),
  'queue:retry': (id) => ({ ok: Boolean(queue.retry(id)) }),
  'queue:retryFailed': () => ({ ok: Boolean(queue.retryFailed()) }),
  'queue:setParallel': (n) => {
    settings.patch({ maxParallel: Number(n) || 1 });
    queue.setParallel(Number(n) || 1);
    return { ok: true, parallel: queue.parallel };
  },
  'queue:jobLogs': (id) => {
    const j = queue.get(id);
    return j ? { logs: j.logs } : { logs: [] };
  },
  'fs:pickFiles': () => {
    // 浏览器宿主没有原生文件对话框：用预置素材目录里的文件模拟一次「选择文件」
    const dir = path.join(resolveStateDir(), 'fixtures');
    let all = [];
    try {
      all = fs.readdirSync(dir).map((n) => path.join(dir, n));
    } catch {
      all = [];
    }
    if (!all.length) all = require('./fixtures').makeFixtures(dir, { hubRoot: registry.hubRoot, python: registry.python });
    const pick = ['gradient-640x400.png', 'pattern-320x200.bmp', 'pattern-160x120.tga']
      .map((n) => path.join(dir, n))
      .filter((p) => fs.existsSync(p));
    return { files: (pick.length ? pick : all.slice(0, 4)).map(describeFile).filter(Boolean) };
  },
  'fs:pickFolder': () => {
    const dir = path.join(resolveStateDir(), 'devhost-out');
    fs.mkdirSync(dir, { recursive: true });
    return { folder: dir };
  },
  'fs:describe': (paths) => ({ files: (paths || []).map(describeFile).filter(Boolean) }),
  'fs:expand': (paths) => ({ files: expandSources(paths).map(describeFile).filter(Boolean) }),
  'fs:openPath': () => ({ ok: true }),
  'fs:openExternal': (url) => ({ ok: true, url }),
  'fs:exists': (p) => ({ exists: fs.existsSync(String(p || '')) }),
  'fs:readImage': (p) => {
    try {
      const st = fs.statSync(p);
      if (st.size > 24 * 1024 * 1024) return { ok: false, message: '文件过大' };
      const buf = fs.readFileSync(p);
      const ext = extOf(p).toLowerCase().replace('.', '');
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif', ico: 'image/x-icon' }[ext] || 'application/octet-stream';
      return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}`, mime };
    } catch (err) {
      return { ok: false, message: String(err.message || err) };
    }
  },
  'fs:revealOutput': () => ({ ok: true }),
  'logs:list': () => ({ logs: globalLogs.slice(-800) }),
  'logs:clear': () => {
    globalLogs.length = 0;
    return { ok: true };
  },
  doctor: () => hub.doctor(),
  'protocol:doc': () => {
    for (const c of [path.join(registry.hubRoot, 'PROTOCOL.md'), path.join(registry.hubRoot, 'README.md')]) {
      try {
        return { ok: true, path: c, markdown: fs.readFileSync(c, 'utf8') };
      } catch {
        /* next */
      }
    }
    return { ok: false, markdown: '', path: '' };
  },
  'protocol:schemas': () => {
    const out = [];
    try {
      for (const name of fs.readdirSync(registry.schemaDir)) {
        if (!name.endsWith('.json')) continue;
        const p = path.join(registry.schemaDir, name);
        out.push({ name, path: p, text: fs.readFileSync(p, 'utf8') });
      }
    } catch {
      /* ignore */
    }
    return out;
  },
  'win:minimize': () => true,
  'win:toggleMaximize': () => true,
  'win:close': () => true,
  'win:state': () => ({ maximized: false }),
  'win:openConsole': () => true,
};

const globalLogs = [];
function log(level, message) {
  const entry = { at: Date.now(), level, message };
  globalLogs.push(entry);
  if (globalLogs.length > 3000) globalLogs.splice(0, globalLogs.length - 3000);
  broadcast('evt:log', entry);
}

/* ------------------------------------------------------------ WebSocket 服务 */

/** 极简 RFC6455 服务端实现（只支持文本帧 + 分片缓冲，够开发宿主用） */
class MiniWsServer {
  constructor(server, onConnection) {
    this.clients = new Set();
    server.on('upgrade', (req, socket) => {
      if (!req.headers['sec-websocket-key']) {
        socket.destroy();
        return;
      }
      if (!/\/bridge/.test(req.url || '')) {
        socket.destroy();
        return;
      }
      const accept = crypto
        .createHash('sha1')
        .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      socket.setNoDelay(true);
      const conn = new WsConnection(socket);
      this.clients.add(conn);
      conn.onClose = () => this.clients.delete(conn);
      onConnection(conn);
    });
  }
}

class WsConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.readyState = 1;
    this.messages = [];
    this.waiters = [];
    this.onClose = null;
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    socket.on('close', () => {
      this.readyState = 3;
      if (this.onClose) this.onClose();
    });
    socket.on('error', () => {
      this.readyState = 3;
      if (this.onClose) this.onClose();
    });
  }

  drain() {
    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLen + len) return;
      const mask = masked ? this.buffer.slice(offset, offset + 4) : null;
      const payload = this.buffer.slice(offset + maskLen, offset + maskLen + len);
      this.buffer = this.buffer.slice(offset + maskLen + len);
      if (mask) {
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      }
      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.sendFrame(payload, 0xa);
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        const text = payload.toString('utf8');
        const waiter = this.waiters.shift();
        if (waiter) waiter(text);
        else this.messages.push(text);
      }
    }
  }

  sendFrame(payload, opcode = 0x1) {
    if (this.readyState !== 1) return;
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const len = data.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.write(Buffer.concat([header, data]));
    } catch {
      this.readyState = 3;
    }
  }

  send(text) {
    this.sendFrame(text, 0x1);
  }

  next(timeoutMs = 20000) {
    if (this.messages.length) return Promise.resolve(this.messages.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== wrapped);
        reject(new Error('等待客户端消息超时'));
      }, timeoutMs);
      const wrapped = (msg) => {
        clearTimeout(timer);
        resolve(msg);
      };
      this.waiters.push(wrapped);
    });
  }

  close() {
    this.readyState = 3;
    try {
      this.socket.end();
    } catch {
      /* ignore */
    }
    if (this.onClose) this.onClose();
  }
}

/* --------------------------------------------------------------- HTTP 静态服务 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function serveStatic(server) {
  server.on('request', (req, res) => {
    let rel = decodeURIComponent((req.url || '/').split('?')[0]);
    if (rel === '/' || rel === '/index.html') rel = '/devhost.html';

    // devhost.html 由 index.html 现场派生：放开 connect-src 以便连回本进程，
    // 并在所有模块脚本之前注入 window.khs 的 WebSocket 实现（生产包不含这一层）。
    if (rel === '/devhost.html') {
      try {
        const html = fs
          .readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8')
          .replace(/connect-src 'none'/g, "connect-src 'self' ws://127.0.0.1:* ws://localhost:*")
          .replace(
            /(<script type="module" src="js\/boot\.js"><\/script>)/,
            '<script src="devhost/khs-browser.js"></script>\n$1'
          )
          .replace('<title>KernelHub Studio</title>', '<title>KernelHub Studio（浏览器开发宿主）</title>');
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(`派生 devhost.html 失败: ${err.message}`);
      }
      return;
    }

    const file = path.join(ROOT, 'src', 'renderer', rel.replace(/^\/+/, ''));
    const resolved = path.resolve(file);
    if (!resolved.startsWith(path.join(ROOT, 'src', 'renderer'))) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(resolved, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`404 ${rel}`);
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(buf);
    });
  });
}

/* ------------------------------------------------------------------ 主流程 */

const server = http.createServer();
serveStatic(server);
const wsServer = new MiniWsServer(server, async (conn) => {
  clients.add(conn);
  conn.onClose = () => clients.delete(conn);
  log('info', '渲染进程已连接开发宿主');
  try {
    for (;;) {
      const raw = await conn.next(24 * 3600 * 1000);
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        continue;
      }
      if (msg.event === 'ready') {
        conn.send(JSON.stringify({ event: 'evt:ready', payload: { hubRoot: registry.hubRoot, kernels: registry.readyEntries().length } }));
        continue;
      }
      const { id, channel, payload } = msg;
      const fn = handlers[channel];
      if (!fn) {
        conn.send(JSON.stringify({ id, ok: false, error: `未实现的通道: ${channel}` }));
        continue;
      }
      try {
        const result = await fn(payload);
        conn.send(JSON.stringify({ id, ok: true, result }));
      } catch (err) {
        log('error', `${channel} 失败: ${err.message}`);
        conn.send(JSON.stringify({ id, ok: false, error: String(err.message || err) }));
      }
    }
  } catch {
    /* 连接结束 */
  }
});

server.listen(PORT, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${PORT}/devhost.html`;
  // 供自动化脚本（tools/uiverify.js）读取，避免解析 stdout
  if (PORT_FILE) {
    try {
      fs.writeFileSync(
        PORT_FILE,
        JSON.stringify({ port: PORT, url, hubRoot: registry.hubRoot, ready: registry.readyEntries().length, total: registry.entries.size }, null, 2),
        'utf8'
      );
    } catch {
      /* ignore */
    }
  }
  console.log(`[devhost] KernelHub Studio 浏览器宿主已启动`);
  console.log(`[devhost] URL      ${url}`);
  console.log(`[devhost] CKP 工作区 ${registry.hubRoot}`);
  console.log(`[devhost] 可用内核 ${registry.readyEntries().length} / ${registry.entries.size}`);
  if (ARGV.includes('--open')) {
    const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
    if (exe) {
      spawn(exe, [`--app=${url}`, '--window-size=1440,940'], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      console.log(`[devhost] 已用系统浏览器打开`);
    } else {
      console.log('[devhost] 未找到 Chrome/Edge，请手动打开上面的 URL');
    }
  }
});

process.on('SIGINT', () => {
  console.log('\n[devhost] 退出');
  queue.cancelAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
});
