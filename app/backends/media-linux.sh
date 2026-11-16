#!/usr/bin/env bash
# Linux media backend: MPRIS over D-Bus, via playerctl (works with Spotify, Chromium,
# VLC, mpv, Rhythmbox, Amberol, …). Emits ONE JSON object per line every 500 ms.
# Dependency: playerctl (apt install playerctl / dnf install playerctl / pacman -S playerctl)
#
# Performance: `playerctl status` + one `playerctl metadata` + one awk = 3 child processes
# per tick; JSON escaping uses bash built-ins (no sed/tr forks).
set -u

if ! command -v playerctl >/dev/null 2>&1; then
  # Contract-preserving error: the app shows a hint instead of silently doing nothing.
  printf '%s\n' '{"ok":false,"error":"playerctl-missing"}'
  exit 0
fi

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\r'/}"
  s="${s//$'\n'/}"
  printf '%s' "$s"
}

emit_none() {
  printf '{"ok":true,"active":false,"status":"NONE","statusValue":-1,"app":"","title":"","artist":"","album":"","position":0,"duration":0,"hasCover":false,"sampledAtMs":%s,"playbackRate":1}\n' "$(printf '%(%s)T000' -1)"
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
    '{{playerName}}|{{artist}}|{{title}}|{{album}}|{{position}}|{{mpris:length}}|{{mpris:artUrl}}' \
    2>/dev/null | head -n 1) || line=""
  IFS='|' read -r player artist title album pos_us len_us art_url <<< "$line"

  # One awk call for both values (was one per value).
  read -r position duration <<< "$(awk -v p="${pos_us:-0}" -v l="${len_us:-0}" 'BEGIN {
    printf "%s %s\n", (p ~ /^[0-9]+$/ ? sprintf("%.3f", p / 1000000) : "0"),
                      (l ~ /^[0-9]+$/ ? sprintf("%.3f", l / 1000000) : "0")
  }')"

  cover="null"
  has_cover="false"
  if [ -n "${art_url:-}" ]; then
    cover="\"$(json_escape "$art_url")\""
    has_cover="true"
  fi

  active="true"
  [ "$status" = "STOPPED" ] && active="false"
  sampled_at="$(printf '%(%s)T000' -1)"

  printf '{"ok":true,"active":%s,"status":"%s","statusValue":%s,"app":"%s","player":"%s","title":"%s","artist":"%s","album":"%s","position":%s,"duration":%s,"hasCover":%s,"coverUrl":%s,"sampledAtMs":%s,"playbackRate":1}\n' \
    "$active" "$status" "$sval" \
    "$(json_escape "$player")" "$(json_escape "$player")" \
    "$(json_escape "$title")" "$(json_escape "$artist")" "$(json_escape "$album")" \
    "$position" "$duration" "$has_cover" "$cover" "$sampled_at"

  sleep 0.5
done
