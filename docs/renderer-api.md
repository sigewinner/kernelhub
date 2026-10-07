# KernelHub Studio · 渲染进程 API 契约（window.khs）

> 由主进程 `src/main/preload.js` 通过 `contextBridge` 暴露。渲染进程 **没有** Node 能力，
> 一切磁盘/进程操作都必须经此契约。所有方法返回 Promise。

## 应用 / 环境

| 调用 | 返回 |
| --- | --- |
| `khs.app.info()` | `{ name, version, ckp, electron, node, chrome, platform, arch, dev, stateDir }` |
| `khs.app.layout()` | `{ hubRoot, pluginsDir, vendorDir, schemaDir, runDir, searchPaths[], python, pythonVersion, sysPath[] }` |
| `khs.settings.get()` | `{ version, hubRoot, extraPluginDirs[], disabledKernels[], priorityOverrides{}, lastOutputDir, lastInputDir, locale, theme, timeoutMs, maxParallel, defaultOp, autoScan, keepLogLines, seenWelcome }` |
| `khs.settings.set(patch)` | 合并后的完整设置 |

## 内核 / registry

| 调用 | 返回 |
| --- | --- |
| `khs.kernels.list()` | `{ kernels: Kernel[], summary: { total, ready, byStatus, ops[], errors[] }, layout }` |
| `khs.kernels.refresh()` | 同 `list()`（重新扫描并重新探测） |
| `khs.kernels.detail(id)` | `{ ok, kernel: Kernel & { manifest, manifestPath, directory, probe, hooks, params } }` |
| `khs.kernels.setEnabled(id, bool)` | `{ ok, kernel }` |
| `khs.kernels.setPriority(id, number)` | `{ ok }` |
| `khs.kernels.status()` | `{ total, ready, byStatus: [{ status, label, count, kernels: [{ id, name, detail, installHint }] }], errors[], searchPaths[] }` |
| `khs.kernels.ops()` | `[{ op, label, icon, description, from[], to[], kernels[], kernelCount }]` |
| `khs.kernels.formats()` | `[{ format, asInput[], asOutput[], kernelCount, kernels[] }]` |
| `khs.kernels.openDir(id)` | `{ ok }` |

### Kernel 形状（UI 常用字段）

```jsonc
{
  "id": "pillow-image",
  "name": "Pillow 图像内核",
  "version": "1.2.0",
  "description": "…",
  "kind": "image", "kindLabel": "图像",
  "status": "ready",           // ready | degraded | invalid | unavailable | disabled
  "statusLabel": "可用",
  "ready": true,
  "detail": "…", "engineNote": "Pillow 12.3.0",
  "homepage": "…", "license": "MIT", "priority": 70, "tags": ["…"],
  "runtimeType": "python", "requires": [],
  "directory": "D:\\…\\kernel-hub\\plugins\\pillow-image",
  "entryPath": "…\\adapter.py",
  "installHint": "python tools/pip_bootstrap.py install …",
  "capabilityCount": 420,
  "capabilities": [
    { "id": "image.convert", "op": "convert", "opLabel": "格式转换", "label": "位图互转",
      "from": ["png","jpg"], "to": ["webp"], "multi_in": false, "multi_out": false,
      "quality": 60, "output_mode": "exact" }
  ],
  "capabilityMatrix": [{ "id","op","label","from[]","to[]","pairs","multi_in","multi_out","output_mode","quality" }],
  "ops": ["convert","extract"],
  "formats": { "from": ["…"], "to": ["…"] },
  "inputFormats": ["…"], "outputFormats": ["…"],
  "params": [{ "id","type","label","description","default","min","max","step","enum":[{value,label}],"advanced","applies_to","when" }],
  "paramCount": 12,
  "executableSpec": { "ffmpeg": "PATH: ffmpeg/ffmpeg.exe；Python: imageio_ffmpeg:get_ffmpeg_exe" },
  "engine": { "type": "python", "entry": "adapter.py", "requires": [], "note": "…", "executables": {} },
  "probe": { "type": "ckp-executable", "target": "ffmpeg" },
  "descriptions": { "op": [{ "op": "convert", "label": "格式转换", "icon": "⇄" }] },
  "xCli": true,
  "builtin": false
}
```

