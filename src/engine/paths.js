'use strict';
/**
 * 路径解析：定位 CKP 工作区（kernel-hub）与本地状态目录。
 *
 * 本 Electron 宿主**不修改** kernel-hub 目录，只把它当作「内核仓库」来读取：
 *   <hub>/plugins/*&#47;kernel.json        内核清单
 *   <hub>/vendor/*                  Python 侧内核依赖（Pillow / PyMuPDF / FFmpeg …）
 *   <hub>/protocol/schemas/*.json   协议 Schema
 *   <hub>/PROTOCOL.md               协议规范
 *   <hub>/.cache/runs/*.json        任务落盘（与 Python 宿主共用，便于对照调试）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..', '..');
const REPO_DIR = path.resolve(APP_DIR, '..');

const DEFAULT_HUB_NAMES = ['kernel-hub', 'kernelhub', 'ckp-hub'];

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 一个目录看起来像 CKP 工作区吗？ */
function looksLikeHub(dir) {
  if (!isDir(dir)) return false;
  return isDir(path.join(dir, 'plugins')) || isFile(path.join(dir, 'PROTOCOL.md'));
}

/**
 * 打包后的资源根目录。
 * electron-builder 会把 extraResources 放进 <安装目录>/resources/，
 * 我们把 CKP 工作区额外拷成 resources/hub，所以打包后要优先看这里。
 */
function packagedResourcesRoot() {
  // process.resourcesPath 只在 Electron 运行时存在；纯 Node 下为 undefined
  const res = process.resourcesPath;
  if (!res) return '';
  const candidates = [path.join(res, 'hub'), path.join(res, 'app.asar.unpacked', 'hub'), res];
  for (const c of candidates) {
    if (looksLikeHub(c)) return c;
  }
  return '';
}

/**
 * 自动探测 CKP 工作区。
 *
 * 打包版和开发版的顺序不同，因为「随包分发的内核仓库」应该是打包版的第一选择：
 *
 *   打包版：显式配置 → 环境变量 → resources/hub（随包分发）→ 用户主目录 → 同级目录
 *   开发版：显式配置 → 环境变量 → 兄弟目录 kernel-hub → 上级目录 → 用户主目录
 *
 * 注意：这里**不能**出现任何开发机专有的绝对路径 —— 打包出去以后那些路径都不存在，
 * 反而会把探测带偏（曾经踩过：打包版误用了开发机的 kernel-hub）。
 */
function detectHubRoot(explicit = '') {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.KERNELHUB_ROOT) candidates.push(process.env.KERNELHUB_ROOT);
  if (process.env.CKP_ROOT) candidates.push(process.env.CKP_ROOT);

  const packaged = packagedResourcesRoot();

  if (packaged) {
    // 打包版：随包分发的内核仓库优先
    candidates.push(packaged);
    for (const name of DEFAULT_HUB_NAMES) candidates.push(path.join(os.homedir(), name));
    candidates.push(path.dirname(process.execPath));
  }

  // 开发版（以及打包版找不到内置仓库时的兜底）：相对位置
  for (const name of DEFAULT_HUB_NAMES) {
    candidates.push(path.join(REPO_DIR, name));
    candidates.push(path.join(APP_DIR, name));
    candidates.push(path.join(os.homedir(), name));
  }
  candidates.push(REPO_DIR);
  candidates.push(APP_DIR);
  candidates.push(path.dirname(REPO_DIR));
  if (packaged) candidates.push(packaged);

  for (const c of candidates) {
    if (!c) continue;
    let dir = path.resolve(c);
    if (looksLikeHub(dir)) return dir;
    // 允许多套一层
    const nested = DEFAULT_HUB_NAMES.map((n) => path.join(dir, n)).find(looksLikeHub);
    if (nested) return nested;
  }
  return explicit ? path.resolve(explicit) : path.join(REPO_DIR, 'kernel-hub');
}

/** 用户级状态目录（Electron 会传 app.getPath('userData') 进来） */
function resolveStateDir(explicit = '') {
  if (explicit) return explicit;
  if (process.env.KERNELHUB_STUDIO_HOME) return process.env.KERNELHUB_STUDIO_HOME;
  const home = os.homedir();
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(base, 'kernelhub-studio');
  }
  return path.join(home, '.config', 'kernelhub-studio');
}

/** 简单 glob（支持 * 与 ?，不跨目录分隔符），用于 x-cli.bundled 模板 */
function globSync(pattern) {
  const dir = path.dirname(pattern);
  const mask = path.basename(pattern);
  if (!isDir(dir)) return [];
  const re = new RegExp(
    '^' + mask.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^\\\\/]*').replace(/\?/g, '.') + '$',
    'i'
  );
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => re.test(n))
    .map((n) => path.join(dir, n))
    .filter(isFile)
    .sort();
}

module.exports = {
  APP_DIR,
  REPO_DIR,
  DEFAULT_HUB_NAMES,
  isDir,
  isFile,
  looksLikeHub,
  detectHubRoot,
  packagedResourcesRoot,
  resolveStateDir,
  globSync,
};
