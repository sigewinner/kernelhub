/*
 * Uninstall.cs —— KernelHub Studio 自绘安装器附带的卸载器（2.2.7）
 *
 * 由 tools/build-installer.js 用 csc.exe 编译，作为资源嵌进安装器，
 * 安装时写到目标目录（<安装目录>\uninstall.exe）。
 *
 * 命令行：
 *   双击        显示一个自绘的小确认窗
 *   /S          静默卸载
 *
 * 做法：先把安装目录移到自己旁边改名（Windows 不允许删除正在运行的程序所在目录），
 * 再递归删除；快捷方式与注册表项一并清掉。
 * 用户数据（%APPDATA%\kernelhub-studio）刻意保留 —— 卸载不该删用户的插件与设置。
 *
 * 【重要】用 .NET Framework 的 csc.exe 编译（C# 5）：不要用 $""、?. 等 C# 6+ 语法。
 */

using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace KhsUninstall
{
    internal static class Program
    {
        private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\KernelHub Studio";

        [STAThread]
        private static int Main(string[] args)
        {
            bool silent = false;
            string dir = null;
            foreach (string a in args)
            {
                if (a == null) continue;
                string t = a.Trim();
                if (t.Equals("/S", StringComparison.OrdinalIgnoreCase)) silent = true;
                else if (t.StartsWith("/DIR=", StringComparison.OrdinalIgnoreCase)) dir = t.Substring(5).Trim('"');
            }

            // 第二步：从临时目录跑起来，这时可以真正删掉安装目录与自身
            if (!string.IsNullOrEmpty(dir))
            {
                DeleteTree(dir);
                return 0;
            }

            if (silent)
            {
                FirstPhase();
                return 0;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new ConfirmForm());
            return 0;
        }

        /**
         * 第一步：清快捷方式与注册表，然后把自己复制到临时目录、带 /DIR= 重新启动。
         * 不能直接删安装目录 —— 自己正运行在里面，Windows 不允许。
         */
        public static void FirstPhase()
        {
            string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);

            TryDelete(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "KernelHub Studio.lnk"));
            TryDelete(Path.Combine(
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    @"Microsoft\Windows\Start Menu\Programs"),
                "KernelHub Studio.lnk"));

            try { Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false); } catch { }

            try
            {
                string temp = Path.Combine(Path.GetTempPath(), "khs-uninstall-" + Guid.NewGuid().ToString("N") + ".exe");
                File.Copy(Assembly.GetExecutingAssembly().Location, temp, true);
                ProcessStartInfo psi = new ProcessStartInfo(temp);
                psi.Arguments = "/S /DIR=\"" + dir + "\"";
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                Process.Start(psi);
            }
            catch { }
        }

        /** 第二步：删安装目录，再让一个批处理把自己删掉 */
        private static void DeleteTree(string dir)
        {
            for (int i = 0; i < 20; i++)
            {
                try
                {
                    if (Directory.Exists(dir)) Directory.Delete(dir, true);
                    break;
                }
                catch
                {
                    Thread.Sleep(300);
                }
            }
            try
            {
                string self = Assembly.GetExecutingAssembly().Location;
                string bat = Path.Combine(Path.GetTempPath(), "khs-clean-" + Guid.NewGuid().ToString("N") + ".cmd");
                File.WriteAllText(bat,
                    "@echo off\r\n" +
                    "ping 127.0.0.1 -n 3 > nul\r\n" +
                    "del /f /q \"" + self + "\"\r\n" +
                    "del /f /q \"%~f0\"\r\n");
                ProcessStartInfo psi = new ProcessStartInfo(bat);
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                Process.Start(psi);
            }
            catch { }
        }

        private static void TryDelete(string path)
        {
            try { if (File.Exists(path)) File.Delete(path); } catch { }
        }

        /* ------------------------------------------------------------ 确认窗 */

        private sealed class ConfirmForm : Form
        {
            private readonly Rectangle _ok = new Rectangle(300, 148, 120, 40);
            private readonly Rectangle _cancel = new Rectangle(168, 148, 120, 40);
            private bool _hoverOk;

            public ConfirmForm()
            {
                Text = "卸载 KernelHub Studio";
                FormBorderStyle = FormBorderStyle.None;
                StartPosition = FormStartPosition.CenterScreen;
                ClientSize = new Size(440, 210);
                DoubleBuffered = true;
                SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
                MouseClick += OnClick;
                MouseMove += delegate(object s, MouseEventArgs e)
                {
                    bool h = _ok.Contains(e.Location);
                    if (h != _hoverOk) { _hoverOk = h; Invalidate(); }
                };
            }

            protected override void OnHandleCreated(EventArgs e)
            {
                base.OnHandleCreated(e);
                IntPtr rgn = CreateRoundRectRgn(0, 0, Width + 1, Height + 1, 16, 16);
                Region = Region.FromHrgn(rgn);
                DeleteObject(rgn);
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                Graphics g = e.Graphics;
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.White);
                using (Font fTitle = Ui(14f, FontStyle.Regular))
                using (Font fBody = Ui(9.5f, FontStyle.Regular))
                using (SolidBrush ink = new SolidBrush(Color.FromArgb(0x11, 0x11, 0x11)))
                using (SolidBrush dim = new SolidBrush(Color.FromArgb(0x66, 0x66, 0x66)))
                {
                    g.DrawString("卸载 KernelHub Studio", fTitle, ink, 28, 32);
                    g.DrawString("将删除程序文件、快捷方式与注册表项。", fBody, dim, 28, 68);
                    g.DrawString("已安装的插件与设置保存在用户目录，不会被删除。", fBody, dim, 28, 90);
                }
                Button(g, _cancel, "取消", Color.White, Color.FromArgb(0x11, 0x11, 0x11));
                Button(g, _ok, "卸载", Color.FromArgb(0xE8, 0x27, 0x1B), Color.White);
                using (Pen p = new Pen(Color.FromArgb(0xE4, 0xE4, 0xE4))) g.DrawRectangle(p, 0, 0, Width - 1, Height - 1);
            }

            private void Button(Graphics g, Rectangle r, string text, Color bg, Color fg)
            {
                using (GraphicsPath path = Round(r, 8))
                using (SolidBrush b = new SolidBrush(bg))
                using (Pen p = new Pen(Color.FromArgb(0xE4, 0xE4, 0xE4)))
                {
                    g.FillPath(b, path);
                    g.DrawPath(p, path);
                }
                using (Font f = Ui(9.5f, FontStyle.Regular))
                using (StringFormat sf = new StringFormat())
                {
                    sf.Alignment = StringAlignment.Center;
                    sf.LineAlignment = StringAlignment.Center;
                    using (SolidBrush fb = new SolidBrush(fg)) g.DrawString(text, f, fb, r, sf);
                }
            }

            private void OnClick(object sender, MouseEventArgs e)
            {
                if (_cancel.Contains(e.Location)) { Close(); return; }
                if (_ok.Contains(e.Location))
                {
                    Hide();
                    FirstPhase();
                    Close();
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

            private static Font Ui(float size, FontStyle style)
            {
                try { return new Font("Microsoft YaHei UI", size, style); }
                catch { return new Font(FontFamily.GenericSansSerif, size, style); }
            }

            [DllImport("gdi32.dll")]
            private static extern IntPtr CreateRoundRectRgn(int l, int t, int r, int b, int w, int h);

            [DllImport("gdi32.dll")]
            private static extern bool DeleteObject(IntPtr hObject);
        }
    }
}
