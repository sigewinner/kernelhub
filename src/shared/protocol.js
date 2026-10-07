'use strict';
/**
 * CKP 1.0 —— 转换内核协议（Node.js 权威实现）
 *
 * 与 Python 宿主 (kernel-hub/kernelhub/protocol.py) 语义一一对应：
 * 格式归一化、参数声明、能力声明、清单/任务校验、事件模型、错误码。
 * 本文件不依赖任何第三方模块，也不依赖 Electron，可被主进程与测试直接 require。
 */

const CKP_VERSION = '1.0';
const CKP_VERSION_MAJOR = 1;
const CKP_VERSION_MINOR = 0;

/* ------------------------------------------------------------------ 格式 */

const FORMAT_ALIASES = {
  jpeg: 'jpg',
  jpe: 'jpg',
  jfif: 'jpg',
  jfi: 'jpg',
  tiff: 'tif',
  dib: 'bmp',
  htm: 'html',
  xhtml: 'html',
  yml: 'yaml',
  md: 'markdown',
  mdown: 'markdown',
  mkd: 'markdown',
  txt: 'text',
  log: 'text',
  mpg: 'mpeg',
  m4v: 'mp4',
  mka: 'mkv',
  wave: 'wav',
  aif: 'aiff',
  heic: 'heif',
  heics: 'heif',
  yuv: 'raw',
  ps: 'postscript',
  eps: 'postscript',
};

/** 规范名 -> 该家族所有标签（含别名，已排序） */
const FORMAT_FAMILY = {};
for (const canon of Object.values(FORMAT_ALIASES)) {
  FORMAT_FAMILY[canon] = FORMAT_FAMILY[canon] || new Set([canon]);
}
for (const [alias, canon] of Object.entries(FORMAT_ALIASES)) {
  FORMAT_FAMILY[canon].add(alias);
  FORMAT_FAMILY[canon].add(canon);
}
for (const key of Object.keys(FORMAT_FAMILY)) {
  FORMAT_FAMILY[key] = Array.from(FORMAT_FAMILY[key]).sort();
}

function canonicalFormat(name) {
  if (!name) return '';
  const fmt = String(name).trim().toLowerCase().replace(/^\.+/, '');
  if (!fmt) return '';
  return FORMAT_ALIASES[fmt] || fmt;
}

function extOf(p) {
  const base = String(p || '').split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot);
}

function formatOfPath(p) {
  return canonicalFormat(extOf(p));
}

