'use strict';
/**
 * 验证「双击 启动.bat」这条真实入口：Electron 起不来时应自动降级、给出诊断并打开浏览器版。
 *
 *   node tools/verify-bat.js [--keep]
 *
 * 做法：用 cmd /c 拉起 启动.bat（与双击等价），等握手文件出现，验证服务可用，
 * 最后按进程树清理（不加 --keep）。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT_FILE = path.join(ROOT, '.launch-port.json');
const KEEP = process.argv.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** 把 GBK 解出来的字节还原成 UTF-8 文本（cmd 里 Node 的输出经管道会变成 GBK 字节） */
function decodeConsoleOutput(buf) {
  const utf8 = buf.toString('utf8');
  if (!/\uFFFD|[\u00c0-\u00ff]{2,}/.test(utf8)) return utf8;
  try {
    const iconvLike = Buffer.from(utf8, 'latin1');
    const decoded = iconvLike.toString('utf8');
    if (!decoded.includes('\uFFFD')) return decoded;
  } catch {
    /* 保持原样 */
  }
  return utf8;
}

(async () => {
  try {
    fs.unlinkSync(PORT_FILE);
  } catch {
    /* ignore */
  }

  console.log('[verify-bat] 执行 启动.bat（等价于双击）…');
  const child = spawn('cmd', ['/c', '启动.bat'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const chunks = [];
  const errChunks = [];
  child.stdout.on('data', (d) => chunks.push(d));
  child.stderr.on('data', (d) => errChunks.push(d));

  let url = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
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
    await sleep(500);
  }

  const out = decodeConsoleOutput(Buffer.concat(chunks));
  const errOut = decodeConsoleOutput(Buffer.concat(errChunks));

  const checks = [
    ['启动器有降级说明（提到浏览器版）', /浏览器版|browser/i.test(out)],
    ['给出了环境诊断（Electron / Python / CKP 工作区）', /Electron/.test(out) && /Python/.test(out) && /CKP/.test(out)],
    ['界面服务已监听并写出 URL', Boolean(url)],
  ];
  if (url) checks.push([`界面可访问（${url}）`, (await get(url)) === 200]);

  if (!KEEP) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGKILL');
    }
    await sleep(1000);
  }

  console.log('');
  let failed = 0;
  for (const [name, pass] of checks) {
    console.log(`  ${pass ? '✓' : '✕'} ${name}`);
    if (!pass) failed += 1;
  }
  console.log('');
  console.log('--- 启动.bat 实际输出 ---');
  console.log(out.trim().split('\n').slice(0, 26).join('\n'));
  if (errOut.trim()) {
    console.log('--- stderr ---');
    console.log(errOut.trim().split('\n').slice(0, 8).join('\n'));
  }
  console.log('');
  console.log(failed ? `[verify-bat] 失败 ${failed} 项` : '[verify-bat] 全部通过');
  process.exit(failed ? 1 : 0);
})();
