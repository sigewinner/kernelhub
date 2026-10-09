'use strict';
/**
 * install-pymupdf.js —— 给用户装「不需要外部程序」的 PDF 内核（2.3.2 交付用）
 *
 * 背景：ghostscript-pdf 要求系统装 Ghostscript（非管理员装不了、装完还不在 PATH），
 * 用户机器上根本没装，于是 PDF 相关操作全部失败。pymupdf-pdf 只依赖 pip 包，
 * 而 pip 依赖我们本来就能一键装。
 *
 * 这个脚本走的就是应用内那两条路径：
 *   1. pluginStore.install(id)      —— 与应用「安装」按钮同一条路
 *   2. deps.installMissing(...)     —— 与「自动安装依赖」按钮同一条路（镜像失败自动回退官方源）
 *
 * 用法: node .gittools/install-pymupdf.js [插件id]
 */

const path = require('path');

const APP = 'D:\\AAA_develop\\01_program_pdf\\kernelhub-studio';
const { Settings } = require(path.join(APP, 'src', 'engine', 'config.js'));
const { resolveStateDir, detectHubRoot } = require(path.join(APP, 'src', 'engine', 'paths.js'));
const { PluginStore } = require(path.join(APP, 'src', 'engine', 'pluginStore.js'));
const { Registry } = require(path.join(APP, 'src', 'engine', 'registry.js'));
const { clearProbeCache } = require(path.join(APP, 'src', 'engine', 'python.js'));
const { probeMissing, installMissing } = require(path.join(APP, 'src', 'engine', 'deps.js'));

const PLUGIN = process.argv[2] || 'pymupdf-pdf';

(async () => {
  const stateDir = resolveStateDir();
  const settings = new Settings(stateDir);
  const hubRoot = settings.get('hubRoot', '') || detectHubRoot();
  const store = new PluginStore({ hubRoot, stateDir, settings });
  const registry = new Registry({
    hubRoot,
    extraPluginDirs: settings.get('extraPluginDirs', []),
    disabledKernels: settings.get('disabledKernels', []),
    priorityOverrides: settings.get('priorityOverrides', {}),
    exePaths: settings.get('exePaths', {}),
  });

  console.log(`  hubRoot = ${hubRoot}`);
  console.log(`  已装内核: ${registry.allEntries().map((e) => e.id).join(', ')}`);
  console.log('');

  // 目录（install 需要它来决定下载地址）
  let catalog = store.cachedCatalog();
  if (!catalog) {
    console.log('  本地没有目录缓存，先拉取…');
    catalog = await store.fetchCatalog();
  }
  const row = (catalog.plugins || []).find((p) => p.id === PLUGIN);
  if (!row) {
    console.error(`  ✗ 目录里没有 ${PLUGIN}`);
    process.exit(1);
  }
  console.log(`  目录里的 ${PLUGIN}: ${row.name}  依赖=[${(row.requires || []).join(',')}]  外部程序=[${(row.external || []).join(',')}]  体积=${(row.size / 1048576).toFixed(1)}MB`);
  console.log('');

  const already = registry.get(PLUGIN);
  if (already) {
    console.log('  · 已经装过，跳过下载');
  } else {
    console.log('  · 下载并安装插件（与应用里的「安装」按钮同一条路）…');
    const res = await store.install(PLUGIN, {
      onProgress: (info) => {
        const msg = (info && (info.message || info.phase)) || '';
        if (msg) console.log(`      ${msg}`);
      },
    });
    if (!res || res.ok === false) {
      console.error('  ✗ 安装失败: ' + JSON.stringify(res && res.error ? res.error : res));
      process.exit(1);
    }
    console.log('  ✓ 插件已安装');
  }

  // 依赖
  clearProbeCache();
  const vendorDir = require(path.join(APP, 'src', 'engine', 'paths.js')).pluginVendorDirOf(hubRoot, PLUGIN);
  const probe = probeMissing({ requires: row.requires || [], vendorDir });
  console.log(`  · 依赖探测: missing=[${probe.missing.join(',') || '（无）'}] packages=[${probe.packages.join(',') || '（无）'}]`);
  if (probe.missing.length) {
    console.log('  · 安装依赖（设置的镜像优先，失败自动回退官方源）…');
    const dep = await installMissing({
      python: probe.python,
      target: vendorDir,
      packages: probe.packages,
      preferredIndex: settings.get('pipIndexUrl', ''),
      onIndex: (i) => console.log(`      使用 ${i.label || i.index}`),
      onLine: () => {},
    });
    if (!dep.ok) {
      console.error(`  ✗ 依赖安装失败: reason=${dep.reason} ${String(dep.error).slice(0, 160)}`);
      process.exit(1);
    }
    console.log(`  ✓ 依赖已安装: ${(dep.installed || []).join(' ')}  来源 ${dep.indexUsed}`);
  } else {
    console.log('  ✓ 依赖已齐全');
  }

  clearProbeCache();
  const reg2 = new Registry({
    hubRoot,
    extraPluginDirs: settings.get('extraPluginDirs', []),
    disabledKernels: settings.get('disabledKernels', []),
    priorityOverrides: settings.get('priorityOverrides', {}),
    exePaths: settings.get('exePaths', {}),
  });
  const entry = reg2.get(PLUGIN);
  console.log('');
  console.log(`  最终状态: ${PLUGIN} → ${entry ? entry.status : '（找不到）'}  ${entry ? entry.engineNote || '' : ''}`);
  for (const e of reg2.allEntries()) {
    console.log(`      ${e.id.padEnd(18)} ${e.status}${e.status === 'ready' ? '' : '  ' + (e.engineNote || '').slice(0, 60)}`);
  }
})().catch((err) => {
  console.error('  失败: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
