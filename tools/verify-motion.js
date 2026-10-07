'use strict';
/**
 * verify-motion.js —— 动效渲染验证（真实 Chrome，逐帧采样）
 *
 * 为什么需要它：应用自检跑在**不可见**窗口里。Chromium 不为隐藏窗口产生帧，
 * CSS 过渡会一直停在第 0 帧 —— 自检能验证「目标值对不对、过渡配置有没有生效」，
 * 但验证不了「动画到底有没有在动」。这个工具用真实 Chrome（headless=new 同样产生帧）
 * 在 requestAnimationFrame 里逐帧读计算样式，把「有没有出现中间帧」量出来。
 *
 * 验证项：
 *   1. 分段选项卡指示条：切换后 transform 应出现多个中间值（滑过去，而不是瞬移）
 *   2. 进度条：改宽度后 width 应出现多个中间值
 *   3. 通知卡片：同类型只留一张（覆盖）；移除一张后余下卡片的 transform 出现中间帧
 *   4. 截图插件页，留作人工核对
 *
 * 用法: node tools/verify-motion.js [--keep]
 *   --keep  跑完不关浏览器（手动接着看）
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { openBrowser, waitFor } = require('./browserkit');

const ROOT = path.resolve(__dirname, '..');
const SHOT_DIR = path.join(ROOT, 'docs', 'screenshots', 'verify');
const PORT_FILE = path.join(ROOT, '.devhost-port.json');
const PORT = 8800 + Math.floor(Math.random() * 200);
const KEEP = process.argv.includes('--keep');

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
}

/** 把 matrix(a,b,c,d,tx,ty) 读成「x,y」，两个方向都能看（让位动画动的是 y） */
function shift(transform) {
  const s = String(transform || '');
  if (s === 'none') return 'none';
  const m = /matrix\(([^)]+)\)/.exec(s);
  if (!m) return s;
  const parts = m[1].split(',').map((v) => Number(v.trim()));
  const x = Math.round(parts[4] * 100) / 100;
  const y = Math.round(parts[5] * 100) / 100;
  return `${x},${y}`;
}

/** 采样一串值，只记录「值发生变化」的那些帧（各步骤在页面里内联这段逻辑） */

