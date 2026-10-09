'use strict';
/**
 * 可执行文件解析 —— CKP `x-cli.executables` 的 Node 侧实现。
 *
 * 与 kernel-hub/kernelhub/executables.py 行为一致，保证
 * 「ckp-executable 探测通过」== 「{exe:名字} 真的能展开成可执行路径」。
 * 解析顺序：settings(应用内指定的路径) → env(CKP_EXE_*) → python(模块:函数)
 *          → bundled(项目内 glob) → absolute(绝对路径) → path(系统 PATH)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { CkpError } = require('../shared/protocol');
const { globSync } = require('./paths');
const { resolvePython, runPython, findOnPath } = require('./python');

const DEFAULT_PREFER = ['env', 'python', 'bundled', 'absolute', 'path'];

function envVarFor(name) {
  return 'CKP_EXE_' + String(name).toUpperCase().replace(/[-.]/g, '_');
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 常见安装位置 —— 有些工具装完**不会**把自己加进 PATH。
 *
 * 实测：Ghostscript 的 Windows 安装包默认把程序放到
 * `C:\Program Files\gs\gs10.xx.x\bin\gswin64c.exe`，PATH 里什么都没有；
 * 环境变量也只在勾选「Add to PATH」时才设置。于是「明明装了却报找不到」
 * 就成了最常见的求助。这里补上注册表与几个常见目录的探测。
 */
function findInKnownLocations(candidates) {
  const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const progFiles86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localApp = process.env.LOCALAPPDATA || '';

  const names = candidates.map((c) => String(c).trim()).filter(Boolean);
  const bare = names.map((n) => n.replace(/\.exe$/i, ''));
  const isGs = bare.some((n) => /^(gswin64c|gswin32c|gs)$/i.test(n));

  /** 只列一层子目录（globSync 只在 basename 里支持通配符，中间目录的 * 它不管） */
  const subdirs = (dir) => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(dir, d.name))
        .sort()
        .reverse(); // 版本目录名倒序 → 先用新版本
    } catch {
      return [];
    }
  };

  if (isGs) {
    const gsNames = bare.filter((x) => /^(gswin64c|gswin32c|gs)$/i.test(x));
    const roots = [path.join(progFiles, 'gs'), path.join(progFiles86, 'gs')];
    if (localApp) roots.push(path.join(localApp, 'Programs', 'gs'));

    for (const root of roots) {
      // 1) <root>\<版本>\bin\<名字>.exe（安装包默认布局）
      for (const ver of subdirs(root)) {
        for (const n of gsNames) {
          for (const cand of [path.join(ver, 'bin', `${n}.exe`), path.join(ver, `${n}.exe`)]) {
            if (isFile(cand)) return { path: cand, source: `常见安装目录 ${cand}` };
          }
        }
      }
      // 2) <root>\<名字>.exe（手工解压/绿色版常见）
      for (const n of gsNames) {
        const cand = path.join(root, `${n}.exe`);
        if (isFile(cand)) return { path: cand, source: `常见安装目录 ${cand}` };
      }
    }

    // 3) 注册表：GS_DLL 指向 bin 目录里的 DLL，同目录就有 gswin64c.exe
    for (const regRoot of ['HKLM\\SOFTWARE\\GPL Ghostscript', 'HKLM\\SOFTWARE\\WOW6432Node\\GPL Ghostscript']) {
      try {
        const res = spawnSync('reg.exe', ['query', regRoot, '/s'], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
        const text = String((res && res.stdout) || '');
        const m = text.match(/GS_DLL\s+REG_SZ\s+(.+)/i);
        if (!m) continue;
        const dir = path.dirname(m[1].trim());
        for (const n of gsNames) {
          const cand = path.join(dir, `${n}.exe`);
          if (isFile(cand)) return { path: cand, source: `注册表 ${regRoot}` };
        }
      } catch {
        /* 注册表读不到就跳过 */
      }
    }
  }
  return null;
}

/**
 * @returns {{path: string, source: string, attempts: string[]}}
 * @throws {CkpError} DEPENDENCY_MISSING
 */
