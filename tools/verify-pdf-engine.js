'use strict';
/**
 * verify-pdf-engine.js —— 真实跑一次 PDF 转换，证明「不需要 Ghostscript」也能用（2.3.2）
 *
 * 为什么要有它：用户报「找不到可执行文件 'gs'」。结论是改用 pymupdf-pdf
 * （只依赖 pip 包），但只有**真的把 PDF 转出图**才算数 —— 这里走引擎同一条路：
 *   Registry.discover() → Hub.convert()
 *
 * 用法: node .gittools/verify-pdf-engine.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const APP = 'D:\\AAA_develop\\01_program_pdf\\kernelhub-studio';
const { Settings } = require(path.join(APP, 'src', 'engine', 'config.js'));
const { resolveStateDir, detectHubRoot, pluginVendorDirOf } = require(path.join(APP, 'src', 'engine', 'paths.js'));
const { Registry } = require(path.join(APP, 'src', 'engine', 'registry.js'));
const { Hub } = require(path.join(APP, 'src', 'engine', 'hub.js'));
const { resolvePython } = require(path.join(APP, 'src', 'engine', 'python.js'));

const OUT = 'C:\\Users\\nahida\\khs-pdf-test';
const PY = resolvePython();

function makePdf(file, sysPath) {
  // 用 pymupdf（pymupdf-pdf 的依赖，已装进它的 vendor）生成一个真 PDF。
  // 搜索路径直接用注册表算出来的那套 —— 与应用跑适配器时完全一致，
  // 免得自己拼路径拼错（第一次就因为拼错报 ModuleNotFoundError）。
  const code = `
import pymupdf
d = pymupdf.open()
p = d.new_page()
p.insert_text((72, 100), "KernelHub Studio PDF probe", fontsize=20)
d.save(r"${file}")
d.close()
print("pdf written")
`;
  const res = spawnSync(PY, ['-c', code], {
    env: { ...process.env, PYTHONPATH: (sysPath || []).join(path.delimiter), PYTHONUTF8: '1' },
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error('生成测试 PDF 失败: ' + String(res.stderr || '').slice(0, 300));
  return file;
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const stateDir = resolveStateDir();
  const settings = new Settings(stateDir);
  const hubRoot = settings.get('hubRoot', '') || detectHubRoot();

  const registry = new Registry({
    hubRoot,
    extraPluginDirs: settings.get('extraPluginDirs', []),
    disabledKernels: settings.get('disabledKernels', []),
    priorityOverrides: settings.get('priorityOverrides', {}),
    exePaths: settings.get('exePaths', {}),
  });
  registry.discover();

  console.log('  内核状态：');
  for (const e of registry.allEntries()) {
    console.log(`      ${e.id.padEnd(18)} ${e.status.padEnd(12)} ${(e.engineNote || '').slice(0, 70)}`);
  }
  console.log('');

  const pdf = makePdf(path.join(OUT, 'probe.pdf'), registry.sysPath);
  console.log(`  测试 PDF: ${pdf}  ${fs.statSync(pdf).size} 字节`);

  const hub = new Hub(() => ({ registry, settings, hubRoot }));
  const rawTargets = hub.targets(pdf, 'render');
  // hub.targets 的返回可能是数组，也可能是 { targets: [...] } —— 两种都兼容
  const targets = Array.isArray(rawTargets) ? rawTargets : (rawTargets && rawTargets.targets) || [];
  console.log(`  该 PDF 可转目标: ${targets.slice(0, 8).join(', ')}${targets.length > 8 ? ' …' : ''}`);
  if (!targets.includes('png')) throw new Error('目标里没有 png ✗');
  console.log('');

  console.log('  · 执行渲染 pdf → png（PDF 转图片用的是 render 操作）…');
  const t0 = Date.now();
  const res = await hub.convert({
    op: 'render',
    sources: [pdf],
    targetFormat: 'png',
    outPath: path.join(OUT, 'probe.png'),
    params: {},
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`    用时 ${dt}s  ok=${res.ok}  内核=${res.kernel_id}`);
  if (res.error) console.log(`    错误: ${JSON.stringify(res.error).slice(0, 200)}`);
  const made = (res.outputs || []).filter((o) => o && o.path && fs.existsSync(o.path));
  for (const o of made) console.log(`    产出: ${o.path}  ${fs.statSync(o.path).size} 字节`);
  if (!res.ok || !made.length) {
    console.log('\n  结论: FAIL —— PDF 转换没跑通');
    process.exit(1);
  }
  console.log('\n  结论: OK —— 不装 Ghostscript 也能把 PDF 转成图片');
})().catch((err) => {
  console.error('  失败: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