function stemOf(p) {
  const base = String(p || '').split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function basenameOf(p) {
  return String(p || '').split(/[\\/]/).pop() || '';
}

function dirnameOf(p) {
  const parts = String(p || '').split(/[\\/]/);
  parts.pop();
  return parts.join('/') || '.';
}

/** 可与 name 匹配的所有标签（规范名 + 全部别名） */
function formatCandidates(name) {
  const canon = canonicalFormat(name);
  if (!canon) return new Set();
  const out = new Set([canon]);
  for (const t of FORMAT_FAMILY[canon] || []) out.add(t);
  return out;
}

/** declared（内核声明的标签）是否覆盖 actual（实际格式） */
function formatsMatch(declared, actual) {
  if (declared === '*') return true;
  const a = formatCandidates(declared);
  if (!a.size) return false;
  for (const t of formatCandidates(actual)) if (a.has(t)) return true;
  return false;
}

/* -------------------------------------------------------------- 参数声明 */

const PARAM_TYPES = ['int', 'float', 'bool', 'string', 'enum', 'path', 'color'];

const PARAM_DEFAULTS = {
  int: 0,
  float: 0.0,
  bool: false,
  string: '',
  enum: null,
  path: '',
  color: '#000000',
};

function paramSpecFromDict(data) {
  const d = data || {};
  return {
    id: String(d.id || ''),
    type: String(d.type || 'string'),
    label: String(d.label || d.id || ''),
    description: String(d.description || ''),
    default: d.default === undefined ? null : d.default,
    min: d.min === undefined ? null : d.min,
    max: d.max === undefined ? null : d.max,
    step: d.step === undefined ? null : d.step,
    enum: Array.isArray(d.enum) ? d.enum.map((e) => ({ ...e })) : [],
    advanced: Boolean(d.advanced),
    required: Boolean(d.required),
    applies_to: Array.isArray(d.applies_to) ? d.applies_to.map(String) : [],
    when: normalizeWhen(d.when),
    raw: { ...d },
  };
}

function normalizeWhen(when) {
  const out = {};
  for (const [k, v] of Object.entries(when || {})) {
    out[k] = Array.isArray(v) ? v.map(String) : [String(v)];
  }
  return out;
}

function effectiveDefault(spec) {
  if (spec.default !== null && spec.default !== undefined) return spec.default;
  if (spec.type === 'enum' && spec.enum.length) return spec.enum[0].value;
  const d = PARAM_DEFAULTS[spec.type];
  return d === undefined ? null : d;
}

/** 按 applies_to / when 判断参数在当前场景是否可见 */
function paramVisibleFor(spec, op, srcFmt, dstFmt) {
  if (spec.applies_to && spec.applies_to.length && !spec.applies_to.includes(op)) return false;
  const when = spec.when || {};
  const ops = when.op;
  if (ops && ops.length && !ops.includes(op)) return false;
  const srcs = when.from;
  if (srcs && srcs.length && !srcs.some((s) => formatsMatch(s, srcFmt))) return false;
  const dsts = when.to;
  if (dsts && dsts.length && !dsts.some((d) => formatsMatch(d, dstFmt))) return false;
  return true;
}

/** 按 id 合并多组参数（后面的覆盖前面的：能力级 > 顶层级） */
function mergeParams(...groups) {
  const merged = new Map();
  for (const group of groups) {
    for (const spec of group || []) merged.set(spec.id, spec);
  }
  return Array.from(merged.values());
}

/* ------------------------------------------------------------------ 能力 */

function capabilityFromDict(data) {
  const d = data || {};
  const cap = {
    op: String(d.op || ''),
    from: (d.from || []).map((f) => canonicalFormat(f) || String(f).toLowerCase()),
    to: (d.to || []).map((f) => canonicalFormat(f) || String(f).toLowerCase()),
    id: String(d.id || ''),
    multi_in: Boolean(d.multi_in),
    multi_out: Boolean(d.multi_out),
    label: String(d.label || ''),
    quality: Number(d.quality || 0),
    params: (d.params || []).map(paramSpecFromDict),
    output_mode: String(d.output_mode || ''),
    raw: { ...d },
  };
  if (!cap.id) {
    cap.id = `${cap.op}:${cap.from.join('+') || '*'}-${cap.to.join('+') || '*'}`;
  }
  cap.acceptsInput = (fmt) => cap.from.some((d2) => formatsMatch(d2, fmt));
  cap.acceptsOutput = (fmt) => cap.to.some((d2) => formatsMatch(d2, fmt));
  cap.specificity = (srcFmt, dstFmt) => {
    let score = 0;
    if (!cap.from.includes('*') && srcFmt) score += 1;
    if (!cap.to.includes('*') && dstFmt) score += 1;
    return score;
  };
  return cap;
}

/* ------------------------------------------------------------------ 清单 */

const ID_RE = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;
const VERSION_RE = /^(\d+)\.(\d+)$/;

const RUNTIME_TYPES = ['python', 'exec', 'powershell', 'node', 'builtin'];
const KINDS = ['image', 'document', 'media', 'archive', 'vector', 'data', 'other'];

const KIND_LABELS = {
  image: '图像',
  document: '文档',
  media: '音视频',
  archive: '压缩包',
  vector: '矢量',
  data: '数据',
  other: '其他',
};

function runtimeFromDict(data) {
  const d = data || {};
  return {
    type: String(d.type || 'python'),
    entry: String(d.entry || ''),
    args: (d.args || []).map(String),
    python: String(d.python || 'auto'),
    requires: (d.requires || []).map(String),
    env: Object.fromEntries(Object.entries(d.env || {}).map(([k, v]) => [String(k), String(v)])),
    cwd: String(d.cwd || ''),
  };
}

function probeFromDict(data) {
  const d = data || {};
  return {
    type: String(d.type || 'none'),
    target: String(d.target || ''),
    args: (d.args || []).map(String),
    expect: String(d.expect || ''),
    min_version: String(d.min_version || ''),
  };
}

function manifestFromDict(data) {
  const d = data || {};
  return {
    id: String(d.id || ''),
    name: String(d.name || ''),
    version: String(d.version || ''),
    ckp: String(d.ckp || CKP_VERSION),
    description: String(d.description || ''),
    kind: String(d.kind || 'other'),
    homepage: String(d.homepage || ''),
    license: String(d.license || ''),
    priority: Number(d.priority === undefined ? 50 : d.priority) || 0,
    tags: (d.tags || []).map(String),
    icon: String(d.icon || ''),
    runtime: runtimeFromDict(d.runtime),
    capabilities: (d.capabilities || []).map(capabilityFromDict),
    params: (d.params || []).map(paramSpecFromDict),
    probe: probeFromDict(d.probe),
    hooks: d.hooks || {},
    builtin: Boolean(d.builtin),
    xCli: d['x-cli'] || null,
    raw: { ...d },
  };
}

/** 校验清单字典，返回错误数组（空数组 = 合法） */
function validateManifest(data) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return ['清单根节点必须是 JSON 对象'];
  }
  for (const key of ['ckp', 'id', 'name', 'version', 'runtime', 'capabilities']) {
    if (!(key in data)) errors.push(`缺少必填字段 '${key}'`);
  }

  const version = String(data.ckp || '');
  const m = VERSION_RE.exec(version);
  if (!m) {
    errors.push(`字段 'ckp' 必须形如 '1.0'，实际为 ${JSON.stringify(version)}`);
  } else if (Number(m[1]) !== CKP_VERSION_MAJOR) {
    errors.push(`协议主版本不兼容：内核声明 ${version}，宿主支持 ${CKP_VERSION}`);
  }

  const kid = String(data.id || '');
  if (kid && !ID_RE.test(kid)) {
    errors.push(`字段 'id' 非法：'${kid}' —— 只允许小写字母/数字/._-，且首尾为字母或数字`);
  }
  if ('name' in data && !String(data.name || '').trim()) errors.push("字段 'name' 不能为空");
  if ('version' in data && !String(data.version || '').trim()) errors.push("字段 'version' 不能为空");

  if (data.kind !== undefined && data.kind !== null && !KINDS.includes(String(data.kind))) {
    errors.push(`字段 'kind' 非法：'${data.kind}'，可选 [${KINDS.join(', ')}]`);
  }

  const runtime = data.runtime;
  if (runtime && typeof runtime === 'object' && !Array.isArray(runtime)) {
    const rtype = String(runtime.type || '');
    if (!RUNTIME_TYPES.includes(rtype)) {
      errors.push(`runtime.type 非法：'${rtype}'，可选 [${RUNTIME_TYPES.join(', ')}]`);
    }
    if (!String(runtime.entry || '').trim()) errors.push('runtime.entry 不能为空');
  } else if (runtime !== undefined && runtime !== null) {
    errors.push('runtime 必须是对象');
  }

  const caps = data.capabilities;
  if (!Array.isArray(caps) || !caps.length) {
    errors.push('capabilities 必须是非空数组');
  } else {
    caps.forEach((cap, i) => {
      if (!cap || typeof cap !== 'object' || Array.isArray(cap)) {
        errors.push(`capabilities[${i}] 必须是对象`);
        return;
      }
      for (const key of ['op', 'from', 'to']) {
        if (!cap[key] || (Array.isArray(cap[key]) && !cap[key].length)) {
          errors.push(`capabilities[${i}] 缺少 '${key}'`);
        }
      }
      for (const key of ['from', 'to']) {
        if (cap[key] !== undefined && !Array.isArray(cap[key])) {
          errors.push(`capabilities[${i}].${key} 必须是数组`);
        }
      }
    });
  }

  (data.params || []).forEach((spec, i) => {
    if (!spec || typeof spec !== 'object') {
      errors.push(`params[${i}] 必须是对象`);
      return;
    }
    if (!String(spec.id || '').trim()) errors.push(`params[${i}] 缺少 'id'`);
    const ptype = String(spec.type || '');
    if (!PARAM_TYPES.includes(ptype)) {
      errors.push(`params[${i}].type 非法：'${ptype}'，可选 [${PARAM_TYPES.join(', ')}]`);
    }
    if (ptype === 'enum' && !(spec.enum && spec.enum.length)) {
      errors.push(`params[${i}] 为 enum 类型但未提供 'enum' 取值`);
    }
  });

  return errors;
}

