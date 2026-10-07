# 架构说明

本文说明 KernelHub Studio 的三层结构、CKP 协议在 Node 侧的落点，以及几个刻意的设计取舍。

---

## 1. 分层

```
渲染进程（Renderer）   —— 只管画界面，没有 Node 能力
      │  window.khs（contextBridge 白名单）
主进程（Main）         —— 窗口、IPC、事件广播、原生对话框
      │  require
内核中枢（Engine）     —— 纯 Node，可脱离 Electron 单独运行
      │  spawn + NDJSON
内核（Kernel）         —— 独立进程，语言无关
```

**为什么把 Engine 与 Electron 解耦？**
因为「选核、探测、跑内核、解析事件」这些逻辑与界面无关，也不应该依赖 Electron。
现在 `tools/probe.js` / `tools/smoke.js` 可以直接 `require` 中枢在控制台跑真实转换，
`tools/devserver.js` 可以把界面跑在系统浏览器里而中枢照旧 —— 同一份代码，三种宿主。

---

## 2. 内核中枢（src/engine）

| 模块 | 职责 | 对应 Python 宿主 |
|---|---|---|
| `shared/protocol.js` | 格式归一化与别名族、参数声明、能力声明、清单/任务校验、事件模型、错误码、状态机 | `protocol.py` |
| `engine/registry.js` | 扫描插件目录 → 校验清单 → 探测引擎 → 建能力索引 → 选核 | `registry.py` |
| `engine/runner.js` | 展开 argv/env、落盘任务、读 NDJSON、超时/取消/产物校验 | `runner.py` + `jobs.py` |
| `engine/cliBridge.js` | `x-cli` 模板 → 真实 argv（占位符展开） | `cli_bridge.py` |
| `engine/executables.js` | `{exe:名字}` 与 `ckp-executable` 探测共用同一套解析 | `executables.py` |
| `engine/hub.js` | 计划、参数求解、命令预览、单次转换编排 | `jobs.py` |
| `engine/queue.js` | 并发队列、取消、重试、事件广播（Electron 侧独有） | Tkinter 里的线程 + Queue |
| `engine/catalog.js` | 给 UI 用的视图数据（内核卡片、操作目录、格式目录、状态台账） | `gui.py` 里的展示逻辑 |
| `engine/config.js` | 用户配置（字段名与 `~/.kernelhub/config.json` 对齐） | `paths.load_config` |
| `engine/python.js` | Python 解释器解析、模块探测（带缓存） | `paths.python_executable` + `find_spec` |

### 选核算法（协议第 10 节）

```
候选 = 所有 ready 内核中 op 匹配、from 覆盖源格式、to 覆盖目标格式的能力
排序 = -quality → -priority → -specificity → id
```

* `quality`：能力声明里的质量分（如 Pillow 位图互转 20，WIC 兜底 0）
* `priority`：内核清单里的 `priority`（用户可在界面上覆盖，立即影响结果）
* `specificity`：非通配的 from/to 各加 1 分（`png → jpg` 比 `* → jpg` 更具体）

界面上「将使用：xxx」旁边会列出全部候选，并给出排序依据，方便解释「为什么不是另一个内核」。

### 探测（probe）

内核清单里的 `probe` 决定「怎么确认引擎在不在」：

| probe.type | 含义 | 失败时状态 |
|---|---|---|
| `none` | 只检查 `runtime.requires` 依赖或适配器入口 | `degraded` / `invalid` |
| `python-import` | 子进程里 `importlib.util.find_spec(target)` | `degraded` |
| `command` | PATH 查找 + 可选执行 `args` 并匹配 `expect` | `unavailable` |
| `ckp-executable` | 用**与运行期完全相同**的 `x-cli.executables` 解析逻辑 | `unavailable` |
| `file` | 检查文件/目录是否存在 | `unavailable` |

`ckp-executable` 的意义：它保证「探测说可用」和「真的能跑起来」用的是同一段解析代码，
不会出现「界面说可用，一转换就找不到 exe」。

探测结果按 `内核 id + 清单 mtime` 缓存，避免每次刷新都拉起十几个子进程；
但「停用后再启用」会强制重新探测，不吃旧缓存。

### 运行期契约

1. 任务落盘到 `<hub>/.cache/runs/job-<时间戳>-<pid>-<随机>.json`（与 Python 宿主共用目录，便于对照调试）
2. 按 `runtime.type` 组装 argv，末尾追加 `--ckp-job <路径>`
3. 注入环境变量（见 README 的「内核进程契约」）
4. stdout 按行流式解析 NDJSON；stderr 全程收集，失败时截尾附在错误详情里
5. 终态只有一个：第一个 `result` 或 `error`；重复终态忽略
6. 产物二次校验：`result.outputs` 里的每个路径必须存在且非空（0 字节视为失败）
7. `output_mode: glob`（例如 FFmpeg 抽帧 `%04d.png`）：命令只给出模板，宿主按 `output_glob` 收集真正落盘的文件

