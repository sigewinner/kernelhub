'use strict';
/**
 * verify-i18n-coverage.js —— 英文化覆盖率（地面真值，2.2.3）
 *
 * 思路：静态扫描会被正则字面量、注释、跨行调用搞得不可信。
 * 这里直接在**英文模式**下把每个视图渲染一遍，读渲染结果的可见文本，
 * 数里面还剩多少中文字符，并列出残留片段 —— 这是用户真正看到的东西。
 *
 * 用法: node tools/verify-i18n-coverage.js [--threshold 100]
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { openBrowser, waitFor } = require('./browserkit');

const ROOT = path.resolve(__dirname, '..');
const PORT_FILE = path.join(ROOT, '.devhost-port.json');
const PORT = 8990 + Math.floor(Math.random() * 9);

// 每个视图：地址 + 进入后要做的动作（尽量把面板都展开）
const VIEWS = [
  { id: 'convert', hash: '#/convert', name: '转换' },
  { id: 'batch', hash: '#/batch', name: '队列' },
  { id: 'plugins-installed', hash: '#/plugins', name: '插件·已安装' },
  { id: 'plugins-available', hash: '#/plugins', name: '插件·可安装', after: `window.__covClickSeg('可安装')` },
  { id: 'formats', hash: '#/formats', name: '格式' },
  { id: 'protocol', hash: '#/protocol', name: '协议' },
  { id: 'logs', hash: '#/logs', name: '日志' },
];

const SETTINGS_PANES = ['外观', '语言与区域', '插件与内核', '队列与性能', '路径', '关于'];

const READ_TEXT = `
  const view = document.querySelector('#view');
  const text = view ? view.innerText : '';
  const cjk = (text.match(/[\\u4e00-\\u9fff]/g) || []).length;
  const total = text.replace(/\\s/g, '').length;
  const left = Array.from(new Set(
    text.split('\\n').map((s) => s.trim()).filter((s) => /[\\u4e00-\\u9fff]/.test(s))
  )).slice(0, 14);
  return { cjk, total, left };
`;

(async () => {
  fs.rmSync(PORT_FILE, { force: true });
  const server = spawn(
    process.execPath,
    [path.join(__dirname, 'devserver.js'), '--port', String(PORT), '--port-file', PORT_FILE],
    { cwd: ROOT, stdio: 'ignore' }
  );
  const info = await waitFor(
    () => (fs.existsSync(PORT_FILE) ? JSON.parse(fs.readFileSync(PORT_FILE, 'utf8')) : false),
    { timeout: 120000, interval: 300, label: 'devhost' }
  );
  const browser = await openBrowser({ url: info.url, headless: true, width: 1440, height: 950 });

  const results = [];
  try {
    // 切到英文并重载
    await browser.eval(`await window.khs.settings.set({ locale: 'en-US' }); localStorage.setItem('khs.locale','en-US'); return true;`);
    await browser.eval(`location.reload(); return true;`);
    await new Promise((r) => setTimeout(r, 4500));

    await browser.eval(`
      window.__covClickSeg = (label) => {
        const b = Array.from(document.querySelectorAll('.segmented__btn')).find((x) => x.innerText.trim() === label);
        if (b) b.click();
        return Boolean(b);
      };
      return true;
    `);

    for (const view of VIEWS) {
      await browser.eval(`location.hash = ${JSON.stringify(view.hash)}; return true;`);
      await new Promise((r) => setTimeout(r, 1600));
      if (view.after) {
        await browser.eval(`${view.after}; return true;`);
        await new Promise((r) => setTimeout(r, 1600));
      }
      const data = await browser.eval(READ_TEXT);
      results.push({ ...view, ...data });
    }

    // 格式详情卡片（2.2.4）：点第一行打开，量卡片里的文本 ——
    // 新加的格式说明是双语的，这里能验证英文模式下确实是英文
    {
      await browser.eval(`location.hash = '#/formats'; return true;`);
      await new Promise((r) => setTimeout(r, 1800));
      await browser.eval(`
        const tr = document.querySelector('#view table tbody tr');
        if (tr) tr.click();
        return true;
      `);
      await new Promise((r) => setTimeout(r, 1200));
      const data = await browser.eval(`
        const panel = document.querySelector('.sheet');
        const text = panel ? panel.innerText : '';
        const cjk = (text.match(/[\\u4e00-\\u9fff]/g) || []).length;
        const total = text.replace(/\\s/g, '').length;
        const left = Array.from(new Set(
          text.split('\\n').map((s) => s.trim()).filter((s) => /[\\u4e00-\\u9fff]/.test(s))
        )).slice(0, 10);
        return { cjk, total, left };
      `);
      results.push({ id: 'format-detail', name: '格式·详情卡片', ...data });
    }

    for (const pane of SETTINGS_PANES) {
      await browser.eval(`location.hash = '#/settings'; return true;`);
      await new Promise((r) => setTimeout(r, 1200));
      await browser.eval(`
        const item = Array.from(document.querySelectorAll('.settings-nav__item')).find((el) => el.innerText.trim() === ${JSON.stringify(pane)});
        if (item) item.click();
        return true;
      `);
      await new Promise((r) => setTimeout(r, 1200));
      const data = await browser.eval(READ_TEXT);
      results.push({ id: `settings-${pane}`, name: `设置·${pane}`, ...data });
    }

    // 还原中文，免得影响之后的开发宿主
    await browser.eval(`await window.khs.settings.set({ locale: 'zh-CN' }); localStorage.setItem('khs.locale','zh-CN'); return true;`);
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(PORT_FILE, { force: true });
  }

  let totalCjk = 0;
  let totalChars = 0;
  console.log('\n  英文模式下各视图的可见文本覆盖率：\n');
  for (const r of results) {
    totalCjk += r.cjk;
    totalChars += r.total;
    const pct = r.total ? (((r.total - r.cjk) / r.total) * 100).toFixed(1) : '100.0';
    const flag = r.cjk === 0 ? '✓' : '·';
    console.log(`    ${flag} ${r.name.padEnd(16)} ${pct.padStart(6)}%   残留中文 ${String(r.cjk).padStart(4)} 字符 / 共 ${r.total}`);
    if (r.cjk > 0) for (const line of r.left) console.log(`        · ${line.slice(0, 84)}`);
  }
  const overall = totalChars ? (((totalChars - totalCjk) / totalChars) * 100).toFixed(1) : '100.0';
  console.log(`\n  合计覆盖率 ${overall}%（残留 ${totalCjk} 中文字符 / 共 ${totalChars} 可见字符）`);

  const clean = results.filter((r) => r.cjk === 0).length;
  console.log(`  完全英文化的视图：${clean}/${results.length}`);
  process.exit(totalCjk === 0 ? 0 : 1);
})().catch((err) => {
  console.error('失败:', err && err.message ? err.message : err);
  process.exit(1);
});