## 计划（选核 / 参数 / 预览）

| 调用 | 参数 | 返回 |
| --- | --- | --- |
| `khs.plan.targets(p)` | `{ sourcePath, op?, kernelId? }` | `{ sourceFormat, targets: string[] }` |
| `khs.plan.params(p)` | `{ op, srcFmt?, dstFmt?, kernelId?, sources? }` | `{ op, srcFmt, dstFmt, kernel: { id, name, engineNote } \| null, params: ParamSpec[] }` |
| `khs.plan.candidates(p)` | `{ op, srcFmt?, dstFmt, sources? }` | `{ candidates: [{ id, name, kind, quality, priority, matched }], chosen: { id, name, engineNote, reason } \| { error, detail } }` |
| `khs.plan.preview(req)` | `{ sources: string[], op, targetFormat, params, kernelId?, outDir?, sameDir? }` | `{ ok, kernel: { id, name, engineNote, xCli }, outputs[], sourceFormat, adapterArgv: string[] (宿主启动适配器的命令), argv: string[] \| null (x-cli 展开后的引擎命令，自带适配器的内核为 null), note, job }` 或 `{ ok:false, code, message, detail }` |

`ParamSpec` 的 `type` ∈ `int | float | bool | string | enum | path | color`。
`when` 形如 `{ "to": ["gif"], "from": [...], "op": [...] }`，`applies_to: ["transform"]`。
**参数控件完全由 `type` 决定**，UI 里不允许出现任何格式名/参数名的硬编码。

宿主还会在每条 param 上附带可见性结论（因为协议里的通配符 `*` 与格式族 `jpeg/jpg`、`tif/tiff`
的匹配语义只有宿主实现，界面不应重复实现）：

| 字段 | 含义 |
| --- | --- |
| `visible` | 该参数在当前 `(op, srcFmt, dstFmt)` 下是否应显示（宿主算好的权威结论） |
| `visibleFrom` / `visibleTo` | `when.from` / `when.to` 中与当前条件「同一格式族」的标签集合 |
| `ops` | `when.op` 展开后的操作集合 |
| `appliesTo` | `applies_to` 展开后的操作集合 |

界面判断顺序：有 `visible` 就以它为准（集合包含判断），否则回落到本地精确字符串比较。

`plan.params` 的返回里还有 `fallback: true` 字段：表示**当前还没有添加文件**，
这份参数是按「该操作下的代表性内核」给出的示例，加入文件后会按真实源格式重新选核。
`plan.targets` 同理：`{ sourcePath }` 为空时返回 `{ sourceFormat: '', targets: [...], fallback: true }`。

## 队列

| 调用 | 说明 |
| --- | --- |
| `khs.queue.enqueue(req)` | `req = { sources: string[], op, targetFormat, outDir?, sameDir?, params, kernelId?, timeoutMs? }` → `{ jobs: Job[], counts }` |
| `khs.queue.list()` | `{ jobs: Job[], counts, paused }` |
| `khs.queue.cancel(id)` / `cancelAll()` / `pause()` / `resume()` | 控制 |
| `khs.queue.remove(id)` / `clear(finishedOnly = true)` / `retry(id)` / `retryFailed()` | 维护 |
| `khs.queue.setParallel(n)` | `{ ok, parallel }`（1–8） |
| `khs.queue.jobLogs(id)` | `{ logs: [{ at, level, message }] }` |

