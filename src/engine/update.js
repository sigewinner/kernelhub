'use strict';
/**
 * update.js —— 检测更新与更新（2.2.0）
 *
 * 规则（按用户要求）：**只看同一个大版本**。
 * 例如当前是 2.2.0，就去 GitHub Release 里找所有 2.x.x，取版本号最大的那个；
 * 3.x.x 不会被当成「更新」推给用户（跨大版本可能有破坏性改动，得由用户自己决定）。
 *
 * 检测走 api.github.com（本项目所在网络环境下它比 github.com 稳得多）。
 * 下载安装包复用 download.js 的多连接分片下载器，完成后交给调用方决定是否启动。
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const { downloadToFile } = require('./download');

const UA = 'KernelHub-Studio-Updater';

/** 'v2.2.0' / '2.2.0-beta.1' → { major, minor, patch } */
function parseVersion(value) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value || '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** 比较两个版本号：a > b 返回 1，相等 0，小于 -1 */
function compareVersion(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return 0;
  for (const key of ['major', 'minor', 'patch']) {
    if (va[key] !== vb[key]) return va[key] > vb[key] ? 1 : -1;
  }
  return 0;
}

/** 简单的 HTTPS GET，返回解析后的 JSON（自动跟随重定向） */
function httpsGetJson(url, { timeout = 20000, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': UA,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume();
          httpsGetJson(res.headers.location, { timeout, redirects: redirects - 1 }).then(resolve, reject);
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}：${text.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(new Error(`响应不是 JSON：${text.slice(0, 160)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
    req.end();
  });
}

/**
 * 从 release 列表里挑出「同一个大版本里最新的一个」。
 * @param {Array} releases GitHub /releases 的返回
 * @param {number} major 当前大版本
 */
function pickLatestForMajor(releases, major) {
  let best = null;
  let bestVersion = null;
  for (const rel of Array.isArray(releases) ? releases : []) {
    if (!rel || rel.draft || rel.prerelease) continue;
    const version = parseVersion(rel.tag_name || rel.name);
    if (!version || version.major !== major) continue;
    if (!bestVersion || compareVersion(rel.tag_name, best.tag_name) > 0) {
      best = rel;
      bestVersion = version;
    }
  }
  return best;
}

/** 从 release 资产里挑安装包（优先 setup.exe） */
function pickInstallerAsset(release) {
  const assets = (release && release.assets) || [];
  const score = (name) =>
    /setup\.exe$/i.test(name) ? 0 : /portable\.exe$/i.test(name) ? 2 : /\.exe$/i.test(name) ? 1 : 9;
  const usable = assets
    .filter((a) => a && a.name && a.browser_download_url)
    .sort((a, b) => score(a.name) - score(b.name));
  return usable.find((a) => /\.exe$/i.test(a.name)) || null;
}

/**
 * 检测更新。
 * @param {object} opts
 * @param {string} opts.current 当前版本（如 '2.2.0'）
 * @param {string} [opts.repoSlug] owner/repo
 * @returns {Promise<{ok:boolean, current:string, latest?:string, hasUpdate?:boolean, error?:string, ...}>}
 */
async function checkForUpdate({ current, repoSlug = 'sigewinner/kernelhub' } = {}) {
  const cur = parseVersion(current);
  if (!cur) return { ok: false, current: String(current || ''), error: '当前版本号无法解析' };

  let releases;
  try {
    releases = await httpsGetJson(`https://api.github.com/repos/${repoSlug}/releases?per_page=40`);
  } catch (err) {
    return { ok: false, current: String(current || ''), error: String(err && err.message ? err.message : err) };
  }
  if (!Array.isArray(releases)) {
    return { ok: false, current: String(current || ''), error: '返回格式异常' };
  }

  const sameMajor = releases
    .filter((r) => {
      const v = parseVersion(r && r.tag_name);
      return v && v.major === cur.major && !r.draft && !r.prerelease;
    })
    .map((r) => r.tag_name);
  const latestRelease = pickLatestForMajor(releases, cur.major);

  if (!latestRelease) {
    return {
      ok: true,
      current: String(current),
      latest: String(current),
      hasUpdate: false,
      sameMajorVersions: sameMajor,
      note: `GitHub 上没有找到 ${cur.major}.x 的正式版本`,
    };
  }

  const latest = String(latestRelease.tag_name || '').replace(/^v/, '');
  const hasUpdate = compareVersion(latest, current) > 0;
  const asset = pickInstallerAsset(latestRelease);
  return {
    ok: true,
    current: String(current),
    latest,
    hasUpdate,
    sameMajorVersions: sameMajor,
    major: cur.major,
    url: latestRelease.html_url || '',
    name: latestRelease.name || '',
    notes: String(latestRelease.body || '').slice(0, 4000),
    publishedAt: latestRelease.published_at || '',
    asset: asset
      ? { name: asset.name, size: Number(asset.size) || 0, url: asset.url, browserUrl: asset.browser_download_url }
      : null,
  };
}

/**
 * 下载安装包到目标目录。
 * @param {object} opts
 * @param {{url:string,name:string,size:number}} opts.asset
 * @param {string} opts.dir 目标目录
 * @param {(info:{received:number,total:number,percent:number})=>void} [opts.onProgress]
 */
async function downloadInstaller({ asset, dir, onProgress } = {}) {
  if (!asset || !asset.url) return { ok: false, error: '没有可下载的安装包' };
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, String(asset.name || 'KernelHub-Studio-setup.exe'));
  try {
    // 走 API 资产地址 + octet-stream：它会 302 到对象存储，download.js 会跟随重定向
    await downloadToFile(asset.url, target, {
      headers: { 'User-Agent': UA, Accept: 'application/octet-stream' },
      onProgress: (info) => {
        if (typeof onProgress !== 'function') return;
        const received = Number(info && info.received) || 0;
        const total = Number(info && info.total) || Number(asset.size) || 0;
        onProgress({ received, total, percent: total ? Math.round((received / total) * 100) : 0 });
      },
    });
    const bytes = fs.statSync(target).size;
    return { ok: true, path: target, bytes };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err), path: target };
  }
}

module.exports = {
  parseVersion,
  compareVersion,
  pickLatestForMajor,
  pickInstallerAsset,
  checkForUpdate,
  downloadInstaller,
  httpsGetJson,
};
