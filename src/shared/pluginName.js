'use strict';
/**
 * 插件在**界面上的显示名**。
 *
 * 规则（软件层面，代码里的 id 与清单原名一概不动）：
 *   类型名 + 最典型的两个扩展名      例：「图片 PNG / JPG」「文档 PDF」
 * 其余支持的格式不进名字（能力矩阵里已经列全），避免名字又长又难认。
 *
 * 三处细节：
 *   1. 类型名以清单的 kind 为准，但对两类做细化 ——
 *        media   → 看实际格式分成 音视频 / 音频 / 视频
 *        data    → 看实际格式分成 表格 / 文本 / 数据
 *   2. 扩展名按「典型度」排序取前两个，避免把 xwd、viff 这种冷门格式摆到脸上。
 *   3. **重名时追加限定名**。同一类里天然会有多个插件（图片类 6 个、PDF 类 4 个），
 *      只按类型+扩展名算出来会撞车（ImageMagick 与 GraphicsMagick 就是同一套格式）。
 *      限定名优先取原名括号里的内容（「零依赖」「纯 Python」），否则取原名的第一个词
 *      （ImageMagick / Poppler / QPDF…）。主名已经含该词时退回用 id。
 */

/**
 * 注意：所有格式名都必须用**规范名**，不能用原始别名。
 * 宿主侧的 CKP 实现会把别名归一化（md/mdown/mkd → markdown，htm/xhtml → html，
 * jpeg/jfif → jpg，eps/ps → postscript，tiff → tif，heic → heif，txt/log → text，
 * mpg → mpeg，dib → bmp，m4v → mp4），注册表给出的就是规范名；
 * 而插件目录 catalog.json 里存的是原始别名 —— 两边统一走 canonicalFormat() 才对齐。
 */
const { canonicalFormat } = require('./protocol');

const TYPE_BY_KIND = {
  image: '图片',
  vector: '矢量图',
  audio: '音频',
  video: '视频',
  media: '音视频',
  document: '文档',
  archive: '压缩包',
  data: '数据',
  other: '其他',
};

/** 每类的「典型格式」顺序（规范名）：越靠前越常见、越能代表这一类插件 */
const TYPICAL = {
  图片: [
    'png', 'jpg', 'webp', 'gif', 'bmp', 'tif', 'avif', 'heif', 'ico', 'psd', 'tga', 'ppm', 'pcx',
    'qoi', 'dds', 'hdr', 'exr', 'fits', 'sgi', 'xbm', 'jp2', 'j2k', 'pnm', 'pbm', 'pgm', 'icns',
    'mpo', 'cur', 'wbmp', 'miff', 'dpx', 'sun', 'viff', 'xpm', 'xwd', 'wpg', 'emf', 'wmf', 'raw',
    'mng', 'otb', 'pict', 'exif', 'magick', 'json', 'pdf', 'postscript', 'svg',
  ],
  音视频: [
    'mp4', 'mp3', 'mkv', 'wav', 'mov', 'avi', 'flac', 'aac', 'webm', 'm4a', 'ogg', 'wmv', 'wma',
    'flv', 'ts', 'mpeg', 'opus', 'aiff', 'amr', '3gp', 'ogv', 'rmvb', 'vob', 'asf',
    'bmp', 'jpg', 'png', 'tif', 'webp', 'gif',
  ],
  音频: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'aiff', 'amr'],
  视频: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'wmv', 'flv', 'ts', 'mpeg', 'ogv', 'rmvb', 'vob', '3gp', 'asf'],
  文档: [
    'pdf', 'docx', 'xlsx', 'pptx', 'markdown', 'html', 'text', 'epub', 'odt', 'rtf', 'csv', 'json',
    'doc', 'xls', 'ppt', 'ods', 'odp', 'fodt', 'fods', 'fodp', 'tex', 'latex', 'rst', 'org', 'adoc',
    'ipynb', 'typ', 'png', 'jpg', 'bmp', 'tif', 'gif', 'webp', 'xml', 'tsv', 'xlsm', 'docm', 'pptm',
    'native', 'man', 'mediawiki', 'textile', 'djot', 'docbook', 'bib', 'asciidoc', 'sxc', 'sxi',
    'sxw', 'wpd', 'wps', 'postscript',
  ],
  表格: ['csv', 'xlsx', 'tsv', 'json', 'html', 'markdown', 'xlsm', 'xls', 'ods'],
  文本: ['markdown', 'html', 'text', 'json', 'xml'],
  矢量图: ['svg', 'png', 'pdf', 'postscript', 'ai', 'dxf', 'emf', 'wmf', 'svgz', 'cdr', 'plt', 'bmp', 'jpg', 'tif', 'webp'],
  压缩包: ['zip', '7z', 'rar', 'tar', 'gz', 'gzip', 'xz', 'bz2', 'iso', 'cab', 'jar', 'tgz'],
  数据: ['json', 'csv', 'xlsx', 'markdown', 'html', 'xml', 'tsv'],
  其他: [],
};

/**
 * 规范名 → 显示用的扩展名。
 * 规范名不总是等于扩展名（markdown 的扩展名是 md，postscript 是 ps），
 * 直接大写会显示成「文本 MARKDOWN / HTML」，所以这里单独给一张表。
 */
const LABEL = {
  markdown: 'MD',
  text: 'TXT',
  postscript: 'PS',
  tif: 'TIFF',
  heif: 'HEIF',
  jpeg: 'JPG',
  mpeg: 'MPEG',
  asciidoc: 'ADOC',
  mediawiki: 'WIKI',
};

