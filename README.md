# KernelHub Studio

> **CKP（转换内核协议）驱动**的文件格式转换工作台 —— Electron + Node.js。
> 所有转换能力由内核清单（`kernel.json`）声明，宿主不写死任何格式名、参数名或工具名，
> 界面完全由协议驱动生成。

![转换工作台](docs/screenshots/02-convert.png)

---

## 软件介绍

**它解决什么问题**：格式转换的现状是每个工具一套接口，每加一种格式就要改一次宿主代码。
KernelHub Studio 把它拆成三层，每层都能独立演进：

| 层 | 是什么 |
|---|---|
| **宿主**（本项目） | Electron + Node.js 的界面与调度。**协议驱动**，自身不含任何格式知识 |
| **协议 CKP 1.0** | 内核清单声明能力（操作 / 输入输出格式 / 参数 / 引擎），宿主据此生成界面、联动与选核 |
| **内核插件** | 语言无关的独立进程：读 `--ckp-job`、往 stdout 吐 NDJSON 事件。可以包装 ImageMagick / FFmpeg / Pandoc / LibreOffice 等命令行工具，也可以是 Python 库 |

所以「加一个新内核」只需要写一份 `kernel.json`；引擎是现成命令行程序时，连适配器都不用写。

### 主要能力

* **转换工作台** —— 拖拽或选择文件/目录（递归展开）；操作 → 目标格式联动；
  自动选核（`quality → priority → 匹配精确度 → id`）；参数面板完全由清单生成；
  真实命令行预览（不执行）；输出目录可选、自动避免覆盖
* **批量队列** —— 并发 1–8 可调，暂停/继续/取消/重试，逐作业进度、实际使用内核与耗时
* **插件**（2.0.1 起原「内核」页并入这里）
  * *已安装*：状态、能力矩阵、参数表、依赖、安装提示、启用/停用、优先级、原始清单
  * *可安装*：从插件仓库按需下载，**多线程并发下载**，装完自动刷新、新格式立刻可选
* **格式矩阵 / 协议规范 / 运行日志 / 设置** —— 格式可达关系、`PROTOCOL.md` 与三份 JSON Schema、
  完整 NDJSON 事件流、Chrome 式分类设置

### 结构：壳 + 按需插件

安装包只含「壳」：Electron 运行时 + 协议资产 + **4 个不需要外部程序的种子插件**（约 1.6 MB）。
其余 15 个内核（FFmpeg、PyMuPDF、Pillow、Office 文档、各类命令行工具包装…）在「插件」页
按需下载 —— 所以安装包只有 **89.9 MB**，而不是把 195 MB 的内核仓库全塞进去。
**每个插件自带自己的依赖**，装 A 插件不会连带拖下 B 插件的几十 MB。

界面为瑞士风格（网格、无衬线、直角、无阴影、无渐变），每屏可见按钮 ≤ 10 个。

| | |
|---|---|
| ![高级抽屉](docs/screenshots/06-convert-advanced.png) | ![协议规范](docs/screenshots/08-protocol.png) |
| 「高级」抽屉：参数全部由清单生成，另有输出目录与命令行预览 | 协议规范：渲染 `PROTOCOL.md` 与三份可机器校验的 JSON Schema |

架构与协议实现见 **[docs/architecture.md](docs/architecture.md)**，
界面设计规范见 **[docs/ui-spec-swiss.md](docs/ui-spec-swiss.md)**。

---

## 客户端安装

### 1. 下载

