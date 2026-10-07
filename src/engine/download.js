'use strict';
/**
 * 多连接并发 HTTP 下载器（零第三方依赖）。
 *
 * 为什么要它：插件的 zip 动辄几十 MB（ffmpeg-media 83 MB），单连接下载既慢，
 * 而且之前把整包读进内存再一次性写盘会让主进程长时间阻塞 —— 界面卡死。
 * 这里做三件事：
 *   1. **多连接分片**：先探测服务端是否支持 Range，支持就切成 N 段并发下载，
 *      各自带独立重试；不支持就老实单连接流式下载。
 *   2. **流式落盘**：边收边写（写入到目标文件的指定偏移），不在内存里囤整包。
 *   3. **全程异步**：不阻塞事件循环，下载期间界面照常响应。
 *
 * GitHub Release 资产的直链（objects.githubusercontent.com）支持 Range，
 * 所以分片是有效的；若某次不支持，会自动退回单流，不会失败。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const DEFAULT_CONNS = 4;
const MIN_CHUNK = 1024 * 1024; // 小于这个大小就不值得分片了

/** 建一次请求，跟随重定向，返回最终响应 */
function request(url, headers = {}, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 10) {
      reject(new Error('重定向次数过多'));
      return;
    }
    const req = https.get(url, { headers: { 'User-Agent': 'kernelhub-studio', ...headers } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        resolve(request(new URL(res.headers.location, url).toString(), headers, depth + 1));
        return;
      }
      if (status >= 400) {
        res.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('连接超时（60 秒无响应）')));
  });
}

/** 探测：能不能分片？总量多大？ */
async function probe(url, headers = {}) {
  const res = await request(url, { ...headers, Range: 'bytes=0-0' });
  const cr = res.headers['content-range'] || '';
  const m = cr.match(/bytes\s+\d+-\d+\/(\d+)/i);
  const total = m ? Number(m[1]) : Number(res.headers['content-length'] || 0);
  const ranged = res.statusCode === 206 && Boolean(m);
  res.resume();
  return { total, ranged, acceptRanges: String(res.headers['accept-ranges'] || '').toLowerCase() === 'bytes' };
}

/** 把一段字节流写到文件的指定偏移 */
function downloadRange(url, headers, start, end, fd, onBytes) {
  return new Promise((resolve, reject) => {
    request(url, { ...headers, Range: `bytes=${start}-${end}` })
      .then((res) => {
        if (res.statusCode !== 206 && res.statusCode !== 200) {
          res.resume();
          reject(new Error(`分片 HTTP ${res.statusCode}`));
          return;
        }
        let position = start;
        res.on('data', (chunk) => {
          // 每个分片写到自己的区间；并发写不同偏移是安全的
          try {
            fs.writeSync(fd, chunk, 0, chunk.length, position);
          } catch (err) {
            res.destroy();
            reject(err);
            return;
          }
          position += chunk.length;
          onBytes(chunk.length);
        });
        res.on('end', () => resolve(position));
        res.on('error', reject);
      })
      .catch(reject);
  });
}

/**
 * 下载到文件。
 * @param {string} url
 * @param {string} dest
 * @param {object} opts
 *   headers   额外请求头
 *   conns     并发连接数（默认 4；1 表示单连接）
 *   onProgress({received,total,percent,conns,phase})
 *   retries   每段重试次数（默认 3）
 */
async function downloadToFile(url, dest, opts = {}) {
  const { headers = {}, conns = DEFAULT_CONNS, onProgress = () => {}, retries = 3 } = opts;

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const info = await probe(url, headers);

  // 单连接路径：服务端不支持 Range，或文件太小，或用户要求单连接
  const useMulti = info.ranged && info.total > MIN_CHUNK && conns > 1;
  if (!useMulti) {
    const res = await request(url, headers);
    const total = Number(res.headers['content-length'] || info.total || 0);
    let received = 0;
    const out = fs.createWriteStream(dest);
    await new Promise((resolve, reject) => {
      res.on('data', (chunk) => {
        received += chunk.length;
        onProgress({ received, total, percent: total ? Math.round((received / total) * 100) : 0, conns: 1, phase: 'download' });
      });
      res.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      res.on('error', reject);
    });
    return { bytes: received, conns: 1, ranged: false };
  }

  // 多连接分片
  const total = info.total;
  const n = Math.min(conns, Math.max(1, Math.ceil(total / MIN_CHUNK)));
  const chunkSize = Math.ceil(total / n);
  const parts = [];
  for (let i = 0; i < n; i += 1) {
    const start = i * chunkSize;
    const end = Math.min(total - 1, start + chunkSize - 1);
    if (start <= end) parts.push({ start, end, got: 0 });
  }

  // 预分配，避免边写边扩张
  const fd = fs.openSync(dest, 'w');
  try {
    fs.ftruncateSync(fd, total);
  } catch {
    /* 某些文件系统不支持，忽略 */
  }

  let received = 0;
  let lastEmit = 0;
  const emit = (force) => {
    const now = Date.now();
    if (!force && now - lastEmit < 120) return;
    lastEmit = now;
    onProgress({
      received,
      total,
      percent: Math.round((received / total) * 100),
      conns: parts.length,
      phase: 'download',
    });
  };

  try {
    await Promise.all(
      parts.map(async (part) => {
        let lastErr = null;
        for (let attempt = 1; attempt <= retries; attempt += 1) {
          try {
            await downloadRange(url, headers, part.start + part.got, part.end, fd, (n2) => {
              part.got += n2;
              received += n2;
              emit(false);
            });
            return;
          } catch (err) {
            lastErr = err;
            // 这一段的进度作废（可能写了一半），整段重下
            received -= part.got;
            part.got = 0;
            emit(true);
            if (attempt < retries) await new Promise((r) => setTimeout(r, 300 * attempt));
          }
        }
        throw new Error(`分片 ${part.start}-${part.end} 下载失败：${String((lastErr && lastErr.message) || lastErr)}`);
      })
    );
    emit(true);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }

  return { bytes: received, conns: parts.length, ranged: true };
}

module.exports = { downloadToFile, probe, DEFAULT_CONNS };
