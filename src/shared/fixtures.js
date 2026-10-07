'use strict';
/**
 * 示例素材生成的**实现**（零依赖：只用内置 zlib 手写 PNG/BMP/TGA/PPM 编码）。
 *
 * 放在 src/ 下而不是 tools/ 下，是因为打包后的应用也要用到它：
 *   · 欢迎页的「加载示例素材」
 *   · 打包版自检 `--selftest` 里的真实转换验证
 * tools/ 不会进包，所以实现必须在 src/ 里；tools/fixtures.js 只是它的转发壳。
 *
 * 顺带一个好处：素材生成不依赖任何内核是否装好 —— 第一次启动就能试。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

/* --------------------------------------------------------------- 位图工具 */

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 生成 RGBA 渐变 + 棋盘 + 色块图案 */
function pattern(width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y += 1) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const u = x / (width - 1 || 1);
      const v = y / (height - 1 || 1);
      const checker = (Math.floor(x / 24) + Math.floor(y / 24)) % 2 === 0 ? 18 : -12;
      let r = Math.round(40 + 200 * u + checker);
      let g = Math.round(60 + 150 * v + checker);
      let b = Math.round(180 + 60 * (1 - u) + checker);
      if (x < width * 0.35 && y > height * 0.6) {
        r = 250; g = 180; b = 60; // 暖色块
      }
      if (x > width * 0.7 && y < height * 0.3) {
        r = 60; g = 230; b = 170; // 青色块
      }
      const cx = x - width * 0.5;
      const cy = y - height * 0.5;
      if (cx * cx + cy * cy < (Math.min(width, height) * 0.14) ** 2) {
        r = 245; g = 245; b = 250; // 中心圆点
      }
      raw[o++] = Math.max(0, Math.min(255, r));
      raw[o++] = Math.max(0, Math.min(255, g));
      raw[o++] = Math.max(0, Math.min(255, b));
      raw[o++] = 255;
    }
  }
  return raw;
}

function writePng(file, width, height, opts = {}) {
  const raw = pattern(width, height);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: opts.level || 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  return file;
}

