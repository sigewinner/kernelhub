# 打包与分发（electron-builder）

本文说明怎么把 KernelHub Studio 打成 Windows 安装包 / 便携版，以及打包版为什么会那样设计。

---

## 一、四条命令

```bat
npm run build:dir        :: 只生成解包目录（最快，用来验证打包结果能不能启动）
npm run build:portable   :: 便携版单文件 exe（含镜像参数，国内网络推荐）
npm run build:mirror     :: NSIS 安装包 + 便携版（走 npmmirror 镜像）
npm run build            :: 同上，但工具链直连 GitHub（网络好时用）
```

产物统一在 `release/`：

| 文件 | 大小 | 说明 |
|---|---|---|
| `KernelHub Studio-1.0.0-setup.exe` | 约 140 MB | NSIS 安装包，可选安装目录、自动建快捷方式、可卸载 |
| `KernelHub Studio-1.0.0-portable.exe` | 约 140 MB | 便携版单文件；首次运行会自解压到临时目录，启动比安装版慢十几秒 |
| `win-unpacked/` | 约 520 MB | 免安装解包目录，可直接整体拷走运行，也是上面两者的中间产物 |

> **为什么包这么大？** 因为里面装了两样东西：
> ① Electron 运行时（Chromium + Node，约 200 MB）；
> ② 随包分发的 CKP 内核仓库（`resources/hub`，约 195 MB，其中 `vendor/` 是 Pillow / PyMuPDF / FFmpeg 等内核依赖）。
> 想要小包就用 `npm run build:nohub`（约 300 MB），代价是安装后要在「设置 → 路径」里手动指向一个 kernel-hub 目录。

---

## 二、配置在哪

* **`electron-builder.config.js`** —— 真正的打包配置（不是 package.json 里的 `build` 字段）。
  单独一个文件是因为要按环境动态决定「是否把 kernel-hub 打进包」。
* **`tools/build.js`** —— 打包入口：预检 → 调 electron-builder → 列出产物。
  之所以不直接在 npm script 里调 electron-builder：
  1. `set FOO=1 && x` 是 cmd 语法，在 PowerShell/bash 下不通用；
  2. 打包前需要预检（免得把一个坏包发出去）；
  3. NSIS 工具链需要镜像与失败提示。

### 关键配置点

```js
files: ['src/**/*', 'package.json', '!src/renderer/devhost/**']
// 应用代码进 asar；浏览器开发宿主不进包（它只在开发/验收时用）

extraResources: [{ from: '../kernel-hub', to: 'hub', filter: [...排除 .cache/output/tests/__pycache__] }]
// 内核仓库必须以真实文件存在（适配器是 Python/命令行程序，不能用 asar 打包）

win: { icon: 'build/icon.ico', signExecutable: false }
// 不签名（没证书也能构建），但图标与版本信息照常写入
// 注意：不要用 signAndEditExecutable: false，那会把图标和元数据一起跳过
```

### 内核仓库是怎么被找到的

打包版把 CKP 工作区放在 `<安装目录>/resources/hub`。运行时 `src/engine/paths.js` 的探测顺序：

1. 环境变量 `KERNELHUB_ROOT` / `CKP_ROOT`（部署时强制指定用）
2. **`app.isPackaged` 且 `resources/hub` 存在 → 直接用它**
3. 设置里记录且确实合法的目录（尊重用户选择）
4. 自动探测（兄弟目录 `../kernel-hub` 等）

第 2 条优先级高于第 3 条是刻意的：开发时会把开发机路径写进设置文件，
如果打包版无条件沿用那条设置，就会去找一个不存在的目录，表现为「一个内核都没有」。

---

## 三、开发和打包的差异

| | 开发（`npm start`） | 打包版 |
|---|---|---|
| 应用代码 | 磁盘上的 `src/` | `resources/app.asar` |
| 内核仓库 | 兄弟目录 `../kernel-hub` | `resources/hub`（随包） |
| 浏览器开发宿主 | 可用（`npm run devhost`） | 不含 |
| 开发者工具 | `npm start --dev` 自动打开 | 需手动菜单打开 |

---

## 四、怎么验证打出来的包真的能用

```bat
npm run verify:package               :: 把 win-unpacked 复制到工作区外，跑自检并读报告
npm run verify:portable              :: 验证便携版单文件（含自解压过程）
node tools\verify-package.js --launch-check   :: 额外真的启动窗口（会留在桌面上，手动关）
```

验证脚本做三件事：

