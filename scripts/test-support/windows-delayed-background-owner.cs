using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8", FrameworkDisplayName = ".NET Framework 4.8")]

// Isolated kernel-event/file-lock peer. It deliberately keeps its process and
// working-directory handle alive after releasing the background ownership lock.
internal static class DelayedBackgroundOwner {
    private static int Main(string[] args) {
        // Match the shipped DataDirectory normalization before deriving the
        // event name. CI's temporary root may use an 8.3 short path spelling.
        string data = Path.GetFullPath(args[0]).TrimEnd('\\'), control = args[1], generation = Guid.NewGuid().ToString("N"), name;
        using (SHA256 hash = SHA256.Create()) name = "Global\\CodexPulse-" + WindowsIdentity.GetCurrent().User.Value + "-"
            + BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(data.TrimEnd('\\').ToUpperInvariant()))).Replace("-", "") + "-" + generation;
        using (EventWaitHandle stop = new EventWaitHandle(false, EventResetMode.ManualReset, name)) {
            FileStream guard = File.Open(Path.Combine(data, "background.guard"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            try {
                using (Process self = Process.GetCurrentProcess()) File.WriteAllText(Path.Combine(data, "background-status.json"), new JavaScriptSerializer().Serialize(new {
                    generation = generation, supervisorPid = self.Id,
                    supervisorCreationTime = self.StartTime.ToFileTimeUtc().ToString(System.Globalization.CultureInfo.InvariantCulture), state = "running"
                }), new UTF8Encoding(false));
                File.WriteAllText(control + ".ready", "ready");
                Stopwatch limit = Stopwatch.StartNew();
                while (!stop.WaitOne(50) && !File.Exists(control + ".release-guard")) {
                    if (limit.Elapsed.TotalSeconds > 60) return 2;
                }
                guard.Dispose(); guard = null;
                File.WriteAllText(control + ".guard-released", "process is still alive");
                while (!File.Exists(control + ".exit")) {
                    if (limit.Elapsed.TotalSeconds > 60) return 3;
                    Thread.Sleep(50);
                }
            } finally { if (guard != null) guard.Dispose(); }
        }
        return 0;
    }
}