function writeBmp(file, width, height) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const buf = Buffer.alloc(54 + pixelBytes);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(54 + pixelBytes, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(pixelBytes, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  const raw = pattern(width, height);
  for (let y = 0; y < height; y += 1) {
    const srcRow = height - 1 - y;
    let dst = 54 + y * rowSize;
    for (let x = 0; x < width; x += 1) {
      const i = (srcRow * width + x) * 4;
      buf[dst++] = raw[i + 2];
      buf[dst++] = raw[i + 1];
      buf[dst++] = raw[i];
    }
  }
  fs.writeFileSync(file, buf);
  return file;
}

function writePpm(file, width, height) {
  const raw = pattern(width, height);
  const head = Buffer.from(`P6\n${width} ${height}\n255\n`, 'ascii');
  const body = Buffer.alloc(width * height * 3);
  let o = 0;
  for (let i = 0; i < raw.length; i += 4) {
    body[o++] = raw[i];
    body[o++] = raw[i + 1];
    body[o++] = raw[i + 2];
  }
  fs.writeFileSync(file, Buffer.concat([head, body]));
  return file;
}

function writeTga(file, width, height) {
  const header = Buffer.alloc(18);
  header[2] = 2; // uncompressed true-color
  header.writeUInt16LE(width, 12);
  header.writeUInt16LE(height, 14);
  header[16] = 24;
  header[17] = 0x20; // top-left origin
  const raw = pattern(width, height);
  const body = Buffer.alloc(width * height * 3);
  let o = 0;
  for (let i = 0; i < raw.length; i += 4) {
    body[o++] = raw[i + 2];
    body[o++] = raw[i + 1];
    body[o++] = raw[i];
  }
  fs.writeFileSync(file, Buffer.concat([header, body]));
  return file;
}

/* ------------------------------------------------------------- 文本类素材 */

const TABLE_ROWS = [
  ['id', 'name', 'category', 'score', 'updated', 'active'],
  ['1', 'Nebula Render', 'graphics', '94.5', '2025-01-04', 'true'],
  ['2', 'Quartz Pipeline', 'media', '88.1', '2025-01-09', 'true'],
  ['3', 'Vertex Cache', 'graphics', '76.8', '2025-02-11', 'false'],
  ['4', 'Signal Router', 'network', '91.2', '2025-02-18', 'true'],
  ['5', 'Delta Encoder', 'media', '83.4', '2025-03-02', 'true'],
  ['6', 'Lumen Index', 'data', '69.9', '2025-03-21', 'false'],
];

function toCsv(rows) {
  return rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n') + '\n';
}

function toTsv(rows) {
  return rows.map((r) => r.join('\t')).join('\n') + '\n';
}

function toJson(rows) {
  const head = rows[0];
  const objs = rows.slice(1).map((r) => {
    const o = {};
    head.forEach((k, i) => {
      const v = r[i];
      o[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v === 'true' ? true : v === 'false' ? false : v;
    });
    return o;
  });
  return JSON.stringify({ generated: new Date().toISOString(), rows: objs }, null, 2);
}

function toMarkdown(rows) {
  const [head, ...body] = rows;
  return [
    '# KernelHub Studio 示例数据',
    '',
    '> 由 `tools/fixtures.js` 生成，可直接用于内核自检。',
    '',
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
    '',
    '## 说明',
    '',
    '- 这个文件用于验证 `data-table` / `text-markup` 类内核',
    '- 格式：CSV / TSV / JSON / Markdown / HTML 互转',
    '',
  ].join('\n');
}

function toHtml(rows) {
  const [head, ...body] = rows;
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>KernelHub 示例表格</title>
<style>body{font:14px/1.6 system-ui,sans-serif;margin:32px;color:#111}
table{border-collapse:collapse}th,td{border:1px solid #d0d7de;padding:6px 12px}
th{background:#f6f8fa;text-align:left}caption{text-align:left;font-weight:600;padding-bottom:8px}</style></head>
<body><table><caption>示例数据</caption>
<thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
</table></body></html>
`;
}

function writeSvg(file) {
  const w = 640;
  const h = 400;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4f8cff"/><stop offset="1" stop-color="#22d3ee"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="#0b1020"/>
  <circle cx="180" cy="150" r="96" fill="url(#g)" opacity="0.92"/>
  <rect x="300" y="80" width="260" height="150" rx="18" fill="none" stroke="#22d3ee" stroke-width="3"/>
  <path d="M60 340 L200 240 L330 320 L520 200" fill="none" stroke="#fbbf24" stroke-width="4" stroke-linejoin="round"/>
  <text x="60" y="60" fill="#e6edf7" font-family="system-ui, sans-serif" font-size="30">KernelHub Studio</text>
  <text x="60" y="92" fill="#8ea1c0" font-family="system-ui, sans-serif" font-size="15">SVG 矢量示例素材</text>
</svg>
`;
  fs.writeFileSync(file, svg, 'utf8');
  return file;
}

function writeTxt(file) {
  const lines = [];
  for (let i = 1; i <= 40; i += 1) {
    lines.push(`${String(i).padStart(3, '0')}  KernelHub Studio 纯文本素材行，用于验证文本类内核的编码与换行处理。`);
  }
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

/* ------------------------------------------------------------------ 入口 */

/**
 * 在 targetDir 生成示例素材，返回生成的文件路径列表。
 * hubRoot 可选：若存在 tools/make_fixtures.py 会额外调用（失败不影响主流程）。
 */
function makeFixtures(targetDir, { hubRoot = '', python = '' } = {}) {
  fs.mkdirSync(targetDir, { recursive: true });
  const out = [];
  const j = (name) => path.join(targetDir, name);

  out.push(writePng(j('gradient-640x400.png'), 640, 400));
  out.push(writePng(j('gradient-128x128.png'), 128, 128));
  out.push(writeBmp(j('pattern-320x200.bmp'), 320, 200));
  out.push(writePpm(j('pattern-200x150.ppm'), 200, 150));
  out.push(writeTga(j('pattern-160x120.tga'), 160, 120));
  out.push(writeSvg(j('vector-card.svg')));
  out.push(writeTxt(j('notes-utf8.txt')));

  const csv = j('records.csv');
  fs.writeFileSync(csv, toCsv(TABLE_ROWS), 'utf8');
  out.push(csv);

  const tsv = j('records.tsv');
  fs.writeFileSync(tsv, toTsv(TABLE_ROWS), 'utf8');
  out.push(tsv);

  const json = j('records.json');
  fs.writeFileSync(json, toJson(TABLE_ROWS), 'utf8');
  out.push(json);

  const md = j('records.md');
  fs.writeFileSync(md, toMarkdown(TABLE_ROWS), 'utf8');
  out.push(md);

  const html = j('records.html');
  fs.writeFileSync(html, toHtml(TABLE_ROWS), 'utf8');
  out.push(html);

  if (hubRoot && python) {
    const script = path.join(hubRoot, 'tools', 'make_fixtures.py');
    if (fs.existsSync(script)) {
      try {
        execFileSync(python, [script], { cwd: hubRoot, timeout: 120000, stdio: 'ignore', windowsHide: true });
      } catch {
        /* 生成更丰富的素材是加分项，失败不影响 */
      }
    }
  }
  return out;
}

module.exports = { makeFixtures, writePng, writeBmp, writeSvg, TABLE_ROWS, toCsv };

if (require.main === module) {
  const dir = process.argv[2] || path.join(process.cwd(), 'examples');
  const files = makeFixtures(dir);
  console.log(`已生成 ${files.length} 个示例素材 → ${dir}`);
  for (const f of files) console.log('  ' + path.basename(f));
}
