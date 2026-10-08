/**
 * toast.js —— 通知系统
 *
 * 设计取舍：
 *   - 命令式 API（toast.success(...)）而不是声明式列表，因为绝大多数调用点
 *     是「某个异步操作失败了」这种瞬时事件。
 *   - 每个 toast 都是独立 DOM 节点、可堆叠、可按类型设置自动消失时长；
 *     error 默认不自动消失（用户需要看清原因），可手动关闭。
 *   - 支持「带动作按钮」的 toast（例如失败后「重试」），避免另开 modal 打断操作。
 *
 * 2.0.3 的两处手感改动：
 *   1. **同类型通知覆盖当前的**。批量失败时容易连发好几条同类型通知，一屏卡片
 *      长得一模一样、还各自倒计时，用户根本来不及看。现在同类型只保留最新一条：
 *      内容就地交叉淡入替换、计时重置，卡片本身不移位（不会闪）。
 *   2. **卡片进出场与堆叠让位都带缓动**。移除一张卡片后，余下的卡片用 FLIP
 *      （移除前量旧位置 → 改 DOM → 再量新位置 → 从位移差动画回 0）平滑让位，
 *      而不是瞬间跳到新位置。
 *   两条在系统「减少动态效果」偏好下都会自动退化为直接切换。
 */

import { h, clear, srText } from './dom.js';
import { icon } from './icons.js';
import { pushLogEntry } from './state.js';
import { t } from './i18n.js';

const TYPE_META = {
  success: { icon: 'success', defaultTitle: '操作成功', ttl: 3000 },
  error: { icon: 'error', defaultTitle: '操作失败', ttl: 0 },
  warn: { icon: 'warn', defaultTitle: '注意', ttl: 6000 },
  info: { icon: 'info', defaultTitle: '提示', ttl: 3000 },
};

const MAX_VISIBLE = 6;

/** 卡片让位动画时长（与 CSS 的 --t-base 同量级） */
const FLIP_MS = 220;
/** 出场动画的兜底时长（系统偏好关闭动画时 animationend 不会触发） */
const LEAVE_FALLBACK_MS = 500;

let host = null;
const live = new Set();
/** 每种类型当前的那一张卡片（同类型再来消息就替换它，而不是再叠一张） */
const currentByType = new Map();

function ensureHost() {
  if (host && host.isConnected) return host;
  host = document.getElementById('toast-host');
  return host;
}

