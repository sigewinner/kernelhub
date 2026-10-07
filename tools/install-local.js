'use strict';
/**
 * 把打包好的应用复制到「能跑的位置」并启动。
 *
 *   node tools/install-local.js                自动挑一个目标目录并安装
 *   node tools/install-local.js --dir D:\Apps\KernelHub Studio
 *   node tools/install-local.js --no-launch     只复制不启动
 *   node tools/install-local.js --force         目标已存在时覆盖
 *
 * 为什么需要它：Electron 的 Chromium 在**低完整性目录**（带 Low Mandatory Level 标签）
 * 里根本起不来（内核策略，改 ACL 没用）。本机工作区正是这种目录，所以
 * release\win-unpacked\KernelHub Studio.exe 在工作区内双击不会有任何反应。
 * 这个脚本负责把产物搬到普通目录（默认 %LOCALAPPDATA%\Programs\KernelHub Studio），
 * 那边的完整性与权限都是正常的。
 *
 * 完整原理见 tools/integrity.js 的注释。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { detect } = require('./integrity');

const ROOT = path.resolve(__dirname, '..');
const ARGV = process.argv.slice(2);
const has = (f) => ARGV.includes(f);
const argOf = (f, fallback = '') => {
  const i = ARGV.indexOf(f);
  return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : fallback;
};

const say = (m = '') => process.stdout.write(`${m}\n`);
const ok = (m) => say(`✓ ${m}`);
const warn = (m) => say(`! ${m}`);
const bad = (m) => say(`✗ ${m}`);

function candidateDirs() {
  const list = [];
  if (process.env.LOCALAPPDATA) list.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'KernelHub Studio'));
  // D 盘存在就优先放 D:\Apps（很多人把程序装 D 盘）
  for (const drive of ['D', 'E']) {
    try {
      if (fs.existsSync(`${drive}:\\`)) list.push(path.join(`${drive}:\\`, 'Apps', 'KernelHub Studio'));
    } catch {
      /* 忽略 */
    }
  }
  list.push(path.join(os.homedir(), 'KernelHub Studio'));
  return list;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const s = path.join(from, name);
    const d = path.join(to, name);
    const st = fs.lstatSync(s);
    if (st.isDirectory()) copyDir(s, d);
    else {
      fs.copyFileSync(s, d);
      try {
        fs.chmodSync(d, st.mode);
      } catch {
        /* 忽略 */
      }
    }
  }
}

function findBuild() {
  const unpacked = path.join(ROOT, 'release', 'win-unpacked');
  if (fs.existsSync(unpacked)) {
    const exe = fs.readdirSync(unpacked).find((n) => n.endsWith('.exe'));
    if (exe) return { from: unpacked, exeName: exe, kind: 'win-unpacked' };
  }
  return null;
}

(function main() {
  say('KernelHub Studio · 本地安装到可运行目录');
  say('');

  const build = findBuild();
  if (!build) {
    bad('找不到打包产物。请先执行：npm run build:dir');
    process.exit(1);
  }

  // 1) 说明现状：当前目录能不能跑
  const here = detect(ROOT);
  if (here.restricted) {
    warn('当前项目目录被标记为低完整性，Electron 在这里起不来（这正是「双击没反应」的原因）。');
    say(`   标签：${here.raw}`);
    say('   所以下面会把程序装到普通目录再启动。');
  } else {
    ok('当前项目目录的完整性正常（理论上也能直接跑）。');
  }
  say('');

  // 2) 选目标目录
  let target = argOf('--dir', '');
  if (!target) {
    for (const dir of candidateDirs()) {
      const info = detect(dir);
      if (!info.restricted) {
        target = dir;
        break;
      }
    }
  }
  if (!target) {
    bad('没找到合适的安装目录，请用 --dir 手动指定，例如：');
    say('   node tools/install-local.js --dir "D:\\Apps\\KernelHub Studio"');
    process.exit(1);
  }
  target = path.resolve(target);

  const targetInfo = detect(target);
  if (targetInfo.restricted) {
    bad(`目标目录也是低完整性，换一个：${target}`);
    say(`   标签：${targetInfo.raw}`);
    process.exit(1);
  }

  say(`▸ 安装到：${target}`);
  const exePath = path.join(target, build.exeName);

  if (fs.existsSync(exePath) && !has('--force')) {
    warn('目标目录里已经有同名 exe（用 --force 覆盖）');
  } else {
    say('  复制中（约 500 MB，稍等）…');
    const t0 = Date.now();
    copyDir(build.from, target);
    ok(`复制完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  }

  if (!fs.existsSync(exePath)) {
    bad(`复制后没找到 exe：${exePath}`);
    process.exit(1);
  }
  ok(`程序位置：${exePath}`);

  // 3) 启动
  if (has('--no-launch')) {
    say('');
    say('（--no-launch：不启动）可以直接双击上面那个 exe。');
    return;
  }
  say('');
  say('▸ 启动…');
  const child = spawn(exePath, [], { cwd: target, stdio: 'ignore', windowsHide: false, detached: false });
  child.on('error', (e) => {
    bad(`启动失败：${e.message}`);
    process.exit(1);
  });

  // 给一句收尾说明，然后退出（应用会继续运行）
  setTimeout(() => {
    say('');
    ok('已启动。窗口应该已经出现了。');
    say(`  以后直接双击：${exePath}`);
    say(`  建议在桌面建个快捷方式指向它。`);
    process.exit(0);
  }, 6000);
})();
