'use strict';
/**
 * 设置存储：把用户配置写进 Electron userData 下的 config.json。
 * 结构刻意与 kernel-hub 的 ~/.kernelhub/config.json 保持兼容（字段同名）。
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  version: 1,
  hubRoot: '',
  extraPluginDirs: [],
  disabledKernels: [],
  priorityOverrides: {},
  lastOutputDir: '',
  lastInputDir: '',
  locale: 'zh-CN',
  theme: 'aurora',
  timeoutMs: 600000,
  maxParallel: 2,
  defaultOp: 'convert',
  autoScan: true,
  keepLogLines: 4000,
  seenWelcome: false,
};

class Settings {
  constructor(stateDir) {
    this.dir = stateDir;
    this.file = path.join(stateDir, 'config.json');
    this.data = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.data = { ...DEFAULTS, ...parsed };
      }
    } catch {
      /* 缺失或损坏 → 用默认值 */
    }
    return this.data;
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  get(key, fallback) {
    const v = this.data[key];
    return v === undefined ? fallback : v;
  }

  all() {
    return { ...this.data };
  }

  patch(patch) {
    this.data = { ...this.data, ...(patch || {}) };
    this.save();
    return this.all();
  }

  /** 停用/启用内核（与 Python 宿主同一语义与字段名） */
  setKernelEnabled(id, enabled) {
    const set = new Set(this.data.disabledKernels || []);
    if (enabled) set.delete(id);
    else set.add(id);
    this.data.disabledKernels = Array.from(set).sort();
    this.save();
  }

  setPriority(id, priority) {
    const overrides = { ...(this.data.priorityOverrides || {}) };
    overrides[id] = Number(priority);
    this.data.priorityOverrides = overrides;
    this.save();
  }
}

module.exports = { Settings, DEFAULTS };
