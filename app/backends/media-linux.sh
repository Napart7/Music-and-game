#!/usr/bin/env bash
# Linux media backend: MPRIS over D-Bus, via playerctl (works with Spotify, Chromium,
# VLC, mpv, Rhythmbox, Amberol, …). Emits ONE JSON object per line every 500 ms.
# Dependency: playerctl (apt install playerctl / dnf install playerctl / pacman -S playerctl)
set -u

if ! command -v playerctl >/dev/null 2>&1; then
  # Contract-preserving error: the app shows a hint instead of silently doing nothing.
  printf '%s\n' '{"ok":false,"error":"playerctl-missing"}'
  exit 0
fi

json_escape() {
  printf '%s' "$1" | tr -d '\r\n' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

to_seconds() {
  awk -v us="${1:-0}" 'BEGIN { if (us ~ /^[0-9]+$/) printf "%.3f", us / 1000000; else printf "0" }'
}

emit_none() {
  printf '%s\n' '{"ok":true,"active":false,"status":"NONE","statusValue":-1,"app":"","title":"","artist":"","album":"","position":0,"duration":0,"hasCover":false}'
}

while true; do
  if ! status_raw=$(playerctl status 2>/dev/null); then
    emit_none
    sleep 0.5
    continue
  fi

  case "$status_raw" in
    Playing) status="PLAYING"; sval=3 ;;
    Paused)  status="PAUSED";  sval=2 ;;
    Stopped) status="STOPPED"; sval=4 ;;
    *)       emit_none; sleep 0.5; continue ;;
  esac

  # playerctl prints one line per requested field, '|' separated by our format string.
  line=$(playerctl metadata --format \
    '{{playerName}}|{{artist}}|{{title}}|{{album}}|{{position}}|{{mpris:length}}|{{mpris:artUrl}}|{{status}}' \
    2>/dev/null | head -n 1) || line=""
  IFS='|' read -r player artist title album pos_us len_us art_url _rest <<< "$line"

  position=$(to_seconds "${pos_us:-0}")
  duration=$(to_seconds "${len_us:-0}")

  cover="null"
  has_cover="false"
  if [ -n "${art_url:-}" ]; then
    cover="\"$(json_escape "$art_url")\""
    has_cover="true"
  fi

  printf '{"ok":true,"active":%s,"status":"%s","statusValue":%s,"app":"%s","player":"%s","title":"%s","artist":"%s","album":"%s","position":%s,"duration":%s,"hasCover":%s,"coverUrl":%s}\n' \
    "$([ "$status" = "STOPPED" ] && echo false || echo true)" \
    "$status" "$sval" \
    "$(json_escape "$player")" "$(json_escape "$player")" \
    "$(json_escape "$title")" "$(json_escape "$artist")" "$(json_escape "$album")" \
    "$position" "$duration" "$has_cover" "$cover"

  sleep 0.5
done
