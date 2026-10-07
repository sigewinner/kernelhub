'use strict';
/**
 * 任务中枢（Hub）：把「用户想转一个文件」翻译成「选内核 → 建 Job → 跑 → 校验」。
 * 上层（IPC / UI）只需要认识这一个类。
 */

const fs = require('fs');
const path = require('path');

const {
  CKP_VERSION,
  CkpError,
  NoKernelError,
  canonicalFormat,
  formatOfPath,
  inputRef,
  outputRef,
  buildJob,
  newJobId,
  mergeParams,
} = require('../shared/protocol');
const { buildPlan } = require('./cliBridge');
const { runJob, buildArgv, DEFAULT_TIMEOUT_MS } = require('./runner');

const EXT_OVERRIDE = {}; // 某些格式不希望写成同名扩展名时在这里覆盖

function extensionFor(fmt) {
  const f = canonicalFormat(fmt);
  return EXT_OVERRIDE[f] || f || 'bin';
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function ensureDir(p) {
  if (p) {
    try {
      fs.mkdirSync(p, { recursive: true });
    } catch {
      /* ignore */
    }
  }
  return p;
}

/** 推导输出路径，自动避免覆盖（加 -1、-2 后缀） */
function defaultOutputPath(src, targetFormat, outDir = '', taken = []) {
  const fmt = canonicalFormat(targetFormat);
  const ext = extensionFor(fmt);
  const base = path.basename(src, path.extname(src)) || 'output';
  const directory = outDir || path.dirname(path.resolve(src));
  ensureDir(directory);

  const takenSet = new Set(taken.map((p) => path.resolve(p).toLowerCase()));
  let candidate = path.join(directory, `${base}.${ext}`);
  let i = 1;
  const exists = (p) => takenSet.has(path.resolve(p).toLowerCase()) || fs.existsSync(p);
  while (exists(candidate)) {
    candidate = path.join(directory, `${base}-${i}.${ext}`);
    i += 1;
    if (i > 9999) break;
  }
  return candidate;
}

class Hub {
  constructor(getContext) {
    // getContext(): { registry, settings }
    this.getContext = getContext;
  }

  get registry() {
    return this.getContext().registry;
  }

  get settings() {
    return this.getContext().settings;
  }

  get hubRoot() {
    return this.registry.hubRoot;
  }

  /* -- 计划 ------------------------------------------------------------- */

  /** 输入文件能转成什么（结合当前队列的源格式） */
  targets(srcPath, op = 'convert', kernelId = '') {
    const fmt = formatOfPath(srcPath);
    const registry = this.registry;
    let targets = registry.targetsFor(op, fmt);
    if (!targets.length) targets = registry.outputFormats(op);
    if (kernelId) {
      const entry = registry.get(kernelId);
      if (entry) {
        const limited = new Set();
        for (const cap of entry.manifest.capabilities) {
          if (cap.op !== op) continue;
          if (fmt && !cap.acceptsInput(fmt)) continue;
          cap.to.forEach((f) => f !== '*' && limited.add(f));
        }
        if (limited.size) targets = Array.from(limited).sort();
      }
    }
    return { sourceFormat: fmt, targets };
  }

  /** 选内核 + 算输出路径（不改动任何文件） */
  plan(req) {
    const registry = this.registry;
    if (!req.sources || !req.sources.length) throw new CkpError('BAD_JOB', '至少需要一个输入文件');
    const missing = req.sources.filter((s) => !isFile(s));
    if (missing.length) throw new CkpError('INPUT_NOT_FOUND', `输入文件不存在: ${missing.join(', ')}`);

    const srcFmt = formatOfPath(req.sources[0]);
    const dstFmt = canonicalFormat(req.targetFormat);
    const multiIn = req.sources.length > 1;

    const { entry, cap } = registry.resolve(req.op || 'convert', srcFmt, dstFmt, {
      kernelId: req.kernelId || '',
      multiIn,
      multiOut: multiIn && Boolean(req.outDir),
    });

    let outputs;
    if (req.outPath) {
      outputs = [req.outPath];
    } else {
      const taken = [];
      outputs = req.sources.map((s) => {
        const p = defaultOutputPath(s, dstFmt, req.outDir || (req.sameDir ? path.dirname(s) : ''), taken);
        taken.push(p);
        return p;
      });
    }
    outputs.forEach((o) => ensureDir(path.dirname(o)));

    const specs = mergeParams(entry.manifest.params, cap.params || []);
    return { entry, cap, outputs, srcFmt, dstFmt, paramSpecs: specs };
  }

  /** 真实命令行预览（不执行）：适配器 argv + x-cli 展开后的引擎命令 */
  preview(req) {
    try {
      const { entry, outputs } = this.plan(req);
      const srcFmt = formatOfPath(req.sources[0]);
      const job = buildJob(
        req.op || 'convert',
        req.sources.map((s) => inputRef(s)),
        outputs.map((o) => outputRef(o, req.targetFormat)),
        req.params || {},
        { kernel: entry.id, workdir: path.dirname(outputs[0] || '.') }
      );
      let engineArgv = null;
      if (entry.manifest.xCli) {
        engineArgv = buildPlan(entry, job, { hubRoot: this.hubRoot, sysPath: this.registry.sysPath }).argv;
      }
      const adapterArgv = buildArgv(entry, '<job.json>', { hubRoot: this.hubRoot });
      return {
        ok: true,
        kernel: { id: entry.id, name: entry.name, engineNote: entry.engineNote, xCli: Boolean(entry.manifest.xCli) },
        outputs,
        sourceFormat: srcFmt,
        adapterArgv,
        argv: engineArgv,
        note: engineArgv
          ? '适配器读取任务后展开为下面这条引擎命令（{exe:…} 已解析为真实路径）'
          : '该内核自带适配器，引擎调用由适配器内部构造；上面是宿主启动适配器的命令。',
        job,
      };
    } catch (err) {
      return {
        ok: false,
        code: err.code || 'INTERNAL',
        message: err.message || String(err),
        detail: err.detail || '',
      };
    }
  }

  /** 执行一次（可 await） */
  async convert(req, hooks = {}) {
    let planned;
    try {
      planned = this.plan(req);
    } catch (err) {
      return {
        ok: false,
        job_id: '',
        kernel_id: req.kernelId || '',
        kernel_name: '',
        duration_ms: 0,
        outputs: [],
        artifacts: [],
        events: [],
        logs: [],
        exit_code: -1,
        error: err instanceof CkpError ? err.toEvent('') : { code: 'INTERNAL', message: String(err.message || err), detail: '' },
        stderr: '',
        command: [],
      };
    }

    const { entry, outputs } = planned;
    const job = buildJob(
      req.op || 'convert',
      req.sources.map((s) => inputRef(s, { bytes: safeSize(s) })),
      outputs.map((o) => outputRef(o, req.targetFormat)),
      req.params || {},
      {
        kernel: entry.id,
        job_id: req.jobId || newJobId(),
        workdir: path.dirname(outputs[0] || '.'),
        timeout_ms: req.timeoutMs || this.settings.get('timeoutMs', DEFAULT_TIMEOUT_MS),
        context: { overwrite: req.overwrite !== false, source: 'hub' },
      }
    );

    const outcome = await runJob(entry, job, {
      hubRoot: this.hubRoot,
      sysPath: this.registry.sysPath,
      timeoutMs: req.timeoutMs || this.settings.get('timeoutMs', DEFAULT_TIMEOUT_MS),
      onEvent: hooks.onEvent,
      onLog: hooks.onLog,
      onProgress: hooks.onProgress,
      signal: hooks.signal,
    });
    outcome.planned_outputs = outputs;
    return outcome;
  }

  /* -- 自检 ------------------------------------------------------------- */

  doctor() {
    const registry = this.registry;
    const layout = registry.layout();
    const settings = this.settings;
    return {
      protocol: CKP_VERSION,
      node: process.versions.node,
      electron: process.versions.electron || '',
      chrome: process.versions.chrome || '',
      platform: `${process.platform} ${process.arch}`,
      layout,
      settings: settings.all(),
      registry: registry.summary(),
      kernels: registry.allEntries().map((e) => ({
        id: e.id,
        name: e.name,
        status: e.status,
        statusLabel: e.status === 'ready' ? '可用' : e.detail || e.status,
        detail: e.detail,
        engineNote: e.engineNote,
        capabilities: e.capabilityCount,
        ops: e.manifest.capabilities
          .map((c) => c.op)
          .filter((v, i, a) => a.indexOf(v) === i),
        license: e.manifest.license,
        homepage: e.manifest.homepage,
        installHint: e.installHint(),
        runtimeType: e.manifest.runtime.type,
        requires: e.manifest.runtime.requires,
      })),
    };
  }
}

function safeSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return undefined;
  }
}

module.exports = { Hub, defaultOutputPath, extensionFor };
