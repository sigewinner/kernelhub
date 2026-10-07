'use strict';
/**
 * 并发任务队列：同一时刻最多 N 个内核进程，支持单个/全部取消、暂停、重试。
 * 所有状态变化都通过 EventEmitter 广播，UI 侧只订阅事件即可。
 */

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');

const { formatOfPath, basenameOf } = require('../shared/protocol');
const { defaultOutputPath } = require('./hub');

const STATE = {
  QUEUED: 'queued',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

function safeSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return undefined;
  }
}

class JobQueue extends EventEmitter {
  constructor(hub) {
    super();
    this.hub = hub;
    this.jobs = new Map();
    this.order = [];
    this.running = new Map(); // id -> AbortController
    this.parallel = 2;
    this.paused = false;
    this.seq = 0;
  }

  setParallel(n) {
    this.parallel = Math.max(1, Math.min(8, Number(n) || 1));
    this.emit('queue', this.list());
    this.pump();
  }

  list() {
    return this.order.map((id) => this.jobs.get(id)).filter(Boolean);
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  counts() {
    const c = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, total: 0 };
    for (const j of this.jobs.values()) {
      c[j.state] = (c[j.state] || 0) + 1;
      c.total += 1;
    }
    return c;
  }

  /**
   * 入队一批文件。
   * @param {object} req { sources, op, targetFormat, outDir, sameDir, params, kernelId, timeoutMs }
   */
  enqueue(req) {
    const sources = (req.sources || []).filter((s) => typeof s === 'string' && s);
    if (!sources.length) return [];
    const created = [];
    const taken = this.list()
      .filter((j) => j.output)
      .map((j) => j.output);

    for (const src of sources) {
      this.seq += 1;
      const id = `j${Date.now().toString(36)}${this.seq.toString(36)}`;
      const outDir = req.outDir || (req.sameDir ? path.dirname(src) : req.outDir || '');
      let output = '';
      try {
        output = defaultOutputPath(src, req.targetFormat, outDir, taken);
        taken.push(output);
      } catch {
        output = '';
      }
      const job = {
        id,
        source: src,
        sourceName: basenameOf(src),
        sourceFormat: formatOfPath(src),
        sourceBytes: safeSize(src),
        output,
        outputName: basenameOf(output),
        op: req.op || 'convert',
        targetFormat: req.targetFormat,
        params: { ...(req.params || {}) },
        kernelId: req.kernelId || '',
        timeoutMs: req.timeoutMs || 0,
        state: STATE.QUEUED,
        progress: 0,
        progressMessage: '',
        kernelUsed: '',
        kernelName: '',
        durationMs: 0,
        bytes: undefined,
        error: null,
        logs: [],
        addedAt: Date.now(),
        startedAt: 0,
        finishedAt: 0,
        command: [],
        jobPath: '',
        artifacts: [],
      };
      this.jobs.set(id, job);
      this.order.push(id);
      created.push(job);
    }

    this.emit('enqueue', created);
    this.emit('queue', this.list());
    this.pump();
    return created;
  }

  pump() {
    if (this.paused) return;
    const queued = this.list().filter((j) => j.state === STATE.QUEUED);
    const free = this.parallel - this.running.size;
    for (let i = 0; i < free && i < queued.length; i += 1) {
      this.start(queued[i]);
    }
  }

