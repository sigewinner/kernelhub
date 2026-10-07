/**
 * splash.js —— 开启动画的收尾与阶段文案（2.0.4）
 *
 * 动画本身是纯 CSS（见 styles/splash.css），随 HTML 立刻出现，不依赖 JS。
 * 这个模块只做两件 JS 才能做的事：
 *   1. 按**真实启动阶段**推进底部那根 1px 进度线（不做假进度）
 *   2. 界面就绪后收起它 —— 带一个最短展示时间，避免快机器上一闪而过
 *
 * 兜底：splash.css 里有一条 6 秒后自行淡出的 CSS 动画，
 * 所以即使 app.js 抛错、没人调用 dismissSplash()，也不会把界面挡死。
 */

/** 最短展示时间：让字标收拢那一下播完，否则快机器上只看到闪一下 */
const MIN_VISIBLE_MS = 1150;
/** 与 splash.css 的 transition 对齐 */
const FADE_MS = 480;

let dismissed = false;

function bar() {
  return document.getElementById('splash-bar');
}

function statusEl() {
  return document.getElementById('splash-status');
}

/**
 * 更新开启动画的阶段文案与进度。
 * @param {string} text 正在做什么（真实阶段，不编造）
 * @param {number} percent 0–100，对应启动完成度
 */
export function setSplashStatus(text, percent) {
  if (dismissed) return;
  const label = statusEl();
  if (label && text) label.textContent = String(text);
  const el = bar();
  if (el && Number.isFinite(Number(percent))) {
    el.style.width = `${Math.max(0, Math.min(100, Number(percent)))}%`;
  }
}

/** 设置协议版本那行小字（拿到 app.info 之后调用） */
export function setSplashCkp(ckp) {
  if (dismissed) return;
  const el = document.getElementById('splash-ckp');
  if (el && ckp) el.textContent = `CKP ${ckp}`;
}

/**
 * 收起开启动画。
 * 用 performance.now() 判断已展示多久 —— 它从页面导航开始计时，
 * 而这个模块被 app.js 加载时开启动画早已出现，所以差值就是真实展示时长。
 */
export function dismissSplash() {
  if (dismissed) return;
  dismissed = true;

  const el = document.getElementById('splash');
  if (!el) return;

  setSplashStatus('就绪', 100);

  const shown = performance.now();
  const wait = Math.max(0, MIN_VISIBLE_MS - shown);

  setTimeout(() => {
    el.classList.add('splash--done');
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, FADE_MS);
  }, wait);
}

export default { setSplashStatus, setSplashCkp, dismissSplash };
