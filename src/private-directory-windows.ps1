param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$phase = 'boundary'
try {
if ($Directory -notmatch '^[A-Za-z]:[\\/]') { throw 'A local absolute data directory is required.' }
$fullTarget = [IO.Path]::GetFullPath($Directory)
$target = $fullTarget.TrimEnd('\')
if ($target -ieq [IO.Path]::GetPathRoot($fullTarget).TrimEnd('\') -or $target.IndexOf(':', 2) -ge 0) { throw 'Refusing a drive root or alternate data stream.' }
# Never apply a recursive product ACL to a profile, drive, system, temp or
# application-data root, even if an environment override points there.
$reserved = @([IO.Path]::GetPathRoot($target), [IO.Path]::GetTempPath(),
    [Environment]::GetFolderPath('UserProfile'), [Environment]::GetFolderPath('LocalApplicationData'),
    [Environment]::GetFolderPath('ApplicationData'), [Environment]::GetFolderPath('CommonApplicationData'),
    [Environment]::GetFolderPath('Windows'), [Environment]::GetFolderPath('System'),
    [Environment]::GetFolderPath('ProgramFiles'), [Environment]::GetFolderPath('ProgramFilesX86'))
foreach ($reservedPath in $reserved) {
    if (-not $reservedPath) { continue }
    $reservedPath = [IO.Path]::GetFullPath($reservedPath).TrimEnd('\')
    if ($reservedPath -ieq $target -or $reservedPath.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing a broad data directory.' }
}
# A packaged app lives in data/app/src, unlike a source-checkout test. Permit
# exactly that owned runtime child, not the checkout or arbitrary ancestors.
$applicationRoot = Split-Path -Parent $PSScriptRoot
$containsApplication = $applicationRoot -ieq $target -or $applicationRoot.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)
if ($containsApplication -and $applicationRoot -ine [IO.Path]::Combine($target, 'app')) { throw 'Refusing a checkout or application root.' }
function Assert-NotLink([string]$path) {
    # Test-Path and Get-Item can report a dangling junction as missing. Native
    # file attributes inspect the link entry even when its destination is gone.
    try { $attributes = [IO.File]::GetAttributes($path) }
    catch [IO.FileNotFoundException] { return }
    catch [IO.DirectoryNotFoundException] { return }
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing a linked data directory or entry.' }
}
function Test-Vanished([string]$path) {
    try { $null = [IO.File]::GetAttributes($path); return $false }
    catch [IO.FileNotFoundException] { return $true }
    catch [IO.DirectoryNotFoundException] { return $true }
    # An access denial is NOT evidence that a file disappeared.
}
$cursor = $target
while ($cursor) { Assert-NotLink $cursor; $cursor = Split-Path -Parent $cursor }
# Inspect the full existing tree before any ACL mutation; do not use -Recurse,
# whose junction traversal behavior differs between PowerShell versions.
$entries = New-Object 'Collections.Generic.List[IO.FileSystemInfo]'
$phase = 'scan'
$pending = New-Object 'Collections.Generic.Queue[string]'
if (Test-Path -LiteralPath $target) { $pending.Enqueue($target) }
while ($pending.Count -gt 0) {
    $path = $pending.Dequeue()
    try {
        Assert-NotLink $path
        if (([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::Directory) -eq 0) { throw 'Data location must be a directory.' }
        $directoryInfo = New-Object IO.DirectoryInfo($path)
        $entries.Add($directoryInfo)
        foreach ($child in $directoryInfo.GetFileSystemInfos()) {
            Assert-NotLink $child.FullName
            if ($child -is [IO.DirectoryInfo]) { $pending.Enqueue($child.FullName) } else { $entries.Add($child) }
            if ($entries.Count + $pending.Count -gt 20000) { throw 'Data tree is too large for a bounded ACL update.' }
        }
    } catch {
        if ($path -ine $target -and (Test-Vanished $path)) { continue }
        throw
    }
}
if ($entries.Count -eq 0) { $entries.Add([IO.Directory]::CreateDirectory($target)) }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$phase = 'acl'
$secured = 0
$vanished = 0
foreach ($item in $entries) {
    try {
    Assert-NotLink $item.FullName
    $isDirectory = $item -is [IO.DirectoryInfo]
    $security = if ($isDirectory) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }
    $security.SetAccessRuleProtection($true, $false)
    # Set only the DACL, not the owner/SACL; no administrator token is needed.
    $inheritance = if ($isDirectory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
    foreach ($identity in @($sid, $system)) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
        $security.AddAccessRule($rule)
    }
    # Do not autoload Microsoft.PowerShell.Security. A PowerShell 7 parent can
    # leave a PSModulePath whose Security module Windows PowerShell cannot load.
    # These are the .NET Framework file-system APIs, with DACL-only changes.
    $item.SetAccessControl($security)
    $readback = $item.GetAccessControl()
    if (-not $readback.AreAccessRulesProtected) { throw 'ACL protection was not persisted.' }
    $rules = @($readback.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 2) { throw 'Unexpected access rules remain.' }
    foreach ($identity in @($sid, $system)) {
        $valid = @($rules | Where-Object { $_.IdentityReference -eq $identity -and $_.AccessControlType -eq 'Allow' -and $_.FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl })
        if ($valid.Count -ne 1) { throw 'Private access rules were not persisted.' }
    }
    $secured++
    } catch {
        # Live watcher snapshots/lock directories can be removed after the
        # scan. Skip only confirmed missing descendants, never the root,
        # existing files, reparse points, permission denials or failed readback.
        if ($item.FullName -ine $target -and (Test-Vanished $item.FullName)) { $vanished++; continue }
        throw
    }
}
@{ok=$true; applicable=$true; entries=$secured; vanished=$vanished} | ConvertTo-Json -Compress
} catch {
    $failure = $_.Exception.GetBaseException()
    [Console]::Error.WriteLine('PULSE_ACL_FAILURE:' + $phase + ':' + $failure.GetType().Name + ':' + $failure.HResult.ToString('X8'))
    throw
}
