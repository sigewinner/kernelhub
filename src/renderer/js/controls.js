/**
 * controls.js —— 由 ParamSpec 动态生成参数控件
 *
 * 这是「协议驱动」约束的核心落点：UI 里**不允许**出现任何参数名或格式名。
 * 一切参数都由主进程 plan:params 返回的 ParamSpec[] 描述，控件类型只由 spec.type 决定：
 *
 *   int / float → 数字输入（有 min/max 时附带方形滑块）
 *   bool        → 直角勾选框
 *   enum        → 下拉（显示 label，提交 value）
 *   string      → 文本框
 *   path        → 输入框 + 浏览按钮（走 khs.fs.pickFolder / pickFiles）
 *   color       → 取色块 + 十六进制输入
 *
 * 可见性：
 *   spec.applies_to 与 spec.when（{ op, from, to }）共同决定控件是否展示。
 *   有 spec.visible（宿主算好的权威结论）就以它为准；否则回落本地精确字符串比较。
 *   隐藏 ≠ 提交：隐藏控件的值会被 stash，格式切回来时自动恢复。
 *
 * 视觉：全部直角、无阴影；标签用 .label（12px），控件高度 32。
 */

import { h, clear, iconAction } from './dom.js';
import { icon } from './icons.js';
import { rangeHint } from './format.js';
import { t } from './i18n.js';

/* --------------------------------------------------------------- 可见性 */

function listMatches(list, value) {
  if (!Array.isArray(list) || !list.length) return true;
  const v = String(value === null || value === undefined ? '' : value);
  if (!v) return true;
  return list.some((item) => String(item) === v);
}

/**
 * 计算某个 spec 在当前 (op, srcFmt, dstFmt) 下是否可见。
 * @returns {boolean}
 */
export function isSpecVisible(spec, context = {}) {
  if (!spec) return false;

  if (typeof spec.visible === 'boolean') {
    if (!spec.visible) return false;
    const applies = Array.isArray(spec.applies_to) ? spec.applies_to : [];
    if (applies.length && !applies.includes(String(context.op || ''))) return false;
    const ops = Array.isArray(spec.ops) ? spec.ops : [];
    if (ops.length && !ops.includes(String(context.op || ''))) return false;
    const srcFmt = String(context.srcFmt || '');
    if (Array.isArray(spec.visibleFrom) && spec.visibleFrom.length && srcFmt && !spec.visibleFrom.includes(srcFmt)) {
      return false;
    }
    const dstFmt = String(context.dstFmt || '');
    if (Array.isArray(spec.visibleTo) && spec.visibleTo.length && dstFmt && !spec.visibleTo.includes(dstFmt)) {
      return false;
    }
    return true;
  }

  const applies = Array.isArray(spec.applies_to) ? spec.applies_to : [];
  if (applies.length && !applies.includes(String(context.op || ''))) return false;

  const when = spec.when && typeof spec.when === 'object' ? spec.when : {};
  if (!listMatches(when.op, context.op)) return false;
  if (!listMatches(when.from, context.srcFmt)) return false;
  if (!listMatches(when.to, context.dstFmt)) return false;
  return true;
}

/* ----------------------------------------------------------- 单控件工厂 */

