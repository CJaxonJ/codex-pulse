$ErrorActionPreference = 'Stop'
# A plugin hook must not depend on the interactive terminal's PATH. Prefer
# the installation's own Node runtime; source installs can use system node.exe.
try {
    $dataDir = $env:CODEX_PULSE_DATA_DIR
    if (-not $dataDir) {
        $local = $env:LOCALAPPDATA
        if (-not $local) { $local = [Environment]::GetFolderPath('LocalApplicationData') }
        $dataDir = [IO.Path]::Combine($local, 'Codex Pulse')
    }
    $node = [IO.Path]::Combine($dataDir, 'app', 'runtime', 'node.exe')
    if (-not [IO.File]::Exists($node)) {
        $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    }
    $script = [IO.Path]::Combine($PSScriptRoot, 'pulse-hook.mjs')
    $utf8 = New-Object Text.UTF8Encoding($false)
    [Console]::InputEncoding = $utf8
    [Console]::OutputEncoding = $utf8
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $node
    $start.Arguments = '"' + $script + '"'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = $utf8
    $start.StandardErrorEncoding = $utf8
    $child = New-Object Diagnostics.Process
    $child.StartInfo = $start
    [void]$child.Start()
    $output = $child.StandardOutput.ReadToEndAsync()
    $errors = $child.StandardError.ReadToEndAsync()
    $child.StandardInput.Write([Console]::In.ReadToEnd())
    $child.StandardInput.Close()
    $child.WaitForExit()
    [Console]::Out.Write($output.GetAwaiter().GetResult())
    [Console]::Error.Write($errors.GetAwaiter().GetResult())
    exit $child.ExitCode
} catch {
    [Console]::Error.WriteLine('Codex Pulse Windows hook could not run: ' + $_.Exception.Message)
    exit 1
}
