"""P0 gate (Electron): prove the transparent always-on-top window is REALLY transparent.

Method: use a tiny local control port (127.0.0.1:17891) to call win.hide()/win.show(),
then grab desktop pixels in both states. ShowWindow(SW_HIDE) does NOT reliably hide a
layered Electron window, which silently produced identical frames in the first attempt.

- Blank areas INSIDE the window must stay nearly identical -> real transparency.
- A solid white anchor INSIDE the window must change a lot -> content is rendered.
- A uniform white/grey veil over blank areas -> opaque host (the pywebview failure mode).

Regions are computed from GetWindowRect so DPI scaling cannot shift them.
Usage: python tools/p0_electron_check.py   (requires p0-electron window running)
"""
import ctypes
import json
import socket
import sys
import time
from ctypes import wintypes
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import p0_pixel_check as base  # noqa: E402  (reuses grab / diff)

from PIL import Image  # noqa: E402

TITLE = "GlassLyricsElectronP0"
CTRL_PORT = 17891
LOGICAL_W, LOGICAL_H = 1200, 700
OUT_PNG = Path(__file__).parent.parent / "docs" / "P0-Electron透明窗截图.png"


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


base.user32.SetProcessDPIAware()
base.user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(RECT)]
base.user32.GetWindowRect.restype = wintypes.BOOL


def ctrl(cmd):
    with socket.create_connection(("127.0.0.1", CTRL_PORT), timeout=3) as s:
        s.sendall(cmd.encode())
        return s.recv(64).decode().strip()


def stats(raw):
    n = len(raw) // 4
    lum = [(raw[i] + raw[i + 1] + raw[i + 2]) / 3 for i in range(0, len(raw), 4)]
    mean = sum(lum) / n
    return {"stddev": round((sum((v - mean) ** 2 for v in lum) / n) ** 0.5, 2)}


def screenshot(path):
    W, H = base.user32.GetSystemMetrics(0), base.user32.GetSystemMetrics(1)
    raw = base.grab(0, 0, W, H)
    Image.frombytes("RGBA", (W, H), raw, "raw", "BGRA").convert("RGB").save(path)
    return [W, H]


def main():
    hwnd = base.user32.FindWindowW(None, TITLE)
    if not hwnd:
        print(json.dumps({"ok": False, "error": "Electron 窗口未找到"}, ensure_ascii=False))
        return

    rect = RECT()
    if not base.user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        print(json.dumps({"ok": False, "error": "GetWindowRect 失败"}, ensure_ascii=False))
        return

    l, t = rect.left, rect.top
    scale = (rect.right - rect.left) / LOGICAL_W

    def rel(x, y, s=64):
        return (int(l + x * scale), int(t + y * scale), s, s)

    regions = {
        "窗口外对照": (8, 8, 64, 64),
        "窗口内空白中央": rel(600, 350),
        "窗口内空白右下": rel(1080, 620),
        "内容锚点白块": rel(60, 45),
        "辉光文字区": rel(900, 315),
    }
    blanks = ("窗口内空白中央", "窗口内空白右下")

    ctrl("hide")
    time.sleep(0.8)
    hidden = {k: base.grab(*v) for k, v in regions.items()}
    ctrl("show")
    time.sleep(1.2)
    shown = {k: base.grab(*v) for k, v in regions.items()}

    result = {"ok": True, "window_rect": [l, t, rect.right, rect.bottom],
              "dpi_scale": round(scale, 3), "regions": {}}
    for k in regions:
        d = base.diff(hidden[k], shown[k])
        d.update(stats(shown[k]))
        result["regions"][k] = d

    veils = []
    for k in blanks:
        r = result["regions"][k]
        rgb = r["shown_mean_rgb"]
        veils.append((min(rgb) > 200 or max(rgb) < 20) and r["stddev"] < 6)

    result["min_blank_delta"] = round(min(result["regions"][k]["mean_rgb_delta"] for k in blanks), 2)
    result["opaque_veil_detected"] = any(veils)
    result["anchor_delta"] = result["regions"]["内容锚点白块"]["mean_rgb_delta"]
    result["transparent_background"] = result["min_blank_delta"] < 10 and not result["opaque_veil_detected"]
    result["content_visible"] = result["anchor_delta"] > 40
    result["P0_PASS"] = result["transparent_background"] and result["content_visible"]

    try:
        result["screenshot_size"] = screenshot(OUT_PNG)
        result["screenshot"] = str(OUT_PNG)
    except Exception as e:  # pragma: no cover
        result["screenshot_error"] = repr(e)

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
