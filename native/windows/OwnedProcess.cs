using System;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace CodexPulse {
    // Only one requested App Server/helper process tree belongs to this Job.
    // Watchers, notifications and the user's existing Desktop/CLI are outside it.
    internal sealed class OwnedProcess : IDisposable {
        [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { public int Size; public IntPtr Descriptor; public int Inherit; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct StartupInfo {
            public int Size; public string Reserved, Desktop, Title;
            public uint X, Y, XSize, YSize, XCount, YCount, Fill, Flags;
            public short Show, ReservedSize; public IntPtr ReservedData, Input, Output, Error;
        }
        [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo { public IntPtr Process, Thread; public uint Id, ThreadId; }
        [StructLayout(LayoutKind.Sequential)] private struct BasicLimits {
            public long ProcessTime, JobTime; public uint Flags; public UIntPtr Minimum, Maximum;
            public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority, Scheduling;
        }
        [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
        [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits {
            public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
        }
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attributes, uint size);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo process);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint code);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
        private readonly object gate = new object();
        private IntPtr job, process;
        internal FileStream Input, Output, Error;
        private static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
        private static void Close(ref IntPtr handle) { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
        private static FileStream Stream(ref IntPtr handle, FileAccess access) {
            SafeFileHandle safe = new SafeFileHandle(handle, true); handle = IntPtr.Zero;
            try { return new FileStream(safe, access, 4096, false); } catch { safe.Dispose(); throw; }
        }
        internal static OwnedProcess Start(string file, string[] args, string directory = null) {
            if (!Path.IsPathRooted(file) || !File.Exists(file)) throw new FileNotFoundException();
            OwnedProcess child = new OwnedProcess();
            IntPtr inputRead = IntPtr.Zero, inputWrite = IntPtr.Zero, outputRead = IntPtr.Zero, outputWrite = IntPtr.Zero, errorRead = IntPtr.Zero, errorWrite = IntPtr.Zero;
            ProcessInfo info = new ProcessInfo();
            try {
                child.job = CreateJobObject(IntPtr.Zero, null); Check(child.job != IntPtr.Zero);
                ExtendedLimits limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE; never allow breakaway.
                Check(SetInformationJobObject(child.job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
                SecurityAttributes attributes = new SecurityAttributes { Size = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = 1 };
                Check(CreatePipe(out inputRead, out inputWrite, ref attributes, 0));
                Check(CreatePipe(out outputRead, out outputWrite, ref attributes, 0));
                Check(CreatePipe(out errorRead, out errorWrite, ref attributes, 0));
                Check(SetHandleInformation(inputWrite, 1, 0)); Check(SetHandleInformation(outputRead, 1, 0)); Check(SetHandleInformation(errorRead, 1, 0));
                StartupInfo startup = new StartupInfo { Size = Marshal.SizeOf(typeof(StartupInfo)), Flags = 0x100, Input = inputRead, Output = outputWrite, Error = errorWrite };
                StringBuilder command = new StringBuilder(String.Join(" ", new[] { file }.Concat(args).Select(Bridge.Quote).ToArray()));
                // Suspended creation is essential: no child can escape before
                // assignment, even on a fast machine or with an adversarial peer.
                Check(CreateProcess(file, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, directory ?? Environment.CurrentDirectory, ref startup, out info));
                child.process = info.Process; info.Process = IntPtr.Zero;
                Check(AssignProcessToJobObject(child.job, child.process));
                child.Input = Stream(ref inputWrite, FileAccess.Write); child.Output = Stream(ref outputRead, FileAccess.Read); child.Error = Stream(ref errorRead, FileAccess.Read);
                Check(ResumeThread(info.Thread) != UInt32.MaxValue);
                return child;
            } catch {
                // Also handle assignment failure while the new process is still
                // suspended and not in our Job. Terminate by its exact handle.
                if (child.process != IntPtr.Zero) TerminateProcess(child.process, 1);
                child.Dispose(); throw;
            } finally {
                Close(ref info.Thread); Close(ref info.Process);
                Close(ref inputRead); Close(ref inputWrite); Close(ref outputRead); Close(ref outputWrite); Close(ref errorRead); Close(ref errorWrite);
            }
        }
        internal void Stop() { lock (gate) { if (job != IntPtr.Zero) Check(TerminateJobObject(job, 1)); } }
        private void CloseJob() { lock (gate) { Close(ref job); } }
        internal int Wait() {
            Check(WaitForSingleObject(process, UInt32.MaxValue) == 0);
            uint code; Check(GetExitCodeProcess(process, out code));
            CloseJob(); // Kill remaining descendants before waiting for pipe EOF.
            return unchecked((int)code);
        }
        internal bool WaitForExit(int milliseconds) {
            uint result = WaitForSingleObject(process, (uint)milliseconds);
            if (result == 258) return false;
            Check(result == 0); return true;
        }
        public void Dispose() {
            CloseJob();
            if (Input != null) Input.Dispose(); if (Output != null) Output.Dispose(); if (Error != null) Error.Dispose();
            Close(ref process);
        }
        private static async Task Relay(System.IO.Stream source, System.IO.Stream destination) {
            byte[] bytes = new byte[8192]; int count;
            while ((count = await source.ReadAsync(bytes, 0, bytes.Length)) != 0) {
                await destination.WriteAsync(bytes, 0, count); await destination.FlushAsync();
            }
        }
        internal static int BridgeServer(string file, string[] args) {
            using (OwnedProcess child = Start(file, args)) {
                Task output = Relay(child.Output, Console.OpenStandardOutput());
                Task error = Relay(child.Error, Console.OpenStandardError());
                // Watcher death closes stdin even when the bridge is otherwise
                // healthy. An uncooperative server must not survive that EOF.
                Task.Run(async delegate { try { await Relay(Console.OpenStandardInput(), child.Input); } finally { try { child.Stop(); } catch { } } });
                int code = child.Wait();
                if (!Task.WaitAll(new[] { output, error }, 5000)) throw new IOException("Owned process pipes did not close.");
                return code;
            }
        }
    }
}
