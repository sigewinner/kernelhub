'use strict';
/**
 * 源码体检：编码完整性 + 语法 + 资源引用 + 工程约定。
 *
 *   node tools/audit.js
 *
 * 检查项：
 *   1. UTF-8 可解码、无 BOM、无 U+FFFD、无私用区字符（中文被 GBK 双重编码的痕迹）
 *   2. 逐文件 JS 语法（CJS 用 node --check，ESM 用 node --input-type=module --check）
 *   3. 渲染层不得出现网络引用（CDN / http(s) 脚本 / 字体）
 *   4. 渲染层不得使用 require/process/fs（必须走 window.khs）
 *   5. 关键工程文件存在性
 *
 * 这个脚本是「文件被错误编码」事故的防呆闸门：任何写入源码的工具都应该在提交前跑它。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const problems = [];
const stats = { files: 0, js: 0, css: 0, lines: 0, bytes: 0 };

const PUA = /[\uE000-\uF8FF]/;
const FFFD = /\uFFFD/;

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git' || name === '.smoke-out' || name === '.ui-out' || name.startsWith('.') || name.endsWith('.corrupt.bak')) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function checkTextFile(file) {
  const rel = path.relative(ROOT, file);
  const buf = fs.readFileSync(file);
  stats.files += 1;
  stats.bytes += buf.length;

  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    problems.push(`${rel}: 含 UTF-8 BOM（Windows 上容易被工具二次编码）`);
  }
  const text = buf.toString('utf8');
  if (text.includes('\uFFFD')) {
    const lines = text.split('\n');
    const hit = lines.findIndex((l) => l.includes('\uFFFD'));
    problems.push(`${rel}:${hit + 1} 含替换字符 U+FFFD（编码已损坏）`);
  }
  if (PUA.test(text)) {
    const lines = text.split('\n');
    const hit = lines.findIndex((l) => PUA.test(l));
    problems.push(`${rel}:${hit + 1} 含私用区字符（中文被 GBK 双重编码的典型痕迹）`);
  }
  if (file.endsWith('.js')) {
    stats.js += 1;
    stats.lines += text.split('\n').length;
  }
  if (file.endsWith('.css')) stats.css += 1;
  return text;
}

function checkSyntax(file) {
  const rel = path.relative(ROOT, file);
  const isEsm =
    file.includes(`${path.sep}renderer${path.sep}`) ||
    /^\s*(import|export)\s/m.test(fs.readFileSync(file, 'utf8'));
  const code = fs.readFileSync(file, 'utf8');
  const tmpDir = path.join(ROOT, '.audit-tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, path.basename(file));
  fs.writeFileSync(tmp, code, 'utf8');
  try {
    execFileSync(process.execPath, isEsm ? ['--input-type=module', '--check'] : ['--check', tmp], {
      stdio: ['pipe', 'pipe', 'pipe'],
      input: isEsm ? code : undefined,
      timeout: 30000,
    });
  } catch (err) {
    const msg = String(err.stderr || err.message).split('\n').slice(0, 3).join(' ');
    problems.push(`${rel}: 语法检查失败 → ${msg.slice(0, 200)}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function main() {
  const rendererDir = path.join(ROOT, 'src', 'renderer');
  const roots = [path.join(ROOT, 'src'), path.join(ROOT, 'tools'), path.join(ROOT, 'docs')].filter((d) => fs.existsSync(d));

  for (const root of roots) {
    for (const file of walk(root)) {
      if (!/\.(js|css|html|json|md)$/.test(file)) continue;
      const text = checkTextFile(file);
      if (file.endsWith('.js')) {
        checkSyntax(file);
        if (file.startsWith(rendererDir)) {
          if (/\brequire\s*\(/.test(text) && !file.includes(`${path.sep}devhost${path.sep}`)) {
            problems.push(`${path.relative(ROOT, file)}: 渲染层不允许 require()`);
          }
          if (/\bprocess\.(env|argv|platform|cwd)\b/.test(text)) {
            problems.push(`${path.relative(ROOT, file)}: 渲染层不允许直接访问 process`);
          }
          if (/https?:\/\/(?!www\.w3\.org)/.test(text)) {
            const line = text.split('\n').find((l) => /https?:\/\/(?!www\.w3\.org)/.test(l));
            problems.push(`${path.relative(ROOT, file)}: 出现外部 URL → ${String(line).trim().slice(0, 90)}`);
          }
        }
      }
    }
  }

  // 关键文件存在性
  const required = [
    'package.json',
    'README.md',
    'src/shared/protocol.js',
    'src/engine/registry.js',
    'src/engine/runner.js',
    'src/engine/hub.js',
    'src/engine/queue.js',
    'src/main/main.js',
    'src/main/preload.js',
    'src/renderer/index.html',
    'src/renderer/js/app.js',
    'src/renderer/js/controls.js',
    'src/renderer/styles/tokens.css',
    'docs/architecture.md',
    'docs/renderer-api.md',
    'docs/UI.md',
  ];
  for (const rel of required) {
    if (!fs.existsSync(path.join(ROOT, rel))) problems.push(`缺少关键文件: ${rel}`);
  }

  fs.rmSync(path.join(ROOT, '.audit-tmp'), { recursive: true, force: true });

  console.log(`[audit] 检查 ${stats.files} 个文本文件（JS ${stats.js} 个 / CSS ${stats.css} 个，共 ${stats.lines} 行 JS，${(stats.bytes / 1024).toFixed(0)} KB）`);
  if (problems.length) {
    console.log(`[audit] 发现 ${problems.length} 个问题：`);
    for (const p of problems) console.log(`  ✕ ${p}`);
    return 1;
  }
  console.log('[audit] 通过：编码完整、语法正确、渲染层无外部依赖、关键文件齐全');
  return 0;
}

process.exit(main());
