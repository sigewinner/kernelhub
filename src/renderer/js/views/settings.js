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

/** 字节 → 人类可读（设置页自己用，避免跨视图 import） */
function humanBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

const CATEGORIES = [
  { id: 'appearance', label: '外观' },
  { id: 'language', label: '语言与区域' },
  { id: 'kernels', label: '插件与内核' },
  { id: 'queue', label: '队列与性能' },
  { id: 'paths', label: '路径' },
  { id: 'about', label: '关于' },
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
    updateNote: '',
  };

  /* --------------------------------------------------------------- 结构 */

  const navEl = h('nav.settings-nav', { 'aria-label': '设置分类' });
  const paneEl = h('div.settings-pane');

  const wrap = h('div.view-inner', { dataset: { view: 'settings' } },
    h('div.view-head', null,
      h('h1.view-title', { textContent: '设置' }),
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

  function field(label, control, hint) {
    return h('div.field', null,
      h('label.label', { textContent: label }),
      control,
      hint ? h('div.field__hint', { textContent: hint }) : null
    );
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
        if (ok) ctx.toast.success('已复制');
        else ctx.toast.warn('复制失败', '当前环境不允许访问剪贴板');
      },
    });
  }

  function pathLine(label, value, extra) {
    return h('div', null,
      h('div.field__hint', { textContent: label }),
      h('div.pathline', null,
        h('span.pathline__value', { textContent: orDash(value), title: String(value || '') }),
        iconCopy(value, `复制${label}`),
        extra || null
      )
    );
  }

  function readOnlyRow(label, value) {
    return h('div.pathline', null,
      h('span.dim', { style: { minWidth: '104px' }, textContent: label }),
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

    paneEl.appendChild(group('主题',
      h('div.radiolist', null,
        makeRadio('light', '浅色'),
        makeRadio('dark', '深色')
      ),
      h('div.field__hint', {
        textContent: '界面采用瑞士风格（International Typographic Style）：网格、无衬线字、左对齐、大量留白，只用黑白灰加一个红点。浅色是默认主题，深色用于夜间或投影环境。',
      }),
      h('div.field__hint', {
        textContent: '主题写入设置并持久化，顶栏右侧的图标按钮可以在任何视图里快速切换。',
      })
    ));

    paneEl.appendChild(group('界面约定',
      h('div.field__hint', {
        textContent: '每屏可见按钮不超过 10 个：详细配置都收在「高级」抽屉里。表格行末的图标操作、字段里的浏览按钮不算按钮数量。',
      })
    ));
  }

  /* -------------------------------------------------------- 语言与区域 */

  function renderLanguage(settings) {
    paneEl.appendChild(group('语言',
      field('界面语言', h('input.input', { type: 'text', value: '简体中文', readonly: true, disabled: true }),
        '当前版本只提供简体中文界面，语言字段来自设置的 locale。'),
      readOnlyRow('设置值', settings.locale || 'zh-CN')
    ));

    paneEl.appendChild(group('数字与时间格式',
      h('div.field__hint', { textContent: '数字使用千分位分组；表格中的数字右对齐并启用等宽数字（tabular-nums）。' }),
      h('div.field__hint', { textContent: '时间使用 24 小时制，完整格式为 YYYY-MM-DD HH:MM:SS，日志中只显示 HH:MM:SS。' }),
      h('div.field__hint', { textContent: '文件体积按 1024 进制换算（B / KB / MB / GB / TB）。' })
    ));
  }

  /* ------------------------------------------------------------ 内核 */

  function renderKernels(settings) {
    const layout = vs.layout || store.pick('layout') || {};
    const extraDirs = Array.isArray(settings.extraPluginDirs) ? settings.extraPluginDirs.slice() : [];
    const disabled = Array.isArray(settings.disabledKernels) ? settings.disabledKernels : [];

    const addBtn = h('button.btn', {
      type: 'button',
      title: '添加一个额外的内核插件目录',
      on: {
        click: async () => {
          try {
            const res = await window.khs.fs.pickFolder({ title: '选择额外的插件目录' });
            if (!res || !res.folder) return;
            const folder = String(res.folder);
            if (extraDirs.includes(folder)) {
              ctx.toast.info('该目录已经在列表里');
              return;
            }
            await save({ extraPluginDirs: extraDirs.concat([folder]) }, '插件目录已添加');
            await ctx.refreshKernels();
          } catch (err) {
            ctx.reportError('添加插件目录失败', ctx.wrapError(err));
          }
        },
      },
    }, h('span', { textContent: '添加目录' }));

    const dirRows = extraDirs.length
      ? extraDirs.map((dir) => h('div.pathline', null,
        h('span.pathline__value', { textContent: dir, title: dir }),
        iconAction({
          classes: ['iconbtn'],
          label: '移除该目录',
          children: [icon('close', { size: 14 })],
          onClick: async () => {
            await save({ extraPluginDirs: extraDirs.filter((d) => d !== dir) }, '插件目录已移除');
            await ctx.refreshKernels();
          },
        })
      ))
      : [h('div.field__hint', { textContent: '还没有额外插件目录。' })];

    const autoScan = h('input.check', { type: 'checkbox', checked: settings.autoScan !== false });
    autoScan.addEventListener('change', () => save({ autoScan: autoScan.checked }, autoScan.checked ? '启动时自动扫描已开启' : '启动时自动扫描已关闭'));

    paneEl.appendChild(group('内核仓库',
      h('div.pathline', null,
        h('span.pathline__value', { textContent: orDash(layout.hubRoot), title: String(layout.hubRoot || '') }),
        iconCopy(layout.hubRoot, '复制内核仓库目录'),
        iconAction({
          classes: ['iconbtn'],
          label: '在资源管理器中打开内核仓库目录',
          children: [icon('folderOpen', { size: 14 })],
          onClick: () => ctx.openPathSafe(layout.hubRoot, '内核仓库'),
        })
      ),
      h('div.field__hint', { textContent: '该目录由主进程在启动时探测得到（也可以由环境变量指定），界面上是只读的。' })
    ));

    paneEl.appendChild(group('额外插件目录',
      ...dirRows,
      h('div.row.gap-2', null, addBtn)
    ));

    // 2.1.0：自动补装插件依赖时用的 pip 源
    const pipIndexInput = h('input.input.input--mono', {
      type: 'text',
      value: String((settings && settings.pipIndexUrl) || ''),
      placeholder: 'https://pypi.tuna.tsinghua.edu.cn/simple',
      'aria-label': 'pip 源',
    });
    pipIndexInput.addEventListener('change', () =>
      save({ pipIndexUrl: pipIndexInput.value.trim() }, '已保存 pip 源')
    );
    paneEl.appendChild(group('依赖安装',
      h('div.field', null,
        h('label.label', { textContent: 'pip 源' }),
        pipIndexInput
      ),
      h('div.field__hint', {
        textContent: '插件缺 Python 依赖时的自动安装源（默认清华镜像）。装不上会自动回退到 PyPI 官方源。',
      })
    ));

    paneEl.appendChild(group('扫描',
      h('label.check-row', null, autoScan, h('span', { textContent: '启动时自动扫描内核' })),
      h('div.field__hint', { textContent: '关闭后启动不会重新探测依赖，需要在「插件 → 已安装」里手动点「重新扫描」。' }),
      h('div.pathline', null,
        h('span.dim', { style: { minWidth: '104px' }, textContent: '已停用内核' }),
        h('span.pathline__value', { textContent: `${disabled.length} 个` }),
        h('a.linkbtn', { href: '#/plugins', textContent: '前往插件页管理' })
      )
    ));

    if (Array.isArray(layout.searchPaths) && layout.searchPaths.length) {
      paneEl.appendChild(group('搜索路径',
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
        await save({ maxParallel: n }, `并发上限已设为 ${n}`);
      } catch (err) {
        ctx.reportError('设置并发上限失败', ctx.wrapError(err));
      }
    });

    const timeoutInput = h('input.input.input--num', {
      type: 'number',
      min: '1000',
      step: '1000',
      value: String(Number(settings.timeoutMs) || 600000),
    });
    const secondsHint = h('div.field__hint', {
      textContent: `≈ ${((Number(settings.timeoutMs) || 600000) / 1000).toFixed(0)} 秒`,
    });
    timeoutInput.addEventListener('input', () => {
      const ms = Number(timeoutInput.value);
      secondsHint.textContent = Number.isFinite(ms) && ms > 0 ? `≈ ${(ms / 1000).toFixed(0)} 秒` : '请输入毫秒数';
    });
    timeoutInput.addEventListener('change', () => {
      const ms = Math.max(1000, Number(timeoutInput.value) || 600000);
      timeoutInput.value = String(ms);
      save({ timeoutMs: ms }, '单次调用超时已保存');
    });

    paneEl.appendChild(group('并发',
      field('并发上限（1–8）', h('div.num-row', null, slider, parallelValue),
        '队列同时执行的作业数量；改小可以减轻机器压力，改大可以更快跑完批量任务。')
    ));

    paneEl.appendChild(group('超时',
      field('单次调用超时（毫秒）', timeoutInput,
        '单个内核调用超过该时长会被判定为失败；下方显示换算后的秒数。'),
      secondsHint
    ));

    paneEl.appendChild(group('日志缓冲',
      readOnlyRow('最多保留', `${thousands(Number(settings.keepLogLines) || 4000)} 行`),
      h('div.field__hint', { textContent: '日志超过上限后会丢弃最早的行；日志页可以手动清空。' })
    ));
  }

  /* ------------------------------------------------------------ 路径 */

  function renderPaths() {
    const layout = vs.layout || store.pick('layout') || {};
    const info = vs.info || store.pick('info') || {};

    paneEl.appendChild(group('应用路径',
      pathLine('状态目录（设置、缓存与日志）', info.stateDir),
      pathLine('运行目录（临时作业文件）', layout.runDir)
    ));

    paneEl.appendChild(group('内核与协议路径',
      pathLine('内核仓库目录', layout.hubRoot),
      pathLine('插件目录', layout.pluginsDir),
      pathLine('内置内核目录', layout.vendorDir),
      pathLine('协议 Schema 目录', layout.schemaDir)
    ));

    paneEl.appendChild(group('Python',
      pathLine('解释器', layout.python),
      readOnlyRow('版本', layout.pythonVersion || '—'),
      h('div.field__hint', { textContent: 'Python 由主进程在启动时探测，内核适配器以它为运行时。' })
    ));

    if (Array.isArray(layout.sysPath) && layout.sysPath.length) {
      paneEl.appendChild(group('运行时搜索路径',
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
   */
  function renderUpdateGroup(info) {
    const state = vs.updateState;
    const checkBtn = h('button.btn', {
      type: 'button',
      title: '到 GitHub Release 上找工作目录大版本里最新的版本',
      on: { click: () => checkUpdate() },
    }, h('span', { textContent: state && state.checking ? '检测中…' : '检测更新' }));

    const rows = [
      h('div.kv__k', { textContent: '当前版本' }),
      h('div.kv__v.mono', { textContent: orDash(info.version) }),
    ];

    let status = null;
    if (!state) {
      status = h('div.field__hint', { textContent: '点「检测更新」到 GitHub 上查看同大版本是否有新版本。' });
    } else if (state.checking) {
      status = h('div.field__hint', { textContent: '正在查询 GitHub Release…' });
    } else if (!state.ok) {
      status = h('div.strip.strip--warn', null, h('span', { textContent: `检测失败：${state.error}` }));
    } else if (!state.hasUpdate) {
      status = h('div.strip.strip--ok', null,
        h('span', { textContent: `已是最新（${state.major}.x 里最新为 ${state.latest}）` })
      );
    }

    const actions = [checkBtn];

    if (state && state.ok && state.hasUpdate) {
      rows.push(h('div.kv__k', { textContent: '最新版本' }), h('div.kv__v.mono.accent', { textContent: state.latest }));
      if (state.asset) {
        rows.push(
          h('div.kv__k', { textContent: '安装包' }),
          h('div.kv__v.mono', { textContent: `${state.asset.name}　${humanBytes(state.asset.size)}` })
        );
      }
      const downBtn = h('button.btn.btn--primary', {
        type: 'button',
        title: '下载安装包并启动安装向导',
        on: { click: () => downloadUpdate() },
      }, h('span', { textContent: '下载并启动安装' }));
      actions.push(downBtn);

      if (state.url) {
        actions.push(h('button.btn', {
          type: 'button',
          title: '在浏览器里打开 Release 页面',
          on: { click: () => window.khs.update.openRelease(state.url) },
        }, h('span', { textContent: '查看更新说明' })));
      }

      status = h('div.strip.strip--warn', null,
        h('span', {
          textContent: `发现新版本 ${state.latest}（${state.major}.x 系列）。更新会下载安装包并启动安装向导，按向导完成即可；已安装的插件与设置不会丢。`,
        })
      );
    }

    if (vs.updateProgress) {
      actions.push(h('span.mono.dim', { textContent: vs.updateProgress }));
    }

    paneEl.appendChild(group('更新',
      h('div.kv', null, ...rows),
      status,
      h('div.row.gap-2', null, ...actions),
      vs.updateNote ? h('div.field__hint', { textContent: vs.updateNote }) : null
    ));
  }

  async function checkUpdate() {
    // 浏览器开发宿主没有 update 桥：优雅降级，别把整个设置页弄崩
    if (!window.khs || !window.khs.update || typeof window.khs.update.check !== 'function') {
      vs.updateState = { ok: false, error: '当前运行方式（浏览器宿主）不支持检测更新' };
      renderPane();
      return;
    }
    vs.updateState = { checking: true };
    vs.updateNote = '';
    renderPane();
    try {
      const res = await window.khs.update.check();
      vs.updateState = res || { ok: false, error: '空响应' };
    } catch (err) {
      vs.updateState = { ok: false, error: String(err && err.message ? err.message : err) };
    }
    renderPane();
  }

  async function downloadUpdate() {
    const state = vs.updateState;
    if (!state || !state.asset) return;
    vs.updateProgress = '准备下载…';
    vs.updateNote = '';
    renderPane();
    try {
      const res = await window.khs.update.download({
        url: state.asset.url,
        name: state.asset.name,
        size: state.asset.size,
        launch: true,
      });
      if (!res || !res.ok) {
        vs.updateProgress = '';
        vs.updateNote = `下载失败：${(res && res.error) || '未知错误'}`;
      } else if (res.launchError) {
        vs.updateProgress = '';
        vs.updateNote = `已下载到 ${res.path}，但启动安装程序失败：${res.launchError}`;
      } else {
        vs.updateProgress = '';
        vs.updateNote = `安装包已下载（${humanBytes(res.bytes)}）并已启动安装向导。`;
      }
    } catch (err) {
      vs.updateProgress = '';
      vs.updateNote = `下载异常：${String(err && err.message ? err.message : err)}`;
    }
    renderPane();
  }

  /* ------------------------------------------------------------ 关于 */

  function renderAbout(settings) {
    const info = vs.info || store.pick('info') || {};
    paneEl.appendChild(group('版本',
      h('div.kv', null,
        h('div.kv__k', { textContent: '应用版本' }), h('div.kv__v.mono', { textContent: orDash(info.version) }),
        h('div.kv__k', { textContent: '协议版本' }), h('div.kv__v.mono', { textContent: info.ckp ? `CKP ${info.ckp}` : '—' }),
        h('div.kv__k', { textContent: '设置结构' }), h('div.kv__v.mono', { textContent: String(orDash(settings.version)) }),
        h('div.kv__k', { textContent: 'Electron' }), h('div.kv__v.mono', { textContent: orDash(info.electron) }),
        h('div.kv__k', { textContent: 'Chromium' }), h('div.kv__v.mono', { textContent: orDash(info.chrome) }),
        h('div.kv__k', { textContent: 'Node' }), h('div.kv__v.mono', { textContent: orDash(info.node) }),
        h('div.kv__k', { textContent: '平台' }), h('div.kv__v', { textContent: `${platformLabel(info.platform)} · ${orDash(info.arch)}` }),
        h('div.kv__k', { textContent: '开发模式' }), h('div.kv__v', { textContent: info.dev ? '是' : '否' })
      )
    ));

    renderUpdateGroup(info);

    if (vs.doctorError) {
      paneEl.appendChild(group('自检',
        h('div.error-state', null,
          h('div.error-state__msg', { textContent: vs.doctorError }),
          h('button.linkbtn', { type: 'button', on: { click: () => loadDoctor() } }, h('span', { textContent: '重试' }))
        )
      ));
      return;
    }

    const doctor = vs.doctor;
    if (!doctor) {
      paneEl.appendChild(group('自检',
        h('div.skeleton', { style: { width: '100%' } }),
        h('div.skeleton', { style: { width: '60%', marginTop: 'var(--sp-2)' } })
      ));
      return;
    }

    const kernels = Array.isArray(doctor.kernels) ? doctor.kernels : [];
    const ready = kernels.filter((k) => k.status === 'ready').length;
    const broken = kernels.filter((k) => k.status !== 'ready');

    paneEl.appendChild(group('自检结果',
      h('div.kv', null,
        h('div.kv__k', { textContent: 'Node（自检）' }), h('div.kv__v.mono', { textContent: orDash(doctor.node) }),
        h('div.kv__k', { textContent: 'Python' }), h('div.kv__v.mono', { textContent: orDash((doctor.layout || {}).pythonVersion) }),
        h('div.kv__k', { textContent: '可用内核' }), h('div.kv__v.mono', { textContent: `${ready} / ${kernels.length}` })
      )
    ));

    if (broken.length) {
      const body = h('tbody');
      for (const k of broken) {
        body.appendChild(h('tr', null,
          h('td', { class: 'truncate', textContent: k.name || k.id }),
          h('td', { class: 'mono', textContent: orDash(k.statusLabel || k.status) }),
          h('td', { class: 'truncate', textContent: orDash(k.installHint) })
        ));
      }
      paneEl.appendChild(group('需要处理的内核',
        h('table.table', null,
          h('colgroup', null,
            h('col', { style: { width: '30%' } }),
            h('col', { style: { width: '14%' } }),
            h('col', { style: { width: '56%' } })
          ),
          h('thead', null, h('tr', null,
            h('th', { textContent: '内核' }),
            h('th', { textContent: '状态' }),
            h('th', { textContent: '安装提示' })
          )),
          body
        )
      ));
    } else {
      paneEl.appendChild(group('需要处理的内核',
        h('div.field__hint', { textContent: '全部内核都可用，没有需要补齐的依赖。' })
      ));
    }

    paneEl.appendChild(group('原始自检数据',
      h('div.codeblock.codeblock--wrap', null,
        h('div.codeblock__bar', null,
          h('span', { textContent: 'doctor() 返回值（截断展示）' }),
          iconAction({
            classes: ['textbtn'],
            label: '复制自检报告',
            children: [h('span', { textContent: '复制' })],
            onClick: async () => {
              const ok = await copyText(prettyJson(doctor, ''));
              if (ok) ctx.toast.success('自检报告已复制');
              else ctx.toast.warn('复制失败', '当前环境不允许访问剪贴板');
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
      ctx.reportError('运行自检失败', ctx.wrapError(err));
    }
    if (vs.cat === 'about') renderPane();
  }

  async function loadEnv() {
    try {
      const [info, layout] = await Promise.all([window.khs.app.info(), window.khs.app.layout()]);
      vs.info = info;
      vs.layout = layout;
    } catch (err) {
      ctx.reportError('读取应用信息失败', ctx.wrapError(err));
    }
    renderPane();
  }

  disposers.push(store.subscribe((state, changed) => {
    if (!changed.includes('settings')) return;
    renderPane();
  }));

  // 更新包下载进度（2.2.0）：只在「关于」页且正在下载时更新那一行文字
  disposers.push(window.khs.on('evt:update:progress', (payload) => {
    if (!payload) return;
    if (payload.phase === 'download') {
      vs.updateProgress = `下载中 ${payload.percent || 0}%（${humanBytes(payload.received)} / ${humanBytes(payload.total)}）`;
    } else if (payload.phase === 'start') {
      vs.updateProgress = '开始下载…';
    } else if (payload.phase === 'done') {
      vs.updateProgress = '下载完成，正在启动安装向导…';
    } else if (payload.phase === 'error') {
      vs.updateProgress = '';
      vs.updateNote = String(payload.message || '下载失败');
    } else {
      return;
    }
    if (vs.cat === 'about') renderPane();
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