/* ------------------------------------------------------------------ 任务 */

let jobCounter = 0;

function newJobId() {
  jobCounter += 1;
  const rnd = Math.random().toString(16).slice(2, 10);
  return `${Date.now().toString(36)}-${process.pid.toString(36)}-${jobCounter.toString(36)}-${rnd}`;
}

function inputRef(p, opts = {}) {
  return {
    path: p,
    format: opts.format || formatOfPath(p),
    role: opts.role || 'primary',
    ...(opts.bytes === undefined ? {} : { bytes: opts.bytes }),
  };
}

function outputRef(p, fmt) {
  return { path: p, format: canonicalFormat(fmt) || formatOfPath(p) };
}

function buildJob(op, inputs, outputs, params, extra = {}) {
  const job = {
    ckp: CKP_VERSION,
    job_id: extra.job_id || newJobId(),
    op,
    inputs: inputs.map((i) => (typeof i === 'string' ? inputRef(i) : i)),
    outputs: (outputs || []).map((o) => (typeof o === 'string' ? outputRef(o) : o)),
    params: { ...(params || {}) },
  };
  if (extra.kernel) job.kernel = extra.kernel;
  if (extra.workdir) job.workdir = extra.workdir;
  if (extra.timeout_ms) job.limits = { timeout_ms: Number(extra.timeout_ms) };
  job.context = { source: 'kernelhub-studio', locale: 'zh-CN', overwrite: true, ...(extra.context || {}) };
  return job;
}

