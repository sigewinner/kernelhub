'use strict';
/**
 * 内核输出适配层：把注册表里的内核整理成 UI 需要的形状。
 * UI 不在本地保存任何内核知识 —— 一切以清单为准（协议驱动）。
 */

const { OP_META, opLabel, opIcon } = require('./registry');
const { KIND_LABELS, STATUS_LABELS_ZH } = require('../shared/protocol');

function humanSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

/** UI 用的内核卡片视图（在 KernelEntry.toPublicDict 之上补 UI 字段） */
function kernelView(entry) {
  const pub = entry.toPublicDict();
  const m = entry.manifest;
  const ready = entry.status === 'ready';

  const inputSet = new Set();
  const outputSet = new Set();
  for (const c of m.capabilities) {
    c.from.forEach((f) => f !== '*' && inputSet.add(f));
    c.to.forEach((f) => f !== '*' && outputSet.add(f));
  }

  const ops = Array.from(new Set(m.capabilities.map((c) => c.op))).sort();
  return {
    ...pub,
    /**
     * 界面上显示的名字（软件层面的命名，见 shared/pluginName.js）：
     * 「类型 + 最典型的两个扩展名」，例如「图片 PNG / JPG」。
     * 代码层面的原清单名保留在 codeName 里，详情页会显示出来。
     */
    name: entry.displayName || pub.name,
    displayName: entry.displayName || pub.name,
    codeName: m.name,
    kindLabel: KIND_LABELS[m.kind] || m.kind,
    ready,
    statusLabel: STATUS_LABELS_ZH[entry.status] || entry.status,
    descriptions: {
      op: ops.map((op) => ({ op, label: opLabel(op), icon: opIcon(op) })),
    },
    capabilityMatrix: m.capabilities.map((c) => ({
      id: c.id,
      op: c.op,
      label: c.label || opLabel(c.op),
      from: c.from,
      to: c.to,
      pairs: c.from.length * c.to.length,
      multi_in: c.multi_in,
      multi_out: c.multi_out,
      output_mode: c.output_mode || 'exact',
      quality: c.quality,
    })),
    paramCount: m.params.length,
    xCli: Boolean(m.xCli),
    engine: {
      type: m.runtime.type,
      entry: m.runtime.entry,
      requires: m.runtime.requires,
      note: entry.engineNote,
      executables: pub.executableSpec,
    },
    inputFormats: Array.from(inputSet).sort(),
    outputFormats: Array.from(outputSet).sort(),
  };
}

/** 单个内核的完整详情（含原始清单，供「查看 JSON」用） */
function kernelDetail(entry) {
  const view = kernelView(entry);
  return {
    ...view,
    manifest: entry.manifest.raw,
    manifestPath: entry.manifestPath,
    directory: entry.directory,
    mtime: entry.mtime,
    probe: {
      type: entry.manifest.probe.type,
      target: entry.manifest.probe.target,
      args: entry.manifest.probe.args,
      expect: entry.manifest.probe.expect,
    },
    hooks: entry.manifest.hooks,
    params: entry.manifest.params.map((p) => ({ ...p.raw })),
  };
}

/** 操作目录：op -> 该操作下的输入/输出格式与可用内核 */
function opsCatalog(registry) {
  const rows = registry.matrix();
  const ready = registry.readyEntries();
  return rows.map((row) => ({
    ...row,
    icon: opIcon(row.op),
    description: (OP_META[row.op] && OP_META[row.op].description) || '',
    kernelCount: row.kernels.length,
    kernels: row.kernels
      .map((id) => {
        const e = ready.find((x) => x.id === id);
        return e ? { id, name: e.name, kind: e.manifest.kind } : { id, name: id, kind: 'other' };
      })
      .slice(0, 24),
  }));
}

/** 格式目录：格式 -> 可作为输入/输出的操作与内核数 */
function formatsCatalog(registry) {
  const map = new Map();
  const touch = (fmt) => {
    if (!map.has(fmt)) {
      map.set(fmt, { format: fmt, asInput: new Set(), asOutput: new Set(), kernels: new Set() });
    }
    return map.get(fmt);
  };
  for (const entry of registry.readyEntries()) {
    for (const cap of entry.manifest.capabilities) {
      cap.from.forEach((f) => {
        if (f === '*') return;
        const rec = touch(f);
        rec.asInput.add(cap.op);
        rec.kernels.add(entry.id);
      });
      cap.to.forEach((f) => {
        if (f === '*') return;
        const rec = touch(f);
        rec.asOutput.add(cap.op);
        rec.kernels.add(entry.id);
      });
    }
  }
  return Array.from(map.values())
    .sort((a, b) => a.format.localeCompare(b.format))
    .map((r) => ({
      format: r.format,
      asInput: Array.from(r.asInput).sort(),
      asOutput: Array.from(r.asOutput).sort(),
      kernelCount: r.kernels.size,
      kernels: Array.from(r.kernels).sort().slice(0, 12),
    }));
}

/** 状态台账：可用/缺失/未安装的汇总 + 每条安装提示 */
function statusOverview(registry) {
  const entries = registry.allEntries();
  const byStatus = {};
  for (const e of entries) {
    const s = e.status;
    byStatus[s] = byStatus[s] || { status: s, label: STATUS_LABELS_ZH[s] || s, count: 0, kernels: [] };
    byStatus[s].count += 1;
    byStatus[s].kernels.push({ id: e.id, name: e.name, detail: e.detail, installHint: e.installHint() });
  }
  return {
    total: entries.length,
    ready: registry.readyEntries().length,
    byStatus: Object.values(byStatus).sort((a, b) => b.count - a.count),
    errors: [...registry.errors],
    searchPaths: [...registry.searchPaths],
  };
}

module.exports = {
  humanSize,
  kernelView,
  kernelDetail,
  opsCatalog,
  formatsCatalog,
  statusOverview,
};
