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
            try { if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new IOException(); }
            catch (FileNotFoundException) { } catch (DirectoryNotFoundException) { }
            return File.Open(file, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        }
        private static string RuntimePath(string data, string name) {
            if (name != "app" && !Regex.IsMatch(name, @"^app-(?:install|backup|failed)-[a-f0-9]{32}$")) throw new InvalidDataException();
            string file = Path.Combine(data, name);
            try { if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new IOException(); }
            catch (FileNotFoundException) { } catch (DirectoryNotFoundException) { }
            return file;
        }
        private static void InspectTree(string root) {
            Queue<string> pending = new Queue<string>(); pending.Enqueue(root); int count = 0;
            while (pending.Count > 0) {
                string entry = pending.Dequeue();
                FileAttributes attributes = File.GetAttributes(entry);
                if ((attributes & FileAttributes.ReparsePoint) != 0 || ++count > 5000) throw new InvalidDataException();
                if ((attributes & FileAttributes.Directory) != 0) foreach (string child in Directory.GetFileSystemEntries(entry)) pending.Enqueue(child);
            }
        }
        internal static int Run(bool installation) {
            string data = BackgroundContext.DataDirectory();
            if (installation) {
                string own = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).TrimEnd('\\');
                // A helper running out of the installed runtime cannot be
                // trusted to rename/delete its own mapped executable.
                if (own.StartsWith(data + "\\", StringComparison.OrdinalIgnoreCase)) {
                    string child = own.Substring(data.Length + 1).Split('\\')[0];
                    if (child.Equals("app", StringComparison.OrdinalIgnoreCase) || Regex.IsMatch(child, @"^app-(?:install|backup|failed)-[a-f0-9]{32}$", RegexOptions.IgnoreCase)) throw new IOException();
                }
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
                        if (request == null || !request.TryGetValue("id", out raw) || !(raw is int) || (int)raw <= lastId) throw new InvalidDataException();
                        int id = (int)raw; lastId = id;
                        try {
                            BackgroundContext.AssertQuiescent(data);
                            // Mutate while THIS process holds the kernel lease.
                            // Never ask the Node owner to rename after an ack:
                            // it could continue after a killed lease helper.
                            string operation = Program.StringValue(request, "op");
                            if (operation == "move" && request.Count == 4) {
                                string source = RuntimePath(data, Program.StringValue(request, "from"));
                                string target = RuntimePath(data, Program.StringValue(request, "to"));
                                Directory.Move(source, target);
                            } else if (operation == "remove-retired" && request.Count == 3) {
                                string name = Program.StringValue(request, "name");
                                if (!Regex.IsMatch(name, @"^app-failed-[a-f0-9]{32}$")) throw new InvalidDataException();
                                string retired = RuntimePath(data, name); InspectTree(retired);
                                // Only a pre-verified retired runtime. No root,
                                // active app, checkpoint or arbitrary path.
                                Directory.Delete(retired, true);
                            } else throw new InvalidDataException();
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
