# KernelHub Studio · 渲染进程 UI 设计说明

> 本文只描述 `src/renderer/` 这一层（HTML + CSS + 原生 ES Module）。
> 与主进程的接口以 `docs/renderer-api.md` 与 `src/main/preload.js` 为准，本项目 UI 不假设任何
> 未在契约中出现的字段，也不硬编码任何格式名 / 内核名 / 参数名。

---

## 1. 设计系统

### 1.1 依赖与约束

| 项 | 约定 |
| --- | --- |
| 技术栈 | HTML + CSS + 原生 ES Module（`<script type="module">` + 相对路径 import） |
| 第三方资源 | **零**。无 CDN、无网络字体、无 React/Vue/Tailwind、无构建步骤 |
| 运行方式 | Electron `loadFile()` 直接打开，全部为相对路径，可离线运行 |
| 渲染进程权限 | 无 `require` / `process` / `fs` / `nodeIntegration`；只经 `window.khs` |
| 样式唯一数值来源 | `styles/tokens.css` 的 CSS 变量；其它样式表只引用 `var(--token)` |
| 安全 | CSP `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'`；无内联脚本；Markdown 先转义再渲染 |

### 1.2 文件结构

```
src/renderer/
├── index.html                 应用外壳 HTML（静态骨架，JS 只填充内容）
├── js/
│   ├── boot.js                能力探测（无 window.khs → 提示页），必须是第一个脚本
│   ├── app.js                 应用内核：启动序列 / 路由 / 事件桥 / 快捷键 / 命令面板数据
│   ├── state.js               全局状态单例（视图与 app 之间的无环叶子模块）
│   ├── store.js               轻量订阅式仓库（createStore / createViewState）
│   ├── dom.js                 极小 DOM 原语：h/qs/qsa/on/clear/frag/delegate/srText/copyText
│   ├── format.js              纯函数格式化：体积/时间/耗时/裁剪/路径/快捷键/JSON
│   ├── icons.js               内联 SVG 图标集（24×24、stroke=currentColor）
│   ├── toast.js               通知系统（success/error/warn/info，可堆叠/可关闭/可带动作）
│   ├── modal.js               对话框（确认/信息/详情/命令行预览/JSON 查看器/代码块/路径芯片）
│   ├── controls.js            由 ParamSpec 生成参数控件的工厂
│   ├── layout.js              标题栏 + 侧栏 + 状态栏 + 命令面板 + 共用小组件
│   └── views/                 8 个视图，按需 import() 懒加载
│       ├── welcome.js  convert.js  batch.js  kernels.js
│       └── formats.js   protocol.js  settings.js  logs.js
└── styles/
    ├── tokens.css             设计令牌（颜色/间距/圆角/阴影/层级/动效/双主题）
    ├── base.css               reset、排版、滚动条、选中、焦点环、工具类、降级提示页
    ├── layout.css             标题栏/侧栏/主区/状态栏骨架 + 响应式断点
    ├── components.css         按钮/输入/下拉/开关/滑块/徽标/卡片/表格/进度/toast/modal/tabs/空态/骨架屏
    └── views.css              各视图专属样式 + 动画（入场、微光、微交互）
```

### 1.3 设计令牌表

令牌定义在 `styles/tokens.css`。默认深色（`:root` 与 `[data-theme="dark"]`），
浅色令牌在 `[data-theme="light"]` 覆盖同名变量，**结构与尺寸不变，只换语义色**。

#### 颜色（深色 / 浅色）

