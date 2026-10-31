param([Parameter(Mandatory=$true)][int]$TargetProcess, [string]$WindowTitle, [string]$Click, [string]$Screenshot, [int]$SelectTabIndex = -1, [switch]$CloseWindow)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class PulseNativeButton {
    [DllImport("user32.dll", SetLastError=true)]
    public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
    private delegate bool EnumWindow(IntPtr window, IntPtr value);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindow callback, IntPtr value);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint relationship);
    public sealed class Window {
        public long handle, owner;
        public string title;
        public bool visible, enabled;
    }
    public static Window[] OwnWindows(uint process) {
        List<Window> windows = new List<Window>();
        EnumWindows(delegate(IntPtr handle, IntPtr unused) {
            uint pid; GetWindowThreadProcessId(handle, out pid);
            if (pid == process) {
                StringBuilder title = new StringBuilder(1024); GetWindowText(handle, title, title.Capacity);
                windows.Add(new Window { handle=handle.ToInt64(), owner=GetWindow(handle, 4).ToInt64(), title=title.ToString(), visible=IsWindowVisible(handle), enabled=IsWindowEnabled(handle) });
            }
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }
}
'@
# Owned modal windows need not be immediate children of the UIA desktop.
# Enumerate real top-level HWNDs, restrict to the test process BEFORE reading
# titles, and create UIA only for the exact native window we intend to inspect.
$deadline = [DateTime]::UtcNow.AddSeconds(10)
do {
    $ownWindows = @([PulseNativeButton]::OwnWindows([uint32]$TargetProcess))
    $native = $ownWindows | Where-Object { $_.visible -and ((-not $WindowTitle) -or $_.title -ceq $WindowTitle) } | Select-Object -First 1
    if ($null -ne $native) { break }
    Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)
if ($null -eq $native) { throw ('No native application window was found. Own-process HWNDs: ' + (ConvertTo-Json -InputObject @($ownWindows) -Compress)) }
if ($CloseWindow) { [void][PulseNativeButton]::PostMessage([IntPtr]$native.handle, 0x10, [UIntPtr]::Zero, [IntPtr]::Zero) }
$window = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]$native.handle)
if ($window.Current.ProcessId -ne $TargetProcess) { throw 'UIA window belongs to another process.' }
$all = $window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
$buttons = @(); $content = @(); $clicked = $null; $elements = @(); $tab = $null
foreach ($element in $all) {
    $elements += @{name=$element.Current.Name; type=$element.Current.ControlType.ProgrammaticName; class=$element.Current.ClassName}
    # Some .NET Framework UIA bridges classify WinForms BUTTON windows as
    # panes. Keep the real native HWND/class, not a synthetic test control.
    $nativeButton = $element.Current.ClassName -match '^WindowsForms10\.BUTTON\.'
    if ($element.Current.ClassName -match '^WindowsForms10\.SysTabControl32\.') { $tab = $element }
    if ($element.Current.ControlType -eq [Windows.Automation.ControlType]::Button -or $nativeButton) {
        $bounds = $element.Current.BoundingRectangle
        $checked = $null
        if ($nativeButton) {
            [UIntPtr]$checkState = [UIntPtr]::Zero
            [void][PulseNativeButton]::SendMessageTimeout([IntPtr]$element.Current.NativeWindowHandle, 0xF0, [UIntPtr]::Zero, [IntPtr]::Zero, 2, 1000, [ref]$checkState)
            $checked = $checkState.ToUInt64() -eq 1
        }
        $buttons += @{name=$element.Current.Name; enabled=$element.Current.IsEnabled; offscreen=$element.Current.IsOffscreen; x=$bounds.X; y=$bounds.Y; width=$bounds.Width; height=$bounds.Height; nativeWinForms=$nativeButton; checked=$checked}
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
if ($SelectTabIndex -ge 0) {
    if ($null -eq $tab -or $SelectTabIndex -gt 1) { throw 'The requested native tab was not found.' }
    $handle = [IntPtr]$tab.Current.NativeWindowHandle
    [uint32]$ownerProcess = 0
    [void][PulseNativeButton]::GetWindowThreadProcessId($handle, [ref]$ownerProcess)
    if ($ownerProcess -ne $TargetProcess) { throw 'The tab belongs to another process.' }
    # TCM_SETCURFOCUS selects a normal tab and sends the real parent selection
    # notifications. All arguments are scalar: never send an address from this
    # PowerShell process into another process via TCM_GETITEMRECT.
    if (-not [PulseNativeButton]::PostMessage($handle, 0x1330, [UIntPtr][uint32]$SelectTabIndex, [IntPtr]::Zero)) { throw 'The tab selection request failed.' }
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
@{title=$window.Current.Name; handle=$native.handle; owner=$native.owner; nativeWindows=@($ownWindows); visible=($native.visible -and (-not $window.Current.IsOffscreen)); buttons=@($buttons); content=@($content); elements=@($elements)} | ConvertTo-Json -Depth 5 -Compress
if ($Click) {
    if ($null -eq $clicked) { throw 'The requested UI action was not found.' }
    if ($clicked.Current.ClassName -match '^WindowsForms10\.BUTTON\.') {
        # BM_CLICK follows the actual native button's event path. Validate
        # its process and class before sending any window message.
        if ($clicked.Current.ClassName -notmatch '^WindowsForms10\.BUTTON\.') { throw 'The control is not a native button.' }
        $handle = [IntPtr]$clicked.Current.NativeWindowHandle
        [uint32]$ownerProcess = 0
        [void][PulseNativeButton]::GetWindowThreadProcessId($handle, [ref]$ownerProcess)
        if ($ownerProcess -ne $TargetProcess -or -not $clicked.Current.IsEnabled -or $clicked.Current.IsOffscreen) { throw 'The native button is not safely actionable.' }
        # Queue the native click rather than blocking until its handler returns:
        # a legitimate ShowDialog handler returns only after the modal closes.
        # Callers still have to observe the expected UI and persisted state.
        if (-not [PulseNativeButton]::PostMessage($handle, 0xF5, [UIntPtr]::Zero, [IntPtr]::Zero)) { throw 'The native button could not be clicked.' }
    } else {
        $invoke = $clicked.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
        $invoke.Invoke()
    }
}
