/**
 * modal.js —— 对话框
 *
 * 设计取舍：
 *   - 单实例栈：同一时刻只显示一个对话框（ESC 关闭、点击遮罩关闭、焦点归位）。
 *     桌面工具里嵌套弹窗只会让人迷路，需要「详情里再看详情」时用 tabs/折叠承载。
 *   - 全部返回 Promise：确认框 resolve(true/false)，信息框 resolve(undefined)，
 *     这样调用点可以写成 `if (!(await modal.confirm(...))) return;`。
 *   - 命令行预览 / JSON 查看器都基于同一个 shell()，只是 body 不同。
 */

import { h, clear, copyText, srText } from './dom.js';
import { icon } from './icons.js';
import { prettyJson } from './format.js';
import { toast } from './toast.js';
import { t } from './i18n.js';

let host = null;
let current = null; // { close }

function ensureHost() {
  if (host && host.isConnected) return host;
  host = document.getElementById('modal-host');
  return host;
}

/**
 * 打开一个对话框。
 * @param {object} opts
 * @param {string} opts.title 标题
 * @param {string} [opts.subtitle] 标题右侧的等宽小字（路径/id 等）
 * @param {Node|string} [opts.body] 正文
 * @param {'sm'|'md'|'lg'|'xl'} [opts.size]
 * @param {Array} [opts.actions] [{ label, kind, value, primary, run }]
 * @param {boolean} [opts.dismissable] 是否允许 ESC / 点遮罩关闭，默认 true
 * @param {() => void} [opts.onClose]
 * @returns {{ close: (value?: any) => void, el: HTMLElement }}
 */
export function open(opts = {}) {
  const root = ensureHost();
  if (!root) return { close() {}, el: null };

  // 若有旧对话框，先静默关闭，避免堆叠
  if (current) current.close(undefined, { silent: true });

  const sizeCls = opts.size === 'sm' ? ' modal--sm'
    : opts.size === 'lg' ? ' modal--lg'
      : opts.size === 'xl' ? ' modal--xl' : '';

  const titleEl = h('div.modal__title', { textContent: String(opts.title || '') });
  const head = h(
    'div.modal__head',
    null,
    titleEl,
    opts.subtitle ? h('div.modal__sub', { textContent: String(opts.subtitle) }) : null,
    h('button.modal__close', {
      type: 'button',
      title: t('关闭（Esc）'),
      'aria-label': t('关闭'),
      on: { click: () => close(undefined, { via: 'button' }) },
    }, icon('close', { size: 15 }), srText(t('关闭对话框')))
  );

  const bodyEl = h('div.modal__body');
  appendBody(bodyEl, opts.body);

  const modalEl = h(`div.modal${sizeCls}`, { role: 'dialog', 'aria-modal': 'true' }, head, bodyEl);

  const foot = h('div.modal__foot');
  const actions = Array.isArray(opts.actions) ? opts.actions : [];
  for (const action of actions) {
    if (!action) continue;
    const kind = action.kind === 'danger' ? 'btn--danger'
      : action.kind === 'ghost' ? 'btn--ghost'
        : action.primary ? 'btn--primary' : '';
    const btn = h(`button.btn${kind ? `.${kind}` : ''}`, {
      type: 'button',
      on: {
        click: () => {
          let handled = false;
          if (typeof action.run === 'function') {
            try {
              handled = action.run() === true;
            } catch (err) {
              toast.exception(t('对话框操作失败'), err);
              handled = true;
            }
          }
          if (handled || action.close !== false) close(action.value);
        },
      },
    }, action.icon ? icon(action.icon, { size: 15 }) : null, h('span', action.label || '确定'));
    foot.appendChild(btn);
  }
  if (foot.childNodes.length) modalEl.appendChild(foot);

  root.appendChild(modalEl);
  root.dataset.open = 'true';

  let closed = false;
  const previousFocus = document.activeElement;

  function close(value, meta = {}) {
    if (closed) return;
    closed = true;
    root.dataset.open = 'false';
    clear(root);
    document.removeEventListener('keydown', onKeydown, true);
    current = null;
    if (previousFocus && typeof previousFocus.focus === 'function' && previousFocus.isConnected) {
      try {
        previousFocus.focus();
      } catch {
        /* 焦点归位失败无所谓 */
      }
    }
    if (typeof opts.onClose === 'function') {
      try {
        opts.onClose(value);
      } catch (err) {
        console.error('[modal] onClose 异常', err);
      }
    }
    if (resolveFn) resolveFn(value);
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (opts.dismissable === false) return;
      close(undefined, { via: 'esc' });
    }
  }

  let resolveFn = null;
  const promise = new Promise((resolve) => {
    resolveFn = resolve;
  });

  root.addEventListener('mousedown', (event) => {
    if (event.target === root && opts.dismissable !== false) close(undefined, { via: 'backdrop' });
  });

  document.addEventListener('keydown', onKeydown, true);

  // 只把焦点交给「输入类」元素：聚焦按钮会平白画出焦点环，且 ESC 由全局快捷键统一处理
  const focusTarget = modalEl.querySelector('input:not([type="hidden"]), textarea, [data-autofocus]');
  if (focusTarget) {
    try {
      focusTarget.focus();
      if (typeof focusTarget.select === 'function' && focusTarget.tagName === 'INPUT') focusTarget.select();
    } catch {
      /* 忽略 */
    }
  }

  current = { close, el: modalEl };
  return { close, el: modalEl, result: promise };
}

