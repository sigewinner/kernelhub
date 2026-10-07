'use strict';
/**
 * 运行器：把 Job 喂给内核，把 NDJSON 事件流收回来。
 *
 * CKP 协议在宿主侧的进程级契约（协议第 9 节）：
 *   1. 按 runtime.type 展开 argv，末尾追加 --ckp-job <path>
 *   2. 注入 CKP_* 环境变量与 PYTHONPATH / PYTHONUTF8
 *   3. 逐行读 stdout 解析 NDJSON（容忍非 JSON 行、容忍重复终态）
 *   4. 超时 → 杀进程树 → 合成 TIMEOUT；取消 → 合成 CANCELLED
 *   5. 无终态即退出 → 合成 PROTOCOL_NO_TERMINAL_EVENT
 *   6. 产物二次校验（存在、非空）
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const {
  CKP_VERSION,
  ERROR_CODES,
  TERMINAL_EVENTS,
  parseEventLine,
  CkpError,
  newJobId,
} = require('../shared/protocol');
const { isDir } = require('./paths');
const { buildPlan, collectGlobOutputs } = require('./cliBridge');
const { resolvePython } = require('./python');

const DEFAULT_TIMEOUT_MS = 600000;
const MAX_TIMEOUT_MS = 3600000;

/** 按 runtime.type 展开 argv */
function buildArgv(entry, jobPath, ctx = {}) {
  const { hubRoot = '' } = ctx;
  const runtime = entry.manifest.runtime;
  const extra = (runtime.args || []).map(String);
  const tail = ['--ckp-job', jobPath];

  switch (runtime.type) {
    case 'python': {
      const python = resolvePython(runtime.python || 'auto', hubRoot);
      return [python, entry.entryPath, ...extra, ...tail];
    }
    case 'builtin':
      return [
        resolvePython('auto', hubRoot),
        '-m',
        `kernelhub.builtins.${runtime.entry}`,
        ...extra,
        ...tail,
      ];
    case 'node':
      return [process.execPath, entry.entryPath, ...extra, ...tail];
    case 'powershell': {
      const exe = process.env.CKP_POWERSHELL || (process.platform === 'win32' ? 'powershell.exe' : 'pwsh');
      return [exe, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', entry.entryPath, ...extra, ...tail];
    }
    default:
      return [entry.entryPath, ...extra, ...tail];
  }
}

function buildEnv(entry, job, ctx = {}) {
  const { hubRoot = '', sysPath = [] } = ctx;
  const manifest = entry.manifest;
  const env = { ...process.env };

  const parts = [...sysPath];
  if (env.PYTHONPATH) parts.push(env.PYTHONPATH);
  env.PYTHONPATH = parts.filter(Boolean).join(path.delimiter);
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONUTF8 = '1';
  env.PYTHONDONTWRITEBYTECODE = '1';

  env.CKP = CKP_VERSION;
  env.CKP_KERNEL_ID = manifest.id;
  env.CKP_JOB_ID = String(job.job_id || '');
  env.CKP_PLUGIN_DIR = entry.directory;
  env.CKP_PROJECT_ROOT = hubRoot;
  /**
   * CKP_VENDOR 指向**这个插件自己的**依赖目录（2.0.0 起）。
   *
   * 老布局是整个工作区共用一个 <hubRoot>/vendor；2.0.0 把它拆到了
   * <plugin>/vendor，这样装 A 插件不会把 B 插件的 190 MB 一起拖下来。
   * 适配器若还按老路径找，这里保留 hubRoot/vendor 作为兼容回退。
   */
  const ownVendor = path.join(entry.directory, 'vendor');
  env.CKP_VENDOR = isDir(ownVendor) ? ownVendor : path.join(hubRoot, 'vendor');

  for (const [k, v] of Object.entries(manifest.runtime.env || {})) {
    env[String(k)] = String(v).replace(/\$(\w+)|\$\{(\w+)\}/g, (_m, a, b) => process.env[a || b] || '');
  }
  return env;
}

function workdirFor(entry) {
  const cwd = entry.manifest.runtime.cwd;
  if (cwd) return path.isAbsolute(cwd) ? cwd : path.join(entry.directory, cwd);
  return entry.directory;
}

function ensureDir(p) {
  if (p && !isDir(p)) {
    try {
      fs.mkdirSync(p, { recursive: true });
    } catch {
      /* ignore */
    }
  }
  return p;
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
        stdio: 'ignore',
        timeout: 15000,
        windowsHide: true,
      });
      return;
    } catch {
      /* 落到通用方案 */
    }
  }
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

