/**
 * views/protocol.js —— 协议
 *
 * 版面（docs/ui-spec-swiss.md 4.5）：2 个按钮
 *   左 4 栏：目录（从 Markdown 标题自动生成，点击滚动到对应锚点）
 *   右 8 栏：文档正文（安全渲染的 Markdown）
 *   底部：协议版本 + 自检摘要（可用内核 / 总数 / Python 版本）
 *   按钮：[复制全文] [查看 Schema]（打开抽屉，里面是 3 份 Schema 的标签页 + 复制）
 *
 * 安全渲染的做法：**先把 Markdown 解析成 DOM 节点**，全程不用 innerHTML，
 * 因此文档里出现的任何 <script>/<img onerror> 之类都会被当成纯文本。
 * 目录项用 <a>（链接）承载 —— 规范里「链接不计入每屏按钮数」。
 */

import { h, clear, on, copyText } from '../dom.js';
import { createSheet } from '../sheet.js';
import { thousands, orDash } from '../format.js';

/* ---------------------------------------------------------------- Markdown */

/** 生成锚点 id：去掉标点、空格换成 -，重复时补序号 */
function slugify(text, used) {
  let base = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) base = 'section';
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  used.add(id);
  return id;
}

/** 行内元素：`code`、**粗体**、*斜体*、[文本](#锚点) */
function inlineNodes(text) {
  const nodes = [];
  const source = String(text === null || text === undefined ? '' : text);
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let match = re.exec(source);
  while (match) {
    if (match.index > last) nodes.push(document.createTextNode(source.slice(last, match.index)));
    const token = match[0];
    if (token.startsWith('`')) {
      nodes.push(h('code', { textContent: token.slice(1, -1) }));
    } else if (token.startsWith('**')) {
      nodes.push(h('strong', { textContent: token.slice(2, -2) }));
    } else if (token.startsWith('*')) {
      nodes.push(h('em', { textContent: token.slice(1, -1) }));
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      const label = link ? link[1] : token;
      const href = link ? link[2] : '';
      if (href.startsWith('#')) {
        // 文档内锚点：先 preventDefault，避免改动 location.hash（那会触发应用路由）
        nodes.push(h('a', {
          href,
          textContent: label,
          on: {
            click: (event) => {
              event.preventDefault();
              const target = document.getElementById(href.slice(1));
              if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'start' });
            },
          },
        }));
      } else {
        // 外部地址一律不生成可点击链接（渲染进程不访问网络）；只把地址原样展示出来
        nodes.push(h('span.mono', { textContent: label, title: href }));
      }
    }
    last = match.index + token.length;
    match = re.exec(source);
  }
  if (last < source.length) nodes.push(document.createTextNode(source.slice(last)));
  return nodes;
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(String(line || ''));
}

function splitRow(line) {
  return String(line || '')
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * 把 Markdown 解析成 DOM。
 * @returns {{ root: HTMLElement, headings: Array<{level:number,text:string,id:string,el:HTMLElement}> }}
 */
function renderMarkdown(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const root = h('div.doc');
  const headings = [];
  const used = new Set();
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      root.appendChild(h('pre', null, h('code', { textContent: body.join('\n') })));
      continue;
    }

    // 标题
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].replace(/[`*]/g, '');
      const id = slugify(text, used);
      const el = h(`h${Math.min(level, 4)}`, { id }, ...inlineNodes(text));
      root.appendChild(el);
      headings.push({ level, text, id, el });
      i += 1;
      continue;
    }

    // 分隔线
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      root.appendChild(h('hr'));
      i += 1;
      continue;
    }

    // 表格
    if (/^\s*\|/.test(line) && isTableSeparator(lines[i + 1])) {
      const header = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      const thead = h('thead', null, h('tr', null,
        ...header.map((cell) => h('th', null, ...inlineNodes(cell)))
      ));
      const tbody = h('tbody', null, ...rows.map((row) => h('tr', null,
        ...header.map((_, index) => h('td', null, ...inlineNodes(row[index] === undefined ? '' : row[index])))
      )));
      root.appendChild(h('table', null, thead, tbody));
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      root.appendChild(h('blockquote', null, ...inlineNodes(body.join(' '))));
      continue;
    }

    // 列表（有序 / 无序）
    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*(?:[-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*(?:[-*+]|\d+\.)\s+/, ''));
        i += 1;
        // 列表项的续行（缩进且不是新的列表项）
        while (i < lines.length && lines[i].trim() && !/^\s*(?:[-*+]|\d+\.)\s+/.test(lines[i]) && /^\s{2,}\S/.test(lines[i])) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
          i += 1;
        }
      }
      const list = h(ordered ? 'ol' : 'ul');
      for (const item of items) list.appendChild(h('li', null, ...inlineNodes(item)));
      root.appendChild(list);
      continue;
    }

    // 空行
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 段落（吸收后续非块级行）
    const para = [line.trim()];
    i += 1;
    while (
      i < lines.length
      && lines[i].trim()
      && !/^\s*(?:#{1,6}\s|```|>|[-*+]\s|\d+\.\s|\|)/.test(lines[i])
      && !/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      para.push(lines[i].trim());
      i += 1;
    }
    root.appendChild(h('p', null, ...inlineNodes(para.join(' '))));
  }

  return { root, headings };
}

