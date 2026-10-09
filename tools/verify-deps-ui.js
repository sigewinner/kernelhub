'use strict';
/**
 * verify-deps-ui.js —— 验证「缺依赖 → 一键自动安装」这条界面链路（2.3.1）
 *
 * 为什么单独写：依赖补装的**引擎**部分可以用 Node 直接测（把 pillow 装进临时目录，
 * 见会话里的实测），但「按钮到底在不在、点了会不会真的调接口」只有把界面跑起来才算数。
 * devhost 里可以用 JS 精确点击与断言，比用鼠标坐标点可靠得多
 * （实测：窗口失去前台焦点后 SetForegroundWindow 会被 Windows 拒绝，
 *  投递 WM_LBUTTONDOWN 对 Chromium 也无效）。
 *
 * 前置状态：某个已装插件的 kernel.json 里要有 requires 且该模块确实缺失
 * （本脚本默认用 ghostscript-pdf + PIL）。
 *
 * 用法: node .gittools/verify-deps-ui.js [插件id]
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const APP = 'D:\\AAA_develop\\01_program_pdf\\kernelhub-studio';
const { openBrowser, waitFor } = require(path.join(APP, 'tools', 'browserkit.js'));

const PLUGIN = process.argv[2] || 'ghostscript-pdf';
const PORT_FILE = path.join(APP, '.devhost-port.json');
const PORT = 8970 + Math.floor(Math.random() * 9);

const results = [];
function step(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.rmSync(PORT_FILE, { force: true });
  const server = spawn(
    process.execPath,
    [path.join(APP, 'tools', 'devserver.js'), '--port', String(PORT), '--port-file', PORT_FILE],
    { cwd: APP, stdio: 'ignore' }
  );
  const info = await waitFor(
    () => (fs.existsSync(PORT_FILE) ? JSON.parse(fs.readFileSync(PORT_FILE, 'utf8')) : false),
    { timeout: 120000, interval: 300, label: 'devhost' }
  );
  const browser = await openBrowser({ url: info.url, headless: true, width: 1440, height: 950 });

  try {
    await sleep(4200); // 等启动画面

    await browser.eval(`location.hash = '#/plugins'; return true;`);
    await sleep(2400);

    // 1) 缺依赖的插件行应当存在，并且状态列写着「缺依赖」
    const row = await browser.eval(`
      const tr = document.querySelector('[data-kernel-id="${PLUGIN}"][data-action="kernel-detail"]');
      return { found: Boolean(tr), text: tr ? tr.innerText.replace(/\\s+/g, ' ').trim() : '' };
    `);
    step('缺依赖的插件行可见', Boolean(row.found), row.text.slice(0, 80));

    // 2) 点开详情卡：要有「自动安装依赖」按钮
    await browser.eval(`
      const tr = document.querySelector('[data-kernel-id="${PLUGIN}"][data-action="kernel-detail"]');
      if (tr) tr.click();
      return true;
    `);
    await sleep(2000);
    const card = await browser.eval(`
      const sheet = document.querySelector('.sheet');
      const btn = Array.from(document.querySelectorAll('.sheet button')).find((b) => /自动安装依赖/.test(b.innerText));
      const text = sheet ? sheet.innerText.replace(/\\s+/g, ' ') : '';
      return {
        hasBtn: Boolean(btn),
        mentionsTerminal: /安装命令|pip install|重新扫描后/.test(text),
        text: text.slice(0, 150),
      };
    `);
    step('详情卡里有「自动安装依赖」按钮', card.hasBtn, card.text);

    // 3) 点按钮 → 用正确参数调用补装接口，并切到「正在安装依赖…」
    const click = await browser.eval(`
      window.__depsCall = null;
      const real = window.khs.plugins.installDeps;
      window.khs.plugins.installDeps = async (p) => {
        window.__depsCall = p;
        return { ok: true, alreadyOk: false, installed: ['pillow'], indexUsed: 'https://pypi.org/simple' };
      };
      const btn = Array.from(document.querySelectorAll('.sheet button')).find((b) => /自动安装依赖/.test(b.innerText));
      if (btn) btn.click();
      await new Promise((r) => setTimeout(r, 700));
      const labels = Array.from(document.querySelectorAll('.sheet button')).map((b) => b.innerText.trim());
      window.khs.plugins.installDeps = real;
      return { call: window.__depsCall, labels };
    `);
    step(
      '点按钮确实调用了补装接口（参数 id 正确）',
      Boolean(click.call && click.call.id === PLUGIN),
      JSON.stringify(click.call)
    );
    step(
      '点击后按钮进入「正在安装依赖…」状态',
      (click.labels || []).some((x) => /正在安装/.test(x)),
      (click.labels || []).join(' / ')
    );

    // 4) 插件目录表：装了但内核不可用时，应当给出带文字的「安装依赖」按钮
    await browser.eval(`location.hash = '#/plugins'; return true;`);
    await sleep(1500);
    await browser.eval(`
      const b = Array.from(document.querySelectorAll('.segmented__btn')).find((x) => x.innerText.trim() === '可安装');
      if (b) b.click();
      return true;
    `);
    await sleep(2200);
    const catalogHint = await browser.eval(`
      const rows = Array.from(document.querySelectorAll('#view table tbody tr'));
      const all = rows.map((r) => r.innerText.replace(/\\s+/g, ' '));
      return { rows: rows.length, withDepsBtn: all.filter((x) => /安装依赖/.test(x)).length };
    `);
    step(
      '「可安装」页渲染正常（回归）',
      catalogHint.rows > 10,
      `${catalogHint.rows} 行，其中带「安装依赖」按钮 ${catalogHint.withDepsBtn} 行`
    );
  } finally {
    try {
      await browser.close();
    } catch {}
    try {
      server.kill();
    } catch {}
    fs.rmSync(PORT_FILE, { force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结论: ${results.length - failed.length}/${results.length} 项通过`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error('失败: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
