'use strict';
/**
 * 插件商店：目录拉取 + 安装 / 卸载 / 更新。
 *
 * 2.0.0 的「壳 + 按需插件」靠这个模块落地：
 *   - 壳里没有任何内核，插件来自独立仓库 sigewinner/kernelhub-plugins
 *   - 应用拉 catalog.json 得到「有哪些插件、多大、内容哈希」
 *   - 用户勾选后按需下载到 <hubRoot>/plugins/<id>/，随装随用
 *
 * 下载策略（git 优先，HTTPS 回退 —— 由 detectGit() 自动选择）：
 *   git   : clone --filter=blob:none --sparse --depth 1 + sparse-checkout set <path>
 *           —— 只会下载选中的那个插件目录，不碰另外 18 个
 *   https : 从插件仓库 Release 资产下载 <id>-<version>.zip，用内置 zipExtract 解压
 *           —— 用户机器上没装 git 时的兜底
 *
 * 两种方式装完都会做**内容树哈希**校验（与 tools/make-catalog.js 算法一致），
 * 不一致就当作安装失败并清掉，避免半个插件留在磁盘上。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { execFileSync, spawn } = require('child_process');

const { isDir, isFile, pluginsDirOf } = require('./paths');
const { findOnPath } = require('./python');
const { extractZipAsync, listZip } = require('./zipExtract');
const { downloadToFile } = require('./download');

const DEFAULT_REPO = 'https://github.com/sigewinner/kernelhub-plugins.git';
const DEFAULT_CATALOG = 'https://raw.githubusercontent.com/sigewinner/kernelhub-plugins/main/catalog.json';
const DEFAULT_BUNDLE = 'https://github.com/sigewinner/kernelhub-plugins/releases/download/plugin-bundles/{id}-{version}.zip';

/* ------------------------------------------------------------------ 工具 */

function walkFiles(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, base, out);
    else out.push(path.relative(base, p).replace(/\\/g, '/'));
  }
  return out;
}

/**
 * 内容树哈希 —— 必须与插件仓库 tools/make-catalog.js 完全一致，
 * 否则校验永远失败。规则：文件按相对路径排序，依次喂 `路径\0文件sha256\n`。
 */
function treeHash(dir) {
  const files = walkFiles(dir).sort();
  const h = crypto.createHash('sha256');
  let bytes = 0;
  for (const rel of files) {
    const abs = path.join(dir, rel);
    let data;
    try {
      data = fs.readFileSync(abs);
    } catch {
      continue;
    }
    bytes += data.length;
    h.update(rel);
    h.update('\0');
    h.update(crypto.createHash('sha256').update(data).digest('hex'));
    h.update('\n');
  }
  return { hash: h.digest('hex'), files: files.length, bytes };
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* 尽力而为 */
  }
}