| 令牌 | 深色 | 浅色 | 用途 |
| --- | --- | --- | --- |
| `--c-bg` | `#070a12` | `#f4f6fb` | 页面底色（近黑/近白） |
| `--c-bg-deep` | `#05070d` | `#eaeef7` | 凹槽、滑块轨道、进度槽 |
| `--c-bg-raise` | `#0b0f1a` | `#ffffff` | 抬升面 |
| `--c-panel` | `rgba(19,24,38,.62)` | `rgba(255,255,255,.78)` | 玻璃面板底色 |
| `--c-panel-solid` | `#111726` | `#ffffff` | 不透明面板（modal、表头） |
| `--c-panel-hover` | `rgba(28,35,54,.72)` | `rgba(255,255,255,.95)` | hover 面 |
| `--c-inset` | `rgba(4,6,12,.55)` | `rgba(15,23,42,.045)` | 输入框/徽标内陷底 |
| `--c-overlay` | `rgba(3,5,10,.72)` | `rgba(15,23,42,.34)` | 遮罩 |
| `--c-border` | `rgba(255,255,255,.07)` | `rgba(15,23,42,.10)` | 1px 低对比描边 |
| `--c-border-strong` | `rgba(255,255,255,.14)` | `rgba(15,23,42,.18)` | hover 描边 |
| `--c-border-accent` | `rgba(79,140,255,.45)` | `rgba(37,99,235,.42)` | 选中/聚焦描边 |
| `--c-text` | `#e8ecf6` | `#101828` | 主文本 |
| `--c-text-2` | `#a9b3c7` | `#43506b` | 次要文本 |
| `--c-text-3` | `#77839b` | `#6b7794` | 说明文本 |
| `--c-text-4` | `#4e596e` | `#98a2b8` | 极弱文本（占位、分隔） |
| `--c-accent` | `#4f8cff` | `#2f6bed` | 强调主色 |
| `--c-accent-2` | `#22d3ee` | `#0aa2c0` | 强调辅色（渐变尾） |
| `--c-success` | `#34d399` | `#0f9f6e` | 成功/可用 |
| `--c-warning` | `#fbbf24` | `#b7791f` | 警告/依赖缺失 |
| `--c-danger` | `#f87171` | `#dc4c4c` | 危险/失败/清单非法 |
| `--c-info` | `#60a5fa` | `#2563eb` | 信息/排队中 |

每种语义色都有 `-soft` 变体（如 `--c-success-soft`）用于徽标底色。

#### 渐变与玻璃

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--grad-accent` | `linear-gradient(135deg, accent → accent-2)` | 主按钮、进度条、Logo |
| `--grad-accent-soft` | 18% / 16% 透明度的同向渐变 | 选中导航项、统计卡图标底 |
| `--grad-flow` | 白色透明带 | 进度条「流动高光」动画的色带 |
| `--glass-bg` | 深色 `rgba(19,24,38,.62)` | 玻璃层背景 |
| `--glass-blur` | `18px`（浅色 `16px`） | `backdrop-filter` 模糊半径 |
| `--halo-1/2/3` | 三个极淡 radial-gradient | 页面底层光晕（青蓝 + 紫，无噪点图） |

#### 尺寸 / 间距 / 圆角

| 令牌 | 值 | 说明 |
| --- | --- | --- |
| `--size-titlebar` | `44px` | 自定义标题栏高度 |
| `--size-sidebar` | `232px`（<1180px 时 `62px`） | 侧栏宽 |
| `--size-statusbar` | `30px` | 底部状态栏 |
| `--size-control` / `--size-control-sm` | `34px` / `28px` | 控件高度 |
| `--sp-1 … --sp-16` | `4 8 12 16 20 24 32 40 48 64` | 4px 基准栅格 |
| `--r-xs … --r-xl` | `6 9 12 16 20` | 圆角；卡片用 `--r-lg`(16)/`--r-xl`(20)，面板 14–18px 区间 |
| `--r-pill` | `999px` | 胶囊 |

#### 层级 / 动效

| 令牌 | 值 |
| --- | --- |
| `--z-sidebar / --z-titlebar` | `40 / 60` |
| `--z-dropdown / --z-modal / --z-toast / --z-cmdk` | `200 / 300 / 400 / 500` |
| `--ease` | `cubic-bezier(.22,.61,.36,1)`（通用） |
| `--ease-out` | `cubic-bezier(.16,1,.3,1)`（入场） |
| `--ease-spring` | `cubic-bezier(.34,1.4,.64,1)`（开关滑块） |
| `--t-fast / --t-base / --t-slow` | `120 / 170 / 240ms` |

`prefers-reduced-motion: reduce` 时三个时长令牌被压到 1ms，全部动画随之关闭。

#### 字体

| 令牌 | 值 |
| --- | --- |
| `--font-sans` | `system-ui, "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif` |
| `--font-mono` | `ui-monospace, "Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace` |

### 1.4 视觉语言的关键取舍

1. **玻璃层而非纯色块**：面板统一 `backdrop-filter: blur(18px) saturate(130%)` + 1px 低对比描边，
   让分层背景（近黑 `#070a12` + 三层极淡光晕）透出来，避免大面积纯色显得扁。
