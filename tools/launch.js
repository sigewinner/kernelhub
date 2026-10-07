'use strict';
/**
 * 启动器：预检 → 启动 Electron → 失败则诊断 + 一键降级到浏览器界面。
 *
 *   node tools/launch.js               启动桌面版（默认）
 *   node tools/launch.js --browser     直接启动浏览器版（不尝试 Electron）
 *   node tools/launch.js --dev         桌面版 + 开发者工具
 *   node tools/launch.js --no-fallback 桌面版拉起失败时不自动降级
 *   node tools/launch.js --diag        只打印环境诊断，不启动任何东西
 *
 * 为什么需要它：Electron 的 GUI 进程在某些环境里会在**主进程之前**就退出
 * （本机沙箱就是这种情况，退出码 0x80000003 = STATUS_BREAKPOINT），
 * 此时 npm start 只会静默失败，用户看到的就是「窗口一闪而过」。
 * 这个脚本负责把这种情况讲清楚，并给出一个立刻能用的替代界面。
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ARGV = process.argv.slice(2);
const has = (flag) => ARGV.includes(flag);

const { detect: detectIntegrity } = require('./integrity');

/** 只有在真正支持 ANSI 的终端里才上色（老 conhost / 重定向到文件时自动降级） */
const COLOR_ON =
  !process.env.NO_COLOR &&
  (process.env.WT_SESSION ||
    process.env.TERM_PROGRAM ||
    process.env.COLORTERM ||
    /^(xterm|screen|tmux|vt|ansi)/i.test(process.env.TERM || '')) &&
  !process.env.KERNELHUB_NO_COLOR;

const C = COLOR_ON
  ? {
    reset: '\u001b[0m',
    bold: '\u001b[1m',
    dim: '\u001b[2m',
    red: '\u001b[31m',
    green: '\u001b[32m',
    yellow: '\u001b[33m',
    cyan: '\u001b[36m',
  }
  : { reset: '', bold: '', dim: '', red: '', green: '', yellow: '', cyan: '' };

const say = (msg = '') => process.stdout.write(`${msg}\n`);
const ok = (msg) => say(`${C.green}✓${C.reset} ${msg}`);
const warn = (msg) => say(`${C.yellow}!${C.reset} ${msg}`);
const bad = (msg) => say(`${C.red}✗${C.reset} ${msg}`);
const step = (msg) => say(`${C.cyan}▸${C.reset} ${msg}`);

/* -------------------------------------------------------------- 环境诊断 */

function electronDir() {
  return path.join(ROOT, 'node_modules', 'electron');
}

/** 返回 electron.exe 的绝对路径；找不到返回 '' */
function electronBinary() {
  const dir = electronDir();
  if (!fs.existsSync(dir)) return '';
  let rel = 'electron.exe';
  try {
    rel = fs.readFileSync(path.join(dir, 'path.txt'), 'utf8').trim() || rel;
  } catch {
    /* 用默认名 */
  }
  const direct = path.join(dir, 'dist', rel);
  if (fs.existsSync(direct)) return direct;
  const distDir = path.join(dir, 'dist');
  if (!fs.existsSync(distDir)) return '';
  const exe = fs.readdirSync(distDir).find((n) => /^electron(\.exe)?$/i.test(n));
  return exe ? path.join(distDir, exe) : '';
}

function pythonInfo() {
  const probe = spawnSync('python', ['-c', 'import sys;print(sys.executable);print(sys.version.split()[0])'], {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  });
  if (probe.status !== 0) return null;
  const [exe, version] = String(probe.stdout || '').trim().split(/\r?\n/);
  return { exe, version };
}

function hubRootGuess() {
  const candidates = [
    process.env.KERNELHUB_ROOT,
    process.env.CKP_ROOT,
    path.join(path.dirname(ROOT), 'kernel-hub'),
    path.join(ROOT, 'kernel-hub'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, 'plugins'))) return c;
    } catch {
      /* 下一个 */
    }
  }
  return '';
}