从 [Releases](https://github.com/sigewinner/kernelhub/releases/latest) 下载：

| 文件 | 大小 | 说明 |
|---|---|---|
| `KernelHub Studio-2.0.1-setup.exe` | 89.9 MB | 安装版：可选安装目录，自动建快捷方式 |
| `KernelHub Studio-2.0.1-portable.exe` | 89.6 MB | 便携版：免安装，首次启动要自解压，稍慢十几秒 |

### 2. 系统要求

* **Windows 10 / 11 x64**
* **系统 Python 3** —— 每个插件的适配器都是 `adapter.py`，需要 PATH 里能找到 `python`
* 转换特定格式还需要对应的外部程序（ImageMagick、FFmpeg、Pandoc、LibreOffice、Ghostscript、
  qpdf、7-Zip 等）。**不必先装**：插件列表里的「内核状态」列会直接告诉你缺什么。

### 3. 安装与使用

1. 双击安装（或直接运行便携版）
2. **首次启动会自动创建用户工作区，并把 4 个种子插件铺好** ——
   `stdlib-image`（纯标准库）、`text-markup`（自带 markdown/html2text）、
   `data-table`（自带 openpyxl）、`windows-wic`（Windows 自带 WIC）。
   不用联网、不用配置，装完即可转换。
3. 打开「转换」页，拖文件进去 → 选目标格式 → 开始转换
4. 需要更多格式时到 **插件**页（侧栏 03）安装：下载 → 自动刷新 → **新格式立刻出现在可选格式里**

### 4. 文件放在哪

| 路径 | 内容 |
|---|---|
| `%APPDATA%\kernelhub-studio\` | 设置、插件目录缓存 |
| `%APPDATA%\kernelhub-studio\hub\plugins\<id>\` | 已安装的插件（含各自的依赖） |
| `%APPDATA%\kernelhub-studio\hub\.cache\runs\` | 任务落盘（与内核进程交换的 job.json） |

### 5. 如果双击 exe 完全没反应

若安装目录被 Windows 标记为**低完整性**（部分开发目录、某些同步盘目录会这样），
Chromium 的渲染进程会被强制完整性控制（MIC）的 No-Write-Up 策略拒绝，
表现为双击 exe **毫无反应、连报错都没有**（退出码 `0x80000003`）。

**这不是程序问题，换到普通目录即可**：默认的 `%LOCALAPPDATA%\Programs\KernelHub Studio`
就是普通目录；便携版建议放到 `D:\Apps\` 或桌面一类的位置。

---

## 开发端安装介绍

### 环境

* **Node.js ≥ 18** + npm
* **Python 3**（PATH 里能找到 `python`）
* 可选：**git** —— 装了的话插件页会优先用稀疏克隆，只下载选中的那个插件

### 起步

```bat
git clone https://github.com/sigewinner/kernelhub.git
cd kernelhub
npm install                :: 只装 Electron 与 electron-builder，没有其它运行时依赖

npm start                  :: 桌面版；预检失败会自动降级到浏览器版并说明原因
npm run browser            :: 浏览器版（同一套界面 + 同一个引擎）
npm run diag               :: 环境诊断：Node / Electron / Python / CKP 工作区
```

`npm start` 走 `tools/launch.js`：先预检项目文件、Electron 运行时与**目录完整性**，
启动后 2.5 秒内判断窗口是否真的起来；失败时打印退出码 + 环境诊断 + 根因判断，
并自动用浏览器版拉起同一套界面。

### 打包

```bat
npm run build:dir        :: 只生成解包目录（最快，先验证能不能启动）
npm run build:portable   :: 便携版单文件 exe
npm run build:mirror     :: 安装包 + 便携版（国内网络走镜像，推荐）
npm run build:withhub    :: 一体化模式：把整个内核仓库也打进包（体积回到 1.x 水平）
```

产物在 `release/`。默认是**壳模式**：只带 SDK + 协议 + 4 个种子插件，
其余内核由用户在应用内按需下载。打包产物请**复制到普通目录再运行**（原因同上文的低完整性问题）。

完整流程（配置项、体积构成、常见失败）见 **[docs/build.md](docs/build.md)**。

### 验证

```bat
node tools\audit.js               :: 源码体检：编码完整性 / JS 语法 / 渲染层依赖边界
node tools\smoke.js               :: 引擎端到端：真实调用内核转换并校验产物
node tools\uiverify.js            :: 界面端到端：启动开发宿主 + Chrome，跑完整流程并截图

:: 打包产物
"KernelHub Studio.exe" --selftest --selftest-out=D:\report.json
node tools\verify-engine-in-electron.js --app <解包目录>
node tools\verify-plugin-install.js --app <解包目录> --id pillow-image
```

### 目录结构

```
kernelhub-studio/
├── src/
│   ├── shared/protocol.js   CKP 1.0 协议的 Node 权威实现
│   ├── engine/              内核中枢（纯 Node，可独立复用）
│   │                        含 pluginStore（按需安装）、download（多连接分片下载）、zipExtract
│   ├── main/                Electron 主进程 + preload 契约
│   └── renderer/            界面（HTML/CSS/原生 ES Module）
│       └── js/views/        7 个视图：转换 / 队列 / 插件 / 格式 / 协议 / 日志 / 设置
├── sdk/kernelhub/           CKP 适配器 SDK（Python 包，所有 adapter.py 依赖它）
├── protocol/                PROTOCOL.md 与 JSON Schema
├── seed-plugins/            随包预置的 4 个种子插件
├── tools/                   启动器 / 打包 / 各类验证脚本
└── docs/                    架构、打包、API 契约、UI 规范与截图
```

### 文档

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 协议实现、引擎分层、内核进程契约 |
| [docs/build.md](docs/build.md) | 打包与发布全流程 |
| [docs/renderer-api.md](docs/renderer-api.md) | 渲染层 API 契约（`window.khs`） |
| [docs/UI.md](docs/UI.md) · [docs/ui-spec-swiss.md](docs/ui-spec-swiss.md) | UI 实现说明 · 设计规范 |

---

## 许可

宿主（本项目的 Node/Electron 代码）为 MIT。
各外部内核的许可证随其 `kernel.json` 的 `license` 字段声明
（ImageMagick、Pandoc 为 GPL 系，PyMuPDF 为 AGPL，FFmpeg 为 LGPL/GPL），商用前请自行确认。
