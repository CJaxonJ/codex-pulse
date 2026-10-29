param([Parameter(Mandatory=$true)][int]$TargetProcess, [string]$Click, [string]$Screenshot)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName UIAutomationClientsideProviders
# PowerShell is an automation host, not a dedicated UIA client. Register the
# framework's genuine Win32/WinForms proxies; never replace controls in tests.
$providers = [AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { $_.GetName().Name -eq 'UIAutomationClientsideProviders' } | Select-Object -First 1
[Windows.Automation.ClientSettings]::RegisterClientSideProviderAssembly($providers.GetName())
Add-Type -AssemblyName System.Drawing
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
    if ($element.Current.ControlType -eq [Windows.Automation.ControlType]::Button) {
        $bounds = $element.Current.BoundingRectangle
        $buttons += @{name=$element.Current.Name; enabled=$element.Current.IsEnabled; offscreen=$element.Current.IsOffscreen; x=$bounds.X; y=$bounds.Y; width=$bounds.Width; height=$bounds.Height}
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
    $invoke = $clicked.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
    $invoke.Invoke()
}
