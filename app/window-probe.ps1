# Long-running foreground-window probe. Emits one compact JSON line per change (plus a heartbeat).
# Used by the Electron main process to auto-fit the overlay onto the active game window.
# No third-party dependency. PowerShell 5.1 is not DPI-aware by default, so RECT values are
# logical/DIP coordinates -- the same coordinate space Electron's screen module uses.
param([int]$IntervalMs = 400, [switch]$Once)

$ErrorActionPreference = 'Stop'
# Node reads this stream as UTF-8; without this, Chinese window titles arrive as mojibake.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class GlassWin32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] public static extern int GetWindowLong32(IntPtr hWnd, int nIndex);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT pvAttribute, int cbAttribute);
  public static long Style(IntPtr h) {
    return IntPtr.Size == 8 ? GetWindowLongPtr64(h, -16).ToInt64() : (long)GetWindowLong32(h, -16);
  }
}
'@ -ErrorAction Stop

function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 5))
  [Console]::Out.Flush()
}

$tick = 0
$last = ''
while ($true) {
  $tick++
  try {
    $h = [GlassWin32]::GetForegroundWindow()
    $raw = New-Object GlassWin32+RECT
    [void][GlassWin32]::GetWindowRect($h, [ref]$raw)
    $ext = New-Object GlassWin32+RECT
    $hr = [GlassWin32]::DwmGetWindowAttribute($h, 9, [ref]$ext, 16)  # DWMWA_EXTENDED_FRAME_BOUNDS
    if ($hr -eq 0 -and $ext.Right -gt $ext.Left -and $ext.Bottom -gt $ext.Top) { $use = $ext } else { $use = $raw }

    $tb = New-Object System.Text.StringBuilder 512
    [void][GlassWin32]::GetWindowTextW($h, $tb, 512)
    $cb = New-Object System.Text.StringBuilder 256
    [void][GlassWin32]::GetClassNameW($h, $cb, 256)
    $procId = [uint32]0
    [void][GlassWin32]::GetWindowThreadProcessId($h, [ref]$procId)
    $pname = ''
    try { $pname = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { }

    $style = [GlassWin32]::Style($h)
    $caption = (($style -band 0x00C00000) -eq 0x00C00000)
    $desktopHwnds = @([GlassWin32]::GetDesktopWindow().ToInt64(), [GlassWin32]::GetShellWindow().ToInt64())

    $obj = @{
      ok = $true
      hwnd = $h.ToInt64()
      title = $tb.ToString()
      className = $cb.ToString()
      process = $pname
      pid = [int]$procId
      # GetWindowRect is DPI-virtualised in this process -> logical/DIP, same space Electron uses.
      rect = @($raw.Left, $raw.Top, ($raw.Right - $raw.Left), ($raw.Bottom - $raw.Top))
      # DWM extended frame bounds are PHYSICAL pixels. Divide by scaleFactor in main.js before use.
      rectPhysical = @($use.Left, $use.Top, ($use.Right - $use.Left), ($use.Bottom - $use.Top))
      visible = [GlassWin32]::IsWindowVisible($h)
      minimized = [GlassWin32]::IsIconic($h)
      caption = $caption
      style = $style
      desktop = ($desktopHwnds -contains $h.ToInt64())
      heartbeat = $false
    }
    $json = $obj | ConvertTo-Json -Compress -Depth 5
    $changed = ($json -ne $last)
    if ($changed -or $Once -or ($tick % 8 -eq 0)) {
      $obj.heartbeat = (-not $changed)
      Emit $obj
      $last = $json
    }
  } catch {
    Emit @{ ok = $false; error = $_.Exception.Message }
  }
  if ($Once) { break }
  Start-Sleep -Milliseconds $IntervalMs
}