2. **描边对比度压到 4.5%–14%**：深色下强边框会显廉价，靠 1px 弱描边 + 阴影分层。
3. **强调色只用于「可交互/已选中/进行中」**：主色出现在主按钮、选中导航项、进度条、
   聚焦环，其余保持中性灰阶，避免界面变成调色板。
4. **动效只做三件事**：视图入场（8px 位移 + 淡入）、hover 上浮 1–2px + 轻发光、按下缩放 0.98。
   进度条流动高光与骨架屏微光是仅有的两个循环动画。
5. **不用图标字体 / 位图**：所有图标是内联 SVG path（`stroke=currentColor`），
   随文字颜色与尺寸缩放，也避免任何外部资源请求。
6. **纯图标按钮必须带 `visually-hidden` 文本**：既满足读屏，也保证
   `innerText` 永远可读（自动化验收依赖这一点，见 §7）。
7. **主题切换只换令牌**：`<html data-theme="dark|light">` 一切依赖 `var(--token)` 的样式自动跟随，
   组件样式表里没有任何硬编码颜色（除少数透明度叠加）。

### 1.5 按钮预算与列表交互（瑞士风格重做后新增）

> 视觉与信息架构以 `docs/ui-spec-swiss.md` 为准（网格、无衬线字、左对齐、大量留白、
> 黑白灰 + 一个红点、直角、无阴影/渐变/圆角/毛玻璃）。上面 §1.4 的「玻璃层 + 发光 + 位移动效」
> 属于重做前的旧设计，仅作历史参考。

1. **每屏可见 `<button>` ≤ 10**：验收脚本（`tools/uiverify.js` 第 9 节）统计屏幕上所有可见的
   `<button>`（含表格行内的），并同时校验「整窗（含外壳）≤ 20」。详细配置一律收进「高级」抽屉。
2. **列表类界面采用整行可点，行操作不用 button，以满足每屏按钮上限**：
   内核表、格式表、作业表的行都是 `<tr tabindex="0" role="button">`（Enter / Space 同样生效），
   行末只放一个 `aria-hidden` 的提示字符；真正的行操作（取消 / 重试 / 打开产物 / 展开日志 /
   移除文件）用 `dom.js` 的 `iconAction()` 渲染成 `<span role="button" tabindex="0" aria-label>`，
   字段里的复制 / 浏览图标同理（`role="button"` 的自定义元素、文字链、输入框、下拉框、
   勾选框都不计入按钮预算）。
3. **禁止每行一个 `<button>`**：19 行内核 × 1 个按钮 = 用户眼里 19 个按钮，这正是重做前的问题。

---

## 2. 视图 / 文件映射

| 视图 | 路由 | 模块 | 主要 khs 接口 | 关键交互 |
| --- | --- | --- | --- | --- |
| 欢迎 | `#/welcome` | `views/welcome.js` | `app.info` `app.layout` `kernels.status` `queue.list` `kernels.formats` `fs.expand` `settings.get` | Hero + 拖拽投放区（拖入即 `fs.expand` 并跳转工作台）、4 张统计卡（点击跳转对应视图）、内核状态台账（可复制安装提示）、最近输出目录、最近转换记录 |
| 转换工作台 | `#/convert` | `views/convert.js` | `plan.targets` `plan.candidates` `plan.params` `plan.preview` `queue.enqueue` `fs.pickFiles/pickFolder` | 左侧待转换文件池（拖拽/选择/去重/移除/汇总）、右上 op→目标格式→内核→输出目录四段联动、中部「将使用：内核」+ 候选内核徽标（点击固定）、参数面板（基础/高级折叠 + 复位 + 每项 description）、命令行预览、实时进度 + 取消 |
| 批量队列 | `#/batch` | `views/batch.js` | `queue.list/cancel/retry/remove/clear/cancelAll/retryFailed/setParallel/pause/resume/jobLogs` | 作业表格（增量更新，不整表重建）、行内展开该作业日志、并发滑块 1–8、暂停/继续、重试失败、清除已完成、筛选 + 搜索 |
| 内核仓库 | `#/kernels` | `views/kernels.js` | `kernels.list/status/detail/setEnabled/setPriority/openDir` | 卡片/列表双模式、状态台账（点击筛选）、状态 + kind 过滤、搜索、排序、启停、优先级、打开目录、详情 modal（能力矩阵/参数表/运行时/探测/executableSpec/安装提示/原始 manifest） |
| 格式矩阵 | `#/formats` | `views/formats.js` | `kernels.formats` `kernels.ops` `kernels.refresh` `plan.targets` | 按 op 分组的统计、格式列表（输入/输出操作标签 + 内核数）、搜索、点击格式查看「可达目标」（**只对选中格式按需查一次 IPC**）、原始数据 JSON |
| 协议规范 | `#/protocol` | `views/protocol.js` | `protocol.doc` `protocol.schemas` `doctor` | 三标签页（协议原文 / Schema / 环境自检）、自写安全 Markdown 渲染器 + 自动目录、Schema 格式化 + 复制 + JSON 查看器、doctor 摘要 + 非可用内核清单 |
| 设置 | `#/settings` | `views/settings.js` | `settings.get/set` `app.layout` `app.info` `doctor` `fs.*` `logs.clear` | hubRoot、额外插件目录增删、并发上限、超时、默认操作、autoScan、日志保留条数、主题深浅、语言只读、全部路径展示（复制/打开）、doctor 结果、危险区（恢复默认/清空日志） |
| 运行日志 | `#/logs` | `views/logs.js` | `logs.list` `logs.clear` + `evt:log` / `evt:job:log` | 合并时间线、级别多选过滤（带计数）、文本搜索、跟随/暂停自动滚动（手动上滚自动暂停）、跳到底部、复制全部、导出（modal 展示文本）、清空 |

