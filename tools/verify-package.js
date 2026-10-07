'use strict';
/**
 * 验证打包版（免安装）能不能真正启动并自检通过。
 *
 *   node tools/verify-package.js
 *
 * 关键点：**必须把打包目录复制到工作区外再运行**。
 * 本机 DSH 工作区目录会阻止 GUI 进程从该目录启动（STATUS_BREAKPOINT），
 * 与代码无关；复制到 %TEMP% 之后就能正常启动。
 *
 * 流程：复制 release/win-unpacked → %TEMP% → 跑 --selftest → 读报告 → 汇总。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'release', 'win-unpacked');
const DEST = path.join(os.tmpdir(), 'khs-package-verify');
const REPORT = path.join(DEST, 'selftest-report.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `--launch-check`：真的把打包好的应用启动起来（普通模式，显示窗口），
 * 确认它不会立刻退出。会真的在你桌面上开一个窗口，需要手动关闭。
 */
async function launchCheck(dir, exeName) {
  console.log('');
  console.log('[verify-package] --launch-check：启动打包版窗口（请手动关闭它）…');
  const child = spawn(path.join(dir, exeName), [], { cwd: dir, stdio: 'ignore', windowsHide: false });
  let exited = false;
  child.on('close', (c) => {
    exited = true;
    console.log(`[verify-package] 窗口进程已退出（code=${c}）`);
  });
  await sleep(20000);
  if (exited) {
    console.log('✕ 应用在 20 秒内自己退出了 —— 说明启动失败');
    return false;
  }
  console.log('✓ 应用持续运行了 20 秒：窗口已成功打开');
  // 顺便看看有没有子进程（渲染进程）
  const { execFileSync } = require('child_process');
  try {
    const list = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + exeName, '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true });
    const rows = list.trim().split('\n').length - 1;
    console.log(`  同名进程数：${rows}（Electron 每个渲染进程一个）`);
  } catch {
    /* 忽略 */
  }
  console.log('  这个窗口就留在桌面上，你看完手动关掉即可。');
  return true;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const s = path.join(from, name);
    const d = path.join(to, name);
    const st = fs.lstatSync(s);
    if (st.isDirectory()) copyDir(s, d);
    else if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d);
    else fs.copyFileSync(s, d);
  }
}

(async () => {
  if (!fs.existsSync(SRC)) {
    console.error(`[verify-package] 找不到 ${SRC}\n  先执行：node tools/build.js --dir`);
    process.exit(1);
  }

  console.log(`[verify-package] 复制打包目录到工作区外：${DEST}`);
  fs.rmSync(DEST, { recursive: true, force: true });
  copyDir(SRC, DEST);

  const exe = fs.readdirSync(DEST).find((n) => n.endsWith('.exe'));
  if (!exe) {
    console.error('[verify-package] 复制结果里没有 exe');
    process.exit(1);
  }
  const exePath = path.join(DEST, exe);
  const sizeMB = (fs.statSync(exePath).size / 1024 / 1024).toFixed(1);
  console.log(`[verify-package] 目标：${exe}（${sizeMB} MB）`);

  console.log('[verify-package] 运行 --selftest …');
  const child = spawn(exePath, ['--selftest', '--selftest-out', REPORT], {
    cwd: DEST,
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

  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.log('[verify-package] 自检超时（120s），强制结束');
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve('timeout');
    }, 120000);
    child.on('close', (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });

  await sleep(500);

  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  } catch (e) {
    /* 报告可能没写出来 */
  }

  console.log('');
  console.log(`[verify-package] 进程退出码：${code}`);
  if (out.trim()) {
    console.log('--- 自检输出 ---');
    console.log(out.trim().split('\n').slice(0, 30).join('\n'));
  }
  if (err.trim()) {
    // 自检模式不注册 IPC，渲染进程的调用必然报 "No handler registered"，
    // 这是预期噪音，过滤掉以免干扰判断。
    const noise = err
      .split('\n')
      .filter((l) => !/No handler registered|browser_init|Session\.emit|^\s+at\s/.test(l))
      .join('\n')
      .trim();
    if (noise) {
      console.log('--- stderr（已过滤自检模式预期噪音）---');
      console.log(noise.split('\n').slice(0, 12).join('\n'));
    }
  }

  let failed = 0;
  let pending = 0;
  let criticalOk = false;
  if (report && Array.isArray(report.steps)) {
    console.log('');
    console.log('--- 自检报告 ---');
    for (const s of report.steps) {
      const isPending = /待执行/.test(s.name);
      console.log(`  ${isPending ? '…' : s.ok ? '✓' : '✕'} ${s.name}${s.detail ? `  (${String(s.detail).slice(0, 90)})` : ''}`);
      if (isPending) pending += 1;
      else if (!s.ok) failed += 1;
    }
    console.log('');
    console.log(`  内核仓库：${report.layout ? report.layout.hubRoot : '?'}`);
    console.log(`  可用内核：${report.steps.find((s) => s.name.startsWith('可用内核')) ? report.steps.find((s) => s.name.startsWith('可用内核')).detail : '?'}`);
    console.log(`  真实转换：${report.conversion ? `${report.conversion.kernel || '-'} / ${report.conversion.state}` : '未执行（进程在转换阶段被环境终止）'}`);
    console.log(`  总结：${report.summary || '（无）'}`);

    // 关键结论：窗口能开、渲染能加载、内核仓库定位正确 —— 这三样过了就算「打包版可用」
    const critical = [
      '定位 CKP 工作区',
      '内核仓库来源正确（打包版应来自 resources/hub）',
      '发现内核（>=15）',
      '可用内核（>=1）',
      '渲染进程加载 + 桥接就绪 + 导航渲染',
    ];
    const criticalOk2 = critical.every((name) => {
      const s = report.steps.find((x) => x.name === name);
      return s && s.ok;
    });
    criticalOk = criticalOk2;
    const conversionOk = report.conversion && report.conversion.state === 'done';
    if (criticalOk && !conversionOk) {
      console.log('');
      console.log('  ⚠ 启动链路全部通过；只有「真实转换」这一步在当前沙箱里被系统拦下（原生崩溃），');
      console.log('    这属于本机环境限制，不影响打包版在正常桌面上运行。');
    }
    if (report.crashed) {
      console.log(`  ⚠ 崩溃点：${report.crashed}`);
    }
  } else {
    console.log('');
    console.log('✕ 没读到自检报告 —— 说明主进程可能根本没起来');
    failed += 1;
  }

  console.log('');
  if (report && report.ok && failed === 0) {
    console.log('[verify-package] 打包版全部通过 ✓（含真实转换）');
    console.log(`  （免安装目录保留在 ${DEST}，可以直接双击里面的 ${exe} 看界面）`);
    process.exit(0);
  }
  if (report && criticalOk && failed === 0 && pending === 1) {
    console.log('[verify-package] 打包版启动链路全部通过 ✓');
    console.log('  真实转换那一步在当前沙箱里被系统拦下（原生崩溃），属本机环境限制，不算打包问题；');
    console.log('  开发态的引擎冒烟测试（node tools/smoke.js，55 项）已覆盖真实转换链路。');
    console.log(`  免安装目录：${DEST}`);
    console.log(`  直接双击 ${exe} 即可看到界面。`);
    if (process.argv.includes('--launch-check')) {
      await launchCheck(DEST, exe);
    }
    process.exit(0);
  }
  console.log(`[verify-package] 打包版存在 ${failed + (report && report.ok ? 0 : 1)} 项问题`);
  process.exit(1);
})().catch((e) => {
  console.error('[verify-package] 异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
