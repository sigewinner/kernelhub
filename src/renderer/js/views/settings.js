/**
 * views/settings.js —— 设置（Chrome 设置架构）
 *
 * 版面（docs/ui-spec-swiss.md 4.7）：0~1 个按钮
 *   左 3 栏：分类列表（外观 / 语言与区域 / 内核 / 队列与性能 / 路径 / 关于）
 *   右 9 栏：当前分类的字段（每组之间 1px 分隔线 + 小节标题）
 *
 * 只有当前分类会被渲染 —— 这是 Chrome 设置页最关键的信息架构取舍。
 * 字段名严格来自 docs/renderer-api.md 的 khs.settings.get()，不臆造。
 * 「文字链」一律用 <a>（链接不计入每屏按钮数），只有真正的动作才是 <button>。
 */

import { h, clear, on, copyText, iconAction } from '../dom.js';
import { icon } from '../icons.js';
import { thousands, platformLabel, prettyJson, orDash } from '../format.js';
import { t, LOCALES, initLocale, statusText } from '../i18n.js';

/** 字节 → 人类可读（设置页自己用，避免跨视图 import） */
function humanBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

const CATEGORIES = [
  { id: 'appearance', label: t('外观') },
  { id: 'language', label: t('语言与区域') },
  { id: 'kernels', label: t('插件与内核') },
  { id: 'queue', label: t('队列与性能') },
  { id: 'paths', label: t('路径') },
  { id: 'about', label: t('关于') },
];

