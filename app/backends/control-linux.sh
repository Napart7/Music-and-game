#!/usr/bin/env bash
# Linux playback control (single shot). $1 = play | pause | toggle | next | prev
set -u
action="${1:-toggle}"

if ! command -v playerctl >/dev/null 2>&1; then
  printf '%s\n' '{"ok":false,"error":"playerctl-missing"}'
  exit 0
fi

case "$action" in
  play)   playerctl play       2>/dev/null && printf '%s\n' '{"ok":true,"action":"play"}'   || printf '%s\n' '{"ok":false,"error":"no-player"}' ;;
  pause)  playerctl pause      2>/dev/null && printf '%s\n' '{"ok":true,"action":"pause"}'  || printf '%s\n' '{"ok":false,"error":"no-player"}' ;;
  toggle) playerctl play-pause 2>/dev/null && printf '%s\n' '{"ok":true,"action":"toggle"}' || printf '%s\n' '{"ok":false,"error":"no-player"}' ;;
  next)   playerctl next       2>/dev/null && printf '%s\n' '{"ok":true,"action":"next"}'   || printf '%s\n' '{"ok":false,"error":"no-player"}' ;;
  prev)   playerctl previous   2>/dev/null && printf '%s\n' '{"ok":true,"action":"prev"}'   || printf '%s\n' '{"ok":false,"error":"no-player"}' ;;
  *)      printf '%s\n' '{"ok":false,"error":"unknown-action"}' ;;
esac
