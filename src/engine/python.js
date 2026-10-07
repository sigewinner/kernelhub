'use strict';
/**
 * Python 运行时解析 + 依赖探测缓存。
 *
 * 内核的适配器（adapter.py）与 x-cli 的「Python 模块函数」解析源都依赖一个
 * 可用的解释器；探测器会产生较多短命进程，所以结果全部缓存。
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CANDIDATES = process.platform === 'win32'
  ? ['python.exe', 'python3.exe', 'py.exe', 'python', 'python3']
  : ['python3', 'python'];

const cache = {
  python: undefined,
  imports: new Map(),
  commands: new Map(),
};

function findOnPath(names) {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const variants = path.extname(name) ? [name] : exts.map((e) => name + e.toLowerCase()).concat(name);
      for (const v of variants) {
        const full = path.join(dir, v);
        try {
          if (fs.statSync(full).isFile()) return full;
        } catch {
          /* 继续 */
        }
      }
    }
  }
  return '';
}

/** 解析 Python 解释器；`preferred` 来自内核清单 runtime.python（'auto' 表示自动） */
function resolvePython(preferred = 'auto', hubRoot = '') {
  if (preferred && preferred !== 'auto' && preferred !== 'vendor') {
    if (fs.existsSync(preferred)) return preferred;
    const which = findOnPath([preferred]);
    if (which) return which;
  }
  if (cache.python) return cache.python;

  // 1) 项目 vendor 内可能带的嵌入式解释器
  for (const rel of ['vendor/python/python.exe', 'python/python.exe']) {
    const p = path.join(hubRoot, rel);
    if (hubRoot && fs.existsSync(p)) {
      cache.python = p;
      return p;
    }
  }
  // 2) PATH
  const found = findOnPath(CANDIDATES);
  if (found) {
    cache.python = found;
    return found;
  }
  cache.python = process.platform === 'win32' ? 'python.exe' : 'python3';
  return cache.python;
}

function pythonVersion(exe) {
  try {
    const out = execFileSync(exe, ['-c', 'import sys;print(sys.version.split()[0])'], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    return String(out).trim();
  } catch {
    return '';
  }
}

/**
 * 用子进程探测 Python 模块是否可导入（替代 importlib.util.find_spec）。
 * `sysPath` 会以 PYTHONPATH 形式注入，保证 vendor 目录可见。
 */
function pythonHasModule(moduleName, { python, sysPath = [] } = {}) {
  const key = `${python}|${sysPath.join(';')}|${moduleName}`;
  if (cache.imports.has(key)) return cache.imports.get(key);
  const code =
    'import importlib.util,sys;' +
    `s=importlib.util.find_spec(${JSON.stringify(moduleName)});` +
    'sys.exit(0 if s else 3)';
  let ok = false;
  try {
    execFileSync(python, ['-c', code], {
      timeout: 20000,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, PYTHONPATH: sysPath.filter(Boolean).join(path.delimiter) },
    });
    ok = true;
  } catch {
    ok = false;
  }
  cache.imports.set(key, ok);
  return ok;
}

/** 运行一段 Python 代码并返回 { ok, stdout, error }（用于 python 模块函数解析） */
function runPython(code, { python, sysPath = [], timeout = 30000 } = {}) {
  try {
    const out = execFileSync(python, ['-c', code], {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      env: { ...process.env, PYTHONPATH: sysPath.filter(Boolean).join(path.delimiter), PYTHONUTF8: '1' },
    });
    return { ok: true, stdout: String(out).trim(), error: '' };
  } catch (err) {
    return { ok: false, stdout: String(err.stdout || '').trim(), error: String(err.message || err) };
  }
}

function clearProbeCache() {
  cache.python = undefined;
  cache.imports.clear();
  cache.commands.clear();
}

module.exports = {
  resolvePython,
  pythonVersion,
  pythonHasModule,
  runPython,
  findOnPath,
  clearProbeCache,
};
