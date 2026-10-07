/**
 * sheet.js —— 高级面板（右侧抽屉）
 *
 * 这是「按钮极少」的关键零件：每屏只留一个「高级」按钮，
 * 详细配置（内核参数、输出目录、内核选择、命令行预览、内核详情、Schema…）全部收进抽屉里。
 *
 * 约束（docs/ui-spec-swiss.md 第 3 节）：
 *   · 白底、1px 描边、直角、无阴影、无毛玻璃（遮罩只是一层很淡的纯色）
 *   · 标题 20px，右上角一个「关闭」文字按钮
 *   · 抽屉挂在视图内部（离开视图时随视图一起销毁），但用 fixed 定位浮在内容之上
 *
 * 用法：
 *   const sheet = createSheet(host, { id: 'convert-advanced', title: '高级', subtitle: '…' });
 *   sheet.body.appendChild(...);        // 内容随视图一起构建（隐藏时也在 DOM 里）
 *   sheet.foot.appendChild(...);
 *   sheet.open(); sheet.close(); sheet.toggle(); sheet.isOpen();
 */

import { h, on } from './dom.js';

export function createSheet(host, opts = {}) {
  const disposers = [];
  let open = false;

  const titleEl = h('div.sheet__title', { textContent: opts.title || '高级' });
  const subEl = h('div.sheet__sub', { textContent: opts.subtitle || '' });
  const closeBtn = h('button.btn.btn--quiet', {
    type: 'button',
    title: '关闭高级面板（Esc）',
    on: { click: () => close() },
  }, h('span', { textContent: '关闭' }));

  const body = h('div.sheet__body');
  const foot = h('div.sheet__foot');
  const panel = h('div.sheet', {
    role: 'dialog',
    'aria-modal': 'false',
    'aria-label': opts.title || '高级',
    dataset: { sheet: opts.id || 'sheet' },
  },
    h('div.sheet__head', null,
      h('div', null, titleEl, opts.subtitle === undefined ? null : subEl),
      closeBtn
    ),
    body,
    foot
  );

  const scrim = h('div.sheet-scrim', { on: { click: () => close() } });
  const root = h('div.sheet-host', null, scrim, panel);
  root.hidden = true;
  if (host) host.appendChild(root);

  function setOpen(next) {
    open = Boolean(next);
    root.hidden = !open;
    if (typeof opts.onToggle === 'function') {
      try {
        opts.onToggle(open);
      } catch (err) {
        console.error('[sheet] onToggle 异常', err);
      }
    }
  }

  function close() {
    if (open) setOpen(false);
  }

  function openSheet() {
    if (!open) setOpen(true);
  }

  function toggle() {
    setOpen(!open);
  }

  // Esc：由 app.js 统一广播（避免每个视图各自监听 document）
  disposers.push(on(window, 'khs:escape', () => close()));

  return {
    el: panel,
    root,
    body,
    foot,
    titleEl,
    subEl,
    setTitle(text) {
      titleEl.textContent = String(text || '');
    },
    setSubtitle(text) {
      subEl.textContent = String(text || '');
      subEl.hidden = !text;
    },
    open: openSheet,
    close,
    toggle,
    isOpen: () => open,
    setOpen,
    destroy() {
      while (disposers.length) {
        const off = disposers.pop();
        try {
          off();
        } catch {
          /* 忽略 */
        }
      }
      if (root.parentNode) root.parentNode.removeChild(root);
    },
  };
}

export default createSheet;
