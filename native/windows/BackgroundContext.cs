using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using System.Collections.Generic;

namespace CodexPulse {
    internal sealed class BackgroundContext : ApplicationContext {
        private readonly string root, data, generation = Guid.NewGuid().ToString("N");
        private readonly FileStream guard;
        private readonly EventWaitHandle stop;
        private readonly System.Windows.Forms.Timer timer;
        private readonly NotifyIcon tray;
        private readonly Stopwatch clock = Stopwatch.StartNew();
        private readonly object logGate = new object();
        private Process worker;
        private double nextStart;
        private int failures, restarts;
        private bool started, stopping;
        private volatile bool ready;
        private string state;

        internal static string DataDirectory() {
            string directory = Environment.GetEnvironmentVariable("CODEX_PULSE_DATA_DIR");
            if (String.IsNullOrEmpty(directory)) directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Codex Pulse");
            if (!Regex.IsMatch(directory, @"^[A-Za-z]:[\\/]")) throw new IOException();
            string data = Path.GetFullPath(directory).TrimEnd('\\');
            if (data.IndexOf(':', 2) >= 0) throw new IOException();
            foreach (string reserved in new[] { Path.GetPathRoot(directory), Path.GetTempPath(),
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                Environment.GetFolderPath(Environment.SpecialFolder.Windows), Environment.GetFolderPath(Environment.SpecialFolder.System),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86) }) {
                if (String.IsNullOrEmpty(reserved)) continue;
                string path = Path.GetFullPath(reserved).TrimEnd('\\');
                if (path.Equals(data, StringComparison.OrdinalIgnoreCase) || path.StartsWith(data + "\\", StringComparison.OrdinalIgnoreCase)) throw new IOException();
            }
            string app = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).TrimEnd('\\');
            if ((app.Equals(data, StringComparison.OrdinalIgnoreCase) || app.StartsWith(data + "\\", StringComparison.OrdinalIgnoreCase))
                && !app.Equals(Path.Combine(data, "app"), StringComparison.OrdinalIgnoreCase)) throw new IOException();
            for (string cursor = data; !String.IsNullOrEmpty(cursor); cursor = Path.GetDirectoryName(cursor)) {
                FileAttributes attributes;
                try { attributes = File.GetAttributes(cursor); }
                catch (FileNotFoundException) { continue; } catch (DirectoryNotFoundException) { continue; }
                if ((attributes & FileAttributes.ReparsePoint) != 0) throw new IOException();
            }
            return data;
        }
        private static string SignalName(string data, string generation) {
            using (SHA256 hash = SHA256.Create()) {
                string id = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(data.TrimEnd('\\').ToUpperInvariant()))).Replace("-", "");
                return "Global\\CodexPulse-" + WindowsIdentity.GetCurrent().User.Value + "-" + id + "-" + generation;
            }
        }
        private static bool SharingViolation(IOException error) { int code = error.HResult & 0xffff; return code == 32 || code == 33; }
        private static bool GuardFree(string data) {
            string file = Path.Combine(data, "background.guard");
            if (!File.Exists(file)) return true;
            try { using (FileStream stream = File.Open(file, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) return true; }
            catch (IOException error) { if (SharingViolation(error)) return false; throw; }
        }
        private static void ConfirmWatcherStopped(string data) {
            if (!Directory.Exists(data)) return;
            Environment.SetEnvironmentVariable("CODEX_PULSE_APP_ROOT", Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory));
            Dictionary<string, object> probe = Bridge.Run("background-probe").GetAwaiter().GetResult();
            if (!Program.BooleanValue(probe, "watcherStopped", false)) throw new IOException();
        }
        internal static void AssertQuiescent(string data) {
            if (!GuardFree(data)) throw new IOException();
            ConfirmWatcherStopped(data);
        }
        internal static int RequestStop() {
            string data = DataDirectory(), file = Path.Combine(data, "background-status.json");
            if (GuardFree(data)) { ConfirmWatcherStopped(data); Program.Acknowledge("not_running"); return 0; }
            if (!File.Exists(file) || new FileInfo(file).Length > 8192) throw new IOException();
            Dictionary<string, object> status = Program.Json.DeserializeObject(File.ReadAllText(file, Encoding.UTF8)) as Dictionary<string, object>;
            string generation = Program.StringValue(status, "generation"); Guid parsed;
            if (!Guid.TryParse(generation, out parsed)) throw new IOException();
            // Signal the exact generation; never terminate a PID from a file.
            using (EventWaitHandle signal = EventWaitHandle.OpenExisting(SignalName(data, generation))) {
                signal.Set();
                Stopwatch deadline = Stopwatch.StartNew();
                while (!GuardFree(data) && deadline.Elapsed.TotalSeconds < 15) Thread.Sleep(100);
                if (!GuardFree(data)) throw new IOException();
            }
            ConfirmWatcherStopped(data);
            Program.Acknowledge("stopped"); return 0;
        }
        internal static int Run() {
            string root = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory), data = DataDirectory();
            Environment.SetEnvironmentVariable("CODEX_PULSE_APP_ROOT", root);
            Environment.SetEnvironmentVariable("CODEX_PULSE_DATA_DIR", data);
            // Only the empty guard is created before the full private ACL check.
            Directory.CreateDirectory(data);
            FileStream guard;
            using (FileStream maintenance = InstallationLease.Acquire(data)) {
                try { guard = File.Open(Path.Combine(data, "background.guard"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
                catch (IOException error) { if (!SharingViolation(error)) throw; Program.Acknowledge("already_running"); return 0; }
            }
            using (guard) {
                // A preparing host is not stopped just because its tray/event
                // does not exist yet. Unknown startup must block replacement.
                Dictionary<string, object> result = Bridge.Run("background-prepare").GetAwaiter().GetResult();
                if (!Program.BooleanValue(result, "ok", false) || !Program.BooleanValue(result, "applicable", false)) throw new IOException();
                using (BackgroundContext background = new BackgroundContext(root, data, guard)) Application.Run(background);
            }
            return 0;
        }
        private BackgroundContext(string root, string data, FileStream guard) {
            this.root = root; this.data = data; this.guard = guard;
            stop = new EventWaitHandle(false, EventResetMode.ManualReset, SignalName(data, generation));
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("打开设置", null, delegate { Open("--settings"); });
            menu.Items.Add("消息历史", null, delegate { Open("--history"); });
            menu.Items.Add("续跑计划", null, delegate { Open("--preview"); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出后台", null, delegate { stopping = true; });
            tray = new NotifyIcon { Icon = Program.AppIcon(), Text = "Codex Pulse · 后台已启动", ContextMenuStrip = menu, Visible = true };
            tray.DoubleClick += delegate { Open("--settings"); };
            timer = new System.Windows.Forms.Timer { Interval = 1000 };
            timer.Tick += delegate { Tick(); };
            StartWorker(); timer.Start();
            Program.Acknowledge("background_started"); // Process start, NOT account/notification readiness.
        }
        private void Open(string mode) {
            try { Process.Start(new ProcessStartInfo(Path.Combine(root, "CodexPulse.exe"), mode) { UseShellExecute = false, WorkingDirectory = root }); }
            catch { tray.Text = "Codex Pulse · 界面暂时无法打开"; }
        }
        private void Log(string value) {
            if (value == null) return;
            lock (logGate) try {
                string file = Path.Combine(data, "monitor.log");
                if (File.Exists(file) && new FileInfo(file).Length > 2 * 1024 * 1024) {
                    string previous = Path.Combine(data, "monitor-previous.log");
                    if (File.Exists(previous)) File.Delete(previous); File.Move(file, previous);
                }
                File.AppendAllText(file, value.Substring(0, Math.Min(8192, value.Length)) + Environment.NewLine, new UTF8Encoding(false));
            } catch { /* Logging is not proof of monitoring readiness. */ }
        }
        private void Status(string next, int? exit = null) {
            state = next;
            Dictionary<string, object> value = new Dictionary<string, object> {
                {"generation", generation}, {"supervisorPid", Process.GetCurrentProcess().Id},
                {"watcherPid", worker == null || worker.HasExited ? (object)null : worker.Id},
                {"state", state}, {"restarts", restarts}, {"lastExitCode", exit},
                {"checkedAt", DateTimeOffset.UtcNow.ToUnixTimeSeconds()}
            };
            string file = Path.Combine(data, "background-status.json"), temporary = file + "." + generation + ".tmp";
            File.WriteAllText(temporary, Program.Json.Serialize(value), new UTF8Encoding(false));
            for (int attempt = 0; ; attempt++) {
                try { if (File.Exists(file)) File.Replace(temporary, file, null); else File.Move(temporary, file); break; }
                catch (IOException error) { if (!SharingViolation(error) || attempt >= 5) throw; Thread.Sleep(20 * (attempt + 1)); }
            }
        }
        private void StartWorker() {
            ready = false; Status("starting");
            bool launched = false;
            try {
                ProcessStartInfo start = new ProcessStartInfo(Path.Combine(root, "runtime", "node.exe"), Bridge.Quote(Path.Combine(root, "bin", "codex-pulse.mjs")) + " watch") {
                    UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = root,
                    RedirectStandardOutput = true, RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
                };
                worker = new Process { StartInfo = start };
                worker.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args) { Log(args.Data); if (Object.ReferenceEquals(sender, worker) && args.Data != null && args.Data.Contains("] watcher started ")) ready = true; };
                worker.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args) { Log(args.Data); };
                worker.Start(); launched = true; worker.BeginOutputReadLine(); worker.BeginErrorReadLine();
                if (started) restarts++; started = true;
            } catch {
                if (launched && !StopWorker()) { stopping = true; Status("stopping"); return; }
                if (worker != null) { worker.Dispose(); worker = null; }
                ScheduleRetry(1);
            }
        }
        private void ScheduleRetry(int code) {
            failures = Math.Min(6, failures + 1);
            nextStart = clock.Elapsed.TotalSeconds + (code == 73 ? 60 : Math.Min(60, Math.Pow(2, failures)));
            Status(code == 73 ? "another_watcher_active" : "waiting_to_retry", code);
        }
        private bool StopWorker() {
            if (worker == null) return true;
            if (!worker.HasExited) {
                try { worker.Kill(); } catch { if (!worker.HasExited) return false; }
                if (!worker.WaitForExit(5000)) return false;
            }
            worker.Dispose(); worker = null; return true;
        }
        private void Tick() {
            if (stopping || stop.WaitOne(0)) {
                stopping = true;
                if (StopWorker()) { Status("stopped"); ExitThread(); }
                else Status("stopping");
                return;
            }
            if (worker != null && worker.HasExited) {
                int code = worker.ExitCode;
                worker.Dispose(); worker = null; ScheduleRetry(code);
            } else if (worker == null && clock.Elapsed.TotalSeconds >= nextStart) StartWorker();
            else if (worker != null && ready && state != "running") { failures = 0; Status("running"); }
        }
        protected override void Dispose(bool disposing) {
            if (disposing) { timer.Stop(); timer.Dispose(); StopWorker(); tray.Visible = false; tray.Dispose(); stop.Dispose(); }
            base.Dispose(disposing);
            // Run owns the OS guard until after all context cleanup completed.
            GC.KeepAlive(guard);
        }
    }
}
