'use strict';
/**
 * 打包入口（跨平台，不依赖 cross-env）。
 *
 *   node tools/build.js              完整打包（Windows: NSIS 安装版 + 便携版）
 *   node tools/build.js --portable   只生成便携版（不需要额外下载 NSIS 工具链，最省事）
 *   node tools/build.js --dir        只生成解包目录（最快，用来验证打包结果能否启动）
 *   node tools/build.js --mirror     打包工具链走 npmmirror 镜像（国内网络推荐）
 *   node tools/build.js --no-hub     不把 kernel-hub 打进包（体积小，装后需手动指定内核目录）
 *   node tools/build.js --linux      打 Linux 包（AppImage/deb）
 *   node tools/build.js --mac        打 macOS 包（dmg）
 *
 * 为什么需要这层：
 *   1. `set FOO=1 && x` 是 cmd 语法，npm script 里写死在 PowerShell/bash 下不通用；
 *   2. 打包前值得先跑一遍预检，避免把一个坏包发出去；
 *   3. NSIS 安装器需要从网上下工具链，这里统一处理镜像与失败提示。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ARGV = process.argv.slice(2);
const has = (f) => ARGV.includes(f);

const REPO_DIR = path.resolve(ROOT, '..');
const HUB_SRC = process.env.KERNELHUB_SRC || path.join(REPO_DIR, 'kernel-hub');
const HUB_OK = fs.existsSync(path.join(HUB_SRC, 'plugins'));

const say = (m = '') => process.stdout.write(`${m}\n`);

function preflight() {
  say('▸ 打包前检查');
  const checks = [];

  const electronPkg = path.join(ROOT, 'node_modules', 'electron', 'package.json');
  const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  checks.push(['electron 已安装', fs.existsSync(electronPkg)]);
  checks.push(['electron 二进制存在', fs.existsSync(electronExe) || fs.existsSync(path.join(ROOT, 'node_modules', 'electron', 'dist'))]);
  checks.push(['electron-builder 已安装', fs.existsSync(path.join(ROOT, 'node_modules', 'electron-builder'))]);
  checks.push(['应用入口存在', fs.existsSync(path.join(ROOT, 'src', 'main', 'main.js'))]);
  if (has('--no-hub')) {
    checks.push(['内核仓库（--no-hub：不打包）', true]);
  } else {
    checks.push([`内核仓库可打包：${HUB_SRC}`, HUB_OK]);
  }

  let failed = 0;
  for (const [name, pass] of checks) {
    say(`  ${pass ? '✓' : '✗'} ${name}`);
    if (!pass) failed += 1;
  }
  if (failed) {
    say('');
    say('请先修好上面标 ✗ 的项再打包。常见处理：');
    say('  npm install                       :: 装依赖（electron / electron-builder）');
    say('  $env:KERNELHUB_SRC="D:\\path\\to\\kernel-hub"   :: 指定内核仓库位置');
    say('  node tools/build.js --no-hub      :: 确实不打包内核仓库时用这个');
    return false;
  }
  return true;
}

function run() {
  const args = ['--config', path.join(ROOT, 'electron-builder.config.js')];
  if (has('--linux')) args.push('--linux');
  else if (has('--mac')) args.push('--mac');
  else args.push('--win');
  if (has('--dir')) args.push('--dir');
  if (has('--portable')) args.push('portable');
  if (has('--nsis')) args.push('nsis');

  const env = { ...process.env };
  if (has('--no-hub')) env.KERNELHUB_BUNDLE = '0';
  if (has('--no-sign')) env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';

  // electron-builder 构建 nsis 安装器时要从 GitHub 下 NSIS / winCodeSign 工具包，
  // 国内网络经常超时。这里给出镜像开关：--mirror 或 BUILD_MIRROR=1 时全部走 npmmirror。
  if (has('--mirror') || process.env.BUILD_MIRROR === '1') {
    env.ELECTRON_MIRROR = env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
    env.ELECTRON_BUILDER_BINARIES_MIRROR =
      env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/';
    say('  （使用 npmmirror 镜像下载打包工具链）');
  }

  // 通过 node 直接跑 cli.js：绕开 .cmd 包装（在 Windows 上 spawn .cmd 会吞掉输出）
  const cli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
  if (!fs.existsSync(cli)) {
    say(`✗ 找不到 ${cli}，请先 npm install`);
    return 1;
  }

  say('');
  say(`▸ 开始打包：electron-builder ${args.slice(1).join(' ')}`);
  if (env.KERNELHUB_BUNDLE === '0') say('  （不随包分发内核仓库）');
  say('');

  const res = spawnSync(process.execPath, [cli, ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env,
    windowsHide: false,
    shell: false,
  });
  if (res.error) {
    say(`✗ 启动 electron-builder 失败：${res.error.message}`);
    return 1;
  }
  return res.status === null ? 1 : res.status;
}

function report() {
  const out = path.join(ROOT, 'release');
  if (!fs.existsSync(out)) return;
  say('');
  say('▸ 产物');
  const found = [];
  const walk = (dir, depth = 0) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        if (depth < 2) walk(full, depth + 1);
      } else if (/\.(exe|msi|dmg|AppImage|deb|zip)$/i.test(name)) {
        found.push({ rel: path.relative(ROOT, full), size: st.size });
      }
    }
  };
  walk(out);
  for (const f of found) say(`  ${f.rel}  (${(f.size / 1024 / 1024).toFixed(1)} MB)`);
  if (!found.length) say('  （没有生成任何可执行文件，请看上面的错误输出）');

  const unpacked = path.join(out, 'win-unpacked', 'KernelHub Studio.exe');
  if (fs.existsSync(unpacked)) {
    say('');
    say(`  免安装解包版：${unpacked}`);
    say('  这个目录可以直接整体拷贝到别处运行；首次启动会自动使用 resources/hub 里的内核仓库。');
  }
  const nsis = found.find((f) => /setup\.exe$/i.test(f.rel));
  if (nsis) {
    say('');
    say(`  安装包：${nsis.rel}（双击安装，可选安装目录，自动建快捷方式）`);
  }
  const portable = found.find((f) => /portable\.exe$/i.test(f.rel));
  if (portable) {
    say('');
    say(`  便携版：${portable.rel}`);
    say('  注意：便携版首次运行要自解压到临时目录，启动会比安装版慢十几秒，属正常现象。');
  }
}

if (!preflight()) process.exit(1);
const code = run();
report();
process.exit(code);
