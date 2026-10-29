param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
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
    [Environment]::GetFolderPath('ProgramFiles'), [Environment]::GetFolderPath('ProgramFilesX86'),
    (Split-Path -Parent $PSScriptRoot))
foreach ($reservedPath in $reserved) {
    if (-not $reservedPath) { continue }
    $reservedPath = [IO.Path]::GetFullPath($reservedPath).TrimEnd('\')
    if ($reservedPath -ieq $target -or $reservedPath.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing a broad data directory.' }
}
function Assert-NotLink([string]$path) {
    # Test-Path can be false for a dangling junction. Inspect the entry itself.
    try { $item = Get-Item -LiteralPath $path -Force }
    catch [Management.Automation.ItemNotFoundException] { return }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing a linked data directory or entry.' }
}
$cursor = $target
while ($cursor) { Assert-NotLink $cursor; $cursor = Split-Path -Parent $cursor }
# Inspect the full existing tree before any ACL mutation; do not use -Recurse,
# whose junction traversal behavior differs between PowerShell versions.
$entries = New-Object 'Collections.Generic.List[IO.FileSystemInfo]'
$pending = New-Object 'Collections.Generic.Queue[string]'
if (Test-Path -LiteralPath $target) { $pending.Enqueue($target) }
while ($pending.Count -gt 0) {
    $path = $pending.Dequeue(); Assert-NotLink $path
    $directoryInfo = Get-Item -LiteralPath $path -Force
    if (-not $directoryInfo.PSIsContainer) { throw 'Data location must be a directory.' }
    $entries.Add($directoryInfo)
    foreach ($child in (Get-ChildItem -LiteralPath $path -Force)) {
        Assert-NotLink $child.FullName
        if ($child.PSIsContainer) { $pending.Enqueue($child.FullName) } else { $entries.Add($child) }
        if ($entries.Count + $pending.Count -gt 20000) { throw 'Data tree is too large for a bounded ACL update.' }
    }
}
if ($entries.Count -eq 0) { $entries.Add([IO.Directory]::CreateDirectory($target)) }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
foreach ($item in $entries) {
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
    Set-Acl -LiteralPath $item.FullName -AclObject $security
    $readback = Get-Acl -LiteralPath $item.FullName
    if (-not $readback.AreAccessRulesProtected) { throw 'ACL protection was not persisted.' }
    $rules = @($readback.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 2) { throw 'Unexpected access rules remain.' }
    foreach ($identity in @($sid, $system)) {
        $valid = @($rules | Where-Object { $_.IdentityReference -eq $identity -and $_.AccessControlType -eq 'Allow' -and $_.FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl })
        if ($valid.Count -ne 1) { throw 'Private access rules were not persisted.' }
    }
}
@{ok=$true; applicable=$true; entries=$entries.Count} | ConvertTo-Json -Compress
