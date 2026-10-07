'use strict';
/**
 * 只补拍「内核详情」弹层这一张：从已启动的开发宿主连接，打开内核仓库 → 点详情 → 截图。
 * 用途：定妆照脚本里某一张需要单独重拍时，不必重跑整个流程。
 *
 *   node tools/shotkernel.js [--port 8799]
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { openBrowser, waitFor } = require('./browserkit');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots', '05-kernel-detail.png');
const PORT_FILE = path.join(ROOT, '.shot-kernel-port.json');
const PORT = 9101 + Math.floor(Math.random() * 150);

async function main() {
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

  const browser = await openBrowser({ url: info.url, headless: true, width: 1500, height: 940 });
  try {
    await browser.eval(`await window.__khsDev.ready(); return true;`);
    await browser.eval(`location.hash = '#/kernels'; return true;`);
    await new Promise((r) => setTimeout(r, 3000));

    const info2 = await browser.eval(`
      const btn = document.querySelector('#view button[title="查看完整详情"]')
        || Array.from(document.querySelectorAll('#view button')).find((b) => /详情/.test(b.innerText));
      if (!btn) {
        return { ok: false, buttons: Array.from(document.querySelectorAll('#view button')).map((b) => ({ t: b.innerText.trim(), title: b.title })).slice(0, 20) };
      }
      btn.click();
      await new Promise((r) => setTimeout(r, 1600));
      const host = document.getElementById('modal-host');
      const dialog = host && (host.querySelector('[role="dialog"]') || host.firstElementChild);
      return {
        ok: Boolean(dialog) && dialog.offsetHeight > 0,
        text: dialog ? dialog.innerText.slice(0, 240) : '',
        keywords: dialog ? /能力|参数|运行时|探测|安装|清单/.test(dialog.innerText) : false,
      };
    `);
    console.log('[shotkernel] 弹层状态:', JSON.stringify(info2).slice(0, 320));
    if (!info2.ok) {
      console.error('[shotkernel] 详情弹层没能打开，不生成截图');
      return 1;
    }
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    await browser.screenshot(OUT);
    console.log(`[shotkernel] 已写出 ${path.relative(ROOT, OUT)}`);
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
    console.error('[shotkernel] 失败：', err && err.stack ? err.stack : err);
    process.exit(1);
  });
