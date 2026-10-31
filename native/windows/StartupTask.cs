using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;

namespace CodexPulse {
    // Per-user Task Scheduler registration. No Windows password, SYSTEM,
    // elevated run level, shell action, or modifications to unrelated tasks.
    internal static class StartupTask {
        private const string Source = "https://github.com/CJaxonJ/codex-pulse#windows-startup/v1";
        private static string Root { get { return Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).TrimEnd('\\'); } }
        private static string Sid { get { return WindowsIdentity.GetCurrent().User.Value; } }
        private static string ActionArguments(string data) { return "--startup-background " + Bridge.Quote(data); }
        private static string TaskName(string data) {
            using (SHA256 hash = SHA256.Create()) {
                string id = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(data.ToUpperInvariant()))).Replace("-", "").Substring(0, 24);
                return "Codex Pulse-" + Sid + "-" + id;
            }
        }
        private static dynamic Find(dynamic folder, string name) {
            try { return folder.GetTask(name); }
            catch (COMException error) { if (error.ErrorCode == unchecked((int)0x80070002)) return null; throw; }
            // The dynamic COM binder maps HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)
            // to FileNotFoundException rather than COMException on .NET Framework.
            // Only this exact missing-task result is absent, not denied/unknown.
            catch (FileNotFoundException error) { if (error.HResult == unchecked((int)0x80070002)) return null; throw; }
        }
        private static bool SameUser(string value) {
            if (value == Sid) return true;
            try { return ((SecurityIdentifier)new NTAccount(value).Translate(typeof(SecurityIdentifier))).Value == Sid; }
            catch (IdentityNotMappedException) { return false; }
        }
        private static void VerifyOwner(dynamic task, string data) {
            dynamic d = task.Definition;
            if ((string)d.RegistrationInfo.Source != Source || !SameUser((string)d.Principal.UserId)
                || (int)d.Principal.LogonType != 3 || (int)d.Principal.RunLevel != 0
                || (int)d.Actions.Count != 1 || (int)d.Actions.Item(1).Type != 0
                || !String.Equals((string)d.Actions.Item(1).Path, Path.Combine(Root, "CodexPulse.exe"), StringComparison.OrdinalIgnoreCase)
                || (string)d.Actions.Item(1).Arguments != ActionArguments(data)
                || !String.Equals((string)d.Actions.Item(1).WorkingDirectory, Root, StringComparison.OrdinalIgnoreCase)
                || (int)d.Triggers.Count != 1 || (int)d.Triggers.Item(1).Type != 9 || !SameUser((string)d.Triggers.Item(1).UserId))
                throw new InvalidDataException("An existing startup task does not belong to this installation.");
        }
        private static void Verify(dynamic task, string data) {
            VerifyOwner(task, data);
            dynamic d = task.Definition;
            dynamic s = d.Settings;
            if (!(bool)d.Triggers.Item(1).Enabled || (int)s.MultipleInstances != 2 || (bool)s.DisallowStartIfOnBatteries || (bool)s.StopIfGoingOnBatteries
                || (bool)s.RunOnlyIfNetworkAvailable || (bool)s.RunOnlyIfIdle || (bool)s.WakeToRun
                || !(bool)s.AllowDemandStart || !(bool)s.StartWhenAvailable || (string)s.ExecutionTimeLimit != "PT0S"
                || (string)s.RestartInterval != "PT1M" || (int)s.RestartCount != 3)
                throw new InvalidDataException("The startup task settings changed; review before modifying it.");
        }
        private static dynamic Definition(dynamic service, string data) {
            dynamic d = service.NewTask(0);
            d.RegistrationInfo.Source = Source;
            d.RegistrationInfo.Author = Sid;
            d.RegistrationInfo.Description = "Codex Pulse current-user background monitor";
            d.Principal.UserId = Sid; d.Principal.LogonType = 3; d.Principal.RunLevel = 0;
            dynamic t = d.Triggers.Create(9); t.UserId = Sid; t.Enabled = true;
            dynamic a = d.Actions.Create(0); a.Path = Path.Combine(Root, "CodexPulse.exe"); a.Arguments = ActionArguments(data); a.WorkingDirectory = Root;
            dynamic s = d.Settings;
            s.MultipleInstances = 2; // IgnoreNew; background also has its independent OS guard.
            s.DisallowStartIfOnBatteries = false; s.StopIfGoingOnBatteries = false;
            s.RunOnlyIfNetworkAvailable = false; s.RunOnlyIfIdle = false; s.WakeToRun = false;
            s.AllowDemandStart = true; s.StartWhenAvailable = true; s.Enabled = true;
            s.ExecutionTimeLimit = "PT0S"; s.RestartInterval = "PT1M"; s.RestartCount = 3;
            return d;
        }
        private static string ContextFile(string data) { return Path.Combine(data, "startup-context.json"); }
        private static void CheckPath(string value, bool executable) {
            if (String.IsNullOrEmpty(value) || value.Length > 3000 || !System.Text.RegularExpressions.Regex.IsMatch(value, @"^[A-Za-z]:[\\/]")
                || value.IndexOf(':', 2) >= 0 || value.IndexOf('\0') >= 0) throw new InvalidDataException();
            if (executable && (!File.Exists(value) || !(value.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
                || value.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase) || value.EndsWith(".bat", StringComparison.OrdinalIgnoreCase)))) throw new InvalidDataException();
        }
        private static Dictionary<string, object> Capture(string data) {
            Environment.SetEnvironmentVariable("CODEX_PULSE_APP_ROOT", Root);
            Dictionary<string, object> paths = Bridge.Run("startup-context").GetAwaiter().GetResult();
            string home = Program.StringValue(paths, "codexHome"), binary = Program.StringValue(paths, "codexBinary");
            CheckPath(home, false); CheckPath(binary, true);
            return new Dictionary<string, object> { { "version", 1 }, { "userSid", Sid }, { "appRoot", Root }, { "dataDir", data }, { "codexHome", home }, { "codexBinary", binary } };
        }
        private static void Publish(string file, string text) {
            string temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try {
                using (FileStream stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                    byte[] bytes = new UTF8Encoding(false).GetBytes(text); stream.Write(bytes, 0, bytes.Length); stream.Flush(true);
                }
                for (int attempt = 0; ; attempt++) {
                    try { if (File.Exists(file)) File.Replace(temporary, file, null); else File.Move(temporary, file); break; }
                    catch (IOException error) { int code = error.HResult & 0xffff; if ((code != 32 && code != 33) || attempt >= 5) throw; Thread.Sleep(20 * (attempt + 1)); }
                }
            } finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
        internal static void LoadContext(string requestedData) {
            Environment.SetEnvironmentVariable("CODEX_PULSE_DATA_DIR", requestedData);
            string data = BackgroundContext.DataDirectory(), file = ContextFile(data);
            if (!File.Exists(file) || (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0 || new FileInfo(file).Length > 16384) throw new InvalidDataException();
            Dictionary<string, object> c = Program.Json.DeserializeObject(File.ReadAllText(file, Encoding.UTF8)) as Dictionary<string, object>;
            if (c == null || c.Count != 6 || !c.ContainsKey("version") || Convert.ToInt32(c["version"]) != 1
                || Program.StringValue(c, "userSid") != Sid || Program.StringValue(c, "appRoot") != Root || Program.StringValue(c, "dataDir") != data) throw new InvalidDataException();
            string home = Program.StringValue(c, "codexHome"), binary = Program.StringValue(c, "codexBinary");
            CheckPath(home, false); CheckPath(binary, true);
            // Persist only these two paths, never a token, password, prompt,
            // caller environment dump or test quota override.
            Environment.SetEnvironmentVariable("CODEX_HOME", home);
            Environment.SetEnvironmentVariable("CODEX_BINARY", binary);
            Environment.SetEnvironmentVariable("CODEX_PULSE_APP_ROOT", Root);
        }
        internal static int Control(string command) {
            // A settings window must not recreate startup/context after an
            // uninstall verified absence but before it removes the runtime.
            // Status is read-only; start is fenced by BackgroundContext.Run
            // itself and must not hold this gate while scheduling that host.
            if (command == "status" || command == "start" || command == "preview-context") return ControlCore(command);
            if (command != "configure" && command != "enable" && command != "disable" && command != "remove") throw new ArgumentException();
            using (FileStream maintenance = InstallationLease.Acquire(BackgroundContext.DataDirectory())) return ControlCore(command);
        }
        private static int ControlCore(string command) {
            if (command == "preview-context") {
                // WinExe has no console code page. Console.Out's default
                // encoding replaces CJK paths with '?'; never use SetConsoleCP.
                using (StreamWriter output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false), 1024, true)) {
                    output.WriteLine(Program.Json.Serialize(new Dictionary<string, object> {
                        { "ok", true }, { "text", Program.Json.Serialize(Capture(BackgroundContext.DataDirectory())) }
                    }));
                    output.Flush();
                }
                return 0;
            }
            if (command == "configure") {
                string contextData = BackgroundContext.DataDirectory();
                Environment.SetEnvironmentVariable("CODEX_PULSE_APP_ROOT", Root);
                Dictionary<string, object> prepared = Bridge.Run("background-prepare").GetAwaiter().GetResult();
                if (!Program.BooleanValue(prepared, "ok", false)) throw new IOException();
                string contextGuard = Path.Combine(contextData, "startup-control.guard");
                try { if ((File.GetAttributes(contextGuard) & FileAttributes.ReparsePoint) != 0) throw new IOException(); }
                catch (FileNotFoundException) { } catch (DirectoryNotFoundException) { }
                using (FileStream guard = File.Open(contextGuard, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None)) {
                    string contextPath = ContextFile(contextData);
                    try { if ((File.GetAttributes(contextPath) & FileAttributes.ReparsePoint) != 0) throw new IOException(); }
                    catch (FileNotFoundException) { } catch (DirectoryNotFoundException) { }
                    Publish(contextPath, Program.Json.Serialize(Capture(contextData)));
                }
                Program.Acknowledge("context_configured"); return 0;
            }
            if (command != "status" && command != "enable" && command != "disable" && command != "start" && command != "remove") throw new ArgumentException();
            string data = BackgroundContext.DataDirectory(), name = TaskName(data);
            dynamic service = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service", true));
            service.Connect(); dynamic folder = service.GetFolder("\\");
            dynamic task = Find(folder, name);
            if (task != null) Verify(task, data); // Never mutate a foreign definition, even if its name matches.
            if (command != "status") {
                if (command == "enable") {
                    Environment.SetEnvironmentVariable("CODEX_PULSE_APP_ROOT", Root);
                    Dictionary<string, object> prepared = Bridge.Run("background-prepare").GetAwaiter().GetResult();
                    if (!Program.BooleanValue(prepared, "ok", false)) throw new IOException();
                } else if (task == null) { Print(name, null); return 0; }
                string guardPath = Path.Combine(data, "startup-control.guard");
                if (File.Exists(guardPath) && (File.GetAttributes(guardPath) & FileAttributes.ReparsePoint) != 0) throw new IOException();
                using (FileStream guard = File.Open(guardPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None)) {
                    task = Find(folder, name); if (task != null) Verify(task, data);
                    if (command == "enable") {
                        string file = ContextFile(data);
                        if (File.Exists(file) && ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0 || new FileInfo(file).Length > 16384)) throw new IOException();
                        string previous = File.Exists(file) ? File.ReadAllText(file, Encoding.UTF8) : null;
                        bool created = task == null, previouslyEnabled = !created && (bool)task.Enabled;
                        Publish(file, Program.Json.Serialize(Capture(data)));
                        try {
                            if (task == null) task = folder.RegisterTaskDefinition(name, Definition(service, data), 2, Sid, null, 3, null);
                            else task.Enabled = true;
                            Verify(task, data);
                        } catch {
                            // Registration/readback can fail after a task was
                            // created. Do not leave enabled startup pointing
                            // at a rolled-back/deleted context. Never repair
                            // a subsequently replaced foreign definition.
                            dynamic current = Find(folder, name);
                            if (current != null) {
                                if (created) { VerifyOwner(current, data); current.Enabled = false; folder.DeleteTask(name, 0); }
                                else { Verify(current, data); current.Enabled = previouslyEnabled; }
                            }
                            if (previous == null) File.Delete(file); else Publish(file, previous);
                            throw;
                        }
                    } else if (task != null) {
                        if (command == "disable") task.Enabled = false; // Stopping is a separate generation-scoped action.
                        else if (command == "start") { LoadContext(data); if (!(bool)task.Enabled) throw new InvalidOperationException(); task.Run(null); }
                        else { if ((bool)task.Enabled) throw new InvalidOperationException("Disable startup before removing it."); folder.DeleteTask(name, 0); task = null; }
                    }
                }
            }
            Print(name, task); return 0;
        }
        private static void Print(string name, dynamic task) {
            Console.Out.WriteLine(Program.Json.Serialize(new Dictionary<string, object> { { "ok", true }, { "installed", task != null },
                { "enabled", task != null && (bool)task.Enabled }, { "taskName", name }, { "interactiveUserOnly", true }, { "runLevel", 0 } }));
        }
    }
}
