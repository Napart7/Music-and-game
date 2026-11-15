# P0 probe: read Windows SMTC (System Media Transport Controls) from PowerShell 5.1.
# No third-party dependency. Prints one JSON line and exits.
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

$asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
        $_.Name -eq 'AsTask' -and
        $_.IsGenericMethodDefinition -and
        $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1

if ($null -eq $asTaskGeneric) { throw 'AsTask(IAsyncOperation<T>) not found' }

function Wait-WinRt($op, [Type]$resultType) {
    $m = $asTaskGeneric.MakeGenericMethod($resultType)
    $t = $m.Invoke($null, @($op))
    $t.Wait(-1) | Out-Null
    return $t.Result
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSession, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionTimelineProperties, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackInfo, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStreamReference, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null

$mgr = Wait-WinRt ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$sessions = $mgr.GetSessions()
$out = @()

foreach ($s in $sessions) {
    $props = Wait-WinRt $s.TryGetMediaPropertiesAsync() ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $timeline = $s.GetTimelineProperties()
    $info = $s.GetPlaybackInfo()
    $out += [ordered]@{
        app      = $s.SourceAppUserModelId
        title    = $props.Title
        artist   = $props.Artist
        album    = $props.AlbumTitle
        status   = [int]$info.PlaybackStatus
        position = [math]::Round($timeline.Position.TotalSeconds, 3)
        duration = [math]::Round($timeline.EndTime.TotalSeconds, 3)
        hasCover = ($null -ne $props.Thumbnail)
    }
}

@{ ok = $true; count = $out.Count; sessions = $out } | ConvertTo-Json -Depth 6 -Compress
