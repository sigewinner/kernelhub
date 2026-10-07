'use strict';
/**
 * 独立验证启动器：真实启动 → 确认开发宿主在监听 → 确认握手文件写对 → 按进程树清理。
 * 只用于开发期自证，不属于运行时组件。
 *
 *   node tools/verify-launch.js
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT_FILE = path.join(ROOT, '.launch-port.json');

function get(url, timeout = 4000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on('error', () => resolve(0));
    req.setTimeout(timeout, () => {
      req.destroy();
      resolve(0);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  try {
    fs.unlinkSync(PORT_FILE);
  } catch {
    /* ignore */
  }

  console.log('[verify-launch] 启动 tools/launch.js --browser --no-open');
  const child = spawn(process.execPath, [path.join(__dirname, 'launch.js'), '--browser', '--no-open'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  child.stderr.on('data', (d) => {
    err += d;
  });

  let url = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    if (fs.existsSync(PORT_FILE)) {
      try {
        const data = JSON.parse(fs.readFileSync(PORT_FILE, 'utf8'));
        if (data && data.url) {
          url = data.url;
          break;
        }
      } catch {
        /* 正在写 */
      }
    }
    if (child.exitCode !== null) break;
    await sleep(400);
  }

  const results = [];
  results.push(['启动器进程存活', child.exitCode === null]);
  results.push(['握手文件写出 URL', Boolean(url)]);
  if (url) {
    const status = await get(url);
    results.push([`HTTP 探测 ${url} 返回 200`, status === 200]);
    const status404 = await get(url.replace('devhost.html', 'nope.html'));
    results.push(['未知路径返回 404（服务在正常路由）', status404 === 404]);
    const htmlStatus = await get(url);
    results.push(['页面可重复访问', htmlStatus === 200]);
  }
  results.push(['启动器有可读输出', out.length > 20]);

  // 按进程树清理（launch.js 会带着 devserver 一起走）
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
  await sleep(1200);

  console.log('');
  let failed = 0;
  for (const [name, pass] of results) {
    console.log(`  ${pass ? '✓' : '✕'} ${name}`);
    if (!pass) failed += 1;
  }
  console.log('');
  console.log('--- 启动器输出 ---');
  console.log(out.split('\n').slice(0, 14).join('\n'));
  if (err.trim()) {
    console.log('--- stderr ---');
    console.log(err.split('\n').slice(0, 6).join('\n'));
  }
  console.log('');
  console.log(failed ? `[verify-launch] 失败 ${failed} 项` : '[verify-launch] 全部通过');
  process.exit(failed ? 1 : 0);
})();
