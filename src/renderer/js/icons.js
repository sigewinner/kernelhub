/**
 * icons.js —— 内联 SVG 图标集
 *
 * 设计取舍：
 *   - 全部图标统一 24×24 viewBox、stroke=currentColor、无填充，
 *     这样在任意尺寸下都能靠 CSS 的 width/height 缩放并跟随文字颜色。
 *   - 只存 path 数据（d 字符串 / 子标签），渲染交给 icon()，避免为每个图标写一遍 <svg>。
 *   - 图标名是本文件唯一的「词汇表」，与业务无关（不含任何格式/内核名）。
 */

import { h } from './dom.js';

/** 图标定义：每个值是 SVG 子元素描述数组 */
const ICONS = {
  /* -- 导航 -- */
  home: [['path', { d: 'M3 10.5 12 3l9 7.5' }], ['path', { d: 'M5.5 9.5V20h13V9.5' }], ['path', { d: 'M10 20v-5.5h4V20' }]],
  convert: [
    ['path', { d: 'M4 8h12' }], ['path', { d: 'm13 5 3 3-3 3' }],
    ['path', { d: 'M20 16H8' }], ['path', { d: 'm11 13-3 3 3 3' }],
  ],
  queue: [
    ['path', { d: 'M4 6h16' }], ['path', { d: 'M4 12h16' }], ['path', { d: 'M4 18h10' }],
    ['circle', { cx: '19', cy: '18', r: '2.2' }],
  ],
  kernels: [
    ['rect', { x: '3.5', y: '3.5', width: '7', height: '7', rx: '2' }],
    ['rect', { x: '13.5', y: '3.5', width: '7', height: '7', rx: '2' }],
    ['rect', { x: '3.5', y: '13.5', width: '7', height: '7', rx: '2' }],
    ['rect', { x: '13.5', y: '13.5', width: '7', height: '7', rx: '2' }],
  ],
  grid: [
    ['rect', { x: '3.5', y: '3.5', width: '17', height: '17', rx: '3' }],
    ['path', { d: 'M3.5 9.5h17M9.5 9.5v11M3.5 15.5h17' }],
  ],
  matrix: [
    ['rect', { x: '3.5', y: '3.5', width: '17', height: '17', rx: '3' }],
    ['path', { d: 'M9 3.5v17M15 3.5v17M3.5 9h17M3.5 15h17' }],
  ],
  book: [
    ['path', { d: 'M5 4.5h9.5A2.5 2.5 0 0 1 17 7v13H7.5A2.5 2.5 0 0 1 5 17.5Z' }],
    ['path', { d: 'M17 7h2v13H7.5' }],
  ],
  settings: [
    ['circle', { cx: '12', cy: '12', r: '3.1' }],
    ['path', { d: 'M19.3 14.4a7.7 7.7 0 0 0 .1-1.4 7.7 7.7 0 0 0-.1-1.4l1.8-1.3-1.8-3.1-2.1.8a7.4 7.4 0 0 0-1.2-.7L15.6 5h-3.2l-.4 2.3a7.4 7.4 0 0 0-1.2.7l-2.1-.8-1.8 3.1L8.7 11.6a7.7 7.7 0 0 0 0 2.8l-1.8 1.3 1.8 3.1 2.1-.8a7.4 7.4 0 0 0 1.2.7l.4 2.3h3.2l.4-2.3a7.4 7.4 0 0 0 1.2-.7l2.1.8 1.8-3.1Z' }],
  ],
  logs: [
    ['rect', { x: '4.5', y: '4.5', width: '15', height: '15', rx: '2' }],
    ['path', { d: 'M8 9h8M8 12.5h8M8 16h5' }],
  ],

  /* -- 动作 -- */
  play: [['path', { d: 'M7 4.8 19 12 7 19.2Z' }]],
  stop: [['rect', { x: '6.5', y: '6.5', width: '11', height: '11', rx: '2' }]],
  pause: [['path', { d: 'M9.5 5.5v13M14.5 5.5v13' }]],
  retry: [['path', { d: 'M20 12a8 8 0 1 1-2.4-5.7' }], ['path', { d: 'M20 4.5V10h-5.5' }]],
  trash: [
    ['path', { d: 'M4.5 7h15' }], ['path', { d: 'M9.5 7V4.8h5V7' }],
    ['path', { d: 'M6.5 7l1 12.2h9L17.5 7' }],
  ],
  plus: [['path', { d: 'M12 5.5v13M5.5 12h13' }]],
  minus: [['path', { d: 'M5.5 12h13' }]],
  close: [['path', { d: 'M6 6l12 12M18 6 6 18' }]],
  check: [['path', { d: 'm5 12.5 4.5 4.5L19 7' }]],
  copy: [
    ['rect', { x: '9', y: '9', width: '11', height: '11', rx: '2.5' }],
    ['path', { d: 'M15 6.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h.5' }],
  ],
  folder: [['path', { d: 'M3.5 6.5A2 2 0 0 1 5.5 4.5h4L11 7h7.5a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z' }]],
  folderOpen: [
    ['path', { d: 'M3.5 6.5A2 2 0 0 1 5.5 4.5h4L11 7h6.5a2 2 0 0 1 2 2v1.5' }],
    ['path', { d: 'M3.5 9.5h17l-2 9H5.5Z' }],
  ],
  file: [['path', { d: 'M6 3.5h7l5 5v12H6Z' }], ['path', { d: 'M13 3.5v5h5' }]],
  files: [
    ['path', { d: 'M8 3.5h6l4 4v10H8Z' }],
    ['path', { d: 'M14 3.5v4h4' }],
    ['path', { d: 'M5 7v13h9' }],
  ],
  upload: [['path', { d: 'M12 16.5V4.5' }], ['path', { d: 'm7.5 9 4.5-4.5L16.5 9' }], ['path', { d: 'M4.5 15v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15' }]],
  download: [['path', { d: 'M12 4.5v12' }], ['path', { d: 'm7.5 12 4.5 4.5L16.5 12' }], ['path', { d: 'M4.5 15v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15' }]],
  search: [['circle', { cx: '11', cy: '11', r: '6.5' }], ['path', { d: 'm20 20-4.2-4.2' }]],
  refresh: [
    ['path', { d: 'M20.5 12a8.5 8.5 0 1 1-2.6-6.1' }],
    ['path', { d: 'M20.5 4v5.5H15' }],
  ],
  external: [['path', { d: 'M14 4.5h5.5V10' }], ['path', { d: 'M19.5 4.5 11 13' }], ['path', { d: 'M18 14v4.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4.5' }]],
  terminal: [['rect', { x: '3.5', y: '4.5', width: '17', height: '15', rx: '2.5' }], ['path', { d: 'm7.5 10 2.5 2.5-2.5 2.5M13 15h4' }]],
  eye: [['path', { d: 'M2.8 12S6.5 5.8 12 5.8 21.2 12 21.2 12 17.5 18.2 12 18.2 2.8 12 2.8 12Z' }], ['circle', { cx: '12', cy: '12', r: '2.8' }]],
  info: [['circle', { cx: '12', cy: '12', r: '8.5' }], ['path', { d: 'M12 11v5.5M12 7.8v.4' }]],
  warn: [['path', { d: 'M12 4.2 21 19.5H3Z' }], ['path', { d: 'M12 10v4.2M12 17v.3' }]],
  error: [['circle', { cx: '12', cy: '12', r: '8.5' }], ['path', { d: 'M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6' }]],
  success: [['circle', { cx: '12', cy: '12', r: '8.5' }], ['path', { d: 'm8.2 12.3 2.6 2.6 5-5.2' }]],
  sparkle: [
    ['path', { d: 'M12 3.5l1.7 4.6 4.6 1.7-4.6 1.7L12 16.1l-1.7-4.6L5.7 9.8l4.6-1.7Z' }],
    ['path', { d: 'M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8Z' }],
  ],
  layers: [
    ['path', { d: 'M12 3.5 3.5 8l8.5 4.5L20.5 8Z' }],
    ['path', { d: 'M3.5 12.5 12 17l8.5-4.5' }],
    ['path', { d: 'M3.5 16.5 12 21l8.5-4.5' }],
  ],
  cpu: [
    ['rect', { x: '7', y: '7', width: '10', height: '10', rx: '2.5' }],
    ['path', { d: 'M10 3.5v3.5M14 3.5v3.5M10 17v3.5M14 17v3.5M3.5 10H7M3.5 14H7M17 10h3.5M17 14h3.5' }],
  ],
  gauge: [['path', { d: 'M4 16.5a8.5 8.5 0 1 1 16 0' }], ['path', { d: 'm12 12.5 3.5-3' }], ['path', { d: 'M4 20h16' }]],
  clock: [['circle', { cx: '12', cy: '12', r: '8.5' }], ['path', { d: 'M12 7.5V12l3 2' }]],
  shield: [['path', { d: 'M12 3.5 5 6v6c0 4.4 3 7.6 7 8.5 4-.9 7-4.1 7-8.5V6Z' }]],
  key: [['circle', { cx: '9', cy: '12', r: '3.5' }], ['path', { d: 'M12.5 12H21M18 12v3M15.5 12v2' }]],
  power: [['path', { d: 'M12 4v8' }], ['path', { d: 'M7.5 7a6.5 6.5 0 1 0 9 0' }]],
  chevronRight: [['path', { d: 'm9.5 6 6 6-6 6' }]],
  chevronDown: [['path', { d: 'm6 9.5 6 6 6-6' }]],
  chevronUp: [['path', { d: 'm6 14.5 6-6 6 6' }]],
  arrowRight: [['path', { d: 'M5 12h14' }], ['path', { d: 'm14 7 5 5-5 5' }]],
  sort: [['path', { d: 'M8 8.5h9M8 12h6M8 15.5h3' }], ['path', { d: 'M5 5.5v13' }]],
  filter: [['path', { d: 'M4 6h16l-6 7v5.5l-4 2V13Z' }]],
  theme: [['circle', { cx: '12', cy: '12', r: '4.5' }], ['path', { d: 'M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4' }]],
  moon: [['path', { d: 'M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z' }]],
  command: [['path', { d: 'M9 6.5a2.5 2.5 0 1 0-2.5 2.5H9Zm6 0A2.5 2.5 0 1 1 17.5 9H15Zm0 11a2.5 2.5 0 1 0 2.5-2.5H15ZM9 17.5A2.5 2.5 0 1 1 6.5 15H9Z' }], ['rect', { x: '9', y: '9', width: '6', height: '6', rx: '1.5' }]],
  database: [
    ['ellipse', { cx: '12', cy: '6.5', rx: '7', ry: '3' }],
    ['path', { d: 'M5 6.5v11c0 1.7 3.1 3 7 3s7-1.3 7-3v-11' }],
    ['path', { d: 'M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3' }],
  ],
  wand: [['path', { d: 'm5 19 9.5-9.5' }], ['path', { d: 'm14 5 5 5' }], ['path', { d: 'm15.5 3.5.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7Z' }]],
  link: [['path', { d: 'M10 14a4 4 0 0 1 0-5.7l2.2-2.2a4 4 0 0 1 5.7 5.7l-1.6 1.6' }], ['path', { d: 'M14 10a4 4 0 0 1 0 5.7l-2.2 2.2a4 4 0 0 1-5.7-5.7l1.6-1.6' }]],
  list: [['path', { d: 'M8 6.5h12M8 12h12M8 17.5h12' }], ['circle', { cx: '4.5', cy: '6.5', r: '1.2' }], ['circle', { cx: '4.5', cy: '12', r: '1.2' }], ['circle', { cx: '4.5', cy: '17.5', r: '1.2' }]],
  cards: [
    ['rect', { x: '3.5', y: '3.5', width: '7.5', height: '17', rx: '2' }],
    ['rect', { x: '13', y: '3.5', width: '7.5', height: '17', rx: '2' }],
  ],
  window: [['rect', { x: '4.5', y: '4.5', width: '15', height: '15', rx: '2.5' }], ['path', { d: 'M4.5 9h15' }]],
  square: [['rect', { x: '5', y: '5', width: '14', height: '14', rx: '2.5' }]],
  scan: [['path', { d: 'M4 8.5V6a2 2 0 0 1 2-2h2.5M15.5 4H18a2 2 0 0 1 2 2v2.5M20 15.5V18a2 2 0 0 1-2 2h-2.5M8.5 20H6a2 2 0 0 1-2-2v-2.5' }], ['path', { d: 'M4 12h16' }]],
  rocket: [
    ['path', { d: 'M13.5 4.5c3.5 0 6 2.5 6 6 0 4-4 7.5-4 7.5l-3-1.5-1.5-3S7.5 9.5 11.5 5.5a5 5 0 0 1 2-1Z' }],
    ['path', { d: 'M8.5 15.5 5 19l1 1 3.5-3.5' }],
    ['circle', { cx: '14.5', cy: '9.5', r: '1.4' }],
  ],
};

