'use strict';
/**
 * 验证「安装插件 → 立刻能用」这条完整链路。
 *
 * 用户报的问题：装完插件还是用不了。这个工具把整条链路原样跑一遍：
 *   1. 从一个**干净的测试工作区**开始（不碰用户的真实工作区）
 *   2. 用 PluginStore 真的去 GitHub 下载并安装一个插件
 *   3. 重建 Registry（等价于应用里的 reloadRegistry）
 *   4. 检查该内核是不是 ready
 *   5. **真的用它转一个文件**（选的内核其依赖只存在于插件自己的 vendor 里，
 *      所以能成功就同时证明了「安装落盘正确」与「per-plugin vendor 生效」）
 *
 * 为什么会失败——常见嫌疑都在这条链上：落盘路径、哈希校验、
 * PYTHONPATH 注入时机、reloadRegistry 之后注册表是否重扫、内核选择。
 *
 * 用法:
 *   node tools/verify-plugin-install.js --app <打包目录> [--id pillow-image] [--work <目录>]
 *
 * 说明：需要联网（会从 GitHub 下载插件包）。默认测 pillow-image（约 13.3 MB），
 * 它是「依赖只在插件 vendor 里」的典型：需要 PIL + pillow_heif，
 * 而系统 Python 里通常并没有装。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const APP = arg('--app');
const PLUGIN_ID = arg('--id', 'pillow-image');
const MODE = arg('--mode', ''); // '' = 用设置里的 auto；可强制 git / http
const WORK = arg('--work', path.join(os.tmpdir(), 'khs-plugin-install-verify'));

if (!APP) {
  console.error('用法: node tools/verify-plugin-install.js --app <打包目录> [--id <插件id>] [--work <目录>]');
  process.exit(2);
}
const APP_DIR = path.resolve(APP);
const ASAR = path.join(APP_DIR, 'resources', 'app.asar');
if (!fs.existsSync(ASAR)) {
  console.error(`✗ 找不到 ${ASAR}`);
  process.exit(2);
}
const ELECTRON_SRC = path.join(ROOT, 'node_modules', 'electron', 'dist');
if (!fs.existsSync(path.join(ELECTRON_SRC, 'electron.exe'))) {
  console.error('✗ 找不到 node_modules/electron/dist，请先 npm install');
  process.exit(2);
}

const runtimeDir = path.join(WORK, 'electron');
const testDir = path.join(WORK, 'harness');
const testHub = path.join(WORK, 'hub');
const testState = path.join(WORK, 'state');

function copyDir(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

console.log('▸ 准备干净 Electron 运行时');
copyDir(ELECTRON_SRC, runtimeDir);

// 每次从空工作区开始，确保测的是「全新安装」而不是残留状态
for (const d of [testHub, testState]) fs.rmSync(d, { recursive: true, force: true });
fs.mkdirSync(path.join(testHub, 'plugins'), { recursive: true });
fs.mkdirSync(path.join(testHub, '.cache', 'runs'), { recursive: true });

fs.mkdirSync(testDir, { recursive: true });
fs.writeFileSync(
  path.join(testDir, 'package.json'),
  JSON.stringify({ name: 'khs-plugin-install-verify', version: '1.0.0', main: 'main.js' }, null, 2),
  'utf8'
);

fs.writeFileSync(
  path.join(testDir, 'main.js'),
  `'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const OUT = path.join(__dirname, 'result.json');
const ASAR = ${JSON.stringify(ASAR)};
const HUB = ${JSON.stringify(testHub)};
const STATE = ${JSON.stringify(testState)};
const SDK = ${JSON.stringify(path.join(APP_DIR, 'resources', 'sdk'))};
const PLUGIN_ID = ${JSON.stringify(PLUGIN_ID)};
const MODE = ${JSON.stringify(MODE)};

const report = { at: new Date().toISOString(), stages: [] };
const save = () => { try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8'); } catch {} };
const stage = (name, ok, detail) => {
  report.stages.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 800) });
  save();
};

app.whenReady().then(async () => {
  try {
    const { PluginStore } = require(path.join(ASAR, 'src', 'engine', 'pluginStore.js'));
    const { Registry } = require(path.join(ASAR, 'src', 'engine', 'registry.js'));
    const { Hub } = require(path.join(ASAR, 'src', 'engine', 'hub.js'));
    const { Settings } = require(path.join(ASAR, 'src', 'engine', 'config.js'));
    const fixtures = require(path.join(ASAR, 'src', 'shared', 'fixtures.js'));
    stage('从 app.asar 载入引擎模块', true, ASAR);

    const settings = new Settings(STATE);
    const store = new PluginStore({ hubRoot: HUB, stateDir: STATE, settings });

    // ---- 1) 拉目录 ----
    const cat = await store.loadCatalog({ force: true });
    stage('拉取插件目录 catalog.json', cat.ok, cat.ok ? '来源=' + cat.source + ' 插件数=' + cat.catalog.pluginCount : cat.error);
    if (!cat.ok) { report.ok = false; save(); app.exit(1); return; }

    const target = cat.catalog.plugins.find((p) => p.id === PLUGIN_ID);
    if (!target) { stage('目录中存在 ' + PLUGIN_ID, false, '目录里没有这个插件'); report.ok = false; save(); app.exit(1); return; }
    stage('目录中存在 ' + PLUGIN_ID, true, 'v' + target.version + ' 需要下载 ' + (target.size / 1048576).toFixed(2) + ' MB');

    // ---- 2) 安装（走默认策略，和界面点「安装」一致） ----
    /**
     * 装一个 50ms 心跳，量一量安装期间主进程有没有被占死。
     *
     * 这是「下载时应用未响应」的自动化判据：旧实现用 execFileSync 跑 git，
     * 稀疏克隆 pillow-image 要 21 秒，心跳会直接断 21 秒；
     * 全异步之后停顿应该只有几十到几百毫秒（文件哈希那一下是同步的）。
     */
    let ticks = 0;
    let maxGap = 0;
    let last = Date.now();
    const beat = setInterval(() => {
      const now = Date.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      ticks += 1;
    }, 50);

    const modes = [];
    const t0 = Date.now();
    const res = await store.install(PLUGIN_ID, {
      mode: MODE || undefined,
      onProgress: (e) => {
        const tag = e.phase + (e.percent ? ':' + e.percent + '%' : '');
        if (modes[modes.length - 1] !== tag) modes.push(tag);
      },
    });
    clearInterval(beat);
    const elapsedS = (Date.now() - t0) / 1000;

    stage('安装插件', res.ok, res.ok
      ? '方式=' + res.mode + (res.fallback ? '(回退)' : '') + ' ' + res.files + ' 文件 / ' + (res.bytes / 1048576).toFixed(2) + ' MB，耗时 ' + elapsedS.toFixed(1) + 's'
      : res.error);
    stage('安装期间主进程未被占死（事件循环最大停顿）', maxGap < 2000,
      '最大停顿 ' + maxGap + ' ms（' + ticks + ' 次心跳，安装共 ' + elapsedS.toFixed(1) + 's）');
    if (!res.ok) { report.ok = false; save(); app.exit(1); return; }

    // ---- 3) 落盘结构检查 ----
    const dir = path.join(HUB, 'plugins', PLUGIN_ID);
    const hasManifest = fs.existsSync(path.join(dir, 'kernel.json'));
    const hasAdapter = fs.existsSync(path.join(dir, 'adapter.py'));
    const hasVendor = fs.existsSync(path.join(dir, 'vendor'));
    stage('落盘结构完整', hasManifest && hasAdapter, 'kernel.json=' + hasManifest + ' adapter.py=' + hasAdapter + ' vendor=' + hasVendor);
    stage('插件自带 vendor', hasVendor, dir + '\\\\vendor');

    // ---- 4) 重建注册表（等价于应用的 reloadRegistry） ----
    const registry = new Registry({ hubRoot: HUB, sdkDir: SDK });
    registry.discover();
    const entry = registry.get(PLUGIN_ID);
    stage('重建注册表后能发现该内核', Boolean(entry), entry ? entry.status + ' / ' + entry.engineNote : '未发现（注册表里只有：' + registry.allEntries().map((e) => e.id).join(',') + '）');
    stage('该内核状态为可用', Boolean(entry && entry.usable), entry ? entry.status : '');
    const vendorInSysPath = registry.sysPath.some((p) => p.toLowerCase().includes(PLUGIN_ID.toLowerCase()));
    stage('它的 vendor 进了 PYTHONPATH', vendorInSysPath, registry.sysPath.join(' | '));

    // ---- 5) 真的用它转一个文件 ----
    const work = path.join(__dirname, 'work');
    fs.mkdirSync(work, { recursive: true });
    const png = path.join(work, 'in.png');
    fixtures.writePng(png, 96, 64);

    const settingsForHub = new Settings(STATE);
    const hub = new Hub(() => ({ registry, settings: settingsForHub, hub: null, queue: null }));
    const outDir = path.join(work, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const outcome = await hub.convert(
      { sources: [png], op: 'convert', targetFormat: 'webp', kernelId: PLUGIN_ID, outDir, overwrite: true },
      {}
    );
    const produced = Boolean(outcome.ok && outcome.outputs.length && outcome.outputs.every((o) => o.bytes > 0));
    stage('用刚装的内核完成真实转换（png → webp）', produced,
      produced
        ? '内核=' + outcome.kernel_id + ' 产出=' + outcome.outputs.map((o) => path.basename(o.path) + '(' + o.bytes + 'B)').join(',')
        : 'error=' + JSON.stringify(outcome.error) + ' stderr=' + String(outcome.stderr || '').slice(0, 300));

    // ---- 6) 卸载后应该消失 ----
    const un = store.uninstall(PLUGIN_ID);
    stage('卸载', un.ok, un.ok ? un.path : un.error);
    const registry2 = new Registry({ hubRoot: HUB, sdkDir: SDK });
    registry2.discover();
    stage('卸载后内核不再被发现', !registry2.get(PLUGIN_ID), '剩余：' + registry2.allEntries().map((e) => e.id).join(',') || '（空）');

    report.progress = modes;
    report.ok = report.stages.every((s) => s.ok);
  } catch (err) {
    stage('执行异常', false, String((err && err.stack) || err));
    report.ok = false;
  }
  save();
  app.exit(report.ok ? 0 : 1);
});
`,
  'utf8'
);

const resultPath = path.join(testDir, 'result.json');
fs.rmSync(resultPath, { force: true });

console.log(`▸ 在干净 Electron 里跑「安装 → 使用」全链路（插件 ${PLUGIN_ID}）`);
console.log(`  测试工作区 = ${testHub}`);
console.log('');

const res = spawnSync(path.join(runtimeDir, 'electron.exe'), [testDir], {
  stdio: 'inherit',
  env: { ...process.env },
  windowsHide: false,
});

let report = null;
try {
  report = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
} catch {
  /* ignore */
}

console.log('');
if (!report) {
  console.error(`✗ 没拿到结果（Electron 退出码 ${res.status}）`);
  process.exit(1);
}

let failed = 0;
for (const s of report.stages) {
  console.log(`  ${s.ok ? '✓' : '✗'} ${s.name}${s.detail ? '  — ' + s.detail : ''}`);
  if (!s.ok) failed += 1;
}
if (Array.isArray(report.progress) && report.progress.length) {
  console.log('');
  console.log(`  进度事件: ${report.progress.join(' → ')}`);
}
console.log('');
console.log(`  结论: ${report.stages.length - failed}/${report.stages.length} 项通过`);
process.exit(failed ? 1 : 0);