function diagnostics() {
  const bin = electronBinary();
  const py = pythonInfo();
  const hub = hubRootGuess();
  const lines = [];
  lines.push(`Node.js        ${process.version} (${process.platform} ${process.arch})`);
  lines.push(`项目目录       ${ROOT}`);
  lines.push(`Electron 二进制 ${bin ? bin : '（未安装）'}`);
  if (bin) {
    const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    const code = probe.status;
    lines.push(
      `Electron 自检   ${code === 0 ? '通过' : `退出码 ${code}（0x${(code >>> 0).toString(16)}）`}` +
        `${code === -2147483645 ? ' ← STATUS_BREAKPOINT：GUI 进程无法初始化' : ''}`
    );
  }
  lines.push(`Python         ${py ? `${py.version} @ ${py.exe}` : '未在 PATH 中找到'}`);
  lines.push(`CKP 工作区      ${hub || '未找到（界面里可在「设置」指定）'}`);
  return lines;
}

function printDiagnostics() {
  step('环境诊断');
  for (const line of diagnostics()) say(`  ${line}`);
  const integ = detectIntegrity(ROOT);
  say(`  目录完整性      ${integ.restricted ? `✗ 低完整性（Electron 无法在此启动）${integ.raw}` : '✓ 正常（中完整性）'}`);
}

/* ------------------------------------------------------------------ 安装 */

function ensureElectron() {
  if (electronBinary()) return true;
  warn('未找到 Electron 运行时，正在安装（首次约需 1–3 分钟）…');
  const res = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: false,
  });
  if (res.status !== 0 || !electronBinary()) {
    bad('Electron 安装失败。');
    say('  常见原因：npm 源不可达，或 npm 阻止了 electron 的 postinstall 脚本（它负责下载二进制）。');
    say('  可手动执行：');
    say(`    cd /d "${ROOT}"`);
    say('    npm install');
    say('    npx electron --version    :: 能打印版本号才算装好');
    return false;
  }
  ok('Electron 运行时已就绪');
  return true;
}

/* ------------------------------------------------------------------ 启动 */

function launchElectron() {
  const bin = electronBinary();
  if (!bin) return { started: false, code: null, reason: 'missing-binary' };

  const args = ['.'];
  if (has('--dev')) args.push('--dev');
  step(`启动桌面版：${path.basename(bin)} ${args.join(' ')}`);

  const child = spawn(bin, args, { cwd: ROOT, stdio: 'inherit', windowsHide: false });
  return new Promise((resolve) => {
    let exited = false;
    child.on('error', (err) => {
      exited = true;
      resolve({ started: false, code: null, reason: String(err.message || err) });
    });
    child.on('close', (code) => {
      exited = true;
      resolve({ started: true, code });
    });
    // 2.5 秒内没退出，就认为窗口已经起来了
    setTimeout(() => {
      if (!exited) resolve({ started: true, code: null, alive: true });
    }, 2500);
  });
}

/**
 * 降级：把界面跑在系统浏览器里（后端仍是真实内核引擎）。
 * @param {{open?: boolean}} opts open=false 时只起服务不开浏览器（自动化测试用）
 */
async function launchBrowser({ open = true } = {}) {
  step('启动浏览器版界面（后端仍是真实内核引擎）…');
  const script = path.join(__dirname, 'devserver.js');
  const portFile = path.join(ROOT, '.launch-port.json');
  try {
    fs.unlinkSync(portFile);
  } catch {
    /* ignore */
  }
  const child = spawn(process.execPath, [script, '--port-file', portFile], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: false,
  });

  // 等 devserver 写出端口文件（说明已在监听），再打开浏览器，避免打开空白页
  const url = await waitForPortFile(portFile, 45000);
  if (child.exitCode !== null) {
    bad('浏览器版没能启动（devserver 已退出）。可手动运行：node tools/devserver.js --open');
    return 1;
  }
  if (url) {
    if (open) {
      openUrl(url);
      say('');
      say(`  ${C.dim}已在默认浏览器打开；关掉这个窗口即可停止服务。${C.reset}`);
    } else {
      say('');
      say(`  ${C.dim}服务已就绪（未自动打开浏览器）：${url}${C.reset}`);
    }
  } else {
    warn('没能确认服务端口，请看上面 [devhost] URL 一行手动打开。');
  }
  return new Promise((resolve) => {
    child.on('close', (code) => {
      try {
        fs.unlinkSync(portFile);
      } catch {
        /* ignore */
      }
      resolve(code || 0);
    });
  });
}

