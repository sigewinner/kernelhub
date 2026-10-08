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

export default { t, initLocale, getLocale, isEnglish, LOCALES, localeLabel };
