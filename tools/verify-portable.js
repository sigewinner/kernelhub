'use strict';
/**
 * 验证「便携版单文件 exe」：它必须先把自身解压到临时目录再启动，所以观察时间要放宽。
 *
 *   node tools/verify-portable.js [--exe "release\\KernelHub Studio-1.0.0-portable.exe"]
 *
 * 判定标准（与 verify-package 一致）：窗口/渲染链路能起来、内核仓库能定位、内核能发现。
 * 便携版自带 resources/hub，所以不依赖安装目录。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ARGV = process.argv.slice(2);
const exeArg = ARGV.indexOf('--exe');
const exePath = path.resolve(
  ROOT,
  exeArg >= 0 && ARGV[exeArg + 1]
    ? ARGV[exeArg + 1]
    : fs
      .readdirSync(path.join(ROOT, 'release'))
      .filter((n) => /portable\.exe$/i.test(n))
      .map((n) => path.join('release', n))[0] || ''
);

const REPORT = path.join(os.tmpdir(), 'khs-portable-report.json');

(async () => {
  if (!exePath || !fs.existsSync(exePath)) {
    console.error('[verify-portable] 找不到便携版 exe，先执行：node tools/build.js --portable --mirror');
    process.exit(1);
  }
  console.log(`[verify-portable] 目标：${path.relative(ROOT, exePath)}（${(fs.statSync(exePath).size / 1024 / 1024).toFixed(1)} MB）`);
  fs.rmSync(REPORT, { force: true });

  // 关键：把便携版拷到工作区外再跑（工作区目录会阻止 GUI 进程启动）
  const outside = path.join(os.tmpdir(), 'khs-portable-verify.exe');
  fs.copyFileSync(exePath, outside);
  console.log(`[verify-portable] 已复制到工作区外：${outside}`);
  console.log('[verify-portable] 启动（便携版首次运行需自解压，给 180 秒）…');

  const child = spawn(outside, ['--selftest', '--selftest-out', REPORT], {
    cwd: os.tmpdir(),
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
      console.log('[verify-portable] 超时（180s），强制结束');
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve('timeout');
    }, 180000);
    child.on('close', (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });

  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  } catch {
    /* 报告没写出来 */
  }

  console.log(`[verify-portable] 退出码：${code}`);
  if (out.trim()) {
    console.log('--- 自检输出 ---');
    console.log(out.trim().split('\n').slice(0, 24).join('\n'));
  }
  if (err.trim() && !/crashpad_client_win/.test(err)) {
    console.log('--- stderr ---');
    console.log(err.trim().split('\n').slice(0, 8).join('\n'));
  }

  let failed = 0;
  let pending = 0;
  if (report && Array.isArray(report.steps)) {
    console.log('');
    console.log('--- 自检报告 ---');
    for (const s of report.steps) {
      const isPending = /待执行/.test(s.name);
      console.log(`  ${isPending ? '…' : s.ok ? '✓' : '✕'} ${s.name}${s.detail ? `  (${String(s.detail).slice(0, 80)})` : ''}`);
      if (isPending) pending += 1;
      else if (!s.ok) failed += 1;
    }
    console.log('');
    console.log(`  内核仓库：${report.layout ? report.layout.hubRoot : '?'}`);
  } else {
    console.log('');
    console.log('✕ 没读到自检报告 —— 便携版可能没起来');
    failed += 1;
  }

  console.log('');
  const criticalNames = ['定位 CKP 工作区', '发现内核（>=15）', '可用内核（>=1）', '渲染进程加载 + 桥接就绪 + 导航渲染'];
  const criticalOk =
    report && criticalNames.every((n) => {
      const s = (report.steps || []).find((x) => x.name === n);
      return s && s.ok;
    });

  try {
    fs.rmSync(outside, { force: true });
  } catch {
    /* ignore */
  }

  if (criticalOk && failed === 0) {
    console.log('[verify-portable] 便携版可用 ✓（自解压 → 启动 → 渲染 → 内核探测 全部通过）');
    if (pending) console.log('  （真实转换那步在本机沙箱被拦下，属环境限制）');
    process.exit(0);
  }
  console.log('[verify-portable] 便携版存在问题');
  process.exit(1);
})().catch((e) => {
  console.error('[verify-portable] 异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
