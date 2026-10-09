/*
 * Setup.cs —— KernelHub Studio 自绘安装器（2.2.7 起）
 *
 * 为什么不用 NSIS 的界面：
 *   官方 NSIS 只能换图与文案（MUI2 没有任何颜色/皮肤 define，工具链里也没有皮肤引擎），
 *   做不出「无系统标题栏 + 圆角 + 品牌色大按钮 + 动画」这种现代安装界面。
 *   所以自己写一个：窗口自绘（GDI+），只用 Windows 自带的 .NET Framework，
 *   由 tools/build-installer.js 用 csc.exe 编译成单个 exe。
 *
 * 组成：
 *   · 本文件         安装器 UI + 安装逻辑
 *   · Uninstall.cs   卸载器（编译后作为资源嵌进来，安装时写到目标目录）
 *   · 资源           payload.7z（应用本体）、sevenzip.exe（解压用）、uninstall.exe
 *
 * 命令行：
 *   （无参数）        显示界面
 *   /S               静默安装（供应用内更新调用），不显示界面、不启动应用
 *   --updated        与 /S 同时出现时表示「更新」：先结束正在运行的实例
 *   /D=<目录>        指定安装目录（静默模式也用得上）
 *   /NOLAUNCH        装完不启动
 *
 * 【重要】这份代码要用 .NET Framework 自带的 csc.exe 编译，那是 **C# 5** 编译器：
 *   不能用 $"" 插值、?. 、nameof、表达式体成员等 C# 6+ 语法。
 *   改这个文件时请保持 C# 5 写法，否则 csc 会报一堆语法错误。
 */

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace KhsSetup
{
    internal static class Brand
    {
        // 品牌色取自应用令牌 --c-accent: #e8271b
        public static readonly Color Accent = Color.FromArgb(0xE8, 0x27, 0x1B);
        public static readonly Color AccentDark = Color.FromArgb(0xB8, 0x18, 0x0F);
        public static readonly Color Ink = Color.FromArgb(0x11, 0x11, 0x11);
        public static readonly Color Ink2 = Color.FromArgb(0x66, 0x66, 0x66);
        public static readonly Color Ink3 = Color.FromArgb(0x99, 0x99, 0x99);
        public static readonly Color Paper = Color.FromArgb(0xFF, 0xFF, 0xFF);
        public static readonly Color Rule = Color.FromArgb(0xE4, 0xE4, 0xE4);
        public static readonly Color Hover = Color.FromArgb(0xF4, 0xF4, 0xF4);
        public static readonly Color Track = Color.FromArgb(0xEE, 0xEE, 0xEE);
        public static readonly Color Warn = Color.FromArgb(0xC8, 0x6A, 0x00);

        public static Font Ui(float size, FontStyle style)
        {
            // 中文优先用雅黑；拿不到就退回系统默认无衬线
            try { return new Font("Microsoft YaHei UI", size, style); }
            catch { return new Font(FontFamily.GenericSansSerif, size, style); }
        }
    }

    /** 安装参数 */
    internal sealed class Options
    {
        public bool Silent;
        public bool Updated;
        public bool NoLaunch;
        public string Dir;

        public static Options Parse(string[] args)
        {
            Options o = new Options();
            foreach (string raw in args)
            {
                string a = raw == null ? "" : raw.Trim();
                if (a.Length == 0) continue;
                if (a.Equals("/S", StringComparison.OrdinalIgnoreCase)) o.Silent = true;
                else if (a.Equals("--updated", StringComparison.OrdinalIgnoreCase)) o.Updated = true;
                else if (a.Equals("/NOLAUNCH", StringComparison.OrdinalIgnoreCase)) o.NoLaunch = true;
                else if (a.StartsWith("/D=", StringComparison.OrdinalIgnoreCase)) o.Dir = a.Substring(3).Trim('"');
                else if (a.StartsWith("/DIR=", StringComparison.OrdinalIgnoreCase)) o.Dir = a.Substring(5).Trim('"');
            }
            return o;
        }
    }

    internal static class Paths
    {
        public const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\KernelHub Studio";
        public const string PreferredDir = @"D:\KernelHub Studio";

        public static string AppDataDir()
        {
            return Path.Combine(
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs"),
                "KernelHub Studio");
        }

        /** 目录（或其最近存在的上级）能不能写 —— 用来判断候选安装目录是否可用 */
        public static bool Writable(string dir)
        {
            try
            {
                string probe = dir;
                while (!Directory.Exists(probe))
                {
                    string parent = Path.GetDirectoryName(probe);
                    if (string.IsNullOrEmpty(parent) || parent == probe) break;
                    probe = parent;
                }
                string file = Path.Combine(probe, "khs-wprobe-" + Guid.NewGuid().ToString("N") + ".tmp");
                File.WriteAllText(file, "probe");
                File.Delete(file);
                return true;
            }
            catch { return false; }
        }

        /**
         * 默认安装目录（默认放 D 盘）：
         *   1. 上次装过就沿用（读 HKCU 的 InstallLocation）
         *   2. D 盘存在 → D:\KernelHub Studio
         *   3. 没有 D 盘 → %LOCALAPPDATA%\Programs\KernelHub Studio
         *
         * 注意这里**不按「当前进程能不能写」来挑**：受限环境（低完整性）下进程
         * 哪个用户目录都写不了，按可写性回退会错显示成 C 盘，把用户绕晕
         * （实测就是这样：明明要装 D 盘，界面却显示 C 盘）。
         * 能不能写由安装前的前置检查负责报错。
         */
        public static string DefaultDir()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(UninstallKey))
                {
                    if (k != null)
                    {
                        string loc = k.GetValue("InstallLocation") as string;
                        if (!string.IsNullOrEmpty(loc)) return loc;
                    }
                }
            }
            catch { }

            try
            {
                DriveInfo d = new DriveInfo("D");
                if (d.IsReady) return PreferredDir;
            }
            catch { }

            return AppDataDir();
        }

        public static string StartMenuLink()
        {
            return Path.Combine(
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    @"Microsoft\Windows\Start Menu\Programs"),
                "KernelHub Studio.lnk");
        }

        public static string DesktopLink()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                "KernelHub Studio.lnk");
        }
    }

    /** 解压 + 安装，带进度回调；非致命问题收集成 warnings */
    internal sealed class Installer
    {
        public const string ExeName = "KernelHub Studio.exe";

        private readonly string _target;
        private readonly Action<int, string> _report;
        public readonly List<string> Warnings = new List<string>();

        public Installer(string target, Action<int, string> report)
        {
            _target = target;
            _report = report;
        }

        public void Run()
        {
            Say(0, "正在准备…");

            /*
             * 前置检查，装不进去就别浪费时间去解压 90MB。
             * 这里刻意把两种失败分开报，用户才知道下一步该做什么。
             */
            if (Restricted())
            {
                throw new InvalidOperationException(
                    "这个安装包所处的位置受限（低完整性），Windows 不允许它写入用户目录，" +
                    "所以装不上。把安装包复制到 D:\\ 或桌面，再从副本运行即可 —— 不需要管理员权限。" +
                    "当前文件：" + Assembly.GetExecutingAssembly().Location);
            }
            if (!Paths.Writable(_target))
            {
                throw new InvalidOperationException(
                    "无法写入 " + _target + "。请点「更改」换一个安装目录。");
            }

            /*
             * 装之前先结束正在运行的实例。
             * 以前只在静默更新（/S --updated）时才做，界面安装这条路径没做 ——
             * 结果应用开着时 exe/dll 被占用，复制失败，表现就是「界面能看、装不上」。
             */
            int killed = KillRunning();
            if (killed > 0)
            {
                Say(1, "已关闭正在运行的程序（" + killed + " 个）");
                Thread.Sleep(600);
            }

            Directory.CreateDirectory(_target);
            string temp = MakeTempDir();
            Program.Log("使用临时目录: " + temp);
            try
            {
                string sevenZip = Path.Combine(temp, "sevenzip.exe");
                WriteResource("sevenzip.exe", sevenZip);
                string payload = Path.Combine(temp, "payload.7z");
                WriteResource("payload.7z", payload);

                Say(4, "正在解压应用文件…");
                Extract(sevenZip, payload, temp);

                Say(88, "正在复制到安装目录…");
                CopyTree(Path.Combine(temp, "app"), _target);

                string exePath = Path.Combine(_target, ExeName);
                if (!File.Exists(exePath))
                {
                    throw new InvalidOperationException(
                        "主程序没有复制成功。" + (Warnings.Count > 0 ? "（" + Warnings[0] + "）" : "") +
                        " 请先关闭正在运行的 KernelHub Studio 再试一次。");
                }

                Say(93, "正在写入卸载信息…");
                try
                {
                    WriteResource("uninstall.exe", Path.Combine(_target, "uninstall.exe"));
                }
                catch (Exception ex) { Warn("卸载程序写入失败：" + ex.Message); }

                Say(95, "正在创建快捷方式…");
                // 装到临时目录（自检/测试）时不建桌面快捷方式，免得污染桌面
                CreateShortcuts(_target.StartsWith(Path.GetTempPath(), StringComparison.OrdinalIgnoreCase));

                Say(98, "正在写入注册表…");
                WriteRegistry(Path.Combine(_target, "uninstall.exe"));

                Say(100, Warnings.Count == 0 ? "安装完成" : "安装完成（" + Warnings.Count + " 条提示）");
            }
            finally
            {
                try { Directory.Delete(temp, true); } catch { }
            }
        }

        private void Warn(string text)
        {
            Warnings.Add(text);
            Program.Log("警告: " + text);
        }

        private void Say(int percent, string text)
        {
            if (_report != null) _report(percent, text);
        }

        /**
         * 找一个能建目录的临时位置，依次尝试：
         *   %TEMP% → %LOCALAPPDATA% → exe 同目录 → 系统盘根目录
         *
         * 为什么这么写：实测在某些环境下（安装包本身带着低完整性标签，或所在目录受限），
         * 进程在 %TEMP% 下 Directory.CreateDirectory 会拿到 ACCESS_DENIED。
         * 安装器不该因为「临时目录选得不好」就整个失败。
         */
        private static string MakeTempDir()
        {
            List<string> roots = new List<string>();
            try { roots.Add(Path.GetTempPath()); } catch { }
            try { roots.Add(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)); } catch { }
            try { roots.Add(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location)); } catch { }
            try { roots.Add(Path.GetPathRoot(Environment.SystemDirectory)); } catch { }

            List<string> errors = new List<string>();
            foreach (string root in roots)
            {
                if (string.IsNullOrEmpty(root)) continue;
                string candidate = Path.Combine(root, "khs-setup-" + Guid.NewGuid().ToString("N"));
                try
                {
                    Directory.CreateDirectory(candidate);
                    return candidate;
                }
                catch (Exception ex)
                {
                    errors.Add(root + " → " + ex.Message);
                    Program.Log("临时目录候选失败: " + root + " → " + ex.Message);
                }
            }
            throw new InvalidOperationException("找不到可写的临时目录。" + string.Join(" | ", errors.ToArray()));
        }

        private static void WriteResource(string name, string dest)
        {
            Assembly asm = Assembly.GetExecutingAssembly();
            using (Stream s = asm.GetManifestResourceStream(name))
            {
                if (s == null) throw new InvalidOperationException("安装包缺少资源：" + name);
                using (FileStream fs = new FileStream(dest, FileMode.Create, FileAccess.Write))
                {
                    byte[] buf = new byte[1 << 20];
                    int n;
                    while ((n = s.Read(buf, 0, buf.Length)) > 0) fs.Write(buf, 0, n);
                }
            }
        }

        /** 调 7za 解压；7za -bsp1 会把百分比打到 stdout，逐行解析 */
        private void Extract(string sevenZip, string payload, string temp)
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = sevenZip;
            psi.Arguments = "x \"" + payload + "\" -o\"" + temp + "\" -y -bsp1";
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.StandardOutputEncoding = Encoding.UTF8;

            using (Process p = Process.Start(psi))
            {
                string line;
                while ((line = p.StandardOutput.ReadLine()) != null)
                {
                    Match m = Regex.Match(line, @"(\d+)\s*%");
                    if (m.Success)
                    {
                        int pct;
                        if (int.TryParse(m.Groups[1].Value, out pct))
                        {
                            Say(4 + (int)(pct * 0.84), "正在解压应用文件… " + pct + "%");
                        }
                    }
                }
                p.WaitForExit();
                if (p.ExitCode != 0) throw new InvalidOperationException("解压失败（7za 退出码 " + p.ExitCode + "）");
            }
        }

        private void CopyTree(string from, string to)
        {
            Directory.CreateDirectory(to);
            foreach (string dir in Directory.GetDirectories(from, "*", SearchOption.AllDirectories))
            {
                Directory.CreateDirectory(Path.Combine(to, dir.Substring(from.Length).TrimStart('\\')));
            }
            foreach (string file in Directory.GetFiles(from, "*", SearchOption.AllDirectories))
            {
                string dest = Path.Combine(to, file.Substring(from.Length).TrimStart('\\'));
                string parent = Path.GetDirectoryName(dest);
                if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                if (!CopyWithRetry(file, dest))
                {
                    Warn("文件被占用，未能覆盖：" + Path.GetFileName(dest));
                }
            }
        }

        /** 复制失败重试几次（占用往往几百毫秒内就释放了） */
        private static bool CopyWithRetry(string from, string to)
        {
            for (int i = 0; i < 4; i++)
            {
                try
                {
                    File.Copy(from, to, true);
                    return true;
                }
                catch (IOException) { Thread.Sleep(250); }
                catch (UnauthorizedAccessException) { Thread.Sleep(250); }
            }
            try
            {
                File.Copy(from, to, true);
                return true;
            }
            catch { return false; }
        }

        private void CreateShortcuts(bool tempTarget)
        {
            string exe = Path.Combine(_target, ExeName);
            if (!MakeLink(Paths.StartMenuLink(), exe)) Warn("开始菜单快捷方式未能创建");
            if (!tempTarget)
            {
                if (!MakeLink(Paths.DesktopLink(), exe)) Warn("桌面快捷方式未能创建");
            }
        }

        private static bool MakeLink(string linkPath, string target)
        {
            try
            {
                Type t = Type.GetTypeFromProgID("WScript.Shell");
                if (t == null) return false;
                object shell = Activator.CreateInstance(t);
                object link = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { linkPath });
                Type lt = link.GetType();
                lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, link, new object[] { target });
                lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, link, new object[] { Path.GetDirectoryName(target) });
                lt.InvokeMember("IconLocation", BindingFlags.SetProperty, null, link, new object[] { target + ",0" });
                lt.InvokeMember("Description", BindingFlags.SetProperty, null, link, new object[] { "KernelHub Studio —— 文件格式转换工作台" });
                lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, link, null);
                Marshal.ReleaseComObject(link);
                Marshal.ReleaseComObject(shell);
                return true;
            }
            catch (Exception ex)
            {
                Program.Log("创建快捷方式失败: " + Path.GetFileName(linkPath) + " → " + ex.Message);
                return false;
            }
        }

        private void WriteRegistry(string uninstaller)
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.CreateSubKey(Paths.UninstallKey))
                {
                    if (k == null) { Warn("无法写入卸载信息（注册表不可写）"); return; }
                    string exe = Path.Combine(_target, ExeName);
                    k.SetValue("DisplayName", "KernelHub Studio");
                    k.SetValue("DisplayVersion", Program.Version);
                    k.SetValue("Publisher", "KernelHub");
                    k.SetValue("InstallLocation", _target);
                    k.SetValue("DisplayIcon", exe + ",0");
                    k.SetValue("UninstallString", "\"" + uninstaller + "\"");
                    k.SetValue("QuietUninstallString", "\"" + uninstaller + "\" /S");
                    k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                }
            }
            catch (Exception ex)
            {
                Warn("卸载信息写入失败：" + ex.Message);
            }
        }

        /** 结束正在运行的实例；返回结束掉的个数 */
        public static int KillRunning()
        {
            int n = 0;
            try
            {
                foreach (Process p in Process.GetProcessesByName("KernelHub Studio"))
                {
                    try
                    {
                        p.Kill();
                        p.WaitForExit(5000);
                        n++;
                    }
                    catch { }
                }
            }
            catch { }
            return n;
        }

        /** 诊断：把「哪些位置能建目录」记进日志，便于排障 */
        public static void Diagnose()
        {
            Program.Log("诊断: user=" + Environment.UserName + " temp=" + Path.GetTempPath() +
                        " cwd=" + Environment.CurrentDirectory);
            Probe("TEMP", Path.GetTempPath());
            try { Probe("LOCALAPPDATA", Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)); } catch { }
            try { Probe("APPDATA", Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData)); } catch { }
            try { Probe("exe-dir", Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location)); } catch { }
            try { Probe("D盘", @"D:\"); } catch { }
        }

        /**
         * 是否处在「写不了用户目录」的受限环境。
         * 典型情况：安装包文件带着低完整性标签（从受限目录复制出来的），
         * 进程于是跑在低完整性，写不了 %APPDATA% / 注册表。
         * 用于在界面上给出可操作提示，而不是让用户看到一句「访问被拒绝」。
         */
        public static bool Restricted()
        {
            string appData = "";
            try { appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData); } catch { }
            if (string.IsNullOrEmpty(appData)) return true;
            return !Paths.Writable(appData);
        }

        private static void Probe(string label, string parent)
        {
            if (string.IsNullOrEmpty(parent)) { Program.Log("  " + label + ": 路径为空"); return; }
            string dir = Path.Combine(parent, "khs-probe-" + Guid.NewGuid().ToString("N"));
            try
            {
                Directory.CreateDirectory(dir);
                Program.Log("  " + label + " 建目录 OK");
                try { Directory.Delete(dir, true); } catch { }
            }
            catch (Exception ex)
            {
                Program.Log("  " + label + " 建目录 FAIL " + ex.GetType().Name + " — " + ex.Message);
            }
        }
    }

    /* ==================================================================
     * 界面：全部自绘（GDI+）。窗口无系统边框、圆角、可拖动，
     * 三个阶段——选择目录 / 安装中 / 完成——用淡入淡出切换。
     *
     * 坐标一律写成「设计像素」（560×340 基准），绘制时用 S() 乘缩放比：
     * 清单声明了 PerMonitorV2 DPI 感知，字体按真实尺寸渲染，
     * 不会像位图拉伸那样发糊（旧版就是因为没声明，高 DPI 下字是糊的）。
     * ================================================================== */

    internal sealed class SetupForm : Form
    {
        private enum Stage { Ready, Working, Failed, Done, Blocked }

        private Stage _stage = Stage.Ready;
        private string _dir;
        private int _percent;
        private string _status = "";
        private string _error = "";
        private string _warnText = "";
        private double _fade = 1.0;
        private float _s = 1f;               // DPI 缩放比（96dpi = 1）
        private readonly System.Windows.Forms.Timer _anim;
        private Point _dragOffset;
        private bool _dragging;
        private bool _hoverPrimary;
        private bool _pressedPrimary;
        private bool _hoverClose;
        private bool _makeDesktop = true;
        private bool _restricted;

        // 设计坐标（按 DPI 缩放后使用）
        private Rectangle _primaryRect;
        private Rectangle _closeRect;
        private Rectangle _checkRect;
        private Rectangle _browseRect;
        private Rectangle _pathRect;

        public SetupForm(string initialDir)
        {
            _dir = initialDir;

            Text = "KernelHub Studio 安装程序";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(560, 340);
            BackColor = Brand.Paper;
            DoubleBuffered = true;
            KeyPreview = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
            /*
             * 关掉 WinForms 的自动缩放。
             * 默认 AutoScaleMode = Font：它会按运行时字体与设计字体的差异把整个窗体
             * 再缩一遍，于是我在 ApplyScale() 里设的 ClientSize 被二次缩放
             * （实测 560×340 变成了 373×227，比例正好 2/3）。
             * 缩放由我们自己的 S() 负责，这里必须是 None。
             */
            AutoScaleMode = AutoScaleMode.None;

            _anim = new System.Windows.Forms.Timer();
            _anim.Interval = 16;
            _anim.Tick += AnimTick;

            MouseDown += OnMouseDown;
            MouseMove += OnMouseMove;
            MouseUp += OnMouseUp;
            MouseClick += OnMouseClick;
            KeyDown += OnKeyDown;

            /*
             * 启动就判断是不是受限环境（安装包带低完整性标签）。
             * 是的话直接显示「无法从当前位置安装」，不给用户点「立即安装」再失败的机会 ——
             * 实测：只在角落放一行小字提示，用户照样会点下去然后失败。
             */
            _restricted = Installer.Restricted();
            if (_restricted)
            {
                _stage = Stage.Blocked;
                Program.Log("检测到受限环境（写不了用户目录），显示「无法从当前位置安装」页");
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            ApplyScale();
        }

        protected override void OnDpiChangedAfterParent(EventArgs e)
        {
            base.OnDpiChangedAfterParent(e);
            ApplyScale();
        }

        /** 按当前 DPI 定窗口尺寸与各命中区 */
        private void ApplyScale()
        {
            /*
             * 缩放比默认取当前显示器 DPI（96dpi = 1.0）。
             * 环境变量 KHS_SETUP_SCALE 可以强制指定 —— 这只是为了在 100% DPI 的
             * 机器上也能验证「高 DPI 缩放」这条路径（截图比对版式与字体清晰度），
             * 正常运行时不需要设置。
             */
            _s = 0f;
            try
            {
                string forced = Environment.GetEnvironmentVariable("KHS_SETUP_SCALE");
                float f;
                if (!string.IsNullOrEmpty(forced) && float.TryParse(forced, out f) && f >= 0.5f && f <= 4f)
                {
                    _s = f;
                }
            }
            catch { }
            if (_s <= 0.1f)
            {
                /*
                 * 取真实 DPI 用 GetDpiForWindow（Win10 1607+）。
                 * 不要只用 Control.DeviceDpi：实测在 150% 缩放的机器上它报了 96，
                 * 结果窗口按 100% 尺寸画，在 150% 屏上显得偏小。
                 */
                int dpi = RealDpi();
                _s = dpi / 96f;
            }
            if (_s <= 0.1f) _s = 1f;
            Program.Log("缩放: _s=" + _s.ToString("0.###") + " DeviceDpi=" + SafeDpi() +
                        " 窗口=" + S(560) + "x" + S(340));

            ClientSize = new Size(S(560), S(340));
            _closeRect = S(520, 14, 24, 24);
            _pathRect = S(32, 162, 400, 34);
            _browseRect = S(440, 162, 88, 34);
            _checkRect = S(34, 232, 18, 18);
            _primaryRect = S(32, 268, 496, 46);
            ApplyRoundRegion();
            Invalidate();
        }

        private int S(int v)
        {
            return (int)Math.Round(v * _s);
        }

        private Rectangle S(int x, int y, int w, int h)
        {
            return new Rectangle(S(x), S(y), S(w), S(h));
        }

        private float SF(float v)
        {
            return v * _s;
        }

        private int SafeDpi()
        {
            try { return DeviceDpi; } catch { return -1; }
        }

        /** 窗口所在显示器的真实 DPI（拿不到就退回 DeviceDpi / 96） */
        private int RealDpi()
        {
            try
            {
                if (Handle != IntPtr.Zero)
                {
                    uint dpi = GetDpiForWindow(Handle);
                    if (dpi >= 48 && dpi <= 480) return (int)dpi;
                }
            }
            catch { }
            try
            {
                using (Graphics g = CreateGraphics())
                {
                    if (g != null && g.DpiX >= 48 && g.DpiX <= 480) return (int)Math.Round(g.DpiX);
                }
            }
            catch { }
            int d = SafeDpi();
            return d >= 48 ? d : 96;
        }

        private void ApplyRoundRegion()
        {
            IntPtr rgn = CreateRoundRectRgn(0, 0, Width + 1, Height + 1, S(16), S(16));
            Region = Region.FromHrgn(rgn);
            DeleteObject(rgn);
        }

        /* ------------------------------------------------------------ 动画 */

        private void AnimTick(object sender, EventArgs e)
        {
            if (_fade >= 1.0) { _anim.Stop(); return; }
            _fade += 0.12;
            if (_fade > 1.0) _fade = 1.0;
            Invalidate();
        }

        private void StartFade()
        {
            _fade = 0.0;
            _anim.Start();
        }

        /* ------------------------------------------------------------ 绘制 */

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            // 字体走 ClearType；配合清单里的 DPI 感知才是清晰的关键
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
            g.Clear(Brand.Paper);

            DrawTitleBar(g);

            int alpha = (int)Math.Round(255 * _fade);
            if (_stage == Stage.Ready) DrawReady(g, alpha);
            else if (_stage == Stage.Working) DrawWorking(g, alpha);
            else if (_stage == Stage.Done) DrawDone(g, alpha);
            else if (_stage == Stage.Blocked) DrawBlocked(g, alpha);
            else DrawFailed(g, alpha);

            using (Pen p = new Pen(Brand.Rule))
            {
                g.DrawRectangle(p, 0, 0, Width - 1, Height - 1);
            }
        }

        private void DrawTitleBar(Graphics g)
        {
            using (Font f = Brand.Ui(SF(9.5f), FontStyle.Bold))
            using (SolidBrush b = new SolidBrush(Brand.Ink))
            {
                g.DrawString("KERNELHUB STUDIO", f, b, S(32), S(20));
            }
            Color c = _hoverClose ? Brand.Ink : Brand.Ink3;
            using (Pen p = new Pen(c, Math.Max(1f, SF(1.4f))))
            {
                g.DrawLine(p, _closeRect.Left + S(8), _closeRect.Top + S(8), _closeRect.Right - S(8), _closeRect.Bottom - S(8));
                g.DrawLine(p, _closeRect.Right - S(8), _closeRect.Top + S(8), _closeRect.Left + S(8), _closeRect.Bottom - S(8));
            }
        }

        private void DrawReady(Graphics g, int alpha)
        {
            using (Font fTitle = Brand.Ui(SF(17f), FontStyle.Regular))
            using (Font fLabel = Brand.Ui(SF(9f), FontStyle.Regular))
            using (Font fBody = Brand.Ui(SF(9.5f), FontStyle.Regular))
            {
                DrawString(g, "选择安装位置", fTitle, Brand.Ink, S(32), S(68), alpha);
                DrawString(g, "KernelHub Studio 将安装到下面的文件夹。", fBody, Brand.Ink2, S(32), S(106), alpha);
                DrawString(g, "安装目录", fLabel, Brand.Ink3, S(32), S(142), alpha);

                // 路径框
                using (GraphicsPath path = Round(_pathRect, S(8)))
                using (Pen p = new Pen(Brand.Rule))
                using (SolidBrush b = new SolidBrush(Brand.Paper))
                {
                    g.FillPath(b, path);
                    g.DrawPath(p, path);
                }
                using (Font fMono = Brand.Ui(SF(9f), FontStyle.Regular))
                {
                    RectangleF inner = new RectangleF(_pathRect.Left + S(12), _pathRect.Top + S(8),
                        _pathRect.Width - S(24), _pathRect.Height - S(12));
                    using (StringFormat sf = new StringFormat())
                    {
                        sf.Trimming = StringTrimming.EllipsisPath;
                        sf.FormatFlags = StringFormatFlags.NoWrap;
                        using (SolidBrush fb = new SolidBrush(Color.FromArgb(alpha, Brand.Ink)))
                        {
                            g.DrawString(_dir, fMono, fb, inner, sf);
                        }
                    }
                }

                DrawGhostButton(g, _browseRect, "更改", alpha);

                // 复选框
                using (GraphicsPath path = Round(_checkRect, S(4)))
                using (SolidBrush fill = new SolidBrush(_makeDesktop ? Brand.Accent : Brand.Paper))
                using (Pen border = new Pen(_makeDesktop ? Brand.Accent : Brand.Rule))
                {
                    g.FillPath(fill, path);
                    g.DrawPath(border, path);
                }
                if (_makeDesktop)
                {
                    using (Pen tick = new Pen(Brand.Paper, Math.Max(1.6f, SF(2f))))
                    {
                        g.DrawLine(tick, _checkRect.Left + S(4), _checkRect.Top + S(9), _checkRect.Left + S(7), _checkRect.Top + S(12));
                        g.DrawLine(tick, _checkRect.Left + S(7), _checkRect.Top + S(12), _checkRect.Right - S(3), _checkRect.Top + S(5));
                    }
                }
                DrawString(g, "创建桌面快捷方式", fBody, Brand.Ink2, _checkRect.Right + S(8), _checkRect.Top + S(1), alpha);

                DrawPrimaryButton(g, alpha);
            }
        }

        private void DrawWorking(Graphics g, int alpha)
        {
            using (Font fTitle = Brand.Ui(SF(17f), FontStyle.Regular))
            using (Font fBody = Brand.Ui(SF(9.5f), FontStyle.Regular))
            {
                DrawString(g, "正在安装", fTitle, Brand.Ink, S(32), S(68), alpha);
                DrawString(g, _status, fBody, Brand.Ink2, S(32), S(106), alpha);

                Rectangle track = S(32, 150, 496, 8);
                using (GraphicsPath tp = Round(track, S(4)))
                using (SolidBrush tb = new SolidBrush(Brand.Track))
                {
                    g.FillPath(tb, tp);
                }
                int w = (int)Math.Round(track.Width * (_percent / 100.0));
                if (w > S(2))
                {
                    using (GraphicsPath fp = Round(new Rectangle(track.Left, track.Top, w, track.Height), S(4)))
                    using (SolidBrush fb = new SolidBrush(Brand.Accent))
                    {
                        g.FillPath(fb, fp);
                    }
                }
                using (Font fPct = Brand.Ui(SF(13f), FontStyle.Regular))
                {
                    DrawString(g, _percent + "%", fPct, Brand.Ink, S(32), S(180), alpha);
                }
            }
        }

        private void DrawDone(Graphics g, int alpha)
        {
            using (Font fTitle = Brand.Ui(SF(17f), FontStyle.Regular))
            using (Font fBody = Brand.Ui(SF(9.5f), FontStyle.Regular))
            {
                DrawString(g, "安装完成", fTitle, Brand.Ink, S(32), S(68), alpha);
                RectangleF line = new RectangleF(S(32), S(106), S(496), S(24));
                using (StringFormat sf = new StringFormat())
                {
                    sf.Trimming = StringTrimming.EllipsisPath;
                    sf.FormatFlags = StringFormatFlags.NoWrap;
                    using (SolidBrush b = new SolidBrush(Color.FromArgb(alpha, Brand.Ink2)))
                    {
                        g.DrawString("已安装到 " + _dir, fBody, b, line, sf);
                    }
                }
                DrawString(g, "已安装的插件与设置保存在用户目录，不受重装影响。", fBody, Brand.Ink3, S(32), S(130), alpha);
                if (_warnText.Length > 0)
                {
                    using (Font fWarn = Brand.Ui(SF(8.5f), FontStyle.Regular))
                    {
                        RectangleF wbox = new RectangleF(S(32), S(154), S(496), S(40));
                        using (SolidBrush b = new SolidBrush(Color.FromArgb(alpha, Brand.Warn)))
                        {
                            g.DrawString(_warnText, fWarn, b, wbox);
                        }
                    }
                }
            }
            DrawPrimaryButton(g, alpha);
        }

        /**
         * 受限环境（安装包带低完整性标签）时直接显示这一页，而不是让用户点了
         * 「立即安装」再看到一句看不懂的「访问被拒绝」。
         * 这是实测踩过的坑：用户从受限目录里运行安装包，点安装必失败。
         */
        private void DrawBlocked(Graphics g, int alpha)
        {
            using (Font fTitle = Brand.Ui(SF(17f), FontStyle.Regular))
            using (Font fBody = Brand.Ui(SF(9.5f), FontStyle.Regular))
            using (Font fMono = Brand.Ui(SF(8.5f), FontStyle.Regular))
            {
                DrawString(g, "无法从当前位置安装", fTitle, Brand.Accent, S(32), S(60), alpha);
                // 正文用矩形自动换行；高度要够 3 行（9.5pt 在 150% 下每行约 19px），
                // 否则会压到下面的「当前文件」那一行（实测踩过）
                RectangleF box = new RectangleF(S(32), S(96), S(496), S(80));
                using (SolidBrush b = new SolidBrush(Color.FromArgb(alpha, Brand.Ink2)))
                {
                    g.DrawString("这个安装包处于受限目录（低完整性），Windows 不允许它写入用户目录，因此装不上。" +
                                 "把安装包复制到 D:\\ 或桌面，再从副本运行即可 —— 不需要管理员权限。",
                        fBody, b, box);
                }
                RectangleF path = new RectangleF(S(32), S(184), S(496), S(30));
                using (StringFormat sf = new StringFormat())
                {
                    sf.Trimming = StringTrimming.EllipsisPath;
                    sf.FormatFlags = StringFormatFlags.NoWrap;
                    using (SolidBrush b = new SolidBrush(Color.FromArgb(alpha, Brand.Ink3)))
                    {
                        g.DrawString("当前文件：" + SelfPath(), fMono, b, path, sf);
                    }
                }
            }
            DrawPrimaryButton(g, alpha);
        }

        /** 本安装包自身的路径（提示用户该复制哪个文件） */
        private static string SelfPath()
        {
            try { return Assembly.GetExecutingAssembly().Location; }
            catch { return "(未知)"; }
        }

        private void DrawFailed(Graphics g, int alpha)
        {
            using (Font fTitle = Brand.Ui(SF(17f), FontStyle.Regular))
            using (Font fBody = Brand.Ui(SF(9.5f), FontStyle.Regular))
            {
                DrawString(g, "安装失败", fTitle, Brand.Accent, S(32), S(68), alpha);
                // 错误按矩形自动换行，不再截断 —— 信息完整才好排查
                RectangleF box = new RectangleF(S(32), S(104), S(496), S(84));
                using (SolidBrush b = new SolidBrush(Color.FromArgb(alpha, Brand.Ink2)))
                {
                    g.DrawString(_error, fBody, b, box);
                }
                using (Font fHint = Brand.Ui(SF(8.5f), FontStyle.Regular))
                {
                    DrawString(g, "详细日志：" + Program.LogPath(), fHint, Brand.Ink3, S(32), S(196), alpha);
                }
            }
            DrawPrimaryButton(g, alpha);
        }

        private void DrawPrimaryButton(Graphics g, int alpha)
        {
            string text = _stage == Stage.Ready ? "立即安装"
                : _stage == Stage.Working ? "正在安装…"
                : _stage == Stage.Done ? "立即启动"
                : _stage == Stage.Blocked ? "打开所在文件夹"
                : "关闭";

            Color baseColor = Brand.Accent;
            if (_stage == Stage.Working) baseColor = Brand.AccentDark;
            else if (_pressedPrimary) baseColor = Brand.AccentDark;
            else if (_hoverPrimary) baseColor = Color.FromArgb(
                Math.Min(255, Brand.Accent.R + 16),
                Math.Min(255, Brand.Accent.G + 16),
                Math.Min(255, Brand.Accent.B + 16));

            using (GraphicsPath path = Round(_primaryRect, S(22)))
            using (SolidBrush b = new SolidBrush(Color.FromArgb(alpha, baseColor)))
            {
                g.FillPath(b, path);
            }
            using (Font f = Brand.Ui(SF(11f), FontStyle.Bold))
            using (StringFormat sf = new StringFormat())
            {
                sf.Alignment = StringAlignment.Center;
                sf.LineAlignment = StringAlignment.Center;
                using (SolidBrush fb = new SolidBrush(Color.FromArgb(alpha, Brand.Paper)))
                {
                    g.DrawString(text, f, fb, _primaryRect, sf);
                }
            }
        }

        private void DrawGhostButton(Graphics g, Rectangle r, string text, int alpha)
        {
            using (GraphicsPath path = Round(r, S(8)))
            using (SolidBrush b = new SolidBrush(Color.FromArgb(alpha, Brand.Paper)))
            using (Pen p = new Pen(Color.FromArgb(alpha, Brand.Rule)))
            {
                g.FillPath(b, path);
                g.DrawPath(p, path);
            }
            using (Font f = Brand.Ui(SF(9f), FontStyle.Regular))
            using (StringFormat sf = new StringFormat())
            {
                sf.Alignment = StringAlignment.Center;
                sf.LineAlignment = StringAlignment.Center;
                using (SolidBrush fb = new SolidBrush(Color.FromArgb(alpha, Brand.Ink)))
                {
                    g.DrawString(text, f, fb, r, sf);
                }
            }
        }

        private static void DrawString(Graphics g, string text, Font f, Color c, int x, int y, int alpha)
        {
            using (SolidBrush b = new SolidBrush(Color.FromArgb(alpha, c)))
            {
                g.DrawString(text, f, b, x, y);
            }
        }

        private static GraphicsPath Round(Rectangle r, int radius)
        {
            GraphicsPath path = new GraphicsPath();
            int d = Math.Max(2, radius * 2);
            if (d > r.Height) d = r.Height;
            if (d > r.Width) d = r.Width;
            path.AddArc(r.Left, r.Top, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Top, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.Left, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        /* ------------------------------------------------------------ 交互 */

        private void OnMouseDown(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            if (_primaryRect.Contains(e.Location) && _stage != Stage.Working)
            {
                _pressedPrimary = true;
                Invalidate();
                return;
            }
            if (e.Y < S(56) && !_closeRect.Contains(e.Location))
            {
                _dragging = true;
                _dragOffset = e.Location;
            }
        }

        private void OnMouseMove(object sender, MouseEventArgs e)
        {
            bool hoverPrimary = _primaryRect.Contains(e.Location) && _stage != Stage.Working;
            bool hoverClose = _closeRect.Contains(e.Location);
            if (hoverPrimary != _hoverPrimary || hoverClose != _hoverClose)
            {
                _hoverPrimary = hoverPrimary;
                _hoverClose = hoverClose;
                Invalidate();
            }
            if (_dragging)
            {
                Point screen = PointToScreen(e.Location);
                Location = new Point(screen.X - _dragOffset.X, screen.Y - _dragOffset.Y);
            }
        }

        private void OnMouseUp(object sender, MouseEventArgs e)
        {
            _dragging = false;
            if (_pressedPrimary)
            {
                _pressedPrimary = false;
                Invalidate();
            }
        }

        private void OnMouseClick(object sender, MouseEventArgs e)
        {
            if (_closeRect.Contains(e.Location)) { Close(); return; }

            if (_stage == Stage.Ready)
            {
                if (_browseRect.Contains(e.Location)) { Browse(); return; }
                if (_checkRect.Contains(e.Location) || CheckLabelHit(e.Location))
                {
                    _makeDesktop = !_makeDesktop;
                    Invalidate();
                    return;
                }
                if (_primaryRect.Contains(e.Location)) { BeginInstall(); return; }
                return;
            }
            if (_stage == Stage.Done && _primaryRect.Contains(e.Location))
            {
                LaunchApp();
                Close();
                return;
            }
            if (_stage == Stage.Failed && _primaryRect.Contains(e.Location))
            {
                Close();
                return;
            }
            if (_stage == Stage.Blocked && _primaryRect.Contains(e.Location))
            {
                // 把资源管理器打开到这个安装包上，方便用户直接复制出去
                try
                {
                    Process.Start("explorer.exe", "/select,\"" + SelfPath() + "\"");
                }
                catch { }
                Close();
            }
        }

        private bool CheckLabelHit(Point p)
        {
            return p.X > _checkRect.Right && p.X < _checkRect.Right + S(180) &&
                   p.Y > _checkRect.Top - S(4) && p.Y < _checkRect.Bottom + S(4);
        }

        private void OnKeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Escape) Close();
        }

        private void Browse()
        {
            using (FolderBrowserDialog dlg = new FolderBrowserDialog())
            {
                dlg.Description = "选择 KernelHub Studio 的安装位置";
                dlg.SelectedPath = _dir;
                dlg.ShowNewFolderButton = true;
                if (dlg.ShowDialog(this) == DialogResult.OK && !string.IsNullOrEmpty(dlg.SelectedPath))
                {
                    // 用户选的是「父目录」，应用名再拼一层（与默认值 D:\KernelHub Studio 一致）
                    _dir = Path.Combine(dlg.SelectedPath, "KernelHub Studio");
                    Invalidate();
                }
            }
        }

        /* ------------------------------------------------------------ 安装 */

        private void BeginInstall()
        {
            _stage = Stage.Working;
            _percent = 0;
            _status = "正在准备…";
            StartFade();
            Invalidate();

            Thread t = new Thread(delegate()
            {
                try
                {
                    Installer inst = new Installer(_dir, delegate(int pct, string text)
                    {
                        _percent = pct;
                        _status = text;
                        try { BeginInvoke((MethodInvoker)delegate { Invalidate(); }); } catch { }
                    });
                    inst.Run();

                    string warn = "";
                    if (inst.Warnings.Count > 0)
                    {
                        int take = Math.Min(2, inst.Warnings.Count);
                        warn = inst.Warnings.Count + " 条提示：" +
                               string.Join("；", inst.Warnings.GetRange(0, take).ToArray());
                    }
                    try
                    {
                        BeginInvoke((MethodInvoker)delegate
                        {
                            _stage = Stage.Done;
                            _percent = 100;
                            _status = "安装完成";
                            _warnText = warn;
                            StartFade();
                            Invalidate();
                        });
                    }
                    catch { }
                }
                catch (Exception ex)
                {
                    string msg = ex.Message;
                    Program.Log("界面安装失败: " + ex.ToString());
                    try
                    {
                        BeginInvoke((MethodInvoker)delegate
                        {
                            _stage = Stage.Failed;
                            _error = msg;
                            StartFade();
                            Invalidate();
                        });
                    }
                    catch { }
                }
            });
            t.IsBackground = true;
            t.Start();
        }

        private void LaunchApp()
        {
            try
            {
                string exe = Path.Combine(_dir, Installer.ExeName);
                if (File.Exists(exe)) Process.Start(new ProcessStartInfo(exe) { WorkingDirectory = _dir });
            }
            catch { }
        }

        /* ------------------------------------------------------------ 原生 */

        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateRoundRectRgn(int l, int t, int r, int b, int w, int h);

        [DllImport("gdi32.dll")]
        private static extern bool DeleteObject(IntPtr hObject);

        [DllImport("user32.dll")]
        private static extern uint GetDpiForWindow(IntPtr hwnd);
    }

    internal static class Program
    {
        public static string Version = "0.0.0";

        /** 诊断日志：写在 exe 同目录（一定可写），安装失败时能查到完整异常 */
        public static string LogPath()
        {
            try
            {
                return Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), "setup-log.txt");
            }
            catch { return Path.Combine(Path.GetTempPath(), "khs-setup-log.txt"); }
        }

        public static void Log(string line)
        {
            try
            {
                File.AppendAllText(LogPath(),
                    DateTime.Now.ToString("HH:mm:ss") + " " + line + Environment.NewLine, Encoding.UTF8);
            }
            catch { }
        }

        [STAThread]
        private static int Main(string[] args)
        {
            Options o = Options.Parse(args);
            Version = FindVersion();
            Log("---- 启动 版本=" + Version + " 参数=" + string.Join(" ", args) +
                " 目标=" + (o.Dir == null ? "(默认)" : o.Dir) + " 静默=" + o.Silent);
            Installer.Diagnose();

            if (o.Silent)
            {
                if (o.Updated) Installer.KillRunning();
                string dir = string.IsNullOrEmpty(o.Dir) ? Paths.DefaultDir() : o.Dir;
                try
                {
                    Installer inst = new Installer(dir, delegate(int pct, string text) { Log(pct + "% " + text); });
                    inst.Run();
                    Log("静默安装完成" + (inst.Warnings.Count > 0 ? "（" + inst.Warnings.Count + " 条提示）" : ""));
                    return 0;
                }
                catch (Exception ex)
                {
                    Log("静默安装失败: " + ex.ToString());
                    return 1;
                }
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            string initial = string.IsNullOrEmpty(o.Dir) ? Paths.DefaultDir() : o.Dir;
            Application.Run(new SetupForm(initial));
            return 0;
        }

        /**
         * 版本号来自构建时生成的 Version.g.cs（tools/build-installer.js 写出），
         * 这样注册表里的 DisplayVersion 与实际发布版本一定一致。
         */
        private static string FindVersion()
        {
            return BuildInfo.Version;
        }
    }
}
