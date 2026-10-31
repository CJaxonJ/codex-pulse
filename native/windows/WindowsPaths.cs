using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace CodexPulse {
    internal static class WindowsPaths {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetLongPathName(string path, StringBuilder result, uint length);
        internal static string CanonicalDirectory(string value) {
            value = Path.GetFullPath(value).TrimEnd('\\');
            if (!Directory.Exists(value)) return value;
            StringBuilder expanded = new StringBuilder(32768);
            uint count = GetLongPathName(value, expanded, (uint)expanded.Capacity);
            if (count == 0 || count >= expanded.Capacity) throw new IOException();
            return expanded.ToString().TrimEnd('\\');
        }
        internal static string InstalledApp { get { return Path.Combine(CanonicalDirectory(BackgroundContext.DataDirectory()), "app"); } }
    }
}
