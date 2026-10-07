'use strict';
/**
 * 控制台探针：不启动 Electron，直接用 Node 跑通「发现内核 → 探测 → 选核 → 转换」。
 *
 *   node tools/probe.js                 # 只列出内核与状态
 *   node tools/probe.js --convert       # 生成示例素材并真跑一次转换
 *   node tools/probe.js --kernel xxx    # 只看某个内核
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { Settings } = require('../src/engine/config');
const { detectHubRoot, resolveStateDir } = require('../src/engine/paths');
const { Registry } = require('../src/engine/registry');
const { Hub } = require('../src/engine/hub');
const { JobQueue } = require('../src/engine/queue');
const catalog = require('../src/engine/catalog');
const { makeFixtures } = require('./fixtures');

function main() {
  const argv = process.argv.slice(2);
  const wantConvert = argv.includes('--convert');
  const kernelFilter = (() => {
    const i = argv.indexOf('--kernel');
    return i >= 0 ? argv[i + 1] : '';
  })();

  const stateDir = resolveStateDir();
  const settings = new Settings(stateDir);
  const hubRoot = detectHubRoot(settings.get('hubRoot', ''));
  console.log(`[probe] 状态目录   ${stateDir}`);
  console.log(`[probe] CKP 工作区 ${hubRoot}`);

  const registry = new Registry({
    hubRoot,
    extraPluginDirs: settings.get('extraPluginDirs', []),
    disabledKernels: settings.get('disabledKernels', []),
    priorityOverrides: settings.get('priorityOverrides', {}),
  });

  const t0 = Date.now();
  registry.discover();
  const layout = registry.layout();
  console.log(`[probe] Python     ${layout.python} (${layout.pythonVersion || '未知版本'})`);
  console.log(`[probe] 搜索路径   ${layout.searchPaths.join(' | ')}`);
  console.log(`[probe] 扫描耗时   ${Date.now() - t0} ms`);

  const summary = registry.summary();
  console.log(`[probe] 内核总数   ${summary.total}，可用 ${summary.ready}`);
  console.log(`[probe] 可用操作   ${summary.ops.join(', ') || '（无）'}`);
  for (const err of summary.errors) console.log(`[probe] ! ${err}`);

  for (const entry of registry.allEntries()) {
    if (kernelFilter && entry.id !== kernelFilter) continue;
    const view = catalog.kernelView(entry);
    console.log(
      `  ${icon(entry.status)} ${entry.id.padEnd(22)} ${view.statusLabel.padEnd(6)} ` +
        `能力=${String(view.capabilityCount).padStart(5)} 参数=${String(view.paramCount).padStart(3)} ` +
        `in=${String(view.inputFormats.length).padStart(3)} out=${String(view.outputFormats.length).padStart(3)}  ${entry.engineNote || entry.detail}`
    );
  }

  if (!wantConvert) return 0;

  const hub = new Hub(() => ({ registry, settings }));
  const queue = new JobQueue(hub);
  queue.setParallel(2);
  queue.on('update', (job) => {
    const pct = Math.round((job.progress || 0) * 100);
    process.stdout.write(`\r[queue] ${job.state.padEnd(9)} ${String(pct).padStart(3)}% ${job.sourceName.padEnd(28)}`);
  });

  const fixtureDir = path.join(stateDir, 'fixtures');
  const files = makeFixtures(fixtureDir);
  console.log(`\n[probe] 示例素材 ${files.length} 个 → ${fixtureDir}`);
  files.forEach((f) => console.log(`         ${path.basename(f)}`));

  const outDir = path.join(stateDir, 'probe-out');
  fs.mkdirSync(outDir, { recursive: true });

  const cases = [
    { file: files.find((f) => f.endsWith('.png')), target: 'bmp', op: 'convert' },
    { file: files.find((f) => f.endsWith('.png')), target: 'webp', op: 'convert' },
    { file: files.find((f) => f.endsWith('.csv')), target: 'json', op: 'convert' },
    { file: files.find((f) => f.endsWith('.csv')), target: 'markdown', op: 'convert' },
    { file: files.find((f) => f.endsWith('.svg')), target: 'png', op: 'convert' },
  ];

  const jobs = [];
  for (const c of cases) {
    if (!c.file) continue;
    jobs.push(...queue.enqueue({ sources: [c.file], op: c.op, targetFormat: c.target, outDir }));
  }

  return new Promise((resolve) => {
    queue.on('idle', () => {
      process.stdout.write('\n');
      let ok = 0;
      let fail = 0;
      for (const job of jobs) {
        if (job.state === 'done') {
          ok += 1;
          console.log(
            `  ✓ ${job.sourceName} → ${job.outputName}  内核=${job.kernelUsed}  ${job.size}  ${job.durationMs}ms`
          );
        } else {
          fail += 1;
          console.log(`  ✕ ${job.sourceName} → ${job.targetFormat}  [${job.error && job.error.code}] ${job.progressMessage}`);
          if (job.error && job.error.detail) {
            console.log(`      ${String(job.error.detail).split('\n').slice(-3).join('\n      ')}`);
          }
        }
      }
      console.log(`[probe] 转换完成：成功 ${ok}，失败 ${fail}`);
      resolve(fail ? 1 : 0);
    });
  });
}

function icon(status) {
  return { ready: '●', degraded: '◐', unavailable: '○', invalid: '✕', disabled: '⛔' }[status] || '·';
}

Promise.resolve(main())
  .then((code) => process.exit(Number(code) || 0))
  .catch((err) => {
    console.error('[probe] 失败:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