---

## 3. 状态与事件流

### 3.1 状态分层

```
state.js（单例，createStore）
├── 外壳层   bootPhase / info / layout / settings / version / ckp / activeView / maximized
├── 数据层   kernels / kernelsSummary / kernelsTotal / kernelsReady / kernelByStatus
│            kernelErrors / kernelSearchPaths / ops / opsMap
│            jobs(Map) / queueCounts / queuePaused / parallel
│            logs / logCount / logErrorCount / pending
└── 缓存层   formatsCache（内核格式矩阵，命令面板与格式矩阵共享）
```

* 视图通过 `ctx.store`（`state` 单例）读写，**不自己调 IPC 改全局数据**（只能读 + 触发动作）。
* 局部 UI 状态（筛选条件、展开行、滚动跟随等）留在各视图闭包里，不进全局 store。
* `pending`（待转换文件池）放在全局，因此「在工作台加文件 → 切到队列 → 切回来」不会丢。

### 3.2 启动序列

```
boot.js           探测 window.khs → 设置 <html data-khs-bridge="ready|missing">
                  （missing 时只显示提示页，不抛异常，不白屏）
app.main()
  ├─ createLayout().mount()                外壳先出来（标题栏/侧栏/状态栏骨架）
  ├─ bindHotkeys() / bindBridgeEvents()     事件订阅必须在任何 IPC 之前挂好
  ├─ 并行: app.info() + app.layout()        关键路径：失败 → 错误态（可重试）
  ├─ settings.get() → applyTheme()          主题在首屏内容之前应用
  └─ 并行: kernels.list() + kernels.status() + kernels.ops()
           queue.list() + logs.list()       这一批失败不阻塞应用，可单独刷新
  └─ bootPhase='ready' → renderRoute()      按 location.hash 懒加载视图
```

* 视图加载/渲染任一环节抛异常 → 视图区域显示带「重试 / 回到欢迎页」的错误块（`buildViewError`），
  同时 toast + `console.error`。
* `khs.app.info()` / `layout()` 失败 → 整页错误态 + 重新加载按钮。

### 3.3 事件订阅（app.js 的 `bindBridgeEvents`）

| 通道 | 处理 |
| --- | --- |
| `evt:queue` | 用全量快照重建 `jobs` Map（并清理已移除作业的 `jobStateSeen`） |
| `evt:queue:enqueue` | 增量插入新作业到 Map |
| `evt:job:update` | 更新单个作业；若状态跃迁到终态则派生通知（完成→成功 toast + 打开产物；失败→错误 toast + 重试/详情） |
| `evt:job:finish` | 只在失败且带 stderr 时补一条错误日志（exit_code + stderr 尾部） |
| `evt:queue:idle` | 更新计数 + 一条「队列已空闲」汇总 |
| `evt:job:log` | `pushLogEntry({ ..., jobId })` |
| `evt:log` | `pushLogEntry({ ..., source: 'main' })` |
| `evt:window` | `state.maximized` → 标题栏最大化/还原图标 |
| `cmd` | `pick-files`→添加文件；`pick-folder`→添加目录；`refresh`→刷新内核；`protocol`→跳协议视图 |