function synthetic(code, message, detail = '') {
  return { code, message, detail, retryable: Boolean(ERROR_CODES[code]), synthetic: true };
}

/**
 * 执行一次内核调用。
 * hooks: { onEvent, onLog, onProgress }
 * @returns {Promise<object>} JobOutcome
 */
function runJob(entry, job, opts = {}) {
  const {
    hubRoot = '',
    sysPath = [],
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onEvent,
    onLog,
    onProgress,
    signal = null,
  } = opts;

  return new Promise((resolve) => {
    const started = Date.now();
    const jobId = String(job.job_id || '');
    const outcome = {
      ok: false,
      job_id: jobId,
      kernel_id: entry.id,
      kernel_name: entry.name,
      exit_code: 0,
      duration_ms: 0,
      outputs: [],
      artifacts: [],
      events: [],
      logs: [],
      error: null,
      stderr: '',
      command: [],
      job_path: '',
    };

    // ---- 执行计划 ----------------------------------------------------------#
    let plan;
    try {
      if (entry.manifest.xCli) {
        plan = buildPlan(entry, job, { hubRoot, sysPath });
      } else {
        plan = { argv: [], template: null, outputMode: 'exact', outputGlob: '' };
      }
    } catch (err) {
      outcome.error = err instanceof CkpError ? err.toEvent(jobId) : synthetic('INTERNAL', String(err.message || err));
      outcome.duration_ms = Date.now() - started;
      resolve(outcome);
      return;
    }

    // ---- Job 落盘 ----------------------------------------------------------#
    let jobPath = '';
    try {
      const runDir = path.join(hubRoot, '.cache', 'runs');
      ensureDir(runDir);
      jobPath = path.join(runDir, `job-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 7)}.json`);
      fs.writeFileSync(jobPath, JSON.stringify(job, null, 2), 'utf8');
    } catch (err) {
      outcome.error = synthetic('INTERNAL', `无法写入任务文件: ${err.message}`);
      outcome.duration_ms = Date.now() - started;
      resolve(outcome);
      return;
    }
    outcome.job_path = jobPath;

    let argv;
    try {
      // 协议第 9 节：无论内核是「自带适配器」还是「x-cli 配置即插件」，
      // 宿主启动的都是**适配器**（末尾追加 --ckp-job），引擎命令由适配器内部展开。
      // x-cli 模板的展开结果只用于 UI 的真实命令行预览，不直接执行。
      argv = buildArgv(entry, jobPath, { hubRoot });
    } catch (err) {
      outcome.error = err instanceof CkpError ? err.toEvent(jobId) : synthetic('INTERNAL', String(err.message || err));
      outcome.duration_ms = Date.now() - started;
      resolve(outcome);
      return;
    }
    outcome.command = argv;

    const env = buildEnv(entry, job, { hubRoot, sysPath });
    const cwd = workdirFor(entry);
    const limit = Math.max(1000, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));

    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: isDir(cwd) ? cwd : undefined,
        env,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      outcome.error =
        err.code === 'ENOENT'
          ? synthetic('DEPENDENCY_MISSING', `无法启动内核进程: ${err.message}`, String(err.message || ''))
          : synthetic('INTERNAL', `启动失败: ${err.message}`, String(err.message || ''));
      outcome.duration_ms = Date.now() - started;
      resolve(outcome);
      return;
    }

    let terminal = null;
    let cancelled = false;
    let timedOut = false;
    let rawBuffer = '';
    const errChunks = [];

    const emitEvent = (evt) => {
      outcome.events.push(evt);
      if (onEvent) {
        try {
          onEvent(evt);
        } catch {
          /* 宿主回调异常不影响任务 */
        }
      }
    };

    const handleLine = (line) => {
      const event = parseEventLine(line);
      if (!event) {
        const text = String(line).replace(/[\r\n]+$/, '');
        if (text.trim()) {
          outcome.logs.push({ level: 'debug', message: text });
          if (onLog) onLog(text, 'debug');
        }
        return;
      }
      const etype = String(event.type || '');
      if (!TERMINAL_EVENTS.includes(etype)) {
        if (etype === 'log') {
          const level = String(event.level || 'info');
          const message = String(event.message || '');
          outcome.logs.push({ level, message });
          if (onLog) onLog(message, level);
        } else if (etype === 'progress') {
          let value = event.value;
          if ((value === undefined || value === null) && event.total) {
            const cur = Number(event.current);
            const tot = Number(event.total);
            value = tot ? cur / tot : null;
          }
          if (onProgress) onProgress(Number(value) || 0, String(event.message || ''));
        } else if (etype === 'artifact') {
          outcome.artifacts.push({ ...event });
        }
        emitEvent(event);
        return;
      }
      if (terminal === null) {
        terminal = { ...event };
        emitEvent(event);
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      rawBuffer += chunk;
      let idx;
      while ((idx = rawBuffer.indexOf('\n')) >= 0) {
        const line = rawBuffer.slice(0, idx);
        rawBuffer = rawBuffer.slice(idx + 1);
        handleLine(line);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      errChunks.push(chunk);
      if (onLog && String(chunk).trim()) onLog(String(chunk).replace(/[\r\n]+$/, ''), 'debug');
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, limit);

    const onAbort = () => {
      cancelled = true;
      killTree(child);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (rawBuffer.trim()) handleLine(rawBuffer);
      outcome.exit_code = code === null || code === undefined ? -1 : code;
      outcome.stderr = errChunks.join('');
      outcome.duration_ms = Date.now() - started;

      if (cancelled) {
        outcome.error = synthetic('CANCELLED', '任务已被取消');
      } else if (timedOut) {
        outcome.error = synthetic('TIMEOUT', `任务超时（>${limit} ms）`, outcome.stderr.slice(-2000));
      } else if (terminal === null) {
        outcome.error = synthetic(
          'PROTOCOL_NO_TERMINAL_EVENT',
          `适配器退出（code=${outcome.exit_code}）但未返回终态事件`,
          outcome.stderr.slice(-2000)
        );
      } else if (String(terminal.type) === 'error') {
        outcome.error = {
          code: String(terminal.code || 'INTERNAL'),
          message: String(terminal.message || '内核报错'),
          detail: String(terminal.detail || '') || outcome.stderr.slice(-2000),
          retryable: terminal.retryable === undefined ? Boolean(ERROR_CODES[String(terminal.code)]) : Boolean(terminal.retryable),
        };
      } else {
        let outputs = Array.isArray(terminal.outputs) ? [...terminal.outputs] : [];

        // output_mode=glob：命令产出的是序列文件，由宿主收集
        if (plan.outputMode === 'glob' && entry.manifest.xCli) {
          const collected = collectGlobOutputs(plan, job).map((p) => ({
            path: p,
            format: (job.outputs[0] && job.outputs[0].format) || '',
          }));
          if (collected.length) outputs = collected;
        }
        // output_mode=stdout：桥接器已经把 stdout 写进 {output}
        if (!outputs.length && outcome.artifacts.length) {
          outputs = outcome.artifacts.map((a) => {
            const { type, ...rest } = a;
            return rest;
          });
        }

        const missing = outputs.filter((o) => !o || !o.path || statSize(String(o.path)) === undefined || statSize(String(o.path)) === 0);
        if (missing.length) {
          const names = missing.map((o) => (o && o.path) || '?').join(', ');
          outcome.error = synthetic('ARTIFACT_MISSING', `内核声称产出但文件不存在或为空: ${names}`, outcome.stderr.slice(-2000));
        } else if (!outputs.length && plan.outputMode !== 'stdout') {
          outcome.error = synthetic('ARTIFACT_MISSING', '内核未上报任何产物', outcome.stderr.slice(-2000));
        } else {
          outcome.ok = true;
          outcome.outputs = outputs.map((o) => ({
            ...o,
            bytes: o.bytes === undefined && o.path ? safeSize(String(o.path)) : o.bytes,
          }));
        }
      }

      if (!outcome.ok && terminal && String(terminal.type) === 'result' && outcome.error) {
        outcome.events.push(outcome.error);
      }
      resolve(outcome);
    };

    child.on('error', (err) => {
      clearTimeout(timer);
      outcome.error =
        err.code === 'ENOENT'
          ? synthetic('DEPENDENCY_MISSING', `无法启动内核进程: ${err.message}`, String(err.message || ''))
          : synthetic('INTERNAL', `进程异常: ${err.message}`, String(err.message || ''));
      outcome.duration_ms = Date.now() - started;
      resolve(outcome);
    });

    child.on('close', (code) => finish(code));
  });
}

function safeSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return undefined;
  }
}

/** 文件存在且可读时返回字节数，否则 undefined（避免二次 statSync 抛异常） */
function statSize(p) {
  return safeSize(p);
}

module.exports = {
  runJob,
  buildArgv,
  buildEnv,
  workdirFor,
  killTree,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  newJobId,
};
