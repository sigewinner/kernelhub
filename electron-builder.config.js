/**
 * electron-builder 打包配置（2.0.0：壳 + 按需插件）。
 *
 *   npm run build          → 打 Windows 安装版（NSIS）+ 免安装便携版
 *   npm run build:dir      → 只生成解包目录（不含安装器）
 *   npm run build:portable → 只生成单文件便携版
 *   npm run build:withhub  → 额外把整个内核仓库打进包（老式一体化分发，体积大）
 *
 * 2.0.0 的关键变化：**默认不再把内核仓库打进包**。
 *
 *   1.x 会把 kernel-hub 整个 vendor/（约 194 MB，其中 83 MB 是 ffmpeg）
 *   塞进安装包，用户为了转一张 PNG 也得先下 140 MB。2.0.0 改成：
 *     - 壳只带「协议运行时 + 4 个不需要外部程序的种子插件」（共约 1.6 MB）
 *     - 其余插件由用户在「插件」页按需下载到 %APPDATA%\kernelhub-studio\hub\plugins
 *
 *   随包分发的三份资源：
 *     resources/sdk/          CKP 适配器 SDK（kernelhub 这个 Python 包）——
 *                             每个 adapter.py 都要 import 它，属于协议而非插件
 *     resources/protocol/     PROTOCOL.md 与 JSON Schema
 *     resources/seed-plugins/ 种子插件，首次启动复制进用户工作区
 *
 *   应用代码（src/）进 asar；上面三份都**不能**进 asar —— Python 与外部程序
 *   必须以真实文件存在。
 */

const fs = require('fs');
const path = require('path');

const APP_DIR = __dirname;
const REPO_DIR = path.resolve(APP_DIR, '..');
const HUB_SRC = process.env.KERNELHUB_SRC || path.join(REPO_DIR, 'kernel-hub');
const HUB_PRESENT = fs.existsSync(path.join(HUB_SRC, 'plugins'));

/**
 * 是否把整个内核仓库打进包。
 * 2.0.0 默认 **不打**；只有显式 KERNELHUB_BUNDLE=1 且仓库存在时才带。
 * （1.x 的默认是「有就带上」，这里反过来了，因为一体包正是要解决的问题。）
 */
const BUNDLE_HUB = process.env.KERNELHUB_BUNDLE === '1' && HUB_PRESENT;

const extraResources = [];

// 1) 适配器 SDK：所有插件共用，跟着壳走
extraResources.push({
  from: path.join(APP_DIR, 'sdk'),
  to: 'sdk',
  filter: ['**/*', '!**/__pycache__/**', '!**/*.pyc'],
});

// 2) 协议文档与 Schema
extraResources.push({
  from: path.join(APP_DIR, 'protocol'),
  to: 'protocol',
  filter: ['**/*'],
});

// 3) 种子插件：首次启动复制进用户工作区，保证装完就能用
extraResources.push({
  from: path.join(APP_DIR, 'seed-plugins'),
  to: 'seed-plugins',
  filter: ['**/*', '!**/__pycache__/**', '!**/*.pyc', '!**/vendor/**/__pycache__/**'],
});

// 4) 可选：整个内核仓库（老式一体化分发）
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
  // eslint-disable-next-line no-console
  console.warn(`[electron-builder] 一体化模式：把整个内核仓库（${HUB_SRC}）打进了包。`);
} else {
  // eslint-disable-next-line no-console
  console.warn(
    '[electron-builder] 2.0.0 壳模式：不打包内核仓库，只带 SDK + 协议 + 4 个种子插件。\n' +
      '                   其余插件由用户在「插件」页按需下载。'
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
      /**
       * 2.2.7：安装包不再由 NSIS 产出。
       *
       * 安装界面改成**自绘**的：installer/Setup.cs（WinForms + GDI+ 画圆角窗口、
       * 品牌色大按钮、进度条与淡入动画），由 tools/build-installer.js 用 Windows
       * 自带的 csc.exe 编译成单个 exe，payload 用 7z 嵌进资源。
       * 这样才做得出「无系统标题栏 + 圆角 + 大按钮」的现代界面 —— 官方 NSIS 只能
       * 换图与文案（MUI2 没有颜色/皮肤 define，工具链里也没有皮肤引擎）。
       *
       * 所以这里只留便携版目标；安装包在 electron-builder 跑完后由
       * tools/build.js 调 tools/build-installer.js 生成。
       * 原来的 nsis 配置（perMachine / include / installerHeader.bmp 等）一并移除，
       * 相关历史与实验结论见 git 记录与 installer/ 目录里的注释。
       */
      { target: 'portable', arch: ['x64'] },
    ],
    icon: ICON,
    signExecutable: false,
    artifactName: '${productName}-${version}-${arch}-${target}.${ext}',
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