const AUDIO_EXT = new Set(['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'aiff', 'amr']);
const VIDEO_EXT = new Set(['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'mpeg', 'ts', 'ogv', 'rmvb', 'vob', '3gp', 'asf']);
const SHEET_EXT = new Set(['csv', 'tsv', 'xlsx', 'xlsm', 'xls', 'ods']);
const TEXT_EXT = new Set(['markdown', 'html', 'text', 'xml']);

/** 显示标签 */
function labelOf(ext) {
  return LABEL[ext] || String(ext).toUpperCase();
}

/** 归一化：统一走 canonicalFormat，再去重（别名会在这里被合并） */
function normExts(formats) {
  const out = [];
  for (const raw of formats || []) {
    const f = String(raw || '').trim().toLowerCase().replace(/^\./, '');
    if (!f || f === '*') continue;
    let canon = f;
    try {
      canon = canonicalFormat(f) || f;
    } catch {
      /* 认不出来的保持原样 */
    }
    canon = String(canon).toLowerCase();
    if (!out.includes(canon)) out.push(canon);
  }
  return out;
}

/** 类型名：以 kind 为准，media / data 按实际格式细化 */
function typeOf(kind, exts) {
  const set = new Set(exts);
  if (kind === 'media') {
    const hasAudio = exts.some((e) => AUDIO_EXT.has(e));
    const hasVideo = exts.some((e) => VIDEO_EXT.has(e));
    if (hasAudio && hasVideo) return '音视频';
    if (hasAudio) return '音频';
    if (hasVideo) return '视频';
    return '音视频';
  }
  if (kind === 'data') {
    if (exts.filter((e) => SHEET_EXT.has(e)).length) return '表格';
    if (exts.filter((e) => TEXT_EXT.has(e)).length) return '文本';
    return '数据';
  }
  if (kind === 'image' && set.has('svg') && exts.length <= 4) return '矢量图';
  return TYPE_BY_KIND[kind] || '其他';
}

/** 按典型度取前 N 个扩展名 */
function typicalExts(type, exts, limit) {
  const order = TYPICAL[type] || [];
  const rank = new Map(order.map((e, i) => [e, i]));
  const hit = exts.filter((e) => rank.has(e)).sort((a, b) => rank.get(a) - rank.get(b));
  const rest = exts.filter((e) => !rank.has(e));
  return hit.concat(rest).slice(0, limit);
}

/** 不含限定名的主名 */
function baseDisplayName(kind, formats) {
  const exts = normExts(formats);
  const type = typeOf(kind, exts);
  const picked = typicalExts(type, exts, 2);
  if (!picked.length) return type;
  return `${type} ${picked.map(labelOf).join(' / ')}`;
}

/**
 * 重名时用的限定名：优先取原名括号内的内容，否则取原名的第一个词。
 * 主名里已经出现该词（大小写不敏感）时退回 id，避免「矢量图 SVG / PDF（SVG）」这种废话。
 */
function qualifierOf(name, id, base) {
  const raw = String(name || '').trim();
  const paren = raw.match(/[（(]([^）)]+)[）)]\s*$/);
  let q = paren ? paren[1].trim() : '';
  if (!q) q = raw.split(/\s+/)[0] || '';
  q = q.replace(/[（(].*$/, '').trim();
  if (!q) q = String(id || '');
  if (base && q && base.toLowerCase().includes(q.toLowerCase())) q = String(id || q);
  return q;
}

/**
 * 给一批插件分配显示名。
 * @param {Array<{id:string, kind:string, name:string, formats:string[]}>} items
 * @returns {Map<string,string>} id → 显示名
 */
function assignDisplayNames(items) {
  const list = (items || []).filter(Boolean);
  const bases = list.map((it) => baseDisplayName(it.kind, it.formats));
  const counts = new Map();
  bases.forEach((b) => counts.set(b, (counts.get(b) || 0) + 1));

  const out = new Map();
  list.forEach((it, i) => {
    const base = bases[i];
    if (counts.get(base) <= 1) {
      out.set(it.id, base);
      return;
    }
    out.set(it.id, `${base}（${qualifierOf(it.name, it.id, base)}）`);
  });
  return out;
}

/** 从注册表的内核条目提取命名所需信息 */
function itemsFromKernels(entries) {
  return (entries || []).map((e) => {
    const m = (e && e.manifest) || {};
    const formats = new Set();
    for (const c of m.capabilities || []) {
      for (const f of c.from || []) if (f && f !== '*') formats.add(String(f).toLowerCase());
      for (const f of c.to || []) if (f && f !== '*') formats.add(String(f).toLowerCase());
    }
    return { id: e.id, kind: m.kind || 'other', name: m.name || e.id, formats: [...formats] };
  });
}

/** 从插件仓库的 catalog.json 提取命名所需信息（formats 由 make-catalog.js 生成） */
function itemsFromCatalog(catalog) {
  const list = (catalog && catalog.plugins) || [];
  return list.map((p) => {
    const f = p.formats || {};
    return {
      id: p.id,
      kind: p.kind || 'other',
      name: p.name || p.id,
      formats: [...new Set([...(f.from || []), ...(f.to || [])])],
    };
  });
}

/** 合并多组插件（按 id 去重，靠前的优先） */
function mergeItems(...lists) {
  const seen = new Map();
  for (const list of lists) {
    for (const it of list || []) if (it && it.id && !seen.has(it.id)) seen.set(it.id, it);
  }
  return [...seen.values()];
}

module.exports = {
  TYPE_BY_KIND,
  TYPICAL,
  LABEL,
  labelOf,
  normExts,
  typeOf,
  typicalExts,
  baseDisplayName,
  qualifierOf,
  assignDisplayNames,
  itemsFromKernels,
  itemsFromCatalog,
  mergeItems,
};
