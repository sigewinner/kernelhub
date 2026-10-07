/**
 * electron-builder 打包配置。
 *
 *   npm run build          → 打 Windows 安装版（NSIS）+ 免安装便携版
 *   npm run build:dir      → 只生成解包目录（不含安装器）
 *   npm run build:portable → 只生成单文件便携版
 *   npm run build:fast     → 不打包内核仓库（体积小，但只认 settings 里指定的 hubRoot）
 *
 * 关键约定：
 *   1. 应用代码（src/）进 asar —— 它是纯 Node/前端代码，不需要被外部程序读。
 *   2. CKP 工作区（kernel-hub）**不能**进 asar：内核适配器是 Python/命令行程序，
 *      需要以真实文件存在，所以用 extraResources 拷到 <安装目录>/resources/hub。
 *      运行时 src/engine/paths.js 会优先在 resources/hub 找内核仓库。
 *   3. 不打包 kernel-hub 的 .cache / output / tests / __pycache__ / *.pyc。
 */

const fs = require('fs');
const path = require('path');

const APP_DIR = __dirname;
const REPO_DIR = path.resolve(APP_DIR, '..');
const HUB_SRC = process.env.KERNELHUB_SRC || path.join(REPO_DIR, 'kernel-hub');
const HUB_PRESENT = fs.existsSync(path.join(HUB_SRC, 'plugins'));

/** 决定是否随包分发内核仓库：有就带上，可用 KERNELHUB_BUNDLE=0 关掉 */
const BUNDLE_HUB = process.env.KERNELHUB_BUNDLE === '0' ? false : HUB_PRESENT;

const extraResources = [];
if (BUNDLE_HUB) {
  extraResources.push({
    from: HUB_SRC,
    to: 'hub',
    filter: [
      '**/*',
      '!**/__pycache__/**',
      '!**/*.pyc',
      '!.cache/**',
      '!output/**',
      '!tests/**',
      '!.git/**',
      '!**/.venv/**',
      '!**/venv/**',
    ],
  });
}

/** extraResources 里的路径在打包后是 resources/hub，这里的提示文案跟着变 */
if (!BUNDLE_HUB) {
  // eslint-disable-next-line no-console
  console.warn(
    `[electron-builder] 未随包分发内核仓库（${HUB_SRC} 不存在）。\n` +
      '                   安装后请在「设置 → 路径」里指定 CKP 工作区目录。'
  );
}

const ICON = path.join(APP_DIR, 'build', 'icon.ico');

module.exports = {
  appId: 'dev.kernelhub.studio',
  productName: 'KernelHub Studio',
  copyright: 'Copyright © 2026 KernelHub',
  // asar 里的应用代码
  files: [
    'src/**/*',
    'package.json',
    '!src/renderer/devhost/**', // 浏览器开发宿主：只在开发时用，不进包
    '!**/*.map',
  ],
  extraResources,
  directories: {
    output: 'release',
    buildResources: 'build',
  },
  asar: true,
  electronVersion: require('./node_modules/electron/package.json').version,
  // Windows 上不签名：没有证书时也能构建成功，但保留图标与版本信息写入
  // （注意不要用 signAndEditExecutable: false —— 那会连图标和元数据一起跳过）
  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
    icon: ICON,
    signExecutable: false,
    artifactName: '${productName}-${version}-${arch}-${target}.${ext}',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'KernelHub Studio',
    deleteAppDataOnUninstall: false,
    artifactName: '${productName}-${version}-setup.${ext}',
  },
  portable: {
    artifactName: '${productName}-${version}-portable.${ext}',
  },
  mac: {
    category: 'public.app-category.productivity',
    target: [{ target: 'dmg', arch: ['x64', 'arm64'] }],
  },
  linux: {
    category: 'Utility',
    target: ['AppImage', 'deb'],
  },
  // 让 electron-builder 从本地缓存/镜像取 Electron 二进制（避免每次都从 GitHub 拉 200MB）
  electronDownload: {
    cache: process.env.ELECTRON_CACHE || path.join(APP_DIR, '.electron-cache'),
    mirror: process.env.ELECTRON_MIRROR || 'https://github.com/electron/electron/releases/download/',
    isVerifyChecksum: false,
  },
};
