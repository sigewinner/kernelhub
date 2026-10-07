'use strict';
/**
 * deps.js —— 插件依赖的检测与自动安装（2.1.0）
 *
 * 为什么需要它：插件清单里的 `runtime.requires` 声明了它需要的 Python 模块。
 * 正常情况下这些依赖随插件一起下载到 `<plugin>/vendor/`，装了就能用；
 * 但如果插件包本身没带全（或用户手工删过 vendor），内核就会停在「缺模块 X」，
 * 而界面上以前只是把这个原因写在状态列里，用户还得自己去 pip install。
 *
 * 这里做两件事：
 *   1. 用与注册表**同一套探测方式**（PYTHONPATH 注入该插件的 vendor）判断到底缺什么
 *   2. 用 `python -m pip install --target <plugin>/vendor` 把缺的包装进插件自己的目录
 *      —— 装进 vendor 而不是全局 site-packages，符合本项目「每个插件自带依赖、
 *      互不干扰」的设计；卸载插件时连带删掉，不留垃圾
 *
 * 网络：默认走设置的 pipIndexUrl（默认国内镜像），失败后自动回退到 PyPI 官方源。
 * 只处理 Python 依赖；外部程序（ImageMagick / ffmpeg 之类）无法用 pip 装，
 * 由调用方把安装提示一并展示给用户。
 */

const { spawn } = require('child_process');

const { resolvePython, pythonHasModule } = require('./python');

/**
 * Python 模块名 → pip 包名。
 * 只有模块名与包名不一致的才需要在这里登记；其余同名直接用。
 */
const MODULE_PACKAGE = {
  PIL: 'pillow',
  cv2: 'opencv-python',
  fitz: 'pymupdf',
  yaml: 'pyyaml',
  bs4: 'beautifulsoup4',
  skimage: 'scikit-image',
  docx: 'python-docx',
  pptx: 'python-pptx',
  xlrd: 'xlrd',
  OpenSSL: 'pyopenssl',
  serial: 'pyserial',
  win32com: 'pywin32',
  svglib: 'svglib',
  reportlab: 'reportlab',
};

/** 内置的候选源：设置里的优先，失败后按顺序回退 */
const FALLBACK_INDEXES = [
  { id: 'pypi', label: 'PyPI 官方源', url: 'https://pypi.org/simple' },
];

function packageFor(moduleName) {
  const name = String(moduleName || '').trim();
  return MODULE_PACKAGE[name] || name;
}

/**
 * 探测插件缺少哪些 Python 依赖。
 * @param {object} opts
 * @param {string[]} opts.requires 插件声明的模块名
 * @param {string} opts.vendorDir 该插件的 vendor 目录（作为 PYTHONPATH）
 * @returns {{python:string, missing:string[], packages:string[]}}
 */
function probeMissing({ requires, vendorDir } = {}) {
  const python = resolvePython();
  const sysPath = vendorDir ? [vendorDir] : [];
  const list = Array.isArray(requires) ? requires.filter(Boolean) : [];
  const missing = [];
  for (const mod of list) {
    if (!python) {
      missing.push(mod);
      continue;
    }
    if (!pythonHasModule(mod, { python, sysPath })) missing.push(mod);
  }
  return { python, missing, packages: missing.map(packageFor) };
}

/**
 * 执行一次 pip 安装。
 * @param {object} opts
 * @param {string} opts.python
 * @param {string} opts.target 安装目标目录（插件的 vendor）
 * @param {string[]} opts.packages pip 包名
 * @param {string} [opts.indexUrl] 索引地址（-i）
 * @param {(line:string)=>void} [opts.onLine] 逐行回吐输出（界面展示进度用）
 * @returns {Promise<{ok:boolean, code:number, log:string, error:string}>}
 */
function pipInstall({ python, target, packages, indexUrl, onLine } = {}) {
  return new Promise((resolve) => {
    const args = [
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
      '--no-input',
      '--upgrade',
      '--target',
      target,
    ];
    if (indexUrl) args.push('-i', indexUrl);
    args.push(...(packages || []));

    let child;
    try {
      child = spawn(python, args, {
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          PIP_DISABLE_PIP_VERSION_CHECK: '1',
          // 关掉 pip 的交互式进度条，输出按行更规整
          PIP_PROGRESS_BAR: 'off',
        },
      });
    } catch (err) {
      resolve({ ok: false, code: -1, log: '', error: String(err && err.message ? err.message : err) });
      return;
    }

    const lines = [];
    let errorText = '';
    const push = (chunk) => {
      const text = String(chunk || '');
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        lines.push(line);
        if (typeof onLine === 'function') {
          try {
            onLine(line);
          } catch {
            /* 回调出错不影响安装 */
          }
        }
      }
    };

    if (child.stdout) child.stdout.on('data', push);
    if (child.stderr) child.stderr.on('data', push);
    child.on('error', (err) => {
      errorText = String(err && err.message ? err.message : err);
    });
    child.on('close', (code) => {
      resolve({
        ok: code === 0,
        code: Number(code),
        log: lines.slice(-60).join('\n'),
        error: code === 0 ? '' : errorText || lines.slice(-4).join(' / '),
      });
    });
  });
}

/**
 * 按「设置里的源 → 回退源」顺序尝试安装，首个成功即返回。
 * @param {object} opts
 * @param {string} [opts.preferredIndex] 设置里的源（默认国内镜像）
 * @param {(info:{index:string, attempt:number})=>void} [opts.onIndex]
 */
async function installMissing({ python, target, packages, preferredIndex, onLine, onIndex } = {}) {
  const pkgs = (packages || []).filter(Boolean);
  if (!pkgs.length) return { ok: true, alreadyOk: true, installed: [], log: '' };
  if (!python) return { ok: false, error: '没有找到 Python 解释器', installed: [], log: '' };

  const tried = [];
  const candidates = [];
  if (preferredIndex) candidates.push({ id: 'preferred', label: '配置的源', url: preferredIndex });
  for (const item of FALLBACK_INDEXES) {
    if (!candidates.some((c) => c.url === item.url)) candidates.push(item);
  }

  let last = null;
  for (let i = 0; i < candidates.length; i += 1) {
    const index = candidates[i];
    tried.push(index.url);
    if (typeof onIndex === 'function') {
      try {
        onIndex({ index: index.url, label: index.label, attempt: i + 1 });
      } catch {
        /* ignore */
      }
    }
    const result = await pipInstall({ python, target, packages: pkgs, indexUrl: index.url, onLine });
    if (result.ok) return { ...result, installed: pkgs, indexUsed: index.url, tried };
    last = result;
  }
  return { ok: false, installed: [], tried, ...(last || {}) };
}

module.exports = {
  MODULE_PACKAGE,
  FALLBACK_INDEXES,
  packageFor,
  probeMissing,
  pipInstall,
  installMissing,
};
