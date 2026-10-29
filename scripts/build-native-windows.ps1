param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This build requires native Windows.' }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $root 'build\windows' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$compiler = Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'The Windows .NET Framework compiler is unavailable.' }
# The existing branded PNG is encoded inside an ICO, not redrawn or replaced.
Add-Type -AssemblyName System.Drawing
$image = [Drawing.Image]::FromFile((Join-Path $root 'brand\codex-pulse-app-icon.png'))
$bitmap = New-Object Drawing.Bitmap($image, 256, 256)
$memory = New-Object IO.MemoryStream
try { $bitmap.Save($memory, [Drawing.Imaging.ImageFormat]::Png); $png = $memory.ToArray() }
finally { $memory.Dispose(); $bitmap.Dispose(); $image.Dispose() }
$iconPath = Join-Path $OutputDirectory 'CodexPulse.ico'
$stream = [IO.File]::Create($iconPath)
try {
    $writer = New-Object IO.BinaryWriter($stream)
    $writer.Write([UInt16]0); $writer.Write([UInt16]1); $writer.Write([UInt16]1)
    $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
    $writer.Write([UInt16]1); $writer.Write([UInt16]32)
    $writer.Write([UInt32]$png.Length); $writer.Write([UInt32]22); $writer.Write($png)
    $writer.Flush()
} finally { $stream.Dispose() }
$exe = Join-Path $OutputDirectory 'CodexPulse.exe'
$sources = @(Get-ChildItem -LiteralPath (Join-Path $root 'native\windows') -Filter '*.cs' | Sort-Object Name | ForEach-Object { $_.FullName })
& $compiler /nologo /target:winexe /platform:anycpu /utf8output /codepage:65001 ("/out:" + $exe) ("/win32icon:" + $iconPath) /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:System.Core.dll @sources
if ($LASTEXITCODE -ne 0) { throw 'Codex Pulse native Windows compilation failed.' }
[IO.File]::Copy((Join-Path $root 'native\windows\CodexPulse.exe.config'), ($exe + '.config'), $true)
Write-Output $exe