/**
 * 生成一个图标元素。
 * @param {string} name ICONS 中的键；未知键返回一个空 svg（不抛异常）
 * @param {object} [opts] { size, cls, strokeWidth }
 * @returns {SVGSVGElement}
 */
export function icon(name, opts = {}) {
  const { size = 16, cls = '', strokeWidth = 1.7 } = opts;
  const parts = ICONS[name] || ICONS.info;
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', String(strokeWidth));
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('focusable', 'false');
  if (cls) el.setAttribute('class', cls);

  for (const [tag, attrs] of parts) {
    const child = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, String(v));
    el.appendChild(child);
  }
  return el;
}

/**
 * 图标 + 文本的行内组合（按钮里最常用），返回一个 span。
 * @param {string} name
 * @param {string|Node} [label]
 */
export function iconLabel(name, label, opts = {}) {
  const wrap = h('span.row.gap-2', null, icon(name, { size: opts.size || 15, cls: opts.cls || '' }));
  if (label !== undefined && label !== null && label !== '') {
    wrap.appendChild(h('span', label));
  }
  return wrap;
}

/** 该图标名是否存在（命令面板/动态图标用得到） */
export function hasIcon(name) {
  return Object.prototype.hasOwnProperty.call(ICONS, name);
}

/** 图标名清单（只读，供文档与自检使用） */
export const ICON_NAMES = Object.freeze(Object.keys(ICONS));
