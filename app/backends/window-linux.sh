#!/usr/bin/env bash
# Linux foreground-window probe (X11). Same JSON contract as the Windows/macOS probes.
# Dependencies: xdotool, xprop (apt install xdotool x11-utils)
# Wayland: xdotool cannot see other clients — the probe reports desktop=true so the
# overlay falls back to full-screen instead of following a window.
#
# Performance: one xprop call for all three attributes and pure-bash parsing keeps this
# at 3 child processes per tick (was ~11: three xprops + sed/awk/tr per field).
set -u

if ! command -v xdotool >/dev/null 2>&1; then
  printf '%s\n' '{"ok":false,"error":"xdotool-missing"}'
  exit 0
fi

if [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; then
  while true; do
    printf '%s\n' '{"ok":true,"visible":false,"desktop":true,"error":"wayland-no-window-api"}'
    sleep 0.4
  done
fi

esc() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/}"
  s="${s//$'\r'/}"
  printf '%s' "$s"
}

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

  # Single xprop round-trip for all three attributes.
  # WM_NAME is the legacy fallback for clients that never set _NET_WM_NAME (some Java games).
  info=$(xprop -id "$wid" _NET_WM_PID WM_CLASS _NET_WM_NAME WM_NAME 2>/dev/null) || info=""
  pid=""; cls=""; name=""; legacy=""
  while IFS= read -r line; do
    case "$line" in
      _NET_WM_PID*) pid="${line#*= }" ;;
      WM_CLASS*)    cls="${line#*= }"; cls="${cls//\"/}" ;;
      _NET_WM_NAME*) name="${line#*= \"}"; name="${name%\"}" ;;
      WM_NAME*)     legacy="${line#*= \"}"; legacy="${legacy%\"}" ;;
    esac
  done <<< "$info"
  pid="${pid// /}"
  [ -z "$name" ] && name="$legacy"

  proc=""
  if [ -n "${pid:-}" ] && [ -r "/proc/$pid/comm" ]; then
    proc=$(cat "/proc/$pid/comm" 2>/dev/null)
    proc="${proc//$'\n'/}"
  fi

  printf '{"ok":true,"visible":true,"minimized":false,"desktop":false,"rect":[%s,%s,%s,%s],"process":"%s","className":"%s","title":"%s"}\n' \
    "$X" "$Y" "$WIDTH" "$HEIGHT" "$(esc "$proc")" "$(esc "$cls")" "$(esc "$name")"

  sleep 0.4
done
