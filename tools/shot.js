'use strict';
/**
 * 在 Electron 里跑一次界面截图（需要 Electron GUI 能启动）。
 *
 *   npm run shot            # 截 8 个视图到 docs/screenshots/
 *   npm run shot -- --out C:\tmp\shots
 *
 * 沙箱/无桌面环境下 Electron 的 GUI 进程可能无法启动；那种情况请改用
 *   node tools/uiverify.js --shots-only
 * （系统 Chrome + 真实引擎的开发宿主，渲染的是同一套界面代码）
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ARGV = process.argv.slice(2);
const outArg = ARGV.indexOf('--out');
const OUT = outArg >= 0 && ARGV[outArg + 1] ? path.resolve(ARGV[outArg + 1]) : path.join(ROOT, 'docs', 'screenshots');

const VIEWS = [
  ['01-welcome', '#/welcome'],
  ['02-convert', '#/convert'],
  ['03-batch', '#/batch'],
  ['04-kernels', '#/kernels'],
  ['05-formats', '#/formats'],
  ['06-protocol', '#/protocol'],
  ['07-settings', '#/settings'],
  ['08-logs', '#/logs'],
];

// 复用主进程的中枢与 IPC：截图里的数据与真实运行完全一致
const { bootstrap } = require(path.join(ROOT, 'src', 'main', 'main.js'));

app.whenReady().then(async () => {
  bootstrap();
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    width: 1500,
    height: 960,
    show: false,
    backgroundColor: '#070a12',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 4000));

  for (const [name, hash] of VIEWS) {
    await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}; true;`);
    await new Promise((r) => setTimeout(r, 1500));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    console.log(`[shot] ${name} → ${path.join(OUT, `${name}.png`)}`);
  }
  console.log(`[shot] 完成，共 ${VIEWS.length} 张 → ${OUT}`);
  app.exit(0);
});