日志合并与裁剪在 `state.js`：`pushLogEntry` 维护 4000 行环形缓冲；
`replaceLogs` 用于启动拉取与清空。

### 3.4 路由

* `location.hash` 驱动（`#/welcome` … `#/logs`），刷新后保持当前视图。
* `VIEWS` 表把 id 映射到 `() => import('./views/x.js')`，天然懒加载。
* 切换时先 `unmount()` 旧视图（视图自己退订所有订阅与事件），再 `clear(#view)`，再挂骨架屏，
  最后 `mount()`；挂载完成后执行「路由后动作」（命令面板要求的目标动作，见下）。
* `navigate(hash, action)`：第二个参数可带 `{ name, payload }`，等目标视图挂载完成后由
  `runAction` 执行。这样命令面板里点「切到某操作」「聚焦某内核」不需要关心视图是否已加载。

### 3.5 关键数据流（转换工作台）

```
pending(文件池) ─┬─→ plan.targets({sourcePath, op, kernelId})      → vs.targets  → 目标格式下拉
                 ├─→ plan.candidates({op, srcFmt, dstFmt, sources})→ chosen + candidates
                 └─→ plan.params({op, srcFmt, dstFmt, kernelId, sources}) → ParamSpec[] → controls

(op | dstFmt | kernelId) 任一变化 → 重跑上述三步
```

* **竞态守卫**：每次刷新自增 `vs.seq`，异步回调只在 `seq` 未过期时写 UI；
  快速连点格式不会出现「旧结果覆盖新结果」。
* **保持选择合法**：`targets` 返回后若 `dstFmt` 不在列表里，自动回退到第一个合法值；
  固定的内核若已不可用则静默退回「自动选择」。
* **参数面板不随计划抖动**：参数变化不回刷计划，只重算可见性。

---

## 4. 参数控件映射表

控件完全由 `plan:params` 返回的 `ParamSpec.type` 决定（`controls.js`）。
UI 里不存在任何参数名/格式名常量。

| `ParamSpec.type` | 控件 | 取值 / 提交 | 边界处理 |
| --- | --- | --- | --- |
| `int` | 数字输入（`step` 默认 1）；有 `min`+`max` 且 `(max-min)/step ≤ 4000` 时附带滑块 | `number` | `change` 时按 `[min,max]` 裁剪并四舍五入；非法输入回退默认值 |
| `float` | 数字输入（`step` 默认 0.01）+ 同上滑块 | `number` | 同上，不取整 |
| `bool` | 自定义开关（`label.switch` + 隐藏 checkbox） | `boolean` | `change` 即提交 |
| `enum` | 自定义 `select`，显示 `enum[].label`，提交 `enum[].value` | `string` | 目标值不在选项内时保留默认，避免提交未知值 |
| `string` | 文本框 | `string` | — |
| `path` | 只读输入 + 「选择目录」「选择文件」两个按钮（`fs.pickFolder` / `fs.pickFiles`） | `string` | IPC 失败走 `khs:ui-error` 事件 → toast |
| `color` | `<input type=color>` + 十六进制输入框（双向同步） | `#RRGGBB` 字符串 | 非法十六进制回退到当前色，不提交脏值 |

其它规格字段：

| 字段 | 行为 |
| --- | --- |
| `label` | 控件标签；缺失时退回 `id` |
| `description` | 渲染在控件下方的说明文本 |
| `default` | 「复位为默认值」的还原目标；`null` 时按类型兜底（enum 取首个选项值，数值 0，bool false，color `#000000`，其余空串） |
| `advanced` | 归入「高级参数」折叠区（默认收起，标题带条数徽标） |
| `min` / `max` / `step` | 数字输入约束 + 滑块范围；下方显示「取值范围 x – y，步长 n」 |
| `required` | 标签后追加红色 `*`（宿主未返回时视为可选） |
| `applies_to` | 与当前 `op` 精确比较，不匹配则隐藏 |
| `when` | `{ op?, from?, to? }`，与当前 `op/srcFmt/dstFmt` **精确字符串比较**（通配与格式族由宿主 `registry.paramVisibleFor` 负责） |