async function waitForPortFile(file, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fs.existsSync(file)) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data && data.url) return String(data.url);
      } catch {
        /* 文件还在写，稍后再读 */
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return '';
}

/** 用系统默认浏览器打开链接 */
function openUrl(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  } catch {
    warn(`没能自动打开浏览器，请手动访问：${url}`);
    return false;
  }
}

/* ------------------------------------------------------------------ main */

async function main() {
  say(`${C.bold}KernelHub Studio${C.reset} ${C.dim}· CKP 协议驱动的文件转换工作台${C.reset}`);
  say('');

  if (has('--diag')) {
    printDiagnostics();
    return 0;
  }

  if (!fs.existsSync(path.join(ROOT, 'src', 'main', 'main.js'))) {
    bad(`项目文件不完整：找不到 ${path.join(ROOT, 'src', 'main', 'main.js')}`);
    say('  请确认是在 kernelhub-studio 目录下运行。');
    return 1;
  }

  if (has('--browser')) {
    return launchBrowser({ open: !has('--no-open') });
  }

  if (!ensureElectron()) {
    printDiagnostics();
    say('');
    say('已自动改用浏览器版界面（如果你不想用浏览器，请按上面的提示修好 Electron 后重试）。');
    return launchBrowser();
  }

  const result = await launchElectron();

  if (result.alive) {
    // 窗口起来了：等它被关闭（前台进程已交给 Electron）
    return 0;
  }

  if (result.started && result.code === 0) {
    ok('桌面版已退出（code 0）');
    return 0;
  }

  // 走到这里说明桌面版没起来
  say('');
  bad(`桌面版没能启动${result.code === null ? '' : `（退出码 ${result.code} / 0x${(result.code >>> 0).toString(16)}）`}`);
  say('');

  // 最常见、也最容易被误判成「权限问题」的原因：目录低完整性
  const integ = detectIntegrity(ROOT);
  if (integ.restricted) {
    bad('根因：当前目录被 Windows 标记为低完整性，Electron 的沙箱进程无法在其中启动。');
    say(`  标签：${integ.raw}`);
    say('  这是内核强制完整性控制（MIC）—— **不是文件权限，改 ACL 没有用**。');
    say('  Chromium 的渲染进程/GPU 进程以低完整性运行，需要在该目录内创建文件并向上请求更高完整性，');
    say('  被 (NW) 策略直接拒绝，于是浏览器内核在初始化阶段就退出（0x80000003）。');
    say('');
    step('两个立刻可用的办法');
    say('  1) 用浏览器版界面（同一套界面 + 同一个内核引擎）：npm run browser');
    say('  2) 把程序复制到普通目录再跑桌面版：');
    say('       node tools/install-local.js      :: 自动装到 %LOCALAPPDATA%\\Programs 并启动');
    say('       或手动把整个目录复制到  D:\\Apps\\  /  桌面  再双击');
    say('');
  }

  printDiagnostics();
  say('');
  step('其它可能的原因与处理');
  say('  1) Electron 二进制没下载完整：删掉 node_modules\\electron 后重新 npm install');
  say('  2) 被杀软 / 安全策略拦下：把项目目录加入白名单后重试');
  say('  3) 缺少系统运行库（Windows 上通常是 VC++ 运行库）或系统版本过旧');
  say('  4) 远程桌面 / 无桌面会话 / 受限沙箱里 Chromium 无法初始化 GUI —— 这种情况用浏览器版');
  say('');

  if (has('--no-fallback')) {
    say('（--no-fallback：不再自动降级）');
    return 1;
  }

  say('已自动改用浏览器版界面（同一套 HTML/CSS/JS，后端接同一个内核引擎）。');
  return launchBrowser({ open: !has('--no-open') });
}

main()
  .then((code) => process.exit(Number(code) || 0))
  .catch((err) => {
    bad(`启动器异常：${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