  async start(job) {
    if (job.state !== STATE.QUEUED) return;
    const controller = new AbortController();
    this.running.set(job.id, controller);
    job.state = STATE.RUNNING;
    job.startedAt = Date.now();
    job.progress = 0;
    job.progressMessage = '启动内核…';
    this.emit('update', job);
    this.emit('queue', this.list());

    const settingsTimeout = this.hub.settings.get('timeoutMs', 600000);
    const outcome = await this.hub.convert(
      {
        sources: [job.source],
        op: job.op,
        targetFormat: job.targetFormat,
        outPath: job.output,
        params: job.params,
        kernelId: job.kernelId,
        timeoutMs: job.timeoutMs || settingsTimeout,
        jobId: job.id,
      },
      {
        signal: controller.signal,
        onLog: (message, level) => {
          const line = { at: Date.now(), level, message };
          job.logs.push(line);
          if (job.logs.length > 500) job.logs.splice(0, job.logs.length - 500);
          this.emit('log', { jobId: job.id, ...line });
        },
        onProgress: (value, message) => {
          job.progress = Math.max(0, Math.min(1, value));
          job.progressMessage = message || job.progressMessage;
          this.emit('update', job);
        },
        onEvent: (evt) => {
          if (evt.type === 'hello') {
            job.kernelName = evt.engine || job.kernelName;
            this.emit('update', job);
          }
        },
      }
    );

    job.kernelUsed = outcome.kernel_id || job.kernelId;
    job.kernelName = outcome.kernel_name || job.kernelName;
    job.durationMs = outcome.duration_ms || 0;
    job.command = outcome.command || [];
    job.jobPath = outcome.job_path || '';
    job.artifacts = (outcome.artifacts || []).filter((a) => a.path);
    this.running.delete(job.id);

    if (outcome.ok) {
      const primary = (outcome.outputs || []).find((o) => o.primary) || (outcome.outputs || [])[0] || {};
      job.state = STATE.DONE;
      job.progress = 1;
      job.progressMessage = '完成';
      job.bytes = primary.bytes;
      job.output = primary.path || job.output;
      job.outputName = basenameOf(job.output);
      job.outputs = outcome.outputs || [];
      job.error = null;
      if (outcome.stderr) job.logs.push({ at: Date.now(), level: 'debug', message: outcome.stderr.slice(-2000) });
    } else {
      const err = outcome.error || {};
      const cancelled = err.code === 'CANCELLED';
      job.state = cancelled ? STATE.CANCELLED : STATE.FAILED;
      job.progressMessage = cancelled ? '已取消' : String(err.message || '失败');
      job.error = err;
      if (outcome.stderr) job.logs.push({ at: Date.now(), level: 'error', message: outcome.stderr.slice(-2000) });
    }
    job.finishedAt = Date.now();
    this.emit('update', job);
    this.emit('finish', { job, outcome });
    this.emit('queue', this.list());
    this.pump();

    const idle = this.list().every((j) => j.state !== STATE.QUEUED && j.state !== STATE.RUNNING);
    if (idle) this.emit('idle', this.counts());
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.state === STATE.QUEUED) {
      job.state = STATE.CANCELLED;
      job.progressMessage = '已取消';
      job.finishedAt = Date.now();
      this.emit('update', job);
      this.emit('queue', this.list());
      return true;
    }
    if (job.state === STATE.RUNNING) {
      const controller = this.running.get(id);
      if (controller) controller.abort();
      return true;
    }
    return false;
  }

  cancelAll() {
    for (const job of this.list()) {
      if (job.state === STATE.QUEUED || job.state === STATE.RUNNING) this.cancel(job.id);
    }
  }

  pause() {
    this.paused = true;
    this.emit('queue', this.list());
  }

  resume() {
    this.paused = false;
    this.emit('queue', this.list());
    this.pump();
  }

  remove(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.state === STATE.RUNNING) this.cancel(id);
    this.jobs.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.emit('queue', this.list());
    return true;
  }

  clear(finishedOnly = true) {
    for (const job of this.list()) {
      if (finishedOnly && (job.state === STATE.QUEUED || job.state === STATE.RUNNING)) continue;
      this.remove(job.id);
    }
    this.emit('queue', this.list());
    return true;
  }

  retry(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.state === STATE.RUNNING || job.state === STATE.QUEUED) return job;
    job.state = STATE.QUEUED;
    job.progress = 0;
    job.progressMessage = '';
    job.error = null;
    job.durationMs = 0;
    job.logs = [];
    this.emit('update', job);
    this.emit('queue', this.list());
    this.pump();
    return job;
  }

  retryFailed() {
    for (const job of this.list()) if (job.state === STATE.FAILED) this.retry(job.id);
    return this.list();
  }
}

module.exports = { JobQueue, STATE };
