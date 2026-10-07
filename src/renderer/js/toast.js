/**
 * toast.js —— 通知系统
 *
 * 设计取舍：
 *   - 命令式 API（toast.success(...)）而不是声明式列表，因为绝大多数调用点
 *     是「某个异步操作失败了」这种瞬时事件。
 *   - 每个 toast 都是独立 DOM 节点、可堆叠、可按类型设置自动消失时长；
 *     error 默认不自动消失（用户需要看清原因），可手动关闭。
 *   - 支持「带动作按钮」的 toast（例如失败后「重试」），避免另开 modal 打断操作。
 */

import { h, clear, srText } from './dom.js';
import { icon } from './icons.js';
import { pushLogEntry } from './state.js';

const TYPE_META = {
  success: { icon: 'success', defaultTitle: '操作成功', ttl: 3000 },
  error: { icon: 'error', defaultTitle: '操作失败', ttl: 0 },
  warn: { icon: 'warn', defaultTitle: '注意', ttl: 6000 },
  info: { icon: 'info', defaultTitle: '提示', ttl: 3000 },
};

const MAX_VISIBLE = 6;

let host = null;
const live = new Set();

function ensureHost() {
  if (host && host.isConnected) return host;
  host = document.getElementById('toast-host');
  return host;
}

/**
 * 显示一个通知。
 * @param {'success'|'error'|'warn'|'info'} type
 * @param {string} title 主标题
 * @param {string|object} [opts] 副文本，或选项对象
 * @param {object} [opts2] 选项对象 { text, ttl, actions, onClose }
 * @returns {{ close: () => void, el: HTMLElement }}
 */
function show(type, title, opts, opts2) {
  const options = (opts && typeof opts === 'object' ? opts : { ...(opts2 || {}), text: opts }) || {};
  const meta = TYPE_META[type] || TYPE_META.info;
  const root = ensureHost();
  if (!root) return { close() {}, el: null };

  // 超出上限时先关掉最老的一条，避免刷屏淹没界面
  while (live.size >= MAX_VISIBLE) {
    const oldest = live.values().next().value;
    if (!oldest) break;
    oldest.close();
  }

  const ttl = options.ttl === undefined ? meta.ttl : Number(options.ttl);

  const closeBtn = h('button.toast__close', {
    type: 'button',
    title: '关闭',
    'aria-label': '关闭通知',
    on: { click: () => close() },
  }, icon('close', { size: 13 }), srText('关闭通知'));

  const body = h(
    'div.toast__body',
    null,
    h('div.toast__title', { textContent: String(title || meta.defaultTitle) }),
    options.text ? h('div.toast__text', { textContent: String(options.text) }) : null
  );

  // 动作按钮：最多展示两个，避免通知变成对话框
  const actions = Array.isArray(options.actions) ? options.actions.slice(0, 2) : [];
  if (actions.length) {
    const actionRow = h('div.toast__actions');
    for (const action of actions) {
      if (!action || typeof action.run !== 'function') continue;
      actionRow.appendChild(
        h('button.btn.btn--sm.btn--subtle', {
          type: 'button',
          on: {
            click: () => {
              try {
                action.run();
              } finally {
                if (action.keepOpen !== true) close();
              }
            },
          },
        }, action.label || '执行')
      );
    }
    if (actionRow.childNodes.length) body.appendChild(actionRow);
  }

  const el = h(
    `div.toast.toast--${type}`,
    { role: type === 'error' ? 'alert' : 'status' },
    h('div.toast__icon', null, icon(meta.icon, { size: 14 })),
    body,
    closeBtn
  );

  let closed = false;
  let timer = null;

  function close() {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    live.delete(handle);
    el.classList.add('toast--leaving');
    const done = () => {
      el.remove();
      if (typeof options.onClose === 'function') {
        try {
          options.onClose();
        } catch (err) {
          console.error('[toast] onClose 异常', err);
        }
      }
    };
    el.addEventListener('animationend', done, { once: true });
    // 动画被系统偏好关掉时 animationend 不会触发，兜底一个定时器
    setTimeout(done, 400);
  }

  const handle = { close, el, type };
  live.add(handle);

  // 规范第 5 节：通知同时写入日志，便于事后回溯（日志视图会看到这一行）
  try {
    pushLogEntry({
      at: Date.now(),
      level: type === 'error' ? 'error' : type === 'warn' ? 'warn' : 'info',
      message: `[通知] ${String(title || meta.defaultTitle)}${options.text ? `：${String(options.text)}` : ''}`,
      source: 'ui',
    });
  } catch {
    /* 日志失败不能影响通知本身 */
  }

  // 追加到列表末尾（toast-host 是纵向排列、锚在右下角，新通知出现在最下方）
  root.appendChild(el);

  if (Number.isFinite(ttl) && ttl > 0) {
    timer = setTimeout(close, ttl);
    // 鼠标悬停暂停计时，方便用户读完
    el.addEventListener('mouseenter', () => {
      if (timer) clearTimeout(timer);
      timer = null;
    });
    el.addEventListener('mouseleave', () => {
      if (!closed) timer = setTimeout(close, 1400);
    });
  }

  return handle;
}

export const toast = {
  success: (title, opts, opts2) => show('success', title, opts, opts2),
  error: (title, opts, opts2) => show('error', title, opts, opts2),
  warn: (title, opts, opts2) => show('warn', title, opts, opts2),
  info: (title, opts, opts2) => show('info', title, opts, opts2),

  /** 直接展示一个 Error / 异常对象（统一「错误必可见」的路径） */
  exception(title, err, extra = {}) {
    const message = err && err.message ? err.message : String(err === undefined ? '未知错误' : err);
    const detail = err && err.detail ? String(err.detail) : '';
    const code = err && err.code ? String(err.code) : '';
    const bits = [message];
    if (code) bits.push(`（${code}）`);
    return show('error', title || '操作失败', {
      text: bits.join(''),
      actions: detail
        ? [{ label: '查看详情', run: () => toast.detail(title || '错误详情', detail), keepOpen: true }]
        : undefined,
      ...extra,
    });
  },

  /** 用一条「不自动消失」的错误通知展示长详情（比 modal 打断更轻） */
  detail(title, text) {
    return show('error', title, { text, ttl: 0 });
  },

  /** 关闭全部通知 */
  clear() {
    for (const handle of Array.from(live)) handle.close();
    const root = ensureHost();
    if (root) clear(root);
  },

  /** 当前存活的通知数量（自检/调试用） */
  count() {
    return live.size;
  },
};

export default toast;
