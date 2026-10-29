using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace CodexPulse {
    internal static class InstallationLease {
        internal static FileStream Acquire(string data) {
            Directory.CreateDirectory(data);
            string file = Path.Combine(data, "maintenance.guard");
            if (File.Exists(file) && (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new IOException();
            return File.Open(file, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        }
        private static string RuntimePath(string data, string name) {
            if (name != "app" && !Regex.IsMatch(name, @"^app-(?:install|backup|failed)-[a-f0-9]{32}$")) throw new InvalidDataException();
            string file = Path.Combine(data, name);
            try { if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new IOException(); }
            catch (FileNotFoundException) { } catch (DirectoryNotFoundException) { }
            return file;
        }
        internal static int Run(bool installation) {
            string data = BackgroundContext.DataDirectory();
            if (installation) {
                string own = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).TrimEnd('\\');
                // A helper running out of the installed runtime cannot be
                // trusted to rename/delete its own mapped executable.
                if (own.Equals(Path.Combine(data, "app"), StringComparison.OrdinalIgnoreCase)
                    || own.StartsWith(Path.Combine(data, "app") + "\\", StringComparison.OrdinalIgnoreCase)) throw new IOException();
            }
            using (FileStream lease = Acquire(data)) {
                if (installation) BackgroundContext.AssertQuiescent(data);
                Program.Acknowledge("maintenance_acquired");
                using (StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true))) {
                    int lastId = 0;
                    while (true) {
                        string line = ReadLine(input);
                        if (line == null || line == "release") return 0;
                        if (!installation || line.Length > 8192) throw new InvalidDataException();
                        Dictionary<string, object> request = Program.Json.DeserializeObject(line) as Dictionary<string, object>;
                        object raw;
                        if (request == null || !request.TryGetValue("id", out raw) || !(raw is int) || (int)raw <= lastId || request.Count != 4) throw new InvalidDataException();
                        int id = (int)raw; lastId = id;
                        try {
                            if (Program.StringValue(request, "op") != "move") throw new InvalidDataException();
                            string source = RuntimePath(data, Program.StringValue(request, "from"));
                            string target = RuntimePath(data, Program.StringValue(request, "to"));
                            BackgroundContext.AssertQuiescent(data);
                            // Mutate while THIS process holds the kernel lease.
                            // Never ask the Node owner to rename after an ack:
                            // it could continue after a killed lease helper.
                            Directory.Move(source, target);
                            Console.Out.WriteLine("{\"id\":" + id + ",\"ok\":true}");
                        } catch (Exception error) {
                            Console.Out.WriteLine(Program.Json.Serialize(new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", error.GetType().Name } }));
                        }
                        Console.Out.Flush();
                    }
                }
            }
        }
        private static string ReadLine(StreamReader input) {
            StringBuilder text = new StringBuilder();
            while (true) {
                int c = input.Read();
                if (c == -1) { if (text.Length != 0) throw new InvalidDataException(); return null; }
                if (c == '\n') return text.ToString().TrimEnd('\r');
                if (text.Length >= 8192) throw new InvalidDataException();
                text.Append((char)c);
            }
        }
    }
}
