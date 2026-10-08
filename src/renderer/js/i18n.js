/**
 * i18n.js —— 界面语言（2.2.1）
 *
 * 设计取舍：**用中文原文当 key**。
 *   · 中文是恒等映射 —— 中文界面零风险，不需要维护一份中文词典
 *   · 英文查表，缺条目就回退中文（永远不会出现空白或 undefined）
 *   · 调用点只包一层 t('原文')，翻译表按原文索引，加语言不用改结构
 * 带参数的句子写成 t('共 {n} 个可用内核', { n: 5 })。
 *
 * 覆盖范围（2.2.1）：外壳（导航 / 顶栏 / 状态栏 / 命令面板 / 通知 / 弹窗 / 抽屉 / 开启动画）
 * 与设置页。六个视图正文在 2.2.2 补齐 —— 未覆盖的字符串会原样显示中文，
 * 不会变成空白。
 */

const STORAGE_KEY = 'khs.locale';

export const LOCALES = [
  { id: 'zh-CN', label: '简体中文' },
  { id: 'en-US', label: 'English' },
];

/** 英文词典：中文原文 → 英文。缺条目自动回退中文。 */
const EN = {
  /* ---------------------------------------------------------------- 导航 */
  '转换': 'Convert',
  '队列': 'Queue',
  '插件': 'Plugins',
  '格式': 'Formats',
  '协议': 'Protocol',
  '日志': 'Logs',
  '设置': 'Settings',
  '命令面板': 'Command palette',
  '视图导航': 'Views',
  '主导航': 'Main navigation',
  '{label}（{kbd}）': '{label} ({kbd})',
  '命令面板（{kbd}）': 'Command palette ({kbd})',

  /* ---------------------------------------------------------------- 顶栏 */
  'KernelHub Studio': 'KernelHub Studio',
  '切换深浅主题': 'Toggle light / dark theme',
  '切换到深色主题': 'Switch to dark theme',
  '切换到浅色主题': 'Switch to light theme',
  '最小化窗口': 'Minimize window',
  '最大化窗口': 'Maximize window',
  '向下还原窗口': 'Restore window',
  '关闭窗口': 'Close window',
  '最小化': 'Minimize',
  '最大化': 'Maximize',
  '向下还原': 'Restore',
  '关闭': 'Close',

  /* -------------------------------------------------------------- 状态栏 */
  '应用状态': 'Application status',
  '可用内核 / 内核总数': 'Ready kernels / total',
  '队列计数': 'Queue counts',
  '待转换文件': 'Pending files',
  '运行日志行数': 'Log lines',
  '当前协议版本': 'Protocol version',
  '启动异常': 'Startup failed',
  '转换中（{n}）': 'Converting ({n})',
  '队列就绪（{n} 待处理）': 'Queue ready ({n} pending)',
  '正在启动…': 'Starting…',
  '就绪': 'Ready',
  '内核': 'Kernels',
  '可用': 'ready',
  '内核 {ready}/{total} 可用': 'Kernels {ready}/{total} ready',
  '队列 {total}（待 {queued} · 失败 {failed}）': 'Queue {total} (pending {queued} · failed {failed})',
  '待转换 {n}': 'Pending {n}',
  '队列已暂停': 'Queue paused',
  '日志 {n}': 'Logs {n}',
  'CKP {v}': 'CKP {v}',
  'CKP —': 'CKP —',
  '内核状态载入中…': 'Loading kernel status…',

  /* ------------------------------------------------------------ 命令面板 */
  '输入命令、视图、内核或格式名…': 'Type a command, view, kernel or format…',
  '↑↓ 选择': '↑↓ select',
  'Enter 执行': 'Enter run',
  'Esc 关闭': 'Esc close',
  '{n} 项': '{n} items',
  '没有匹配项': 'No matches',
  '换个关键词，或直接用快捷键操作。': 'Try another keyword, or use a shortcut.',
  '命令': 'Commands',
  '视图': 'Views',

  /* ---------------------------------------------------------------- 通知 */
  '操作成功': 'Done',
  '操作失败': 'Failed',
  '注意': 'Notice',
  '提示': 'Info',
  '关闭通知': 'Dismiss notification',
  '已复制': 'Copied',
  '{n} 个字符': '{n} characters',
  '复制失败': 'Copy failed',
  '当前环境不允许访问剪贴板，请手动选择文本': 'Clipboard access is blocked here — select the text manually',
  '[通知] {title}：{text}': '[notice] {title}: {text}',
  '[通知] {title}': '[notice] {title}',

  /* ---------------------------------------------------------------- 抽屉 */
  '高级': 'Advanced',
  '关闭高级面板（Esc）': 'Close advanced panel (Esc)',

  /* ---------------------------------------------------------------- 弹窗 */
  '确定': 'OK',
  '取消': 'Cancel',
  '关闭（Esc）': 'Close (Esc)',

  /* ------------------------------------------------------------ 开启动画 */
  '正在启动': 'Starting',
  '读取运行环境': 'Reading environment',
  '载入内核与队列': 'Loading kernels and queue',
  '准备界面': 'Preparing interface',
  '正在启动 KernelHub Studio': 'KernelHub Studio is starting',

  /* -------------------------------------------------------- 设置：分类名 */
  '外观': 'Appearance',
  '语言与区域': 'Language & region',
  '插件与内核': 'Plugins & kernels',
  '队列与性能': 'Queue & performance',
  '路径': 'Paths',
  '关于': 'About',
  '设置分类': 'Settings sections',
  '左侧选分类，右侧只显示该分类的字段；所有改动立即写回主进程。':
    'Pick a section on the left; changes are written back immediately.',

  /* ------------------------------------------------------------ 设置：外观 */
  '主题': 'Theme',
  '浅色': 'Light',
  '深色': 'Dark',
  '浅色为默认；切换后立即生效并写入设置。': 'Light is the default; changes apply immediately.',
  '界面约定': 'Interface conventions',
  '数字右对齐并使用等宽数字（tabular-nums）、表格不用斑马纹、颜色只用于状态。':
    'Numbers are right-aligned with tabular figures, tables have no zebra stripes, colour is reserved for status.',
  '语言': 'Language',
  '界面语言': 'Interface language',
  '切换后界面会重新加载。当前已英文化的范围：导航、顶栏、状态栏、命令面板、通知与设置页；各视图正文将在后续版本补齐。':
    'The interface reloads after switching. English currently covers navigation, top bar, status bar, command palette, notifications and the settings page; view contents follow in a later version.',
  '数字与时间格式': 'Number & time format',
  '固定为以下约定（避免同一屏出现两种写法）：': 'Fixed conventions (so one screen never mixes two styles):',
  '数字使用千分位分组；表格中的数字右对齐并启用等宽数字（tabular-nums）。':
    'Numbers use thousands separators; table figures are right-aligned with tabular numerals.',
  '时间使用 24 小时制，完整格式为 YYYY-MM-DD HH:MM:SS，日志中只显示 HH:MM:SS。':
    'Time is 24-hour; the full format is YYYY-MM-DD HH:MM:SS, logs show HH:MM:SS only.',
  '文件体积按 1024 进制换算（B / KB / MB / GB / TB）。':
    'File sizes use binary units (B / KB / MB / GB / TB).',

  /* -------------------------------------------------- 设置：插件与内核 */
  '内核仓库': 'Kernel repository',
  '仓库目录': 'Repository directory',
  '该目录由主进程在启动时探测得到（也可以由环境变量指定），界面上是只读的。':
    'Resolved by the main process at startup (or via an environment variable); read-only here.',
  '在资源管理器中打开内核仓库目录': 'Open the kernel repository folder',
  '额外插件目录': 'Extra plugin directories',
  '还没有额外插件目录。': 'No extra plugin directories yet.',
  '移除该目录': 'Remove this directory',
  '添加一个额外的内核插件目录': 'Add an extra kernel plugin directory',
  '选择额外的插件目录': 'Choose an extra plugin directory',
  '插件目录已添加': 'Plugin directory added',
  '插件目录已移除': 'Plugin directory removed',
  '添加目录': 'Add directory',
  '扫描': 'Scanning',
  '启动时自动扫描内核': 'Scan kernels on startup',
  '关闭后启动不会重新探测依赖，需要在「插件 → 已安装」里手动点「重新扫描」。':
    'When off, dependencies are not re-probed at startup — use Rescan on the Plugins → Installed tab.',
  '已停用内核': 'Disabled kernels',
  '前往插件页管理': 'Manage on the Plugins page',
  '搜索路径': 'Search paths',
  '运行时搜索路径': 'Runtime search paths',
  '依赖安装': 'Dependency install',
  'pip 源': 'pip index',
  '插件缺 Python 依赖时的自动安装源（默认清华镜像）。装不上会自动回退到 PyPI 官方源。':
    'Where missing Python dependencies are installed from (defaults to the Tsinghua mirror); falls back to PyPI automatically.',
  '复制搜索路径': 'Copy search path',
  '已保存': 'Saved',

  /* ------------------------------------------------ 设置：队列与性能 */
  '并发': 'Concurrency',
  '同时执行的内核进程数': 'Number of kernel processes running at once',
  '超时': 'Timeout',
  '单个作业的超时秒数': 'Per-job timeout in seconds',
  '{n} 秒': '{n} s',
  '日志缓冲': 'Log buffer',
  '最多保留的日志行数': 'Maximum retained log lines',
  '日志超过上限后会丢弃最早的行；日志页可以手动清空。':
    'Oldest lines are dropped past the limit; the Logs page can clear them manually.',

  /* ------------------------------------------------------------ 设置：路径 */
  '应用路径': 'Application paths',
  '内核与协议路径': 'Kernel & protocol paths',
  '应用目录': 'Application directory',
  '资源目录': 'Resources directory',
  '用户数据目录': 'User data directory',
  '内核仓库目录': 'Kernel repository directory',
  '插件目录': 'Plugins directory',
  '适配器 SDK': 'Adapter SDK',
  '协议资产': 'Protocol assets',
  '种子插件': 'Seed plugins',
  Python: 'Python',
  'Python 由主进程在启动时探测，内核适配器以它为运行时。':
    'Detected by the main process at startup; kernels use it as their runtime.',
  '版本': 'Version',

  /* ------------------------------------------------------------ 设置：关于 */
  '应用版本': 'App version',
  '协议版本': 'Protocol version',
  '设置结构': 'Settings schema',
  '平台': 'Platform',
  '开发模式': 'Development mode',
  '是': 'Yes',
  '否': 'No',
  '自检': 'Diagnostics',
  '自检结果': 'Diagnostics result',
  '重试': 'Retry',
  '复制自检报告': 'Copy diagnostics report',
  '需要处理的内核': 'Kernels needing attention',
  '全部内核都可用，没有需要补齐的依赖。': 'All kernels are ready — no missing dependencies.',
  '依赖已就绪': 'Dependencies ready',
  '缺少依赖': 'Missing dependencies',
  '安装命令': 'Install command',

  /* ------------------------------------------------------------ 设置：更新 */
  '更新': 'Updates',
  '当前版本': 'Current version',
  '最新版本': 'Latest version',
  '安装包': 'Installer',
  '检测更新': 'Check for updates',
  '检测中…': 'Checking…',
  '点「检测更新」到 GitHub 上查看同大版本是否有新版本。':
    'Click Check for updates to see whether a newer release exists in the same major version.',
  '正在查询 GitHub Release…': 'Querying GitHub releases…',
  '到 GitHub Release 上找工作目录大版本里最新的版本': 'Look for the newest release in the same major version',
  '已是最新': 'Up to date',
  '已是最新（{major}.x 里最新为 {latest}）': 'Up to date (newest {major}.x is {latest})',
  '检测失败': 'Check failed',
  '发现新版本': 'Update available',
  '发现新版本 {latest}（{major}.x 系列）。更新会下载安装包并启动安装向导，按向导完成即可；已安装的插件与设置不会丢。':
    'Version {latest} is available in the {major}.x line. Updating downloads the installer and launches the setup wizard; installed plugins and settings are kept.',
  '下载并启动安装': 'Download and install',
  '下载安装包并启动安装向导': 'Download the installer and launch the setup wizard',
  '查看更新说明': 'Release notes',
  '在浏览器里打开 Release 页面': 'Open the release page in your browser',
  '检测失败：{error}': 'Check failed: {error}',
  '下载失败：{error}': 'Download failed: {error}',
  '下载失败': 'Download failed',
  '下载异常：{error}': 'Download error: {error}',
  '已下载到 {path}，但启动安装程序失败：{error}': 'Downloaded to {path}, but launching the installer failed: {error}',
  '下载并静默安装': 'Download & install',
  '下载后静默安装到第一次安装时选定的目录': 'Download, then install silently into the folder chosen at first install',
  '安装包已下载（{size}）并已静默启动：会按第一次安装时的设置在后台完成更新，本窗口稍后会自动关闭。':
    'The installer ({size}) has been downloaded and started silently: it updates in the background using the settings from your first install, and this window will close shortly.',
  '发现新版本 {latest}（{major}.x 系列）。更新会关闭本窗口并静默安装到第一次安装时选定的目录，完成后重新打开即可；已安装的插件与设置不会丢。':
    'Version {latest} is available in the {major}.x line. Updating closes this window and installs silently into the folder chosen at first install; reopen the app afterwards. Installed plugins and settings are kept.',
  '下载完成，正在静默安装…': 'Download complete, installing silently…',
  '便携版不会自动替换正在运行的程序：已在资源管理器中打开 {path}，用新版本覆盖即可。':
    'The portable build cannot replace itself while running: {path} has been opened in Explorer — overwrite it with the new version.',
  '准备下载…': 'Preparing download…',
  '开始下载…': 'Starting download…',
  '下载中 {percent}%（{got} / {total}）': 'Downloading {percent}% ({got} / {total})',
  '下载完成，正在启动安装向导…': 'Download complete, launching the setup wizard…',
  '准备下载…': 'Preparing download…',
  '{name}　{size}': '{name}  {size}',

  /* ------------------------------------------------------------ 通用词 */
  '添加文件': 'Add files',
  '添加目录': 'Add folder',
  '清空列表': 'Clear list',
  '刷新': 'Refresh',
  '复制': 'Copy',
  '重置': 'Reset',
  '应用': 'Apply',
  '打开目录': 'Open folder',
  '重新扫描': 'Rescan',
  '刷新目录': 'Refresh catalog',
  '打开插件目录': 'Open plugin folder',
  '已安装': 'Installed',
  '可安装': 'Available',

  /* ------------------------------------ 外壳与设置里逐条补齐的零散文案（2.2.1） */
  '界面操作失败': 'Action failed',
  '未知原因': 'Unknown reason',
  '命令面板搜索': 'Command palette search',
  '0 项': '0 items',
  '排队中': 'Queued',
  '转换中': 'Converting',
  '已完成': 'Done',
  '失败': 'Failed',
  '已取消': 'Cancelled',
  '查看详情': 'View details',
  '前往': 'Go to',
  '设置已保存': 'Settings saved',
  '正在重新扫描内核…': 'Rescanning kernels…',
  '内核已刷新': 'Kernels refreshed',
  '打开产物': 'Open output',
  '详情': 'Details',
  '添加到待转换列表': 'Add to the pending list',
  '没有新增文件': 'No new files',
  '添加目录（递归展开）': 'Add folder (expand recursively)',
  '目录': 'Folder',
  '没有可用的文件': 'No usable files',
  '文件已在列表中': 'Already in the list',
  '回到转换': 'Back to Convert',
  '队列已空闲': 'Queue idle',
  '没有识别到文件路径': 'No file paths recognised',
  '拖入内容': 'Dropped content',
  '开始转换': 'Start conversion',
  '刷新内核': 'Refresh kernels',
  '该操作当前不可用': 'This action is currently unavailable',
  '选择文件加入待转换列表': 'Pick files to add to the pending list',
  '递归展开目录并加入待转换列表': 'Expand a folder recursively into the pending list',
  '把当前待转换列表提交到队列': 'Submit the pending list to the queue',
  '清空待转换列表': 'Clear the pending list',
  '不移除磁盘上的文件': 'Files on disk are not removed',
  '打开高级面板': 'Open the advanced panel',
  '内核参数 / 输出目录 / 命令行预览': 'Kernel params / output folder / command preview',
  '重新扫描并重新探测依赖': 'Rescan and re-probe dependencies',
  '主题会写入设置并持久化': 'The theme is saved to settings',
  '打开最近输出目录': 'Open the last output folder',
  '打开内核仓库目录': 'Open the kernel repository',
  '运行自检并查看结果': 'Run diagnostics and view the result',
  'Node / Electron / Python / 内核探测摘要': 'Node / Electron / Python / kernel probe summary',
  '清空运行日志': 'Clear the runtime log',
  '同时清理主进程日志缓冲': 'Also clears the main-process log buffer',
  '日志已清空': 'Log cleared',
  '第一条成功': 'First success',
  '第二条成功': 'Second success',
  '一条错误': 'One error',
  '未处理的异步错误': 'Unhandled async error',
  '重新加载': 'Reload',
  '关闭对话框': 'Close dialog',
  '对话框操作失败': 'Dialog action failed',
  '已复制到剪贴板': 'Copied to clipboard',
  '路径已复制': 'Path copied',
  '命令行预览': 'Command preview',
  '真实命令行预览': 'Real command preview',
  '不会执行任何命令': 'No command will be executed',
  '复制 argv': 'Copy argv',
  '已复制 argv': 'argv copied',
  '浅色': 'Light',
  '深色': 'Dark',
  '设置值': 'Setting value',
  '该目录已经在列表里': 'That folder is already in the list',
  '并发上限（1–8）': 'Concurrency limit (1–8)',
  '单次调用超时（毫秒）': 'Per-call timeout (ms)',
  'Node（自检）': 'Node (diagnostics)',
  '可用内核': 'Ready kernels',
  '状态': 'Status',
  '安装提示': 'Install hint',
  '原始自检数据': 'Raw diagnostics data',
  'doctor() 返回值（截断展示）': 'doctor() return value (truncated)',
  '自检报告已复制': 'Diagnostics report copied',
  '界面采用瑞士风格（International Typographic Style）：网格、无衬线字、左对齐、大量留白，只用黑白灰加一个红点。浅色是默认主题，深色用于夜间或投影环境。':
    'The interface follows the Swiss (International Typographic) style: grid, sans-serif type, left alignment, generous white space, black/white/grey plus one red accent. Light is the default; dark suits night work or projection.',
  '主题写入设置并持久化，顶栏右侧的图标按钮可以在任何视图里快速切换。':
    'The theme is persisted to settings; the icon button in the top bar switches it from any view.',
  '每屏可见按钮不超过 10 个：详细配置都收在「高级」抽屉里。表格行末的图标操作、字段里的浏览按钮不算按钮数量。':
    'At most 10 visible buttons per screen: detailed options live in the Advanced drawer. Row icon actions and field browse buttons do not count.',

  /* ============================================================ 各视图（2.2.3）
   * 以下按文件分组补齐六个视图与外壳的文案。key 就是中文原文；
   * 带 {0}/{1} 的是位置参数（由 codemod 从模板字面量自动生成）。 */

  /* ---------------------------------------------------------- 转换视图 */
  '目标格式': 'Target format',
  '添加文件到待转换列表': 'Add files to the pending list',
  '清空待转换列表（不会删除磁盘文件）': 'Clear the pending list (files on disk are kept)',
  '清空待转换列表？': 'Clear the pending list?',
  '清空': 'Clear',
  '内核参数、输出目录、命令行预览': 'Kernel params, output folder, command preview',
  '把待转换列表提交到队列（Ctrl/Cmd+Enter）': 'Submit the pending list to the queue (Ctrl/Cmd+Enter)',
  '文件名': 'File name',
  '移除': 'Remove',
  '还没有待转换文件': 'No pending files yet',
  '把文件或文件夹拖到这里，或点「选择文件」。目录会被递归展开。':
    'Drop files or folders here, or click Select files. Folders are expanded recursively.',
  '选择文件': 'Select files',
  '与源文件同目录': 'Same folder as source',
  '任务摘要': 'Task summary',
  '将使用': 'Will use',
  '输出': 'Output',
  '使用内核': 'Kernel',
  '未指定（与源文件同目录）': 'Not set (same folder as source)',
  '输出目录': 'Output folder',
  '选择输出目录': 'Choose the output folder',
  '选择输出目录失败': 'Failed to choose the output folder',
  '勾选「与源文件同目录」时，每个产物留在各自源文件所在目录。':
    'With “Same folder as source” on, each output stays next to its own source file.',
  '内核参数': 'Kernel params',
  '复制命令行': 'Copy command line',
  '已复制命令行': 'Command line copied',
  '只读 · 不会执行': 'Read-only · nothing runs',
  '把全部参数恢复为该内核声明的默认值': 'Reset every parameter to the default declared by the kernel',
  '参数已复位为默认值': 'Parameters reset to defaults',
  '复位为默认值': 'Reset to defaults',
  '读取目标格式失败': 'Failed to read target formats',
  '所选内核没有可用目标格式': 'The selected kernel exposes no usable target format',
  '已自动切回「自动选择内核」。': 'Switched back to “Auto-select kernel”.',
  '读取参数声明失败': 'Failed to read parameter declarations',
  '计算选核/参数失败': 'Failed to plan kernel and parameters',
  '自动选择（按质量与优先级）': 'Auto (by quality and priority)',
  '共 {0} 个可用内核；指定内核后目标格式会按其能力收敛。':
    '{0} kernels available; choosing one narrows the targets to its capabilities.',
  '无可用内核：{0}': 'No kernels available: {0}',
  '{0} / {1} 项参数': '{0} / {1} parameters',
  '移除 {0}': 'Remove {0}',
  '{0} 个文件': '{0} files',
  '合计 {0}': 'Total {0}',
  '主格式 {0}': 'Main format {0}',
  ' · 用时 {0} s': ' · took {0} s',
  '上次结果：成功 {0} · 失败 {1}{2}': 'Last run: {0} done · {1} failed{2}',
  '{0} 个待转换文件': '{0} pending files',
  '输出：{0}': 'Output: {0}',
  '内核 {0} · 输出 {1} 个文件': 'Kernel {0} · {1} output files',
  '{0}（预览取列表第一个文件为例；队列会按每个文件各自的源格式逐个执行）':
    '{0} (the preview uses the first file as an example; the queue runs each file with its own source format)',
  '没有待转换文件': 'No pending files',
  '请先添加文件。': 'Add files first.',
  '没有目标格式': 'No target format',
  '请先选择目标格式。': 'Choose a target format first.',
  '没有作业入队': 'No jobs were queued',
  '主进程没有为这些文件创建作业，请检查文件是否仍然存在。':
    'The main process created no jobs for these files — check that they still exist.',
  '已加入队列：{0} 个作业': 'Queued {0} jobs',
  '查看队列': 'View queue',
  '加入队列失败': 'Failed to queue',
  '请改用「添加文件」按钮。': 'Use the Add files button instead.',
  '{0}{1}': '{0}{1}',
  '（源 {0}）': ' (source {0})',
  '（尚未添加文件）': ' (no files added yet)',
  '—（尚未添加文件）': '— (no files added yet)',
  '（已选择与源文件同目录）': '(output goes next to each source file)',
  '源文件所在目录': 'the source file’s folder',
  '输出：与源文件同目录': 'Output: next to each source file',
  '继续': 'Resume',
  '暂停': 'Pause',
  '主进程没有返回协议文档': 'The main process returned no protocol document',

  /* ---------------------------------------------------------- 队列视图 */
  '移除已完成 / 已取消 / 失败的作业记录': 'Remove finished / cancelled / failed job records',
  '清除已完成': 'Clear finished',
  '取消所有排队中与进行中的作业': 'Cancel every queued and running job',
  '全部取消': 'Cancel all',
  '并发上限': 'Concurrency limit',
  '没有可清除的已完成作业': 'No finished jobs to clear',
  '已清除 {0} 条作业记录': 'Cleared {0} job records',
  '清除已完成作业失败': 'Failed to clear finished jobs',
  '当前没有进行中的作业': 'No jobs in progress',
  '取消全部 {0} 个排队中 / 进行中的作业？': 'Cancel all {0} queued / running jobs?',
  '已请求取消全部作业': 'Requested cancellation of all jobs',
  '取消全部作业失败': 'Failed to cancel all jobs',
  '取消作业失败': 'Failed to cancel the job',
  '已重新排队': 'Re-queued',
  '重试作业失败': 'Failed to retry the job',
  '该作业没有产物路径': 'This job has no output path',
  '读取作业日志失败：{0}': 'Failed to read the job log: {0}',
  '并发上限已设为 {0}': 'Concurrency limit set to {0}',
  '设置并发失败': 'Failed to set concurrency',
  '还没有作业': 'No jobs yet',
  '在「转换」里添加文件并开始转换，作业会按并发度在这里排队执行。':
    'Add files on the Convert page and start; jobs queue here and run according to the concurrency limit.',
  '取消该作业': 'Cancel this job',
  '重试该作业': 'Retry this job',
  '在资源管理器中定位产物': 'Show the output in Explorer',
  '文件 → 目标': 'File → target',
  '大小': 'Size',
  '耗时': 'Elapsed',
  '进度': 'Progress',
  '操作': 'Actions',
  '{0} 个作业': '{0} jobs',
  '待处理 {0}': 'Pending {0}',
  '运行 {0}': 'Running {0}',
  '已完成 {0}': 'Done {0}',
  '失败 {0}': 'Failed {0}',

  /* ---------------------------------------------------------- 插件视图 */
  '可更新': 'Update available',
  '内容已改动': 'Local changes',
  '未安装': 'Not installed',
  '非官方来源': 'Unofficial source',
  '插件视图': 'Plugins view',
  '查看已安装的插件（等于原来「内核」页的内容）': 'View installed plugins (what the old Kernels page showed)',
  '从插件仓库安装新插件': 'Install new plugins from the repository',
  '搜索插件名 / id / 格式': 'Search plugin name / id / format',
  '搜索插件': 'Search plugins',
  '插件状态': 'Plugin status',
  '重新拉取插件目录（catalog.json）': 'Re-fetch the plugin catalog (catalog.json)',
  '在资源管理器中打开插件目录': 'Open the plugin folder in Explorer',
  '目录拉取失败：{0}（显示的是本地缓存）': 'Catalog fetch failed: {0} (showing the local cache)',
  '缓存更新于 {0}': 'Cache updated {0}',
  '已安装 {0} / 共 {1} 个插件': '{0} of {1} plugins installed',
  '下载方式 {0}': 'Download mode {0}',
  '目录更新于 {0}': 'Catalog updated {0}',
  '自带依赖 {0}': 'Bundled deps {0}',
  '需外部程序: {0}': 'Needs external tools: {0}',
  '正在读取插件目录…': 'Reading the plugin catalog…',
  '首次会自动从 GitHub 拉取 catalog.json。': 'catalog.json is fetched from GitHub automatically on first use.',
  '没有匹配的插件': 'No matching plugins',
  '换个关键词或状态筛选再试。': 'Try another keyword or status filter.',
  '安装 {0}（约 {1}）': 'Install {0} (about {1})',
  '重新安装 / 更新到 {0}': 'Reinstall / update to {0}',
  '检查并自动补装该插件的依赖（Python 模块）': 'Check and auto-install this plugin’s Python dependencies',
  '卸载 {0}': 'Uninstall {0}',
  '在资源管理器中打开该插件目录': 'Open this plugin’s folder in Explorer',
  '内核状态': 'Kernel status',
  '体积': 'Size',
  '读取插件目录失败': 'Failed to read the plugin catalog',
  '{0}完成，内核已可用': '{0} finished — the kernel is ready',
  '{0}完成，但内核当前不可用': '{0} finished, but the kernel is not available right now',
  '{0}完成': '{0} finished',
  '该插件未提供内核，或清单异常；到「已安装」标签查看。':
    'This plugin provides no kernel, or its manifest is invalid — check the Installed tab.',
  '{0}插件「{1}」？': '{0} plugin “{1}”?',
  '版本：{0}': 'Version: {0}',
  '装完还需要系统 PATH 里有：{0}': 'After installing, these must also be on your PATH: {0}',
  '{0}失败': '{0} failed',
  '{0}失败：{1}': '{0} failed: {1}',
  '{0} 已就绪': '{0} is ready',
  '{0}异常': '{0} error',
  '缺少 Python 模块：{0}': 'Missing Python modules: {0}',
  '将安装的包：{0}': 'Packages to install: {0}',
  '安装位置：{0}（插件自带依赖目录，卸载时会一并删除）':
    'Install location: {0} (the plugin’s own dependency folder; removed together with the plugin)',
  '解释器：{0}': 'Interpreter: {0}',
  '另外还需要系统里已有：{0}（外部程序无法用 pip 安装）':
    'Also required on the system: {0} (external tools cannot be installed with pip)',
  '用镜像安装': 'Install from mirror',
  '从官方源安装': 'Install from official source',
  '{0} 缺少依赖': '{0} is missing dependencies',
  '正在安装 {0} 的依赖…': 'Installing dependencies for {0}…',
  '已尝试 {0}': 'Tried {0}',
  '依赖安装失败：{0}': 'Dependency install failed: {0}',
  '依赖安装失败': 'Dependency install failed',
  '依赖已安装：{0}': 'Dependencies installed: {0}',
  '来源 {0}': 'Source {0}',
  '依赖安装异常': 'Dependency install error',
  '卸载插件「{0}」？': 'Uninstall plugin “{0}”?',
  '卸载': 'Uninstall',
  '会删除 {0} 目录（{1}）。\n对应的内核会立刻从转换页消失。':
    'This deletes the folder {0} ({1}).\nIts kernel disappears from the Convert page immediately.',
  '卸载失败': 'Uninstall failed',
  '已卸载': 'Uninstalled',
  '卸载异常': 'Uninstall error',
  '打开目录失败': 'Failed to open the folder',
  '打开插件目录失败': 'Failed to open the plugin folder',

  /* ---------------------------------------------------------- 内核视图 */
  '搜索名称 / id / 格式': 'Search name / id / format',
  '搜索内核': 'Search kernels',
  '状态筛选': 'Status filter',
  '类型筛选': 'Type filter',
  '排序': 'Sort',
  '重新扫描内核目录并重新探测依赖': 'Rescan the kernel repository and re-probe dependencies',
  '内核详情': 'Kernel details',
  '全部状态': 'All statuses',
  '全部类型': 'All types',
  '按状态': 'By status',
  '按名称': 'By name',
  '按优先级': 'By priority',
  '按能力数': 'By capability count',
  '可用 {0} / 共 {1}': '{0} ready / {1} total',
  '当前显示 {0} 个': 'Showing {0}',
  '搜索路径 {0} 处': '{0} search paths',
  '扫描过程中有 {0} 条问题：{1}': '{0} issues during the scan: {1}',
  '查看内核 {0} 的详情': 'View details for kernel {0}',
  '{0}\n（点击整行查看详情）': '{0}\n(click a row for details)',
  '名称': 'Name',
  '能力': 'Capabilities',
  '参数': 'Params',
  '等 {0} 项': 'and {0} more',
  '{0} 个字符': '{0} characters',
  '概览': 'Overview',
  '切换内核启停失败': 'Failed to toggle the kernel',
  '优先级已更新': 'Priority updated',
  '更新优先级失败': 'Failed to update priority',
  '调度': 'Scheduling',
  '启用该内核': 'Enable this kernel',
  '优先级（越大越优先）': 'Priority (higher wins)',
  '能力矩阵': 'Capability matrix',
  '{0} 条': '{0}',
  '质量/模式': 'Quality / mode',
  '该内核没有声明能力。': 'This kernel declares no capabilities.',
  '参数表': 'Parameter table',
  '{0} 项': '{0}',
  '类型': 'Type',
  '默认值': 'Default',
  '说明': 'Description',
  '该内核没有声明参数。': 'This kernel declares no parameters.',
  '引擎与依赖': 'Engine & dependencies',
  '原始 kernel.json': 'Raw kernel.json',
  '{0} 字符': '{0} characters',
  '该内核的状态是「{0}」，请按上面的安装命令补齐依赖后重新扫描。':
    'This kernel is “{0}” — run the install command above, then rescan.',

  /* ---------------------------------------------------------- 格式视图 */
  '格式表': 'Format table',
  '操作表': 'Operation table',
  '操作筛选': 'Operation filter',
  '全部操作': 'All operations',
  '搜索格式或操作': 'Search formats or operations',
  '没有匹配的格式': 'No matching formats',
  '换个操作或关键词再试。': 'Try another operation or keyword.',
  '可作输入的操作': 'Operations that take it as input',
  '可作输出的操作': 'Operations that produce it',
  '内核数': 'Kernels',
  '没有匹配的操作': 'No matching operations',
  '换个关键词再试。': 'Try another keyword.',
  '输入格式数': 'Input formats',
  '输出格式数': 'Output formats',
  '格式 ': 'Format ',
  '可作输入': 'As input',
  '可作输出': 'As output',
  '涉及内核': 'Kernels involved',
  '{0} 个': '{0}',
  '作为输入时的可用目标格式（由参与的操作推出）：':
    'Target formats available when used as input (derived from the participating operations):',
  '输入格式': 'Input formats',
  '{0} 种': '{0}',
  '输出格式': 'Output formats',
  '参与内核': 'Kernels involved',
  '输入格式：': 'Input formats:',
  '输出格式：': 'Output formats:',

  /* ---------------------------------------------------------- 协议视图 */
  '文档目录': 'Contents',
  '复制整篇协议 Markdown': 'Copy the whole protocol Markdown',
  '复制全文': 'Copy full text',
  '查看三份机器可校验的 JSON Schema': 'View the three machine-checkable JSON Schemas',
  '查看 Schema': 'View schema',
  '三份机器可校验的 JSON Schema': 'Three machine-checkable JSON Schemas',
  '复制当前 Schema 原文': 'Copy the current schema source',
  '复制当前 Schema': 'Copy current schema',
  'Schema 文件': 'Schema file',
  '没有可用的 Schema': 'No schema available',
  '主进程没有返回 Schema 文件。': 'The main process returned no schema files.',
  'Schema 已复制': 'Schema copied',
  '协议全文已复制': 'Protocol text copied',
  '文档没有标题。': 'The document has no headings.',

  /* ---------------------------------------------------------- 日志视图 */
  '全部级别': 'All levels',
  '调试': 'Debug',
  '信息': 'Info',
  '警告': 'Warn',
  '错误': 'Error',
  '全部来源': 'All sources',
  '主进程': 'Main',
  '作业': 'Job',
  '日志级别': 'Log level',
  '日志来源': 'Log source',
  '搜索内容': 'Search',
  '搜索日志内容': 'Search log contents',
  '清空主进程与本地的日志缓冲': 'Clear both the main-process and local log buffers',
  '复制当前过滤结果': 'Copy the current filtered result',
  '作业 {0}': 'Job {0}',
  '显示 {0} 行 / 共 {1} 行': 'Showing {0} of {1} lines',
  '最多保留 {0} 行': 'Keeping at most {0} lines',
  '已暂停跟随，滚动到底部可恢复': 'Follow paused — scroll to the bottom to resume',
  '日志已经是空的': 'The log is already empty',
  '清空全部日志？': 'Clear all logs?',
  '清空日志失败': 'Failed to clear the log',
  '没有可复制的内容': 'Nothing to copy',
  '日志已复制': 'Log copied',
  '{0} 行': '{0} lines',

  /* ------------------------------------------------ 参数控件 / 弹窗 / 抽屉 */
  '（该参数未提供可选值）': '(no choices provided for this parameter)',
  '未选择': 'Not selected',
  '选择目录': 'Choose folder',
  '为「{0}」选择目录': 'Choose a folder for “{0}”',
  '为「{0}」选择文件': 'Choose a file for “{0}”',
  '参数「{0}」选择失败': 'Choosing a value for parameter “{0}” failed',
  '基础参数': 'Basic parameters',
  '当前组合没有可调参数': 'No tunable parameters for this combination',
  '高级参数': 'Advanced parameters',
  '展开高级参数': 'Expand advanced parameters',
  '{0} 个参数不适用于当前组合，已自动隐藏': '{0} parameters do not apply here and were hidden',
  '必填': 'Required',
  '纯文本 · {0} 字符': 'Plain text · {0} characters',
  '{0}\n（单击复制）': '{0}\n(click to copy)',
  'argv（{0} 项）': 'argv ({0} items)',

  /* ------------------------------------------------- 设置里新增的零散文案 */
  '复制{0}': 'Copy {0}',
  '切换后界面会重新加载，已英文化的范围见下表。': 'The interface reloads after switching.',
  '添加插件目录失败': 'Failed to add the plugin directory',
  '设置并发上限失败': 'Failed to set the concurrency limit',
  '≈ {0} 秒': '≈ {0} s',
  '请输入毫秒数': 'Enter milliseconds',
  '队列同时执行的作业数量；改小可以减轻机器压力，改大可以更快跑完批量任务。':
    'How many jobs run at once; lower eases the machine, higher finishes batches sooner.',
  '单个内核调用超过该时长会被判定为失败；下方显示换算后的秒数。':
    'A single kernel call longer than this is treated as failed; the equivalent seconds are shown below.',
  '最多保留': 'Keep at most',
  '{n} 行': '{n} lines',
  '状态目录（设置、缓存与日志）': 'State folder (settings, cache, logs)',
  '运行目录（临时作业文件）': 'Run folder (temporary job files)',
  '内置内核目录': 'Bundled kernel folder',
  '协议 Schema 目录': 'Protocol schema folder',
  '解释器': 'Interpreter',
  '运行自检失败': 'Diagnostics failed',
  '读取应用信息失败': 'Failed to read application info',

  /* --------------------------------------------------------- 外壳（app.js） */
  '保存设置失败': 'Failed to save settings',
  '读取内核信息失败': 'Failed to read kernel info',
  '会重新探测每个内核的运行时依赖': 'Re-probes each kernel’s runtime dependencies',
  '刷新内核失败': 'Failed to refresh kernels',
  '读取队列失败': 'Failed to read the queue',
  '读取日志失败': 'Failed to read the log',
  '转换完成：{0}': 'Conversion finished: {0}',
  '打开产物失败': 'Failed to open the output',
  '转换失败：{0}': 'Conversion failed: {0}',
  '重试失败': 'Retry failed',
  '已添加 {0} 个文件': 'Added {0} files',
  '{0} 个重复文件已忽略': '{0} duplicates ignored',
  '{0} 个文件已在列表中': '{0} files were already listed',
  '选择文件失败': 'Failed to select files',
  '添加目录失败': 'Failed to add the folder',
  '所选路径下没有可识别的文件（或全部为隐藏项）':
    'No recognisable files under the selected path (or all of them are hidden)',
  '{0} 个重复已忽略': '{0} duplicates ignored',
  '共 {0} 个文件': '{0} files in total',
  '{0} 个文件此前已加入': '{0} files were added earlier',
  '展开{0}失败': 'Failed to expand {0}',
  '加载视图「{0}」失败': 'Failed to load view “{0}”',
  '视图加载失败': 'View failed to load',
  '视图模块 {0}.js 没有导出 mount()': 'View module {0}.js does not export mount()',
  '渲染视图「{0}」失败': 'Failed to render view “{0}”',
  '视图渲染失败': 'View failed to render',
  '视图「{0}」无法显示': 'View “{0}” cannot be displayed',
  '作业 {0} 退出码 {1}：{2}': 'Job {0} exited with code {1}: {2}',
  '完成 {0}': 'Done {0}',
  '取消 {0}': 'Cancelled {0}',
  '请改用「添加文件」按钮，或把文件拖到待转换列表上。':
    'Use the Add files button, or drop files onto the pending list.',
  '没有视图注册动作「{0}」。': 'No view registered the action “{0}”.',
  '执行操作失败': 'Action failed',
  '快捷键「{0}」执行失败': 'Shortcut “{0}” failed',
  '切换到{0}主题': 'Switch to the {0} theme',
  '自检失败': 'Diagnostics failed',
  '切到「{0}」': 'Switch to “{0}”',
  '{0} · {1} 个内核': '{0} · {1} kernels',
  '{0} 个内核': '{0} kernels',
  '没有可打开的{0}': 'Nothing to open: {0}',
  '该路径尚未设置。': 'That path is not set.',
  '打开{0}失败': 'Failed to open {0}',
  '应用启动失败：{0}': 'Application failed to start: {0}',
  '未知错误': 'Unknown error',
  '调用主进程失败': 'Main-process call failed',
  '内核返回失败': 'The kernel reported failure',
  '失败详情': 'Failure details',
  '所选内容不是文件': 'The dropped content is not a file',
  '请先切换到转换视图并选择文件与目标格式。':
    'Switch to the Convert view and choose files and a target format first.',
  '转换视图未就绪，无法设置目标格式': 'The Convert view is not ready — cannot set the target format',
  '尚未设置': 'Not set',
  '最近输出目录': 'Last output folder',
  '内核仓库': 'Kernel repository',
  '操作类型': 'Operations',
  '操作类型 ': 'Operations ',
  '对话框操作失败': 'Dialog action failed',
  '无法生成命令行': 'Cannot build the command line',
  '源格式': 'Source format',
  '单行命令（可直接粘贴）': 'One-line command (paste-ready)',
  '逐项参数': 'Parameter by parameter',
  '内容不是合法 JSON，已按纯文本展示。': 'Content is not valid JSON; shown as plain text.',
  '纯文本': 'Plain text',
  '确认操作': 'Confirm',
  '知道了': 'Got it',
  '详情': 'Details',
  '取消': 'Cancel',
  '复制': 'Copy',
  '设置已保存': 'Settings saved',
};

