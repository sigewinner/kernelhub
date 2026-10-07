'use strict';
/**
 * 端到端冒烟测试（不依赖 Electron）：
 *   协议核心 → 内核发现与探测 → 计划/选核/参数 → 真实转换（含 x-cli 命令行内核）→ 失败路径
 *
 *   node tools/smoke.js            交互式输出
 *   node tools/smoke.js --quiet    只输出结论
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const protocol = require('../src/shared/protocol');
const { Settings } = require('../src/engine/config');
const { detectHubRoot, resolveStateDir } = require('../src/engine/paths');
const { Registry } = require('../src/engine/registry');
const { Hub } = require('../src/engine/hub');
const { JobQueue } = require('../src/engine/queue');
const { makeFixtures } = require('./fixtures');
const { resolveExecutable } = require('../src/engine/executables');

const quiet = process.argv.includes('--quiet');
const results = [];

function check(name, condition, detail = '') {
  results.push({ name, pass: Boolean(condition), detail });
  if (!quiet) console.log(`${condition ? '  ✓' : '  ✕'} ${name}${detail && !condition ? `  ← ${detail}` : ''}`);
  return Boolean(condition);
}

function section(title) {
  if (!quiet) console.log(`\n${title}`);
}

async function main() {
  /* -------------------------------------------------------------- 协议核心 */
  section('【1】协议核心');
  check('canonicalFormat 展开别名', protocol.canonicalFormat('JPEG') === 'jpg' && protocol.canonicalFormat('.TIF') === 'tif');
  check('formatsMatch 支持别名族', protocol.formatsMatch('jpeg', 'jpg') && protocol.formatsMatch('*', 'whatever'));
  check('formatOfPath 推断格式', protocol.formatOfPath('a\\b\\c.WEBP') === 'webp');
  check('默认输出名不加 -1（无冲突）', protocol.stemOf('D:\\x\\photo.png') === 'photo');

  const validManifest = {
    ckp: '1.0', id: 'demo-kernel', name: 'Demo', version: '1.0.0',
    runtime: { type: 'python', entry: 'adapter.py' },
    capabilities: [{ op: 'convert', from: ['png'], to: ['jpg'] }],
  };
  check('合法清单通过校验', protocol.validateManifest(validManifest).length === 0, JSON.stringify(protocol.validateManifest(validManifest)));
  check('非法 id 被拒绝', protocol.validateManifest({ ...validManifest, id: 'Bad_ID' }).some((e) => e.includes("'id'")));
  check('缺 capabilities 被拒绝', protocol.validateManifest({ ...validManifest, capabilities: [] }).length > 0);
  check('主版本不兼容被拒绝', protocol.validateManifest({ ...validManifest, ckp: '2.0' }).some((e) => e.includes('主版本')));

  const spec = protocol.paramSpecFromDict({ id: 'q', type: 'int', label: '质量', default: 80, min: 1, max: 100 });
  check('ParamSpec 默认值生效', protocol.effectiveDefault(spec) === 80);
  check('when.to 过滤生效', protocol.paramVisibleFor(protocol.paramSpecFromDict({ id: 'w', type: 'int', when: { to: ['gif'] } }), 'convert', 'png', 'gif') === true);
  check('when.to 反向过滤生效', protocol.paramVisibleFor(protocol.paramSpecFromDict({ id: 'w', type: 'int', when: { to: ['gif'] } }), 'convert', 'png', 'webp') === false);

  check('NDJSON 解析合法行', protocol.parseEventLine('{"type":"log","message":"hi"}') !== null);
  check('NDJSON 忽略非 JSON 行', protocol.parseEventLine('Traceback (most recent call last):') === null);
  check('终态事件识别', protocol.isTerminal({ type: 'result' }) && protocol.isTerminal({ type: 'error' }) && !protocol.isTerminal({ type: 'log' }));

  /* ---------------------------------------------------------- 注册表与探测 */
  section('【2】内核发现与探测');
  const stateDir = resolveStateDir();
  const settings = new Settings(stateDir);
  const hubRoot = detectHubRoot(settings.get('hubRoot', ''));
  check('定位到 CKP 工作区', fs.existsSync(path.join(hubRoot, 'plugins')), hubRoot);

  // 产物目录放在本应用目录下：一是方便查看，二是避免某些引擎在用户目录下写文件受限
  const outDir = path.join(__dirname, '..', '.smoke-out');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const registry = new Registry({
    hubRoot,
    extraPluginDirs: settings.get('extraPluginDirs', []),
    disabledKernels: settings.get('disabledKernels', []),
    priorityOverrides: settings.get('priorityOverrides', {}),
  });
  const t0 = Date.now();
  registry.discover();
  const scanMs = Date.now() - t0;
  if (!quiet) console.log(`    扫描 ${registry.entries.size} 个内核，耗时 ${scanMs} ms，可用 ${registry.readyEntries().length} 个`);

  check('发现至少 15 个内核', registry.entries.size >= 15, `实际 ${registry.entries.size}`);
  check('至少 5 个内核可用', registry.readyEntries().length >= 5, `实际 ${registry.readyEntries().length}`);
  check('可用内核均非 invalid', registry.allEntries().every((e) => e.status !== 'invalid' || e.manifest.id.startsWith('invalid.')));
  check('汇总里 ready 与列表一致', registry.summary().ready === registry.readyEntries().length);

  const ops = registry.ops();
  check('至少暴露 convert 操作', ops.includes('convert'), ops.join(','));

  if (registry.get('pillow-image')) {
    const e = registry.get('pillow-image');
    check('pillow-image 可用', e.usable, e.detail);
    check('pillow-image 能力数 > 100', e.capabilityCount > 100, String(e.capabilityCount));
  }
  if (registry.get('ffmpeg-media')) {
    const e = registry.get('ffmpeg-media');
    check('ffmpeg-media 可用（bundled 二进制解析成功）', e.usable, e.detail);
  }

  /* ------------------------------------------------------------ 计划与选核 */
  section('【3】计划 / 选核 / 参数');
  const hub = new Hub(() => ({ registry, settings }));
  const fixtureDir = path.join(stateDir, 'fixtures');
  const files = makeFixtures(fixtureDir, { hubRoot, python: registry.python });
  const byName = (suffix) => files.find((f) => f.endsWith(suffix));
  const png = byName('.png');
  const csv = byName('.csv');
  const svg = byName('.svg');

  const targets = hub.targets(png, 'convert');
  check('PNG 的候选目标格式 > 10', targets.targets.length > 10, String(targets.targets.length));
  check('PNG 可转 webp', targets.targets.includes('webp'));

  const paramsOut = registry.paramSpecsFor('convert', 'png', 'webp');
  check('参数面板有内容', paramsOut.specs.length > 0, String(paramsOut.specs.length));
  check('参数含 quality', paramsOut.specs.some((s) => s.id === 'quality'));

  const cands = registry.candidates('convert', 'png', 'jpg');
  check('PNG→JPG 有候选内核', cands.length > 0);
  const chosen = registry.resolve('convert', 'png', 'jpg');
  check('选核返回内核与能力', Boolean(chosen.entry && chosen.cap));
  if (cands.length > 1 && !quiet) {
    console.log(`    候选顺序：${cands.slice(0, 4).map((c) => `${c.entry.id}(q${c.cap.quality}/p${c.entry.manifest.priority})`).join(' → ')}`);
  }
  check(
    '候选按 quality/priority 排序',
    cands.every((c, i) => i === 0 || cands[i - 1].cap.quality > c.cap.quality ||
      (cands[i - 1].cap.quality === c.cap.quality && cands[i - 1].entry.manifest.priority >= c.entry.manifest.priority))
  );

  let unsupported = '';
  try {
    registry.resolve('convert', 'png', 'unlikely-format-xyz');
  } catch (err) {
    unsupported = err.message;
  }
  check('不支持的格式抛出可读错误', /没有内核能完成/.test(unsupported) || /不支持/.test(unsupported), unsupported);

  const prev = hub.preview({ sources: [png], op: 'convert', targetFormat: 'jpg', params: { quality: 80 } });
  check('预览返回输出路径', prev.ok && prev.outputs.length === 1, JSON.stringify(prev));

  /* -------------------------------------------------------------- 真实转换 */
  section('【4】真实转换（逐内核族）');

  const queue = new JobQueue(hub);
  queue.setParallel(3);
  const jobsById = new Map();

  const enqueueCases = [
    { file: png, target: 'jpg', op: 'convert' },
    { file: png, target: 'bmp', op: 'convert' },
    { file: png, target: 'webp', op: 'convert' },
    { file: png, target: 'pdf', op: 'convert' },
    { file: csv, target: 'json', op: 'convert' },
    { file: csv, target: 'markdown', op: 'convert' },
    { file: csv, target: 'html', op: 'convert' },
    { file: svg, target: 'png', op: 'convert' },
    { file: byName('.txt'), target: 'html', op: 'convert' },
  ];
  if (registry.get('windows-wic') && registry.get('windows-wic').usable) {
    enqueueCases.push({ file: byName('.bmp'), target: 'png', op: 'convert' });
  }
  if (registry.get('stdlib-image') && registry.get('stdlib-image').usable) {
    enqueueCases.push({ file: byName('.ppm'), target: 'png', op: 'convert' });
  }

  const allJobs = [];
  for (const c of enqueueCases) {
    if (!c.file) continue;
    const jobs = queue.enqueue({ sources: [c.file], op: c.op, targetFormat: c.target, outDir });
    for (const j of jobs) jobsById.set(j.id, c);
    allJobs.push(...jobs);
  }
  check('作业全部入队', allJobs.length === enqueueCases.length, `${allJobs.length}/${enqueueCases.length}`);

  await new Promise((resolve) => {
    if (allJobs.every((j) => j.state === 'done' || j.state === 'failed' || j.state === 'cancelled')) return resolve();
    queue.once('queue', () => {
      if (allJobs.every((j) => j.state === 'done' || j.state === 'failed' || j.state === 'cancelled')) resolve();
    });
    const iv = setInterval(() => {
      if (allJobs.every((j) => ['done', 'failed', 'cancelled'].includes(j.state))) {
        clearInterval(iv);
        resolve();
      }
    }, 200);
  });

  for (const job of allJobs) {
    const c = jobsById.get(job.id);
    const label = `${c.file.split('.').pop()} → ${c.target}`;
    if (job.state === 'done') {
      const size = job.bytes || safeSize(job.output);
      check(`${label}（${job.kernelUsed}）`, Boolean(size) && size > 0, `产物 ${job.output} 大小 ${size}`);
    } else {
      check(`${label}`, false, `[${job.error && job.error.code}] ${job.progressMessage}`);
    }
  }

  /* ------------------------------------------------- x-cli 命令行内核路径 */
  section('【5】x-cli 命令行内核（FFmpeg）');
  const ff = registry.get('ffmpeg-media');
  if (ff && ff.usable) {
    const exe = resolveExecutable('ffmpeg', (ff.manifest.xCli.executables || {}).ffmpeg, { hubRoot, sysPath: registry.sysPath }).path;
    const mp4 = path.join(outDir, 'source.mp4');
    try {
      // 带音轨的测试视频：视频用 testsrc，音频用正弦波，这样「抽取音轨」也有内容可抽
      execFileSync(
        exe,
        [
          '-y', '-hide_banner', '-loglevel', 'error',
          '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15',
          '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
          '-t', '2', '-pix_fmt', 'yuv420p',
          '-c:v', 'libx264', '-c:a', 'aac', '-shortest', mp4,
        ],
        { timeout: 120000, windowsHide: true, stdio: 'ignore' }
      );
      check('用 ffmpeg 生成测试视频', fs.existsSync(mp4) && fs.statSync(mp4).size > 0);
    } catch (err) {
      check('用 ffmpeg 生成测试视频', false, String(err.message || err));
    }

    if (fs.existsSync(mp4)) {
      const q2 = new JobQueue(hub);
      q2.setParallel(1);
      const gifJobs = q2.enqueue({ sources: [mp4], op: 'convert', targetFormat: 'gif', params: { fps: 8, gif_width: 240 }, outDir });
      const mp3Jobs = q2.enqueue({ sources: [mp4], op: 'extract', targetFormat: 'mp3', outDir });
      const frameJobs = q2.enqueue({ sources: [mp4], op: 'extract', targetFormat: 'png', params: { fps: 1 }, outDir });
      const all = [...gifJobs, ...mp3Jobs, ...frameJobs];
      await new Promise((resolve) => {
        const iv = setInterval(() => {
          if (all.every((j) => ['done', 'failed', 'cancelled'].includes(j.state))) {
            clearInterval(iv);
            resolve();
          }
        }, 200);
      });
      for (const job of all) {
        const label = `${job.sourceFormat} → ${job.targetFormat}（${job.op}）`;
        if (job.state === 'done') {
          const outs = job.artifacts && job.artifacts.length ? job.artifacts : [{ path: job.output }];
          const total = outs.reduce((n, o) => n + (safeSize(o.path) || 0), 0);
          check(`${label}`, total > 0, `产物 ${outs.length} 个，合计 ${total} 字节`);
        } else {
          check(`${label}`, false, `[${job.error && job.error.code}] ${job.progressMessage}`);
        }
      }

      const dryPlan = hub.preview({ sources: [mp4], op: 'convert', targetFormat: 'gif', params: { fps: 8 } });
      check('x-cli 预览给出真实引擎 argv', Array.isArray(dryPlan.argv) && dryPlan.argv.length > 3, JSON.stringify(dryPlan.argv));
      check('x-cli 预览同时给出适配器 argv', Array.isArray(dryPlan.adapterArgv) && dryPlan.adapterArgv.includes('--ckp-job'));
      if (dryPlan.argv && !quiet) console.log(`    argv: ${dryPlan.argv.slice(0, 6).join(' ')} …`);
    }
  } else {
    check('ffmpeg-media 可用', false, ff ? ff.detail : '未发现');
  }

  /* ------------------------------------------------------------ 失败与取消 */
  section('【6】错误路径 / 取消 / 并发');
  const missing = await hub.convert({ sources: [path.join(outDir, 'does-not-exist.png')], op: 'convert', targetFormat: 'jpg' });
  check('输入不存在 → INPUT_NOT_FOUND', !missing.ok && missing.error.code === 'INPUT_NOT_FOUND', JSON.stringify(missing.error));

  const badFmt = await hub.convert({ sources: [png], op: 'convert', targetFormat: 'zzz-not-real' });
  check('目标格式不支持 → UNSUPPORTED_FORMAT', !badFmt.ok && badFmt.error.code === 'UNSUPPORTED_FORMAT', JSON.stringify(badFmt.error));

  const q3 = new JobQueue(hub);
  q3.setParallel(1);
  const slow = q3.enqueue({ sources: [png, png, png, png], op: 'convert', targetFormat: 'webp', outDir, params: {} });
  const before = q3.counts();
  check('并发受限：同一时刻仅 1 个 running', before.running <= 1, JSON.stringify(before));
  q3.cancelAll();
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const after = q3.counts();
  check('取消后无 running 作业', after.running === 0, JSON.stringify(after));
  check('取消的作业状态被正确标记', q3.list().every((j) => j.state === 'cancelled' || j.state === 'done' || j.state === 'queued'));
  void slow;

  /* ------------------------------------------------------------------ 汇总 */
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n${'─'.repeat(64)}`);
  console.log(`冒烟测试：通过 ${passed} / 共 ${results.length}${failed ? `，失败 ${failed}` : ''}`);
  if (failed) {
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✕ ${r.name}  ${r.detail}`);
  }
  console.log(`产物目录：${outDir}`);
  return failed ? 1 : 0;
}

function safeSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[smoke] 异常:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
