param([Parameter(Mandatory=$true)][int]$TargetProcess, [string]$Click, [string]$Screenshot)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PulseNativeButton {
    [DllImport("user32.dll", SetLastError=true)]
    public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
}
'@
$condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ProcessIdProperty, $TargetProcess)
$deadline = [DateTime]::UtcNow.AddSeconds(10)
do {
    $window = [Windows.Automation.AutomationElement]::RootElement.FindFirst([Windows.Automation.TreeScope]::Children, $condition)
    if ($null -ne $window) { break }
    Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)
if ($null -eq $window) { throw 'No native application window was found.' }
$all = $window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
$buttons = @(); $content = @(); $clicked = $null; $elements = @()
foreach ($element in $all) {
    $elements += @{name=$element.Current.Name; type=$element.Current.ControlType.ProgrammaticName; class=$element.Current.ClassName}
    # Some .NET Framework UIA bridges classify WinForms BUTTON windows as
    # panes. Keep the real native HWND/class, not a synthetic test control.
    $nativeButton = $element.Current.ClassName -match '^WindowsForms10\.BUTTON\.'
    if ($element.Current.ControlType -eq [Windows.Automation.ControlType]::Button -or $nativeButton) {
        $bounds = $element.Current.BoundingRectangle
        $buttons += @{name=$element.Current.Name; enabled=$element.Current.IsEnabled; offscreen=$element.Current.IsOffscreen; x=$bounds.X; y=$bounds.Y; width=$bounds.Width; height=$bounds.Height; nativeWinForms=$nativeButton}
        if ($Click -and $element.Current.Name -eq $Click) {
            $clicked = $element
        }
    }
    $pattern = $null
    if ($element.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
        $content += $pattern.DocumentRange.GetText(-1)
    } elseif ($element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
        $content += $pattern.Current.Value
    }
}
if ($Screenshot) {
    $bounds = $window.Current.BoundingRectangle
    $bitmap = New-Object Drawing.Bitmap([int]$bounds.Width, [int]$bounds.Height)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen([int]$bounds.X, [int]$bounds.Y, 0, 0, $bitmap.Size)
        $bitmap.Save($Screenshot, [Drawing.Imaging.ImageFormat]::Png)
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
}
@{title=$window.Current.Name; visible=(-not $window.Current.IsOffscreen); buttons=@($buttons); content=@($content); elements=@($elements)} | ConvertTo-Json -Depth 5 -Compress
if ($Click) {
    if ($null -eq $clicked) { throw 'The requested UI action was not found.' }
    $invoke = $null
    if ($clicked.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
        $invoke.Invoke()
    } else {
        # BM_CLICK follows the actual native button's event path. Validate
        # its process and class before sending any window message.
        if ($clicked.Current.ClassName -notmatch '^WindowsForms10\.BUTTON\.') { throw 'The control is not a native button.' }
        $handle = [IntPtr]$clicked.Current.NativeWindowHandle
        [uint32]$ownerProcess = 0
        [void][PulseNativeButton]::GetWindowThreadProcessId($handle, [ref]$ownerProcess)
        if ($ownerProcess -ne $TargetProcess -or -not $clicked.Current.IsEnabled -or $clicked.Current.IsOffscreen) { throw 'The native button is not safely actionable.' }
        [UIntPtr]$result = [UIntPtr]::Zero
        $sent = [PulseNativeButton]::SendMessageTimeout($handle, 0xF5, [UIntPtr]::Zero, [IntPtr]::Zero, 2, 2000, [ref]$result)
        if ($sent -eq [IntPtr]::Zero -and (Get-Process -Id $TargetProcess -ErrorAction SilentlyContinue)) { throw 'The native button did not respond.' }
    }
}
