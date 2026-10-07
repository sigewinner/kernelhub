'use strict';
/**
 * 验证「用户双击 exe」这条真实路径：正常启动（不带任何参数），确认窗口真的出现。
 *
 *   node tools/verify-window.js            :: 从工作区外的副本启动
 *   node tools/verify-window.js --in-place :: 直接从 release\win-unpacked 启动（对照用）
 *
 * 判据：出现带窗口标题的同名进程（Electron 会 bootstrap 子进程，退出码不可信）。
 * 结束后会询问式地保留窗口 —— 默认 8 秒后自动关掉，避免留下孤儿进程。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'release', 'win-unpacked');
const OUTSIDE = path.join(os.tmpdir(), 'KernelHub Studio');
const IN_PLACE = process.argv.includes('--in-place');
const KEEP = process.argv.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const s = path.join(from, name);
    const d = path.join(to, name);
    const st = fs.lstatSync(s);
    if (st.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function processInfo(exeName) {
  const base = path.basename(exeName, '.exe');
  const ps = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `$p = Get-Process -Name '${base}' -ErrorAction SilentlyContinue; if ($p) { $p | ForEach-Object { "$($_.Id)|$($_.MainWindowTitle)" } }`,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 }
  );
  const rows = String(ps.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [id, ...rest] = l.split('|');
      return { pid: Number(id), title: rest.join('|').trim() };
    })
    .filter((r) => Number.isFinite(r.pid));
  return { count: rows.length, title: (rows.find((r) => r.title) || {}).title || '', rows };
}

function killAll(exeName) {
  spawnSync('taskkill', ['/F', '/IM', path.basename(exeName)], { stdio: 'ignore', windowsHide: true });
}

(async () => {
  if (!fs.existsSync(SRC)) {
    console.error(`[verify-window] 找不到 ${SRC}\n  先执行：node tools/build.js --dir`);
    process.exit(1);
  }
  const exeName = fs.readdirSync(SRC).find((n) => n.endsWith('.exe'));
  if (!exeName) {
    console.error('[verify-window] release/win-unpacked 里没有 exe');
    process.exit(1);
  }

  let dir = SRC;
  let label = '工作区内（release\\win-unpacked）';
  if (!IN_PLACE) {
    console.log(`[verify-window] 复制到工作区外：${OUTSIDE}`);
    fs.rmSync(OUTSIDE, { recursive: true, force: true });
    copyDir(SRC, OUTSIDE);
    dir = OUTSIDE;
    label = '工作区外（%TEMP%\\KernelHub Studio）';
  }

  const exePath = path.join(dir, exeName);
  killAll(exeName);
  await sleep(500);

  console.log(`\n[verify-window] 正常启动（不带参数），位置：${label}`);
  console.log(`  ${exePath}`);
  const child = spawn(exePath, [], { cwd: dir, stdio: 'ignore', windowsHide: false, detached: false });
  child.on('error', (e) => console.error(`  spawn error: ${e.message}`));

  let windowTitle = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    await sleep(1200);
    const info = processInfo(exeName);
    if (info.title) {
      windowTitle = info.title;
      console.log(`  ✓ 第 ${Math.round((Date.now() - t0) / 1000)} 秒出现窗口：${windowTitle}（进程 ${info.rows.length} 个）`);
      break;
    }
  }
  const final = processInfo(exeName);

  console.log('');
  if (windowTitle) {
    console.log(`[verify-window] 通过 ✓ 窗口标题="${windowTitle}"，同名进程 ${final.rows.length} 个`);
    console.log('  结论：打包版可以正常打开。');
    if (KEEP) {
      console.log('  --keep：窗口保留在桌面上，你看完手动关掉。');
      return;
    }
    await sleep(5000);
    console.log('  5 秒后自动关闭窗口（要保留请加 --keep）。');
    killAll(exeName);
    console.log('  已关闭。');
  } else {
    console.log(`[verify-window] 失败 ✗ 40 秒内没有出现窗口（同名进程 ${final.rows.length} 个）`);
    console.log('  对照：换到工作区外运行 node tools/verify-window.js（不带 --in-place）');
    killAll(exeName);
    process.exit(1);
  }
})();
