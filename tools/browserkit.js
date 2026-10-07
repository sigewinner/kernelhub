'use strict';
/**
 * 无依赖的浏览器自动化小工具（CDP 直连）。
 *
 * 环境说明：本机沙箱不允许 Electron 的 GUI 进程启动（Chromium 在主进程之前崩溃），
 * 因此界面验证走「系统 Chrome/Edge + Chrome DevTools Protocol」这条路：
 * 渲染的是同一套 HTML/CSS/JS，后端仍是真实内核引擎（见 tools/devserver.js）。
 *
 * 用法：
 *   const b = await openBrowser({ url, headless: true });
 *   await b.eval('document.title');
 *   await b.click('#some-button');
 *   await b.screenshot('shot.png');
 *   await b.close();
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

function findChromium() {
  for (const c of CANDIDATES) if (fs.existsSync(c)) return c;
  throw new Error('未找到 Chrome/Edge，无法进行浏览器侧验证');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function httpJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

async function waitFor(fn, { timeout = 30000, interval = 250, label = '条件' } = {}) {
  const t0 = Date.now();
  let lastErr = null;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() - t0 > timeout) {
      throw new Error(`等待「${label}」超时${lastErr ? `：${lastErr.message}` : ''}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}, timeoutMs = 120000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error(`无法连接 CDP: ${wsUrl}`)), { once: true });
  });
  return new CdpSession(ws);
}

/**
 * 打开一个浏览器页面。
 * @param {{url: string, headless?: boolean, width?: number, height?: number, profile?: string, extraArgs?: string[]}} opts
 */
async function openBrowser(opts) {
  const {
    url,
    headless = true,
    width = 1440,
    height = 940,
    extraArgs = [],
  } = opts;
  const exe = opts.exe || findChromium();
  const port = await freePort();
  const profile = opts.profile || path.join(os.tmpdir(), `khs-cdp-${port}`);
  fs.mkdirSync(profile, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--allow-file-access-from-files',
    ...(headless ? ['--headless=new', '--disable-gpu'] : []),
    ...extraArgs,
    url,
  ];

  const child = spawn(exe, args, { stdio: 'ignore', windowsHide: false, detached: false });
  let session = null;
  let target = null;

  try {
    await waitFor(
      async () => {
        const list = await httpJson(`http://127.0.0.1:${port}/json/list`);
        const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (!page) return false;
        target = page;
        return true;
      },
      { timeout: 30000, interval: 300, label: '浏览器调试端口' }
    );

    session = await cdpConnect(target.webSocketDebuggerUrl);
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    // 等页面真正加载完
    await waitFor(
      async () => {
        const r = await session.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
        return r.result && r.result.value === 'complete';
      },
      { timeout: 30000, interval: 200, label: '页面加载' }
    );
  } catch (err) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    throw err;
  }

  const api = {
    exe,
    port,
    child,
    session,
    target,

    /** 在页面里执行一段代码：body 里用 return 返回结果，支持 await */
    async eval(body, { timeout = 120000 } = {}) {
      const expression = `(async () => {\n${body}\n})()`;
      const res = await session.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true, userGesture: true },
        timeout
      );
      if (res.exceptionDetails) {
        const d = res.exceptionDetails;
        const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text;
        throw new Error(`页面执行异常: ${msg}`);
      }
      return res.result ? res.result.value : undefined;
    },

    /** 单表达式求值（同步，自动 return） */
    async value(expression) {
      const res = await session.send('Runtime.evaluate', { expression: `(${expression})`, returnByValue: true, awaitPromise: true });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || '求值失败');
      return res.result ? res.result.value : undefined;
    },

    async waitForExpr(expr, timeout = 20000, label = expr) {
      return waitFor(() => api.value(expr), { timeout, label });
    },

    async click(selector) {
      const ok = await api.eval(`
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      `);
      if (!ok) throw new Error(`点击失败，未找到元素: ${selector}`);
      await new Promise((r) => setTimeout(r, 350));
      return true;
    },

    async type(selector, text) {
      const ok = await api.eval(`
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.focus();
        el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      `);
      if (!ok) throw new Error(`输入失败，未找到元素: ${selector}`);
      await new Promise((r) => setTimeout(r, 200));
      return true;
    },

    async navigate(target_url) {
      await session.send('Page.navigate', { url: target_url });
      await waitFor(
        async () => (await api.value('document.readyState')) === 'complete',
        { timeout: 30000, label: '跳转完成' }
      );
    },

    async reload() {
      await session.send('Page.reload', { ignoreCache: true });
      await new Promise((r) => setTimeout(r, 1200));
    },

    /** 捕获网页长图（超出视口的部分用 captureBeyondViewport 一并截下） */
    async screenshot(file, { fullPage = false } = {}) {
      if (fullPage) {
        const metrics = await session.send('Page.getLayoutMetrics');
        const size = metrics.cssContentSize || metrics.contentSize;
        await session.send('Emulation.setDeviceMetricsOverride', {
          width: Math.ceil(size.width),
          height: Math.ceil(size.height),
          deviceScaleFactor: 1,
          mobile: false,
        });
      }
      const shot = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      if (fullPage) await session.send('Emulation.clearDeviceMetricsOverride');
      return file;
    },

    async close() {
      try {
        await session.send('Browser.close', {}, 5000);
      } catch {
        /* ignore */
      }
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 400));
    },
  };

  return api;
}

module.exports = { openBrowser, findChromium, waitFor, httpJson, freePort };
