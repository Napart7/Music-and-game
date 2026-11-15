"""P0 验证 2：屏幕像素对比，判断覆盖层背景是否真的透明。

原理：同一个屏幕区域，在「隐藏覆盖层」与「显示覆盖层」两种状态下各抓一次像素。
  - 空白角落区域：两次几乎一致 -> 背景透明；显示时变成纯黑/纯色 -> 不透明，P0 失败
  - 歌词区域：两次有明显差异 -> 文字确实被画出来了

注意：WebView2 若走 DirectComposition，GDI BitBlt 可能抓不到其内容，
      因此「歌词区域无差异」不等于窗口没显示，要以肉眼实测为准。

用法：python tools/p0_pixel_check.py   （需 p0_overlay.py 正在运行）
"""
import ctypes
import json
import time
from ctypes import wintypes

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
TITLE = "GlassLyricsOverlayP0"
SW_HIDE, SW_SHOW = 0, 5
SRCCOPY = 0x00CC0020
DIB_RGB_COLORS = 0


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD), ("biWidth", ctypes.c_long), ("biHeight", ctypes.c_long),
        ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD), ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", ctypes.c_long), ("biYPelsPerMeter", ctypes.c_long),
        ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


user32.GetDC.argtypes = [wintypes.HWND]
user32.GetDC.restype = wintypes.HDC
user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
user32.FindWindowW.restype = wintypes.HWND
user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.GetSystemMetrics.argtypes = [ctypes.c_int]
gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
gdi32.CreateCompatibleDC.restype = wintypes.HDC
gdi32.CreateCompatibleBitmap.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int]
gdi32.CreateCompatibleBitmap.restype = wintypes.HBITMAP
gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
gdi32.SelectObject.restype = wintypes.HGDIOBJ
gdi32.BitBlt.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                         wintypes.HDC, ctypes.c_int, ctypes.c_int, wintypes.DWORD]
gdi32.BitBlt.restype = wintypes.BOOL
gdi32.GetDIBits.argtypes = [wintypes.HDC, wintypes.HBITMAP, wintypes.UINT, wintypes.UINT,
                            ctypes.c_void_p, ctypes.POINTER(BITMAPINFO), wintypes.UINT]
gdi32.GetDIBits.restype = ctypes.c_int
gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
gdi32.DeleteDC.argtypes = [wintypes.HDC]


def grab(x, y, w, h):
    hdc = user32.GetDC(None)
    mem = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
    old = gdi32.SelectObject(mem, bmp)
    gdi32.BitBlt(mem, 0, 0, w, h, hdc, x, y, SRCCOPY)
    bi = BITMAPINFO()
    bi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bi.bmiHeader.biWidth = w
    bi.bmiHeader.biHeight = -h
    bi.bmiHeader.biPlanes = 1
    bi.bmiHeader.biBitCount = 32
    bi.bmiHeader.biCompression = 0
    buf = (ctypes.c_ubyte * (w * h * 4))()
    gdi32.GetDIBits(mem, bmp, 0, h, buf, ctypes.byref(bi), DIB_RGB_COLORS)
    gdi32.SelectObject(mem, old)
    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mem)
    user32.ReleaseDC(None, hdc)
    return bytes(buf)


def diff(a, b):
    total = 0
    maxd = 0
    dark = 0
    sr = sg = sb = 0
    for i in range(0, len(a), 4):
        d = abs(a[i] - b[i]) + abs(a[i + 1] - b[i + 1]) + abs(a[i + 2] - b[i + 2])
        total += d
        maxd = max(maxd, d)
        sr += b[i]; sg += b[i + 1]; sb += b[i + 2]
        if b[i] < 12 and b[i + 1] < 12 and b[i + 2] < 12:
            dark += 1
    n = len(a) // 4
    return {"mean_rgb_delta": round(total / n / 3, 2), "max_delta": maxd,
            "shown_mean_rgb": [round(sr / n), round(sg / n), round(sb / n)],
            "shown_near_black_ratio": round(dark / n, 3)}


def main():
    hwnd = user32.FindWindowW(None, TITLE)
    if not hwnd:
        print(json.dumps({"ok": False, "error": "覆盖层窗口未找到，请先运行 p0_overlay.py"}, ensure_ascii=False))
        return
    W, H = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
    size = 64
    regions = {
        "左上角落（应无内容）": (8, 8, size, size),
        "正中央（应完全留空）": (W // 2 - size // 2, H // 2 - size // 2, size, size),
        "右侧中部（歌词区）": (int(W * 0.72), int(H * 0.46), size, size),
        "左侧中部（歌词区）": (int(W * 0.06), int(H * 0.46), size, size),
    }
    user32.ShowWindow(hwnd, SW_HIDE)
    time.sleep(0.5)
    hidden = {k: grab(*v) for k, v in regions.items()}
    user32.ShowWindow(hwnd, SW_SHOW)
    time.sleep(1.0)
    shown = {k: grab(*v) for k, v in regions.items()}

    out = {"ok": True, "screen": [W, H], "regions": {}}
    for k in regions:
        out["regions"][k] = diff(hidden[k], shown[k])
    blanks = [out["regions"][k] for k in ("左上角落（应无内容）", "正中央（应完全留空）")]
    out["min_blank_delta"] = min(b["mean_rgb_delta"] for b in blanks)
    out["opaque_black_detected"] = any(b["shown_near_black_ratio"] > 0.8 for b in blanks)
    out["transparent_background"] = (not out["opaque_black_detected"]) and out["min_blank_delta"] < 8
    out["note"] = ("桌面动态内容会让部分空白区 delta 偏大，不能据此判定不透明。"
                   "只要存在一处空白区几乎无变化、且显示时未出现纯黑块，即视为背景透明。"
                   "WebView2 若走 DirectComposition，GDI 可能抓不到文字，歌词区差异小不代表没显示。")
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
