'use strict';
/**
 * 打包入口（跨平台，不依赖 cross-env）。
 *
 *   node tools/build.js              完整打包（Windows: NSIS 安装版 + 便携版）
 *   node tools/build.js --portable   只生成便携版（不需要额外下载 NSIS 工具链，最省事）
 *   node tools/build.js --dir        只生成解包目录（最快，用来验证打包结果能否启动）
 *   node tools/build.js --mirror     打包工具链走 npmmirror 镜像（国内网络推荐）
 *   node tools/build.js --with-hub   把整个内核仓库也打进包（2.0.0 默认不打，一体包体积大）
 *   node tools/build.js --linux      打 Linux 包（AppImage/deb）
 *   node tools/build.js --mac        打 macOS 包（dmg）
 *
 * 2.0.0 起默认是「壳模式」：只带 SDK + 协议资产 + 4 个种子插件（约 1.6 MB），
 * 其余插件由用户在应用内按需下载，见 src/engine/pluginStore.js。
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
  // 2.0.0：随包分发的是 SDK / 协议 / 种子插件这三份，内核仓库默认不打
  checks.push(['适配器 SDK 存在（sdk/kernelhub）', fs.existsSync(path.join(ROOT, 'sdk', 'kernelhub', 'sdk.py'))]);
  checks.push(['协议文档存在（protocol/schemas）', fs.existsSync(path.join(ROOT, 'protocol', 'schemas'))]);
  checks.push(['种子插件存在（seed-plugins）', fs.existsSync(path.join(ROOT, 'seed-plugins'))]);
  if (has('--with-hub')) {
    checks.push([`内核仓库可打包：${HUB_SRC}`, HUB_OK]);
  } else {
    checks.push(['内核仓库（壳模式：不打包）', true]);
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
    say('  $env:KERNELHUB_SRC="D:\\path\\to\\kernel-hub"   :: 指定内核仓库位置（仅 --with-hub 需要）');
    say('  去掉 --with-hub                    :: 用默认的壳模式打包');
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
  /**
   * 2.2.7：安装包不再由 NSIS 产出，改用自绘安装器
   * （installer/Setup.cs，由 tools/build-installer.js 用 Windows 自带的 csc.exe 编译）。
   * 这里保留 --nsis 开关只为兼容旧命令：它不再改变 electron-builder 的目标，
   * 安装器统一在打包完成后由 build-installer.js 生成。
   */
  if (has('--nsis')) say('  提示：--nsis 已不再需要，安装包统一由自绘安装器生成');

  const env = { ...process.env };
  // 2.0.0：默认壳模式（不打包内核仓库）；只有显式 --with-hub 才走一体化
  env.KERNELHUB_BUNDLE = has('--with-hub') ? '1' : '0';
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
  say(
    env.KERNELHUB_BUNDLE === '1'
      ? '  （一体化模式：整个内核仓库随包分发，体积大）'
      : '  （壳模式：只带 SDK + 协议 + 种子插件，其余内核由用户在应用内按需下载）'
  );
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
    say('  这个目录可以直接整体拷贝到别处运行。');
    const res = path.join(out, 'win-unpacked', 'resources');
    const parts = [];
    for (const [name, label] of [
      ['sdk', '适配器 SDK'],
      ['protocol', '协议资产'],
      ['seed-plugins', '种子插件'],
      ['hub', '一体包内核仓库'],
    ]) {
      if (fs.existsSync(path.join(res, name))) parts.push(label);
    }
    if (parts.length) say(`  随包资源：${parts.join(' / ')}`);
    if (!fs.existsSync(path.join(res, 'hub'))) {
      say('  壳模式：安装后首次启动会建用户工作区，并把种子插件复制过去；');
      say('            其余插件在「插件」页按需下载。');
    }
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

/**
 * 打包完成后再生成自绘安装器（需要 win-unpacked 作为 payload）。
 * 只在 Windows 全量打包时做：--dir / --linux / --mac 都跳过。
 */
function buildCustomInstaller() {
  if (has('--linux') || has('--mac') || has('--dir')) return 0;
  const unpacked = path.join(ROOT, 'release', 'win-unpacked', 'KernelHub Studio.exe');
  if (!fs.existsSync(unpacked)) {
    say('  · 没有 win-unpacked，跳过自绘安装器');
    return 0;
  }
  say('');
  say('▸ 生成自绘安装器');
  const res = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-installer.js')], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
  });
  return res.status === null ? 1 : res.status;
}

/**
 * 清掉 release/ 里**其他版本**的安装包与便携版。
 * 不清的话 report() 里的 find 会先匹配到上一版的产物，
 * 于是提示里写着旧版本号（实测踩到：2.2.8 构建完提示 2.2.7）。
 */
function cleanStaleArtifacts() {
  const out = path.join(ROOT, 'release');
  if (!fs.existsSync(out)) return;
  const version = require(path.join(ROOT, 'package.json')).version;
  let removed = 0;
  for (const name of fs.readdirSync(out)) {
    if (!/-(setup|portable)\.exe(\.blockmap)?$/i.test(name)) continue;
    if (name.includes(version)) continue;
    try {
      fs.rmSync(path.join(out, name), { force: true });
      removed++;
    } catch {}
  }
  if (removed) say(`  · 清掉 ${removed} 个旧版本产物`);
}

if (!preflight()) process.exit(1);
cleanStaleArtifacts();
const code = run();
const installerCode = code === 0 ? buildCustomInstaller() : 0;
report();
process.exit(code === 0 ? installerCode : code);