function defaultOf(spec) {
  if (spec.default !== null && spec.default !== undefined) return spec.default;
  if (spec.type === 'enum' && Array.isArray(spec.enum) && spec.enum.length) return spec.enum[0].value;
  switch (spec.type) {
    case 'int':
    case 'float':
      return 0;
    case 'bool':
      return false;
    case 'color':
      return '#000000';
    default:
      return '';
  }
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sliderWorthwhile(spec) {
  const hasMin = spec.min !== null && spec.min !== undefined && Number.isFinite(Number(spec.min));
  const hasMax = spec.max !== null && spec.max !== undefined && Number.isFinite(Number(spec.max));
  if (!hasMin || !hasMax) return false;
  const span = Number(spec.max) - Number(spec.min);
  if (!Number.isFinite(span) || span <= 0 || span > 200000) return false;
  const step = Number(spec.step) > 0 ? Number(spec.step) : spec.type === 'int' ? 1 : 0.01;
  return span / step <= 4000;
}

/**
 * 创建单个参数控件。
 * @returns {{ el: HTMLElement, get: () => any, set: (v:any) => void, reset: () => void }}
 */
function createControl(spec, hooks = {}) {
  const setter = typeof hooks.onChange === 'function' ? hooks.onChange : () => {};
  const common = { id: spec.id, label: spec.label, description: spec.description };
  switch (spec.type) {
    case 'bool': return boolControl(spec, setter);
    case 'int':
    case 'float': return numberControl(spec, setter);
    case 'enum': return enumControl(spec, setter);
    case 'path': return pathControl(spec, setter, common);
    case 'color': return colorControl(spec, setter);
    case 'string':
    default: return textControl(spec, setter);
  }
}

/* --- bool：直角勾选框 --- */
function boolControl(spec, setter) {
  const input = h('input.check', { type: 'checkbox', checked: Boolean(defaultOf(spec)) });
  const textEl = h('span', { dataset: { role: 'bool-text' } });
  const sync = () => { textEl.textContent = input.checked ? '启用' : '关闭'; };
  input.addEventListener('change', () => {
    sync();
    setter(spec, input.checked);
  });
  const wrap = h('div.check-row', null, input, textEl);
  sync();
  return {
    el: wrap,
    get: () => input.checked,
    set: (v) => { input.checked = Boolean(v); sync(); },
    reset: () => { input.checked = Boolean(defaultOf(spec)); sync(); },
  };
}

/* --- int / float：数字输入（+ 可选滑块） --- */
function numberControl(spec, setter) {
  const step = Number(spec.step) > 0 ? Number(spec.step) : spec.type === 'int' ? 1 : 0.01;
  const withSlider = sliderWorthwhile(spec);

  const input = h('input.input.input--num', {
    type: 'number',
    value: String(defaultOf(spec)),
    step: String(step),
    min: spec.min !== null && spec.min !== undefined ? String(spec.min) : null,
    max: spec.max !== null && spec.max !== undefined ? String(spec.max) : null,
  });

  function normalize(raw) {
    let n = Number(raw);
    if (!Number.isFinite(n)) n = toNum(defaultOf(spec), 0);
    if (spec.min !== null && spec.min !== undefined && Number.isFinite(Number(spec.min))) n = Math.max(n, Number(spec.min));
    if (spec.max !== null && spec.max !== undefined && Number.isFinite(Number(spec.max))) n = Math.min(n, Number(spec.max));
    if (spec.type === 'int') n = Math.round(n);
    return n;
  }

  let slider = null;
  if (withSlider) {
    slider = h('input.slider', {
      type: 'range',
      min: String(spec.min),
      max: String(spec.max),
      step: String(step),
      value: String(normalize(defaultOf(spec))),
    });
    slider.addEventListener('input', () => {
      input.value = String(normalize(slider.value));
      setter(spec, normalize(input.value));
    });
  }

  input.addEventListener('change', () => {
    const n = normalize(input.value);
    input.value = String(n);
    if (slider) slider.value = String(n);
    setter(spec, n);
  });
  input.addEventListener('input', () => {
    if (slider && Number.isFinite(Number(input.value))) slider.value = input.value;
  });

  const hint = rangeHint(spec.min, spec.max, spec.step);
  if (hint && input) input.title = hint;
  if (hint && slider) slider.title = hint;
  // 2.1.0：取值范围/步长不再单独占一行小字，交给 buildField 挂到 title 上
  const wrap = h('div.col.gap-2', null,
    h('div.num-row', null, input, slider)
  );

  return {
    el: wrap,
    tip: hint,
    get: () => normalize(input.value),
    set: (v) => {
      const n = normalize(v);
      input.value = String(n);
      if (slider) slider.value = String(n);
    },
    reset: () => {
      const n = normalize(defaultOf(spec));
      input.value = String(n);
      if (slider) slider.value = String(n);
    },
  };
}

/* --- enum：下拉（显示 label，提交 value） --- */
function enumControl(spec, setter) {
  const options = Array.isArray(spec.enum) ? spec.enum : [];
  const select = h('select.select');
  if (!options.length) {
    select.appendChild(h('option', { value: '', textContent: t('（该参数未提供可选值）') }));
  }
  for (const item of options) {
    const value = item && item.value !== undefined ? item.value : '';
    const label = item && item.label ? String(item.label) : String(value);
    select.appendChild(h('option', { value: String(value), textContent: label }));
  }
  const def = defaultOf(spec);
  select.value = def === null || def === undefined ? '' : String(def);
  select.addEventListener('change', () => setter(spec, select.value));

  const wrap = h('div.selectwrap', null, select);

  return {
    el: wrap,
    get: () => select.value,
    set: (v) => {
      const target = v === null || v === undefined ? '' : String(v);
      const exists = Array.from(select.options).some((o) => o.value === target);
      select.value = exists ? target : String(def === null || def === undefined ? '' : def);
    },
    reset: () => {
      select.value = def === null || def === undefined ? '' : String(def);
    },
  };
}

/* --- string：文本框 --- */
function textControl(spec, setter) {
  const initial = defaultOf(spec);
  const input = h('input.input', {
    type: 'text',
    value: initial === null || initial === undefined ? '' : String(initial),
  });
  input.addEventListener('change', () => setter(spec, input.value));
  return {
    el: h('div', null, input),
    get: () => input.value,
    set: (v) => { input.value = v === null || v === undefined ? '' : String(v); },
    reset: () => { input.value = String(defaultOf(spec) || ''); },
  };
}

/* --- path：输入框 + 浏览按钮 --- */
function pathControl(spec, setter, common = {}) {
  const input = h('input.input.input--mono', {
    type: 'text',
    value: String(defaultOf(spec) || ''),
    placeholder: t('未选择'),
  });
  input.addEventListener('change', () => setter(spec, input.value));

  const browseDir = iconAction({
    label: t('选择目录'),
    classes: ['iconbtn'],
    children: [icon('folder', { size: 15 })],
    onClick: async () => {
      try {
        const res = await window.khs.fs.pickFolder({ title: t('为「{0}」选择目录', { 0: common.label || common.id }) });
        if (res && res.folder) {
          input.value = res.folder;
          setter(spec, input.value);
        }
      } catch (err) {
        reportError(common, err);
      }
    },
  });

  const browseFile = iconAction({
    label: t('选择文件'),
    classes: ['iconbtn'],
    children: [icon('file', { size: 15 })],
    onClick: async () => {
      try {
        const res = await window.khs.fs.pickFiles({ title: t('为「{0}」选择文件', { 0: common.label || common.id }) });
        if (res && Array.isArray(res.files) && res.files.length) {
          input.value = res.files[0].path;
          setter(spec, input.value);
        }
      } catch (err) {
        reportError(common, err);
      }
    },
  });

  return {
    el: h('div.path-row', null, input, browseDir, browseFile),
    get: () => input.value,
    set: (v) => { input.value = v === null || v === undefined ? '' : String(v); },
    reset: () => { input.value = String(defaultOf(spec) || ''); },
  };
}

/* --- color：取色块 + 十六进制输入 --- */
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function normalizeHex(value) {
  const s = String(value === null || value === undefined ? '' : value).trim();
  if (HEX_RE.test(s)) return s.length === 4
    ? `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toUpperCase()
    : s.toUpperCase();
  return '';
}

function colorControl(spec, setter) {
  const initial = normalizeHex(defaultOf(spec)) || '#000000';
  const swatch = h('input.color-field__swatch', { type: 'color', value: initial });
  const hexInput = h('input.input.input--mono', { type: 'text', value: initial, maxlength: '7' });

  swatch.addEventListener('input', () => {
    hexInput.value = swatch.value.toUpperCase();
    setter(spec, hexInput.value);
  });
  hexInput.addEventListener('change', () => {
    const hex = normalizeHex(hexInput.value);
    if (hex) {
      hexInput.value = hex;
      swatch.value = hex;
      setter(spec, hex);
    } else {
      hexInput.value = swatch.value.toUpperCase();
    }
  });

  return {
    el: h('div.color-field', null, swatch, hexInput),
    get: () => hexInput.value,
    set: (v) => {
      const hex = normalizeHex(v) || swatch.value;
      hexInput.value = hex;
      swatch.value = hex.length === 7 ? hex : swatch.value;
    },
    reset: () => {
      const hex = normalizeHex(defaultOf(spec)) || '#000000';
      hexInput.value = hex;
      swatch.value = hex;
    },
  };
}

function reportError(common, err) {
  const message = err && err.message ? err.message : String(err);
  window.dispatchEvent(new CustomEvent('khs:ui-error', {
    detail: { title: t('参数「{0}」选择失败', { 0: common.label || common.id }), message },
  }));
}

/* ------------------------------------------------------------- 参数面板 */

/**
 * 创建参数面板。
 * @param {HTMLElement} host 挂载容器（会被清空）
 * @param {object} options
 * @param {Array} options.specs ParamSpec[]
 * @param {object} options.context { op, srcFmt, dstFmt }
 * @param {(id: string, value: any) => void} [options.onChange]
 * @returns {object} 面板句柄
 */
export function createParamPanel(host, options = {}) {
  const state = {
    specs: [],
    context: { op: '', srcFmt: '', dstFmt: '' },
    controls: new Map(),
    stash: new Map(),
    advancedOpen: false,
  };
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};

  const basicBody = h('div.param-grid');
  const advancedBody = h('div.param-grid');
  // 2.1.0：原「N 个参数不适用于当前组合，已自动隐藏」也是小字，改为挂在区块标题的悬停提示上
  const hiddenTip = { count: 0 };
  const basicTitle = h('div.param-section__title', null, h('span', { textContent: t('基础参数') }));
  const emptyState = h('div.empty', { style: { padding: 'var(--sp-4) 0' } },
    h('div.empty__title', { textContent: t('当前组合没有可调参数') })
  );

  const root = h('div.param-panel');
  const basicSection = h('div.param-section', null,
    basicTitle,
    basicBody
  );
  const advancedSection = h('div.param-section', null,
    h('div.param-section__title', null,
      h('span', { textContent: t('高级参数') }),
      h('span.badge.badge--mono', { dataset: { role: 'adv-count' }, textContent: '0' })
    ),
    advancedBody
  );
  const advancedFold = h('div.fold', { dataset: { open: 'false' } });
  advancedFold.appendChild(h('div.fold__head', null, h('span', { textContent: t('展开高级参数') })));
  advancedFold.appendChild(h('div.fold__body', null, advancedSection));
  advancedFold.querySelector('.fold__head').addEventListener('click', () => setAdvancedOpen(!state.advancedOpen));

  root.appendChild(emptyState);
  root.appendChild(basicSection);
  root.appendChild(advancedFold);

  if (host) {
    clear(host);
    host.appendChild(root);
  }

  function render() {
    clear(basicBody);
    clear(advancedBody);
    state.controls.clear();
    state.stash.clear();

    let basicCount = 0;
    let advancedCount = 0;

    for (const spec of state.specs) {
      if (!spec || !spec.id) continue;
      const control = createControl(spec, {
        onChange: (s, value) => onChange(s.id, value),
      });
      state.controls.set(spec.id, { spec, control, isAdvanced: Boolean(spec.advanced) });

      const field = buildField(spec, control);
      if (spec.advanced) {
        advancedBody.appendChild(field);
        advancedCount += 1;
      } else {
        basicBody.appendChild(field);
        basicCount += 1;
      }
    }

    const hasSpecs = state.specs.length > 0;
    emptyState.classList.toggle('hidden', hasSpecs);
    basicSection.classList.toggle('hidden', !hasSpecs || basicCount === 0);
    advancedFold.classList.toggle('hidden', !hasSpecs || advancedCount === 0);

    const advBadge = advancedFold.querySelector('[data-role="adv-count"]');
    if (advBadge) advBadge.textContent = String(advancedCount);

    applyVisibility();
  }

  function applyVisibility() {
    let hiddenCount = 0;
    for (const [id, entry] of state.controls) {
      const visible = isSpecVisible(entry.spec, state.context);
      const target = entry.control.el.closest('.param-field') || entry.control.el;
      if (visible) {
        if (target.classList.contains('hidden')) {
          target.classList.remove('hidden');
          if (state.stash.has(id)) {
            entry.control.set(state.stash.get(id));
            state.stash.delete(id);
          }
        }
      } else if (!target.classList.contains('hidden')) {
        state.stash.set(id, entry.control.get());
        target.classList.add('hidden');
        hiddenCount += 1;
      } else {
        hiddenCount += 1;
      }
    }
    // 2.1.0：隐藏参数的数量改成悬停提示（原先是区块标题旁边的一行小字）
    hiddenTip.count = hiddenCount;
    basicTitle.title = hiddenCount > 0 ? t('{0} 个参数不适用于当前组合，已自动隐藏', { 0: hiddenCount }) : '';
  }

  function setAdvancedOpen(open) {
    state.advancedOpen = Boolean(open);
    advancedFold.dataset.open = state.advancedOpen ? 'true' : 'false';
  }

  return {
    el: root,

    setSpecs(specs) {
      const next = Array.isArray(specs) ? specs : [];
      const same = next.length === state.specs.length
        && next.every((s, i) => state.specs[i] && s && s.id === state.specs[i].id && s.type === state.specs[i].type);
      state.specs = next;
      if (!same) render();
      else applyVisibility();
    },

    setContext(context) {
      state.context = {
        op: context.op || '',
        srcFmt: context.srcFmt || '',
        dstFmt: context.dstFmt || '',
      };
      applyVisibility();
    },

    values() {
      const out = {};
      for (const [id, entry] of state.controls) {
        if (!isSpecVisible(entry.spec, state.context)) continue;
        const value = entry.control.get();
        if (value === undefined) continue;
        if (entry.spec.type === 'bool' || value !== '') out[id] = value;
      }
      return out;
    },

    get(id) {
      const entry = state.controls.get(id);
      return entry ? entry.control.get() : undefined;
    },

    set(id, value) {
      const entry = state.controls.get(id);
      if (entry) entry.control.set(value);
    },

    reset() {
      for (const entry of state.controls.values()) entry.control.reset();
      onChange('*', null);
    },

    counts() {
      let visible = 0;
      for (const entry of state.controls.values()) {
        if (isSpecVisible(entry.spec, state.context)) visible += 1;
      }
      return { visible, total: state.controls.size };
    },

    setAdvancedOpen,

    get specs() {
      return state.specs.slice();
    },

    dispose() {
      clear(root);
      state.controls.clear();
      state.stash.clear();
    },
  };
}

/** 把一个控件包装成带 label / 描述 / 类型标记的字段块 */
function buildField(spec, control) {
  const label = h('label.label', null,
    h('span', { textContent: spec.label || spec.id }),
    spec.required ? h('span.field__req', { title: t('必填'), textContent: '*' }) : null,
    h('span.badge.badge--mono', { textContent: String(spec.type || 'string') })
  );
  /**
   * 2.1.0：不再在字段下方显示说明小字，改成把说明挂到整块的 title 上
   * （鼠标悬停才出现）。用户要求「高级里的说明文字删干净、悬停再看」。
   */
  const field = h('div.field.param-field', null, label, control.el);
  const tips = [];
  if (spec.description) tips.push(String(spec.description));
  const rangeTip = control.tip || '';
  if (rangeTip) tips.push(rangeTip);
  if (tips.length) {
    const title = tips.join('\n');
    field.title = title;
    // 控件本身也带上，避免悬停在输入框上时看不到（title 不会从子元素冒泡）
    const inner = control.el.querySelector('input, select, textarea, button');
    if (inner && !inner.title) inner.title = title;
  }
  return field;
}

export default createParamPanel;