let currentLocale = 'zh-CN';

/**
 * 模块加载时**同步**确定语言。
 *
 * 这一点很关键：像 NAV_ITEMS 那样在模块顶层就调用 t('转换') 的地方，
 * 求值发生在任何异步初始化之前。而语言存在主进程的 settings.json 里，
 * 只能异步读到 —— 所以这里先用 localStorage 里的镜像值（同步可得），
 * app.js 启动时再拿 settings.locale 与之比对，不一致就 reload 一次。
 * 这样模块顶层的 t() 永远拿到正确语言，且不会出现「切了语言但导航没变」。
 */
(function bootstrapLocale() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en-US' || saved === 'zh-CN') {
      currentLocale = saved;
      document.documentElement.setAttribute('lang', saved);
      return;
    }
    const nav = (navigator && navigator.language) || 'zh-CN';
    currentLocale = /^zh/i.test(nav) ? 'zh-CN' : 'en-US';
    localStorage.setItem(STORAGE_KEY, currentLocale);
    document.documentElement.setAttribute('lang', currentLocale);
  } catch {
    /* 读不到就保持 zh-CN */
  }
})();

/** 读取初始语言：设置里存过就用它，否则跟随系统 */
export function initLocale(preferred) {
  let value = preferred;
  if (!value) {
    try {
      value = localStorage.getItem(STORAGE_KEY) || '';
    } catch {
      value = '';
    }
  }
  if (!value) {
    try {
      const nav = navigator.language || 'zh-CN';
      value = /^zh/i.test(nav) ? 'zh-CN' : 'en-US';
    } catch {
      value = 'zh-CN';
    }
  }
  currentLocale = value === 'en-US' ? 'en-US' : 'zh-CN';
  try {
    localStorage.setItem(STORAGE_KEY, currentLocale);
  } catch {
    /* 忽略：隐私模式等 */
  }
  try {
    document.documentElement.setAttribute('lang', currentLocale);
  } catch {
    /* ignore */
  }
  return currentLocale;
}

