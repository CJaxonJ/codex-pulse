using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8", FrameworkDisplayName = ".NET Framework 4.8")]

namespace CodexPulse {
    internal static class Program {
        internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };
        internal static readonly Color Green = Color.FromArgb(46, 133, 117);
        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsWindowVisible(IntPtr window);
        [STAThread]
        private static int Main(string[] args) {
            try {
                Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                if (args.Length == 1 && args[0] == "--notify") {
                    string text = ReadPayload();
                    Dictionary<string, object> payload = Json.DeserializeObject(text) as Dictionary<string, object>;
                    if (payload == null) throw new InvalidDataException();
                    Notice notice = new Notice(payload);
                    if (notice.Persistent) {
                        using (NoticeWindow window = new NoticeWindow(notice)) {
                            window.Shown += delegate {
                                if (!window.Visible || !IsWindowVisible(window.Handle)) throw new IOException();
                                Acknowledge("shown");
                            };
                            Application.Run(window);
                        }
                    } else {
                        using (BannerContext banner = new BannerContext(notice)) Application.Run(banner);
                    }
                } else if (args.Length == 1 && args[0] == "--protection") {
                    using (ProtectionWindow window = new ProtectionWindow()) Application.Run(window);
                } else if (args.Length == 0 || (args.Length == 1 && args[0] == "--settings")) {
                    using (SettingsWindow window = new SettingsWindow()) Application.Run(window);
                } else if (args.Length == 1 && (args[0] == "--history" || args[0] == "--preview")) {
                    using (HistoryWindow window = new HistoryWindow(args.Length == 1 && args[0] == "--preview")) Application.Run(window);
                } else { throw new ArgumentException(); }
                return 0;
            } catch (Exception error) {
                // Do not leak prompt text, home paths or credentials in the UI protocol.
                string method = error.TargetSite == null ? "startup" : error.TargetSite.DeclaringType.FullName + "." + error.TargetSite.Name;
                Console.Error.WriteLine("Codex Pulse interface failed: " + error.GetType().Name + " at " + method);
                return 1;
            }
        }
        private static string ReadPayload() {
            char[] buffer = new char[4096];
            StringBuilder value = new StringBuilder();
            int count;
            // A WinExe has no console code page. Setting Console.InputEncoding
            // calls SetConsoleCP and fails without a console; decode the pipe.
            using (StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true))) {
                while ((count = input.Read(buffer, 0, buffer.Length)) > 0) {
                    value.Append(buffer, 0, count);
                    if (value.Length > 65536) throw new InvalidDataException();
                }
            }
            return value.ToString();
        }
        internal static void Acknowledge(string status) {
            using (StreamWriter output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false), 1024, true)) {
                output.WriteLine("{\"status\":\"" + status + "\"}");
                output.Flush();
            }
        }
        internal static string StringValue(IDictionary<string, object> value, string key, int limit = 20000) {
            object result;
            string text = value != null && value.TryGetValue(key, out result) && result != null ? Convert.ToString(result) : "";
            return text.Length > limit ? text.Substring(0, limit) : text;
        }
        internal static bool BooleanValue(IDictionary<string, object> value, string key, bool fallback) {
            object result;
            return value.TryGetValue(key, out result) && result is bool ? (bool)result : fallback;
        }
        internal static string LocalTime(IDictionary<string, object> value, string key) {
            object raw;
            if (!value.TryGetValue(key, out raw) || raw == null) return "未知";
            try { return DateTimeOffset.FromUnixTimeSeconds(Convert.ToInt64(raw)).ToLocalTime().ToString("g"); }
            catch (FormatException) { return "未知"; }
            catch (OverflowException) { return "未知"; }
            catch (InvalidCastException) { return "未知"; }
            catch (ArgumentOutOfRangeException) { return "未知"; }
        }
        internal static string SafeSource(string value) {
            Uri uri;
            if (value.Length > 2048 || !Uri.TryCreate(value, UriKind.Absolute, out uri) || uri.Scheme != "https"
                || !new[] { "x.com", "www.x.com", "twitter.com", "www.twitter.com" }.Contains(uri.Host)
                || !String.IsNullOrEmpty(uri.UserInfo) || !uri.IsDefaultPort
                || !Regex.IsMatch(uri.AbsolutePath, @"^/(?:[a-zA-Z0-9_]{1,15}|i)/(?:status|web/status)/[0-9]{1,25}/?$")) return "";
            return "https://x.com" + uri.AbsolutePath.TrimEnd('/');
        }
        internal static void OpenSource(string value) {
            string safe = SafeSource(value);
            if (safe.Length == 0) return;
            Process.Start(new ProcessStartInfo(safe) { UseShellExecute = true });
        }
        internal static Icon AppIcon() {
            return Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        }
        internal static Button Button(string title, EventHandler click) {
            Button button = new Button { Text = title, AutoSize = true, MinimumSize = new Size(112, 40), Margin = new Padding(8, 0, 0, 0), Padding = new Padding(12, 8, 12, 8), AccessibleName = title, AccessibleRole = AccessibleRole.PushButton };
            button.Click += click;
            return button;
        }
        internal static RichTextBox TextArea() {
            return new RichTextBox { Dock = DockStyle.Fill, ReadOnly = true, BorderStyle = BorderStyle.None,
                DetectUrls = false, BackColor = SystemColors.Window, ForeColor = SystemColors.WindowText,
                ScrollBars = RichTextBoxScrollBars.Vertical, AccessibleName = "消息内容" };
        }
        internal static void Style(Form window, string title) {
            window.Text = title;
            window.Icon = AppIcon();
            window.AutoScaleMode = AutoScaleMode.Dpi;
            window.Font = SystemFonts.MessageBoxFont;
            window.BackColor = SystemColors.Window;
            window.ForeColor = SystemColors.WindowText;
            window.Padding = new Padding(24);
            window.StartPosition = FormStartPosition.CenterScreen;
            window.MinimumSize = new Size(480, 400);
            window.ClientSize = new Size(560, 440);
        }
    }

    internal sealed class Notice {
        internal readonly string Title, Body, Severity, Source, SourceText, SourceHeading, Action;
        internal readonly bool Persistent, Sound;
        internal Notice(IDictionary<string, object> value) {
            Title = Program.StringValue(value, "title", 180);
            if (Title.Length == 0) Title = "Codex Pulse";
            Body = Program.StringValue(value, "body", 2000);
            string severity = Program.StringValue(value, "severity");
            Severity = new[] { "critical", "warning", "info" }.Contains(severity) ? severity : "info";
            Source = Program.SafeSource(Program.StringValue(value, "sourceUrl"));
            SourceText = Program.StringValue(value, "sourceText");
            SourceHeading = Program.StringValue(value, "sourceTextKind") == "summary" ? "来源摘要（非逐字原文）" : "原文";
            Action = Program.StringValue(value, "action") == "preview" ? "preview" : "history";
            Persistent = Program.BooleanValue(value, "persistent", false);
            Sound = Program.BooleanValue(value, "sound", true);
        }
    }

    internal sealed class NoticeWindow : Form {
        internal NoticeWindow(Notice notice) {
            Program.Style(this, "Codex Pulse · " + notice.Title);
            TableLayoutPanel layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3 };
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            string level = notice.Severity == "critical" ? "重要" : notice.Severity == "warning" ? "留意" : "提醒";
            Label heading = new Label { Text = level + " · " + notice.Title, AutoSize = true, MaximumSize = new Size(480, 0),
                Font = new Font(Font, FontStyle.Bold), ForeColor = notice.Severity == "critical" ? Color.Firebrick : Program.Green,
                Margin = new Padding(0, 0, 0, 16), AccessibleName = "提醒标题" };
            RichTextBox body = Program.TextArea();
            body.Margin = new Padding(0, 0, 0, 24);
            body.Text = notice.Body + (notice.SourceText.Length > 0 ? "\n\n" + notice.SourceHeading + "\n" + notice.SourceText : "");
            FlowLayoutPanel actions = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, WrapContents = true, Margin = new Padding(0) };
            Button dismiss = Program.Button("知道了", delegate { Close(); });
            dismiss.BackColor = Program.Green; dismiss.ForeColor = Color.White;
            actions.Controls.Add(dismiss);
            actions.Controls.Add(Program.Button(notice.Action == "preview" ? "查看续跑计划" : "查看消息历史", delegate {
                using (HistoryWindow history = new HistoryWindow(notice.Action == "preview")) history.ShowDialog(this);
            }));
            if (notice.Source.Length > 0) actions.Controls.Add(Program.Button("查看原帖", delegate {
                try { Program.OpenSource(notice.Source); } catch { body.AppendText("\n\n未能打开浏览器，请稍后从消息历史重试。"); }
            }));
            layout.Controls.Add(heading, 0, 0); layout.Controls.Add(body, 0, 1); layout.Controls.Add(actions, 0, 2);
            Controls.Add(layout);
            AcceptButton = dismiss; CancelButton = dismiss;
            Shown += delegate { if (notice.Sound) System.Media.SystemSounds.Exclamation.Play(); };
            // Persistent notices have no auto-dismiss timer and do not steal
            // focus via TopMost. Closing is always an explicit user action.
        }
    }

    internal sealed class BannerContext : ApplicationContext {
        private readonly BalloonWindow tray;
        private readonly Timer expiry;
        private readonly Notice notice;
        internal BannerContext(Notice notice) {
            this.notice = notice;
            tray = new BalloonWindow(notice, OpenDetail);
            expiry = new Timer { Interval = 20000 };
            expiry.Tick += delegate { ExitThread(); };
            expiry.Start();
            // Windows may suppress a balloon under Do Not Disturb; this is
            // request acceptance, never proof that the user saw a banner.
            Program.Acknowledge("requested");
        }
        private void OpenDetail(object sender, EventArgs args) {
            expiry.Stop(); tray.Dispose();
            NoticeWindow window = new NoticeWindow(notice);
            window.FormClosed += delegate { ExitThread(); };
            window.Show();
        }
        protected override void Dispose(bool disposing) {
            if (disposing) { expiry.Dispose(); tray.Dispose(); }
            base.Dispose(disposing);
        }
    }

    // NotifyIcon.ShowBalloonTip has no silent option. Use the documented
    // NIIF_NOSOUND flag rather than ignoring the user's sound preference.
    internal sealed class BalloonWindow : NativeWindow, IDisposable {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct NotifyData {
            public int Size; public IntPtr Window; public uint Id, Flags, Callback;
            public IntPtr Icon;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Tip;
            public uint State, StateMask;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string Info;
            public uint Timeout;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string Title;
            public uint InfoFlags; public Guid Guid; public IntPtr BalloonIcon;
        }
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool Shell_NotifyIcon(uint command, ref NotifyData data);
        private NotifyData data;
        private readonly Icon icon;
        private readonly EventHandler click;
        private bool disposed;
        internal BalloonWindow(Notice notice, EventHandler click) {
            this.click = click; icon = Program.AppIcon();
            CreateHandle(new CreateParams { Caption = "Codex Pulse notification callback", Parent = new IntPtr(-3) });
            data = new NotifyData { Size = Marshal.SizeOf(typeof(NotifyData)), Window = Handle, Id = 1, Flags = 1 | 2 | 4,
                Callback = 0x8001, Icon = icon.Handle, Tip = "Codex Pulse", Info = "", Title = "" };
            if (!Shell_NotifyIcon(0, ref data)) { Dispose(); throw new IOException(); }
            data.Flags = 16; data.Info = notice.Body.Substring(0, Math.Min(255, notice.Body.Length));
            data.Title = notice.Title.Substring(0, Math.Min(63, notice.Title.Length));
            data.Timeout = 15000;
            data.InfoFlags = (uint)(notice.Severity == "critical" ? 3 : notice.Severity == "warning" ? 2 : 1) | (notice.Sound ? 0u : 16u);
            if (!Shell_NotifyIcon(1, ref data)) { Dispose(); throw new IOException(); }
        }
        protected override void WndProc(ref Message message) {
            if (message.Msg == 0x8001 && (message.LParam.ToInt64() == 0x405 || message.LParam.ToInt64() == 0x203)) click(this, EventArgs.Empty);
            base.WndProc(ref message);
        }
        public void Dispose() {
            if (disposed) return; disposed = true;
            Shell_NotifyIcon(2, ref data); DestroyHandle(); icon.Dispose();
        }
    }

    internal static class Bridge {
        // Windows quoting for CommandLineToArgvW, NOT cmd.exe or PowerShell.
        internal static string Quote(string text) {
            StringBuilder result = new StringBuilder("\"");
            int slashes = 0;
            foreach (char c in text) {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') result.Append('\\', slashes * 2 + 1);
                else result.Append('\\', slashes);
                slashes = 0; result.Append(c);
            }
            result.Append('\\', slashes * 2); result.Append('"');
            return result.ToString();
        }
        internal static Task<Dictionary<string, object>> Run(params string[] args) {
            return Task.Run(delegate {
                string root = Environment.GetEnvironmentVariable("CODEX_PULSE_APP_ROOT");
                if (String.IsNullOrEmpty(root)) root = AppDomain.CurrentDomain.BaseDirectory;
                root = Path.GetFullPath(root);
                string node = Path.Combine(root, "runtime", "node.exe");
                string script = Path.Combine(root, "bin", "codex-pulse.mjs");
                if (!File.Exists(node) || !File.Exists(script)) throw new IOException("安装文件不完整，请重新运行安装器。");
                ProcessStartInfo start = new ProcessStartInfo(node, String.Join(" ", new[] { script }.Concat(args).Select(Quote).ToArray())) {
                    UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8, WorkingDirectory = root
                };
                using (Process process = Process.Start(start)) {
                    Task<string> output = process.StandardOutput.ReadToEndAsync();
                    Task<string> errors = process.StandardError.ReadToEndAsync();
                    if (!process.WaitForExit(15000)) { try { process.Kill(); } catch { } throw new IOException("本机数据暂未读到，请重试。"); }
                    Task.WaitAll(output, errors);
                    if (process.ExitCode != 0) throw new IOException("无法读取本机记录，请检查安装后重试。");
                    Dictionary<string, object> result = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 }.DeserializeObject(output.Result) as Dictionary<string, object>;
                    if (result == null) throw new IOException("本机记录格式异常，请重试。");
                    return result;
                }
            });
        }
    }

    internal sealed class HistoryWindow : Form {
        private readonly ListBox entries;
        private readonly RichTextBox details;
        private readonly Button source;
        private readonly Button refresh;
        private readonly bool preview;
        private IList<Dictionary<string, object>> records = new List<Dictionary<string, object>>();
        internal HistoryWindow(bool preview) {
            this.preview = preview;
            Program.Style(this, preview ? "Codex Pulse · 续跑计划" : "Codex Pulse · 消息历史");
            ClientSize = new Size(640, 560);
            TableLayoutPanel layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4 };
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 128));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.Controls.Add(new Label { AutoSize = true, Text = preview ? "原目标、已完成内容和下一步" : "最近收到的消息 · 保留原文入口", Margin = new Padding(0, 0, 0, 16), Font = new Font(Font, FontStyle.Bold) }, 0, 0);
            entries = new ListBox { Dock = DockStyle.Fill, IntegralHeight = false, AccessibleName = preview ? "任务列表" : "消息列表", Margin = new Padding(0, 0, 0, 16) };
            entries.SelectedIndexChanged += delegate { SelectRecord(); };
            details = Program.TextArea(); details.Text = "正在读取本机记录…";
            FlowLayoutPanel actions = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, FlowDirection = FlowDirection.RightToLeft, Margin = new Padding(0, 16, 0, 0) };
            actions.Controls.Add(Program.Button("关闭", delegate { Close(); }));
            refresh = Program.Button("刷新", async delegate { await LoadRecords(); }); actions.Controls.Add(refresh);
            source = Program.Button("查看原帖", delegate {
                if (entries.SelectedIndex < 0 || entries.SelectedIndex >= records.Count) return;
                try { Program.OpenSource(Program.StringValue(records[entries.SelectedIndex], "sourceUrl")); }
                catch { details.AppendText("\n\n未能打开浏览器，请稍后重试。"); }
            });
            source.Visible = !preview; source.Enabled = false; actions.Controls.Add(source);
            layout.Controls.Add(entries, 0, 1); layout.Controls.Add(details, 0, 2); layout.Controls.Add(actions, 0, 3);
            Controls.Add(layout);
            Shown += async delegate { await LoadRecords(); };
        }
        private async Task LoadRecords() {
            refresh.Enabled = false;
            try {
                Dictionary<string, object> data = await Bridge.Run(preview ? "preview" : "history");
                if (IsDisposed) return;
                object raw;
                IEnumerable values = data.TryGetValue(preview ? "tasks" : "events", out raw) ? raw as IEnumerable : null;
                records = values == null ? new List<Dictionary<string, object>>() : values.Cast<object>().OfType<Dictionary<string, object>>().Reverse().ToList();
                entries.Items.Clear();
                foreach (Dictionary<string, object> item in records) entries.Items.Add(Program.StringValue(item, preview ? "objective" : "title", 180));
                if (records.Count > 0) entries.SelectedIndex = 0;
                else { details.Text = preview ? "当前没有待续跑任务。达到保护线后，已保存的计划会出现在这里。" : "还没有消息。收到提醒后，可在这里重新查看。"; source.Enabled = false; }
            } catch (Exception error) { if (!IsDisposed) details.Text = error.Message; }
            finally { if (!IsDisposed) refresh.Enabled = true; }
        }
        private void SelectRecord() {
            if (entries.SelectedIndex < 0 || entries.SelectedIndex >= records.Count) return;
            Dictionary<string, object> record = records[entries.SelectedIndex];
            if (!preview) {
                string received = Program.LocalTime(record, "occurredAt"), posted = Program.LocalTime(record, "sourceAt");
                string heading = Program.StringValue(record, "sourceTextKind") == "summary" ? "来源摘要（非逐字原文）" : "原文";
                string original = Program.StringValue(record, "sourceText");
                details.Text = "收到时间：" + received + "\n" + Program.StringValue(record, "body")
                    + (original.Length > 0 ? "\n\n" + heading + " · 原帖时间：" + posted + "\n" + original : "");
                source.Enabled = Program.SafeSource(Program.StringValue(record, "sourceUrl")).Length > 0;
                return;
            }
            Dictionary<string, object> restart = record.ContainsKey("restart") ? record["restart"] as Dictionary<string, object> : null;
            Dictionary<string, object> duration = record.ContainsKey("duration") ? record["duration"] as Dictionary<string, object> : null;
            string time = "";
            object at;
            if (restart != null && restart.TryGetValue("earliestAt", out at)) time = "\n最早额度恢复时间：" + Program.LocalTime(restart, "earliestAt");
            string estimate = Program.StringValue(duration, "source");
            if (duration != null && duration.ContainsKey("minMinutes") && duration["minMinutes"] != null)
                estimate = Program.StringValue(duration, "minMinutes") + "–" + Program.StringValue(duration, "maxMinutes") + " 分钟（估算，非承诺）";
            details.Text = "原目标\n" + Program.StringValue(record, "objective") + "\n\n当前状态\n" + Program.StringValue(record, "statusText")
                + "\n\n已完成\n" + Program.StringValue(record, "completed") + "\n\n剩余工作\n" + Program.StringValue(record, "remaining")
                + "\n\n下一步\n" + Program.StringValue(record, "nextAction") + "\n\n何时启动\n" + Program.StringValue(restart, "text") + time
                + "\n\n剩余耗时\n" + estimate + "\n\n需要留意\n" + Program.StringValue(record, "blockers");
        }
    }
}