/* ------------------------------------------------------------------ 视图 */

export async function mount(host, ctx) {
  const { store } = ctx;
  const disposers = [];

  const vs = {
    markdown: '',
    path: '',
    headings: [],
    schemas: [],
    activeHeading: '',
    loading: true,
    error: null,
    activeSchema: 0,
  };

  /* --------------------------------------------------------------- 结构 */

  const tocEl = h('nav.toc', { 'aria-label': '文档目录' });
  const docEl = h('div');

  const copyDocBtn = h('button.btn', {
    type: 'button',
    title: '复制整篇协议 Markdown',
    on: { click: () => copyDoc() },
  }, h('span', { textContent: '复制全文' }));

  const schemaBtn = h('button.btn', {
    type: 'button',
    title: '查看三份机器可校验的 JSON Schema',
    on: { click: () => openSchemas() },
  }, h('span', { textContent: '查看 Schema' }));

  const wrap = h('div.view-inner', { dataset: { view: 'protocol' } },
    h('div.view-head', null,
      h('h1.view-title', { textContent: '协议' }),
      h('div.view-rule')
    ),
    h('div.toolbar', null,
      copyDocBtn,
      schemaBtn
    ),
    h('div.grid12', null,
      h('div.c4', null, tocEl),
      h('div.c8', null, docEl)
    )
  );
  host.appendChild(wrap);

  /* ------------------------------------------------------- Schema 抽屉 */

  const sheet = createSheet(host, { id: 'protocol-schema', title: 'Schema', subtitle: '三份机器可校验的 JSON Schema' });
  const tabsEl = h('div.tabs');
  const schemaPre = h('pre', { textContent: '—' });
  const schemaMeta = h('div.field__hint');
  const schemaCopyBtn = h('button.btn', {
    type: 'button',
    title: '复制当前 Schema 原文',
    on: { click: () => copySchema() },
  }, h('span', { textContent: '复制当前 Schema' }));

  sheet.body.appendChild(h('div.param-section', null,
    h('div.param-section__title', null, h('span', { textContent: 'Schema 文件' })),
    tabsEl
  ));
  sheet.body.appendChild(h('div.param-section', null,
    h('div.codeblock.codeblock--wrap', null, schemaPre),
    schemaMeta
  ));
  sheet.foot.appendChild(schemaCopyBtn);

  function renderSchemaTabs() {
    clear(tabsEl);
    vs.schemas.forEach((schema, index) => {
      tabsEl.appendChild(h('button.tab', {
        type: 'button',
        dataset: { active: index === vs.activeSchema ? 'true' : 'false' },
        title: schema.path || schema.name,
        on: {
          click: () => {
            vs.activeSchema = index;
            renderSchemaTabs();
            renderSchemaBody();
          },
        },
      }, h('span', { textContent: schema.name || `Schema ${index + 1}` })));
    });
  }

  function renderSchemaBody() {
    const schema = vs.schemas[vs.activeSchema];
    schemaPre.textContent = schema ? String(schema.text || '') : '（没有可用的 Schema）';
    schemaMeta.textContent = schema
      ? `${schema.path || ''} · ${String(schema.text || '').length} 字符`
      : '主进程没有返回 Schema 文件。';
    schemaCopyBtn.disabled = !schema;
  }

  function openSchemas() {
    if (!vs.schemas.length) {
      ctx.toast.warn('没有可用的 Schema', { text: '主进程没有返回 Schema 文件。' });
      return;
    }
    renderSchemaTabs();
    renderSchemaBody();
    sheet.open();
  }

  async function copySchema() {
    const schema = vs.schemas[vs.activeSchema];
    if (!schema) return;
    const ok = await copyText(String(schema.text || ''));
    if (ok) ctx.toast.success('Schema 已复制', { text: schema.name || '' });
    else ctx.toast.warn('复制失败', '当前环境不允许访问剪贴板');
  }

  async function copyDoc() {
    if (!vs.markdown) {
      ctx.toast.warn('没有可复制的内容');
      return;
    }
    const ok = await copyText(vs.markdown);
    if (ok) ctx.toast.success('协议全文已复制', { text: `${vs.markdown.length} 个字符` });
    else ctx.toast.warn('复制失败', '当前环境不允许访问剪贴板');
  }

  /* --------------------------------------------------------------- 渲染 */

  function renderToc() {
    clear(tocEl);
    if (!vs.headings.length) {
      tocEl.appendChild(h('div.field__hint', { textContent: '文档没有标题。' }));
      return;
    }
    for (const heading of vs.headings) {
      if (heading.level > 3) continue;
      const item = h('a', {
        class: `toc__item toc__item--${Math.min(heading.level, 3)}`,
        href: `#${heading.id}`,
        role: 'link',
        tabindex: '0',
        title: heading.text,
        textContent: heading.text,
        dataset: { target: heading.id },
        on: {
          click: (event) => {
            event.preventDefault();
            focusHeading(heading);
          },
          keydown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              focusHeading(heading);
            }
          },
        },
      });
      tocEl.appendChild(item);
    }
    markActiveToc();
  }

  function focusHeading(heading) {
    if (!heading || !heading.el) return;
    heading.el.scrollIntoView({ block: 'start' });
    vs.activeHeading = heading.id;
    markActiveToc();
  }

  function markActiveToc() {
    for (const item of tocEl.querySelectorAll('.toc__item')) {
      if (item.dataset.target === vs.activeHeading) item.setAttribute('aria-current', 'true');
      else item.removeAttribute('aria-current');
    }
  }

  function renderFoot() {
    const ckp = store.pick('ckp') || '';
    const ready = Number(store.pick('kernelsReady') || 0);
    const total = Number(store.pick('kernelsTotal') || 0);
    const layout = store.pick('layout') || {};
    // 实时信息推到状态栏右下角（2.0.4 起不再各视图自己放一行 .footline）
    ctx.setStatusInfo([
      ckp ? `协议版本 CKP ${ckp}` : '协议版本 —',
      `可用内核 ${ready} / ${total}`,
      `Python ${orDash(layout.pythonVersion)}`,
      vs.path ? { text: `文档 ${vs.path}`, mono: true } : null,
    ]);
  }

  async function load() {
    vs.loading = true;
    vs.error = null;
    renderDoc();
    try {
      const [doc, schemas] = await Promise.all([
        window.khs.protocol.doc(),
        window.khs.protocol.schemas(),
      ]);
      if (!doc || doc.ok === false) throw new Error('主进程没有返回协议文档');
      vs.markdown = String(doc.markdown || '');
      vs.path = String(doc.path || '');
      vs.schemas = Array.isArray(schemas) ? schemas : [];
      vs.loading = false;
      renderDoc();
    } catch (err) {
      vs.loading = false;
      vs.error = ctx.wrapError(err, '读取协议文档失败');
      renderDoc();
    }
  }

  function renderDoc() {
    clear(docEl);
    if (vs.error) {
      docEl.appendChild(h('div.error-state', null,
        h('div.error-state__msg', { textContent: vs.error.message || String(vs.error) }),
        h('button.linkbtn', { type: 'button', on: { click: () => load() } }, h('span', { textContent: '重试' }))
      ));
      return;
    }
    if (vs.loading) {
      docEl.appendChild(h('div', null,
        h('div.skeleton', { style: { width: '100%' } }),
        h('div.skeleton', { style: { width: '100%', marginTop: 'var(--sp-2)' } }),
        h('div.skeleton', { style: { width: '70%', marginTop: 'var(--sp-2)' } })
      ));
      return;
    }
    const parsed = renderMarkdown(vs.markdown);
    vs.headings = parsed.headings;
    docEl.appendChild(parsed.root);
    renderToc();
  }

  /* --------------------------------------------------------------- 事件 */

  let rafPending = false;
  disposers.push(on(host, 'scroll', () => {
    if (rafPending || !vs.headings.length) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const hostTop = host.getBoundingClientRect().top;
      let current = vs.headings[0];
      for (const heading of vs.headings) {
        const top = heading.el.getBoundingClientRect().top - hostTop;
        if (top <= 96) current = heading;
        else break;
      }
      if (current && current.id !== vs.activeHeading) {
        vs.activeHeading = current.id;
        markActiveToc();
      }
    });
  }));

  disposers.push(store.subscribe((state, changed) => {
    if (changed.includes('kernelsReady') || changed.includes('kernelsTotal') || changed.includes('ckp')) renderFoot();
  }));

  renderFoot();
  await load();

  return {
    unmount() {
      sheet.destroy();
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
