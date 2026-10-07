'use strict';
/**
 * x-cli 通用命令行桥接（Node 侧）。
 *
 * 与 kernel-hub/kernelhub/cli_bridge.py 的占位符语义完全一致：
 *
 *   {input} / {inputN} / {inputs}   输入路径
 *   {output} / {outputN} / {outputs} 输出路径
 *   {outdir} {stem} {ext} {workdir}
 *   {param:NAME} {param:NAME|默认值}
 *   {exe:名字}                      可执行文件解析
 *
 * 模板字段：command / args / optional_args / tail_args / output_mode / output_glob
 *
 * 本模块输出 **执行计划**（argv），不负责跑进程 —— 跑进程由 runner 负责，
 * 这样 UI 才能做「真实命令行预览」。
 */

const path = require('path');

const { canonicalFormat, CkpError, formatsMatch } = require('../shared/protocol');
const { globSync } = require('./paths');
const { resolveExecutable } = require('./executables');

const TOKEN_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*(?::[^}]*)?)\}/g;

function paramValue(params, rest, fallback) {
  const name = rest.trim();
  const value = params ? params[name] : undefined;
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/** 把单条 argv 模板展开成字符串列表 */
function expandArg(raw, ctx) {
  const replaced = String(raw).replace(TOKEN_RE, (_m, token) => {
    if (token.startsWith('exe:')) {
      const name = token.slice(4).trim();
      const hit = ctx.executables[name];
      if (!hit) throw new CkpError('DEPENDENCY_MISSING', `模板引用了未声明的可执行文件 '{exe:${name}}'`);
      return hit;
    }
    if (token.startsWith('param:')) {
      const rest = token.slice(6);
      const bar = rest.indexOf('|');
      const fallback = bar >= 0 ? rest.slice(bar + 1) : '';
      return paramValue(ctx.params, bar >= 0 ? rest.slice(0, bar) : rest, fallback);
    }
    switch (token) {
      case 'input':
      case 'input0':
        return ctx.inputs[0] || '';
      case 'inputs':
        return ctx.inputs.join('\u0000');
      case 'output':
      case 'output0':
        return ctx.outputs[0] || '';
      case 'outputs':
        return ctx.outputs.join('\u0000');
      case 'outdir':
        return ctx.outdir || '';
      case 'stem':
        return ctx.stem || '';
      case 'ext':
        return ctx.ext || '';
      case 'workdir':
        return ctx.workdir || '';
      default: {
        const m = /^input(\d+)$/.exec(token);
        if (m) return ctx.inputs[Number(m[1])] || '';
        const o = /^output(\d+)$/.exec(token);
        if (o) return ctx.outputs[Number(o[1])] || '';
        return '';
      }
    }
  });
  // {inputs} / {outputs} 展开为多个 argv（用 \0 分隔）
  return replaced.split('\u0000').filter((s) => s !== '');
}

function expandAll(list, ctx) {
  const out = [];
  for (const item of list || []) {
    for (const part of expandArg(item, ctx)) out.push(part);
  }
  return out;
}

/** 某条模板是否匹配当前 job（op / from / to） */
function whenMatches(when, srcFmt, dstFmt, op) {
  if (!when || typeof when !== 'object') return true;
  if (when.op && when.op.length && !when.op.includes(op)) return false;
  if (when.from && when.from.length) {
    if (!when.from.some((f) => formatsMatch(f, srcFmt))) return false;
  }
  if (when.to && when.to.length) {
    if (!when.to.some((f) => formatsMatch(f, dstFmt))) return false;
  }
  return true;
}

/** 选模板：先按 when 过滤，再看声明顺序；无 when 的通用模板作为兜底 */
function pickTemplate(templates, srcFmt, dstFmt, op) {
  const list = (templates || []).filter((t) => t && t.command);
  const specific = list.filter((t) => t.when && Object.keys(t.when).length);
  for (const t of specific) if (whenMatches(t.when, srcFmt, dstFmt, op)) return t;
  const generic = list.filter((t) => t.op === op && (!t.when || !Object.keys(t.when).length));
  if (generic.length) return generic[0];
  const byOp = list.filter((t) => t.op === op);
  if (byOp.length) return byOp[0];
  return null;
}

/**
 * 构造执行计划。
 * @returns {{argv: string[], template: object, outputMode: string, outputGlob: string}}
 */
function buildPlan(entry, job, ctx) {
  const { hubRoot = '', sysPath = [] } = ctx || {};
  const xCli = entry.manifest.xCli || {};
  const templates = xCli.templates || [];
  const params = job.params || {};
  const inputs = (job.inputs || []).map((i) => i.path);
  const outputs = (job.outputs || []).map((o) => o.path);
  const srcFmt = (job.inputs && job.inputs[0] && job.inputs[0].format) || '';
  const dstFmt = (job.outputs && job.outputs[0] && job.outputs[0].format) || '';
  const op = job.op || 'convert';

  const template = pickTemplate(templates, srcFmt, dstFmt, op);
  if (!template) {
    throw new CkpError(
      'UNSUPPORTED_FORMAT',
      `内核 ${entry.id} 的 x-cli 没有匹配 ${srcFmt || '*'} → ${dstFmt || '*'}（${op}）的模板`
    );
  }

  // 先解析所有需要的可执行文件（失败即 DEPENDENCY_MISSING，不启动进程）
  const executables = {};
  for (const raw of [template.command, ...(template.args || []), ...(template.tail_args || [])]) {
    const re = /\{exe:([^}]+)\}/g;
    let m;
    while ((m = re.exec(String(raw))) !== null) {
      const name = m[1].trim();
      if (executables[name]) continue;
      const spec = (xCli.executables || {})[name];
      executables[name] = resolveExecutable(name, spec, { hubRoot, sysPath }).path;
    }
  }

  const out0 = outputs[0] || '';
  const in0 = inputs[0] || '';
  const expandCtx = {
    inputs,
    outputs,
    params,
    executables,
    outdir: out0 ? path.dirname(out0) : job.workdir || '',
    stem: in0 ? path.basename(in0, path.extname(in0)) : 'output',
    ext: canonicalFormat(dstFmt) || (out0 ? path.extname(out0).replace('.', '') : 'bin'),
    workdir: job.workdir || (out0 ? path.dirname(out0) : process.cwd()),
  };

  const argv = [];
  argv.push(...expandAll([template.command], expandCtx));
  argv.push(...expandAll(template.args, expandCtx));

  // optional_args：值为空则整项省略
  for (const item of template.optional_args || []) {
    if (!item || !item.flag) continue;
    const value = item.value === undefined ? '' : expandAll([item.value], expandCtx).join(' ');
    if (value === '') continue;
    argv.push(...expandAll([item.flag], expandCtx), value);
  }

  // output_mode=exact 时在尾部补上 {output}（模板自己写了的就不再补）
  const outputMode = String(template.output_mode || 'exact');
  const tail = template.tail_args || [];
  const hasOutputToken = [...(template.args || []), ...tail].some((a) => /\{outputs?\b|\{output\d*\}/.test(String(a)));
  argv.push(...expandAll(tail, expandCtx));
  if (outputMode === 'exact' && !hasOutputToken && out0) argv.push(out0);

  return { argv, template, outputMode, outputGlob: String(template.output_glob || '') };
}

/** output_mode=glob 时收集产物 */
function collectGlobOutputs(plan, job) {
  const raw = String(job.outputs && job.outputs[0] && job.outputs[0].path) || '';
  const inputs = (job.inputs || []).map((i) => i.path);
  const srcFmt = (job.inputs && job.inputs[0] && job.inputs[0].format) || '';
  const dstFmt = (job.outputs && job.outputs[0] && job.outputs[0].format) || '';
  const ctx = {
    inputs,
    outputs: (job.outputs || []).map((o) => o.path),
    params: job.params || {},
    executables: {},
    outdir: raw ? path.dirname(raw) : job.workdir || '',
    stem: inputs[0] ? path.basename(inputs[0], path.extname(inputs[0])) : 'output',
    ext: canonicalFormat(dstFmt) || 'bin',
    workdir: job.workdir || '',
  };
  const outdir = ctx.outdir;
  const stem = ctx.stem;
  ctx.stem = stem;
  let pattern = plan.outputGlob || path.join(outdir, `${stem}_*.${ctx.ext}`);
  pattern = pattern.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_m, token) => {
    if (token === 'outdir') return outdir;
    if (token === 'stem') return stem;
    if (token === 'ext') return ctx.ext;
    if (token === 'output' || token === 'output0') return raw;
    return '';
  });
  return globSync(pattern);
}

module.exports = { buildPlan, pickTemplate, whenMatches, collectGlobOutputs, expandArg };
