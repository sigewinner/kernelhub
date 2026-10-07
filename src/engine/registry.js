'use strict';
/**
 * 内核注册表：发现 → 校验 → 探测 → 建索引 → 选择。
 *
 * 这是 CKP 宿主侧的核心：把「磁盘上一堆插件目录」变成「一张可查询的能力表」。
 * 选择算法与 kernel-hub/kernelhub/registry.py 完全一致（协议第 10 节）：
 *
 *   -quality  →  -priority  →  -specificity  →  id
 */

const fs = require('fs');
const path = require('path');

const {
  STATUS_READY,
  STATUS_DEGRADED,
  STATUS_INVALID,
  STATUS_UNAVAILABLE,
  STATUS_DISABLED,
  STATUS_LABELS_ZH,
  STATUS_RANK,
  KIND_LABELS,
  canonicalFormat,
  manifestFromDict,
  validateManifest,
  CkpError,
  NoKernelError,
} = require('../shared/protocol');
const { globSync, resolveSdkDir, pluginVendorDirOf } = require('./paths');
const { resolveExecutable, describeSpec } = require('./executables');
const { resolvePython, pythonVersion, pythonHasModule, findOnPath } = require('./python');

const MANIFEST_NAME = 'kernel.json';
const SKIP_DIRS = new Set(['__pycache__', 'node_modules', '.git', '.venv', 'venv', 'dist']);

/** 操作名的展示文案（协议只规定 op 是字符串，展示层在这里集中维护） */
const OP_META = {
  convert: { label: '格式转换', icon: '⇄', description: '把文件从一种格式转换为另一种格式' },
  transform: { label: '变换处理', icon: '✥', description: '缩放、裁剪、旋转、截取等就地变换' },
  extract: { label: '内容抽取', icon: '⤓', description: '从文件里抽出文本、图片、音轨等' },
  merge: { label: '合并', icon: '⊕', description: '把多个输入合并成一个输出' },
  split: { label: '拆分', icon: '⊖', description: '把一个输入拆成多个输出' },
  compress: { label: '压缩瘦身', icon: '⤡', description: '在不改变格式的前提下减小体积' },
  inspect: { label: '读取信息', icon: '◎', description: '只读取元数据，不产出文件' },
};

function opLabel(op) {
  return (OP_META[op] && OP_META[op].label) || op;
}