/** 系统是否要求减少动态效果（无障碍） */
function reducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function writeLog(type, title, options) {
  // 规范第 5 节：通知同时写入日志，便于事后回溯（日志视图会看到这一行）
  try {
    pushLogEntry({
      at: Date.now(),
      level: type === 'error' ? 'error' : type === 'warn' ? 'warn' : 'info',
      message: `[通知] ${String(title || (TYPE_META[type] || TYPE_META.info).defaultTitle)}${
        options.text ? `：${String(options.text)}` : ''
      }`,
      source: 'ui',
    });
  } catch {
    /* 日志失败不能影响通知本身 */
  }
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
  const incoming = (opts && typeof opts === 'object' ? opts : { ...(opts2 || {}), text: opts }) || {};
  const meta = TYPE_META[type] || TYPE_META.info;
  const root = ensureHost();
  if (!root) return { close() {}, el: null };

  // 同类型已有卡片 → 就地覆盖它（不新增、不移位、计时重置）
  const existing = currentByType.get(type);
  if (existing && existing.isAlive()) {
    existing.update(title, incoming);
    return existing;
  }

  // 超出上限时先关掉最老的一条，避免刷屏淹没界面
  while (live.size >= MAX_VISIBLE) {
    const oldest = live.values().next().value;
    if (!oldest) break;
    oldest.close();
  }

  let closed = false;
  let timer = null;
  let options = { ...incoming };
  let ttl = options.ttl === undefined ? meta.ttl : Number(options.ttl);

  const closeBtn = h('button.toast__close', {
    type: 'button',
    title: t('关闭'),
    'aria-label': t('关闭通知'),
    on: { click: () => close() },
  }, icon('close', { size: 13 }), srText(t('关闭通知')));

  const body = h('div.toast__body');
  const el = h(
    `div.toast.toast--${type}`,
    { role: type === 'error' ? 'alert' : 'status' },
    h('div.toast__icon', null, icon(meta.icon, { size: 14 })),
    body,
    closeBtn
  );

  /** 把标题/正文/动作按钮填进目标节点（覆盖时复用同一个 body，只换内容） */
  function renderBody(target, text, optsIn) {
    clear(target);
    target.appendChild(h('div.toast__title', { textContent: String(text || meta.defaultTitle) }));
    if (optsIn.text) {
      target.appendChild(h('div.toast__text', { textContent: String(optsIn.text) }));
    }
    const actions = Array.isArray(optsIn.actions) ? optsIn.actions.slice(0, 2) : [];
    if (!actions.length) return;
    const row = h('div.toast__actions');
    for (const action of actions) {
      if (!action || typeof action.run !== 'function') continue;
      row.appendChild(
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
    if (row.childNodes.length) target.appendChild(row);
  }

  function armTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!Number.isFinite(ttl) || ttl <= 0) return;
    timer = setTimeout(close, ttl);
  }

  /** 同类型覆盖：换内容 + 交叉淡入 + 重置计时 */
  function update(nextTitle, nextOptions) {
    if (closed) return;
    options = { ...options, ...nextOptions };
    renderBody(body, nextTitle, options);
    ttl = nextOptions.ttl === undefined ? meta.ttl : Number(nextOptions.ttl);

    if (!reducedMotion()) {
      // 一次性 class 播一段交叉淡入；先移除再强制重排，保证同名动画能重播
      body.classList.remove('toast__swapping');
      void body.offsetWidth;
      body.classList.add('toast__swapping');
      setTimeout(() => body.classList.remove('toast__swapping'), FLIP_MS + 80);
    }

    armTimer();
    writeLog(type, nextTitle, options);
  }

  function close() {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    live.delete(handle);
    if (currentByType.get(type) === handle) currentByType.delete(type);

    el.classList.add('toast--leaving');

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener('animationend', onAnimEnd);
      // FLIP：移除前量一次旧位置，移除后再量一次，从位移差动画回 0 —— 余下卡片平滑让位
      const others = [];
      if (!reducedMotion()) {
        for (const other of live) {
          const node = other.el;
          if (node && node.isConnected) others.push([node, node.getBoundingClientRect().top]);
        }
      }
      el.remove();
      for (const [node, before] of others) {
        if (!node.isConnected) continue;
        const delta = before - node.getBoundingClientRect().top;
        if (!delta) continue;
        node.animate(
          [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }],
          { duration: FLIP_MS, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }
        );
      }
      if (typeof options.onClose === 'function') {
        try {
          options.onClose();
        } catch (err) {
          console.error('[toast] onClose 异常', err);
        }
      }
    };
    // 只认出场动画：进场动画的 animationend 不能提前把卡片拿掉
    const onAnimEnd = (e) => {
      if (e.target === el && e.animationName === 'toast-out') finish();
    };
    el.addEventListener('animationend', onAnimEnd);
    // 动画被系统偏好关掉时 animationend 不会触发，兜底一个定时器
    setTimeout(finish, LEAVE_FALLBACK_MS);
  }

  const handle = { close, update, el, type, isAlive: () => !closed && el.isConnected };
  live.add(handle);
  currentByType.set(type, handle);

  renderBody(body, title, options);
  writeLog(type, title, options);
  root.appendChild(el);
  armTimer();

  // 鼠标悬停暂停计时，方便用户读完
  el.addEventListener('mouseenter', () => {
    if (timer) clearTimeout(timer);
    timer = null;
  });
  el.addEventListener('mouseleave', () => {
    if (!closed) armTimer();
  });

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
        ? [{ label: t('查看详情'), run: () => toast.detail(title || '错误详情', detail), keepOpen: true }]
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
    currentByType.clear();
    const root = ensureHost();
    if (root) clear(root);
  },

  /** 当前存活的通知数量（自检/调试用） */
  count() {
    return live.size;
  },

  /** 按类型统计存活数量（自检用：验证「同类型互相覆盖」） */
  counts() {
    const out = { success: 0, error: 0, warn: 0, info: 0 };
    for (const handle of live) out[handle.type] = (out[handle.type] || 0) + 1;
    return out;
  },
};

export default toast;
