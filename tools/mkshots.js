'use strict';
/**
 * 界面截图（生产态）：用真实引擎 + 真实转换，把界面停在「有数据、有产物」的状态再截图。
 *
 *   node tools/mkshots.js
 *
 * 为什么要单独一个脚本：直接对着空界面截图，看不出这套界面的价值。
 * 这里会像真人一样操作：入队真实转换 → 等完成 → 逐视图截图 → 还原为主题与干净状态。
 *
 * 与 tools/shot.js 的分工：
 *   shot.js      —— 在 Electron 里截图（需要 Electron GUI 能启动）
 *   mkshots.js   —— 用系统 Chrome + 开发宿主截图（无 Electron 环境下可用）
 * 两者渲染的是同一套界面代码。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { openBrowser, waitFor } = require('./browserkit');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const PORT_FILE = path.join(ROOT, '.mkshots-port.json');
const PORT = 8951 + Math.floor(Math.random() * 120);
const OUT_DIR = path.join(ROOT, '.ui-out');

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  try {
    fs.unlinkSync(PORT_FILE);
  } catch {
    /* ignore */
  }

  const server = spawn(
    process.execPath,
    [path.join(__dirname, 'devserver.js'), '--port', String(PORT), '--port-file', PORT_FILE],
    { cwd: ROOT, stdio: 'inherit', windowsHide: false }
  );

  const info = await waitFor(
    () => (fs.existsSync(PORT_FILE) ? JSON.parse(fs.readFileSync(PORT_FILE, 'utf8')) : false),
    { timeout: 120000, interval: 400, label: '开发宿主就绪' }
  );
  console.log(`[mkshots] 宿主 ${info.url}（可用内核 ${info.ready}/${info.total}）`);

  const browser = await openBrowser({ url: info.url, headless: true, width: 1500, height: 940 });
  const shot = async (name) => {
    const file = path.join(OUT, `${name}.png`);
    await browser.screenshot(file);
    console.log(`[mkshots] ${name}.png`);
  };
  const goto = async (hash, waitMs = 1500) => {
    await browser.eval(`location.hash = ${JSON.stringify(hash)}; return true;`);
    await new Promise((r) => setTimeout(r, waitMs));
  };

  try {
    await browser.eval(`await window.__khsDev.ready(); return true;`);

    // 定妆照用深色主题（默认是浅色；两种主题都支持，这里挑对比更强的深色做主视觉）
    await browser.eval(`
      await window.khs.settings.set({ theme: 'dark' });
      document.documentElement.dataset.theme = 'dark';
      await window.khs.queue.clear(false);
      return true;
    `);
    await browser.eval(`location.hash = '#/convert'; return true;`);
    await new Promise((r) => setTimeout(r, 2000));
    await shot('01-convert-empty');

    /* ------------------------------------------------------ 2. 转换工作台 */
    await goto('#/convert', 1800);
    const picked = await browser.eval(`
      const { files } = await window.khs.fs.pickFiles({});
      return files.map((f) => f.path);
    `);
    const target = await browser.eval(`
      const paths = ${JSON.stringify(picked)};
      let common = null;
      for (const p of paths) {
        const { targets } = await window.khs.plan.targets({ sourcePath: p, op: 'convert' });
        common = common === null ? new Set(targets) : new Set(targets.filter((t) => common.has(t)));
      }
      const list = common ? Array.from(common) : [];
      return list.includes('webp') ? 'webp' : list[0] || 'png';
    `);
    // 像真人一样操作：往「待转换文件」卡片上做一次真实的拖拽投放。
    // 用 File 对象 + DataTransfer 触发视图里真正的 drop 处理链路（含去重、目录递归判断）。
    const dropped = await browser.eval(`
      const paths = ${JSON.stringify(picked)};
      const { files } = await window.khs.fs.describe(paths);
      const dt = new DataTransfer();
      for (const f of files) {
        const file = new File([new Uint8Array([0])], f.name, { type: 'application/octet-stream' });
        // 浏览器不给路径，开发宿主用同一字段模拟 Electron 的 webUtils 结果
        Object.defineProperty(file, 'path', { value: f.path, enumerable: true });
        dt.items.add(file);
      }
      // 投放目标：转换页的文件列表容器（.filelist），它的父容器绑定了 drop 处理
      const zone = document.querySelector('#view .filelist') || document.querySelector('#view') || document.body;
      const opts = { bubbles: true, cancelable: true, dataTransfer: dt };
      zone.dispatchEvent(new DragEvent('dragenter', opts));
      zone.dispatchEvent(new DragEvent('dragover', opts));
      zone.dispatchEvent(new DragEvent('drop', opts));
      await new Promise((r) => setTimeout(r, 1200));
      return {
        pending: window.__khsTest && window.__khsTest.pendingCount ? window.__khsTest.pendingCount() : -1,
        listed: document.querySelectorAll('#view tbody tr').length,
        zone: zone.className,
        text: (zone.innerText || '').slice(0, 120),
      };
    `);
    console.log(`[mkshots] 拖拽投放结果：${JSON.stringify(dropped).slice(0, 160)}`);

    await browser.eval(`
      const dst = Array.from(document.querySelectorAll('#view select')).find((s) =>
        Array.from(s.options).some((o) => o.value === ${JSON.stringify(target)}));
      if (dst) { dst.value = ${JSON.stringify(target)}; dst.dispatchEvent(new Event('change', { bubbles: true })); }
      await new Promise((r) => setTimeout(r, 1400));
      // 关掉可能残留的提示条，让主画面干净
      document.querySelectorAll('#toast-host button').forEach((b) => b.click());
      return true;
    `);
    await new Promise((r) => setTimeout(r, 900));
    await shot('02-convert');

    /* ------------------------------------------------------ 3. 批量队列 */
    /* ------------------------------------------------------ 3. 批量队列 */
    const jobs = await browser.eval(`
      const paths = ${JSON.stringify(picked)};
      const dest = ${JSON.stringify(OUT_DIR)};
      const r = await window.khs.queue.enqueue({ sources: paths, op: 'convert', targetFormat: ${JSON.stringify(target)}, outDir: dest, params: {} });
      const { files } = await window.khs.fs.describe(paths);
      return r.jobs.length;
    `);
    console.log(`[mkshots] 批量队列真实入队 ${jobs} 个作业，等待完成…`);
    const final = await browser.eval(`return await window.__khsDev.awaitIdle(300000);`);
    const counts = final.counts || {};
    console.log(`[mkshots] 队列结果：完成 ${counts.done || 0} / 失败 ${counts.failed || 0}`);
    await goto('#/batch', 1800);
    await browser.eval(`
      document.querySelectorAll('#toast-host button').forEach((b) => b.click());
      // 展开第一个作业的日志，体现「作业级日志」能力（新界面里是行末的展开图标）
      const rowBtn = document.querySelector('#view tbody tr button[aria-label*="日志"], #view tbody tr button[title*="日志"]');
      if (rowBtn) rowBtn.click();
      await new Promise((r) => setTimeout(r, 700));
      return true;
    `);
    await shot('03-batch');

    /* ------------------------------------------------------ 4. 内核仓库 */
    await goto('#/kernels', 2400);
    await shot('04-kernels');

    /* ------------------------------------------------ 5. 内核详情（抽屉） */
    const detailOpened = await browser.eval(`
      // 新界面：整行可点（tr[data-kernel-id]）+ 行末非按钮提示
      const row = document.querySelector('#view tbody tr[data-kernel-id]')
        || document.querySelector('#view [data-action="kernel-detail"]')
        || Array.from(document.querySelectorAll('#view tbody tr')).find((r) => /pillow|image|内核/.test(r.innerText));
      if (!row) return { ok: false, reason: '未找到内核行' };
      row.click();
      await new Promise((r) => setTimeout(r, 1500));
      // 高级抽屉挂在 #view 内部（.sheet-host），不是 modal-host
      const panel = document.querySelector('#view .sheet-host .sheet, .sheet-host .sheet, #modal-host [role="dialog"]');
      return {
        ok: Boolean(panel) && panel.offsetHeight > 0,
        text: panel ? panel.innerText.slice(0, 160) : '',
        keywords: panel ? /能力|参数|依赖|安装|清单|优先级/.test(panel.innerText) : false,
      };
    `);
    if (detailOpened.ok && detailOpened.keywords) {
      await shot('05-kernel-detail');
    } else {
      console.log(`[mkshots] 跳过 05-kernel-detail（详情抽屉未打开：${JSON.stringify(detailOpened).slice(0, 200)}）`);
    }    await browser.eval(`
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));
      return true;
    `);

    /* ---------------------------------------------------- 6. 高级面板（转换页） */
    await goto('#/convert', 1600);
    const advancedOpened = await browser.eval(`
      // 用真实用户操作：点工具栏上的「高级」按钮
      const btn = Array.from(document.querySelectorAll('#view button')).find((b) => /高级/.test(b.innerText || ''));
      if (btn) btn.click();
      else if (window.__khsTest && typeof window.__khsTest.openAdvanced === 'function') window.__khsTest.openAdvanced();
      await new Promise((r) => setTimeout(r, 1400));
      const panel = document.querySelector('#view .sheet-host .sheet, .sheet-host .sheet, #modal-host [role="dialog"]');
      return {
        ok: Boolean(panel) && panel.offsetHeight > 0,
        text: panel ? panel.innerText.slice(0, 160) : '',
        hasParams: Boolean(panel && panel.querySelector('.param-field, .param-grid, [data-role="param"]')),
      };
    `);
    if (advancedOpened.ok) {
      await shot('06-convert-advanced');
    } else {
      console.log(`[mkshots] 跳过 06-convert-advanced（高级抽屉未打开：${JSON.stringify(advancedOpened).slice(0, 200)}）`);
    }
    await browser.eval(`
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));
      return true;
    `);

    /* ------------------------------------------------------ 7. 格式矩阵 */
    await goto('#/formats', 2200);
    await browser.eval(`
      // 点一行（新界面是整行可点），展示「该格式可达哪些目标」的联动
      const row =
        Array.from(document.querySelectorAll('#view tbody tr')).find((r) => /png/i.test(r.innerText)) ||
        document.querySelector('#view tbody tr');
      if (row) row.click();
      await new Promise((r) => setTimeout(r, 900));
      return true;
    `);
    await shot('07-formats');

    /* ------------------------------------------------------ 8. 协议规范 */
    await goto('#/protocol', 2600);
    await shot('08-protocol');

    /* ---------------------------------------------------------- 9. 设置 */
    await goto('#/settings', 2200);
    await shot('09-settings');
    // 顺便截一张「切到别的分类后」的状态（Chrome 式设置的两级结构）
    const switched = await browser.eval(`
      const item = Array.from(document.querySelectorAll('#view [data-section], #view aside a, #view aside button, #view nav a, #view nav button, #view li[role="button"]'))
        .find((el) => /内核|队列|性能|路径|关于/.test(el.innerText || ''));
      if (item) { item.click(); await new Promise((r) => setTimeout(r, 900)); return (item.innerText || '').trim(); }
      return '';
    `);
    console.log(`[mkshots] 设置页分类切换：${switched || '（未找到分类项）'}`);
    await shot('10-settings-section');

    /* ------------------------------------------------------ 11. 运行日志 */
    await goto('#/logs', 2000);
    await shot('11-logs');

    /* ---------------------------------------------------- 12. 命令面板 */
    await goto('#/convert', 1200);
    await browser.eval(`
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 700));
      return true;
    `);
    await shot('12-command-palette');

    /* ------------------------------------- 清理：删掉不再使用的旧截图 */
    for (const stale of ['01-welcome.png', '09-logs.png', '10-command-palette.png', '06-formats.png', '07-protocol.png', '08-settings.png']) {
      try {
        fs.unlinkSync(path.join(OUT, stale));
        console.log(`[mkshots] 清理旧截图 ${stale}`);
      } catch {
        /* 本来就不存在 */
      }
    }

    console.log(`\n[mkshots] 完成，截图目录：${OUT}`);
    return 0;
  } finally {
    await browser.close();
    server.kill();
    try {
      fs.unlinkSync(PORT_FILE);
    } catch {
      /* ignore */
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[mkshots] 失败：', err && err.stack ? err.stack : err);
    process.exit(1);
  });
