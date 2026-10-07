/**
 * segmented.js —— 分段选项卡（带滑动指示条）
 *
 * 为什么不用两个普通按钮切换 class：
 *   按钮直接换背景色是「硬切」，视线要重新找当前在哪一项。这里在按钮下面放一块
 *   实心方块当指示条，切换时方块**滑过去**，眼睛跟着它走 —— 这是 2.0.3 让界面
 *   显得连贯的关键一环。视觉上完全沿用项目既有的语言：直角、黑白、无阴影、无渐变。
 *
 * 位移与时长受 tokens.css 里 --t-slow / --e-in-out 约束；系统偏好「减少动态效果」
 * 时由 CSS 把时长压到 1ms，等于直接切换。
 *
 * 用法：
 *   const seg = createSegmented({ items: [{value,label,title}], value, onChange });
 *   host.appendChild(seg.el);
 *   seg.sync();              // 挂载后调用一次：量按钮位置、摆好指示条（不动画）
 *   seg.select('catalog');   // 代码切换（会动）
 */

import { h } from './dom.js';

export function createSegmented({ items, value, onChange, className = '', ariaLabel = '' } = {}) {
  const list = (items || []).filter(Boolean);
  let current = value != null ? value : list.length ? list[0].value : null;

  const indicator = h('div.segmented__indicator');
  const root = h(`div.segmented${className ? `.${className}` : ''}`, {
    role: 'group',
    'aria-label': ariaLabel || undefined,
  }, indicator);

  const buttons = [];

  /** 把指示条摆到当前按钮上；animate=false 用于首次定位与尺寸变化（不产生滑动） */
  function layout(animate) {
    const btn = buttons.find((b) => b.dataset.value === String(current));
    if (!btn) return;
    if (!animate) indicator.style.transition = 'none';
    indicator.style.transform = `translateX(${btn.offsetLeft}px)`;
    indicator.style.width = `${btn.offsetWidth}px`;
    if (!animate) {
      // 强制一次重排，让「无过渡」的设置立即生效，再恢复过渡
      void indicator.offsetWidth;
      indicator.style.transition = '';
    }
  }

  function select(next, silent) {
    if (next === current) return;
    current = next;
    for (const b of buttons) {
      const on = b.dataset.value === String(next);
      b.dataset.active = String(on);
      b.setAttribute('aria-pressed', String(on));
    }
    layout(true);
    if (!silent && typeof onChange === 'function') onChange(next);
  }

  for (const item of list) {
    const on = item.value === current;
    const btn = h('button.segmented__btn', {
      type: 'button',
      dataset: { value: String(item.value), active: String(on) },
      title: item.title || '',
      'aria-pressed': String(on),
      on: { click: () => select(item.value) },
    }, h('span', { textContent: item.label }));
    buttons.push(btn);
    root.appendChild(btn);
  }

  // 容器尺寸变化（窗口缩放、字体加载完成）后重新量一次，不产生滑动
  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => layout(false));
    ro.observe(root);
  }

  return {
    el: root,
    select,
    get value() {
      return current;
    },
    /** 挂载后调用：此时才量得到按钮位置 */
    sync(animate = false) {
      layout(animate);
    },
    /** 尺寸变化后重摆（不滑动） */
    relayout() {
      layout(false);
    },
    dispose() {
      if (ro) ro.disconnect();
    },
  };
}

export default createSegmented;
