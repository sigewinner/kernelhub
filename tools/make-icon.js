'use strict';
/**
 * 生成应用图标（零依赖，手写 PNG 编码 + ICO 封装）。
 *
 *   node tools/make-icon.js
 *
 * 产出：
 *   build/icon.ico    16/24/32/48/64/128/256 多尺寸（electron-builder 打包用）
 *   build/icon-256.png 预览图（文档/README 用）
 *
 * 图形：圆角方块 + 青蓝渐变 + 白色「协议层叠」标记（对应应用的立方体 logo）。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'build');

/* ----------------------------------------------------------------- PNG 编码 */

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

function pngFromRgba(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let o = 0;
  for (let y = 0; y < size; y += 1) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      raw[o++] = rgba[i];
      raw[o++] = rgba[i + 1];
      raw[o++] = rgba[i + 2];
      raw[o++] = rgba[i + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ 图形绘制 */

/** 超采样抗锯齿：以 scale 倍分辨率绘制后平均降采样 */
function renderIcon(size, scale = 4) {
  const S = size * scale;
  const buf = new Float32Array(S * S * 4);

  const put = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    const src = a / 255;
    const dst = buf[i + 3] / 255;
    const outA = src + dst * (1 - src);
    if (outA <= 0) return;
    buf[i] = (r * src + buf[i] * dst * (1 - src)) / outA;
    buf[i + 1] = (g * src + buf[i + 1] * dst * (1 - src)) / outA;
    buf[i + 2] = (b * src + buf[i + 2] * dst * (1 - src)) / outA;
    buf[i + 3] = outA * 255;
  };

  const inRoundRect = (x, y, l, t, w, h, r) => {
    const cx = Math.min(Math.max(x, l + r), l + w - r);
    const cy = Math.min(Math.max(y, t + r), t + h - r);
    const dx = x - cx;
    const dy = y - cy;
    if (x >= l && x <= l + w && y >= t + r && y <= t + h - r) return true;
    if (y >= t && y <= t + h && x >= l + r && x <= l + w - r) return true;
    return dx * dx + dy * dy <= r * r;
  };

  // 背景：圆角方块 + 左上→右下渐变（青蓝 #4f8cff → #22d3ee）
  const pad = S * 0.045;
  const boxW = S - pad * 2;
  const radius = boxW * 0.24;
  for (let y = 0; y < S; y += 1) {
    for (let x = 0; x < S; x += 1) {
      if (!inRoundRect(x, y, pad, pad, boxW, boxW, radius)) continue;
      const t = (x / S) * 0.55 + (y / S) * 0.45;
      // 深色底 → 青蓝，保证小尺寸下也有足够对比
      const r = Math.round(28 + (34 - 28) * t + (1 - t) * 40);
      const g = Math.round(48 + (140 - 48) * t);
      const b = Math.round(90 + (238 - 90) * t);
      put(x, y, r, g, b, 255);
    }
  }

  // logo：一个立方体线框 + 中轴（与界面标题栏的 mark 一致）
  const cx = S / 2;
  const cy = S / 2;
  const R = boxW * 0.30;
  const th = Math.max(scale * 1.6, S * 0.028); // 线宽
  const white = [238, 246, 255];

  const line = (x1, y1, x2, y2, w, color, alpha = 255) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const minX = Math.floor(Math.min(x1, x2) - w - 2);
    const maxX = Math.ceil(Math.max(x1, x2) + w + 2);
    const minY = Math.floor(Math.min(y1, y2) - w - 2);
    const maxY = Math.ceil(Math.max(y1, y2) + w + 2);
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const px = x - x1;
        const py = y - y1;
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (len * len)));
        const ox = px - dx * t;
        const oy = py - dy * t;
        const d = Math.abs(ox * nx + oy * ny);
        if (d <= w) {
          const a = Math.round(alpha * Math.min(1, (w - d) / (w * 0.55) + 0.25));
          put(x, y, color[0], color[1], color[2], Math.min(255, a));
        }
      }
    }
  };

  // 六边形立方体：顶点为上下两个六边形的 6 个角 + 中间三条棱
  const pts = [];
  for (let k = 0; k < 6; k += 1) {
    const ang = (Math.PI / 3) * k - Math.PI / 6;
    pts.push([cx + R * Math.cos(ang), cy + R * 0.62 * Math.sin(ang) - R * 0.18]);
  }
  for (let k = 0; k < 6; k += 1) {
    const a = pts[k];
    const b = pts[(k + 1) % 6];
    line(a[0], a[1], b[0], b[1], th, white, 235);
  }
  // 上盖与竖棱：把上三点连到中心上方一点，形成立体感
  for (let k = 0; k < 6; k += 1) {
    if (k % 2 === 0) continue;
    line(pts[k][0], pts[k][1], cx, cy - R * 0.18, th * 0.85, white, 180);
  }

  // 降采样
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const i = ((y * scale + sy) * S + (x * scale + sx)) * 4;
          r += buf[i];
          g += buf[i + 1];
          b += buf[i + 2];
          a += buf[i + 3];
        }
      }
      const n = scale * scale;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

/* ------------------------------------------------------------------- ICO 封装 */

/** ICO 里内嵌 PNG（Vista+ 支持）；小尺寸用 32bpp BMP 更兼容，这里统一用 PNG 并附 BMP 兜底 */
function icoFromPngs(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(count, 4);

  const dirs = [];
  let offset = 6 + count * 16;
  const blobs = [];
  for (const { size, png } of entries) {
    const dir = Buffer.alloc(16);
    dir[0] = size >= 256 ? 0 : size; // 256 记 0
    dir[1] = size >= 256 ? 0 : size;
    dir[2] = 0; // palette
    dir[3] = 0; // reserved
    dir.writeUInt16LE(1, 4); // color planes
    dir.writeUInt16LE(32, 6); // bpp
    dir.writeUInt32LE(png.length, 8);
    dir.writeUInt32LE(offset, 12);
    dirs.push(dir);
    blobs.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...dirs, ...blobs]);
}

/* ---------------------------------------------------------------------- main */

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const entries = sizes.map((size) => ({ size, png: pngFromRgba(renderIcon(size, size <= 48 ? 8 : 4), size) }));

  const ico = icoFromPngs(entries);
  const icoPath = path.join(OUT_DIR, 'icon.ico');
  fs.writeFileSync(icoPath, ico);

  const png256 = entries.find((e) => e.size === 256).png;
  const pngPath = path.join(OUT_DIR, 'icon-256.png');
  fs.writeFileSync(pngPath, png256);

  // 顺便给界面用的 64px 预览
  const png64 = entries.find((e) => e.size === 64).png;
  fs.writeFileSync(path.join(OUT_DIR, 'icon-64.png'), png64);

  console.log(`[make-icon] ${path.relative(ROOT, icoPath)}  ${(ico.length / 1024).toFixed(1)} KB  (${sizes.join('/')})`);
  console.log(`[make-icon] ${path.relative(ROOT, pngPath)}  ${(png256.length / 1024).toFixed(1)} KB`);
}

main();