function resolveExecutable(name, spec, ctx = {}) {
  const { hubRoot = '', sysPath = [], pluginDir = '', exePaths = {} } = ctx;
  const attempts = [];

  /*
   * 0) 应用内指定的路径（设置 → exePaths）。
   * 用户在界面上「选择可执行文件…」选过一次之后就永远优先用它 ——
   * 这是对「明明装了却找不到」最直接的解法，也方便绿色版/自定义安装位置。
   */
  const chosen = String((exePaths && exePaths[name]) || '').trim();
  if (chosen) {
    if (isFile(chosen)) return { path: chosen, source: `设置中指定 ${chosen}`, attempts };
    attempts.push(`设置中指定的路径不存在：${chosen}`);
  }

  if (!spec) {
    const found = findOnPath([name]) || findInKnownLocations([name]);
    if (found) {
      const p = typeof found === 'string' ? found : found.path;
      const src = typeof found === 'string' ? `PATH: ${p}` : found.source;
      return { path: p, source: src, attempts };
    }
    if (path.isAbsolute(name) && isFile(name)) {
      return { path: name, source: `绝对路径: ${name}`, attempts };
    }
    throw new CkpError('DEPENDENCY_MISSING', `未找到可执行文件 '${name}'`, attempts.join('；'));
  }

  const specObj = typeof spec === 'string' ? { candidates: [spec] } : spec;
  if (!specObj || typeof specObj !== 'object') {
    throw new CkpError('BAD_JOB', `executables.${name} 必须是对象或字符串`);
  }

  const prefer = Array.isArray(specObj.prefer) && specObj.prefer.length ? specObj.prefer : DEFAULT_PREFER;

  for (const source of prefer) {
    if (source === 'env') {
      const key = envVarFor(name);
      const value = String(process.env[key] || '').trim();
      if (value) {
        if (isFile(value)) return { path: value, source: `环境变量 ${key}`, attempts };
        attempts.push(`环境变量 ${key}=${value}（文件不存在）`);
      } else {
        attempts.push(`环境变量 ${key}（未设置）`);
      }
    } else if (source === 'python') {
      const target = String(specObj.python || '');
      if (!target) continue;
      const idx = target.indexOf(':');
      if (idx < 0) {
        attempts.push(`python:${target}（缺少 '模块:函数' 形式）`);
        continue;
      }
      const moduleName = target.slice(0, idx);
      const funcName = target.slice(idx + 1);
      const python = resolvePython('auto', hubRoot);
      const code =
        'import sys,json;' +
        `import ${moduleName} as _m;` +
        `print(json.dumps(str(getattr(_m, ${JSON.stringify(funcName)})() or "")))`;
      const res = runPython(code, { python, sysPath });
      if (res.ok) {
        let p = res.stdout;
        try {
          p = JSON.parse(res.stdout);
        } catch {
          /* 保持原样 */
        }
        if (p && isFile(p)) return { path: p, source: `Python ${target}`, attempts };
        attempts.push(`python:${target} -> ${p || '空路径'}`);
      } else {
        attempts.push(`python:${target}（${res.error.split('\n')[0]}）`);
      }
    } else if (source === 'bundled') {
      for (const pattern of specObj.bundled || []) {
        /**
         * bundled 模板是相对路径。2.0.0 起插件自带依赖（per-plugin vendor），
         * 所以先相对**插件目录**找，再回退到工作区根 —— 这样
         * `vendor/imageio_ffmpeg/binaries/ffmpeg-*.exe` 在插件内就能命中，
         * 而插件清单本身不需要为 2.0.0 改写。
         */
        const bases = [];
        if (pluginDir) bases.push(pluginDir);
        if (hubRoot && path.resolve(hubRoot) !== path.resolve(pluginDir || '.')) bases.push(hubRoot);
        for (const b of bases) {
          const target = path.isAbsolute(pattern) ? pattern : path.join(b, pattern);
          const hits = globSync(target);
          if (hits.length) {
            const rel = path.relative(b, hits[0]).replace(/\\/g, '/');
            return { path: hits[0], source: `插件内 ${rel}`, attempts };
          }
        }
        attempts.push(`bundled:${pattern}`);
      }
    } else if (source === 'absolute') {
      for (const cand of specObj.absolute || []) {
        if (isFile(cand)) return { path: cand, source: `绝对路径 ${cand}`, attempts };
        attempts.push(`absolute:${cand}`);
      }
    } else if (source === 'path') {
      const candidates = (specObj.candidates || [name]).map(String);
      const found = findOnPath(candidates);
      if (found) return { path: found, source: `PATH: ${found}`, attempts };
      // PATH 里没有就翻常见安装位置（装上但没加进 PATH 是最常见的情形）
      const known = findInKnownLocations(candidates);
      if (known) return { path: known.path, source: known.source, attempts };
      attempts.push(`PATH 与常见安装目录中均未找到 ${candidates.join('、')}`);
    }
  }

  throw new CkpError(
    'DEPENDENCY_MISSING',
    `找不到可执行文件 '${name}'`,
    attempts.length ? '已尝试 → ' + attempts.join('；') : '未配置 executables'
  );
}

/** 给 UI 用的一句话说明：这个内核靠什么找到引擎 */
function describeSpec(spec, name = 'NAME') {
  if (!spec) return '系统 PATH';
  if (typeof spec === 'string') return `PATH: ${spec}`;
  const parts = [];
  if (spec.candidates) parts.push('PATH: ' + spec.candidates.join('/'));
  if (spec.python) parts.push(`Python: ${spec.python}`);
  if (spec.bundled) parts.push('项目内: ' + spec.bundled.join(', '));
  if (spec.absolute) parts.push('绝对路径: ' + spec.absolute.join(', '));
  return (parts.join('；') || '未配置') + `（可用 ${envVarFor(name)} 覆盖）`;
}

module.exports = { resolveExecutable, describeSpec, envVarFor, DEFAULT_PREFER, findInKnownLocations };
