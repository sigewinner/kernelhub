'use strict';
/**
 * 在 Electron 里验证「打包后的引擎能不能真的转一个文件」。
 *
 * 为什么需要这个工具，而不是用应用的 --selftest：
 *   应用自检里跑转换会让主进程以 V8 fatal「Invoke in DisallowJavascriptExecutionScope」
 *   崩掉（1.0.0 与 2.0.0 同样，已确认不是 2.0.0 引入的）。所以自检默认跳过转换这一步
 *   （见 src/main/main.js 的说明），转换改用本工具验证。
 *
 * 本工具的做法：拿一个**干净的** Electron 运行时（node_modules/electron/dist），
 * 加载打包产物里的 app.asar 引擎，直接跑一次真实转换。所有阶段逐段落盘，
 * 即使中途崩溃也能看出走到哪一步。
 *
 * 用法:
 *   node tools/verify-engine-in-electron.js --app <打包目录> [--work <工作目录>]
 *
 * 典型流程（打包版必须放在普通目录才能跑起来，工作区是低完整性目录）：
 *   node tools/build.js --dir
 *   xcopy /E /I release\win-unpacked %TEMP%\khs-verify\win-unpacked
 *   node tools/verify-engine-in-electron.js --app %TEMP%\khs-verify\win-unpacked
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
const WORK = arg('--work', path.join(os.tmpdir(), 'khs-engine-verify'));

if (!APP) {
  console.error('用法: node tools/verify-engine-in-electron.js --app <打包目录> [--work <工作目录>]');
  process.exit(2);
}
const APP_DIR = path.resolve(APP);
const ASAR = path.join(APP_DIR, 'resources', 'app.asar');
if (!fs.existsSync(ASAR)) {
  console.error(`✗ 找不到 ${ASAR}（--app 应指向 win-unpacked 这样的解包目录）`);
  process.exit(2);
}

const ELECTRON_SRC = path.join(ROOT, 'node_modules', 'electron', 'dist');
if (!fs.existsSync(path.join(ELECTRON_SRC, 'electron.exe'))) {
  console.error('✗ 找不到 node_modules/electron/dist，请先 npm install');
  process.exit(2);
}

/* -------- 1) 准备一个干净 Electron + 测试 app -------- */

const runtimeDir = path.join(WORK, 'electron');
const testDir = path.join(WORK, 'harness');

