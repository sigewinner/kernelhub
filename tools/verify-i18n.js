'use strict';
/**
 * verify-i18n.js —— 界面语言切换验证（2.2.1）
 *
 * 做三件事：
 *   1. 中文模式下导航/状态栏确实是中文
 *   2. 切到 en-US（写 localStorage 后重载）后，导航/顶栏/状态栏/命令面板/设置页变成英文
 *   3. **量出覆盖率**：统计英文模式下外壳与设置页上还剩多少中文可见文本
 *      （未覆盖的字符串按设计回退中文，不会变空白；这里只是把范围说清楚）
 *
 * 用法: node tools/verify-i18n.js
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { openBrowser, waitFor } = require('./browserkit');

const ROOT = path.resolve(__dirname, '..');
const PORT_FILE = path.join(ROOT, '.devhost-port.json');
const PORT = 8980 + Math.floor(Math.random() * 15);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: Boolean(pass), detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
}

const READ_SHELL = `
  const nav = Array.from(document.querySelectorAll('.nav__label')).map((e) => e.innerText.trim());
  const status = document.querySelector('#statusbar') ? document.querySelector('#statusbar').innerText.replace(/\\s+/g, ' ').trim() : '';
  const brand = document.querySelector('.topbar__brand span') ? document.querySelector('.topbar__brand span').innerText.trim() : '';
  return { nav, status, brand };
`;

const READ_SETTINGS = `
  const cats = Array.from(document.querySelectorAll('.settings-nav__item')).map((e) => e.innerText.trim());
  const groups = Array.from(document.querySelectorAll('.settings-pane .settings-group')).map((e) => {
    const h = e.querySelector('.settings-group__title, h2, .label');
    return h ? h.innerText.trim() : '';
  }).filter(Boolean);
  const pane = document.querySelector('.settings-pane');
  const text = pane ? pane.innerText : '';
  const cjk = (text.match(/[\\u4e00-\\u9fff]/g) || []).length;
  const total = text.replace(/\\s/g, '').length;
  // 逐行列出仍含中文的可见文本，便于定位漏翻的串
  const left = Array.from(new Set(
    text.split('\\n').map((s) => s.trim()).filter((s) => /[\\u4e00-\\u9fff]/.test(s))
  )).slice(0, 24);
  return { cats, groups, cjk, total, left };
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

  const browser = await openBrowser({ url: info.url, headless: true, width: 1400, height: 900 });
  try {
    await new Promise((r) => setTimeout(r, 3000));

    /* ---------------------------------------------------------- 中文模式 */
    await browser.eval(`await window.khs.settings.set({ locale: 'zh-CN' }); localStorage.setItem('khs.locale', 'zh-CN'); return true;`);
    await browser.eval(`location.reload(); return true;`);
    await new Promise((r) => setTimeout(r, 2500));
    const zh = await browser.eval(READ_SHELL);
    check('中文模式：导航为中文', zh.nav.includes('转换') && zh.nav.includes('设置'), zh.nav.join(' / '));
    check('中文模式：状态栏为中文', /内核|就绪|可用/.test(zh.status), zh.status.slice(0, 60));

    /* ---------------------------------------------------------- 英文模式 */
    // 语言以**设置**为权威值（localStorage 只是给模块顶层同步读取的镜像），
    // 所以这里改设置；应用发现镜像不一致会自己重载一次。
    await browser.eval(`await window.khs.settings.set({ locale: 'en-US' }); localStorage.setItem('khs.locale', 'en-US'); return true;`);
    await browser.eval(`location.reload(); return true;`);
    await new Promise((r) => setTimeout(r, 4000));
    const en = await browser.eval(READ_SHELL);
    check(
      '英文模式：导航为英文',
      en.nav.includes('Convert') && en.nav.includes('Settings') && !en.nav.some((n) => /[\u4e00-\u9fff]/.test(n)),
      en.nav.join(' / ')
    );
    check('英文模式：状态栏为英文', /Ready|Kernels|CKP/.test(en.status), en.status.slice(0, 70));
    check('英文模式：产品名保持 KernelHub Studio', /kernelhub studio/i.test(en.brand), en.brand);

    /* ------------------------------------------------------- 设置页覆盖 */
    await browser.eval(`location.hash = '#/settings'; return true;`);
    await new Promise((r) => setTimeout(r, 1500));
    const setEn = await browser.eval(READ_SETTINGS);
    const catsEn = setEn.cats.every((c) => !/[\u4e00-\u9fff]/.test(c));
    check('英文模式：设置页分类为英文', catsEn && setEn.cats.includes('Appearance'), setEn.cats.join(' / '));
    const coverage = setEn.total ? Math.round(((setEn.total - setEn.cjk) / setEn.total) * 100) : 100;
    check(
      '英文模式：设置页可见文本覆盖率',
      coverage >= 85,
      `${coverage}%（剩余中文 ${setEn.cjk} 字符 / 共 ${setEn.total}）`
    );
    if (coverage < 85 && setEn.left.length) {
      console.log('    仍为中文的可见文本：');
      for (const line of setEn.left) console.log(`      · ${line.slice(0, 78)}`);
    }

    /* ------------------------------------------- 命令面板与高级抽屉文案 */
    const palette = await browser.eval(`
      const host = document.getElementById('cmdk-host');
      window.__khsUi && window.__khsUi.state ? null : null;
      const q = document.getElementById('cmdk-trigger');
      if (q) q.click();
      await new Promise((r) => setTimeout(r, 300));
      const el = document.querySelector('.cmdk');
      const out = el ? el.innerText.replace(/\\s+/g, ' ').trim() : '';
      if (q) q.click();
      return out;
    `);
    check(
      '英文模式：命令面板为英文',
      /Type a command|select|close|items/i.test(palette),
      palette.slice(0, 70)
    );

    /* ------------------------------------------------------- 还原为中文 */
    await browser.eval(`await window.khs.settings.set({ locale: 'zh-CN' }); localStorage.setItem('khs.locale', 'zh-CN'); return true;`);
    await browser.eval(`location.reload(); return true;`);
    await new Promise((r) => setTimeout(r, 2000));
    const back = await browser.eval(READ_SHELL);
    check('切回中文模式正常', back.nav.includes('转换'), back.nav.join(' / '));
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(PORT_FILE, { force: true });
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n结论: ${passed}/${results.length} 项通过`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((err) => {
  console.error('失败:', err && err.message ? err.message : err);
  process.exit(1);
});
