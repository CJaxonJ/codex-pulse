using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace CodexPulse {
    // Source-package UI. Installation still runs through the same verified,
    // transaction-protected Node entry as automated acceptance, without a shell.
    internal sealed class SetupWindow : Form {
        private readonly Label heading, description;
        private readonly RichTextBox feedback;
        private readonly Button primary, remove, close;
        private readonly CheckBox login;
        private readonly ProgressBar progress;
        private bool busy, confirmRemoval, completed;
        private readonly string root = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
        internal static bool IsSourcePackage() {
            string own = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).TrimEnd('\\');
            string installed = WindowsPaths.InstalledApp.TrimEnd('\\');
            return File.Exists(Path.Combine(own, "bundle-manifest.json")) && !own.Equals(installed, StringComparison.OrdinalIgnoreCase);
        }
        internal SetupWindow() {
            Program.Style(this, "Codex Pulse · 安装"); ClientSize = new Size(560, 440);
            TableLayoutPanel layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 7 };
            for (int i = 0; i < 7; i++) layout.RowStyles.Add(new RowStyle(i == 4 ? SizeType.Percent : SizeType.AutoSize, i == 4 ? 100 : 0));
            heading = new Label { Text = "安装 Codex Pulse", AutoSize = true, Font = new Font(Font, FontStyle.Bold), Margin = new Padding(0, 0, 0, 16) };
            description = new Label { Text = "额度提醒、重置消息和任务进度保护。\n安装到当前用户目录，无需管理员权限。", AutoSize = true, MaximumSize = new Size(480, 0), Margin = new Padding(0, 0, 0, 24) };
            login = new CheckBox { Text = "登录 Windows 时启动", AutoSize = true, Checked = true, Margin = new Padding(0, 0, 0, 16) };
            progress = new ProgressBar { Dock = DockStyle.Fill, Style = ProgressBarStyle.Marquee, Visible = false, Margin = new Padding(0, 0, 0, 16) };
            feedback = Program.TextArea(); feedback.AccessibleName = "安装状态";
            feedback.Text = "请先在本机 Codex 登录。\n安装不会替你确认保护授权，也不会自动开启用卡。";
            Label privacy = new Label { Text = "重装和卸载保留进度、偏好与用卡记录。", AutoSize = true, Margin = new Padding(0, 16, 0, 16) };
            FlowLayoutPanel actions = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, FlowDirection = FlowDirection.RightToLeft, Margin = new Padding(0) };
            primary = Program.Button("安装", async delegate {
                if (completed && !confirmRemoval) { OpenInstalled("--settings"); return; }
                await Execute(confirmRemoval);
            }); primary.BackColor = Program.Green; primary.ForeColor = Color.White;
            close = Program.Button("关闭", delegate { if (confirmRemoval) Reset(); else Close(); });
            remove = Program.Button("卸载", delegate {
                if (busy) return;
                confirmRemoval = true; heading.Text = "卸载 Codex Pulse？";
                description.Text = "停止后台并移除本产品程序、自启和插件。\n保留已有记录，不会卸载 Codex 本身。";
                primary.Text = "确认卸载"; primary.AccessibleName = primary.Text; close.Text = "返回"; close.AccessibleName = close.Text;
                remove.Visible = false; login.Visible = false;
            });
            remove.Visible = HasRemovalEntry();
            if (remove.Visible) { heading.Text = "管理 Codex Pulse"; primary.Text = "更新或修复"; primary.AccessibleName = primary.Text; login.Visible = false; }
            actions.Controls.Add(primary); actions.Controls.Add(close); actions.Controls.Add(remove);
            layout.Controls.Add(heading, 0, 0); layout.Controls.Add(description, 0, 1); layout.Controls.Add(login, 0, 2);
            layout.Controls.Add(progress, 0, 3); layout.Controls.Add(feedback, 0, 4); layout.Controls.Add(privacy, 0, 5); layout.Controls.Add(actions, 0, 6);
            Controls.Add(layout); CancelButton = close;
            FormClosing += delegate(object sender, FormClosingEventArgs args) { if (busy) args.Cancel = true; };
        }
        private static bool HasRemovalEntry() {
            string data = BackgroundContext.DataDirectory();
            return File.Exists(Path.Combine(data, "windows-installation.json")) || File.Exists(Path.Combine(data, "uninstallation-in-progress.json"));
        }
        private void Reset() {
            confirmRemoval = false; heading.Text = completed ? "Codex Pulse 已安装" : "安装 Codex Pulse";
            description.Text = "额度提醒、重置消息和任务进度保护。\n安装到当前用户目录，无需管理员权限。";
            remove.Visible = HasRemovalEntry();
            primary.Text = completed ? "打开设置" : remove.Visible ? "更新或修复" : "安装"; primary.AccessibleName = primary.Text; close.Text = "关闭"; close.AccessibleName = close.Text;
            login.Visible = !completed && !remove.Visible;
        }
        private void OpenInstalled(string mode) {
            try {
                string app = Path.Combine(BackgroundContext.DataDirectory(), "app");
                ProcessStartInfo info = new ProcessStartInfo { FileName = Path.Combine(app, "CodexPulse.exe"), Arguments = mode, UseShellExecute = false, WorkingDirectory = app };
                info.EnvironmentVariables["CODEX_PULSE_APP_ROOT"] = app;
                using (Process launched = Process.Start(info)) { if (launched == null) throw new IOException(); }
            } catch { feedback.Text = "未能打开设置。请重新打开安装包修复后再试。"; }
        }
        private static string SafeIssue(string stderr) {
            try {
                Dictionary<string, object> value = Program.Json.DeserializeObject(stderr) as Dictionary<string, object>;
                string text = Program.StringValue(value, "error", 600);
                // Display actionable product messages, not raw command lines,
                // exception stacks or paths copied from subprocess failures.
                foreach (string prefix in new[] { "托管任务", "后台正在", "Codex Pulse 正在", "自启实例", "中断记录", "发现上次", "发现未完成", "无法确认旧后台", "尚未读取到", "无法确认 Codex", "安装包", "安装失败且", "安装未成功", "卸载未完成", "运行目录", "现有运行", "请从下载" }) {
                    if (text.StartsWith(prefix, StringComparison.Ordinal) && text.IndexOf('\n') < 0 && text.IndexOf('\r') < 0) return text;
                }
            } catch { }
            return "操作未完成，已有记录和现场已保留。请确认 Codex 已登录、网络可用，然后重试。";
        }
        private async Task Execute(bool uninstall) {
            if (busy) return;
            busy = true; primary.Enabled = false; remove.Enabled = false; close.Enabled = false; login.Enabled = false; progress.Visible = true;
            heading.Text = uninstall ? "正在卸载" : "正在安装";
            feedback.Text = uninstall ? "正在停止后台并处理本产品文件，请保持窗口打开。" : "正在检查安装包和本机账号，并安装后台。\n若发现上次中断，会先核实并恢复。请保持窗口打开。";
            bool startAtLogin = login.Checked;
            try {
                Dictionary<string, object> result = await Task.Run(delegate {
                    string node = Path.Combine(root, "runtime", "node.exe"), script = Path.Combine(root, "scripts", uninstall ? "uninstall-windows.mjs" : "install-windows.mjs");
                    if (!File.Exists(node) || !File.Exists(script)) throw new IOException("请完整解压安装包后重试。");
                    ProcessStartInfo info = new ProcessStartInfo { FileName = node, Arguments = Bridge.Quote(script) + (!uninstall && !startAtLogin ? " --no-start-at-login" : ""),
                        UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                        StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8, WorkingDirectory = root };
                    using (Process installer = Process.Start(info)) {
                        if (installer == null) throw new IOException();
                        Task<string> output = installer.StandardOutput.ReadToEndAsync(), errors = installer.StandardError.ReadToEndAsync();
                        // No timed PID kill. The child has bounded RPC waits;
                        // closing this UI is disabled until the real exit.
                        installer.WaitForExit(); Task.WaitAll(output, errors);
                        if (installer.ExitCode != 0) throw new IOException(SafeIssue(errors.Result));
                        Dictionary<string, object> value = Program.Json.DeserializeObject(output.Result) as Dictionary<string, object>;
                        if (!Program.BooleanValue(value, "ok", false)) throw new IOException();
                        return value;
                    }
                });
                completed = !uninstall; confirmRemoval = false; heading.Text = uninstall ? "已卸载 Codex Pulse" : "Codex Pulse 已安装";
                description.Text = uninstall ? "后台、运行程序、自启和产品插件已移除。" : "监控已安装。任务保护还需要你本人确认授权。";
                feedback.Text = uninstall ? "任务进度、偏好、额度历史和用卡记录已保留。\n现有 Codex 会话可在方便时重新打开。" : "点击“打开设置”，进入“保护与用卡”确认保护授权。\n自动用卡默认关闭，需要另外确认。";
                if (!Program.BooleanValue(result, uninstall ? "shortcutsRemoved" : "shortcutCreated", false)) feedback.AppendText(uninstall ? "\n未清理不属于本次安装的快捷方式。" : "\n快捷入口未创建，可先点击“打开设置”使用。");
                primary.Text = uninstall ? "重新安装" : "打开设置"; primary.AccessibleName = primary.Text;
                close.Text = "关闭"; close.AccessibleName = close.Text; remove.Visible = !uninstall; login.Visible = uninstall;
            } catch (Exception error) {
                heading.Text = uninstall ? "卸载未完成" : "安装未完成";
                feedback.Text = error is IOException && error.Message.Length < 600 ? error.Message : "操作未完成。请完整解压安装包、确认 Codex 已登录，再重试。";
                primary.Text = uninstall ? "重试卸载" : "重试安装"; primary.AccessibleName = primary.Text;
            } finally { busy = false; primary.Enabled = true; close.Enabled = true; remove.Enabled = true; login.Enabled = true; progress.Visible = false; }
        }
    }

    internal static class SetupShortcut {
        private const string Description = "https://github.com/CJaxonJ/codex-pulse#start-menu/v1";
        internal static string Stage = "none";
        private static string App { get { return WindowsPaths.InstalledApp; } }
        private static string Folder {
            get {
                // Explicit custom data profiles must not overwrite the normal
                // user's Start menu entry (also isolates native acceptance).
                string normal = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Codex Pulse");
                return WindowsPaths.CanonicalDirectory(BackgroundContext.DataDirectory()).Equals(WindowsPaths.CanonicalDirectory(normal), StringComparison.OrdinalIgnoreCase)
                    ? Environment.GetFolderPath(Environment.SpecialFolder.Programs) : Path.Combine(BackgroundContext.DataDirectory(), "shortcuts");
            }
        }
        private static string FileName { get { return Path.Combine(Folder, "Codex Pulse.lnk"); } }
        private static IShellLinkW Link(bool create) {
            if (!System.Text.RegularExpressions.Regex.IsMatch(Folder, @"^[A-Za-z]:[\\/]")) throw new IOException();
            for (string cursor = Folder; !String.IsNullOrEmpty(cursor); cursor = Path.GetDirectoryName(cursor)) {
                try { if ((File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0) throw new IOException(); }
                catch (DirectoryNotFoundException) { } catch (FileNotFoundException) { }
            }
            bool exists = false;
            try {
                FileAttributes attributes = File.GetAttributes(FileName); exists = true;
                if ((attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0) throw new IOException();
            } catch (DirectoryNotFoundException) { } catch (FileNotFoundException) { }
            if (!exists && !create) return null;
            if (!Directory.Exists(Folder)) Directory.CreateDirectory(Folder);
            Stage = "create-shell-link";
            IShellLinkW link = (IShellLinkW)new ShellLinkObject();
            try {
                if (exists) {
                    if (new FileInfo(FileName).Length > 1024 * 1024) throw new IOException();
                    Stage = "load-owned-link"; ((IPersistFile)link).Load(FileName, 0);
                    StringBuilder description = new StringBuilder(512), arguments = new StringBuilder(1024), target = new StringBuilder(260), directory = new StringBuilder(260);
                    link.GetDescription(description, description.Capacity); link.GetArguments(arguments, arguments.Capacity);
                    link.GetPath(target, target.Capacity, IntPtr.Zero, 4); // SLGP_RAWPATH; never Resolve a foreign target.
                    link.GetWorkingDirectory(directory, directory.Capacity);
                    if (description.ToString() != Description || arguments.ToString() != "--settings"
                        || !String.Equals(target.ToString(), Path.Combine(App, "CodexPulse.exe"), StringComparison.OrdinalIgnoreCase)
                        || !String.Equals(directory.ToString(), App, StringComparison.OrdinalIgnoreCase)) throw new IOException();
                }
                return link;
            } catch { Marshal.FinalReleaseComObject(link); throw; }
        }
        internal static void Create() {
            if ((File.GetAttributes(App) & FileAttributes.ReparsePoint) != 0) throw new IOException();
            foreach (string entry in new[] { Path.Combine(App, "CodexPulse.exe"), Path.Combine(BackgroundContext.DataDirectory(), "windows-installation.json") }) {
                if ((File.GetAttributes(entry) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0) throw new IOException();
            }
            using (FileStream guard = Guard()) {
                IShellLinkW link = Link(true);
                try {
                    Stage = "set-target"; link.SetPath(Path.Combine(App, "CodexPulse.exe"));
                    Stage = "set-arguments"; link.SetArguments("--settings");
                    Stage = "set-directory"; link.SetWorkingDirectory(App);
                    Stage = "set-description"; link.SetDescription(Description);
                    Stage = "set-icon"; link.SetIconLocation(Path.Combine(App, "CodexPulse.exe"), 0);
                    Stage = "save-link"; ((IPersistFile)link).Save(FileName, true);
                } finally { Marshal.FinalReleaseComObject(link); }
            }
        }
        private static FileStream Guard() {
            string file = Path.Combine(BackgroundContext.DataDirectory(), "shortcut.guard");
            try { if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new IOException(); }
            catch (FileNotFoundException) { } catch (DirectoryNotFoundException) { }
            return File.Open(file, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        }
        private static void RemoveCore() {
            IShellLinkW link = Link(false);
            if (link != null) { Marshal.FinalReleaseComObject(link); Stage = "remove-owned-link"; File.Delete(FileName); }
        }
        internal static void Remove() { using (FileStream guard = Guard()) RemoveCore(); }
        internal static void RemoveIfUninstalled() {
            // A subsequent installer may have committed while the old
            // uninstaller was finishing. Never erase its new shortcut.
            using (FileStream guard = Guard()) {
                foreach (string entry in new[] { App, Path.Combine(BackgroundContext.DataDirectory(), "windows-installation.json") }) {
                    try { File.GetAttributes(entry); throw new IOException(); }
                    catch (DirectoryNotFoundException) { } catch (FileNotFoundException) { }
                }
                RemoveCore();
            }
        }
    }
}
