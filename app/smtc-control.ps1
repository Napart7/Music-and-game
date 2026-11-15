# One-shot SMTC playback control. Called by the Electron main process on demand.
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('play', 'pause', 'next', 'prev', 'toggle')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

$asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
        $_.Name -eq 'AsTask' -and
        $_.IsGenericMethodDefinition -and
        $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1

function Wait-WinRt($op, [Type]$resultType) {
    $m = $asTaskGeneric.MakeGenericMethod($resultType)
    $t = $m.Invoke($null, @($op))
    $t.Wait(-1) | Out-Null
    return $t.Result
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSession, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackInfo, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null

try {
    $mgr = Wait-WinRt ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    $s = $mgr.GetCurrentSession()
    if ($null -eq $s) {
        $all = $mgr.GetSessions()
        if ($all.Count -gt 0) { $s = $all[0] }
    }
    if ($null -eq $s) { Write-Output '{"ok":false,"error":"no SMTC session"}'; exit 1 }

    $op = switch ($Action) {
        'play'   { $s.TryPlayAsync() }
        'pause'  { $s.TryPauseAsync() }
        'next'   { $s.TrySkipNextAsync() }
        'prev'   { $s.TrySkipPreviousAsync() }
        'toggle' {
            if ([int]$s.GetPlaybackInfo().PlaybackStatus -eq 3) { $s.TryPauseAsync() }
            else { $s.TryPlayAsync() }
        }
    }
    $null = Wait-WinRt $op ([bool])
    Write-Output ('{"ok":true,"action":"' + $Action + '"}')
} catch {
    Write-Output ('{"ok":false,"error":' + ($_.Exception.Message | ConvertTo-Json -Compress) + '}')
    exit 1
}