function validateJob(job) {
  const errors = [];
  if (!job || typeof job !== 'object' || Array.isArray(job)) return ['Job 根节点必须是对象'];
  for (const key of ['ckp', 'job_id', 'op', 'inputs']) {
    if (!job[key]) errors.push(`缺少必填字段 '${key}'`);
  }
  const m = VERSION_RE.exec(String(job.ckp || ''));
  if (!m) errors.push(`字段 'ckp' 必须形如 '1.0'，实际为 '${job.ckp}'`);
  else if (Number(m[1]) !== CKP_VERSION_MAJOR) errors.push(`协议主版本不兼容：${job.ckp} vs ${CKP_VERSION}`);
  if (!Array.isArray(job.inputs) || !job.inputs.length) errors.push('inputs 必须是非空数组');
  else job.inputs.forEach((it, i) => {
    if (!it || !it.path) errors.push(`inputs[${i}] 缺少 'path'`);
  });
  if (job.outputs !== undefined) {
    if (!Array.isArray(job.outputs)) errors.push('outputs 必须是数组');
    else job.outputs.forEach((it, i) => {
      if (!it || !it.path) errors.push(`outputs[${i}] 缺少 'path'`);
    });
  }
  if (job.params !== undefined && (typeof job.params !== 'object' || Array.isArray(job.params))) {
    errors.push('params 必须是对象');
  }
  return errors;
}

/* ------------------------------------------------------------------ 事件 */

const EVENT_TYPES = ['hello', 'log', 'progress', 'artifact', 'result', 'error'];
const TERMINAL_EVENTS = ['result', 'error'];
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

const ERROR_CODES = {
  UNSUPPORTED_FORMAT: false,
  BAD_JOB: false,
  PROTOCOL_VERSION: false,
  DEPENDENCY_MISSING: false,
  INPUT_NOT_FOUND: false,
  INPUT_UNREADABLE: false,
  OUTPUT_NOT_WRITABLE: true,
  OUTPUT_EXISTS: true,
  TIMEOUT: true,
  CANCELLED: true,
  ENGINE_CRASH: true,
  ARTIFACT_MISSING: false,
  PROTOCOL_NO_TERMINAL_EVENT: false,
  INTERNAL: true,
};

