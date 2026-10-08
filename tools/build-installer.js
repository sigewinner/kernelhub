'use strict';
/**
 * build-installer.js —— 用 Windows 自带的 csc.exe 编译自绘安装器（2.2.7）
 *
 * 为什么自己写安装器：
 *   NSIS 只能换图与文案（MUI2 没有颜色/皮肤 define，工具链里也没有皮肤引擎），
 *   做不出「无系统标题栏 + 圆角 + 品牌色大按钮 + 动画」这种界面。
 *   本脚本用 .NET Framework 自带的 C# 编译器把 installer/*.cs 编译成单个 exe，
 *   不需要装任何额外工具链（VS、Roslyn、NSIS 皮肤引擎都不需要）。
 *
 * 产物：
 *   release/KernelHub Studio-<版本>-setup.exe    自绘安装器（内嵌 payload.7z 与卸载器）
 *
 * 步骤：
 *   1. 确认 release/win-unpacked（应用本体）存在
 *   2. 用 electron-builder 缓存里的 7za 把 win-unpacked 压成 payload.7z（内含 app/ 目录）
 *   3. 编译 installer/Uninstall.cs → uninstall.exe
 *   4. 生成 Version.g.cs（版本号单一来源）
 *   5. 编译 installer/Setup.cs，把 payload.7z / sevenzip.exe / uninstall.exe 作为资源嵌进去
 *
 * 用法: node tools/build-installer.js [--skip-payload]
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RELEASE = path.join(ROOT, 'release');
const APP_DIR = path.join(RELEASE, 'win-unpacked');
const INSTALLER_SRC = path.join(ROOT, 'installer');
const OBJ = path.join(ROOT, '.installer-obj');
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const ICON = path.join(ROOT, 'build', 'icon.ico');
// 清单：声明 asInvoker，绕开 Windows 对「名字含 setup/install 的 exe」的
// 启发式提权（不声明的话会被拖去弹 UAC，然后失败）
const MANIFEST = path.join(INSTALLER_SRC, 'app.manifest');

const VERSION = require(path.join(ROOT, 'package.json')).version;

function say(msg) {
  console.log(msg);
}
function fail(msg) {
  console.error(`  ✗ ${msg}`);
  process.exit(1);
}

/** 找 electron-builder 缓存里的 7za.exe（NSIS 打包时也在用它，属于既有依赖） */
function find7za() {
  const cache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache');
  if (!fs.existsSync(cache)) return null;
  const stack = [cache];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.toLowerCase() === '7za.exe') return full;
    }
  }
  return null;
}

function main() {
  const skipPayload = process.argv.includes('--skip-payload');

  if (!fs.existsSync(CSC)) fail(`找不到 csc.exe：${CSC}`);
  if (!fs.existsSync(APP_DIR)) fail(`找不到应用本体目录：${APP_DIR}（先跑 node tools/build.js --dir）`);

  fs.mkdirSync(OBJ, { recursive: true });

  /* ---------------------------------------------------- 1. payload.7z */
  const payload = path.join(OBJ, 'payload.7z');
  let sevenZip = null;
  if (!skipPayload || !fs.existsSync(payload)) {
    sevenZip = find7za();
    if (!sevenZip) fail('找不到 7za.exe（electron-builder 缓存里没有；先跑一次打包）');
    // 打成含 app/ 目录的结构：安装器解压后从 <temp>/app 复制
    const staging = path.join(OBJ, 'staging');
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(path.join(staging, 'app'), { recursive: true });
    say('  · 准备 payload（复制应用本体到暂存目录）…');
    fs.cpSync(APP_DIR, path.join(staging, 'app'), { recursive: true });
    say('  · 压缩 payload.7z（7z 最高压缩，和原来 NSIS 用的同一套）…');
    fs.rmSync(payload, { force: true });
    execFileSync(sevenZip, ['a', '-t7z', '-mx=9', '-md=1m', '-mtc=off', '-ms=off', '-bd', payload, 'app'], {
      cwd: staging,
      stdio: 'inherit',
    });
    fs.rmSync(staging, { recursive: true, force: true });
  } else {
    say('  · 复用已有 payload.7z（--skip-payload）');
  }
  const payloadMB = (fs.statSync(payload).size / 1048576).toFixed(1);
  say(`  · payload.7z = ${payloadMB} MB`);

  /* --------------------------------------------------- 2. uninstall.exe */
  const versionCs = path.join(OBJ, 'Version.g.cs');
  fs.writeFileSync(
    versionCs,
    `// 由 tools/build-installer.js 生成，不要手改\n` +
      `internal static class BuildInfo\n{\n    public const string Version = "${VERSION}";\n}\n`,
    'utf8'
  );

  const uninstaller = path.join(OBJ, 'uninstall.exe');
  say('  · 编译卸载器 …');
  execFileSync(
    CSC,
    [
      '/nologo',
      '/target:winexe',
      '/platform:x64',
      '/optimize+',
      `/win32icon:${ICON}`,
      `/win32manifest:${MANIFEST}`,
      `/out:${uninstaller}`,
      '/reference:System.dll',
      '/reference:System.Drawing.dll',
      '/reference:System.Windows.Forms.dll',
      path.join(INSTALLER_SRC, 'Uninstall.cs'),
    ],
    { stdio: 'inherit' }
  );

  /* --------------------------------------------------- 3. setup.exe */
  if (!sevenZip) sevenZip = find7za();
  if (!sevenZip) fail('找不到 7za.exe（安装器要把解压工具一起嵌进去）');
  const sevenCopy = path.join(OBJ, 'sevenzip.exe');
  fs.copyFileSync(sevenZip, sevenCopy);

  const out = path.join(RELEASE, `KernelHub Studio-${VERSION}-setup.exe`);
  fs.rmSync(out, { force: true });
  say('  · 编译安装器（把 payload / 解压器 / 卸载器作为资源嵌进去）…');
  execFileSync(
    CSC,
    [
      '/nologo',
      '/target:winexe',
      '/platform:x64',
      '/optimize+',
      `/win32icon:${ICON}`,
      `/win32manifest:${MANIFEST}`,
      `/out:${out}`,
      '/reference:System.dll',
      '/reference:System.Drawing.dll',
      '/reference:System.Windows.Forms.dll',
      '/reference:System.IO.Compression.dll',
      `/resource:${payload},payload.7z`,
      `/resource:${sevenCopy},sevenzip.exe`,
      `/resource:${uninstaller},uninstall.exe`,
      versionCs,
      path.join(INSTALLER_SRC, 'Setup.cs'),
    ],
    { stdio: 'inherit' }
  );

  const size = (fs.statSync(out).size / 1048576).toFixed(1);
  say('');
  say(`  自绘安装器：release/${path.basename(out)}（${size} MB）`);
}

main();
