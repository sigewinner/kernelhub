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
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
    icon: ICON,
    signExecutable: false,
    artifactName: '${productName}-${version}-${arch}-${target}.${ext}',
  },
  nsis: {
    oneClick: false,
    /**
     * 2.2.5：让安装向导**只留「选定安装位置」一个参数**。
     *
     * 模板的 assisted 流程里，「安装选项（为所有用户 / 仅为我）」这一页是
     * `!ifndef INSTALL_MODE_PER_ALL_USERS` 时才插入的（见 assistedInstaller.nsh）。
     * 也就是说：perMachine: true 这一页自然就没了。
     *
     * 我也试过用 nsis.script 换掉整个脚本以保留 per-user（那样不弹 UAC），
     * 但 electron-builder 3.x 的自定义脚本分支没能把卸载器文件传给 makensis
     * （`-DUNINSTALLER_OUT_FILE` 传的是空值，构建必然失败）——即使用与模板
     * **逐字节相同**的脚本也一样失败，所以这条路是死的。实测结论记在这里，
     * 免得后人再试一遍。
     *
     * 代价（已知并接受）：装到 Program Files、需要管理员权限；
     * 应用内「下载并静默安装」更新时会弹一次 UAC，但流程仍然无向导。
     */
    perMachine: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'KernelHub Studio',
    deleteAppDataOnUninstall: false,
    artifactName: '${productName}-${version}-setup.${ext}',
    /**
     * 自定义 include（preamble 阶段生效）：去掉完成页的「运行应用」复选框、
     * 改完成页文案。文件名刻意不叫 installer.nsh —— 模板的 installSection.nsh
     * 会 `!include installer.nsh`（指模板自己的），同名会把它顶掉导致构建失败。
     */
    include: 'build/khs-installer.nsh',
    /**
     * 界面用图：NSIS 只吃 BMP，文件名是 electron-builder 约定，
     * 由 `node .gittools/make-nsis-overrides.js` 生成（白底 + 1px 黑线 + 一个红方块）。
     * installerHeader.bmp 150×57 出现在内页右上，installerSidebar.bmp 164×314
     * 出现在完成页左侧。
     */
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
