'use strict';
/**
 * 对照实验：同一个打包 exe，在「工作区内」与「工作区外」分别启动，看能否出窗口。
 *
 *   node tools/diagnose-launch.js
 *
 * 用途：当用户反馈「exe 双击没反应」时，先跑这个脚本定位是环境问题还是程序问题。
 * 判据不是进程退出码（Electron 会 bootstrap 出子进程，父进程退出码无意义），
 * 而是：① 是否有带窗口标题的同名进程在跑；② 自检报告是否被写出来。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'release', 'win-unpacked');
const OUTSIDE = path.join(os.tmpdir(), 'khs-launch-diagnose');
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

/** 查同名进程与窗口标题 */
function inspect(exeName) {
  const res = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${exeName}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  const rows = String(res.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^信息|^INFO|No tasks/i.test(l));
  // 用 PowerShell 取窗口标题更可靠（tasklist 不给标题）
  const ps = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `Get-Process -Name '${path.basename(exeName, '.exe')}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -ExpandProperty MainWindowTitle`],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 }
  );
  const titles = String(ps.stdout || '')
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean);
  return { processes: rows.length, titles };
}

function killAll(exeName) {
  spawnSync('taskkill', ['/F', '/IM', exeName], { stdio: 'ignore', windowsHide: true });
}

/**
 * 启动并观察。
 * @returns {{exe: string, cwd: string, alive: boolean, windowTitles: string[], report: boolean, reportSummary: string, stdout: string, stderr: string}}
 */
async function trial(label, exePath, cwd, seconds) {
  const reportPath = path.join(os.tmpdir(), `khs-diag-${label}.json`);
  fs.rmSync(reportPath, { force: true });
  killAll(path.basename(exePath));

  console.log(`\n──── ${label} ────`);
  console.log(`  exe: ${exePath}`);
  console.log(`  cwd: ${cwd}`);

  const child = spawn(exePath, ['--selftest', '--selftest-out', reportPath], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  child.stderr.on('data', (d) => {
    err += d;
  });
  child.on('error', (e) => {
    err += `spawn error: ${e.message}`;
  });

  // 轮询观察窗口是否出现
  let sawWindow = false;
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    await sleep(1000);
    const info = inspect(path.basename(exePath));
    if (info.titles.length) {
      sawWindow = true;
      console.log(`  ✓ ${Math.round((Date.now() - (deadline - seconds * 1000)) / 1000)}s 出现窗口：${info.titles.join(' / ')}`);
      break;
    }
  }

  const info = inspect(path.basename(exePath));
  const report = fs.existsSync(reportPath)
    ? (() => {
      try {
        const data = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        return { ok: data.ok, summary: data.summary, steps: (data.steps || []).length };
      } catch {
        return { ok: false, summary: '报告解析失败' };
      }
    })()
    : null;

  killAll(path.basename(exePath));
  await sleep(800);

  const result = {
    label,
    exe: exePath,
    cwd,
    alive: !child.killed && child.exitCode === null,
    processes: info.processes,
    windowTitles: info.titles,
    sawWindow,
    report,
    stdout: out.slice(0, 600),
    stderr: err.slice(0, 400),
  };

  console.log(`  同名进程数：${info.processes}`);
  console.log(`  窗口标题：${info.titles.length ? info.titles.join(' / ') : '（无）'}`);
  console.log(`  自检报告：${report ? `${report.summary || '?'}（${report.steps} 步）` : '（未写出）'}`);
  return result;
}

(async () => {
  if (!fs.existsSync(SRC)) {
    console.error(`[diagnose] 找不到 ${SRC}\n  先执行：node tools/build.js --dir`);
    process.exit(1);
  }
  const exeName = fs.readdirSync(SRC).find((n) => n.endsWith('.exe'));
  if (!exeName) {
    console.error('[diagnose] 目录里没有 exe');
    process.exit(1);
  }

  console.log('[diagnose] 对照实验：同一个 exe，换目录启动');
  console.log(`[diagnose] 工作区：${path.parse(ROOT).root}${ROOT.split(path.sep).slice(1, 3).join(path.sep)}`);

  const results = [];
  results.push(await trial('A-工作区内', path.join(SRC, exeName), SRC, 25));

  console.log(`\n[diagnose] 复制到工作区外：${OUTSIDE}`);
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
  copyDir(SRC, OUTSIDE);
  results.push(await trial('B-工作区外', path.join(OUTSIDE, exeName), OUTSIDE, 25));

  console.log(`\n${'─'.repeat(66)}`);
  for (const r of results) {
    console.log(`  ${r.label.padEnd(12)} 窗口=${r.sawWindow ? '有' : '无'}  进程=${r.processes}  自检=${r.report ? r.report.summary || '有' : '无'}`);
  }
  console.log('');

  const a = results[0];
  const b = results[1];
  if (b.sawWindow && !a.sawWindow) {
    console.log('结论：工作区内启动失败、工作区外正常 —— 是**目录级限制**（本机沙箱/安全策略会拦 GUI 进程），');
    console.log('      不是程序问题。把整个目录复制到普通路径（例如 D:\\Apps\\）再双击即可。');
  } else if (a.sawWindow && b.sawWindow) {
    console.log('结论：两种情况都能出窗口 —— 程序本身没问题。若你那边双击没反应，请看下面的 stdout/stderr。');
  } else if (!a.sawWindow && !b.sawWindow) {
    console.log('结论：两种情况都不出窗口 —— 需要进一步排查（见下面的输出与错误）。');
  } else {
    console.log('结论：工作区外也不出窗口 —— 需要进一步排查。');
  }

  for (const r of results) {
    if (r.stdout.trim()) console.log(`\n[${r.label}] stdout:\n${r.stdout.trim().split('\n').slice(0, 8).join('\n')}`);
    if (r.stderr.trim()) console.log(`\n[${r.label}] stderr:\n${r.stderr.trim().split('\n').slice(0, 8).join('\n')}`);
  }
})();
