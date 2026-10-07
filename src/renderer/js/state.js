/**
 * state.js —— 全局状态单例
 *
 * 为什么单独一个文件：视图是懒加载的独立模块，如果 store 定义在 app.js 里，
 * 视图 import app.js 会形成「app → view → app」的循环依赖。
 * 把状态拎出来当叶子模块，依赖方向就永远是 app/view → state，干净且无环。
 *
 * 状态分层：
 *   外壳层：info/layout/settings/version/ckp/activeView/maximized  —— 全局只有一份
 *   数据层：kernels/ops/jobs/logs/pending                          —— 由 app.js 的事件桥维护
 *   缓存层：formatsCache/opsMap                                    —— 避免重复 IPC 的派生数据
 */

import { createStore } from './store.js';

export const state = createStore({
  /* ---- 启动 ---- */
  bootPhase: 'loading', // loading | ready | error
  bootError: null,

  /* ---- 环境 ---- */
  info: null,
  layout: null,
  settings: null,
  version: '',
  ckp: '',

  /* ---- 内核 ---- */
  kernels: [],
  kernelsSummary: null,
  kernelsTotal: 0,
  kernelsReady: 0,
  kernelByStatus: [],
  kernelErrors: [],
  kernelSearchPaths: [],

  /* ---- 操作（op）目录 ---- */
  ops: [],
  opsMap: {},

  /* ---- 队列 ---- */
  jobs: new Map(),
  queueCounts: null,
  queuePaused: false,
  parallel: 2,

  /* ---- 日志 ---- */
  logs: [],
  logCount: 0,
  logErrorCount: 0,

  /* ---- 待转换文件池：跨视图共享，切走再切回不丢 ---- */
  pending: [],

  /* ---- 派生缓存 ---- */
  formatsCache: null, // kernels.formats() 的结果，供命令面板与格式矩阵共享

  /* ---- 最近一次提交到队列的作业（转换页的「上次结果」用） ---- */
  lastRunIds: [],

  /* ---- 外壳 ---- */
  activeView: 'convert',
  maximized: false,
  lastOutputDir: '',
}, {
  onWarn: (msg) => console.warn('[state]', msg),
});

/** 日志环形缓冲上限（与主进程 keepLogLines 默认值对齐） */
export const LOG_LIMIT = 4000;

/**
 * 追加日志。
 * 注意：直接 push 后显式用一个新数组引用 set，确保所有订阅者都能收到通知
 * （store 内部用 Object.is 判断是否真的变了）。
 */
export function pushLogEntry(entry) {
  const logs = state.pick('logs');
  logs.push(entry);
  if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT);
  state.set({
    logs: logs.slice(),
    logCount: logs.length,
    logErrorCount: state.pick('logErrorCount') + (entry.level === 'error' ? 1 : 0),
  });
}

/** 用主进程返回的日志列表整体替换本地缓冲（启动/清空后调用） */
export function replaceLogs(list) {
  const logs = Array.isArray(list) ? list.slice(-LOG_LIMIT) : [];
  state.set({
    logs,
    logCount: logs.length,
    logErrorCount: logs.filter((l) => l && l.level === 'error').length,
  });
}

/** 由作业表重新计算计数（本地兜底，主进程没给 counts 时用） */
export function countsFromJobs(map) {
  const counts = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, total: 0 };
  for (const job of map.values()) {
    counts[job.state] = (counts[job.state] || 0) + 1;
    counts.total += 1;
  }
  return counts;
}

export default state;
