# CKP · 转换内核协议 v1.0

**CKP**（**C**onversion **K**ernel **P**rotocol）是一套把「文件格式转换能力」标准化成**可插拔内核**的独立协议。
任何程序——Python 库、命令行工具、PowerShell 脚本、甚至远程服务——只要实现本协议，就能被宿主
（图形化工具 / CLI）自动发现、校验、调度，无需修改宿主一行代码。

本协议与具体语言、具体工具、具体 GUI 框架**完全解耦**。宿主和内核只通过两个东西对话：

1. **清单文件** `kernel.json`（声明「我能做什么」）
2. **NDJSON 事件流**（声明「我正在做什么、结果是什么」）

---

## 目录

1. [术语](#1-术语)
2. [体系结构](#2-体系结构)
3. [插件目录布局](#3-插件目录布局)
4. [清单文件 kernel.json](#4-清单文件-kerneljson)
5. [能力矩阵 Capability](#5-能力矩阵-capability)
6. [参数声明 Param](#6-参数声明-param)
7. [任务 Job](#7-任务-job)
8. [事件流 Event](#8-事件流-event)
9. [调用握手（进程级契约）](#9-调用握手进程级契约)
10. [内核选择算法](#10-内核选择算法)
11. [格式规范与别名](#11-格式规范与别名)
12. [错误模型](#12-错误模型)
13. [可用性探测与生命周期钩子](#13-可用性探测与生命周期钩子)
14. [版本兼容规则](#14-版本兼容规则)
15. [安全边界](#15-安全边界)
16. [扩展点](#16-扩展点)

---

## 1. 术语

| 术语 | 英文 | 含义 |
|---|---|---|
| 宿主 | Host | 调用方。本项目里指 GUI / CLI / 任何遵守本协议的调用程序 |
| 内核 | Kernel | 转换能力的提供方，最小可插拔单元 |
| 适配器 | Adapter | 内核目录内的可执行入口，负责说协议。它可以包裹任意底层引擎 |
| 引擎 | Engine | 适配器背后真正干活的库/程序（Pillow、ImageMagick、FFmpeg…） |
| 清单 | Manifest | `kernel.json`，内核的自我描述 |
| 能力 | Capability | 一条「某格式 → 某格式」的可执行声明 |
| 任务 | Job | 宿主发给内核的一次工作请求 |
| 事件 | Event | 内核向宿主单向流式上报的 NDJSON 行 |
| 制品 | Artifact | 任务产生的输出文件 |

**关键约定：宿主永远不直接调用引擎，只调用适配器。** 引擎换了、升级了、换成别的实现了，
只要适配器仍然说协议，宿主就无感。这是「内核即插件」的根本保证。

---

## 2. 体系结构

```
┌──────────────────────────── 宿主 Host ────────────────────────────┐
│                                                                    │
│   ┌──────────┐   ┌────────────┐   ┌──────────┐   ┌────────────┐   │
│   │  发现器   │──▶│  注册表     │──▶│ 选择器    │──▶│  运行器     │   │
│   │ Discovery│   │ Registry   │   │ Resolver │   │  Runner    │   │
│   └──────────┘   └────────────┘   └──────────┘   └─────┬──────┘   │
│        扫描           校验+索引         选内核            桥接        │
│     kernel.json     能力矩阵        按优先级/可用性        子进程      │
└────────────────────────────────────────────────────────┬───────────┘
                                                         │
              argv: --ckp-job <job.json>                 │  stdin/stdout
                                                         ▼
┌──────────────────────── 内核插件 Kernel ───────────────────────────┐
│  kernel.json   ──▶   adapter.(py|ps1|exe|js)   ──▶   Engine        │
│   自我描述             协议翻译层                   Pillow / IM /   │
│                                                      FFmpeg / …    │
└────────────────────────────────────────────────────────────────────┘
```

数据流：

```
宿主                                                          内核
 │  1. 生成 Job(JSON)                                          │
 │  2. spawn 适配器进程  ── argv --ckp-job job.json ──────────▶ │
 │                                                             │ 解析 Job
 │  ◀── {"type":"hello"} ───────────────────────────────────── │
 │  ◀── {"type":"log","message":"..."} ─────────────────────── │
 │  ◀── {"type":"progress","value":0.4} ────────────────────── │
 │  ◀── {"type":"artifact","path":"out.webp"} ──────────────── │
 │  ◀── {"type":"result","ok":true,...} ────────────────────── │
 │  3. 收到 result → 校验产物 → 收尾                            │ exit 0
```

---

## 3. 插件目录布局

宿主按固定规则扫描，**一个目录 = 一个内核**：

```
plugins/
├── pillow-image/                 ← 内核目录（目录名随意，但建议用 id）
│   ├── kernel.json               ← 必需：清单
│   ├── adapter.py                ← 必需：适配器入口（由清单 runtime.entry 指定）
│   ├── engine/                   ← 可选：内核自带的二进制/依赖
│   ├── README.md                 ← 可选
│   └── LICENSE                   ← 可选
├── imagemagick/
│   ├── kernel.json
│   └── adapter.py
└── windows-wic/
    ├── kernel.json
    └── adapter.ps1
```

扫描规则：

- 宿主在**搜索路径**下扫描**一级子目录**，查找 `kernel.json`。
- 搜索路径默认包含：`<项目根>/plugins/`、`<用户配置目录>/plugins/`、环境变量
  `CKP_PLUGIN_PATH` 中列出的路径（`;` 分隔）。
- 目录内可放任何附加文件（引擎二进制、图标、许可证），宿主不干涉。
- 若 `kernel.json` 解析失败或必填字段缺失，该内核进入 `invalid` 状态：**在 GUI 中可见并报错，但不参与任务分派**。
- 隐藏目录（`.` 开头）、`__pycache__`、`node_modules` 一律跳过。

---

## 4. 清单文件 `kernel.json`

UTF-8 编码的 JSON 对象。

### 4.1 字段总表

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `ckp` | string | ✅ | 协议版本，固定形如 `"1.0"`。**注意：是版本号，不是 `"ckp/1.0"`** |
| `id` | string | ✅ | 全局唯一标识。`^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$` |
| `name` | string | ✅ | 人类可读名称（可中文） |
| `version` | string | ✅ | 内核自身版本，建议 semver |
| `description` | string | ➖ | 一句话说明 |
| `kind` | string | ➖ | 分类：`image` / `document` / `media` / `archive` / `vector` / `data` / `other` |
| `runtime` | object | ✅ | 如何启动适配器，见 4.2 |
| `capabilities` | array | ✅ | 能力矩阵，至少 1 条，见第 5 节 |
| `params` | array | ➖ | 可选参数声明，用于 GUI 自动生成控件，见第 6 节 |
| `homepage` | string | ➖ | 项目主页 |
| `license` | string | ➖ | 许可证标识（如 `MIT`、`Apache-2.0`、`GPL-3.0`） |
| `priority` | integer | ➖ | 选择优先级，默认 `50`，越大越优先 |
| `tags` | array\<string\> | ➖ | 检索标签 |
| `icon` | string | ➖ | 相对内核目录的图标路径（PNG/SVG） |
| `probe` | object | ➖ | 可用性探测，见 13 |
| `hooks` | object | ➖ | `install` / `uninstall` 钩子，见 13 |
| `x-*` | any | ➖ | 自定义扩展字段，宿主必须忽略 |

### 4.2 `runtime` 对象

描述「怎么把这个适配器跑起来」。

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `type` | string | ✅ | `python` / `exec` / `powershell` / `node` / `builtin` |
| `entry` | string | ✅ | 相对内核目录的入口文件 |
| `args` | array\<string\> | ➖ | 追加在入口之后的固定参数 |
| `python` | string | ➖ | `auto`（默认，用宿主解释器）/ `vendor`（用宿主 vendor 目录）/ 绝对路径 |
| `requires` | array\<string\> | ➖ | Python 导入名，缺失则内核 `degraded` |
| `env` | object | ➖ | 追加环境变量 |
| `cwd` | string | ➖ | 工作目录，默认内核目录 |

**`type` 语义**

| 值 | 宿主行为 |
|---|---|
| `python` | 用 Python 解释器执行 `entry`，并按 `python` 字段决定用哪个解释器与 `sys.path` |
| `exec` | 直接执行 `entry`（可执行文件 / 带 shebang 脚本） |
| `powershell` | 用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <entry>` |
| `node` | 用 `node <entry>` |
| `builtin` | 宿主内置适配器（`entry` 为内置注册名），用于零依赖兜底 |

无论哪种 `type`，宿主**必须**在命令行末尾追加：

```
--ckp-job <任务JSON文件的绝对路径>
```

适配器**必须**接受该参数；若不支持，则应自行从 stdin 读取同一份 JSON（兼容模式）。

### 4.3 最小可用清单

```json
{
  "ckp": "1.0",
  "id": "my-kernel",
  "name": "我的内核",
  "version": "1.0.0",
  "runtime": { "type": "python", "entry": "adapter.py" },
  "capabilities": [
    { "op": "convert", "from": ["png"], "to": ["jpg"] }
  ]
}
```

---

## 5. 能力矩阵 `Capability`

每条能力是一句可执行的承诺：**「给我 `from` 里的格式，我能给你 `to` 里的格式」**。

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `op` | string | ✅ | 操作类型，开放词汇，见 5.1 |
| `from` | array\<string\> | ✅ | 接受的输入格式（小写、不含点）；`"*"` 表示任意 |
| `to` | array\<string\> | ✅ | 能产出的输出格式；`"*"` 表示任意 |
| `id` | string | ➖ | 能力标识，默认 `<op>:<from>-<to>` |
| `multi_in` | boolean | ➖ | 是否支持多输入合并（默认 `false`） |
| `multi_out` | boolean | ➖ | 是否支持一次产出多文件（默认 `false`） |
| `label` | string | ➖ | GUI 展示名 |
| `params` | array | ➖ | 仅对该能力生效的参数（与顶层 `params` 合并，局部优先） |
| `quality` | integer | ➖ | 同 op 内的偏好权重，默认 `0` |

### 5.1 `op` 开放词汇

协议**不封闭** `op` 取值，宿主对未知 `op` 必须原样索引、原样转发。推荐标准值：

| op | 方向 | 说明 |
|---|---|---|
| `convert` | 1 → 1 | 通用格式转换（最常用） |
| `transform` | 1 → 1 | 同格式内的变换（缩放、旋转、裁剪） |
| `optimize` | 1 → 1 | 同格式压缩优化（无损优先） |
| `merge` | N → 1 | 多文件合并 |
| `split` | 1 → N | 单文件拆分成多个 |
| `extract` | 1 → N | 抽取内容（PDF 抽图、视频抽帧、文档抽文本） |
| `render` | 1 → 1 | 渲染成位图（PDF→PNG、SVG→PNG） |
| `package` / `unpack` | N ↔ N | 归档/解包 |
| `inspect` | 1 → 0 | 只读取元信息，不产出文件 |

### 5.2 示例

```json
"capabilities": [
  {
    "op": "convert",
    "from": ["png","jpg","jpeg","bmp","gif","tif","tiff","webp","avif","ico","ppm","tga"],
    "to":   ["png","jpg","jpeg","bmp","gif","tif","tiff","webp","avif","ico","ppm","tga"],
    "multi_out": false
  },
  {
    "op": "transform",
    "from": ["*"],
    "to":   ["*"],
    "params": [
      { "id": "resize_w", "type": "int", "min": 1, "max": 20000 },
      { "id": "resize_h", "type": "int", "min": 1, "max": 20000 }
    ]
  }
]
```

---

## 6. 参数声明 `Param`

参数声明让**宿主自动生成 GUI 控件**，内核无需写任何界面代码。这是协议可扩展性的关键一环。

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 参数名，会作为 `job.params` 的键 |
| `type` | string | ✅ | `int` / `float` / `bool` / `string` / `enum` / `path` / `color` |
| `label` | string | ➖ | GUI 显示名 |
| `description` | string | ➖ | 提示文本 |
| `default` | any | ➖ | 默认值 |
| `min` / `max` | number | ➖ | `int`/`float` 的范围 |
| `step` | number | ➖ | 步进 |
| `enum` | array\<object\> | ➖ | `enum` 类型的取值：`[{"value":"a","label":"A"}]` |
| `advanced` | boolean | ➖ | 是否收进「高级」折叠区，默认 `false` |
| `applies_to` | array\<string\> | ➖ | 仅在这些 op 下显示 |
| `when` | object | ➖ | 条件显示：`{"to": ["jpg","webp"]}` / `{"from": ["png"]}` |
| `required` | boolean | ➖ | 是否必填，默认 `false` |

**参数合并规则**：命中能力的 `capability.params` 与清单顶层 `params` 按 `id` 合并，
**能力级覆盖顶层级**。宿主按 `when` 过滤后再渲染。

未知参数由宿主原样透传，内核可自行解释（前向兼容）。

---

## 7. 任务 `Job`

宿主写入临时文件、以 `--ckp-job <path>` 传给适配器的 JSON 对象。

```json
{
  "ckp": "1.0",
  "job_id": "0f2c9a7e-1b44-4b0a-9c2f-2a4d1e6f88ab",
  "kernel": "pillow-image",
  "op": "convert",
  "inputs": [
    { "path": "D:\\in\\a.png", "format": "png", "role": "primary", "bytes": 20480 }
  ],
  "outputs": [
    { "path": "D:\\out\\a.webp", "format": "webp" }
  ],
  "params": { "quality": 84, "strip_metadata": true },
  "workdir": "D:\\out",
  "limits": { "timeout_ms": 60000 },
  "context": { "source": "gui", "locale": "zh-CN", "overwrite": true }
}
```

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `ckp` | string | ✅ | 协议版本 |
| `job_id` | string | ✅ | 任务唯一标识，内核须在事件中原样回传 |
| `op` | string | ✅ | 操作类型 |
| `inputs` | array | ✅ | 输入文件，见 7.1 |
| `outputs` | array | ➖ | 期望输出；`inspect` 类 op 可为空 |
| `params` | object | ➖ | 参数键值对，默认 `{}` |
| `kernel` | string | ➖ | 宿主指定的内核 id（内核可忽略） |
| `workdir` | string | ➖ | 输出工作目录 |
| `limits.timeout_ms` | integer | ➖ | 内核应自我约束的软超时 |
| `context` | object | ➖ | 宿主上下文：`source` / `locale` / `overwrite` / 自定义 |

### 7.1 输入项 `InputRef`

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `path` | string | ✅ | 绝对路径 |
| `format` | string | ➖ | 格式标签（小写、无点）；缺省时内核自行嗅探 |
| `role` | string | ➖ | `primary` / `aux` / `mask` / …，默认 `primary` |
| `bytes` | integer | ➖ | 文件大小，供内核预估 |

### 7.2 输出项 `OutputRef`

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `path` | string | ✅ | 期望写出的绝对路径（含文件名） |
| `format` | string | ➖ | 目标格式；缺省时由扩展名推断 |

**约定**：内核**必须**把产物写进 `outputs[*].path`；若该路径为目录或未提供，
内核应在 `workdir` 下自行生成唯一文件名，并在 `artifact`/`result` 事件中报告真实路径。
宿主以事件中报告的真实路径为准。

---

## 8. 事件流 `Event`

适配器在 **stdout** 上输出 **NDJSON**：每行一个完整 JSON 对象，行内不得有裸换行。
stdout 上不得输出任何非 JSON 内容（调试信息一律走 stderr）。

### 8.1 事件类型

| `type` | 时机 | 必需 |
|---|---|---|
| `hello` | 启动后立刻，宣告自己 | 推荐 |
| `log` | 任意时刻，人类可读日志 | ➖ |
| `progress` | 处理过程中，可多次 | ➖ |
| `artifact` | 每产出一个文件时 | 推荐 |
| `result` | **终态，成功**，必须恰好一次 | ✅ |
| `error` | **终态，失败**，必须恰好一次 | ✅ |

### 8.2 事件定义

```jsonc
// hello —— 让宿主确认适配器已就绪且协议版本匹配
{ "type": "hello", "ckp": "1.0", "kernel": "pillow-image", "version": "1.0.0",
  "engine": "Pillow 12.3.0", "pid": 1234 }

// log —— 人类可读；level 取 debug|info|warn|error
{ "type": "log", "level": "info", "message": "已解码 800x600 PNG" }

// progress —— value 为 0.0~1.0；也可用 current/total
{ "type": "progress", "value": 0.42, "message": "编码中",
  "current": 42, "total": 100 }

// artifact —— 单个产物完成；可多次
{ "type": "artifact", "path": "D:\\out\\a.webp", "format": "webp",
  "bytes": 18342, "primary": true,
  "meta": { "width": 800, "height": 600, "sha256": "…" } }

// result —— 成功终态
{ "type": "result", "ok": true, "ckp": "1.0", "job_id": "…",
  "kernel": { "id": "pillow-image", "version": "1.0.0" },
  "outputs": [ { "path": "D:\\out\\a.webp", "format": "webp", "bytes": 18342,
                 "width": 800, "height": 600 } ],
  "metrics": { "duration_ms": 213, "engine": "Pillow 12.3.0" } }

// error —— 失败终态
{ "type": "error", "ok": false, "ckp": "1.0", "job_id": "…",
  "code": "UNSUPPORTED_FORMAT", "message": "不支持的输出格式: heic",
  "detail": "traceback…", "retryable": false }
```

### 8.3 宿主必须做的鲁棒性处理

- **逐行解析**：单行解析失败 → 记为 `log`，不得中断任务。
- **非 JSON 行**（第三方库往 stdout 打印了东西）：同上，按日志处理。
- **重复终态**：只认第一个 `result`/`error`，其余忽略。
- **无终态即退出**：进程退出但没收到终态 → 宿主合成 `error`，`code = "PROTOCOL_NO_TERMINAL_EVENT"`。
- **超时**：超过 `limits.timeout_ms`（或宿主上限）→ 杀进程，合成 `code = "TIMEOUT"`。
- **产物校验**：`result` 中每个 output 的 `path` 必须存在且可读，否则 `code = "ARTIFACT_MISSING"`。

---

## 9. 调用握手（进程级契约）

宿主启动适配器的完整规则：

1. **命令行**
   ```
   <runtime 展开后的 argv…> [runtime.args…] --ckp-job <job.json 绝对路径>
   ```
   - `python` → `<python.exe> <entry> --ckp-job <job>`
   - `powershell` → `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <entry> --ckp-job <job>`
   - `exec` → `<entry> --ckp-job <job>`
   - `node` → `node <entry> --ckp-job <job>`

2. **工作目录**：`runtime.cwd`（相对内核目录）→ 否则内核目录。

3. **环境变量**（宿主注入，内核可选读）：
   | 变量 | 含义 |
   |---|---|
   | `CKP=1.0` | 协议版本 |
   | `CKP_KERNEL_ID` | 内核 id |
   | `CKP_JOB_ID` | 任务 id |
   | `CKP_PLUGIN_DIR` | 内核目录绝对路径 |
   | `CKP_PROJECT_ROOT` | 宿主项目根 |
   | `CKP_VENDOR` | 宿主 vendor 目录（Python 依赖） |
   | `PYTHONPATH` | 已包含 `CKP_VENDOR` 与内核 SDK 目录 |
   | `PYTHONIOENCODING=utf-8` | 强制 UTF-8 |
   | `PYTHONUTF8=1` | 强制 UTF-8 模式 |

4. **stdin**：宿主写空并关闭（或写入同一份 Job JSON，作为 `--ckp-job` 的兜底）。

5. **stdout**：NDJSON 事件流，**必须 UTF-8 无 BOM**。

6. **stderr**：自由文本日志，宿主捕获用于错误诊断（不解析）。

7. **退出码**：
   | 码 | 含义 |
   |---|---|
   | `0` | 成功（必须已发 `result`） |
   | `1` | 通用失败（应已发 `error`） |
   | `2` | 参数/协议错误 |
   | `3` | 依赖缺失（引擎未安装） |
   | `4` | 输入不可读 |
   | `5` | 输出不可写 |

   宿主**以事件为准**，退出码仅作交叉校验。

8. **取消**：宿主发 `terminate`，宽限 3 秒后 `kill`。内核应尽力清理半成品。

---

## 10. 内核选择算法

宿主为一个「`op` + 输入格式 + 目标格式」组合挑选内核时，按以下顺序执行：

```
候选 = 所有 status == "ready" 的内核
       .filter(k => k.capabilities.any(c =>
             c.op == op
          && (c.from contains from_fmt || c.from contains "*")
          && (c.to   contains to_fmt   || c.to   contains "*")))
       .filter(k => 多输入时 c.multi_in 为真)
       .filter(k => 多输出时 c.multi_out 为真)

排序键（降序）：
   1. 能力级 quality            —— 声明更精确者优先
   2. 内核级 priority           —— 用户/作者偏好
   3. 格式匹配精确度             —— 非通配 > 通配
   4. 内核 id 字典序             —— 保证结果稳定可复现

若候选为空 → 宿主报 NO_KERNEL_FOR_JOB，并把「最接近」的内核与缺失格式一并提示。
```

`status` 取值：`ready`（可用）/ `degraded`（依赖缺失，可在 GUI 中显示修复提示）/
`invalid`（清单非法）/ `unavailable`（probe 失败）/ `disabled`（用户停用）。

---

## 11. 格式规范与别名

- 格式标签统一为**小写、不含点**：`png`、`jpg`、`tiff`…
- 内核**必须**同时接受规范名与常见别名；宿主在做匹配与展示时会先归一化。
- 标准别名表（宿主内建，内核可参考）：

| 规范名 | 别名 |
|---|---|
| `jpg` | `jpeg`、`jpe`、`jfif` |
| `tif` | `tiff` |
| `html` | `htm` |
| `yaml` | `yml` |
| `markdown` | `md` |
| `text` | `txt` |
| `mpeg` | `mpg` |
| `bmp` | `dib` |

- 扩展名与格式标签通常一致；不一致时以 `format` 字段为准。
- 未知格式名一律按字面量处理，不做拒绝。

---

## 12. 错误模型

`error` 事件的 `code` 使用**大写下划线**常量，宿主据此给出人类提示与重试策略：

| code | 可重试 | 含义 |
|---|---|---|
| `UNSUPPORTED_FORMAT` | ✖ | 内核不认识该格式 |
| `BAD_JOB` | ✖ | Job JSON 不合法/缺字段 |
| `PROTOCOL_VERSION` | ✖ | 协议版本不兼容 |
| `DEPENDENCY_MISSING` | ✖ | 引擎/依赖未安装 |
| `INPUT_NOT_FOUND` | ✖ | 输入文件不存在 |
| `INPUT_UNREADABLE` | ✖ | 输入存在但无法读取/解码 |
| `OUTPUT_NOT_WRITABLE` | ✔ | 输出路径不可写 |
| `OUTPUT_EXISTS` | ✔ | 输出已存在且未允许覆盖 |
| `TIMEOUT` | ✔ | 超时（宿主合成） |
| `CANCELLED` | ✔ | 用户取消 |
| `ENGINE_CRASH` | ✔ | 引擎异常退出 |
| `ARTIFACT_MISSING` | ✖ | 声称产出但文件不存在（宿主合成） |
| `PROTOCOL_NO_TERMINAL_EVENT` | ✖ | 进程结束但无终态事件（宿主合成） |
| `INTERNAL` | ✔ | 其他内部错误 |

`detail` 放完整堆栈/引擎原始输出，GUI 折叠展示。

---

## 13. 可用性探测与生命周期钩子

### 13.1 探测 `probe`

```json
"probe": {
  "type": "python-import",
  "target": "PIL",
  "min_version": "9.0"
}
```

```json
"probe": { "type": "command", "target": "magick", "args": ["-version"], "expect": "ImageMagick" }
```

| `type` | 行为 |
|---|---|
| `python-import` | 尝试 import `target`，可选 `min_version` |
| `command` | 在 PATH 中查找 `target` 并运行 `args`，输出含 `expect` 即可用 |
| `file` | 检查宿主项目内相对路径 `target` 是否存在 |
| `none` | 视为始终可用 |

未声明 `probe` 时，宿主退化为检查 `runtime.requires`（Python 导入）。

`probe` 失败 → 内核 `status = "unavailable"`（`python-import` 失败为 `degraded`），
**仍出现在 GUI 中**，并显示如何安装。

### 13.2 钩子 `hooks`

```json
"hooks": {
  "install":   { "type": "command", "command": "winget", "args": ["install", "-e", "--id", "ImageMagick.ImageMagick"] },
  "uninstall": { "type": "command", "command": "..." }
}
```

宿主可在 GUI 中把 `install` 作为「一键安装此内核」按钮暴露给用户；**必须显式确认后才执行**。
钩子只描述「怎么装」，不自动运行。

---

## 14. 版本兼容规则

- 版本号形如 `MAJOR.MINOR`（清单里只写数字，如 `"1.0"`；事件里可写 `"1.0"`）。
- **主版本不同 = 不兼容**：宿主必须拒绝加载，标记 `status = invalid`，`code = PROTOCOL_VERSION`。
- **次版本不同 = 兼容**：
  - 宿主支持 `1.3`，内核写 `1.0` → 加载；
  - 宿主支持 `1.0`，内核写 `1.5` → 加载，但宿主**必须忽略**不认识的字段与事件类型。
- **未知字段**：任何一层出现未知字段，**一律忽略，不得报错**（前后兼容的基石）。
- **未知事件类型**：宿主记为 `log` 并继续。
- **未知 `op`**：正常索引与转发。

---

## 15. 安全边界

- 适配器是**本地进程**，拥有与宿主相同的权限。宿主**不得**从不受信任来源自动下载并执行内核。
- 宿主执行 `hooks.install` 前必须获得用户**显式确认**，并在界面展示将要执行的完整命令行。
- 内核**不得**访问 `inputs`/`outputs`/`workdir` 之外的路径（协议约定；宿主可通过沙箱强化）。
- 传输编码固定 UTF-8，路径使用绝对路径，避免歧义。
- 产物路径由宿主二次校验（存在、在允许目录内、大小合理）。

---

## 16. 扩展点

协议刻意留了四层扩展缝，**加功能不需要改宿主**：

| 扩展点 | 怎么做 | 效果 |
|---|---|---|
| **加格式支持** | 在内核 `capabilities[].from/to` 里加格式名 | GUI 的下拉框自动多出选项 |
| **加参数控件** | 在内核 `params` 里加一条声明 | GUI 自动多出一个控件 |
| **加新操作** | 用新的 `op` 字符串 | 只要内核认，宿主即可调度 |
| **加新引擎** | 新写一个插件目录，塞进 `plugins/` | 重启/热重载后自动出现 |
| **加自定义行为** | 用 `x-*` 字段 + 自定义事件类型 | 宿主忽略，你的工具可识别 |

**新增一个内核的完整成本 = 写一个 `kernel.json` + 写一个读 stdin/`--ckp-job` 的适配器。**
不需要碰宿主代码，不需要重新编译，不需要注册表。

---

## 附录 A：完整最小适配器（Python）

```python
#!/usr/bin/env python3
"""CKP 1.0 最小适配器：png -> jpg。"""
import argparse, json, os, sys

def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()

def load_job(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckp-job")
    ns = ap.parse_args(argv)
    if ns.ckp_job:
        with open(ns.ckp_job, encoding="utf-8") as fh:
            return json.load(fh)
    return json.load(sys.stdin)

def main():
    job = load_job(sys.argv[1:])
    emit({"type": "hello", "ckp": "1.0", "kernel": "demo", "version": "1.0.0"})
    try:
        from PIL import Image
    except ImportError:
        emit({"type": "error", "ckp": "1.0", "job_id": job["job_id"], "ok": False,
              "code": "DEPENDENCY_MISSING", "message": "需要 Pillow", "retryable": False})
        return 3
    src = job["inputs"][0]["path"]
    dst = job["outputs"][0]["path"]
    emit({"type": "progress", "value": 0.5})
    Image.open(src).convert("RGB").save(dst, quality=job.get("params", {}).get("quality", 85))
    emit({"type": "artifact", "path": dst, "format": "jpg", "bytes": os.path.getsize(dst), "primary": True})
    emit({"type": "result", "ok": True, "ckp": "1.0", "job_id": job["job_id"],
          "outputs": [{"path": dst, "format": "jpg", "bytes": os.path.getsize(dst)}]})
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
```

## 附录 B：JSON Schema

机器可校验的 Schema 位于：

- `protocol/schemas/kernel-manifest.schema.json`
- `protocol/schemas/job.schema.json`
- `protocol/schemas/event.schema.json`

宿主在加载内核时按 Schema 校验；校验失败 → `status = invalid`。

---

*CKP v1.0 · 本协议独立于任何具体实现，可被任意宿主复用。*
