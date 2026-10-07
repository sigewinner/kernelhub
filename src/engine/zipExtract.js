'use strict';
/**
 * 极简 ZIP 解压器（零第三方依赖）。
 *
 * 为什么自己写：项目坚持「零运行时依赖」（package.json 的 dependencies 是空的），
 * 而插件在用户机器上没有 git 时，需要从 GitHub Release 下载 zip 再解压 ——
 * Node 内置只有 zlib（能 inflate），没有 zip 容器解析，所以这里补上。
 *
 * 实现要点（只做解压，不做压缩）：
 *   - 从文件尾部回扫 End of Central Directory（EOCD，0x06054b50）确定中央目录位置
 *   - 读中央目录条目（0x02014b50）拿文件名 / 压缩方式 / 大小 / 本地头偏移
 *     —— 用中央目录而不是本地头，是为了同时支持「带 data descriptor」的 zip
 *       （那种 zip 的本地头里大小字段是 0，流式写入的 zip 很常见）
 *   - 按本地头（0x04034b50）里的 name/extra 长度算出数据真实偏移
 *   - method 0 直接拷贝，method 8 用 zlib.inflateRawSync
 *   - 拒绝越界路径（zip slip）：条目名里出现 .. 或绝对路径一律丢弃
 *
 * 不支持：加密（ZipCrypto/AES）、ZIP64（>4GB）、多卷。插件包用不到。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** 从尾部回扫 EOCD。注释区最长 65535，所以最多回扫 65557 字节 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - (65535 + 22));
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * 解析 zip 的中央目录。
 * @returns {Array<{name:string, method:number, compressedSize:number, size:number, localOffset:number, isDir:boolean}>}
 */
function readCentralDirectory(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 zip：找不到 EOCD');
  const total = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const entries = [];
  for (let i = 0; i < total; i += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== SIG_CENTRAL) break;
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const nameBytes = buf.subarray(offset + 46, offset + 46 + nameLen);
    // bit 11 = 文件名为 UTF-8；否则按 CP437，但我们的包都是 ASCII 路径，直接 utf8 读
    const name = nameBytes.toString(flags & 0x800 ? 'utf8' : 'utf8');

    entries.push({
      name: name.replace(/\\/g, '/'),
      method,
      compressedSize,
      size,
      localOffset,
      isDir: name.endsWith('/'),
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 条目名安全性：挡掉 zip slip 与绝对路径 */
function safeRelativeName(name) {
  if (!name) return '';
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return '';
  const parts = name.split('/').filter((p) => p && p !== '.');
  if (!parts.length) return '';
  if (parts.some((p) => p === '..')) return '';
  return parts.join('/');
}

/** 取出单个条目的原始数据 */
function readEntry(buf, entry) {
  const off = entry.localOffset;
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== SIG_LOCAL) {
    throw new Error(`条目本地头损坏: ${entry.name}`);
  }
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const start = off + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > buf.length) throw new Error(`条目数据越界: ${entry.name}`);
  const raw = buf.subarray(start, end);
  if (entry.method === METHOD_STORE) return Buffer.from(raw);
  if (entry.method === METHOD_DEFLATE) return zlib.inflateRawSync(raw);
  throw new Error(`不支持的压缩方式 ${entry.method}（条目 ${entry.name}）`);
}

/**
 * 把 zip 解压到目标目录。
 * @param {string} zipPath
 * @param {string} destDir
 * @param {(info:{done:number,total:number,name:string})=>void} [onProgress]
 * @returns {{files:number, bytes:number, skipped:string[]}}
 */
function extractZip(zipPath, destDir, onProgress) {
  const buf = fs.readFileSync(zipPath);
  const entries = readCentralDirectory(buf);
  const skipped = [];
  let files = 0;
  let bytes = 0;

  entries.forEach((entry, idx) => {
    const rel = safeRelativeName(entry.name);
    if (!rel) {
      if (entry.name && !entry.isDir) skipped.push(entry.name);
      return;
    }
    const target = path.join(destDir, rel);
    if (entry.isDir) {
      fs.mkdirSync(target, { recursive: true });
      return;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const data = readEntry(buf, entry);
    fs.writeFileSync(target, data);
    files += 1;
    bytes += data.length;
    if (onProgress && (idx % 25 === 0 || idx === entries.length - 1)) {
      onProgress({ done: idx + 1, total: entries.length, name: rel });
    }
  });

  return { files, bytes, skipped };
}

/** 只列条目，不解压（用于预览 / 校验包内容） */
function listZip(zipPath) {
  const buf = fs.readFileSync(zipPath);
  return readCentralDirectory(buf).map((e) => ({
    name: e.name,
    size: e.size,
    compressedSize: e.compressedSize,
    method: e.method,
    isDir: e.isDir,
  }));
}

module.exports = { extractZip, listZip, readCentralDirectory, safeRelativeName };
