/**
 * format.js —— 纯函数格式化工具
 *
 * 设计原则：这里**只做展示层转换**，不含任何业务知识。
 * 特别注意：本文件里不允许出现任何具体格式名/内核名/参数名（协议驱动约束）——
 * 所有「是什么格式」「是什么内核」都由 window.khs 的返回值决定，这里只负责把
 * 已经拿到的字符串排版得好看一点。
 */

/* ------------------------------------------------------------------ 字节 */

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/**
 * 人类可读体积。
 * 与主进程 catalog.humanSize 保持同样的取舍（>10 保留 1 位、>100 取整），
 * 但这里多一个容错：非法输入返回 '—'，避免 UI 出现 'NaN B'。
 */
export function humanSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  let v = n / 1024;
  let i = 1;
  while (v >= 1024 && i < SIZE_UNITS.length - 1) {
    v /= 1024;
    i += 1;
  }
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${SIZE_UNITS[i]}`;
}

/** 数字千分位（用于计数类展示） */
export function thousands(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0';
  return num.toLocaleString('zh-CN');
}

/* ------------------------------------------------------------------ 时间 */

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 时间戳 → HH:MM:SS（日志时间列） */
export function clockTime(ts) {
  const d = toDate(ts);
  if (!d) return '--:--:--';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 时间戳 → HH:MM:SS.mmm（日志详情用，保留毫秒） */
export function clockTimeMs(ts) {
  const d = toDate(ts);
  if (!d) return '--:--:--.---';
  return `${clockTime(d)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** 时间戳 → YYYY-MM-DD HH:MM:SS */
export function dateTime(ts) {
  const d = toDate(ts);
  if (!d) return '—';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clockTime(d)}`;
}

/** 时间戳 → YYYY-MM-DD */
export function dateOnly(ts) {
  const d = toDate(ts);
  if (!d) return '—';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 相对时间：刚刚 / 3 分钟前 / 2 小时前 / 昨天 / 具体日期 */
export function relativeTime(ts) {
  const d = toDate(ts);
  if (!d) return '—';
  const diff = Date.now() - d.getTime();
  if (diff < 0) return dateTime(ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return '刚刚';
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day === 1) return '昨天';
  if (day < 30) return `${day} 天前`;
  return dateOnly(ts);
}

/**
 * 耗时展示：毫秒 → '820 ms' / '1.24 s' / '2:05'
 * 队列里 durationMs 为 0 时表示还没跑完，返回 '—'。
 */
export function duration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)} s`;
  const total = Math.floor(n / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${m}:${pad2(s)}`;
  const h = Math.floor(m / 60);
  return `${h}:${pad2(m % 60)}:${pad2(s)}`;
}

/** 从起止时间戳算耗时（作业还在跑时算到「现在」） */
export function elapsed(startedAt, finishedAt) {
  const s = Number(startedAt) || 0;
  if (!s) return '—';
  const e = Number(finishedAt) || Date.now();
  return duration(Math.max(0, e - s));
}

function toDate(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* ------------------------------------------------------------------ 文本 */

/**
 * 中间省略的文本裁剪——比简单尾部截断更适合展示路径/文件名，
 * 因为路径的尾部（文件名）通常比头部更有信息量。
 */
export function truncateMiddle(value, max = 48) {
  const str = String(value === null || value === undefined ? '' : value);
  if (str.length <= max) return str;
  const keep = max - 1; // 省略号占 1 个字符
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${str.slice(0, head)}…${str.slice(str.length - tail)}`;
}

/** 尾部省略（列表里的名称列） */
export function truncateEnd(value, max = 40) {
  const str = String(value === null || value === undefined ? '' : value);
  return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
}

/** 取文件名（Windows / POSIX 分隔符都认） */
export function baseName(p) {
  const str = String(p === null || p === undefined ? '' : p);
  if (!str) return '';
  const parts = str.split(/[\\/]/);
  return parts[parts.length - 1] || str;
}

/** 取目录（保留原始分隔符风格） */
export function dirName(p) {
  const str = String(p === null || p === undefined ? '' : p);
  const idx = Math.max(str.lastIndexOf('\\'), str.lastIndexOf('/'));
  return idx > 0 ? str.slice(0, idx) : str;
}

/** 取扩展名（小写，不含点） */
export function extName(p) {
  const name = baseName(p);
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** 去掉扩展名 */
export function stripExt(name) {
  const str = String(name || '');
  const i = str.lastIndexOf('.');
  return i > 0 ? str.slice(0, i) : str;
}

/** 首字母大写（用于把内核 id 之类的裸串排得好看点） */
export function capitalize(value) {
  const s = String(value || '');
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

/**
 * 格式标签：把协议返回的格式串排成统一的大写标签。
 * 不做任何格式映射——只做大小写与空白处理，避免硬编码格式名。
 */
export function formatLabel(fmt) {
  const s = String(fmt === null || fmt === undefined ? '' : fmt).trim();
  if (!s) return '未知';
  if (s === '*') return '任意';
  return s.toUpperCase();
}

/** 格式对展示：'PNG → WEBP' */
export function formatPair(from, to) {
  return `${formatLabel(from)} → ${formatLabel(to)}`;
}

/** 百分比：0.42 → '42%' */
export function percent(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0%';
  return `${(Math.max(0, Math.min(1, n)) * 100).toFixed(digits)}%`;
}

/** 数字区间标注：有 min/max 时给出 '(1 – 100)' 之类的提示 */
export function rangeHint(min, max, step) {
  const hasMin = Number.isFinite(Number(min));
  const hasMax = Number.isFinite(Number(max));
  if (!hasMin && !hasMax) return '';
  const lo = hasMin ? Number(min) : '−∞';
  const hi = hasMax ? Number(max) : '+∞';
  const st = Number.isFinite(Number(step)) && Number(step) > 0 ? `，步长 ${Number(step)}` : '';
  return `取值范围 ${lo} – ${hi}${st}`;
}

/* ------------------------------------------------------------------ 平台 */

let cachedPlatform = null;

/** 由 app.js 在启动时注入真实平台（khs.app.info().platform） */
export function setPlatform(platform) {
  cachedPlatform = String(platform || '') || null;
}

export function currentPlatform() {
  return cachedPlatform;
}

export function isMac() {
  return cachedPlatform === 'darwin';
}

/**
 * 快捷键展示：把逻辑描述（'mod+K'）翻成当前平台的按键组合。
 * 逻辑键名保持平台中立，展示时按平台替换 mod → Ctrl / ⌘。
 */
export function shortcut(label) {
  const raw = String(label || '');
  if (!raw) return '';
  const mod = isMac() ? '⌘' : 'Ctrl';
  return raw
    .replace(/\bmod\b/gi, mod)
    .replace(/\bshift\b/gi, 'Shift')
    .replace(/\balt\b/gi, isMac() ? '⌥' : 'Alt')
    .replace(/\benter\b/gi, 'Enter')
    .replace(/\besc\b/gi, 'Esc')
    .replace(/\s*\+\s*/g, '+');
}

/** 平台名称（doctor / 详情里展示） */
export function platformLabel(platform) {
  const p = String(platform || '');
  if (p.startsWith('win')) return 'Windows';
  if (p === 'darwin') return 'macOS';
  if (p.startsWith('linux')) return 'Linux';
  return p || '未知平台';
}

/* ------------------------------------------------------------------ 其它 */

/** JSON 美化，失败时原样返回（永不抛异常） */
export function prettyJson(value, fallback = '') {
  try {
    if (typeof value === 'string') {
      return JSON.stringify(JSON.parse(value), null, 2);
    }
    return JSON.stringify(value, null, 2);
  } catch {
    return typeof value === 'string' ? value : fallback;
  }
}

/** 安全取字符串（用于字段可能缺失的场景） */
export function orDash(value) {
  const s = value === null || value === undefined ? '' : String(value).trim();
  return s || '—';
}

/** 截断长数组为 '前 N 项 + 其余 M 项' 的字符串 */
export function joinLimited(list, limit = 8, sep = '、') {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return '—';
  if (arr.length <= limit) return arr.join(sep);
  return `${arr.slice(0, limit).join(sep)} 等 ${arr.length} 项`;
}

/** 从 operation 描述对象里取展示标签，缺字段时退回 op 本身 */
export function opLabelOf(opInfo, op) {
  const info = opInfo && typeof opInfo === 'object' ? opInfo : null;
  const label = info && info.label ? String(info.label) : '';
  return label || capitalize(op || '');
}