function opIcon(op) {
  return (OP_META[op] && OP_META[op].icon) || '◆';
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readManifestFile(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

/* ------------------------------------------------------------------ 探测器 */

function probeEntry(entry, ctx) {
  const { hubRoot, sysPath, python } = ctx;
  const manifest = entry.manifest;
  const probe = manifest.probe;
  const ptype = probe.type || 'none';

  const entryStatus = () => {
    const rtype = manifest.runtime.type;
    if (rtype === 'builtin') return { usable: true, note: '宿主内置适配器', status: STATUS_READY };
    if (!isFile(entry.entryPath)) {
      return { usable: false, note: `适配器入口不存在: ${entry.entryPath}`, status: STATUS_INVALID };
    }
    return { usable: true, note: path.basename(entry.entryPath), status: STATUS_READY };
  };

  if (ptype === 'none') {
    const requires = manifest.runtime.requires || [];
    if (requires.length) {
      const missing = requires.filter((r) => !pythonHasModule(r, { python, sysPath }));
      if (missing.length) {
        return { usable: false, note: `缺少 Python 依赖: ${missing.join(', ')}`, status: STATUS_DEGRADED };
      }
      return { usable: true, note: `依赖就绪: ${requires.join(', ')}`, status: STATUS_READY };
    }
    return entryStatus();
  }

  if (ptype === 'python-import') {
    if (!probe.target) return entryStatus();
    const ok = pythonHasModule(probe.target, { python, sysPath });
    if (!ok) return { usable: false, note: `Python 模块 '${probe.target}' 未安装`, status: STATUS_DEGRADED };
    const st = entryStatus();
    return { ...st, note: st.note === path.basename(entry.entryPath) ? `模块 ${probe.target} 就绪` : st.note };
  }

  if (ptype === 'command') {
    const exe = findOnPath([probe.target]) || (path.isAbsolute(probe.target) && isFile(probe.target) ? probe.target : '');
    if (!exe) {
      return { usable: false, note: `未在 PATH 中找到命令 '${probe.target}'`, status: STATUS_UNAVAILABLE };
    }
    if (!probe.args.length && !probe.expect) return { ...entryStatus(), note: exe };
    try {
      const { execFileSync } = require('child_process');
      const out = String(
        execFileSync(exe, probe.args, { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      );
      if (probe.expect && !out.toLowerCase().includes(probe.expect.toLowerCase())) {
        return { usable: false, note: `命令输出中未找到 '${probe.expect}'`, status: STATUS_UNAVAILABLE };
      }
      const first = out.trim().split('\n')[0] || exe;
      return { ...entryStatus(), note: first.slice(0, 160) };
    } catch (err) {
      return { usable: false, note: `命令探测失败: ${String(err.message || err).split('\n')[0]}`, status: STATUS_UNAVAILABLE };
    }
  }

  if (ptype === 'ckp-executable') {
    const spec = ((manifest.xCli || {}).executables || {})[probe.target];
    try {
      const { path: p, source } = resolveExecutable(probe.target, spec, {
        hubRoot,
        sysPath,
        pluginDir: entry.directory,
      });
      return { ...entryStatus(), note: `${path.basename(p)} ← ${source}` };
    } catch (err) {
      const detail = err instanceof CkpError ? err.message + (err.detail ? `（${err.detail}）` : '') : String(err.message || err);
      return { usable: false, note: detail, status: STATUS_UNAVAILABLE };
    }
  }

  if (ptype === 'file') {
    let target = probe.target;
    if (!path.isAbsolute(target)) target = path.join(entry.directory, target);
    if (fs.existsSync(target)) return { ...entryStatus(), note: target };
    return { usable: false, note: `未找到文件: ${target}`, status: STATUS_UNAVAILABLE };
  }

  return entryStatus();
}

/* ------------------------------------------------------------------ 注册表 */

class KernelEntry {
  constructor({ manifest, directory, manifestPath, status, detail, engineNote, mtime }) {
    this.manifest = manifest;
    this.directory = directory;
    this.manifestPath = manifestPath;
    this.status = status || STATUS_UNAVAILABLE;
    this.detail = detail || '';
    this.engineNote = engineNote || '';
    this.mtime = mtime || 0;
  }

  get id() {
    return this.manifest.id;
  }

  get name() {
    return this.manifest.name || this.manifest.id;
  }

  get usable() {
    return this.status === STATUS_READY;
  }

  get entryPath() {
    return path.normalize(path.join(this.directory, this.manifest.runtime.entry));
  }

  get capabilityCount() {
    return this.manifest.capabilities.reduce((n, c) => n + c.from.length * c.to.length, 0);
  }

  installHint() {
    const hook = (this.manifest.hooks || {}).install || {};
    if (hook.type === 'command' && hook.command) {
      return [hook.command, ...(hook.args || []).map(String)].join(' ').trim();
    }
    if (hook.description) return String(hook.description);
    return '';
  }

  toPublicDict() {
    const m = this.manifest;
    return {
      id: m.id,
      name: m.name,
      version: m.version,
      ckp: m.ckp,
      description: m.description,
      kind: m.kind,
      kindLabel: KIND_LABELS[m.kind] || m.kind,
      homepage: m.homepage,
      license: m.license,
      priority: m.priority,
      tags: [...m.tags],
      builtin: m.builtin,
      runtimeType: m.runtime.type,
      requires: [...m.runtime.requires],
      status: this.status,
      statusLabel: STATUS_LABELS_ZH[this.status] || this.status,
      detail: this.detail,
      engineNote: this.engineNote,
      directory: this.directory,
      entryPath: this.entryPath,
      installHint: this.installHint(),
      capabilityCount: this.capabilityCount,
      ops: m.capabilities.map((c) => c.op).filter((v, i, a) => a.indexOf(v) === i),
      formats: {
        from: this.inputFormats(),
        to: this.outputFormats(),
      },
      capabilities: m.capabilities.map((c) => ({
        id: c.id,
        op: c.op,
        opLabel: opLabel(c.op),
        label: c.label,
        from: [...c.from],
        to: [...c.to],
        multi_in: c.multi_in,
        multi_out: c.multi_out,
        quality: c.quality,
        output_mode: c.output_mode || 'exact',
      })),
      params: m.params.map((p) => ({ ...p.raw })),
      executableSpec: Object.fromEntries(
        Object.entries((m.xCli || {}).executables || {}).map(([k, v]) => [k, describeSpec(v, k)])
      ),
      probe: { type: m.probe.type, target: m.probe.target },
      enabled: this.status !== STATUS_DISABLED,
    };
  }

  inputFormats(op = '') {
    const out = new Set();
    for (const c of this.manifest.capabilities) {
      if (op && c.op !== op) continue;
      for (const f of c.from) if (f !== '*') out.add(f);
    }
    return Array.from(out).sort();
  }

  outputFormats(op = '') {
    const out = new Set();
    for (const c of this.manifest.capabilities) {
      if (op && c.op !== op) continue;
      for (const f of c.to) if (f !== '*') out.add(f);
    }
    return Array.from(out).sort();
  }

  findCapabilities(op, srcFmt, dstFmt) {
    return this.manifest.capabilities.filter(
      (c) => c.op === op && c.acceptsInput(srcFmt) && c.acceptsOutput(dstFmt)
    );
  }
}

class Registry {
  /**
   * @param {object} opts
   * @param {string} opts.hubRoot   CKP 工作区根目录
   * @param {string[]} opts.extraPluginDirs
   * @param {string[]} opts.disabledKernels
   * @param {Record<string, number>} opts.priorityOverrides
   */
  constructor(opts = {}) {
    this.hubRoot = path.resolve(opts.hubRoot || '.');
    this.extraPluginDirs = (opts.extraPluginDirs || []).map((d) => path.resolve(d));
    this.disabled = new Set(opts.disabledKernels || []);
    this.priorityOverrides = { ...(opts.priorityOverrides || {}) };
    /**
     * CKP 适配器 SDK 目录（含 kernelhub 包）。壳提供，所有插件共用。
     * 传空串表示「不提供」，用于老布局下让 hubRoot 自己兜底。
     */
    this.sdkDir = opts.sdkDir === undefined ? resolveSdkDir() : opts.sdkDir;
    /** 额外的 PYTHONPATH 条目（例如用户自建的共享依赖目录） */
    this.extraPythonPaths = (opts.extraPythonPaths || []).map((p) => path.resolve(p));
    this.entries = new Map();
    this.errors = [];
    this.scannedAt = 0;
    this.searchPaths = [];
    this.probeCache = new Map();
    this._sysPath = null;
  }

  /* -- 配置 ------------------------------------------------------------- */

  get vendorDir() {
    return path.join(this.hubRoot, 'vendor');
  }

  get pluginsDir() {
    return path.join(this.hubRoot, 'plugins');
  }

  get schemaDir() {
    return path.join(this.hubRoot, 'protocol', 'schemas');
  }

  get runDir() {
    return path.join(this.hubRoot, '.cache', 'runs');
  }

  get python() {
    if (!this._python) this._python = resolvePython('auto', this.hubRoot);
    return this._python;
  }

  get sysPath() {
    if (this._sysPath) return this._sysPath;
    const parts = [];
    if (this.sdkDir && isDir(this.sdkDir)) parts.push(this.sdkDir);
    if (isDir(this.vendorDir)) parts.push(this.vendorDir);
    parts.push(...this.extraPythonPaths.filter(isDir));
    if (isDir(this.hubRoot)) parts.push(this.hubRoot);
    parts.push(...this.collectPluginVendorDirs());

    const seen = new Set();
    this._sysPath = parts.filter((p) => {
      const k = path.resolve(p).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return this._sysPath;
  }

  /**
   * 所有插件各自的 vendor 目录（2.0.0 起插件自带 Python 依赖）。
   *
   * 必须扫所有搜索路径的子目录，而不是只扫 hubRoot —— 用户可能通过
   * CKP_PLUGIN_PATH / extraPluginDirs 把插件放在别处，那些插件的依赖同样要可见。
   */
  collectPluginVendorDirs() {
    const out = [];
    const bases = this.searchPaths.length ? this.searchPaths : this.resolveSearchPaths();
    for (const base of bases) {
      if (!isDir(base)) continue;
      let children = [];
      try {
        children = fs.readdirSync(base);
      } catch {
        continue;
      }
      for (const child of children) {
        if (child.startsWith('.') || child.startsWith('_') || SKIP_DIRS.has(child)) continue;
        const v = pluginVendorDirOf(path.join(base, child));
        if (isDir(v)) out.push(v);
      }
    }
    return out;
  }

  /** 内核搜索路径（去重保序，语义同 Python 宿主） */
  resolveSearchPaths() {
    const list = [this.pluginsDir];
    const env = process.env.CKP_PLUGIN_PATH || '';
    for (const item of env.split(path.delimiter)) {
      if (item.trim()) list.push(path.resolve(item.trim()));
    }
    for (const d of this.extraPluginDirs) list.push(d);
    const userPluginDir = path.join(require('os').homedir(), '.kernelhub', 'plugins');
    if (isDir(userPluginDir)) list.push(userPluginDir);

    const seen = new Set();
    const out = [];
    for (const p of list) {
      const norm = path.resolve(p).toLowerCase();
      if (!seen.has(norm)) {
        seen.add(norm);
        out.push(path.resolve(p));
      }
    }
    return out;
  }

  /* -- 发现 ------------------------------------------------------------- */

  discover() {
    this.entries.clear();
    this.errors = [];
    this.probeCache.clear();
    this._python = undefined;
    this.searchPaths = this.resolveSearchPaths();
    // sysPath 依赖 searchPaths（要扫各插件自带的 vendor），搜索路径一变就必须重算
    this._sysPath = null;
    const seenDirs = new Set();

    for (const base of this.searchPaths) {
      if (!isDir(base)) continue;
      let children = [];
      try {
        children = fs.readdirSync(base).sort();
      } catch (err) {
        this.errors.push(`无法读取插件目录 ${base}: ${err.message}`);
        continue;
      }
      for (const child of children) {
        if (child.startsWith('.') || child.startsWith('_') || SKIP_DIRS.has(child)) continue;
        const pluginDir = path.join(base, child);
        if (!isDir(pluginDir)) continue;
        const norm = pluginDir.toLowerCase();
        if (seenDirs.has(norm)) continue;
        seenDirs.add(norm);
        const entry = this.load(pluginDir);
        if (entry) this.register(entry);
      }
    }
    this.scannedAt = Date.now();
    return this;
  }

  load(pluginDir) {
    const manifestPath = path.join(pluginDir, MANIFEST_NAME);
    if (!isFile(manifestPath)) return null;
    let mtime = 0;
    try {
      mtime = fs.statSync(manifestPath).mtimeMs;
    } catch {
      /* ignore */
    }

    let data;
    try {
      data = readManifestFile(manifestPath);
    } catch (err) {
      const kid = path.basename(pluginDir);
      const broken = manifestFromDict({ id: `invalid.${kid}`, name: `${kid}（清单损坏）`, version: '0.0.0' });
      return new KernelEntry({
        manifest: broken,
        directory: pluginDir,
        manifestPath,
        status: STATUS_INVALID,
        detail: `kernel.json 解析失败: ${err.message}`,
        mtime,
      });
    }

    const problems = validateManifest(data);
    const manifest = manifestFromDict(data);
    const entry = new KernelEntry({ manifest, directory: pluginDir, manifestPath, mtime });

    if (problems.length) {
      entry.status = STATUS_INVALID;
      entry.detail = problems.join('；');
      return entry;
    }

    const override = this.priorityOverrides[manifest.id];
    if (typeof override === 'number' && Number.isFinite(override)) manifest.priority = override;

    // 探测（带缓存：同一清单在 mtime 不变时复用结论）
    const cacheKey = `${manifest.id}|${mtime}`;
    let probed = this.probeCache.get(cacheKey);
    if (!probed) {
      probed = probeEntry(entry, { hubRoot: this.hubRoot, sysPath: this.sysPath, python: this.python });
      this.probeCache.set(cacheKey, probed);
    }
    entry.status = probed.status;
    entry.engineNote = probed.note;
    if (!probed.usable && !entry.detail) entry.detail = probed.note;

    if (this.disabled.has(manifest.id)) {
      entry.status = STATUS_DISABLED;
      entry.detail = '已被用户停用';
    }
    return entry;
  }

  register(entry) {
    const existing = this.entries.get(entry.id);
    if (existing) {
      const better = (STATUS_RANK[entry.status] ?? 9) < (STATUS_RANK[existing.status] ?? 9);
      this.errors.push(
        `内核 id 冲突: ${entry.id} —— ${existing.directory} 与 ${entry.directory}，` +
          `保留 ${better ? entry.directory : existing.directory}`
      );
      if (better) this.entries.set(entry.id, entry);
      return;
    }
    this.entries.set(entry.id, entry);
  }

  /* -- 查询 ------------------------------------------------------------- */

  get(id) {
    return this.entries.get(id) || null;
  }

  allEntries() {
    return Array.from(this.entries.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  readyEntries() {
    return this.allEntries().filter((e) => e.usable);
  }

  ops() {
    const set = [];
    for (const e of this.readyEntries()) {
      for (const c of e.manifest.capabilities) if (!set.includes(c.op)) set.push(c.op);
    }
    return set.sort();
  }

  inputFormats(op) {
    const out = new Set();
    for (const e of this.readyEntries()) {
      for (const c of e.manifest.capabilities) {
        if (c.op !== op) continue;
        for (const f of c.from) if (f !== '*') out.add(f);
      }
    }
    return Array.from(out).sort();
  }

  outputFormats(op) {
    const out = new Set();
    for (const e of this.readyEntries()) {
      for (const c of e.manifest.capabilities) {
        if (c.op !== op) continue;
        for (const f of c.to) if (f !== '*') out.add(f);
      }
    }
    return Array.from(out).sort();
  }

  /** 给定输入格式，能转出哪些格式（GUI 联动用） */
  targetsFor(op, srcFmt) {
    const src = canonicalFormat(srcFmt);
    const out = new Set();
    for (const e of this.readyEntries()) {
      for (const c of e.manifest.capabilities) {
        if (c.op !== op || !c.acceptsInput(src)) continue;
        for (const f of c.to) if (f !== '*') out.add(f);
      }
    }
    return Array.from(out).sort();
  }

  sourcesFor(op, dstFmt) {
    const dst = canonicalFormat(dstFmt);
    const out = new Set();
    for (const e of this.readyEntries()) {
      for (const c of e.manifest.capabilities) {
        if (c.op !== op || !c.acceptsOutput(dst)) continue;
        for (const f of c.from) if (f !== '*') out.add(f);
      }
    }
    return Array.from(out).sort();
  }

  /** 能力矩阵：op -> { from: [...], to: [...] }，供「格式 × 操作」视图用 */
  matrix() {
    const perOp = new Map();
    for (const e of this.readyEntries()) {
      for (const c of e.manifest.capabilities) {
        const rec = perOp.get(c.op) || { op: c.op, label: opLabel(c.op), from: new Set(), to: new Set(), kernels: new Set() };
        c.from.forEach((f) => f !== '*' && rec.from.add(f));
        c.to.forEach((f) => f !== '*' && rec.to.add(f));
        rec.kernels.add(e.id);
        perOp.set(c.op, rec);
      }
    }
    return Array.from(perOp.values())
      .sort((a, b) => a.op.localeCompare(b.op))
      .map((r) => ({
        op: r.op,
        label: r.label,
        from: Array.from(r.from).sort(),
        to: Array.from(r.to).sort(),
        kernels: Array.from(r.kernels).sort(),
      }));
  }

  /* -- 选择 ------------------------------------------------------------- */

  candidates(op, srcFmt, dstFmt, { multiIn = false, multiOut = false } = {}) {
    const src = canonicalFormat(srcFmt);
    const dst = canonicalFormat(dstFmt);
    const hits = [];
    for (const entry of this.readyEntries()) {
      for (const cap of entry.manifest.capabilities) {
        if (cap.op !== op) continue;
        if (!cap.acceptsInput(src) || !cap.acceptsOutput(dst)) continue;
        if (multiIn && !cap.multi_in) continue;
        if (multiOut && !cap.multi_out) continue;
        hits.push({ entry, cap });
      }
    }
    hits.sort((a, b) => {
      if (b.cap.quality !== a.cap.quality) return b.cap.quality - a.cap.quality;
      if (b.entry.manifest.priority !== a.entry.manifest.priority) {
        return b.entry.manifest.priority - a.entry.manifest.priority;
      }
      const sa = a.cap.specificity(src, dst);
      const sb = b.cap.specificity(src, dst);
      if (sb !== sa) return sb - sa;
      return a.entry.id.localeCompare(b.entry.id);
    });
    return hits;
  }

  resolve(op, srcFmt, dstFmt, { kernelId = '', multiIn = false, multiOut = false } = {}) {
    if (kernelId) {
      const entry = this.get(kernelId);
      if (!entry) throw new NoKernelError(`指定的内核不存在: ${kernelId}`);
      if (!entry.usable) {
        throw new NoKernelError(
          `内核 ${kernelId} 当前不可用（${STATUS_LABELS_ZH[entry.status] || entry.status}）：${entry.detail}`
        );
      }
      const caps = entry.findCapabilities(op, srcFmt, dstFmt);
      if (!caps.length) {
        throw new NoKernelError(`内核 ${kernelId} 不支持 ${srcFmt || '*'} → ${dstFmt || '*'}（${op}）`);
      }
      caps.sort((a, b) => {
        if (b.quality !== a.quality) return b.quality - a.quality;
        return b.specificity(srcFmt, dstFmt) - a.specificity(srcFmt, dstFmt);
      });
      return { entry, cap: caps[0] };
    }

    const hits = this.candidates(op, srcFmt, dstFmt, { multiIn, multiOut });
    if (hits.length) return hits[0];

    throw new NoKernelError(this.explainMiss(op, srcFmt, dstFmt, multiIn, multiOut), JSON.stringify(this.nearMisses(op, srcFmt, dstFmt), null, 2));
  }

  nearMisses(op, src, dst, limit = 6) {
    const rows = [];
    for (const entry of this.readyEntries()) {
      const inHit = entry.findCapabilities(op, src, '*');
      const outHit = entry.findCapabilities(op, '*', dst);
      if (inHit.length || outHit.length) {
        rows.push({
          kernel: entry.id,
          name: entry.name,
          status: entry.status,
          can_read_input: inHit.length > 0,
          can_write_output: outHit.length > 0,
          ops: entry.manifest.capabilities.map((c) => c.op).filter((v, i, a) => a.indexOf(v) === i),
        });
      }
    }
    return rows.slice(0, limit);
  }

  explainMiss(op, src, dst, multiIn, multiOut) {
    const ready = this.readyEntries();
    if (!ready.length) {
      const pending = this.allEntries().filter((e) => e.status !== STATUS_READY).slice(0, 5);
      const hint = pending.map((e) => `${e.id}(${STATUS_LABELS_ZH[e.status] || e.status})`).join('；');
      return '目前没有任何可用内核。' + (hint ? ` 已发现但不可用：${hint}` : '');
    }
    const ops = Array.from(new Set(ready.flatMap((e) => e.manifest.capabilities.map((c) => c.op)))).sort();
    let msg = `没有内核能完成 ${src || '*'} → ${dst || '*'}（操作 ${op}）。可用操作：${ops.join(', ')}`;
    if (multiIn) msg += '（该任务需要多输入支持）';
    if (multiOut) msg += '（该任务需要多输出支持）';
    return msg;
  }

  /** 给指定内核/格式组合求参数集合（GUI 动态表单的唯一数据来源） */
  paramSpecsFor(op, srcFmt, dstFmt, { kernelId = '', all = false } = {}) {
    let entries = [];
    if (kernelId) {
      const e = this.get(kernelId);
      if (e) entries = [e];
    }
    if (!entries.length) {
      const hits = this.candidates(op, srcFmt, dstFmt);
      entries = [];
      for (const h of hits) if (!entries.includes(h.entry)) entries.push(h.entry);
    }
    if (!entries.length || all) {
      const ready = this.readyEntries();
      entries = entries.length ? entries : ready;
    }
    if (!entries.length) return { specs: [], entry: null };

    const primary = entries[0];
    const caps = primary.findCapabilities(op, srcFmt, dstFmt);
    const capParams = caps.length ? caps[0].params : [];
    const merged = require('../shared/protocol').mergeParams(primary.manifest.params, capParams);
    return { specs: merged, entry: primary };
  }

  /**
   * 参数可见性求值（单一权威来源）。
   *
   * 协议声明的是 when.from / when.to（可能含通配符与别名，如 `jpeg`、`tif`），
   * UI 不应该自己再实现一遍格式族匹配 —— 这里把它算成集合，交给界面做包含判断：
   *   visible    当前 (op, from, to) 下是否应显示
   *   visibleFrom/visibleTo  when 里与该条件「同一格式族」的标签（供界面展示）
   */
  paramVisibility(spec, op, srcFmt, dstFmt) {
    const { paramVisibleFor, formatCandidates, formatsMatch } = require('../shared/protocol');
    const when = spec.when || {};
    const pickMatches = (declared, actual) =>
      (declared || []).filter((d) => formatsMatch(d, actual) || (formatCandidates(d) && formatCandidates(d).has(canonicalFormat(actual))));
    return {
      visible: paramVisibleFor(spec, op, srcFmt || '', dstFmt || ''),
      visibleFrom: pickMatches(when.from, srcFmt || ''),
      visibleTo: pickMatches(when.to, dstFmt || ''),
      ops: when.op ? [...when.op] : [],
      appliesTo: spec.applies_to ? [...spec.applies_to] : [],
    };
  }

  /* -- 汇总 ------------------------------------------------------------- */

  summary() {
    const byStatus = {};
    for (const e of this.entries.values()) byStatus[e.status] = (byStatus[e.status] || 0) + 1;
    return {
      total: this.entries.size,
      ready: this.readyEntries().length,
      byStatus,
      ops: this.ops(),
      errors: [...this.errors],
    };
  }

  layout() {
    return {
      hubRoot: this.hubRoot,
      pluginsDir: this.pluginsDir,
      vendorDir: this.vendorDir,
      schemaDir: this.schemaDir,
      runDir: this.runDir,
      searchPaths: [...this.searchPaths],
      python: this.python,
      pythonVersion: pythonVersion(this.python),
      sysPath: this.sysPath,
    };
  }
}

module.exports = { Registry, KernelEntry, OP_META, opLabel, opIcon, probeEntry };