/** 递归复制目录（Node 16.7+ 自带 cpSync，这里保留兼容分支） */
function copyDir(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (typeof fs.cpSync === 'function') {
    fs.cpSync(src, dst, { recursive: true });
    return;
  }
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * 异步版递归复制。
 *
 * 安装插件时必须用这个：插件包动辄几百上千个文件（office-text 808 个），
 * 同步复制会把主进程占住，界面表现为「未响应」。
 */
async function copyDirAsync(src, dst) {
  await fs.promises.mkdir(path.dirname(dst), { recursive: true });
  await fs.promises.cp(src, dst, { recursive: true });
}

/** HTTPS GET，跟随重定向（GitHub Release 资产会跳到 objects.githubusercontent.com） */
function httpGet(url, { onProgress, depth = 0, headers = {}, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    if (depth > 10) {
      reject(new Error('重定向次数过多'));
      return;
    }
    const req = https.get(url, { headers: { 'User-Agent': 'kernelhub-studio', ...headers } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        resolve(httpGet(new URL(res.headers.location, url).toString(), { onProgress, depth: depth + 1, headers, timeout }));
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status}：${url}`));
        return;
      }
      const total = Number(res.headers['content-length'] || 0);
      let received = 0;
      const chunks = [];
      res.on('data', (c) => {
        chunks.push(c);
        received += c.length;
        if (onProgress && total) onProgress({ received, total, percent: Math.round((received / total) * 100) });
      });
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), bytes: received }));
      res.on('error', reject);
    });
    req.on('error', reject);
    // 空闲超时：连接建立不上、或中途卡住都会在这里被中断，避免整个安装卡死
    req.setTimeout(timeout, () => {
      req.destroy(new Error(`请求超时（${Math.round(timeout / 1000)} 秒无响应）`));
    });
  });
}

/* ------------------------------------------------------------------ 主体 */

class PluginStore {
  /**
   * @param {object} opts
   * @param {string} opts.hubRoot   插件安装目标工作区
   * @param {string} opts.stateDir  应用状态目录（缓存与临时文件放这里）
   * @param {object} opts.settings  Settings 实例
   */
  constructor(opts = {}) {
    this.hubRoot = path.resolve(opts.hubRoot || '.');
    this.stateDir = path.resolve(opts.stateDir || path.join(os.homedir(), '.kernelhub-studio'));
    this.settings = opts.settings || null;
    this.catalogCache = path.join(this.stateDir, 'plugin-catalog.json');
    this.tmpDir = path.join(this.stateDir, 'tmp');
    this._catalog = null;
    this._gitPath = undefined;
  }

  get pluginsDir() {
    return pluginsDirOf(this.hubRoot);
  }

  get repoUrl() {
    return (this.settings && this.settings.get('pluginRepoUrl', '')) || DEFAULT_REPO;
  }

  get catalogUrl() {
    return (this.settings && this.settings.get('pluginCatalogUrl', '')) || DEFAULT_CATALOG;
  }

  get bundleUrlTemplate() {
    return (this.settings && this.settings.get('pluginBundleUrl', '')) || DEFAULT_BUNDLE;
  }

  /** `owner/repo`，供 api.github.com 用；从 repoUrl 里解析出来 */
  get repoSlug() {
    const configured = (this.settings && this.settings.get('pluginRepoSlug', '')) || '';
    if (configured) return String(configured).replace(/^\/+|\/+$/g, '');
    const m = String(this.repoUrl).match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
    return m ? `${m[1]}/${m[2]}` : '';
  }

  /** 存放 zip 的 Release 标签 */
  get bundleTag() {
    return (this.settings && this.settings.get('pluginBundleTag', '')) || 'plugin-bundles';
  }

  /**
   * 候选下载地址（按优先级）。
   *
   * 为什么要搞成多候选：GitHub 的 release 下载入口是 `github.com`，
   * 而部分网络下这个域名会不可达，但 `api.github.com` 与
   * `objects.githubusercontent.com` 是通的。所以优先用 API 解析出资产直链
   * （带 Accept: application/octet-stream 会 302 到真实存储），
   * 直连地址只作为兜底；用户还可用 pluginBundleUrl 指定镜像。
   */
  async _bundleCandidates(id, version) {
    const name = `${id}-${version}.zip`;
    const out = [];

    const override = this.settings ? this.settings.get('pluginBundleUrl', '') : '';
    if (override) {
      out.push({ label: '自定义地址', url: String(override).replace('{id}', id).replace('{version}', version) });
    }

    const slug = this.repoSlug;
    if (slug) {
      // 1) 先用缓存的资产 id，省掉 api 配额
      const cached = this._readAssetCache()[`${this.bundleTag}|${name}`];
      if (cached) {
        out.push({
          label: 'API 直链（缓存）',
          url: `https://api.github.com/repos/${slug}/releases/assets/${cached}`,
          headers: { Accept: 'application/octet-stream' },
        });
      }
      // 2) 现查一次
      try {
        const { buffer } = await httpGet(`https://api.github.com/repos/${slug}/releases/tags/${this.bundleTag}`, {
          timeout: 30000,
          headers: { Accept: 'application/vnd.github+json' },
        });
        const rel = JSON.parse(buffer.toString('utf8'));
        const asset = (rel.assets || []).find((a) => a.name === name);
        if (asset && asset.id) {
          this._writeAssetCache(`${this.bundleTag}|${name}`, asset.id);
          out.push({
            label: 'API 直链',
            url: `https://api.github.com/repos/${slug}/releases/assets/${asset.id}`,
            headers: { Accept: 'application/octet-stream' },
          });
        }
      } catch {
        /* api 不通就靠下面的直连地址 */
      }
      // 3) 直连（需要 github.com 可达）
      out.push({
        label: 'Release 直连',
        url: `https://github.com/${slug}/releases/download/${this.bundleTag}/${name}`,
      });
    }

    // 4) 模板兜底
    out.push({ label: '模板地址', url: this.bundleUrlTemplate.replace('{id}', id).replace('{version}', version) });

    // 去重
    const seen = new Set();
    return out.filter((c) => {
      if (!c.url || seen.has(c.url)) return false;
      seen.add(c.url);
      return true;
    });
  }

  _assetCachePath() {
    return path.join(this.stateDir, 'plugin-assets.json');
  }

  _readAssetCache() {
    try {
      return JSON.parse(fs.readFileSync(this._assetCachePath(), 'utf8'));
    } catch {
      return {};
    }
  }

  _writeAssetCache(key, value) {
    try {
      const cache = this._readAssetCache();
      cache[key] = value;
      fs.mkdirSync(this.stateDir, { recursive: true });
      fs.writeFileSync(this._assetCachePath(), JSON.stringify(cache, null, 2), 'utf8');
    } catch {
      /* 缓存写不了不影响安装 */
    }
  }

  /* -- git 可用性 -------------------------------------------------------- */

  /** 本机有没有 git？有就走稀疏克隆，没有就回退 HTTPS */
  detectGit() {
    if (this._gitPath !== undefined) return this._gitPath;
    const found = findOnPath(['git.exe', 'git']);
    if (!found) {
      this._gitPath = '';
      return '';
    }
    try {
      execFileSync(found, ['--version'], { stdio: 'ignore', timeout: 15000, windowsHide: true });
      this._gitPath = found;
    } catch {
      this._gitPath = '';
    }
    return this._gitPath;
  }

  downloadMode() {
    const forced = this.settings ? this.settings.get('pluginDownloadMode', 'auto') : 'auto';
    if (forced === 'git' || forced === 'http') return forced;
    return this.detectGit() ? 'git' : 'http';
  }

  /* -- 目录清单 ---------------------------------------------------------- */

  /** 读上次缓存的目录清单（离线也能看到列表） */
  cachedCatalog() {
    try {
      const raw = fs.readFileSync(this.catalogCache, 'utf8');
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
      return parsed && Array.isArray(parsed.plugins) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** 拉取目录清单；force=false 时优先用内存/磁盘缓存 */
  async loadCatalog({ force = false } = {}) {
    if (!force && this._catalog) return { ok: true, catalog: this._catalog, source: 'memory' };
    if (!force) {
      const cached = this.cachedCatalog();
      if (cached) {
        this._catalog = cached;
        return { ok: true, catalog: cached, source: 'cache' };
      }
    }
    try {
      const { buffer } = await httpGet(this.catalogUrl);
      const catalog = JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''));
      if (!catalog || !Array.isArray(catalog.plugins)) throw new Error('catalog.json 结构不正确');
      this._catalog = catalog;
      try {
        fs.mkdirSync(this.stateDir, { recursive: true });
        fs.writeFileSync(this.catalogCache, JSON.stringify(catalog, null, 2), 'utf8');
      } catch {
        /* 缓存写不了不影响本次使用 */
      }
      return { ok: true, catalog, source: 'remote' };
    } catch (err) {
      const cached = this.cachedCatalog();
      if (cached) {
        this._catalog = cached;
        return { ok: true, catalog: cached, source: 'cache', warning: String(err.message || err) };
      }
      return { ok: false, catalog: null, error: String(err.message || err) };
    }
  }

  /* -- 已安装 ------------------------------------------------------------ */

  scanInstalled() {
    const out = new Map();
    const dir = this.pluginsDir;
    if (!isDir(dir)) return out;
    let children = [];
    try {
      children = fs.readdirSync(dir);
    } catch {
      return out;
    }
    for (const name of children) {
      if (name.startsWith('.') || name.startsWith('_')) continue;
      const p = path.join(dir, name);
      if (!isDir(p)) continue;
      let version = '';
      let id = name;
      try {
        const mf = JSON.parse(fs.readFileSync(path.join(p, 'kernel.json'), 'utf8').replace(/^\uFEFF/, ''));
        version = String(mf.version || '');
        id = String(mf.id || name);
      } catch {
        /* 清单缺失/损坏：仍然算已安装，界面上会显示成「清单异常」 */
      }
      let t = { files: 0, bytes: 0 };
      try {
        t = treeHash(p);
      } catch {
        /* ignore */
      }
      out.set(id, { id, dirName: name, dir: p, version, files: t.files, bytes: t.bytes, hash: t.hash });
    }
    return out;
  }

  /** 给界面用的合并视图：目录里的插件 × 本机安装状态 */
  async list({ refresh = false } = {}) {
    const res = await this.loadCatalog({ force: refresh });
    const installed = this.scanInstalled();
    const rows = [];
    const seen = new Set();

    for (const p of (res.catalog && res.catalog.plugins) || []) {
      const local = installed.get(p.id);
      seen.add(p.id);
      let state = 'not-installed';
      if (local) {
        state = local.version && p.version && local.version !== p.version ? 'update-available' : 'installed';
        if (p.sha256 && local.hash && local.hash !== p.sha256) state = 'modified';
      }
      rows.push({
        ...p,
        state,
        installedVersion: local ? local.version : '',
        installedBytes: local ? local.bytes : 0,
        installedFiles: local ? local.files : 0,
        dir: local ? local.dir : '',
        hashMatches: Boolean(local && p.sha256 && local.hash === p.sha256),
      });
    }

    // 装了但已不在目录里的（用户手动拷进来的 / 已下架的）
    for (const [id, local] of installed) {
      if (seen.has(id)) continue;
      rows.push({
        id,
        name: id,
        version: local.version,
        ckp: '',
        kind: 'other',
        description: '（不在官方目录中，可能是手动放入的插件）',
        path: '',
        size: local.bytes,
        files: local.files,
        sha256: '',
        state: 'local-only',
        installedVersion: local.version,
        installedBytes: local.bytes,
        installedFiles: local.files,
        dir: local.dir,
        hashMatches: false,
        requires: [],
        external: [],
        ops: [],
        capabilities: 0,
      });
    }

    rows.sort((a, b) => a.id.localeCompare(b.id));
    return {
      ok: res.ok,
      source: res.source || '',
      warning: res.warning || '',
      error: res.error || '',
      catalog: res.catalog
        ? { updated: res.catalog.updated, pluginCount: res.catalog.pluginCount, totalSize: res.catalog.totalSize, repository: res.catalog.repository }
        : null,
      git: this.detectGit(),
      mode: this.downloadMode(),
      hubRoot: this.hubRoot,
      pluginsDir: this.pluginsDir,
      installedCount: installed.size,
      plugins: rows,
    };
  }

  /* -- 安装 -------------------------------------------------------------- */

  _stagingDir(id) {
    fs.mkdirSync(this.tmpDir, { recursive: true });
    return path.join(this.tmpDir, `install-${id}-${process.pid}-${Date.now().toString(36)}`);
  }

  /**
   * 额外的 git -c 参数（企业代理 / 自定义 TLS 后端等），来自设置。
   *
   * 2.2.1 起固定加上两条与**编码**有关的配置：
   *   · core.quotepath=false —— git 默认把非 ASCII 路径转义成八进制
   *     （`"\346\226\207..."`）。任何把 git 输出当路径用的地方都会因此拿到垃圾，
   *     插件仓库里一旦有中文文件名就会踩到。
   *   · i18n.logOutputEncoding=utf-8 —— 提交信息/日志按 UTF-8 输出。
   */
  _gitConfigArgs() {
    const raw = (this.settings && this.settings.get('pluginGitConfig', [])) || [];
    const out = ['-c', 'core.quotepath=false', '-c', 'i18n.logOutputEncoding=utf-8'];
    for (const item of Array.isArray(raw) ? raw : []) {
      const s = String(item || '').trim();
      if (s) out.push('-c', s);
    }
    return out;
  }

  /** git 子进程环境：让它对「连接卡住」快速失败，而不是干等 */
  _gitEnv() {
    return {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0', // 不要在无人值守时弹认证
      GIT_HTTP_LOW_SPEED_LIMIT: '1000', // 低于 1KB/s …
      GIT_HTTP_LOW_SPEED_TIME: '30', // … 持续 30 秒就中断
    };
  }

  /**
   * 异步跑一条 git 命令。
   *
   * 这里**不能**用 execFileSync —— 之前那版就是同步的，git 稀疏克隆
   * pillow-image 要 21 秒，整整 21 秒主进程被占死，界面直接「未响应」。
   * 换成 spawn 异步等，并在 stderr 里抓进度回吐给界面。
   */
  _gitRun(args, cwd, onLine) {
    const git = this.detectGit();
    if (!git) return Promise.reject(new Error('本机没有可用的 git'));
    return new Promise((resolve, reject) => {
      const child = spawn(git, [...this._gitConfigArgs(), ...args], {
        cwd: cwd || this.tmpDir,
        env: this._gitEnv(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let tail = '';
      const feed = (buf) => {
        const text = String(buf);
        tail = (tail + text).slice(-2000);
        if (onLine) {
          for (const line of text.split(/\r?\n/)) {
            if (line.trim()) onLine(line.trim());
          }
        }
      };
      child.stdout.on('data', feed);
      child.stderr.on('data', feed);
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`git ${args[0]} 退出码 ${code}：${tail.trim().split(/\r?\n/).slice(-2).join(' ')}`));
      });
    });
  }

  /** git 稀疏克隆：只把目标插件目录落到磁盘 */
  async _fetchViaGit(entry, staging, onProgress) {
    const repo = `${staging}-repo`;
    const attempts = 3;
    let lastErr = null;

    for (let i = 1; i <= attempts; i += 1) {
      try {
        rmrf(repo);
        onProgress({ phase: 'git-clone', percent: 5, message: `克隆插件仓库（稀疏模式，第 ${i}/${attempts} 次）` });
        await this._gitRun(['clone', '--filter=blob:none', '--sparse', '--depth', '1', this.repoUrl, repo], this.tmpDir, (line) => {
          // git 把进度写在 stderr，抓关键行回吐，让界面不是干等
          if (/Receiving objects|Resolving deltas|remote:|Cloning into/i.test(line)) {
            onProgress({ phase: 'git-clone', percent: 20, message: line.slice(0, 120) });
          }
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        rmrf(repo);
        if (i < attempts) {
          onProgress({
            phase: 'git-clone',
            percent: 5,
            message: `克隆失败，${i * 3} 秒后重试（${String(err.message || err).split('\n')[0].slice(0, 80)}）`,
          });
          await new Promise((r) => setTimeout(r, i * 3000));
        }
      }
    }
    if (lastErr) throw lastErr;

    onProgress({ phase: 'git-checkout', percent: 60, message: `拉取 ${entry.path}` });
    await this._gitRun(['sparse-checkout', 'set', entry.path.replace(/\\/g, '/')], repo, (line) => {
      if (/Updating files|Receiving objects/i.test(line)) {
        onProgress({ phase: 'git-checkout', percent: 70, message: line.slice(0, 120) });
      }
    });

    const src = path.join(repo, ...entry.path.split('/'));
    if (!isDir(src)) throw new Error(`仓库里没有找到 ${entry.path}`);
    onProgress({ phase: 'git-checkout', percent: 80, message: '复制到插件目录' });
    await copyDirAsync(src, staging);
    rmrf(repo);
    return staging;
  }

  /**
   * HTTPS 回退：下载 Release 资产里的插件 zip。
   *
   * 用 downloadToFile（多连接分片 + 流式落盘 + 全异步），
   * 再用 extractZipAsync 解压（每 20 个文件让出一次事件循环）。
   * 这两步都不能同步做，否则几十 MB 的插件一装界面就卡死。
   */
  async _fetchViaHttp(entry, staging, onProgress) {
    const candidates = await this._bundleCandidates(entry.id, entry.version);
    if (!candidates.length) throw new Error('没有可用的下载地址');

    const conns = Number((this.settings && this.settings.get('pluginDownloadConns', 0)) || 0) || 4;
    const errors = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const cand = candidates[i];
      const zipPath = `${staging}.zip`;
      try {
        onProgress({ phase: 'download', percent: 0, message: `下载 ${entry.id}-${entry.version}.zip（${cand.label}）` });
        const startedAt = Date.now();
        const res = await downloadToFile(cand.url, zipPath, {
          headers: cand.headers || {},
          conns,
          onProgress: (p) => {
            const mb = (p.received / 1048576).toFixed(1);
            const tot = (p.total / 1048576).toFixed(1);
            const secs = Math.max(0.2, (Date.now() - startedAt) / 1000);
            const speed = (p.received / 1048576 / secs).toFixed(1);
            onProgress({
              phase: 'download',
              percent: p.percent,
              message: `下载 ${entry.id}　${mb}/${tot} MB　${speed} MB/s　${p.conns} 个连接`,
            });
          },
        });

        onProgress({ phase: 'extract', percent: 80, message: `解压（${res.conns} 连接，${(res.bytes / 1048576).toFixed(1)} MB）` });
        const raw = `${staging}-raw`;
        rmrf(raw);
        await extractZipAsync(zipPath, raw, (p) => {
          onProgress({
            phase: 'extract',
            percent: 80 + Math.round((p.done / p.total) * 12),
            message: `解压 ${p.done}/${p.total}`,
          });
        });
        // 包里是 plugins/<id>/... 的仓库布局，取出来摆到 staging 根
        const inner = path.join(raw, 'plugins', entry.id);
        const picked = isDir(inner) ? inner : raw;
        await copyDirAsync(picked, staging);
        rmrf(raw);
        rmrf(zipPath);
        return staging;
      } catch (err) {
        errors.push(`${cand.label}: ${String(err.message || err).split('\n')[0]}`);
        rmrf(`${staging}-raw`);
        rmrf(zipPath);
        if (i < candidates.length - 1) {
          onProgress({ phase: 'download', percent: 0, message: `${cand.label} 失败，换下一个地址` });
        }
      }
    }
    throw new Error(`所有下载地址都失败 → ${errors.join('；')}`);
  }

  /**
   * 安装（或重装）一个插件。
   *
   * 下载方式：
   *   pluginDownloadMode = 'auto'（默认）→ 有 git 就先用 git，**失败自动回退 HTTPS**
   *   'git'  → 只用 git
   *   'http' → 只用 HTTPS
   *
   * 为什么 auto 必须带回退：git clone 走的是 github.com 这一个域名，
   * 部分网络下该域名会不可达（而 api/codeload/raw 正常），此时
   * 死守 git 会让插件彻底装不上；HTTPS 走 Release 资产，是另一条通路。
   *
   * @param {string} id
   * @param {object} opts { onProgress, mode }
   */
  async install(id, opts = {}) {
    const { onProgress = () => {}, mode = '' } = opts;
    const res = await this.loadCatalog({});
    if (!res.ok) return { ok: false, error: `无法获取插件目录：${res.error}` };
    const entry = res.catalog.plugins.find((p) => p.id === id);
    if (!entry) return { ok: false, error: `目录里没有插件 ${id}` };

    const setting = mode || (this.settings ? this.settings.get('pluginDownloadMode', 'auto') : 'auto');
    let modes;
    if (setting === 'git') modes = ['git'];
    else if (setting === 'http') modes = ['http'];
    else modes = this.detectGit() ? ['git', 'http'] : ['http'];

    const attempts = [];
    for (let i = 0; i < modes.length; i += 1) {
      const useMode = modes[i];
      const result = await this._installOnce(entry, useMode, onProgress, modes.length > 1 && i > 0);
      if (result.ok) return result;
      attempts.push(`${useMode}: ${result.error}`);
      // 还有备选方式时，把这次失败降级成告警继续试
      if (i < modes.length - 1) {
        onProgress({ phase: 'fallback', percent: 0, message: `${useMode} 方式失败，改用 ${modes[i + 1]}` });
      }
    }

    onProgress({ phase: 'error', percent: 0, message: attempts.join('；') });
    return { ok: false, id, error: attempts.join('；'), attempts };
  }

  /** 用指定方式装一次（auto 回退时的单次尝试） */
  async _installOnce(entry, useMode, onProgress, isFallback) {
    const id = entry.id;
    const staging = this._stagingDir(id);
    const target = path.join(this.pluginsDir, id);
    const backup = `${target}.bak-${Date.now().toString(36)}`;

    try {
      rmrf(staging);
      if (useMode === 'git') {
        await this._fetchViaGit(entry, staging, onProgress);
      } else {
        await this._fetchViaHttp(entry, staging, onProgress);
      }

      // 校验内容树哈希 —— 与 catalog 不一致视为失败，避免留下半个插件
      if (entry.sha256) {
        onProgress({ phase: 'verify', percent: 92, message: '校验内容哈希' });
        const got = treeHash(staging);
        if (got.hash !== entry.sha256) {
          throw new Error(`内容哈希不匹配（期望 ${entry.sha256.slice(0, 12)}…，实际 ${got.hash.slice(0, 12)}…）`);
        }
      }

      onProgress({ phase: 'install', percent: 96, message: '写入插件目录' });
      fs.mkdirSync(this.pluginsDir, { recursive: true });
      // 覆盖安装：先挪走旧的，失败可回滚
      if (fs.existsSync(target)) fs.renameSync(target, backup);
      fs.renameSync(staging, target);
      rmrf(backup);

      const info = treeHash(target);
      onProgress({ phase: 'done', percent: 100, message: `已安装 ${entry.name || id} ${entry.version}` });
      return {
        ok: true,
        id,
        version: entry.version,
        path: target,
        bytes: info.bytes,
        files: info.files,
        mode: useMode,
        fallback: Boolean(isFallback),
      };
    } catch (err) {
      rmrf(staging);
      // 回滚：把备份挪回来
      if (fs.existsSync(backup) && !fs.existsSync(target)) {
        try {
          fs.renameSync(backup, target);
        } catch {
          /* ignore */
        }
      }
      return { ok: false, id, error: String(err.message || err), mode: useMode };
    }
  }

  /** 卸载：只允许删 pluginsDir 下的直接子目录 */
  uninstall(id) {
    const target = path.join(this.pluginsDir, id);
    const resolved = path.resolve(target);
    const base = path.resolve(this.pluginsDir);
    if (!resolved.startsWith(base + path.sep)) {
      return { ok: false, error: `拒绝删除工作区外的路径：${resolved}` };
    }
    if (!isDir(resolved)) return { ok: false, error: `未安装：${id}` };

    rmrf(resolved);
    // 关键：不能删完就报成功。文件被占用（比如某个内核进程还开着 .pyd）时
    // rmSync 会失败，若不复查，界面会显示「已卸载」而目录其实还在。
    if (fs.existsSync(resolved)) {
      try {
        fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (err) {
        return { ok: false, id, error: `删除失败：${String(err.message || err)}` };
      }
    }
    if (fs.existsSync(resolved)) {
      return { ok: false, id, error: '删除后目录仍然存在，可能被其他进程占用' };
    }
    return { ok: true, id, path: resolved };
  }

  /** 更新 = 重新安装（catalog 里的最新版本） */
  async update(id, opts = {}) {
    return this.install(id, opts);
  }

  /**
   * 校验已安装插件的完整性（对照 catalog 的 sha256）。
   * 界面上的「校验」按钮用它，也用于诊断「为什么这个内核突然不可用」。
   */
  async verifyAll() {
    const res = await this.loadCatalog({});
    const installed = this.scanInstalled();
    const rows = [];
    for (const [id, local] of installed) {
      const entry = res.catalog ? res.catalog.plugins.find((p) => p.id === id) : null;
      if (!entry) {
        rows.push({ id, status: 'unknown', detail: '不在官方目录中' });
        continue;
      }
      const files = walkFiles(local.dir);
      const missing = [];
      const extra = [];
      const expected = new Set();
      rows.push({
        id,
        status: local.hash === entry.sha256 ? 'ok' : 'mismatch',
        blocked:
          local.hash === entry.sha256
            ? false
            : { files: files.length, expectedHash: entry.sha256.slice(0, 12), actualHash: local.hash.slice(0, 12), missing, extra },
        installedVersion: local.version,
        catalogVersion: entry.version,
      });
    }
    return { ok: true, rows };
  }

  /** 列出插件 zip 里的条目（调试用：确认 Release 资产内容正确） */
  inspectBundle(zipPath) {
    return listZip(zipPath);
  }
}

module.exports = { PluginStore, treeHash, httpGet, DEFAULT_REPO, DEFAULT_CATALOG, DEFAULT_BUNDLE };
