"""P0.5 gate: prove the overlay HWND really follows the captured game window.

Reads docs/自适应自检.json (written by the running app via GL_FIT_OUT), then asks Win32 for
the ACTUAL GlassLyricsOverlay window rectangle and compares it with what the app intended.

Usage: python tools/verify_window_fit.py
"""
import ctypes
import json
import sys
from ctypes import wintypes
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import p0_pixel_check as base  # noqa: E402

TITLE = "GlassLyricsOverlay"
REPORT = Path(__file__).parent.parent / "docs" / "自适应自检.json"


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


base.user32.SetProcessDPIAware()
base.user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(RECT)]
base.user32.GetWindowRect.restype = wintypes.BOOL


def actual_rect():
    h = base.user32.FindWindowW(None, TITLE)
    if not h:
        return None
    r = RECT()
    if not base.user32.GetWindowRect(h, ctypes.byref(r)):
        return None
    return [r.left, r.top, r.right - r.left, r.bottom - r.top]


def main():
    if not REPORT.exists():
        print(json.dumps({"ok": False, "error": "未找到自适应自检.json，请先启动 app 并设置 GL_FIT_OUT"}, ensure_ascii=False))
        return
    data = json.loads(REPORT.read_text(encoding="utf-8"))
    fit = data.get("autoFit") or {}
    bounds = fit.get("bounds")
    appliedObj = data.get("appliedBounds")
    # Electron's win.getBounds() returns {x,y,width,height}, not an array.
    if isinstance(appliedObj, dict) and all(k in appliedObj for k in ("x", "y", "width", "height")):
        applied = [appliedObj["x"], appliedObj["y"], appliedObj["width"], appliedObj["height"]]
    elif isinstance(appliedObj, list) and len(appliedObj) == 4:
        applied = appliedObj
    else:
        applied = None
    scale = float(fit.get("scale") or 1.0)
    probe = (data.get("windowProbe") or {}).get("rect")
    phys = actual_rect()

    out = {"ok": False, "report": str(REPORT), "autoFit": fit,
           "appliedBounds": appliedObj, "appliedVector": applied,
           "physicalHWNDRect": phys, "dpiScale": scale}

    if phys is None:
        out["error"] = "找不到 GlassLyricsOverlay 窗口"
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return

    # Python is DPI-aware here, so GetWindowRect is physical. Convert back to Electron's DIP space.
    logical = [round(phys[0] / scale), round(phys[1] / scale),
               round(phys[2] / scale), round(phys[3] / scale)]
    out["logicalHWNDRect"] = logical

    def delta(a, b):
        return [abs(a[i] - b[i]) for i in range(4)] if a and b else None

    out["delta_applied_vs_actual"] = delta(applied, logical)
    out["delta_probe_vs_actual"] = delta(probe, logical) if probe else None

    checks = {
        "捕捉到游戏窗口": fit.get("active") is True,
        "探针提供了窗口矩形": isinstance(probe, list) and len(probe) == 4 and probe[2] > 0,
        "实际窗口与设定矩形一致(±8px)": bool(applied and max(delta(applied, logical)) <= 8),
        "窗口尺寸跟随前台窗口(±16px)": bool(probe and max(delta(probe, logical)) <= 16),
        "窗口未超出合理范围": logical[2] >= 320 and logical[3] >= 240,
    }
    out["checks"] = checks
    out["PASS"] = all(checks.values())
    out["ok"] = out["PASS"]
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