/** 把 body 描述（Node / 字符串 / 节点数组）挂到容器上 */
function appendBody(container, body) {
  if (body === null || body === undefined) return;
  if (Array.isArray(body)) {
    body.forEach((item) => appendBody(container, item));
    return;
  }
  container.appendChild(typeof body === 'string' ? document.createTextNode(body) : body);
}

/** 构建一个「可复制的代码块」，返回元素 */
export function codeBlock(content, { lang = '', wrap = true, maxHeight = '' } = {}) {
  const textValue = String(content === null || content === undefined ? '' : content);
  const pre = h('pre', { textContent: textValue });
  if (maxHeight) pre.style.maxHeight = maxHeight;

  const copyBtn = h('button.btn.btn--ghost.btn--sm', {
    type: 'button',
    on: {
      click: async () => {
        const ok = await copyText(textValue);
        if (ok) toast.success(t('已复制到剪贴板'), { text: t('{0} 个字符', { 0: textValue.length }) });
        else toast.warn(t('复制失败'), '当前环境不允许访问剪贴板，请手动选择文本复制');
      },
    },
  }, icon('copy', { size: 14 }), h('span', '复制'));

  return h(
    `div.codeblock${wrap ? '.codeblock--wrap' : ''}`,
    null,
    h('div.codeblock__toolbar', null, h('span.codeblock__lang', { textContent: lang || t('纯文本 · {0} 字符', { 0: textValue.length }) }), copyBtn),
    pre
  );
}

/** 构建一个路径芯片（点击复制） */
export function pathChip(pathValue, { label = '', onOpen = null } = {}) {
  const value = String(pathValue || '');
  const chip = h('button.path-chip', {
    type: 'button',
    title: t('{0}\\n（单击复制）', { 0: value }),
    on: {
      click: async (event) => {
        if (onOpen && event.altKey) {
          onOpen(value);
          return;
        }
        const ok = await copyText(value);
        if (ok) toast.success(t('路径已复制'));
        else toast.warn(t('复制失败'), '请手动选择路径文本');
      },
    },
  }, icon('copy', { size: 12 }), h('span.path-chip__text', { textContent: label || value }));
  return chip;
}

/* ------------------------------------------------------------ 常用对话框 */

/** 确认框：resolve(true) / resolve(false) */
export async function confirm(message, opts = {}) {
  const { result } = open({
    title: opts.title || '确认操作',
    size: 'sm',
    body: h(
      'div.col.gap-4',
      null,
      h('div.modal__message', { textContent: String(message) }),
      opts.detail ? codeBlock(opts.detail, { lang: '详情' }) : null
    ),
    actions: [
      { label: opts.cancelLabel || '取消', kind: 'ghost', value: false },
      { label: opts.okLabel || '确定', kind: opts.danger ? 'danger' : undefined, primary: !opts.danger, value: true },
    ],
  });
  return (await result) === true;
}

/** 信息框（单按钮） */
export async function info(title, body, opts = {}) {
  const { result } = open({
    title,
    subtitle: opts.subtitle,
    size: opts.size || 'md',
    body: typeof body === 'string' ? h('div.modal__message', { textContent: body }) : body,
    actions: [{ label: opts.okLabel || '知道了', primary: true, value: true }],
  });
  return result;
}

/** 详情框：长文本 + 复制 */
export async function detail(title, text, opts = {}) {
  const { result } = open({
    title,
    subtitle: opts.subtitle,
    size: opts.size || 'lg',
    body: codeBlock(text, { lang: opts.lang || t('纯文本 · {0} 字符', { 0: String(text || '').length }), wrap: opts.wrap !== false }),
    actions: [{ label: t('关闭'), kind: 'ghost', value: false }],
  });
  return result;
}

