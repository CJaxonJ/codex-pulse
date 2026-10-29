using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;

namespace CodexPulse {
    internal static class ProcessIdentity {
        [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
        internal static int Read(string value) {
            int pid; if (!Int32.TryParse(value, out pid) || pid <= 0) throw new ArgumentException();
            IntPtr handle = OpenProcess(0x1000, false, pid); // QUERY_LIMITED_INFORMATION only; never terminate access.
            if (handle == IntPtr.Zero) {
                int error = Marshal.GetLastWin32Error();
                if (error == 87 || error == 1168) { Console.Out.WriteLine("{\"exists\":false}"); return 0; }
                throw new Win32Exception(error);
            }
            try {
                uint code; if (!GetExitCodeProcess(handle, out code)) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (code != 259) { Console.Out.WriteLine("{\"exists\":false}"); return 0; }
                long creation, exit, kernel, user;
                if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) throw new Win32Exception(Marshal.GetLastWin32Error());
                Console.Out.WriteLine("{\"exists\":true,\"creationTimeFileTime\":\"" + creation.ToString(CultureInfo.InvariantCulture) + "\"}");
                return 0;
            } finally { CloseHandle(handle); }
        }
    }
}
