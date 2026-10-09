'use strict';
/**
 * exeInstall.js —— 外部程序的自动安装（2.3.3）
 *
 * 为什么要有它：Ghostscript / Pandoc 这类**外部程序** pip 装不了，界面以前只能说
 * 「找不到可执行文件」然后让用户自己去官网下载安装。这里把「自动装」做成能力。
 *
 * 只用**官方**下载地址，不引第三方二进制（避免供应链问题）：
 *
 *   installer 类：官方只有 requireAdministrator 的 NSIS 安装包（Ghostscript 就是），
 *     7za 也解不开（实测 "Cannot open the file as archive"），所以只能静默安装。
 *     注意不能用 spawn：CreateProcess 从非提权进程启动 requireAdministrator 的程序会
 *     直接失败（ELEVATION_REQUIRED），连 UAC 都不弹；必须走
 *     `powershell Start-Process -Verb RunAs` —— 弹**一次** UAC，用户同意后装完。
 *
 *   zip 类：官方有免安装 zip（Pandoc 就是），解到用户目录即可，**不需要任何权限**。
 *
 * 装完把可执行文件路径交给调用方（应用会写进设置 exePaths，引擎解析时优先用它）。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const { findInKnownLocations } = require('./executables');

/** 官方下载地址与安装方式 */
const EXE_RECIPES = {
  gs: {
    label: 'Ghostscript',
    kind: 'installer',
    url: 'https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs10080/gs10080w64.exe',
    fileName: 'gs10080w64.exe',
    /*
     * 静默参数用 Inno Setup 那一套。
     * 实测：这个安装包传 `/S`（NSIS 的静默参数）会**弹出安装向导**（窗口标题
     * "GPL Ghostscript Setup"），把自动化卡在那里；`/VERYSILENT` 才是它的沉默开关。
     * 两个都传也无害（各自忽略不认识的参数），但以 /VERYSILENT 为主。
     */
    args: ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-'],
    expect: ['gswin64c', 'gswin32c', 'gs'],
    page: 'https://www.ghostscript.com/releases/gsdnld.html',
    /** 需要管理员确认（官方安装包清单里是 requireAdministrator） */
    needsAdmin: true,
  },
  pandoc: {
    label: 'Pandoc',
    kind: 'zip',
    /** 官方资产名带版本号，先问一次 API 拿当前的免安装 zip */
    resolveUrl: async () => {
      const res = await fetch('https://api.github.com/repos/jgm/pandoc/releases/latest', {
        headers: { 'User-Agent': 'KernelHub-Studio', Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) throw new Error(`查询 Pandoc 最新版失败：HTTP ${res.status}`);
      const data = await res.json();
      const asset = (data.assets || []).find((a) => /windows-x86_64\.zip$/i.test(a.name || ''));
      if (!asset) throw new Error('Pandoc 最近一个发布里没有 Windows 免安装 zip');
      return asset.browser_download_url;
    },
    expect: ['pandoc'],
    page: 'https://pandoc.org/installing.html',
    needsAdmin: false,
  },
};

/** gswin64c / gswin32c 都归到 gs 这一份配方 */
function recipeOf(name) {
  const key = String(name || '').trim().toLowerCase();
  if (EXE_RECIPES[key]) return EXE_RECIPES[key];
  if (/^(gswin64c|gswin32c|gswin64|gswin32)$/.test(key)) return EXE_RECIPES.gs;
  return null;
}

function exeLabelOf(name) {
  const recipe = recipeOf(name);
  return recipe ? recipe.label : String(name || '');
}

/** 下载文件（GitHub 的 release 会 302 到 objects.githubusercontent.com，必须跟） */
function downloadFile(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) {
      reject(new Error('重定向次数过多'));
      return;
    }
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'KernelHub-Studio', Accept: 'application/octet-stream' } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          downloadFile(next, dest, onProgress, redirects + 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`下载失败：HTTP ${res.statusCode}`));
          return;
        }
        const total = Number(res.headers['content-length'] || 0);
        let got = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          got += chunk.length;
          if (onProgress && total) onProgress(Math.min(99, Math.round((got / total) * 100)));
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve({ ok: true, bytes: got })));
        out.on('error', reject);
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(900000, () => req.destroy(new Error('下载超时')));
  });
}

/**
 * 跑官方安装包（静默）。
 * 用户拒绝 UAC 时 PowerShell 返回非 0，据此给出「已取消」的提示。
 */
function runElevatedInstaller(file, args) {
  return new Promise((resolve) => {
    const argList = (args || []).map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',');
    const ps = [
      '$ErrorActionPreference = "Stop";',
      `$p = Start-Process -FilePath '${String(file).replace(/'/g, "''")}'`,
      argList ? `-ArgumentList ${argList}` : '',
      '-Verb RunAs -Wait -PassThru;',
      'exit $p.ExitCode;',
    ]
      .filter(Boolean)
      .join(' ');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      windowsHide: true,
    });
    let stderr = '';
    if (child.stderr) child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => resolve({ ok: false, code: -1, error: String(err.message || err) }));
    child.on('close', (code) => resolve({ ok: code === 0, code, error: stderr.slice(0, 400) }));
  });
}