```jsonc
// Job
{
  "id": "jli3x9f1", "source": "D:\\a.png", "sourceName": "a.png",
  "sourceFormat": "png", "sourceBytes": 1024, "sourceSize": "1.00 KB",
  "output": "D:\\out\\a.webp", "outputName": "a.webp",
  "op": "convert", "targetFormat": "webp",
  "state": "queued",   // queued | running | done | failed | cancelled
  "progress": 0.42, "progressMessage": "编码中…",
  "kernelUsed": "pillow-image", "kernelName": "Pillow 图像内核",
  "durationMs": 812, "bytes": 2048, "size": "2.00 KB",
  "error": { "code": "…", "message": "…", "detail": "…", "retryable": true } | null,
  "addedAt": 0, "startedAt": 0, "finishedAt": 0,
  "artifacts": [{ "path": "…", "format": "webp", "bytes": 2048 }],
  "params": {}, "logCount": 3
}
```

## 文件系统

| 调用 | 返回 |
| --- | --- |
| `khs.fs.pickFiles({ title?, filters? })` | `{ files: FileInfo[] }` |
| `khs.fs.pickFolder({ title?, defaultPath? })` | `{ folder }` |
| `khs.fs.describe(paths)` | `{ files: FileInfo[] }` |
| `khs.fs.expand(paths)` | `{ files: FileInfo[] }`（目录会被递归展开） |
| `khs.fs.openPath(p)` | `{ ok }`（目录用资源管理器打开，文件在资源管理器中定位） |
| `khs.fs.openExternal(url)` | `{ ok }` |
| `khs.fs.exists(p)` | `{ exists }` |
| `khs.fs.readImage(p)` | `{ ok, dataUrl, mime }`（≤24MB，用于缩略图预览） |
| `khs.fs.revealOutput(p)` | `{ ok }` |
| `khs.fs.pathForFile(file)` | **同步**返回拖拽 File 的磁盘路径；拿不到返回 `''`（Electron 32 起 `File.path` 被移除，这里用 preload 里的 `webUtils.getPathForFile`） |

```jsonc
// FileInfo
{ "path": "…", "name": "a.png", "dir": "…", "ext": "png", "format": "png",
  "bytes": 1024, "size": "1.00 KB", "mtime": 0, "isDir": false }
```

## 日志 / 自检 / 协议

| 调用 | 返回 |
| --- | --- |
| `khs.logs.list()` | `{ logs: [{ at, level, message }] }` |
| `khs.logs.clear()` | `{ ok }` |
| `khs.doctor()` | `{ protocol, node, electron, chrome, platform, layout, settings, registry, kernels: [{ id, name, status, statusLabel, detail, engineNote, capabilities, ops[], license, homepage, installHint, runtimeType, requires[] }] }` |
| `khs.protocol.doc()` | `{ ok, path, markdown }`（kernel-hub/PROTOCOL.md 原文） |
| `khs.protocol.schemas()` | `[{ name, path, text }]`（三份 JSON Schema 原文） |

## 窗口

`khs.win.minimize() / toggleMaximize() / close() / state() / openConsole()`

## 事件

```js
const off = khs.on('evt:job:update', (job) => { … });
off(); // 取消订阅
```

| 通道 | 载荷 |
| --- | --- |
| `evt:job:log` | `{ jobId, at, level: 'debug'\|'info'\|'warn'\|'error', message }` |
| `evt:job:update` | `Job` |
| `evt:job:finish` | `{ job, outcome: { ok, kernel, kernelName, duration_ms, outputs, error, exit_code, command, stderr } }` |
| `evt:queue` | `Job[]`（任意队列变化后的全量快照） |
| `evt:queue:enqueue` | `Job[]`（新入队的作业） |
| `evt:queue:idle` | `{ queued, running, done, failed, cancelled, total }` |
| `evt:log` | `{ at, level, message }`（主进程日志） |
| `evt:window` | `{ maximized }` |
| `cmd` | `'pick-files' \| 'pick-folder' \| 'refresh' \| 'protocol'`（来自原生菜单） |