const ERROR_MESSAGES_ZH = {
  UNSUPPORTED_FORMAT: '内核不支持该格式',
  BAD_JOB: '任务描述不合法',
  PROTOCOL_VERSION: '协议版本不兼容',
  DEPENDENCY_MISSING: '内核依赖缺失（引擎未安装）',
  INPUT_NOT_FOUND: '输入文件不存在',
  INPUT_UNREADABLE: '输入文件无法读取或解码',
  OUTPUT_NOT_WRITABLE: '输出路径不可写',
  OUTPUT_EXISTS: '输出文件已存在',
  TIMEOUT: '任务超时',
  CANCELLED: '任务已取消',
  ENGINE_CRASH: '底层引擎异常退出',
  ARTIFACT_MISSING: '内核声称产出的文件不存在',
  PROTOCOL_NO_TERMINAL_EVENT: '适配器结束但未返回终态事件',
  INTERNAL: '内核内部错误',
};

/** 解析一行 NDJSON；失败返回 null（宿主按日志处理） */
function parseEventLine(line) {
  const text = String(line || '').trim();
  if (!text) return null;
  if (!text.startsWith('{') || !text.endsWith('}')) return null;
  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    return obj;
  } catch {
    return null;
  }
}

function isTerminal(event) {
  return TERMINAL_EVENTS.includes(String((event || {}).type || ''));
}

/* ------------------------------------------------------------ 状态与错误 */

const STATUS_READY = 'ready';
const STATUS_DEGRADED = 'degraded';
const STATUS_INVALID = 'invalid';
const STATUS_UNAVAILABLE = 'unavailable';
const STATUS_DISABLED = 'disabled';

const STATUS_LABELS_ZH = {
  ready: '可用',
  degraded: '依赖缺失',
  invalid: '清单非法',
  unavailable: '未安装',
  disabled: '已停用',
};

const STATUS_RANK = {
  ready: 0,
  degraded: 1,
  unavailable: 2,
  invalid: 3,
  disabled: 4,
};

class CkpError extends Error {
  constructor(code, message, detail = '', retryable) {
    super(message || ERROR_MESSAGES_ZH[code] || '内核错误');
    this.name = 'CkpError';
    this.code = code;
    this.detail = detail;
    this.retryable = retryable === undefined ? Boolean(ERROR_CODES[code]) : Boolean(retryable);
  }

  toEvent(jobId = '') {
    return {
      type: 'error',
      ok: false,
      ckp: CKP_VERSION,
      job_id: jobId,
      code: this.code,
      message: this.message,
      detail: this.detail,
      retryable: this.retryable,
      synthetic: true,
    };
  }
}

class NoKernelError extends CkpError {
  constructor(message, detail = '') {
    super('UNSUPPORTED_FORMAT', message, detail);
    this.name = 'NoKernelError';
  }
}

module.exports = {
  CKP_VERSION,
  CKP_VERSION_MAJOR,
  CKP_VERSION_MINOR,
  FORMAT_ALIASES,
  FORMAT_FAMILY,
  canonicalFormat,
  formatOfPath,
  formatCandidates,
  formatsMatch,
  extOf,
  stemOf,
  basenameOf,
  dirnameOf,
  PARAM_TYPES,
  PARAM_DEFAULTS,
  paramSpecFromDict,
  effectiveDefault,
  paramVisibleFor,
  mergeParams,
  capabilityFromDict,
  manifestFromDict,
  validateManifest,
  ID_RE,
  VERSION_RE,
  RUNTIME_TYPES,
  KINDS,
  KIND_LABELS,
  newJobId,
  inputRef,
  outputRef,
  buildJob,
  validateJob,
  EVENT_TYPES,
  TERMINAL_EVENTS,
  LOG_LEVELS,
  ERROR_CODES,
  ERROR_MESSAGES_ZH,
  parseEventLine,
  isTerminal,
  STATUS_READY,
  STATUS_DEGRADED,
  STATUS_INVALID,
  STATUS_UNAVAILABLE,
  STATUS_DISABLED,
  STATUS_LABELS_ZH,
  STATUS_RANK,
  CkpError,
  NoKernelError,
};
