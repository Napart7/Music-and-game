# Long-running SMTC reader. Emits one compact JSON object per line on stdout.
# No third-party dependency: uses WinRT types already present on Windows 10/11.
# Node spawns this once and streams the lines to the renderer via IPC.
param([int]$IntervalMs = 500)

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

function Emit($obj) {
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Depth 6 -Compress))
    [Console]::Out.Flush()
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSession, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionTimelineProperties, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackInfo, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStreamReference, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null

$statusNames = @{ 0 = 'CLOSED'; 1 = 'OPENED'; 2 = 'PAUSED'; 3 = 'PLAYING'; 4 = 'STOPPED'; 5 = 'CHANGING' }
$mgr = $null

while ($true) {
    try {
        if ($null -eq $mgr) {
            $mgr = Wait-WinRt ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
        }

        $s = $mgr.GetCurrentSession()
        if ($null -eq $s) {
            $all = $mgr.GetSessions()
            if ($all.Count -gt 0) { $s = $all[0] }
        }

        if ($null -eq $s) {
            Emit @{ ok = $true; active = $false; app = ''; title = ''; artist = ''; album = '';
                    status = 'NONE'; statusValue = -1; position = 0; duration = 0; hasCover = $false }
        } else {
            $p = Wait-WinRt $s.TryGetMediaPropertiesAsync() ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
            $tl = $s.GetTimelineProperties()
            $info = $s.GetPlaybackInfo()
            $sv = [int]$info.PlaybackStatus
            $name = if ($statusNames.ContainsKey($sv)) { $statusNames[$sv] } else { 'UNKNOWN' }
            Emit @{
                ok = $true; active = $true
                app = $s.SourceAppUserModelId
                title = $p.Title
                artist = $p.Artist
                album = $p.AlbumTitle
                status = $name
                statusValue = $sv
                position = [math]::Round($tl.Position.TotalSeconds, 3)
                duration = [math]::Round($tl.EndTime.TotalSeconds, 3)
                hasCover = ($null -ne $p.Thumbnail)
            }
        }
    } catch {
        $mgr = $null
        Emit @{ ok = $false; error = $_.Exception.Message }
    }
    Start-Sleep -Milliseconds $IntervalMs
}
