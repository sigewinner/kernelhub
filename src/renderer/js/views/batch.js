/**
 * views/batch.js —— 队列
 *
 * 版面（docs/ui-spec-swiss.md 4.2）：3 个按钮（+ 行内图标操作 + 空状态 1 个）
 *   工具栏：[暂停/继续] [清除已完成] [全部取消] …右侧：并发 ▾
 *   表格：状态 / 文件 → 目标 / 大小 / 内核 / 耗时 / 进度 / 行内图标（取消、重试、打开产物、展开日志）
 *   展开行：该作业日志（等宽、最多 200px 高、可滚动）
 *   空状态：「还没有作业」+ [添加文件]
 *
 * 作业数据来自 app.js 维护的 store.pick('jobs')（Map<id, Job>），
 * 本视图不主动轮询，只订阅 store 变化重画表格。
 */

import { h, clear, on, iconAction } from '../dom.js';
import { icon } from '../icons.js';
import { statusBadge, jobStateMeta } from '../layout.js';
import { elapsed, percent, thousands, formatLabel, clockTime } from '../format.js';
import { t } from '../i18n.js';

export async function mount(host, ctx) {
  const { store } = ctx;
  const disposers = [];

  const expanded = new Set();
  const logCache = new Map(); // jobId -> logs[]

  /* --------------------------------------------------------------- 结构 */

  const pauseBtn = h('button.btn', { type: 'button', on: { click: () => togglePause() } });
  const clearBtn = h('button.btn', {
    type: 'button',
    title: t('移除已完成 / 已取消 / 失败的作业记录'),
    on: { click: () => clearFinished() },
  }, h('span', { textContent: t('清除已完成') }));
  const cancelAllBtn = h('button.btn.btn--danger', {
    type: 'button',
    title: t('取消所有排队中与进行中的作业'),
    on: { click: () => cancelAll() },
  }, h('span', { textContent: t('全部取消') }));

  const parallelSelect = h('select.select', { 'aria-label': t('并发上限') });
  for (let n = 1; n <= 8; n += 1) parallelSelect.appendChild(h('option', { value: String(n), textContent: String(n) }));

  const tableHost = h('div');

  const wrap = h('div.view-inner', { dataset: { view: 'batch' } },
    h('div.view-head', null,
      h('h1.view-title', { textContent: t('队列') }),
      h('div.view-rule')
    ),
    h('div.toolbar', null,
      pauseBtn,
      clearBtn,
      cancelAllBtn,
      h('div.toolbar__right', null,
        h('label.label', { style: { marginBottom: '0' }, textContent: t('并发') }),
        h('div.selectwrap', { style: { width: '80px' } }, parallelSelect)
      )
    ),
    tableHost
  );
  host.appendChild(wrap);

  /* --------------------------------------------------------------- 动作 */

  async function togglePause() {
    const paused = Boolean(store.pick('queuePaused'));
    try {
      if (paused) await window.khs.queue.resume();
      else await window.khs.queue.pause();
      store.set({ queuePaused: !paused });
      ctx.toast.info(paused ? '队列已继续' : '队列已暂停');
      render();
    } catch (err) {
      ctx.reportError(paused ? '继续队列失败' : '暂停队列失败', ctx.wrapError(err));
    }
  }

  async function clearFinished() {
    const counts = store.pick('queueCounts') || {};
    const finished = Number(counts.done || 0) + Number(counts.failed || 0) + Number(counts.cancelled || 0);
    if (!finished) {
      ctx.toast.info(t('没有可清除的已完成作业'));
      return;
    }
    try {
      await window.khs.queue.clear(true);
      expanded.clear();
      logCache.clear();
      ctx.toast.success(t('已清除 {0} 条作业记录', { 0: finished }));
    } catch (err) {
      ctx.reportError(t('清除已完成作业失败'), ctx.wrapError(err));
    }
  }

  async function cancelAll() {
    const counts = store.pick('queueCounts') || {};
    const active = Number(counts.queued || 0) + Number(counts.running || 0);
    if (!active) {
      ctx.toast.info(t('当前没有进行中的作业'));
      return;
    }
    if (!(await ctx.modal.confirm(t('取消全部 {0} 个排队中 / 进行中的作业？', { 0: active }), { okLabel: t('全部取消'), danger: true }))) return;
    try {
      await window.khs.queue.cancelAll();
      ctx.toast.success(t('已请求取消全部作业'));
    } catch (err) {
      ctx.reportError(t('取消全部作业失败'), ctx.wrapError(err));
    }
  }

  async function cancelOne(job) {
    try {
      await window.khs.queue.cancel(job.id);
    } catch (err) {
      ctx.reportError(t('取消作业失败'), ctx.wrapError(err));
    }
  }

  async function retryOne(job) {
    try {
      await window.khs.queue.retry(job.id);
      ctx.toast.info(t('已重新排队'), { text: job.sourceName || job.id });
    } catch (err) {
      ctx.reportError(t('重试作业失败'), ctx.wrapError(err));
    }
  }

  async function openArtifact(job) {
    const target = job.output || (Array.isArray(job.artifacts) && job.artifacts[0] ? job.artifacts[0].path : '');
    if (!target) {
      ctx.toast.warn(t('该作业没有产物路径'));
      return;
    }
    await ctx.openPathSafe(target, '产物');
  }

  async function toggleLog(job) {
    if (expanded.has(job.id)) {
      expanded.delete(job.id);
      render();
      return;
    }
    expanded.add(job.id);
    render();
    if (logCache.has(job.id)) return;
    try {
      const res = await window.khs.queue.jobLogs(job.id);
      logCache.set(job.id, (res && res.logs) || []);
    } catch (err) {
      logCache.set(job.id, [{ at: Date.now(), level: 'error', message: t('读取作业日志失败：{0}', { 0: err && err.message ? err.message : String(err) }) }]);
    }
    render();
  }

  function onParallelChange() {
    const n = Number(parallelSelect.value) || 1;
    Promise.resolve(window.khs.queue.setParallel(n))
      .then(() => ctx.patchSettings({ maxParallel: n }, { silent: true }))
      .then(() => ctx.toast.success(t('并发上限已设为 {0}', { 0: n })))
      .catch((err) => ctx.reportError(t('设置并发失败'), ctx.wrapError(err)));
  }

  /* --------------------------------------------------------------- 渲染 */

  function jobList() {
    const map = store.pick('jobs');
    const list = map instanceof Map ? Array.from(map.values()) : [];
    return list.filter(Boolean).sort((a, b) => (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0));
  }

  /**
   * 行内图标操作：刻意用 <span role="button">（见 dom.js 的 iconAction）。
   * 表格行里如果每行放 4 个 <button>，一屏作业就是几十个按钮，
   * 所以行操作不占「每屏按钮 ≤ 10」的预算；整行本身可点（切展开日志）。
   */
  function iconButton(iconName, title, onClick, disabled) {
    return iconAction({
      label: title,
      disabled,
      stop: true,
      children: [icon(iconName, { size: 14 })],
      onClick,
    });
  }

  function render() {
    const jobs = jobList();
    const counts = store.pick('queueCounts') || {};

    // 暂停/继续按钮文案随状态变化
    const paused = Boolean(store.pick('queuePaused'));
    clear(pauseBtn);
    pauseBtn.appendChild(h('span', { textContent: paused ? t('继续') : t('暂停') }));
    pauseBtn.title = paused ? '继续执行队列' : '暂停调度新作业';

    // 并发选择器始终跟随设置（设置页也能改它）
    const parallel = String(Number((store.pick('settings') || {}).maxParallel) || 1);
    if (Array.from(parallelSelect.options).some((o) => o.value === parallel)) parallelSelect.value = parallel;

    clear(tableHost);
    if (!jobs.length) {
      tableHost.appendChild(h('div.empty', null,
        h('div.empty__title', { textContent: t('还没有作业') }),
        h('div.empty__text', { textContent: t('在「转换」里添加文件并开始转换，作业会按并发度在这里排队执行。') }),
        h('div.empty__actions', null,
          h('button.btn.btn--primary', {
            type: 'button',
            on: { click: () => ctx.pickFiles() },
          }, h('span', { textContent: t('添加文件') }))
        )
      ));
    } else {
      const tbody = h('tbody');
      for (const job of jobs) {
        const meta = jobStateMeta(job.state);
        const value = Number(job.progress) || 0;
        const canCancel = job.state === 'queued' || job.state === 'running';
        const canRetry = job.state === 'failed' || job.state === 'cancelled';
        const isOpen = expanded.has(job.id);

        tbody.appendChild(h('tr', {
          dataset: { job: job.id },
          title: `${job.source || job.sourceName || job.id}${job.output ? `\n→ ${job.output}` : ''}\n（点击整行展开/收起日志）`,
          class: 'jobrow',
          on: { click: () => toggleLog(job) },
        },
          h('td', null, statusBadge(meta.label, meta.tone)),
          h('td', { class: 'truncate' },
            h('div', null,
              h('span', { textContent: job.sourceName || job.source || job.id }),
              h('span.dim', { textContent: ' → ' }),
              h('span.mono', { textContent: formatLabel(job.targetFormat) })
            )
          ),
          h('td', { class: 'num mono', textContent: job.size || job.sourceSize || '—' }),
          h('td', { class: 'truncate', textContent: job.kernelName || job.kernelUsed || '待选核' }),
          h('td', { class: 'num mono', textContent: elapsed(job.startedAt, job.finishedAt) }),
          h('td', null,
            h('div.jobrow__progress', null,
              h('div.progress', null, h('div.progress__fill', { style: { width: `${Math.max(2, value * 100)}%` } })),
              h('span.jobrow__pct', { textContent: job.state === 'done' ? '100%' : percent(value) })
            )
          ),
          h('td', null,
            h('div.rowactions', null,
              iconButton('close', t('取消该作业'), () => cancelOne(job), !canCancel),
              iconButton('retry', t('重试该作业'), () => retryOne(job), !canRetry),
              iconButton('external', t('在资源管理器中定位产物'), () => openArtifact(job), job.state !== 'done' || !job.output),
              iconButton(isOpen ? 'chevronDown' : 'chevronRight', isOpen ? '收起日志' : '展开日志', () => toggleLog(job), false)
            )
          )
        ));

        if (job.error && job.error.message) {
          tbody.appendChild(h('tr', null,
            h('td', { colspan: '7' }, h('div.strip.strip--err', null,
              h('span', { textContent: `${job.error.code || 'ERROR'}：${job.error.message}` })
            ))
          ));
        }

        if (isOpen) {
          const logs = logCache.get(job.id);
          tbody.appendChild(h('tr', null,
            h('td', { colspan: '7' },
              h('div.joblog', {
                textContent: logs === undefined
                  ? '正在读取作业日志…'
                  : logs.length
                    ? logs.map((l) => `${clockTime(l.at)}  ${l.message || ''}`).join('\n')
                    : '（该作业没有日志）',
              })
            )
          ));
        }
      }

      tableHost.appendChild(h('table.table.table--center', null,
        h('colgroup', null,
          h('col', { style: { width: '11%' } }),
          h('col', { style: { width: '27%' } }),
          h('col', { style: { width: '10%' } }),
          h('col', { style: { width: '17%' } }),
          h('col', { style: { width: '9%' } }),
          h('col', { style: { width: '14%' } }),
          h('col', { style: { width: '12%' } })
        ),
        h('thead', null, h('tr', null,
          h('th', { textContent: t('状态') }),
          h('th', { textContent: t('文件 → 目标') }),
          h('th', { class: 'num', textContent: t('大小') }),
          h('th', { textContent: t('内核') }),
          h('th', { class: 'num', textContent: t('耗时') }),
          h('th', { textContent: t('进度') }),
          h('th', { class: 'num', textContent: t('操作') })
        )),
        tbody
      ));
    }

    // 实时信息推到状态栏右下角（2.0.4 起不再各视图自己放一行 .footline）
    ctx.setStatusInfo([
      t('{0} 个作业', { 0: thousands(jobs.length) }),
      t('待处理 {0}', { 0: thousands(counts.queued || 0) }),
      t('运行 {0}', { 0: thousands(counts.running || 0) }),
      t('已完成 {0}', { 0: thousands(counts.done || 0) }),
      t('失败 {0}', { 0: thousands(counts.failed || 0) }),
      paused ? { text: t('队列已暂停'), tone: 'warn' } : null,
    ]);
  }

  /* --------------------------------------------------------------- 事件 */

  disposers.push(on(parallelSelect, 'change', onParallelChange));

  // 作业日志增量：只影响已展开的那一行
  disposers.push(window.khs.on('evt:job:log', (line) => {
    if (!line || !line.jobId) return;
    const list = logCache.get(line.jobId);
    if (list) list.push({ at: line.at, level: line.level, message: line.message });
    if (expanded.has(line.jobId)) render();
  }));

  let lastSignature = '';
  function signature() {
    const jobs = jobList();
    return jobs.map((j) => `${j.id}:${j.state}:${Math.round((Number(j.progress) || 0) * 100)}:${j.kernelUsed || ''}`).join('|');
  }

  disposers.push(store.subscribe(() => {
    const next = signature();
    const structural = next !== lastSignature;
    lastSignature = next;
    if (structural || expanded.size) render();
  }));

  lastSignature = signature();
  render();
  if (!parallelSelect.value) parallelSelect.value = String(Number((store.pick('settings') || {}).maxParallel) || 1);

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