1. **把打包目录复制到工作区外再运行** —— 见下面第五节，这一步是必须的；
2. 用 `--selftest` 启动应用：它会依次检查「定位内核仓库 → 发现内核 → Python 可用 →
   协议文档/Schema 可读 → 渲染进程加载 + 桥接就绪 + 导航渲染 → 真实转换」，把结果写成 JSON；
3. 汇总报告，关键链路全过才算通过。

应用本身也内置了这个自检开关，方便你在客户现场排查：

```bat
"KernelHub Studio.exe" --selftest --selftest-out D:\report.json
```

---

## 五、本机环境的两个坑（重要）

### 坑 1：低完整性目录会让 Electron 完全起不来（这就是「双击没反应」）

**现象**：双击 `release\win-unpacked\KernelHub Studio.exe`，**什么都没有发生**——
没有报错、没有窗口，40 秒内连一个进程都不留。

**根因（已用对照实验确证）**：程序所在目录被标记为**低完整性**。

```
> icacls "D:\AAA_develop\01_program_pdf"
  Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)
```

* 这是 Windows 的**强制完整性控制（Mandatory Integrity Control）**，
  **不是文件权限** —— 该目录 ACL 里 `SIGEWINNE\nahida:(F)` 本来就是完全控制。
  改权限、用管理员运行、关 UAC 全都没用：内核策略在 ACL 之前生效。
* Chromium 的渲染进程与 GPU 进程以**低完整性**运行（这就是它的沙箱机制）。
  它们启动时需要在程序目录里创建临时文件、并向上请求更高完整性的对象，
  而 `(NW)` = **No-Write-Up** 恰好禁止这个方向，于是被内核直接拒绝。
* 结果：浏览器内核在主进程 JS 执行之前就退出，退出码 `0x80000003`（`STATUS_BREAKPOINT`）。

**对照实验（本机实测，同一份 exe，SHA256 一致）**：

| 位置 | 目录标签 | 结果 |
|---|---|---|
| `release\win-unpacked`（工作区内） | Low Mandatory Level (NW) | 40 秒内 **0 个进程**，无窗口 |
| 同一份 exe 复制到 `%TEMP%` | 无标签（中完整性） | **4 秒出现窗口**（4 个进程） |
| 安装到 `%LOCALAPPDATA%\Programs\KernelHub Studio` | 无标签 | **2 秒出现窗口** |

**处理办法**：

```bat
npm run integrity              :: 先确认目录标签（出现 Low Mandatory Level 就是它）
安装到可运行目录.bat            :: 一键复制到 %LOCALAPPDATA%\Programs 并启动
npm run install:local -- --dir "D:\Apps\KernelHub Studio"   :: 指定目标目录
npm run browser                :: 或者直接用浏览器版界面（功能一致）
npm run verify:window          :: 从工作区外正常启动一次，确认窗口出现
npm run diag:launch            :: 工作区内 vs 工作区外对照实验，自动给结论
```

**别做的事**：不要用 `icacls` 去掉这个标签。工作区的完整性标签是宿主环境（DSH）的安全设置，
去掉等于削弱隔离；正确做法是把程序放到普通目录运行。

### 坑 2：electron-builder 构建 NSIS 时要联网下工具链

第一次构建安装包需要从 GitHub 下 `nsis` / `winCodeSign` / `7zip`，国内网络容易 TLS 超时。
用 `--mirror`（或 `npm run build:mirror`）走 npmmirror 即可：

```bat
npm run build:mirror
:: 等价于设置下面两个环境变量后执行 npm run build
::   ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
::   ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

---

## 六、常见问题

**Q：装完打开，内核显示 0 个？**
A：看「设置 → 路径与自检」。如果 `hubRoot` 指向一个不存在的路径，把它清空后点「重新扫描」，
或手动指到真正的 kernel-hub 目录；也可以在启动前设 `KERNELHUB_ROOT`。

**Q：便携版第一次打开要等很久？**
A：正常。便携版要先把自己（140 MB）解压到临时目录，之后启动就快了。
要更快的启动体验就用 NSIS 安装版。

**Q：想换图标？**
A：替换 `build/icon.ico`（含 16/24/32/48/64/128/256 多尺寸）。没有现成图标可以
`npm run icon` 重新生成内置那套（青蓝渐变立方体）。

**Q：安装包没签名，Windows 会弹「未知发布者」？**
A：不签名就会这样。要消掉需要代码签名证书，在 `electron-builder.config.js` 里配置
`win.certificateFile` / `certificatePassword`（或改用 `--no-sign` 之外的方式），并把
`signExecutable` 去掉。

**Q：怎么只给某个客户打包，且不带内核仓库？**
A：`npm run build:nohub`，安装后让他把 `KERNELHUB_ROOT` 指到公司的共享内核目录。