**一个容易踩的坑（本项目已修正）**：`x-cli` 内核**不是**直接执行展开后的引擎命令，
而是执行适配器（`adapter.py`），由适配器内部再展开命令。
如果宿主直接执行引擎命令，stdout 里就不会有 NDJSON 终态事件，任务会以
`PROTOCOL_NO_TERMINAL_EVENT` 失败。因此：

* **执行**：永远 `buildArgv(entry, jobPath)` → 适配器
* **展示**：`cliBridge.buildPlan()` 展开引擎命令，只用于「真实命令行预览」

---

## 3. 主进程（src/main）

* `main.js`
  * 单实例锁；无边框窗口；原生深色主题
  * 组装中枢（Registry / Hub / JobQueue），把队列事件转发给渲染进程
  * IPC 通道分组：`app:*` `settings:*` `kernels:*` `plan:*` `queue:*` `fs:*` `logs:*` `doctor` `protocol:*` `win:*`
  * 外链一律交给系统浏览器；`will-navigate` 拦截外部跳转
  * 原生菜单（文件/视图/帮助）把命令以 `cmd` 事件推给界面
* `preload.js`
  * 只暴露一份显式白名单 API（`window.khs`），渲染进程拿不到 `require`/`process`
  * 事件通道固定为 9 个 `evt:*` / `cmd`，订阅返回取消订阅函数

### 事件流

```
内核进程 stdout(NDJSON)
   │
engine/runner.js  ——逐行解析——▶  hub.convert({onEvent,onLog,onProgress})
   │                                      │
engine/queue.js   ——作业状态机——▶  EventEmitter
   │                                      │
main.js           ——webContents.send——▶  evt:job:update / evt:job:log / evt:queue / …
   │                                      │
renderer          ——store 订阅——▶  进度条、队列行、日志面板
```

界面从不轮询：队列状态完全由事件推动；`evt:queue` 是全量快照（用于重排/筛选），
`evt:job:update` 是单个作业的增量更新（避免整表重建导致闪烁与滚动位置丢失）。

---

## 4. 渲染进程（src/renderer）

* 零依赖：没有 React/Vue/Tailwind，没有构建步骤，没有网络请求
* `location.hash` 路由 + 动态 `import()` 懒加载视图
* 参数控件工厂（`js/controls.js`）把 `ParamSpec` 映射成控件：

| ParamSpec.type | 控件 |
|---|---|
| `int` / `float` | 数字输入（有 min/max 时配滑块） |
| `bool` | 开关 |
| `string` | 文本框 |
| `enum` | 自定义下拉（显示 label，提交 value） |
| `path` | 只读输入 + 浏览按钮（文件/目录） |
| `color` | 颜色选择器 + 十六进制输入 |

视图里**不允许出现任何格式名/内核名/参数名**：操作来自 `kernels.ops()`，
目标格式来自 `plan.targets()`，控件来自 `plan.params()`，内核信息来自 `kernels.list()`。

---

## 5. 开发宿主（tools/devserver.js）

一套把界面跑在系统 Chrome 里的开发/验收宿主：

```
Chromium(页面)  ──WebSocket(/bridge)──▶  devserver.js  ──require──▶  src/engine/*
```

* 页面侧：`src/renderer/devhost/khs-browser.js` 用 WebSocket 实现与 preload **完全相同**的 API 契约
* 宿主侧：一张 `通道 → 处理函数` 表，与 `main.js` 的 IPC 处理逻辑一一对应
* `devhost.html` 由 `index.html` 现场派生：放开 `connect-src` + 注入 shim，生产文件零改动

用途：在没有 Electron GUI 的环境（CI、受限沙箱）里也能对真实数据的界面做端到端验收与截图。

---

## 6. 配置与状态

| 内容 | 位置 |
|---|---|
| 用户配置 | `%APPDATA%/kernelhub-studio/config.json`（Linux: `~/.config/kernelhub-studio/`） |
| 任务落盘 | `<hub>/.cache/runs/*.json` |
| 示例素材 | `%APPDATA%/kernelhub-studio/fixtures/` |
| 验收产物 | `<项目>/.smoke-out/`、`<项目>/.ui-out/` |
| 界面截图 | `docs/screenshots/` |

配置字段刻意与 `~/.kernelhub/config.json` 同名（`disabled_kernels` → `disabledKernels` 除外，采用 JS 命名），
便于在两个宿主之间迁移「哪些内核被停用」「优先级覆盖」这类用户决策。

---

## 7. 已知取舍

1. **探测要拉子进程**：`python-import` / `python` 可执行文件解析需要跑 Python。首次扫描约 2 秒（19 个内核）。
   已用「按 id+mtime 缓存」把重复扫描压到毫秒级，并提供强制刷新。
2. **没有实现 `runtime.type = builtin`**：协议预留了宿主内置适配器（Python 侧有 `kernelhub.builtins.*`）。
   Node 宿主目前遇到 `builtin` 会去调 Python 宿主的内置模块 —— 语义上正确，但等于复用原实现。
3. **`x-cli` 的 `output_mode: stdout`**：由适配器负责落盘，宿主只校验产物，不再额外接管管道。
4. **沙箱限制**：某些环境里 `ffmpeg` 写不进用户目录（`Permission denied`），
   因此自检把产物目录放在项目内 `.smoke-out/`，避开这条坑。