function copyDir(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

console.log('▸ 准备干净 Electron 运行时（工作区是低完整性目录，必须拷到普通目录才能启动）');
console.log(`  ${ELECTRON_SRC} → ${runtimeDir}`);
copyDir(ELECTRON_SRC, runtimeDir);

fs.mkdirSync(testDir, { recursive: true });
fs.writeFileSync(
  path.join(testDir, 'package.json'),
  JSON.stringify({ name: 'khs-engine-verify', version: '1.0.0', main: 'main.js' }, null, 2),
  'utf8'
);

/**
 * 测试 app 跑在干净的 Electron 里，因此可以放心加载被验证产物的 app.asar。
 * 注意完全不做任何 BrowserWindow 操作 —— 保持变量最少。
 */
fs.writeFileSync(
  path.join(testDir, 'main.js'),
  `'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const OUT = path.join(__dirname, 'result.json');
const ASAR = ${JSON.stringify(ASAR)};
const HUB = process.env.KHS_HUB;
const SDK = process.env.KHS_SDK;

const report = { at: new Date().toISOString(), stages: [] };
const save = () => { try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8'); } catch {} };
const stage = (name, ok, detail) => {
  report.stages.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 700) });
  save();
};

app.whenReady().then(async () => {
  try {
    const { Registry } = require(path.join(ASAR, 'src', 'engine', 'registry.js'));
    const { Hub } = require(path.join(ASAR, 'src', 'engine', 'hub.js'));
    const { Settings } = require(path.join(ASAR, 'src', 'engine', 'config.js'));
    const fixtures = require(path.join(ASAR, 'src', 'shared', 'fixtures.js'));
    stage('从 app.asar 载入引擎模块', true, ASAR);

    const registry = new Registry({ hubRoot: HUB, sdkDir: SDK });
    registry.discover();
    stage('注册表发现内核', registry.entries.size > 0,
      registry.entries.size + ' 个；可用 ' + registry.readyEntries().length + ' 个；sysPath ' + registry.sysPath.length + ' 条');
    stage('适配器 SDK 来自打包产物', fs.existsSync(path.join(SDK, 'kernelhub', 'sdk.py')), SDK);

    const work = path.join(__dirname, 'work');
    fs.mkdirSync(work, { recursive: true });
    const png = path.join(work, 'probe.png');
    fixtures.writePng(png, 96, 64);
    stage('生成测试素材 PNG', fs.existsSync(png), png + ' ' + fs.statSync(png).size + ' B');

    const settings = new Settings(path.join(__dirname, 'state'));
    const hub = new Hub(() => ({ registry, settings, hub: null, queue: null }));
    const outcome = await hub.convert(
      { sources: [png], op: 'convert', targetFormat: 'bmp', outDir: work, overwrite: true },
      {}
    );
    const produced = Boolean(outcome.ok && outcome.outputs.length && outcome.outputs.every((o) => o.bytes > 0));
    stage('真实转换 PNG → BMP', produced,
      produced
        ? '内核=' + outcome.kernel_id + ' 产出=' + outcome.outputs.map((o) => path.basename(o.path) + '(' + o.bytes + 'B)').join(',')
        : 'error=' + JSON.stringify(outcome.error) + ' stderr=' + String(outcome.stderr || '').slice(0, 200));

    // 再验证一个「依赖只在插件自己 vendor 里」的内核，证明 per-plugin vendor 生效
    const withVendor = registry.readyEntries().filter((e) => e.manifest.runtime.requires.length > 0);
    if (withVendor.length) {
      const e = withVendor[0];
      const out2 = path.join(work, 'vendor-check');
      fs.mkdirSync(out2, { recursive: true });
      const o2 = await hub.convert(
        { sources: [png], op: 'convert', targetFormat: 'bmp', kernelId: e.id, outDir: out2, overwrite: true },
        {}
      );
      stage('带 vendor 的内核可执行（' + e.id + '）', Boolean(o2.ok),
        o2.ok ? '产出 ' + o2.outputs.map((x) => x.bytes + 'B').join(',') : JSON.stringify(o2.error));
    } else {
      stage('带 vendor 的内核可执行', true, '当前工作区没有带 Python 依赖的内核，跳过');
    }

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

/* -------- 2) 运行 -------- */

const hubRoot = path.join(os.homedir(), 'AppData', 'Roaming', 'kernelhub-studio', 'hub');
const sdkDir = path.join(APP_DIR, 'resources', 'sdk');
const resultPath = path.join(testDir, 'result.json');
fs.rmSync(resultPath, { force: true });

console.log('▸ 在干净 Electron 里加载 app.asar 引擎并跑真实转换');
console.log(`  hubRoot = ${hubRoot}`);
console.log(`  sdkDir  = ${sdkDir}`);
console.log('');

const res = spawnSync(path.join(runtimeDir, 'electron.exe'), [testDir], {
  stdio: 'inherit',
  env: { ...process.env, KHS_HUB: hubRoot, KHS_SDK: sdkDir },
  windowsHide: false,
});

let report = null;
try {
  report = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
} catch {
  /* 崩溃时可能没写出来 */
}

console.log('');
if (!report) {
  console.error(`✗ 没有拿到结果文件（Electron 退出码 ${res.status}）—— 进程可能在写完结果前就崩了`);
  process.exit(1);
}

let failed = 0;
for (const s of report.stages) {
  console.log(`  ${s.ok ? '✓' : '✗'} ${s.name}${s.detail ? '  — ' + s.detail : ''}`);
  if (!s.ok) failed += 1;
}
console.log('');
console.log(`  结论: ${report.stages.length - failed}/${report.stages.length} 项通过（Electron 退出码 ${res.status}）`);
process.exit(failed || report.ok === false ? 1 : 0);