/** 解压 zip：Windows 自带的 tar.exe 就能处理 zip（bsdtar），不引第三方工具 */
function unzipTo(file, dir) {
  return new Promise((resolve) => {
    const child = spawn('tar.exe', ['-xf', file, '-C', dir], { windowsHide: true });
    let stderr = '';
    if (child.stderr) child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => resolve({ ok: false, error: String(err.message || err) }));
    child.on('close', (code) => resolve({ ok: code === 0, code, error: stderr.slice(0, 400) }));
  });
}

/** 在给定目录（可选）与常见安装位置里找一个可执行文件 */
function locateInstalledExe(names, extraDir) {
  const known = findInKnownLocations(names);
  if (known) return known.path;
  if (!extraDir) return '';
  try {
    const stack = [extraDir];
    while (stack.length) {
      const dir = stack.pop();
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (names.some((n) => e.name.toLowerCase() === `${String(n).toLowerCase()}.exe`)) return full;
      }
    }
  } catch {
    /* 目录读不到就算了 */
  }
  return '';
}

/**
 * 自动安装一个外部程序。
 *
 * @param {object} opts
 * @param {string} opts.name        清单里声明的名字（gs / gswin64c / pandoc …）
 * @param {string} opts.toolsDir    下载与解包的目录（一般是 <stateDir>/tools）
 * @param {(p:{phase:string,percent:number,message:string})=>void} [opts.onProgress]
 * @param {boolean} [opts.keepDownload] 留着安装包（默认装完删掉，60MB+ 不占地方）
 * @returns {Promise<{ok:boolean, path?:string, error?:string, canAuto:boolean}>}
 */
async function installExe({ name, toolsDir, onProgress, keepDownload = false } = {}) {
  const exeName = String(name || '').trim();
  const recipe = recipeOf(exeName);
  const say = (payload) => {
    if (typeof onProgress === 'function') {
      try {
        onProgress(payload);
      } catch {
        /* 回调出错不影响安装 */
      }
    }
  };
  if (!recipe) {
    return { ok: false, canAuto: false, error: `暂时不支持自动安装 ${exeName}，请手动下载安装` };
  }

  const dir = toolsDir || path.join(require('os').tmpdir(), 'khs-tools');
  fs.mkdirSync(dir, { recursive: true });
  let downloaded = '';
  try {
    const url = typeof recipe.resolveUrl === 'function' ? await recipe.resolveUrl() : recipe.url;
    downloaded = path.join(dir, recipe.fileName || path.basename(new URL(url).pathname) || 'download.bin');

    say({ phase: 'download', percent: 0, message: `正在下载 ${recipe.label}…` });
    await downloadFile(url, downloaded, (pct) =>
      say({ phase: 'download', percent: pct, message: `正在下载 ${recipe.label}… ${pct}%` })
    );

    let extraDir = '';
    if (recipe.kind === 'zip') {
      extraDir = path.join(dir, recipe.expect[0] || exeName);
      fs.rmSync(extraDir, { recursive: true, force: true });
      fs.mkdirSync(extraDir, { recursive: true });
      say({ phase: 'extract', percent: 0, message: `正在解压 ${recipe.label}…` });
      const un = await unzipTo(downloaded, extraDir);
      if (!un.ok) throw new Error(`解压失败${un.error ? '：' + un.error : ''}`);
    } else {
      say({
        phase: 'install',
        percent: 0,
        message: `正在安装 ${recipe.label} —— 会弹一次管理员确认，请点「是」…`,
      });
      const run = await runElevatedInstaller(downloaded, recipe.args);
      if (!run.ok) {
        throw new Error(
          /cancel|取消|denied|拒绝|拒绝访问/i.test(run.error || '') || run.code === -1
            ? '已取消管理员确认：这个程序必须管理员权限才能装。若你没有管理员权限，可以改用不需要外部程序的替代内核。'
            : `安装失败${run.error ? '：' + run.error : '（退出码 ' + run.code + '）'}`
        );
      }
    }

    say({ phase: 'locate', percent: 0, message: '正在确认安装结果…' });
    let found = '';
    for (let i = 0; i < 40 && !found; i += 1) {
      found = locateInstalledExe(recipe.expect, extraDir);
      if (!found) await new Promise((r) => setTimeout(r, 1500));
    }
    if (!found) throw new Error(`${recipe.label} 装完了但没找到可执行文件（可能取消了管理员确认）`);

    if (!keepDownload) {
      try {
        fs.rmSync(downloaded, { force: true });
      } catch {
        /* ignore */
      }
    }
    say({ phase: 'done', percent: 100, message: `${recipe.label} 已就绪：${found}` });
    return { ok: true, path: found, canAuto: true, label: recipe.label };
  } catch (err) {
    if (!keepDownload && downloaded) {
      try {
        fs.rmSync(downloaded, { force: true });
      } catch {
        /* ignore */
      }
    }
    const message = String((err && err.message) || err);
    say({ phase: 'error', percent: 0, message });
    return { ok: false, canAuto: true, error: message };
  }
}

module.exports = {
  EXE_RECIPES,
  recipeOf,
  exeLabelOf,
  installExe,
  locateInstalledExe,
  downloadFile,
};
