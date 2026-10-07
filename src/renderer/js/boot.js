/**
 * boot.js —— 能力探测（第一个被执行的脚本）
 *
 * 为什么单独一个文件而不是在 index.html 里写内联 <script>：
 *   页面 CSP 是 `script-src 'self'`，内联脚本会被浏览器拦下（控制台报
 *   「Executing inline script violates ... script-src 'self'」）。虽然功能上
 *   可以退化成「检测不到桥」，但会污染控制台、也会掩盖真正的错误。
 *   所以 index.html 默认声明 data-khs-bridge="missing"（提示页可见），
 *   由本模块在探测到 window.khs 后把它改成 "ready"（提示页隐藏、外壳显示）。
 *
 * 这个模块不导入任何其它模块：它必须能在 app.js 加载失败时也照常工作。
 */

(function detect() {
  const bridge = window.khs;
  const ready = Boolean(bridge && typeof bridge === 'object' && bridge.app && typeof bridge.app.info === 'function');
  document.documentElement.setAttribute('data-khs-bridge', ready ? 'ready' : 'missing');
  if (!ready) {
    // 不抛异常：index.html 已经准备好「请在 Electron 中运行」的提示页
    console.warn('[boot] 未检测到 window.khs：当前不在 Electron 宿主中，界面进入降级提示页。');
  }
})();