**隐藏 ≠ 提交**：隐藏控件的值不进入 `values()`，但会被 stash 起来；
等格式切回来时自动恢复，避免来回切格式丢失用户已填内容。
面板标题右侧常驻「可见 / 总数」计数，隐藏时另有一行提示「N 个参数不适用于当前组合」。

---

## 5. 交互模式与快捷键

### 5.1 快捷键表

逻辑键名平台中立，展示时由 `format.js` 的 `shortcut()` 按平台替换
（`mod` → macOS `⌘` / 其它 `Ctrl`）。全部在 `app.js` 的 `HOTKEYS` 集中注册，视图不注册全局键。

| 逻辑键 | Windows / Linux | macOS | 动作 | 实现 |
| --- | --- | --- | --- | --- |
| `mod+O` | `Ctrl+O` | `⌘O` | 添加文件 | `pickFiles()` |
| `mod+Shift+O` | `Ctrl+Shift+O` | `⌘⇧O` | 添加目录（递归展开） | `pickFolder()` |
| `mod+Enter` | `Ctrl+Enter` | `⌘↵` | 开始转换 | `runAction('start-convert')` → 由转换工作台注册 |
| `F5` | `F5` | `F5` | 刷新内核（重扫 + 重探测） | `refreshKernels()` |
| `mod+R` | `Ctrl+R` | `⌘R` | 刷新内核（兼容别名） | 同上 |
| `mod+K` | `Ctrl+K` | `⌘K` | 命令面板 | `layout.openPalette()` |
| `Esc` | `Esc` | `Esc` | 关闭命令面板 → 关闭 modal → 通知视图（`khs:escape`） | 逐级判断 |
| `mod+1…8` | `Ctrl+1…8` | `⌘1…8` | 依次切换 8 个视图 | 按 `NAV_ITEMS` 顺序 |

在输入框/下拉里按单键不会触发快捷键（`F5` 等 `F` 键除外），避免打字时误触。

### 5.2 全局交互约定

| 交互 | 反馈 |
| --- | --- |
| hover | 上浮 1–2px + `shadow-sm/md`；图标按钮的 tooltip 由 `.tip[data-tip]` 提供 |
| active | `scale(0.98)` |
| 焦点 | `:focus-visible` → `outline: 2px solid rgba(79,140,255,.6); outline-offset: 2px` |
| 视图切换 | 8px 位移 + 淡入（`view-enter`，240ms `--ease-out`） |
| 加载中 | 骨架屏微光扫过（标题 1 条 + 3 张卡 + 4 行，形状与真实内容接近，避免跳变） |
| 进度 | 渐变填充 + 流动高光；排队中改用 indetermine 往返动画 |
| 通知 | 右下角堆叠（最多 6 条，超出关掉最旧）；success 3.6s、warn 6s、info 4.2s 自动消失，**error 不自动消失**；hover 暂停计时；错误可带「重试 / 查看详情」动作 |
| 错误路径 | 任何失败都至少有两处可见：toast + 一条带级别与来源的日志；`catch {}` 仅用于「清理/退订」这类无副作用场景 |
| 拖拽 | 窗口级 `dragover/drop` 阻止默认行为；欢迎页与工作台各自有投放区（`data-drag` 高亮 + 缩放） |
| 命令面板 | `↑↓` 选择、`Enter` 执行、`Esc` 关闭；分组为「前往 / 操作 / 操作类型 / 内核 / 格式」；内核与格式条目直接跳转并聚焦 |
| 状态栏 | 就绪状态点（就绪/转换中/启动异常/载入中）、内核可用数、队列计数、待转换数、暂停标记、日志条数、CKP 版本、命令面板提示；点击可跳转对应视图 |

### 5.3 视图级状态机

**转换工作台**

```
无文件 ──添加文件/拖入──▶ 有文件
有文件 ──plan.targets──▶ 目标格式可选出 ──plan.candidates──▶ chosen.ok / chosen.error
chosen.error ──换 op / 换内核 / 放弃──▶ 重新选核
就绪 ──queue.enqueue──▶ 清空待转换池 + 提示「已加入队列」+ 底部出现实时进度
进行中 ──queue.cancel / 取消该作业──▶ 取消
```

**批量队列作业**

