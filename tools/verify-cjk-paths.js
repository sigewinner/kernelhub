'use strict';
/**
 * verify-cjk-paths.js —— 中文（非 ASCII）路径支持验证（2.2.1）
 *
 * 背景：用户反馈「不支持中文路径」。这个工具用真实引擎在**纯中文目录 / 文件名**
 * 下跑完整转换链路，把失败点暴露出来，而不是靠猜：
 *   1. 目录名含中文、文件名含中文（还带空格）
 *   2. Hub.targets / preview / convert 全链路
 *   3. 产物确实落在中文输出目录里，且内容非空
 *   4. 额外覆盖：中文路径 + 空格 + 全角字符
 *
 * 用法: node tools/verify-cjk-paths.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { Settings } = require('../src/engine/config');
const { detectHubRoot, resolveStateDir } = require('../src/engine/paths');
const { Registry } = require('../src/engine/registry');
const { Hub } = require('../src/engine/hub');
const { makeFixtures } = require('./fixtures');

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: Boolean(pass), detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
}

async function main() {
  // 与 verify-engine-in-electron.js 一致：直接用**用户工作区**（壳模式下内核都在那里）
  const hubRoot = path.join(os.homedir(), 'AppData', 'Roaming', 'kernelhub-studio', 'hub');
  const settings = new Settings(resolveStateDir());
  settings.load();

  const registry = new Registry({
    hubRoot,
    sdkDir: path.join(__dirname, '..', 'sdk'),
    extraPythonPaths: settings.get('extraPythonPaths', []),
    extraPluginDirs: settings.get('extraPluginDirs', []),
    disabledKernels: settings.get('disabledKernels', []),
    priorityOverrides: settings.get('priorityOverrides', {}),
  });
  registry.discover();

  const hub = new Hub(() => ({ registry, settings }));
  const ready = registry.allEntries().filter((e) => e.status === 'ready');
  console.log(`▸ 内核 ${ready.length}/${registry.allEntries().length} 可用\n`);
  if (!ready.length) {
    console.log('  没有可用内核，无法验证');
    process.exit(1);
  }

  // 全中文目录 + 中文文件名（含空格）
  const base = path.join(os.tmpdir(), '中文路径测试', '输出 目录');
  const srcDir = path.join(os.tmpdir(), '中文路径测试', '源 文件');
  fs.rmSync(path.join(os.tmpdir(), '中文路径测试'), { recursive: true, force: true });
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(base, { recursive: true });

  const made = makeFixtures(srcDir, { hubRoot, python: registry.python });
  const png = made.find((f) => f.toLowerCase().endsWith('.png'));
  check('在中文目录下生成测试素材', Boolean(png) && fs.existsSync(png), png || '生成失败');
  if (!png) return finish();

  // 改成带空格的中文文件名，进一步加压
  const cjkSource = path.join(srcDir, '源图 带空格.png');
  fs.copyFileSync(png, cjkSource);
  check('中文 + 空格文件名可读', fs.existsSync(cjkSource), cjkSource);

  // 1) 目标格式列举
  let targets = [];
  try {
    // hub.targets 返回的是 { targets: [...], ... }，不是裸数组
    const out = hub.targets(cjkSource, 'convert');
    targets = (out && out.targets) || [];
  } catch (err) {
    check('hub.targets 处理中文路径', false, String(err.message || err));
  }
  check('hub.targets 处理中文路径', targets.length > 0, `${targets.length} 个目标格式`);

  // 2) 预览（只规划，不执行）
  const target = targets.includes('bmp') ? 'bmp' : targets[0];
  let preview = null;
  try {
    preview = hub.preview({ sources: [cjkSource], op: 'convert', targetFormat: target, outDir: base });
  } catch (err) {
    check('hub.preview 处理中文路径', false, String(err.message || err));
  }
  check(
    'hub.preview 处理中文路径',
    Boolean(preview && preview.ok !== false),
    preview ? `内核=${(preview.kernel && (preview.kernel.name || preview.kernel.id)) || '?'} argv=${(preview.argv || []).length} 段` : '无预览结果'
  );

  // 3) 真实转换
  const before = new Set(fs.existsSync(base) ? fs.readdirSync(base) : []);
  let result = null;
  try {
    result = await hub.convert({ sources: [cjkSource], op: 'convert', targetFormat: target, outDir: base });
  } catch (err) {
    check('真实转换（中文输入 → 中文输出目录）', false, String(err.message || err));
  }
  const okConvert = Boolean(result && (result.ok === true || (result.outputs || []).length));
  check(
    '真实转换（中文输入 → 中文输出目录）',
    okConvert,
    result
      ? `ok=${result.ok} 产出=${(result.outputs || []).length} 个${result.error ? ` 错误=${result.error}` : ''}`
      : '没有返回结果'
  );

  // 4) 产物落盘且非空
  const after = fs.existsSync(base) ? fs.readdirSync(base) : [];
  const created = after.filter((f) => !before.has(f));
  const sizes = created.map((f) => ({ f, n: fs.statSync(path.join(base, f)).size }));
  check(
    '产物落在中文输出目录且非空',
    created.length > 0 && sizes.every((s) => s.n > 0),
    sizes.map((s) => `${s.f}=${s.n}B`).join(' ') || '没有新文件'
  );
  if (created.length) {
    check('产物文件名保留中文原名', created.some((f) => /源图/.test(f)), created.join(' / '));
  }

  // 5) 中文路径 + 全角括号（扩展名仍是 ASCII，避免把「没有扩展名」误判成编码问题）
  const full = path.join(srcDir, '全角（）测试.png');
  fs.copyFileSync(cjkSource, full);
  const r2 = await hub.convert({ sources: [full], op: 'convert', targetFormat: target, outDir: base });
  check(
    '全角括号路径同样可用',
    Boolean(r2 && (r2.ok === true || (r2.outputs || []).length)),
    r2 ? `产出=${(r2.outputs || []).length}${r2.error ? ` 错误=${fmtErr(r2.error)}` : ''}` : '无结果'
  );

  // 6) 文本类内核：中文路径 + 中文内容（走 Python 读写文件，最容易踩编码）
  const md = path.join(srcDir, '中文 文档.md');
  fs.writeFileSync(md, '# 中文标题\n\n这是正文，包含中文字符。\n', 'utf8');
  const r3 = await hub.convert({ sources: [md], op: 'convert', targetFormat: 'html', outDir: base });
  check(
    '文本内核（md → html）处理中文路径与中文内容',
    Boolean(r3 && (r3.ok === true || (r3.outputs || []).length)),
    r3 ? `产出=${(r3.outputs || []).length}${r3.error ? ` 错误=${fmtErr(r3.error)}` : ''}` : '无结果'
  );
  if (r3 && (r3.outputs || []).length) {
    const first = r3.outputs[0];
    const p = typeof first === 'string' ? first : first && (first.path || first.file);
    if (p) {
      const html = fs.readFileSync(p, 'utf8');
      check('产物里的中文内容没有乱码', html.includes('中文标题'), `${html.length} 字符 ${path.basename(p)}`);
    }
  }

  // 7) 外部命令行内核：argv 里带中文路径（ffmpeg 这类最容易踩）
  const ffEntry = ready.find((e) => e.id === 'ffmpeg-media');
  if (!ffEntry) {
    console.log('  – 跳过外部命令行内核用例（未安装 ffmpeg-media）');
  } else {
    const probe = ready.find((e) => e.id === 'ffmpeg-media');
    void probe;
    const srcPng = path.join(srcDir, '中文 源图.png');
    fs.copyFileSync(cjkSource, srcPng);
    const r4 = await hub.convert({ sources: [srcPng], op: 'convert', targetFormat: 'jpg', outDir: base });
    check(
      '外部命令行内核（ffmpeg）处理中文路径',
      Boolean(r4 && (r4.ok === true || (r4.outputs || []).length)),
      r4 ? `内核=${r4.kernelUsed || '?'} 产出=${(r4.outputs || []).length}${r4.error ? ` 错误=${fmtErr(r4.error)}` : ''}` : '无结果'
    );
  }

  return finish();
}

/** 把错误对象打成可读文本（hub 有时返回对象而不是字符串） */
function fmtErr(err) {
  if (!err) return '（空）';
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function finish() {
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n结论: ${passed}/${results.length} 项通过`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('失败:', err && err.stack ? err.stack : err);
  process.exit(1);
});