async function main() {
  console.log('▸ 启动浏览器开发宿主…');
  // 端口文件是上一轮跑完留下的，必须先删掉 —— 否则会读到旧端口，
  // 浏览器连到一个已经不存在的宿主上，等选择器就会一直超时
  fs.rmSync(PORT_FILE, { force: true });

  const server = spawn(
    process.execPath,
    [path.join(__dirname, 'devserver.js'), '--port', String(PORT), '--port-file', PORT_FILE],
    { cwd: ROOT, stdio: 'inherit', windowsHide: false }
  );

  let info;
  try {
    info = await waitFor(
      () => {
        if (!fs.existsSync(PORT_FILE)) return false;
        return JSON.parse(fs.readFileSync(PORT_FILE, 'utf8'));
      },
      { timeout: 120000, interval: 400, label: '开发宿主就绪' }
    );
  } catch (err) {
    server.kill();
    throw err;
  }
  console.log(`  宿主 ${info.url}（内核 ${info.ready}/${info.total}）`);

  const browser = await openBrowser({ url: info.url, headless: true, width: 1400, height: 900 });

  try {
    // 进插件页（分段选项卡在这里）
    await browser.eval(`location.hash = '#/plugins'; return true;`);
    await browser.waitForExpr(`!!document.querySelector('.segmented__indicator')`, 20000, '分段控件出现');
    await new Promise((r) => setTimeout(r, 800));

    /* ------------------------------------------------ 1) 选项卡指示条滑动 */
    const segFrames = await browser.eval(`
      const btn = Array.from(document.querySelectorAll('.segmented__btn')).find((b) => b.innerText.trim() === '可安装');
      const ind = document.querySelector('.segmented__indicator');
      if (!btn || !ind) return null;
      const seen = [];
      const t0 = performance.now();
      const sampler = new Promise((resolve) => {
        function tick() {
          const v = getComputedStyle(ind).transform;
          if (!seen.length || seen[seen.length - 1].v !== v) seen.push({ t: Math.round(performance.now() - t0), v });
          if (performance.now() - t0 >= 700) resolve();
          else requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      btn.click();
      await sampler;
      return seen;
    `);
    const segMoved = (segFrames || []).filter((f) => shift(f.v) !== '0,0' && shift(f.v) !== 'none');
    check(
      '切换选项卡时指示条逐帧滑动（有中间帧）',
      (segFrames || []).length >= 3 && segMoved.length >= 2,
      segFrames ? `${segFrames.length} 个不同帧（x,y）：${segFrames.map((f) => shift(f.v)).join(' → ')}` : '取不到指示条'
    );

    /* ------------------------------------------------------ 2) 进度条宽度 */
    const barFrames = await browser.eval(`
      const track = document.createElement('div');
      track.className = 'progress progress--install';
      const fill = document.createElement('div');
      fill.className = 'progress__fill';
      fill.style.width = '5%';
      track.appendChild(fill);
      document.body.appendChild(track);
      await new Promise((r) => requestAnimationFrame(r));
      // 关键：先强制一次样式解析，让「初始宽度」真正落到渲染管线里。
      // 否则新元素还没有 before 值，后面的赋值不会触发过渡，会直接跳到终值。
      void getComputedStyle(fill).width;
      await new Promise((r) => requestAnimationFrame(r));
      const seen = [];
      const t0 = performance.now();
      const sampler = new Promise((resolve) => {
        function tick() {
          const v = getComputedStyle(fill).width;
          if (!seen.length || seen[seen.length - 1].v !== v) seen.push({ t: Math.round(performance.now() - t0), v });
          if (performance.now() - t0 >= 700) resolve();
          else requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      });
      fill.style.width = '90%';
      await sampler;
      track.remove();
      return seen;
    `);
    check(
      '进度条宽度变化逐帧缓动（有中间帧）',
      (barFrames || []).length >= 4,
      barFrames ? `${barFrames.length} 个不同宽度：${barFrames.slice(0, 6).map((f) => f.v).join(' → ')}…` : '取不到进度条'
    );

    /* ------------------------------------------ 3) 通知：同类覆盖 + 让位动画 */
    const toastProbe = await browser.eval(`
      const T = window.__khsTest;
      T.toastClear();
      T.toastShow('success', '第一条成功');
      T.toastShow('success', '第二条成功');
      const afterSame = T.toastCounts();
      T.toastShow('warn', '一条警告');
      T.toastShow('info', '一条提示');
      const total = T.toastCount();
      const cards = Array.from(document.querySelectorAll('.toast'));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const last = cards[cards.length - 1];
      if (!last) return { afterSame, total, frames: null };
      const seen = [];
      const t0 = performance.now();
      const sampler = new Promise((resolve) => {
        function tick() {
          const v = getComputedStyle(last).transform;
          if (!seen.length || seen[seen.length - 1].v !== v) seen.push({ t: Math.round(performance.now() - t0), v });
          if (performance.now() - t0 >= 800) resolve();
          else requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      });
      // 关掉最上面那张（它下面的卡片应当平滑让位）
      const closeBtn = document.querySelector('.toast .toast__close');
      if (closeBtn) closeBtn.click();
      await sampler;
      return { afterSame, total, frames: seen };
    `);
    check(
      '同类型通知互相覆盖（两条成功只剩一张）',
      toastProbe && toastProbe.afterSame && toastProbe.afterSame.success === 1,
      toastProbe ? `success=${toastProbe.afterSame.success}，此时共 ${toastProbe.total} 张` : '探针失败'
    );
    const shiftFrames = (toastProbe && toastProbe.frames) || [];
    check(
      '移除一张后余下卡片平滑让位（有中间帧）',
      shiftFrames.length >= 3,
      shiftFrames.length ? `${shiftFrames.length} 个不同 transform（x,y）：${shiftFrames.slice(0, 8).map((f) => shift(f.v)).join(' → ')}…` : '没采到帧'
    );

    await browser.eval(`window.__khsTest.toastClear(); return true;`);

    /* ------------------------------------------------------------ 4) 截图 */
    await browser.eval(`location.hash = '#/plugins'; return true;`);
    await new Promise((r) => setTimeout(r, 700));
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const shot = path.join(SHOT_DIR, '20-plugins-tabs.png');
    await browser.screenshot(shot);
    console.log(`  截图 → ${path.relative(ROOT, shot)}`);

    // 通知卡片的视觉留痕
    await browser.eval(`
      const T = window.__khsTest;
      T.toastClear();
      T.toastShow('success', '安装完成', 'pillow-image 已就绪');
      T.toastShow('error', '安装失败', '网络连接被重置');
      return true;
    `);
    await new Promise((r) => setTimeout(r, 600));
    const shot2 = path.join(SHOT_DIR, '21-toasts.png');
    await browser.screenshot(shot2);
    console.log(`  截图 → ${path.relative(ROOT, shot2)}`);
    await browser.eval(`window.__khsTest.toastClear(); return true;`);
  } finally {
    if (!KEEP) {
      await browser.close();
      server.kill();
    }
  }

  const passed = results.filter((r) => r.pass).length;
  console.log('');
  console.log(`结论: ${passed}/${results.length} 项通过`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(async (err) => {
  console.error('失败:', err && err.message ? err.message : err);
  try {
    if (fs.existsSync(PORT_FILE)) fs.rmSync(PORT_FILE, { force: true });
  } catch {
    /* ignore */
  }
  process.exit(1);
});
