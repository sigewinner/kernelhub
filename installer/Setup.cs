/*
 * Setup.cs —— KernelHub Studio 自绘安装器（2.2.7）
 *
 * 为什么不用 NSIS 的界面：
 *   官方 NSIS 只能换图与文案（MUI2 没有任何颜色/皮肤 define，工具链里也没有皮肤引擎），
 *   做不出「无系统标题栏 + 圆角 + 品牌色大按钮 + 动画」这种现代安装界面。
 *   所以自己写一个：窗口自绘（GDI+），只用 Windows 自带的 .NET Framework，
 *   由 build 脚本用 csc.exe 编译成单个 exe。
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
 *   /D=<目录>        指定安装目录（/D 必须放在最后，NSIS 风格，静默模式也用得上）
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

        public static string DefaultDir()
        {
            // 已经装过就沿用原目录（和应用内「静默更新沿用首次安装目录」一致）
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
            return Path.Combine(
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs"),
                "KernelHub Studio");
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

    /** 解压 + 安装，带进度回调 */
    internal sealed class Installer
    {
        public const string ExeName = "KernelHub Studio.exe";

        private readonly string _target;
        private readonly Action<int, string> _report;

        public Installer(string target, Action<int, string> report)
        {
            _target = target;
            _report = report;
        }

        public void Run()
        {
            Say(0, "正在准备…");
            Directory.CreateDirectory(_target);

            string temp = MakeTempDir();
            Program.Log("使用临时目录: " + temp);
            Directory.CreateDirectory(temp);
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

                Say(93, "正在写入卸载信息…");
                string uninstaller = Path.Combine(_target, "uninstall.exe");
                WriteResource("uninstall.exe", uninstaller);

                Say(95, "正在创建快捷方式…");
                CreateShortcuts();

                Say(98, "正在写入注册表…");
                WriteRegistry(uninstaller);

                Say(100, "安装完成");
            }
            finally
            {
                try { Directory.Delete(temp, true); } catch { }
            }
        }

        private void Say(int percent, string text)
        {
            if (_report != null) _report(percent, text);
        }

        /**
         * 找一个能建目录的临时位置，依次尝试：
         *   %TEMP% → %LOCALAPPDATA% → 目标目录的父目录 → exe 同目录
         *
         * 为什么要这么写：实测在某些环境里，进程在 %TEMP% 下 Directory.CreateDirectory
         * 会拿到 ERROR_ACCESS_DENIED（同一路径用资源管理器/命令行却能建）。
         * 安装器不该因为「临时目录选得不好」就整个失败，所以挨个试，
         * 试不出来的话才抛异常并写进日志。
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
                    errors.Add(root + " → " + ex.GetType().Name + ": " + ex.Message);
                    Program.Log("临时目录候选失败: " + root + " → " + ex.Message);
                }
            }
            throw new InvalidOperationException("找不到可写的临时目录。" + string.Join(" | ", errors.ToArray()));
        }

        /** 诊断：把「哪些位置能建目录/写文件」记进日志，便于排障 */
        public static void Diagnose()
        {
            Program.Log("诊断: user=" + Environment.UserName + " temp=" + Path.GetTempPath() +
                        " cwd=" + Environment.CurrentDirectory);
            Probe("TEMP", Path.GetTempPath());
            try { Probe("LOCALAPPDATA", Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)); } catch { }
            try { Probe("exe-dir", Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location)); } catch { }
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
            string file = Path.Combine(parent, "khs-probe-" + Guid.NewGuid().ToString("N") + ".txt");
            try
            {
                File.WriteAllText(file, "probe");
                Program.Log("  " + label + " 写文件 OK");
                try { File.Delete(file); } catch { }
            }
            catch (Exception ex)
            {
                Program.Log("  " + label + " 写文件 FAIL " + ex.GetType().Name + " — " + ex.Message);
            }
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
                            // 解压占 4%–88% 这段
                            Say(4 + (int)(pct * 0.84), "正在解压应用文件… " + pct + "%");
                        }
                    }
                }
                p.WaitForExit();
                if (p.ExitCode != 0) throw new InvalidOperationException("解压失败（7za 退出码 " + p.ExitCode + "）");
            }
        }

        private static void CopyTree(string from, string to)
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
                File.Copy(file, dest, true);
            }
        }

        private void CreateShortcuts()
        {
            string exe = Path.Combine(_target, ExeName);
            MakeLink(Paths.StartMenuLink(), exe);
            // 桌面快捷方式：装到临时目录（自检）时不建，免得污染桌面
            if (!_target.StartsWith(Path.GetTempPath(), StringComparison.OrdinalIgnoreCase))
            {
                MakeLink(Paths.DesktopLink(), exe);
            }
        }

        private static void MakeLink(string linkPath, string target)
        {
            try
            {
                Type t = Type.GetTypeFromProgID("WScript.Shell");
                if (t == null) return;
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
            }
            catch { }
        }

        private void WriteRegistry(string uninstaller)
        {
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(Paths.UninstallKey))
            {
                if (k == null) return;
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

        /** 结束正在运行的实例（更新前必须做，否则文件被占用复制不过去） */
        public static void KillRunning()
        {
            try
            {
                foreach (Process p in Process.GetProcessesByName("KernelHub Studio"))
                {
                    try { p.Kill(); p.WaitForExit(5000); } catch { }
                }
            }
            catch { }
        }
    }

    /* ==================================================================
     * 界面：全部自绘（GDI+）。窗口无系统边框、圆角、可拖动，
     * 三个阶段——选择目录 / 安装中 / 完成——用淡入淡出切换。
     * ================================================================== */

    internal sealed class SetupForm : Form
    {
        private enum Stage { Ready, Working, Failed, Done }

        private Stage _stage = Stage.Ready;
        private string _dir;
        private int _percent;
        private string _status = "";
        private string _error = "";
        private double _fade = 1.0;         // 阶段内容淡入用
        private readonly System.Windows.Forms.Timer _anim;
        private Point _dragOffset;
        private bool _dragging;
        private bool _hoverPrimary;
        private bool _pressedPrimary;
        private bool _hoverClose;
        private bool _makeDesktop = true;
        private bool _hoverCheck;

        private readonly Rectangle _primaryRect = new Rectangle(32, 268, 496, 46);
        private readonly Rectangle _closeRect = new Rectangle(520, 14, 24, 24);
        private readonly Rectangle _checkRect = new Rectangle(34, 232, 18, 18);

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

            _anim = new System.Windows.Forms.Timer();
            _anim.Interval = 16;
            _anim.Tick += AnimTick;

            MouseDown += OnMouseDown;
            MouseMove += OnMouseMove;
            MouseUp += OnMouseUp;
            MouseClick += OnMouseClick;
            KeyDown += OnKeyDown;
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            ApplyRoundRegion();
        }

        private void ApplyRoundRegion()
        {
            // 圆角窗口：用 Win32 圆角矩形做 Region（比 GraphicsPath 干净）
            IntPtr rgn = CreateRoundRectRgn(0, 0, Width + 1, Height + 1, 16, 16);
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
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
            g.Clear(Brand.Paper);

            DrawTitleBar(g);

            int alpha = (int)Math.Round(255 * _fade);
            if (_stage == Stage.Ready) DrawReady(g, alpha);
            else if (_stage == Stage.Working) DrawWorking(g, alpha);
            else if (_stage == Stage.Done) DrawDone(g, alpha);
            else DrawFailed(g, alpha);

            // 外框（1px 细线，收口）
            using (Pen p = new Pen(Brand.Rule))
            {
                g.DrawRectangle(p, 0, 0, Width - 1, Height - 1);
            }
        }

        private void DrawTitleBar(Graphics g)
        {
            using (Font f = Brand.Ui(9.5f, FontStyle.Bold))
            using (SolidBrush b = new SolidBrush(Brand.Ink))
            {
                g.DrawString("KERNELHUB STUDIO", f, b, 32, 20);
            }
            // 关闭按钮：一个细十字
            Color c = _hoverClose ? Brand.Ink : Brand.Ink3;
            using (Pen p = new Pen(c, 1.4f))
            {
                g.DrawLine(p, _closeRect.Left + 8, _closeRect.Top + 8, _closeRect.Right - 8, _closeRect.Bottom - 8);
                g.DrawLine(p, _closeRect.Right - 8, _closeRect.Top + 8, _closeRect.Left + 8, _closeRect.Bottom - 8);
            }
        }

        private void DrawReady(Graphics g, int alpha)
        {
            using (Font fTitle = Brand.Ui(17f, FontStyle.Regular))
            using (Font fLabel = Brand.Ui(9f, FontStyle.Regular))
            using (Font fBody = Brand.Ui(9.5f, FontStyle.Regular))
            {
                DrawString(g, "选择安装位置", fTitle, Brand.Ink, 32, 68, alpha);
                DrawString(g, "KernelHub Studio 将安装到下面的文件夹。", fBody, Brand.Ink2, 32, 106, alpha);

                DrawString(g, "安装目录", fLabel, Brand.Ink3, 32, 142, alpha);

                // 路径框（圆角描边）
                Rectangle box = new Rectangle(32, 162, 400, 34);
                using (GraphicsPath path = Round(box, 8))
                using (Pen p = new Pen(Brand.Rule))
                using (SolidBrush b = new SolidBrush(Brand.Paper))
                {
                    g.FillPath(b, path);
                    g.DrawPath(p, path);
                }
                using (Font fMono = Brand.Ui(9f, FontStyle.Regular))
                {
                    DrawString(g, Trim(_dir, 52), fMono, Brand.Ink, box.Left + 12, box.Top + 9, alpha);
                }

                // 更改按钮
                Rectangle browse = new Rectangle(440, 162, 88, 34);
                DrawGhostButton(g, browse, "更改", alpha, false);

                // 复选框
                using (GraphicsPath path = Round(_checkRect, 4))
                using (SolidBrush fill = new SolidBrush(_makeDesktop ? Brand.Accent : Brand.Paper))
                using (Pen border = new Pen(_makeDesktop ? Brand.Accent : Brand.Rule))
                {
                    g.FillPath(fill, path);
                    g.DrawPath(border, path);
                }
                if (_makeDesktop)
                {
                    using (Pen tick = new Pen(Brand.Paper, 2f))
                    {
                        g.DrawLine(tick, _checkRect.Left + 4, _checkRect.Top + 9, _checkRect.Left + 7, _checkRect.Top + 12);
                        g.DrawLine(tick, _checkRect.Left + 7, _checkRect.Top + 12, _checkRect.Right - 3, _checkRect.Top + 5);
                    }
                }
                DrawString(g, "创建桌面快捷方式", fBody, Brand.Ink2, _checkRect.Right + 8, _checkRect.Top + 1, alpha);

                DrawPrimaryButton(g, alpha);
            }
        }

        private void DrawWorking(Graphics g, int alpha)
        {
            using (Font fTitle = Brand.Ui(17f, FontStyle.Regular))
            using (Font fBody = Brand.Ui(9.5f, FontStyle.Regular))
            {
                DrawString(g, "正在安装", fTitle, Brand.Ink, 32, 68, alpha);
                DrawString(g, _status, fBody, Brand.Ink2, 32, 106, alpha);

                // 进度条
                Rectangle track = new Rectangle(32, 150, 496, 8);
                using (GraphicsPath tp = Round(track, 4))
                using (SolidBrush tb = new SolidBrush(Brand.Track))
                {
                    g.FillPath(tb, tp);
                }
                int w = (int)Math.Round(track.Width * (_percent / 100.0));
                if (w > 2)
                {
                    using (GraphicsPath fp = Round(new Rectangle(track.Left, track.Top, w, track.Height), 4))
                    using (SolidBrush fb = new SolidBrush(Brand.Accent))
                    {
                        g.FillPath(fb, fp);
                    }
                }
                using (Font fPct = Brand.Ui(13f, FontStyle.Regular))
                {
                    DrawString(g, _percent + "%", fPct, Brand.Ink, 32, 180, alpha);
                }
            }
        }

        private void DrawDone(Graphics g, int alpha)
        {
            using (Font fTitle = Brand.Ui(17f, FontStyle.Regular))
            using (Font fBody = Brand.Ui(9.5f, FontStyle.Regular))
            {
                DrawString(g, "安装完成", fTitle, Brand.Ink, 32, 68, alpha);
                DrawString(g, "已安装到 " + Trim(_dir, 46), fBody, Brand.Ink2, 32, 106, alpha);
                DrawString(g, "已安装的插件与设置保存在用户目录，不受重装影响。", fBody, Brand.Ink3, 32, 130, alpha);
            }
            DrawPrimaryButton(g, alpha);
        }

        private void DrawFailed(Graphics g, int alpha)
        {
            using (Font fTitle = Brand.Ui(17f, FontStyle.Regular))
            using (Font fBody = Brand.Ui(9.5f, FontStyle.Regular))
            {
                DrawString(g, "安装失败", fTitle, Brand.Accent, 32, 68, alpha);
                DrawString(g, Trim(_error, 120), fBody, Brand.Ink2, 32, 106, alpha);
            }
            DrawPrimaryButton(g, alpha);
        }

        private void DrawPrimaryButton(Graphics g, int alpha)
        {
            string text = _stage == Stage.Ready ? "立即安装"
                : _stage == Stage.Working ? "正在安装…"
                : _stage == Stage.Done ? "立即启动"
                : "关闭";

            Color baseColor = Brand.Accent;
            if (_stage == Stage.Working) baseColor = Brand.AccentDark;
            else if (_pressedPrimary) baseColor = Brand.AccentDark;
            else if (_hoverPrimary) baseColor = Color.FromArgb(
                Math.Min(255, Brand.Accent.R + 16),
                Math.Min(255, Brand.Accent.G + 16),
                Math.Min(255, Brand.Accent.B + 16));

            using (GraphicsPath path = Round(_primaryRect, 22))
            using (SolidBrush b = new SolidBrush(Color.FromArgb(alpha, baseColor)))
            {
                g.FillPath(b, path);
            }
            using (Font f = Brand.Ui(11f, FontStyle.Bold))
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

        private void DrawGhostButton(Graphics g, Rectangle r, string text, int alpha, bool hover)
        {
            using (GraphicsPath path = Round(r, 8))
            using (SolidBrush b = new SolidBrush(Color.FromArgb(alpha, hover ? Brand.Hover : Brand.Paper)))
            using (Pen p = new Pen(Color.FromArgb(alpha, Brand.Rule)))
            {
                g.FillPath(b, path);
                g.DrawPath(p, path);
            }
            using (Font f = Brand.Ui(9f, FontStyle.Regular))
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
            int d = radius * 2;
            path.AddArc(r.Left, r.Top, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Top, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.Left, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        private static string Trim(string s, int max)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Length <= max ? s : "…" + s.Substring(s.Length - max + 1);
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
            // 标题栏区域拖动窗口
            if (e.Y < 56 && !_closeRect.Contains(e.Location))
            {
                _dragging = true;
                _dragOffset = e.Location;
            }
        }

        private void OnMouseMove(object sender, MouseEventArgs e)
        {
            bool hoverPrimary = _primaryRect.Contains(e.Location) && _stage != Stage.Working;
            bool hoverClose = _closeRect.Contains(e.Location);
            bool hoverCheck = _checkRect.Contains(e.Location) || (e.X > _checkRect.Left && e.X < 260 && e.Y > 226 && e.Y < 254);
            if (hoverPrimary != _hoverPrimary || hoverClose != _hoverClose || hoverCheck != _hoverCheck)
            {
                _hoverPrimary = hoverPrimary;
                _hoverClose = hoverClose;
                _hoverCheck = hoverCheck;
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
            if (_closeRect.Contains(e.Location))
            {
                Close();
                return;
            }
            if (_stage == Stage.Ready)
            {
                if (new Rectangle(440, 162, 88, 34).Contains(e.Location)) { Browse(); return; }
                if (_checkRect.Contains(e.Location) || (e.X > _checkRect.Left && e.X < 260 && e.Y > 226 && e.Y < 254))
                {
                    _makeDesktop = !_makeDesktop;
                    Invalidate();
                    return;
                }
                if (_primaryRect.Contains(e.Location)) { BeginInstall(); return; }
            }
            else if (_stage == Stage.Done && _primaryRect.Contains(e.Location))
            {
                LaunchApp();
                Close();
            }
            else if (_stage == Stage.Failed && _primaryRect.Contains(e.Location))
            {
                Close();
            }
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
                    try
                    {
                        BeginInvoke((MethodInvoker)delegate
                        {
                            _stage = Stage.Done;
                            _percent = 100;
                            _status = "安装完成";
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
                // 静默安装 / 更新：不显示界面。装到指定目录或上次记录的目录。
                if (o.Updated) Installer.KillRunning();
                string dir = string.IsNullOrEmpty(o.Dir) ? Paths.DefaultDir() : o.Dir;
                try
                {
                    Installer inst = new Installer(dir, delegate(int pct, string text) { Log(pct + "% " + text); });
                    inst.Run();
                    Log("静默安装完成");
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
         * 这样注册表里的 DisplayVersion 与实际发布版本一定一致，
         * 不需要在读 exe 资源上绕弯。
         */
        private static string FindVersion()
        {
            return BuildInfo.Version;
        }
    }
}
