#!/usr/bin/env bash
# Linux foreground-window probe (X11). Same JSON contract as the Windows/macOS probes.
# Dependencies: xdotool, xprop (apt install xdotool x11-utils)
# Wayland: xdotool cannot see other clients — the probe reports desktop=true so the
# overlay falls back to full-screen instead of following a window.
set -u

if ! command -v xdotool >/dev/null 2>&1; then
  printf '%s\n' '{"ok":false,"error":"xdotool-missing"}'
  exit 0
fi

if [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; then
  # Wayland has no cross-client window geometry for ordinary apps (by design).
  while true; do
    printf '%s\n' '{"ok":true,"visible":false,"desktop":true,"error":"wayland-no-window-api"}'
    sleep 0.4
  done
fi

while true; do
  wid=$(xdotool getactivewindow 2>/dev/null) || wid=""
  if [ -z "$wid" ]; then
    printf '%s\n' '{"ok":true,"visible":false,"desktop":true,"process":"","className":"","title":""}'
    sleep 0.4
    continue
  fi

  # xdotool prints shell assignments: X=.. Y=.. WIDTH=.. HEIGHT=.. (values are integers).
  geom=$(xdotool getwindowgeometry --shell "$wid" 2>/dev/null) || geom=""
  if [ -z "$geom" ]; then
    printf '%s\n' '{"ok":true,"visible":false,"desktop":true,"process":"","className":"","title":""}'
    sleep 0.4
    continue
  fi
  X=0; Y=0; WIDTH=0; HEIGHT=0
  eval "$geom"   # safe: values come from xdotool as plain integers

  pid=$(xprop -id "$wid" _NET_WM_PID 2>/dev/null | awk -F'= ' '{print $2}' | tr -d ' ')
  proc=""
  if [ -n "${pid:-}" ] && [ -r "/proc/$pid/comm" ]; then
    proc=$(tr -d '\n' < "/proc/$pid/comm")
  fi

  cls=$(xprop -id "$wid" WM_CLASS 2>/dev/null | sed 's/^[^=]*= //; s/"//g' | tr -d '\n')
  name=$(xprop -id "$wid" _NET_WM_NAME 2>/dev/null | sed 's/^[^=]*= "//; s/"$//' | tr -d '\n')
  esc() { printf '%s' "$1" | tr -d '\r\n' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

  printf '{"ok":true,"visible":true,"minimized":false,"desktop":false,"rect":[%s,%s,%s,%s],"process":"%s","className":"%s","title":"%s"}\n' \
    "$X" "$Y" "$WIDTH" "$HEIGHT" "$(esc "$proc")" "$(esc "$cls")" "$(esc "$name")"

  sleep 0.4
done