```
queued ─运行位空闲─▶ running ──成功──▶ done ──清除已完成──▶ 移除
                              ├─失败──▶ failed ──retry──▶ queued
                              └─取消──▶ cancelled ──retry──▶ queued
（pause 只影响新的调度，已在运行的会跑完；resume 后立即 pump）
```

**日志视图**：`跟随中` ⇄ `已暂停跟随`（手动上滚自动暂停；出现「有新日志（n）」按钮）。

---

## 6. 如何新增一个视图

只有 4 处需要改，**不需要碰主进程**：

1. **新建模块** `src/renderer/js/views/yourview.js`，导出 `mount(host, ctx)`：

   ```js
   export async function mount(host, ctx) {
     const { store, navigate, reportError, wrapError, toast, modal, registerAction } = ctx;
     const wrap = h('div.view-inner', null, /* ... */);
     host.appendChild(wrap);
     const off = store.subscribe(() => { /* 只在 activeView === 'yourview' 时重绘 */ });
     const offAction = registerAction('your-action', (payload) => { /* ... */ });
     return {
       unmount() { off(); offAction(); clear(host); },
     };
   }
   ```
   * 必须返回 `{ unmount }`（或 `undefined`）：路由切换时会先调 `unmount` 再清 DOM，
     用于退订 store、`window.khs.on(...)` 与 DOM 事件。
   * `ctx` 提供的全部能力见 `app.js` 的 `makeContext()`：`store / navigate / reportError /
     wrapError / openPathSafe / registerAction / patchSettings / 文件池操作 / refreshKernels /
     toast / modal / opMeta / openPalette / loadSamples / pickFiles / pickFolder / expandPaths`。

2. **注册懒加载**：在 `app.js` 的 `VIEWS` 里加一行 `yourview: () => import('./views/yourview.js')`。

3. **加入导航与快捷键**：在 `layout.js` 的 `NAV_ITEMS` 里加一项
   （`id / label / icon / hash / shortcut / badge`）。`badge(state)` 返回 `{ text, kind }` 或 `null`；
   侧栏分组与 `Ctrl/Cmd+数字` 顺序都由 `NAV_ITEMS` 数组顺序决定（当前 8 项 → `mod+1..8`）。

4. **补样式**：在 `styles/views.css` 加块（建议前缀与视图同名），
   或复用 `components.css` 已有的 `.card / .badge / .table / .progress / .empty / .strip`。

若要展示外壳上的数字（状态栏/侧栏徽标），优先在 `app.js` 里把它并入
`layout.render(state)` 的入参或 `NAV_ITEMS[i].badge`，而不是让视图直接改外壳 DOM。

---

## 7. 自检与验证

### 7.1 语法校验（渲染进程全部 JS）

```powershell
# 逐个文件做 ES Module 语法校验（package.json 是 commonjs，所以走 stdin 形式）
Get-ChildItem -Path src\renderer -Recurse -File -Filter *.js |
  ForEach-Object { cmd /c "node --input-type=module --check < `"$($_.FullName)`"" }
```

### 7.2 资源约束校验

```powershell
# 只应出现文档链接（khs.fs.openExternal 的目标），不得出现 CDN/脚本/字体引用
Select-String -Path src\renderer\* -Include *.html,*.css,*.js -Pattern "https?://" -Recurse
```

### 7.3 端到端界面验收（浏览器开发宿主 + 真实内核引擎）

`tools/uiverify.js` 会启动 `tools/devserver.js`（真实引擎 + WebSocket 桥），
用系统 Chrome 打开**由 `index.html` 现场派生**的 `devhost.html`（放开 `connect-src` 并注入
`devhost/khs-browser.js` 提供的 `window.khs`），然后逐视图断言并截图到 `docs/screenshots/`：

```powershell
node tools/uiverify.js
```

覆盖：启动序列与外壳、真实选核/参数/落盘、批量队列、内核仓库（含详情接口与启停）、
格式矩阵、协议 Markdown 渲染、设置与自检、主题切换、日志、`Ctrl+K` 命令面板、
以及「页面无未捕获异常 / 控制台无错误输出」。

> 为了让 `#view button` 上的 `innerText` 在任何情况下都可用（验收脚本会 `.trim()` 它），
> 所有「只有图标」的按钮都必须带 `visually-hidden` 文本（`dom.js` 的 `srText()`）。
> 新增图标按钮时请沿用这一约定。
