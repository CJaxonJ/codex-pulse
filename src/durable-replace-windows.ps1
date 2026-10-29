$ErrorActionPreference = 'Stop'
try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PulseDurableMove {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool MoveFileExW(string source, string destination, uint flags);
}
'@
    $source = [IO.Path]::GetFullPath($env:CODEX_PULSE_MOVE_SOURCE)
    $destination = [IO.Path]::GetFullPath($env:CODEX_PULSE_MOVE_DESTINATION)
    if ([IO.Path]::GetDirectoryName($source) -ne [IO.Path]::GetDirectoryName($destination)) {
        throw 'Replacement must stay in the same directory'
    }
    # REPLACE_EXISTING | WRITE_THROUGH; no copy/delete fallback or delayed move.
    if (-not [PulseDurableMove]::MoveFileExW($source, $destination, 9)) {
        throw (New-Object ComponentModel.Win32Exception([Runtime.InteropServices.Marshal]::GetLastWin32Error()))
    }
    exit 0
} catch {
    [Console]::Error.WriteLine('Durable operation record could not be published: ' + $_.Exception.Message)
    exit 1
}
