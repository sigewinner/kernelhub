'use strict';
/**
 * 界面验收：启动浏览器开发宿主（真实引擎）→ 在 Chrome 里跑完整 UI 流程 → 截图 + 断言。
 *
 *   node tools/uiverify.js                    # 全量验收
 *   node tools/uiverify.js --keep             # 结束后保留浏览器（人工看）
 *   node tools/uiverify.js --shots-only       # 只截图
 *
 * 说明：本机沙箱下 Electron 的 GUI 进程无法启动，因此界面验证走系统 Chrome；
 * 渲染的是同一套 HTML/CSS/JS，宿主能力由 tools/devserver.js 提供（同样是真实内核）。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { openBrowser, waitFor } = require('./browserkit');

const ROOT = path.resolve(__dirname, '..');
// 验收截图与「成品截图」分开放：docs/screenshots 放的是给文档用的定妆照（tools/mkshots.js），
// 每次跑验收都会覆盖的留痕放到 docs/screenshots/verify/。
const SHOT_DIR = path.join(ROOT, 'docs', 'screenshots', 'verify');
const PORT_FILE = path.join(ROOT, '.devhost-port.json');
const PORT = 8712 + Math.floor(Math.random() * 200);

const ARGV = process.argv.slice(2);
const KEEP = ARGV.includes('--keep');
const SHOTS_ONLY = ARGV.includes('--shots-only');

const results = [];
const consoleErrors = [];

function check(name, pass, detail = '') {
  results.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? '  ✓' : '  ✕'} ${name}${!pass && detail ? `  ← ${detail}` : ''}`);
  return Boolean(pass);
}

async function main() {
  try {
    fs.unlinkSync(PORT_FILE);
  } catch {
    /* ignore */
  }

  console.log('[uiverify] 启动浏览器开发宿主…');
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
  console.log(`[uiverify] 宿主已就绪：${info.url}（可用内核 ${info.ready}/${info.total}）`);

  const browser = await openBrowser({ url: info.url, headless: true, width: 1500, height: 960 });
  const errors = [];
  browser.session.ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      const text = (msg.params.args || []).map((a) => a.value || a.description || '').join(' ');
      errors.push(text);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails || {};
      errors.push((d.exception && (d.exception.description || d.exception.value)) || d.text || '未知异常');
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      errors.push(`${msg.params.entry.text} ${msg.params.entry.url || ''}`.trim());
    }
  });
  await browser.session.send('Log.enable');

  const screenshot = async (name, opts) => {
    const file = path.join(SHOT_DIR, `${name}.png`);
    await browser.screenshot(file, opts);
    console.log(`[uiverify] 截图 → ${path.relative(ROOT, file)}`);
    return file;
  };

  const goto = async (hash, waitMs = 900) => {
    await browser.eval(`location.hash = ${JSON.stringify(hash)}; return true;`);
    await new Promise((r) => setTimeout(r, waitMs));
  };

  const domStats = () =>
    browser.eval(`
      const txt = (el) => (el && (el.innerText || el.textContent || '')) || '';
      const view = document.querySelector('#view') || document.body;
      return {
        view: location.hash,
        text: txt(view).slice(0, 4000),
        textLength: txt(view).length,
        buttons: Array.from(document.querySelectorAll('#view button')).map((b) => txt(b)).filter(Boolean).slice(0, 40),
        navItems: Array.from(document.querySelectorAll('#nav a, #nav button')).map((n) => txt(n)).filter(Boolean),
        kernelCards: document.querySelectorAll('#view [data-kernel-id], #view .kernel-card, #view .card').length,
        statusbar: txt(document.querySelector('#statusbar')),
        toasts: Array.from(document.querySelectorAll('#toast-host *')).map((t) => txt(t)).slice(0, 6),
      };
    `);

  try {
    /* ---------------------------------------------------------- 启动序列 */
    console.log('\n【1】启动序列与外壳');
    await browser.waitForExpr('document.documentElement.dataset.khsBridge === "ready"', 20000, 'window.khs 桥接');
    const boot = await browser.eval(`
      await window.__khsDev.ready();
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        const app = document.getElementById('app');
        const view = document.getElementById('view');
        if (app && !app.hidden && view && view.innerText.trim().length > 40) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      const info = await window.khs.app.info();
      const { kernels, summary } = await window.khs.kernels.list();
      return {
        appVisible: !document.getElementById('app').hidden,
        fallbackHidden: document.getElementById('bridge-fallback').hidden,
        title: document.title,
        ckp: info.ckp,
        kernelCount: kernels.length,
        readyCount: kernels.filter((k) => k.ready).length,
        summaryReady: summary.ready,
        nav: Array.from(document.querySelectorAll('#nav a, #nav button')).map((n) => n.innerText.trim()).filter(Boolean),
        sidebarText: document.getElementById('sidebar').innerText.slice(0, 400),
        statusbar: document.getElementById('statusbar').innerText.slice(0, 300),
      };
    `);

    check('桥接可用且应用外壳已显示', boot.appVisible && boot.fallbackHidden, JSON.stringify(boot).slice(0, 200));
    check('协议版本正确', boot.ckp === '1.0', boot.ckp);
    check('渲染出真实内核数据（19 个）', boot.kernelCount === 19, String(boot.kernelCount));
    check('可用内核数与引擎一致', boot.readyCount === info.ready && boot.summaryReady === info.ready, `ui=${boot.readyCount} engine=${info.ready}`);
    check('侧栏导航至少 8 项', boot.nav.length >= 8, boot.nav.join(' | '));
    check('状态栏显示内核可用信息', /内核|可用/.test(boot.statusbar), boot.statusbar.replace(/\n/g, ' '));
    await screenshot('01-welcome');

    if (SHOTS_ONLY) return finish(0);

    /* ------------------------------------------------------------ 转换工作台 */
    console.log('\n【2】转换工作台（真实选核 / 参数 / 落盘）');
    await goto('#/convert');
    const convertBoot = await domStats();
    check('转换视图有内容', convertBoot.textLength > 120, `textLength=${convertBoot.textLength}`);

    const picked = await browser.eval(`
      const { files } = await window.khs.fs.pickFiles({});
      return files.map((f) => f.path);
    `);
    check('能取到示例素材', picked.length > 0, JSON.stringify(picked));

    // 目标格式要覆盖所有被选中的素材：取「每个文件各自可达目标」的交集
    const target = await browser.eval(`
      const paths = ${JSON.stringify(picked)};
      let common = null;
      for (const p of paths) {
        const { targets } = await window.khs.plan.targets({ sourcePath: p, op: 'convert' });
        common = common === null ? new Set(targets) : new Set(targets.filter((t) => common.has(t)));
      }
      const list = common ? Array.from(common) : [];
      return list[0] || 'png';
    `);
    console.log(`      统一目标格式：${target}（由 plan.targets 交集得出）`);

    const added = await browser.eval(`
      const paths = ${JSON.stringify(picked)};
      const target = ${JSON.stringify(target)};
      if (typeof window.__khsTestAdd === 'function') return await window.__khsTestAdd(paths, target);
      // 没有测试钩子时，退回到宿主入队（等价于点击「开始转换」后的效果）
      const r = await window.khs.queue.enqueue({ sources: paths, op: 'convert', targetFormat: target, outDir: ${JSON.stringify(path.join(ROOT, '.ui-out'))}, params: {} });
      return { jobs: r.jobs.length, target };
    `);
    check('文件成功入队', added && added.jobs > 0, JSON.stringify(added));
    await new Promise((r) => setTimeout(r, 600));
    await goto('#/batch');

    const queueState = await browser.eval(`
      const r = await window.__khsDev.awaitIdle(240000);
      return {
        counts: r.counts,
        jobs: r.jobs.map((j) => ({ name: j.sourceName, state: j.state, out: j.output, outName: j.outputName, size: j.size, kernel: j.kernelUsed, target: j.targetFormat, err: j.error && j.error.code, msg: j.progressMessage, detail: j.error && String(j.error.detail || '').slice(-300) })),
      };
    `);
    const doneJobs = queueState.jobs.filter((j) => j.state === 'done');
    const failedJobs = queueState.jobs.filter((j) => j.state === 'failed');
    check('批量队列全部执行成功', failedJobs.length === 0 && doneJobs.length > 0, JSON.stringify(queueState.counts));
    if (failedJobs.length) {
      for (const f of failedJobs) console.log(`      失败：${f.name} → ${f.target}  [${f.err}] ${f.msg}`);
    }
    const produced = doneJobs.filter((j) => j.out && fs.existsSync(j.out) && fs.statSync(j.out).size > 0);
    check('产物真实落盘且非空', produced.length === doneJobs.length, produced.map((j) => j.outName).join(', '));
    const realKernels = doneJobs.filter((j) => j.kernel);
    check('作业记录了实际使用的内核', realKernels.length === doneJobs.length, doneJobs.map((j) => `${j.kernel}`).join(','));
    console.log(`      产物：${produced.map((j) => `${j.outName}(${j.size})`).join('，')}`);

    const batchView = await domStats();
    check('队列视图渲染出作业行', /webp|完成|成功/.test(batchView.text), batchView.text.slice(0, 160).replace(/\n/g, ' '));
    await browser.eval(`return Array.from(document.querySelectorAll('button')).some((b) => { if (/打开/.test(b.innerText)) { b.click(); return true; } return false; });`);
    await screenshot('02-batch');

    // 转换视图：参数面板必须由 ParamSpec 生成
    await goto('#/convert');
    const paramStats = await browser.eval(`
      const view = document.getElementById('view');
      return {
        inputs: view.querySelectorAll('input').length,
        selects: view.querySelectorAll('select, [role="listbox"], .select, .dropdown').length,
        sliders: view.querySelectorAll('input[type=range]').length,
        switches: view.querySelectorAll('input[type=checkbox], [role=switch], .switch').length,
        labels: Array.from(view.querySelectorAll('label')).map((l) => l.innerText.trim()).filter(Boolean).slice(0, 24),
        text: view.innerText.slice(0, 800),
      };
    `);
    check('参数面板生成了控件', paramStats.inputs + paramStats.selects + paramStats.sliders > 0, JSON.stringify(paramStats));
    check('参数面板带中文标签', paramStats.labels.some((l) => /[\u4e00-\u9fa5]/.test(l)), paramStats.labels.slice(0, 6).join(' | '));
    await screenshot('03-convert');

    /* ------------------------------------------- 测试钩子（window.__khsTest） */
    console.log('\n【2b】测试钩子：加入文件 → 选格式 → 高级面板 → 开始转换');
    const hook = await browser.eval(`
      const paths = ${JSON.stringify(picked)};
      const target = ${JSON.stringify(target)};
      if (!window.__khsTest) return { ok: false, reason: 'window.__khsTest 未暴露' };
      const before = window.__khsTest.pendingCount();
      const addedCount = await window.__khsTest.addPaths(paths);
      await window.__khsTest.setTarget(target);
      await new Promise((r) => setTimeout(r, 900));
      const select = document.querySelector('#view select[data-role="target"]');
      window.__khsTest.openAdvanced();
      await new Promise((r) => setTimeout(r, 900));
      const sheet = document.querySelector('#view .sheet');
      return {
        ok: true,
        addedCount,
        before,
        after: window.__khsTest.pendingCount(),
        selected: select ? select.value : '',
        listRows: document.querySelectorAll('#view table tbody tr').length,
        sheetVisible: Boolean(sheet) && sheet.offsetHeight > 0 && !sheet.closest('[hidden]'),
        paramFields: document.querySelectorAll('#view .param-field').length,
        openButtons: window.__khsTest.visibleButtons(),
        theme: window.__khsTest.theme(),
      };
    `);
    check('测试钩子 addPaths 把文件加入待转换列表', hook.ok && hook.addedCount === picked.length && hook.after === hook.before + picked.length, JSON.stringify({ added: hook.addedCount, before: hook.before, after: hook.after }));
    check('测试钩子 setTarget 选中目标格式', hook.ok && hook.selected === target, `${hook.selected} vs ${target}`);
    check('测试钩子 openAdvanced 打开高级面板并生成参数控件', hook.ok && hook.sheetVisible && hook.paramFields > 0, `sheet=${hook.sheetVisible} paramFields=${hook.paramFields}`);
    check('高级面板打开时可见按钮 ≤ 10', hook.ok && hook.openButtons.length <= 10, (hook.openButtons || []).join(' / '));

    const started = await browser.eval(`
      // 关掉高级面板，再用界面上的「开始转换」走真实提交通路
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      const btn = Array.from(document.querySelectorAll('#view button')).find((b) => b.innerText.trim() === '开始转换');
      if (!btn) return { ok: false, reason: '未找到「开始转换」按钮' };
      if (btn.disabled) return { ok: false, reason: '「开始转换」按钮处于禁用状态' };
      btn.click();
      await new Promise((r) => setTimeout(r, 1500));
      const { jobs } = await window.khs.queue.list();
      return { ok: true, jobs: jobs.length, target: ${JSON.stringify(target)} };
    `);
    check('通过界面「开始转换」把文件提交到队列', started.ok && started.jobs > 0, JSON.stringify(started));

    const hookQueue = await browser.eval(`
      const r = await window.__khsDev.awaitIdle(240000);
      return { counts: r.counts, jobs: r.jobs.map((j) => ({ id: j.id, state: j.state, out: j.output, size: j.size, target: j.targetFormat, err: j.error && j.error.code, msg: j.progressMessage })) };
    `);
    const hookDone = hookQueue.jobs.filter((j) => j.state === 'done');
    const hookFailed = hookQueue.jobs.filter((j) => j.state === 'failed');
    if (hookFailed.length) {
      for (const f of hookFailed) console.log(`      失败：${f.target} [${f.err}] ${f.msg}`);
    }
    check('界面通路驱动的转换全部成功', hookFailed.length === 0 && hookDone.length > 0, JSON.stringify(hookQueue.counts));
    const hookProduced = hookDone.filter((j) => j.out && fs.existsSync(j.out) && fs.statSync(j.out).size > 0);
    check('界面通路产物真实落盘（界面默认与源文件同目录）', hookDone.length > 0 && hookProduced.length === hookDone.length, hookProduced.map((j) => j.out).join(', '));

    /* -------------------------------------------------------------- 内核仓库 */
    console.log('\n【3】内核仓库');
    await goto('#/kernels');
    await new Promise((r) => setTimeout(r, 900));
    const kernelsView = await browser.eval(`
      const view = document.getElementById('view');
      const text = view.innerText;
      const detail = await window.khs.kernels.detail('pillow-image');
      return {
        textLength: text.length,
        hasPillow: /pillow-image|Pillow/.test(text),
        hasUnavailable: /未安装|依赖缺失/.test(text),
        statusChips: view.querySelectorAll('.badge, .chip, .status').length,
        clickable: view.querySelectorAll('button, [role="button"]').length,
        detailOk: detail.ok,
        detailCaps: detail.kernel ? detail.kernel.capabilities.length : 0,
        detailParams: detail.kernel ? detail.kernel.params.length : 0,
        text: text.slice(0, 500),
      };
    `);
    check('内核列表渲染出内核', kernelsView.hasPillow, kernelsView.text.slice(0, 200));
    check('展示未安装/依赖缺失状态', kernelsView.hasUnavailable);
    check('内核详情接口可用', kernelsView.detailOk && kernelsView.detailCaps > 0, `caps=${kernelsView.detailCaps} params=${kernelsView.detailParams}`);
    check('内核视图有可交互元素', kernelsView.clickable > 3, String(kernelsView.clickable));
    await screenshot('04-kernels');

    const kernelDetailUi = await browser.eval(`
      // 列表类界面是「整行可点」：详情入口是 <tr role="button">，不是每行一个 <button>
      const row = document.querySelector('#view tbody tr[data-kernel-id]');
      if (!row) return { ok: false, reason: '内核表格没有可点行' };
      row.click();
      await new Promise((r) => setTimeout(r, 1500));
      const sheet = document.querySelector('#view .sheet');
      const text = sheet ? sheet.innerText : '';
      const res = {
        ok: true,
        visible: Boolean(sheet) && sheet.offsetHeight > 0,
        hasCaps: /能力矩阵/.test(text),
        hasParams: /参数表/.test(text),
        hasRaw: /kernel\\.json/.test(text),
        hasEnable: Boolean(sheet && sheet.querySelector('input[type="checkbox"]')),
        hasPriority: Boolean(sheet && sheet.querySelector('input[type="number"]')),
        buttons: window.__khsTest.visibleButtons(),
      };
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      return res;
    `);
    check('内核详情面板可打开（整行可点 → 概览 / 能力矩阵 / 参数表 / 原始清单）', kernelDetailUi.ok && kernelDetailUi.visible && kernelDetailUi.hasCaps && kernelDetailUi.hasParams && kernelDetailUi.hasRaw, JSON.stringify(kernelDetailUi).slice(0, 220));
    check('内核详情面板含启停与优先级控件', kernelDetailUi.ok && kernelDetailUi.hasEnable && kernelDetailUi.hasPriority);
    check('内核详情打开时可见按钮 ≤ 10', kernelDetailUi.ok && kernelDetailUi.buttons.length <= 10, (kernelDetailUi.buttons || []).join(' / '));

    const toggled = await browser.eval(`
      const before = (await window.khs.kernels.list()).kernels.find((k) => k.id === 'stdlib-image');
      const r = await window.khs.kernels.setEnabled('stdlib-image', false);
      const after = (await window.khs.kernels.list()).kernels.find((k) => k.id === 'stdlib-image');
      await window.khs.kernels.setEnabled('stdlib-image', true);
      const restored = (await window.khs.kernels.list()).kernels.find((k) => k.id === 'stdlib-image');
      return { before: before.status, disabled: after.status, restored: restored.status };
    `);
    check('停用/启用内核生效', toggled.disabled === 'disabled' && toggled.restored === toggled.before, JSON.stringify(toggled));

    /* -------------------------------------------------------------- 格式矩阵 */
    console.log('\n【4】格式矩阵 / 操作目录');
    await goto('#/formats');
    await new Promise((r) => setTimeout(r, 900));
    const formatsView = await browser.eval(`
      const view = document.getElementById('view');
      const formats = await window.khs.kernels.formats();
      const ops = await window.khs.kernels.ops();
      return {
        formats: formats.length,
        ops: ops.length,
        opLabels: ops.map((o) => o.label),
        textLength: view.innerText.length,
        text: view.innerText.slice(0, 400),
      };
    `);
    check('格式矩阵数据非空', formatsView.formats > 20, String(formatsView.formats));
    check('操作目录数据非空', formatsView.ops > 0, formatsView.opLabels.join(' | '));
    check('格式视图渲染有内容', formatsView.textLength > 120, String(formatsView.textLength));
    await screenshot('05-formats');

    /* ---------------------------------------------------------------- 协议 */
    console.log('\n【5】协议规范');
    await goto('#/protocol');
    await new Promise((r) => setTimeout(r, 1000));
    const protocolView = await browser.eval(`
      const view = document.getElementById('view');
      const doc = await window.khs.protocol.doc();
      const schemas = await window.khs.protocol.schemas();
      const html = view.innerHTML;
      return {
        docOk: doc.ok,
        docLength: (doc.markdown || '').length,
        schemas: schemas.map((s) => s.name),
        textLength: view.innerText.length,
        hasHeading: /CKP|协议/.test(view.innerText),
        injectedRaw: /<script/i.test(html) && /PROTOCOL/.test(html),
        tables: view.querySelectorAll('table, pre, code').length,
        text: view.innerText.slice(0, 300),
      };
    `);
    check('能读取 PROTOCOL.md', protocolView.docOk && protocolView.docLength > 5000, `len=${protocolView.docLength}`);
    check('三份 Schema 均可用', protocolView.schemas.length === 3, protocolView.schemas.join(','));
    check('Markdown 渲染为结构化内容', protocolView.textLength > 500 && protocolView.tables > 0, `text=${protocolView.textLength} nodes=${protocolView.tables}`);
    await screenshot('06-protocol');

    /* ---------------------------------------------------------------- 设置 */
    console.log('\n【6】设置与自检');
    await goto('#/settings');
    await new Promise((r) => setTimeout(r, 900));
    const settingsView = await browser.eval(`
      const view = document.getElementById('view');
      const s = await window.khs.settings.get();
      const doc = await window.khs.doctor();
      const info = await window.khs.app.info();
      return {
        textLength: view.innerText.length,
        hasHubRoot: view.innerText.includes(String(s.hubRoot).slice(0, 8)),
        pythonShown: /py(thon)?/i.test(view.innerText),
        kernelRows: doc.kernels.length,
        stateDir: info.stateDir,
        text: view.innerText.slice(0, 300),
      };
    `);
    check('设置视图渲染有内容', settingsView.textLength > 200, String(settingsView.textLength));
    check('自检返回全部内核', settingsView.kernelRows === 19, String(settingsView.kernelRows));
    await screenshot('07-settings');

    const theme = await browser.eval(`
      const before = document.documentElement.dataset.theme || 'dark';
      const want = before === 'dark' ? 'light' : 'dark';
      const btn = document.querySelector('[data-theme-toggle="' + want + '"]');
      if (!btn) return { before, after: before, error: '未找到主题切换按钮 [data-theme-toggle="' + want + '"]' };
      btn.click();
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        const cur = document.documentElement.dataset.theme;
        if (cur === want) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      const saved = (await window.khs.settings.get()).theme;
      return { before, after: document.documentElement.dataset.theme, saved };
    `);
    check('浅色/深色主题可切换（并写回设置）', theme.after !== theme.before && theme.saved === theme.after, JSON.stringify(theme));
    await screenshot('08-settings-light');
    const restored = await browser.eval(`
      const btn = document.querySelector('[data-theme-toggle="dark"]');
      if (btn) btn.click();
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        if (document.documentElement.dataset.theme === 'dark') break;
        await new Promise((r) => setTimeout(r, 150));
      }
      return document.documentElement.dataset.theme;
    `);
    check('主题恢复为深色', restored === 'dark', restored);

    /* ---------------------------------------------------------------- 日志 */
    console.log('\n【7】运行日志');
    await goto('#/logs');
    await new Promise((r) => setTimeout(r, 900));
    const logsView = await browser.eval(`
      const view = document.getElementById('view');
      const { logs } = await window.khs.logs.list();
      return { textLength: view.innerText.length, logs: logs.length, text: view.innerText.slice(0, 200) };
    `);
    check('日志视图渲染有内容', logsView.textLength > 60, String(logsView.textLength));
    await screenshot('09-logs');

    /* -------------------------------------------------------------- 命令面板 */
    console.log('\n【8】命令面板与快捷键');
    const cmdk = await browser.eval(`
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));
      const host = document.getElementById('cmdk-host');
      const visible = host && (host.children.length > 0) && getComputedStyle(host).display !== 'none' && host.offsetHeight > 0;
      return { visible, html: host ? host.innerText.slice(0, 200) : '' };
    `);
    check('Ctrl+K 打开命令面板', cmdk.visible, JSON.stringify(cmdk).slice(0, 200));
    await screenshot('10-cmdk');
    await browser.eval(`
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      return true;
    `);

    /* -------------------------------------------------- 极简约束：按钮计数 */
    console.log('\n【9】界面极简约束（每屏可见按钮 ≤ 10）');
    const VIEW_BUDGET = [
      ['#/convert', '转换', 10],
      ['#/batch', '队列', 10],
      ['#/kernels', '内核', 10],
      ['#/formats', '格式', 10],
      ['#/protocol', '协议', 10],
      ['#/settings', '设置', 10],
      ['#/logs', '日志', 10],
    ];
    const buttonAudit = [];
    for (const [hash, label, budget] of VIEW_BUDGET) {
      await goto(hash, 1200);
      const res = await browser.eval(`
        const visible = (el) => {
          if (!el || el.closest('[hidden]')) return false;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const labelOf = (el) => (el.innerText || el.getAttribute('aria-label') || el.title || '').trim();
        // 口径：**屏幕上看得见的按钮**都算，包括表格行里的操作按钮。
        // 这也是为什么列表类界面要「整行可点」，而不是「每行一个按钮」：
        // 18 行内核 × 1 个按钮 = 用户眼睛看到 18 个按钮。
        const inView = Array.from(document.querySelectorAll('#view button')).filter(visible).map(labelOf).filter(Boolean);
        const all = Array.from(document.querySelectorAll('button')).filter(visible).map(labelOf).filter(Boolean);
        return { inView, all };
      `);
      const n = res.inView.length;
      buttonAudit.push({ label, hash, count: n, total: res.all.length, labels: res.inView });
      check(`${label}页可见按钮 ${n} 个（上限 ${budget}）`, n <= budget, res.inView.join(' / ').slice(0, 220));
      // 整窗（含外壳）也不该堆太多按钮
      check(`${label}页整窗可见按钮 ${res.all.length} 个（含外壳，上限 20）`, res.all.length <= 20, res.all.join(' / ').slice(0, 220));
    }
    console.log('  按钮清单（仅 #view 内）：');
    for (const row of buttonAudit) {
      console.log(`    ${row.label.padEnd(4)} ${String(row.count).padStart(2)} 个（整窗 ${row.total}）：${row.labels.join(' · ') || '（无）'}`);
    }

    /* ---------------------------------------------------------- 错误与异常 */
    console.log('\n【10】控制台错误');
    const hookErrors = await browser.eval('return (window.__khsTest && typeof window.__khsTest.errors === "function") ? window.__khsTest.errors() : ["window.__khsTest 未暴露"];');
    check('测试钩子 errors() 为空', Array.isArray(hookErrors) && hookErrors.length === 0, (hookErrors || []).join(' | ').slice(0, 300));
    const pageErrors = await browser.eval('return window.__khsDev.errors || [];');
    const fatal = errors.filter((e) => !/favicon|DevTools|Autofill|net::ERR_FILE_NOT_FOUND/i.test(e));
    check('页面无未捕获异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300));
    check('控制台无错误输出', fatal.length === 0, fatal.slice(0, 3).join(' | ').slice(0, 300));

    return finish(0);
  } catch (err) {
    console.error('\n[uiverify] 验收过程异常：', err && err.stack ? err.stack : err);
    try {
      await screenshot('99-failure');
    } catch {
      /* ignore */
    }
    return finish(1);
  } finally {
    if (!KEEP) {
      await browser.close();
      server.kill();
    } else {
      console.log('[uiverify] --keep：浏览器与宿主保持运行，Ctrl+C 结束');
    }
  }
}

function finish(code) {
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`界面验收：通过 ${passed} / 共 ${results.length}${failed ? `，失败 ${failed}` : ''}`);
  for (const r of results.filter((x) => !x.pass)) console.log(`  ✕ ${r.name}  ${r.detail}`);
  console.log(`截图目录：${path.relative(ROOT, SHOT_DIR)}`);
  return failed ? 1 : code;
}

main()
  .then((code) => {
    if (!KEEP) process.exit(code);
  })
  .catch((err) => {
    console.error('[uiverify] 失败：', err && err.stack ? err.stack : err);
    process.exit(1);
  });