export function getLocale() {
  return currentLocale;
}

export function isEnglish() {
  return currentLocale === 'en-US';
}

/** 取当前语言下的显示名 */
export function localeLabel(id) {
  const hit = LOCALES.find((l) => l.id === id);
  return hit ? hit.label : String(id || '');
}

/**
 * 翻译。
 * @param {string} zh 中文原文（同时是词典 key）
 * @param {object} [params] {n: 5} 之类，替换 {n}
 */
export function t(zh, params) {
  const key = String(zh == null ? '' : zh);
  if (currentLocale === 'zh-CN') return applyParams(key, params);
  const hit = Object.prototype.hasOwnProperty.call(EN, key) ? EN[key] : key;
  return applyParams(hit, params);
}

function applyParams(text, params) {
  if (!params) return text;
  return String(text).replace(/\{(\w+)\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m
  );
}

/** 词典里有没有这条（自检/排查用） */
export function hasTranslation(zh) {
  return Object.prototype.hasOwnProperty.call(EN, String(zh));
}

export function translationCount() {
  return Object.keys(EN).length;
}

/* ------------------------------------------------------------------ 数据标签
 *
 * 有些文字不是界面自己的，而是**主进程算出来再传过来的**：
 *   · 内核状态   主进程给 status（ready/degraded/…）+ statusLabel（中文）
 *   · 内核类型   kind（image/media/…）+ kindLabel（中文）
 *   · 操作名     op（convert/extract/transform）+ label（中文）
 *
 * 这类文字没法用「中文原文当 key」翻译 —— 因为它们不经过 t()，
 * 而且中文是从共享表里查出来的。所以按 **id** 另做一张表：
 * 英文模式用 id 查英文，查不到就回退主进程给的中文（不会空白）。
 * 中文模式原样返回中文，行为不变。
 */
const STATUS_EN = {
  ready: 'Ready',
  degraded: 'Missing dependencies',
  invalid: 'Invalid manifest',
  unavailable: 'Not installed',
  disabled: 'Disabled',
};

const KIND_EN = {
  image: 'Image',
  document: 'Document',
  media: 'Media',
  archive: 'Archive',
  vector: 'Vector',
  data: 'Data',
  other: 'Other',
};

const OP_EN = {
  convert: 'Convert',
  extract: 'Extract',
  transform: 'Transform',
  inspect: 'Inspect',
};

function pickId(map, id, fallback) {
  if (currentLocale === 'zh-CN') return fallback == null ? '' : String(fallback);
  const hit = map[String(id || '')];
  if (hit) return hit;
  return fallback == null ? '' : String(fallback);
}

/** 内核状态的显示名（status = ready/degraded/…） */
export function statusText(status, fallback) {
  return pickId(STATUS_EN, status, fallback);
}

/** 内核类型的显示名（kind = image/media/…） */
export function kindText(kind, fallback) {
  return pickId(KIND_EN, kind, fallback);
}

/** 操作名的显示名（op = convert/extract/transform） */
export function opText(op, fallback) {
  return pickId(OP_EN, op, fallback);
}

/** 英文模式下用逗号分隔列表，中文用顿号 */
export function listSeparator() {
  return currentLocale === 'zh-CN' ? '、' : ', ';
}

export default {
  t,
  initLocale,
  getLocale,
  isEnglish,
  LOCALES,
  localeLabel,
  statusText,
  kindText,
  opText,
  listSeparator,
};
