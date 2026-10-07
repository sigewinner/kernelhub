'use strict';
/**
 * 可执行文件解析 —— CKP `x-cli.executables` 的 Node 侧实现。
 *
 * 与 kernel-hub/kernelhub/executables.py 行为一致，保证
 * 「ckp-executable 探测通过」== 「{exe:名字} 真的能展开成可执行路径」。
 * 解析顺序：env(CKP_EXE_*) → python(模块:函数) → bundled(项目内 glob)
 *          → absolute(绝对路径) → path(系统 PATH)
 */

const fs = require('fs');
const path = require('path');

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
 * @returns {{path: string, source: string, attempts: string[]}}
 * @throws {CkpError} DEPENDENCY_MISSING
 */
function resolveExecutable(name, spec, ctx = {}) {
  const { hubRoot = '', sysPath = [] } = ctx;
  const attempts = [];

  if (!spec) {
    const found = findOnPath([name]);
    if (found) return { path: found, source: `PATH: ${found}`, attempts };
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
        const base = path.isAbsolute(pattern) ? pattern : path.join(hubRoot, pattern);
        const hits = globSync(base);
        if (hits.length) {
          const rel = path.relative(hubRoot, hits[0]).replace(/\\/g, '/');
          return { path: hits[0], source: `项目内 ${rel}`, attempts };
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
      attempts.push(`PATH 中未找到 ${candidates.join('、')}`);
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

module.exports = { resolveExecutable, describeSpec, envVarFor, DEFAULT_PREFER };