export async function mount(host, ctx) {
  const { store } = ctx;
  const disposers = [];

  const vs = {
    cat: 'appearance',
    doctor: null,
    doctorError: null,
    info: store.pick('info') || null,
    layout: store.pick('layout') || null,
    refreshing: false,
    /* 检测更新（2.2.0）：null = 还没点过 */
    updateState: null,
    updateProgress: '',
    updatePercent: 0,
    updateNote: '',
  };

  /* --------------------------------------------------------------- 结构 */

  const navEl = h('nav.settings-nav', { 'aria-label': t('设置分类') });
  const paneEl = h('div.settings-pane');

  const wrap = h('div.view-inner', { dataset: { view: 'settings' } },
    h('div.view-head', null,
      h('h1.view-title', { textContent: t('设置') }),
      h('div.view-rule')
    ),
    h('div.settings-grid', null, navEl, paneEl)
  );
  host.appendChild(wrap);

  /* --------------------------------------------------------------- 工具 */

  function group(title, ...children) {
    return h('section.settings-group', null,
      h('div.settings-group__title', { textContent: title }),
      ...children.filter(Boolean)
    );
  }

  /**
   * 字段。第三参数是**悬停提示**，不再渲染成页面上的一行小字（2.2.3）。
   * 理由：这些说明（例如「并发改小可以减轻机器压力…」）只有在你要调它的时候才有用，
   * 平时却一直占着版面；挂到 title 上，鼠标停上去才出现。
   */
  function field(label, control, hint) {
    const labelEl = h('label.label', { textContent: label });
    if (hint) {
      labelEl.title = hint;
      if (control && control.setAttribute && !control.title) control.title = hint;
      else if (control && control.nodeType === 1 && !control.title) control.title = hint;
    }
    return h('div.field', null, labelEl, control);
  }

  /**
   * 字段里的复制图标：刻意用 <span role="button">（见 dom.js 的 iconAction）。
   * 「路径」分类里有 7 个路径，如果每个复制都是 <button>，一屏就是 7 个按钮。
   */
  function iconCopy(text, title) {
    return iconAction({
      classes: ['iconbtn'],
      label: title || '复制',
      children: [icon('copy', { size: 14 })],
      onClick: async () => {
        const ok = await copyText(String(text || ''));
        if (ok) ctx.toast.success(t('已复制'));
        else ctx.toast.warn(t('复制失败'), '当前环境不允许访问剪贴板');
      },
    });
  }

  function pathLine(label, value, extra) {
    return h('div', null,
      h('div.pathline__label', { textContent: label }),
      h('div.pathline', null,
        h('span.pathline__value', { textContent: orDash(value), title: String(value || '') }),
        iconCopy(value, t('复制{0}', { 0: label })),
        extra || null
      )
    );
  }

  function readOnlyRow(label, value, hint) {
    const labelEl = h('span.dim', { style: { minWidth: '104px' }, textContent: label });
    if (hint) labelEl.title = hint;
    return h('div.pathline', null,
      labelEl,
      h('span.pathline__value', { textContent: orDash(value), title: String(value || '') })
    );
  }

  async function save(patch, note) {
    const next = await ctx.patchSettings(patch, { silent: true });
    if (next) ctx.toast.success(note || '设置已保存');
    renderPane();
  }

  /* --------------------------------------------------------------- 渲染 */

  let navIndicatorEl = null;
  const navLinks = [];

  function renderNav() {
    clear(navEl);
    navLinks.length = 0;
    // 选中指示块：与侧栏导航同源，切换分类时滑过去
    navIndicatorEl = h('div.settings-nav__indicator');
    navEl.appendChild(navIndicatorEl);

    for (const item of CATEGORIES) {
      // 分类导航用 <a>（链接）而不是 <button>：它只负责切换右侧内容，
      // 和侧栏导航同类；规范里「链接不算按钮」，这样设置页的按钮数才落在 0~1。
      const link = h('a.settings-nav__item', {
        role: 'tab',
        tabindex: '0',
        dataset: { cat: item.id },
        textContent: item.label,
        on: {
          click: (event) => {
            event.preventDefault();
            selectCategory(item.id);
          },
          keydown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              selectCategory(item.id);
            }
          },
        },
      });
      if (item.id === vs.cat) link.setAttribute('aria-current', 'page');
      navLinks.push({ id: item.id, el: link });
      navEl.appendChild(link);
    }
    moveNavIndicator(false);
  }

  /** 把指示块挪到当前分类上；animate=false 用于首次定位与尺寸变化 */
  function moveNavIndicator(animate = true) {
    if (!navIndicatorEl) return;
    const hit = navLinks.find((l) => l.id === vs.cat);
    if (!hit) return;
    const transform = `translateY(${hit.el.offsetTop}px)`;
    const height = `${hit.el.offsetHeight}px`;
    if (navIndicatorEl.style.transform === transform && navIndicatorEl.style.height === height) return;
    if (!animate) navIndicatorEl.style.transition = 'none';
    navIndicatorEl.style.transform = transform;
    navIndicatorEl.style.height = height;
    if (!animate) {
      void navIndicatorEl.offsetHeight;
      navIndicatorEl.style.transition = '';
    }
  }

  function selectCategory(id) {
    vs.cat = id;
    // 只改选中标记 + 挪指示块，不重建导航（重建就没有滑动可言了）
    for (const item of navLinks) {
      if (item.id === id) item.el.setAttribute('aria-current', 'page');
      else item.el.removeAttribute('aria-current');
    }
    moveNavIndicator(true);
    renderPane();
  }

  function renderPane() {
    clear(paneEl);
    const settings = store.pick('settings') || {};
    switch (vs.cat) {
      case 'language': renderLanguage(settings); break;
      case 'kernels': renderKernels(settings); break;
      case 'queue': renderQueue(settings); break;
      case 'paths': renderPaths(settings); break;
      case 'about': renderAbout(settings); break;
      case 'appearance':
      default: renderAppearance(settings); break;
    }
    // 新内容淡入（2.2.0）。先移除再强制重排，保证同名动画能重播。
    paneEl.classList.remove('settings-pane--enter');
    void paneEl.offsetWidth;
    paneEl.classList.add('settings-pane--enter');
  }

  /* ------------------------------------------------------------ 外观 */

  function renderAppearance(settings) {
    const current = String(settings.theme) === 'dark' ? 'dark' : 'light';
    const makeRadio = (value, label, note) => {
      const input = h('input', {
        type: 'radio',
        name: 'khs-theme',
        value,
        checked: current === value,
        on: {
          change: () => {
            if (input.checked) save({ theme: value }, value === 'dark' ? '已切换到深色主题' : '已切换到浅色主题');
          },
        },
      });
      return h('label.radio', null, input, h('span', { textContent: label }), note ? h('span.dim', { textContent: note }) : null);
    };

    // 2.2.3：主题下方原本有两段说明小字（瑞士风格、写入设置），已去掉 ——
    // 主题是两个单选按钮，选一下就知道效果，说明只是占版面。
    paneEl.appendChild(group(t('主题'),
      h('div.radiolist', null,
        makeRadio('light', t('浅色')),
        makeRadio('dark', t('深色'))
      )
    ));
  }

  /* -------------------------------------------------------- 语言与区域 */

  function renderLanguage(settings) {
    // 2.2.1：语言可切换。切换后重载界面 —— 让所有模块按新语言重新构建，
    // 比逐个重渲染安全得多（模块顶层就有 t() 调用，见 i18n.js 的说明）。
    const localeSelect = h('select.select', { 'aria-label': t('界面语言') });
    for (const item of LOCALES) {
      localeSelect.appendChild(h('option', {
        value: item.id,
        textContent: item.label,
        selected: (settings.locale || 'zh-CN') === item.id,
      }));
    }
    localeSelect.addEventListener('change', async () => {
      const next = localeSelect.value;
      await save({ locale: next }, next === 'en-US' ? 'Language switched to English' : '已切换为简体中文');
      initLocale(next);
      location.reload();
    });

    paneEl.appendChild(group(t('语言'),
      field(t('界面语言'), localeSelect, t('切换后界面会重新加载，已英文化的范围见下表。')),
      readOnlyRow(t('设置值'), settings.locale || 'zh-CN')
    ));
  }

  /* ------------------------------------------------------------ 内核 */

  function renderKernels(settings) {
    const layout = vs.layout || store.pick('layout') || {};
    const extraDirs = Array.isArray(settings.extraPluginDirs) ? settings.extraPluginDirs.slice() : [];
    const disabled = Array.isArray(settings.disabledKernels) ? settings.disabledKernels : [];

    const addBtn = h('button.btn', {
      type: 'button',
      title: t('添加一个额外的内核插件目录'),
      on: {
        click: async () => {
          try {
            const res = await window.khs.fs.pickFolder({ title: t('选择额外的插件目录') });
            if (!res || !res.folder) return;
            const folder = String(res.folder);
            if (extraDirs.includes(folder)) {
              ctx.toast.info(t('该目录已经在列表里'));
              return;
            }
            await save({ extraPluginDirs: extraDirs.concat([folder]) }, '插件目录已添加');
            await ctx.refreshKernels();
          } catch (err) {
            ctx.reportError(t('添加插件目录失败'), ctx.wrapError(err));
          }
        },
      },
    }, h('span', { textContent: t('添加目录') }));

    const dirRows = extraDirs.length
      ? extraDirs.map((dir) => h('div.pathline', null,
        h('span.pathline__value', { textContent: dir, title: dir }),
        iconAction({
          classes: ['iconbtn'],
          label: t('移除该目录'),
          children: [icon('close', { size: 14 })],
          onClick: async () => {
            await save({ extraPluginDirs: extraDirs.filter((d) => d !== dir) }, '插件目录已移除');
            await ctx.refreshKernels();
          },
        })
      ))
      : [h('div.note-line.dim', { textContent: t('还没有额外插件目录。') })];

    const autoScan = h('input.check', { type: 'checkbox', checked: settings.autoScan !== false });
    autoScan.addEventListener('change', () => save({ autoScan: autoScan.checked }, autoScan.checked ? '启动时自动扫描已开启' : '启动时自动扫描已关闭'));

    paneEl.appendChild(group(t('内核仓库'),
      h('div.pathline', null,
        h('span.pathline__value', { textContent: orDash(layout.hubRoot), title: String(layout.hubRoot || '') }),
        iconCopy(layout.hubRoot, '复制内核仓库目录'),
        iconAction({
          classes: ['iconbtn'],
          label: t('在资源管理器中打开内核仓库目录'),
          children: [icon('folderOpen', { size: 14 })],
          onClick: () => ctx.openPathSafe(layout.hubRoot, '内核仓库'),
        })
      )
    ));

    paneEl.appendChild(group(t('额外插件目录'),
      ...dirRows,
      h('div.row.gap-2', null, addBtn)
    ));

    // 2.1.0：自动补装插件依赖时用的 pip 源
    const pipIndexInput = h('input.input.input--mono', {
      type: 'text',
      value: String((settings && settings.pipIndexUrl) || ''),
      placeholder: 'https://pypi.tuna.tsinghua.edu.cn/simple',
      'aria-label': t('pip 源'),
    });
    pipIndexInput.addEventListener('change', () =>
      save({ pipIndexUrl: pipIndexInput.value.trim() }, '已保存 pip 源')
    );
    paneEl.appendChild(group(t('依赖安装'),
      field(t('pip 源'), pipIndexInput,
        t('插件缺 Python 依赖时的自动安装源（默认清华镜像）。装不上会自动回退到 PyPI 官方源。'))
    ));

    const autoScanRow = h('label.check-row', null, autoScan, h('span', { textContent: t('启动时自动扫描内核') }));
    autoScanRow.title = t('关闭后启动不会重新探测依赖，需要在「插件 → 已安装」里手动点「重新扫描」。');
    paneEl.appendChild(group(t('扫描'),
      autoScanRow,
      h('div.pathline', null,
        h('span.dim', { style: { minWidth: '104px' }, textContent: t('已停用内核') }),
        h('span.pathline__value', { textContent: t('{0} 个', { 0: disabled.length }) }),
        h('a.linkbtn', { href: '#/plugins', textContent: t('前往插件页管理') })
      )
    ));

    if (Array.isArray(layout.searchPaths) && layout.searchPaths.length) {
      paneEl.appendChild(group(t('搜索路径'),
        ...layout.searchPaths.map((p) => h('div.pathline', null,
          h('span.pathline__value', { textContent: String(p), title: String(p) }),
          iconCopy(p, '复制搜索路径')
        ))
      ));
    }
  }

  /* ------------------------------------------------------ 队列与性能 */

  function renderQueue(settings) {
    const parallel = Math.min(8, Math.max(1, Number(settings.maxParallel) || 1));
    const slider = h('input.slider', {
      type: 'range',
      min: '1',
      max: '8',
      step: '1',
      value: String(parallel),
    });
    const parallelValue = h('span.mono', { textContent: String(parallel) });
    slider.addEventListener('input', () => { parallelValue.textContent = slider.value; });
    slider.addEventListener('change', async () => {
      const n = Number(slider.value) || 1;
      try {
        await window.khs.queue.setParallel(n);
        await save({ maxParallel: n }, t('并发上限已设为 {0}', { 0: n }));
      } catch (err) {
        ctx.reportError(t('设置并发上限失败'), ctx.wrapError(err));
      }
    });

    const timeoutInput = h('input.input.input--num', {
      type: 'number',
      min: '1000',
      step: '1000',
      value: String(Number(settings.timeoutMs) || 600000),
    });
    // 动态数值显示（毫秒 ↔ 秒），不是说明小字：它是输入框的实时换算结果
    const secondsHint = h('div.note-line.mono', {
      textContent: t('≈ {0} 秒', { 0: ((Number(settings.timeoutMs) || 600000) / 1000).toFixed(0) }),
    });
    timeoutInput.addEventListener('input', () => {
      const ms = Number(timeoutInput.value);
      secondsHint.textContent = Number.isFinite(ms) && ms > 0 ? t('≈ {0} 秒', { 0: (ms / 1000).toFixed(0) }) : t('请输入毫秒数');
    });
    timeoutInput.addEventListener('change', () => {
      const ms = Math.max(1000, Number(timeoutInput.value) || 600000);
      timeoutInput.value = String(ms);
      save({ timeoutMs: ms }, '单次调用超时已保存');
    });

    paneEl.appendChild(group(t('并发'),
      field(t('并发上限（1–8）'), h('div.num-row', null, slider, parallelValue),
        t('队列同时执行的作业数量；改小可以减轻机器压力，改大可以更快跑完批量任务。'))
    ));

    paneEl.appendChild(group(t('超时'),
      field(t('单次调用超时（毫秒）'), timeoutInput,
        t('单个内核调用超过该时长会被判定为失败；下方显示换算后的秒数。')),
      secondsHint
    ));

    paneEl.appendChild(group(t('日志缓冲'),
      readOnlyRow(t('最多保留'), t('{n} 行', { n: thousands(Number(settings.keepLogLines) || 4000) }),
        t('日志超过上限后会丢弃最早的行；日志页可以手动清空。'))
    ));
  }

  /* ------------------------------------------------------------ 路径 */

  function renderPaths() {
    const layout = vs.layout || store.pick('layout') || {};
    const info = vs.info || store.pick('info') || {};

    paneEl.appendChild(group(t('应用路径'),
      pathLine(t('状态目录（设置、缓存与日志）'), info.stateDir),
      pathLine(t('运行目录（临时作业文件）'), layout.runDir)
    ));

    paneEl.appendChild(group(t('内核与协议路径'),
      pathLine(t('内核仓库目录'), layout.hubRoot),
      pathLine(t('插件目录'), layout.pluginsDir),
      pathLine(t('内置内核目录'), layout.vendorDir),
      pathLine(t('协议 Schema 目录'), layout.schemaDir)
    ));

    paneEl.appendChild(group('Python',
      pathLine(t('解释器'), layout.python),
      readOnlyRow(t('版本'), layout.pythonVersion || '—')
    ));

    if (Array.isArray(layout.sysPath) && layout.sysPath.length) {
      paneEl.appendChild(group(t('运行时搜索路径'),
        ...layout.sysPath.slice(0, 12).map((p) => h('div.pathline', null,
          h('span.pathline__value', { textContent: String(p), title: String(p) }),
          iconCopy(p, '复制搜索路径')
        ))
      ));
    }
  }

  /* ------------------------------------------------------- 检测更新（2.2.0） */

  /**
   * 更新检测只认**同一个大版本**：当前 2.x → 只推 2.x 里最新的那个。
   * 跨大版本可能有破坏性改动，交回用户自己决定。
   *
   * 2.2.2：这一组**只建一次骨架**，之后所有状态变化都走 paintUpdate() 就地更新。
   * 之前是每次状态变化都调 renderPane() 重建整块面板 —— 下载进度事件约每 120ms 一次，
   * 整页反复重建并重播 settings-pane--enter 淡入动画，观感就是「频闪」。
   */
  let updRefs = null;

  function renderUpdateGroup(info) {
    const labelEl = h('span', { textContent: t('检测更新') });
    const checkBtn = h('button.btn', {
      type: 'button',
      title: t('到 GitHub Release 上找工作目录大版本里最新的版本'),
      on: { click: () => checkUpdate() },
    }, labelEl);

    const latestKey = h('div.kv__k', { textContent: t('最新版本') });
    const latestVal = h('div.kv__v.mono.accent');
    const assetKey = h('div.kv__k', { textContent: t('安装包') });
    const assetVal = h('div.kv__v.mono');
    const kv = h('div.kv', null,
      h('div.kv__k', { textContent: t('当前版本') }),
      h('div.kv__v.mono', { textContent: orDash(info.version) }),
      latestKey, latestVal,
      assetKey, assetVal
    );

    const statusText = h('span');
    const statusStrip = h('div.strip', null, statusText);

    // 进度条：复用全局 .progress（本来就带缓进缓出），配百分比与说明文字
    const progressFill = h('div.progress__fill');
    const progressTrack = h('div.progress.progress--install', null, progressFill);
    const progressPct = h('span.progress__pct');
    const progressMsg = h('span.progress-label');
    const progressWrap = h('div.upd-progress', null,
      h('div.progress-row', null, progressTrack, progressPct),
      progressMsg
    );

    const downBtn = h('button.btn.btn--primary', {
      type: 'button',
      title: t('下载后静默安装到第一次安装时选定的目录'),
      on: { click: () => downloadUpdate() },
    }, h('span', { textContent: t('下载并静默安装') }));

    const notesBtn = h('button.btn', {
      type: 'button',
      title: t('在浏览器里打开 Release 页面'),
      on: {
        click: () => {
          const url = vs.updateState && vs.updateState.url;
          if (url) window.khs.update.openRelease(url);
        },
      },
    }, h('span', { textContent: t('查看更新说明') }));

    const actionsRow = h('div.row.gap-2', null, checkBtn, downBtn, notesBtn);
    const noteEl = h('div.upd-note');

    updRefs = {
      labelEl, checkBtn, latestKey, latestVal, assetKey, assetVal,
      statusStrip, statusText, progressWrap, progressTrack, progressFill, progressPct, progressMsg,
      downBtn, notesBtn, noteEl,
    };
    paintUpdate();
    paneEl.appendChild(group(t('更新'), kv, statusStrip, progressWrap, actionsRow, noteEl));
  }

  /**
   * 就地刷新更新分组。**不要**在这里调 renderPane()：
   * 那会清空重建整块设置面板，进度条每帧都在重建 → 频闪（2.2.2 修的就是这个）。
   */
  function paintUpdate() {
    const r = updRefs;
    if (!r) return;
    const state = vs.updateState;
    const hasUpdate = Boolean(state && state.ok && state.hasUpdate);
    const checking = Boolean(state && state.checking);

    r.labelEl.textContent = checking ? t('检测中…') : t('检测更新');
    r.checkBtn.disabled = checking;

    // 「最新版本 / 安装包」两行只在发现更新时出现
    r.latestKey.hidden = !hasUpdate;
    r.latestVal.hidden = !hasUpdate;
    r.assetKey.hidden = !(hasUpdate && state.asset);
    r.assetVal.hidden = !(hasUpdate && state.asset);
    if (hasUpdate) r.latestVal.textContent = String(state.latest || '');
    if (hasUpdate && state.asset) {
      r.assetVal.textContent = `${state.asset.name}　${humanBytes(state.asset.size)}`;
    }

    if (!state) {
      r.statusStrip.className = 'strip';
      r.statusText.textContent = t('点「检测更新」到 GitHub 上查看同大版本是否有新版本。');
    } else if (checking) {
      r.statusStrip.className = 'strip';
      r.statusText.textContent = t('正在查询 GitHub Release…');
    } else if (!state.ok) {
      r.statusStrip.className = 'strip strip--warn';
      r.statusText.textContent = t('检测失败：{error}', { error: state.error });
    } else if (!state.hasUpdate) {
      r.statusStrip.className = 'strip strip--ok';
      r.statusText.textContent = t('已是最新（{major}.x 里最新为 {latest}）', {
        major: state.major,
        latest: state.latest,
      });
    } else {
      r.statusStrip.className = 'strip strip--warn';
      r.statusText.textContent = t(
        '发现新版本 {latest}（{major}.x 系列）。更新会关闭本窗口并静默安装到第一次安装时选定的目录，完成后重新打开即可；已安装的插件与设置不会丢。',
        { latest: state.latest, major: state.major }
      );
    }

    r.downBtn.hidden = !hasUpdate;
    r.notesBtn.hidden = !(hasUpdate && state.url);

    // 进度：有文案就显示这一块；百分比未知时用呼吸态
    const pct = Number(vs.updatePercent);
    r.progressWrap.hidden = !vs.updateProgress;
    if (vs.updateProgress) {
      r.progressMsg.textContent = vs.updateProgress;
      if (Number.isFinite(pct) && pct > 0) {
        r.progressTrack.classList.remove('progress--indeterminate');
        r.progressFill.style.width = `${Math.max(2, Math.min(100, pct))}%`;
        r.progressPct.textContent = `${Math.round(pct)}%`;
      } else {
        r.progressTrack.classList.add('progress--indeterminate');
        r.progressPct.textContent = '';
      }
    }

    r.noteEl.textContent = vs.updateNote || '';
    r.noteEl.hidden = !vs.updateNote;
  }

  async function checkUpdate() {
    // 浏览器开发宿主没有 update 桥：优雅降级，别把整个设置页弄崩
    if (!window.khs || !window.khs.update || typeof window.khs.update.check !== 'function') {
      vs.updateState = { ok: false, error: '当前运行方式（浏览器宿主）不支持检测更新' };
      paintUpdate();
      return;
    }
    vs.updateState = { checking: true };
    vs.updateNote = '';
    vs.updateProgress = '';
    vs.updatePercent = 0;
    paintUpdate();
    try {
      const res = await window.khs.update.check();
      vs.updateState = res || { ok: false, error: '空响应' };
    } catch (err) {
      vs.updateState = { ok: false, error: String(err && err.message ? err.message : err) };
    }
    paintUpdate();
  }

  async function downloadUpdate() {
    const state = vs.updateState;
    if (!state || !state.asset) return;
    vs.updateProgress = t('准备下载…');
    vs.updatePercent = 0;
    vs.updateNote = '';
    paintUpdate();
    try {
      const res = await window.khs.update.download({
        url: state.asset.url,
        name: state.asset.name,
        size: state.asset.size,
        launch: true,
      });
      if (!res || !res.ok) {
        vs.updateProgress = '';
        vs.updateNote = t('下载失败：{error}', { error: (res && res.error) || '未知错误' });
      } else if (res.launchError) {
        vs.updateProgress = '';
        vs.updateNote = t('已下载到 {path}，但启动安装程序失败：{error}', {
          path: res.path,
          error: res.launchError,
        });
      } else if (res.needsManual) {
        // 便携版：没有「首次安装目录」可用，只能打开所在目录由用户自行替换
        vs.updateProgress = '';
        vs.updatePercent = 100;
        vs.updateNote = t('便携版不会自动替换正在运行的程序：已在资源管理器中打开 {path}，用新版本覆盖即可。', {
          path: res.path,
        });
      } else {
        vs.updateProgress = '';
        vs.updatePercent = 100;
        vs.updateNote = t(
          '安装包已下载（{size}）并已静默启动：会按第一次安装时的设置在后台完成更新，本窗口稍后会自动关闭。',
          { size: humanBytes(res.bytes) }
        );
      }
    } catch (err) {
      vs.updateProgress = '';
      vs.updateNote = t('下载异常：{error}', { error: String(err && err.message ? err.message : err) });
    }
    paintUpdate();
  }

  /* ------------------------------------------------------------ 关于 */

  function renderAbout(settings) {
    const info = vs.info || store.pick('info') || {};
    paneEl.appendChild(group(t('版本'),
      h('div.kv', null,
        h('div.kv__k', { textContent: t('应用版本') }), h('div.kv__v.mono', { textContent: orDash(info.version) }),
        h('div.kv__k', { textContent: t('协议版本') }), h('div.kv__v.mono', { textContent: info.ckp ? `CKP ${info.ckp}` : '—' }),
        h('div.kv__k', { textContent: t('设置结构') }), h('div.kv__v.mono', { textContent: String(orDash(settings.version)) }),
        h('div.kv__k', { textContent: 'Electron' }), h('div.kv__v.mono', { textContent: orDash(info.electron) }),
        h('div.kv__k', { textContent: 'Chromium' }), h('div.kv__v.mono', { textContent: orDash(info.chrome) }),
        h('div.kv__k', { textContent: 'Node' }), h('div.kv__v.mono', { textContent: orDash(info.node) }),
        h('div.kv__k', { textContent: t('平台') }), h('div.kv__v', { textContent: `${platformLabel(info.platform)} · ${orDash(info.arch)}` }),
        h('div.kv__k', { textContent: t('开发模式') }), h('div.kv__v', { textContent: info.dev ? '是' : '否' })
      )
    ));

    renderUpdateGroup(info);

    if (vs.doctorError) {
      paneEl.appendChild(group(t('自检'),
        h('div.error-state', null,
          h('div.error-state__msg', { textContent: vs.doctorError }),
          h('button.linkbtn', { type: 'button', on: { click: () => loadDoctor() } }, h('span', { textContent: t('重试') }))
        )
      ));
      return;
    }

    const doctor = vs.doctor;
    if (!doctor) {
      paneEl.appendChild(group(t('自检'),
        h('div.skeleton', { style: { width: '100%' } }),
        h('div.skeleton', { style: { width: '60%', marginTop: 'var(--sp-2)' } })
      ));
      return;
    }

    const kernels = Array.isArray(doctor.kernels) ? doctor.kernels : [];
    const ready = kernels.filter((k) => k.status === 'ready').length;
    const broken = kernels.filter((k) => k.status !== 'ready');

    paneEl.appendChild(group(t('自检结果'),
      h('div.kv', null,
        h('div.kv__k', { textContent: t('Node（自检）') }), h('div.kv__v.mono', { textContent: orDash(doctor.node) }),
        h('div.kv__k', { textContent: 'Python' }), h('div.kv__v.mono', { textContent: orDash((doctor.layout || {}).pythonVersion) }),
        h('div.kv__k', { textContent: t('可用内核') }), h('div.kv__v.mono', { textContent: `${ready} / ${kernels.length}` })
      )
    ));

    if (broken.length) {
      const body = h('tbody');
      for (const k of broken) {
        body.appendChild(h('tr', null,
          h('td', { class: 'truncate', textContent: k.name || k.id }),
          h('td', { class: 'mono', textContent: orDash(statusText(k.status, k.statusLabel)) }),
          h('td', { class: 'truncate', textContent: orDash(k.installHint) })
        ));
      }
      paneEl.appendChild(group(t('需要处理的内核'),
        h('table.table.table--center', null,
          h('colgroup', null,
            h('col', { style: { width: '30%' } }),
            h('col', { style: { width: '14%' } }),
            h('col', { style: { width: '56%' } })
          ),
          h('thead', null, h('tr', null,
            h('th', { textContent: t('内核') }),
            h('th', { textContent: t('状态') }),
            h('th', { textContent: t('安装提示') })
          )),
          body
        )
      ));
    } else {
      // 状态行（不是说明小字）：这里报的是「全都好了」这个事实
      paneEl.appendChild(group(t('需要处理的内核'),
        h('div.strip.strip--ok', null, h('span', { textContent: t('全部内核都可用，没有需要补齐的依赖。') }))
      ));
    }

    paneEl.appendChild(group(t('原始自检数据'),
      h('div.codeblock.codeblock--wrap', null,
        h('div.codeblock__bar', null,
          h('span', { textContent: t('doctor() 返回值（截断展示）') }),
          iconAction({
            classes: ['textbtn'],
            label: t('复制自检报告'),
            children: [h('span', { textContent: t('复制') })],
            onClick: async () => {
              const ok = await copyText(prettyJson(doctor, ''));
              if (ok) ctx.toast.success(t('自检报告已复制'));
              else ctx.toast.warn(t('复制失败'), '当前环境不允许访问剪贴板');
            },
          })
        ),
        h('pre', { textContent: prettyJson(doctor, '').slice(0, 4000) })
      )
    ));
  }

  /* --------------------------------------------------------------- 数据 */

  async function loadDoctor() {
    vs.doctorError = null;
    try {
      vs.doctor = await window.khs.doctor();
    } catch (err) {
      vs.doctorError = (err && err.message) ? err.message : String(err);
      ctx.reportError(t('运行自检失败'), ctx.wrapError(err));
    }
    if (vs.cat === 'about') renderPane();
  }

  async function loadEnv() {
    try {
      const [info, layout] = await Promise.all([window.khs.app.info(), window.khs.app.layout()]);
      vs.info = info;
      vs.layout = layout;
    } catch (err) {
      ctx.reportError(t('读取应用信息失败'), ctx.wrapError(err));
    }
    renderPane();
  }

  disposers.push(store.subscribe((state, changed) => {
    if (!changed.includes('settings')) return;
    renderPane();
  }));

  // 更新包下载进度（2.2.0，2.2.2 改为就地刷新）
  // 注意：**不要**在这里调 renderPane()。进度事件约每 120ms 一次，整页重建会重播
  // 淡入动画，观感就是频闪；paintUpdate() 只改那几个节点。
  disposers.push(window.khs.on('evt:update:progress', (payload) => {
    if (!payload) return;
    if (payload.phase === 'download') {
      vs.updatePercent = Number(payload.percent) || 0;
      vs.updateProgress = t('下载中 {percent}%（{got} / {total}）', {
        percent: payload.percent || 0,
        got: humanBytes(payload.received),
        total: humanBytes(payload.total),
      });
    } else if (payload.phase === 'start') {
      vs.updatePercent = 0;
      vs.updateProgress = t('开始下载…');
    } else if (payload.phase === 'done') {
      vs.updatePercent = 100;
      vs.updateProgress = t('下载完成，正在静默安装…');
    } else if (payload.phase === 'error') {
      vs.updateProgress = '';
      vs.updateNote = String(payload.message || t('下载失败'));
    } else {
      return;
    }
    if (vs.cat === 'about') paintUpdate();
  }));

  renderNav();
  renderPane();
  // 挂载后才量得到导航项位置，这里把指示块摆好（首次不动画）
  requestAnimationFrame(() => moveNavIndicator(false));
  await loadEnv();
  loadDoctor();

  return {
    unmount() {
      while (disposers.length) {
        const dispose = disposers.pop();
        try {
          dispose();
        } catch {
          /* 忽略 */
        }
      }
      clear(host);
    },
  };
}