/**
 * 命令行预览框：展示 argv 数组，逐段可读，支持复制整条命令。
 * @param {object} preview khs.plan.preview 的返回值
 */
export async function commandPreview(preview) {
  const body = h('div.col.gap-4');

  if (preview && preview.ok === false) {
    body.appendChild(h(
      'div.error-state',
      null,
      h('div.error-state__head', null, icon('error', { size: 15 }), h('span', '无法生成命令行')),
      h('div.error-state__msg', { textContent: t('{0}：{1}', { 0: preview.code || 'ERROR', 1: preview.message || '未知原因' }) }),
      preview.detail ? h('div.error-state__detail', { textContent: String(preview.detail) }) : null
    ));
    const { result } = open({
      title: t('命令行预览'),
      size: 'lg',
      body,
      actions: [{ label: t('关闭'), kind: 'ghost', value: false }],
    });
    return result;
  }

  const argv = Array.isArray(preview && preview.argv) ? preview.argv : null;
  const outputs = Array.isArray(preview && preview.outputs) ? preview.outputs : [];
  const kernel = (preview && preview.kernel) || {};

  body.appendChild(h(
    'div.kv',
    null,
    h('div.kv__k', '内核'),
    h('div.kv__v', { textContent: `${kernel.name || '—'}${kernel.id ? `（${kernel.id}）` : ''}` }),
    h('div.kv__k', '源格式'),
    h('div.kv__v', { textContent: String(preview.sourceFormat || '—').toUpperCase() }),
    h('div.kv__k', '输出'),
    h('div.kv__v.kv__v--mono', { textContent: outputs.join('\n') || '—' })
  ));

  if (argv) {
    // 用逐行「一行一个参数」的展示，便于看清每个 argv 元素
    const lines = [argv[0] || '', ...argv.slice(1)].join('\n');
    body.appendChild(h('div.modal__section', null,
      h('div.modal__section-title', null, icon('terminal', { size: 14 }), h('span', t('argv（{0} 项）', { 0: argv.length }))),
      codeBlock(argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' '), { lang: '单行命令（可直接粘贴）' }),
      h('div', { style: { height: 'var(--sp-3)' } }),
      codeBlock(lines, { lang: '逐项参数' })
    ));
  }

  if (preview && preview.note) {
    body.appendChild(h('div.strip', null, icon('info', { size: 14 }), h('span', { textContent: String(preview.note) })));
  }

  const { result } = open({
    title: t('真实命令行预览'),
    subtitle: t('不会执行任何命令'),
    size: 'xl',
    body,
    actions: [
      {
        label: t('复制 argv'),
        icon: 'copy',
        kind: 'ghost',
        close: false,
        run: async () => {
          const text = argv ? argv.join(' ') : '';
          const ok = await copyText(text);
          if (ok) toast.success(t('已复制 argv'));
          else toast.warn(t('复制失败'), '请手动选择文本复制');
          return false;
        },
      },
      { label: t('关闭'), kind: 'ghost', value: false },
    ],
  });
  return result;
}

/**
 * JSON 查看器：字符串会被美化；解析失败时按纯文本展示并给出提示。
 * @param {string} title
 * @param {string|object} value
 */
export async function json(title, value, opts = {}) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const pretty = prettyJson(raw, String(raw));
  const isJson = pretty !== String(raw) || (typeof value === 'object');
  const body = h('div.col.gap-3');
  if (!isJson) {
    body.appendChild(h('div.strip.strip--warn', null, icon('warn', { size: 14 }), h('span', '内容不是合法 JSON，已按纯文本展示。')));
  }
  body.appendChild(codeBlock(pretty, { lang: opts.lang || (isJson ? 'JSON' : '纯文本') }));
  const { result } = open({
    title,
    subtitle: opts.subtitle,
    size: opts.size || 'xl',
    body,
    actions: [{ label: t('关闭'), kind: 'ghost', value: false }],
  });
  return result;
}

/** 是否已有打开的对话框（ESC 处理优先级用） */
export function isOpen() {
  return Boolean(current);
}

/** 关闭当前对话框 */
export function closeCurrent() {
  if (current) current.close(undefined, { via: 'api' });
}

export const modal = { open, confirm, info, detail, commandPreview, json, codeBlock, pathChip, isOpen, closeCurrent };
export default modal;
