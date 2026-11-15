"""GlassLyrics P0 覆盖层原型。

验证三件事：
  1. 透明置顶无边框窗口能否创建并保持在最顶层
  2. QQ音乐 / 网易云的 SMTC 曲目与进度能否实时推给前端
  3. 鼠标穿透与「热键唤出面板」能否正常切换

运行：python tools/p0_overlay.py
热键：Ctrl+Alt+P 唤出/收起面板；Ctrl+Alt+L 显示/隐藏覆盖层
退出：关闭窗口或 Ctrl+C
"""
import asyncio
import ctypes
import json
import os
import threading
import time
from ctypes import wintypes
from datetime import datetime

import webview
from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OVERLAY_URL = "file:///" + os.path.join(ROOT, "src", "overlay.html").replace("\\", "/")
REPORT = os.path.join(ROOT, "docs", "P0验证报告.md")
TITLE = "GlassLyricsOverlayP0"

user32 = ctypes.WinDLL("user32", use_last_error=True)
GWL_EXSTYLE = -20
WS_EX_TRANSPARENT = 0x00000020
WS_EX_TOPMOST = 0x00000008
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_NOACTIVATE = 0x08000000
WS_EX_LAYERED = 0x00080000
HWND_TOPMOST = wintypes.HWND(-1)
SWP_NOMOVE, SWP_NOSIZE, SWP_NOACTIVATE, SWP_SHOWWINDOW = 0x0002, 0x0001, 0x0010, 0x0040
MOD_ALT, MOD_CONTROL, MOD_NOREPEAT = 0x0001, 0x0002, 0x4000
WM_HOTKEY = 0x0312
SW_HIDE, SW_SHOW = 0, 5
LWA_COLORKEY = 0x00000001
CHROMA_KEY = 0x00202020  # COLORREF 0x00BBGGRR -> #202020

user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
user32.FindWindowW.restype = wintypes.HWND
user32.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
user32.GetWindowLongW.restype = ctypes.c_long
user32.SetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_long]
user32.SetWindowLongW.restype = c_long = ctypes.c_long
user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
                                ctypes.c_int, ctypes.c_int, wintypes.UINT]
user32.SetWindowPos.restype = wintypes.BOOL
user32.RegisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int, wintypes.UINT, wintypes.UINT]
user32.RegisterHotKey.restype = wintypes.BOOL
user32.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND,
                               wintypes.UINT, wintypes.UINT]
user32.GetMessageW.restype = ctypes.c_int
user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.GetSystemMetrics.argtypes = [ctypes.c_int]
user32.GetSystemMetrics.restype = ctypes.c_int
user32.SetProcessDPIAware.restype = wintypes.BOOL
user32.SetLayeredWindowAttributes.argtypes = [wintypes.HWND, wintypes.COLORREF,
                                              wintypes.BYTE, wintypes.DWORD]
user32.SetLayeredWindowAttributes.restype = wintypes.BOOL

stop = threading.Event()
panel_open = False
visible = True
hwnd = None
selfcheck = {"window_found": False, "styles": {}, "hotkeys": {}, "smtc_first": None, "errors": []}


def find_hwnd(timeout=15.0):
    end = time.time() + timeout
    while time.time() < end:
        h = user32.FindWindowW(None, TITLE)
        if h:
            return h
        time.sleep(0.2)
    return None


def configure_window(h):
    style = user32.GetWindowLongW(h, GWL_EXSTYLE)
    style |= WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST
    user32.SetWindowLongW(h, GWL_EXSTYLE, style)
    user32.SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW)
    # WebView2 自己画透明背景，但 WinForms 宿主窗体仍是纯色底；
    # 用分层窗口颜色键把该底色抠掉，只留下文字与玻璃面板。
    keyed = user32.SetLayeredWindowAttributes(h, CHROMA_KEY, 0, LWA_COLORKEY)
    final = user32.GetWindowLongW(h, GWL_EXSTYLE)
    selfcheck["styles"] = {
        "raw": int(final),
        "colorkey_applied": bool(keyed),
        "colorkey": "#202020",
        "transparent": bool(final & WS_EX_TRANSPARENT),
        "layered": bool(final & WS_EX_LAYERED),
        "topmost": bool(final & WS_EX_TOPMOST),
        "toolwindow": bool(final & WS_EX_TOOLWINDOW),
        "noactivate": bool(final & WS_EX_NOACTIVATE),
    }


def set_click_through(on):
    if not hwnd:
        return
    style = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
    if on:
        style |= WS_EX_TRANSPARENT
    else:
        style &= ~WS_EX_TRANSPARENT
    user32.SetWindowLongW(hwnd, GWL_EXSTYLE, style)


async def read_smtc():
    mgr = await GlobalSystemMediaTransportControlsSessionManager.request_async()
    s = mgr.get_current_session()
    if not s:
        return None
    props = await s.try_get_media_properties_async()
    info = s.get_playback_info()
    tl = s.get_timeline_properties()
    status = getattr(info.playback_status, "name", str(info.playback_status))
    return {
        "app": s.source_app_user_model_id,
        "title": props.title or "",
        "artist": props.artist or "",
        "album": props.album_title or "",
        "status": str(status),
        "position": round(tl.position.total_seconds(), 3),
        "duration": round(tl.end_time.total_seconds(), 3),
        "has_thumbnail": props.thumbnail is not None,
    }


def register_hotkey(hid, candidates):
    """注册全局热键，被占用时自动回退到备用键。返回实际键名或 None。"""
    for key in candidates:
        if user32.RegisterHotKey(None, hid, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, ord(key)):
            return key
    return None


def hotkey_loop(window):
    pk = register_hotkey(1, ["P"])
    lk = register_hotkey(2, ["L", "H", "K", "B"])
    selfcheck["hotkeys"] = {
        "panel": "Ctrl+Alt+" + pk if pk else None,
        "visible": "Ctrl+Alt+" + lk if lk else None,
        "ok": bool(pk and lk),
    }
    selfcheck["last_error"] = ctypes.get_last_error() if not (pk and lk) else 0
    msg = wintypes.MSG()
    while not stop.is_set():
        r = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
        if r <= 0:
            break
        if msg.message == WM_HOTKEY:
            global panel_open, visible
            if msg.wParam == 1:
                panel_open = not panel_open
                set_click_through(not panel_open)
                try:
                    window.evaluate_js("window.setPanel(%s)" % ("true" if panel_open else "false"))
                except Exception as e:
                    selfcheck["errors"].append("panel js: " + repr(e))
            elif msg.wParam == 2:
                visible = not visible
                user32.ShowWindow(hwnd, SW_SHOW if visible else SW_HIDE)


def smtc_loop(window):
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    first = True
    while not stop.is_set():
        try:
            data = loop.run_until_complete(read_smtc())
            if data:
                if first:
                    selfcheck["smtc_first"] = data
                    first = False
                    write_report()
                window.evaluate_js("window.applyTrack(%s)" % json.dumps(data, ensure_ascii=False))
        except Exception as e:
            selfcheck["errors"].append("smtc: " + repr(e))
        stop.wait(0.3)


def write_report():
    s = selfcheck["styles"]
    sm = selfcheck["smtc_first"]
    hk = selfcheck["hotkeys"]
    panel_key = hk.get("panel") or "Ctrl+Alt+P"
    visible_key = hk.get("visible") or "Ctrl+Alt+H"
    lines = [
        "# P0 验证报告",
        "",
        "生成时间：" + datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "",
        "## 自动验证",
        "",
        "| 项 | 结果 |",
        "|---|---|",
        "| 透明置顶窗创建 | %s |" % ("通过" if selfcheck["window_found"] else "失败"),
        "| 鼠标穿透 WS_EX_TRANSPARENT | %s |" % ("通过" if s.get("transparent") else "失败"),
        "| 分层窗口 WS_EX_LAYERED | %s |" % ("通过" if s.get("layered") else "失败"),
        "| 颜色键抠底 #202020 | %s |" % ("通过" if s.get("colorkey_applied") else "失败"),
        "| 置顶 WS_EX_TOPMOST | %s |" % ("通过" if s.get("topmost") else "失败"),
        "| 不抢焦点 / 不入任务栏 | %s |" % ("通过" if s.get("noactivate") and s.get("toolwindow") else "失败"),
        "| 全局热键（唤出面板 / 显示隐藏） | %s |" % (
            ("%s / %s" % (selfcheck["hotkeys"].get("panel"), selfcheck["hotkeys"].get("visible")))
            if selfcheck["hotkeys"].get("ok") else "注册失败：" + str(selfcheck["hotkeys"])),
        "| SMTC 读到曲目 | %s |" % ("通过" if sm else "未读到（音乐客户端可能未播放）"),
        "",
    ]
    if sm:
        lines += [
            "### SMTC 首次读数",
            "",
            "- 应用：`%s`" % sm["app"],
            "- 曲目：**%s** — %s" % (sm["title"], sm["artist"]),
            "- 专辑：%s" % sm["album"],
            "- 状态：%s" % sm["status"],
            "- 进度：%.3f s / %.3f s" % (sm["position"], sm["duration"]),
            "- 封面缩略图：%s" % ("有" if sm["has_thumbnail"] else "无"),
            "",
        ]
    if selfcheck["errors"]:
        lines += ["### 运行期错误", ""] + ["- " + e for e in selfcheck["errors"][:10]] + [""]
    lines += [
        "## 需要你人工确认的部分",
        "",
        "自动检查只能证明「窗口存在且样式正确」，不能证明「在游戏画面上真的看得见」。请：",
        "",
        "1. 保持本窗口运行，把 Terraria（或任一单机）设成**无边框全屏 / 窗口化**并切到前台。",
        "2. 看歌词是否仍浮在游戏画面上、鼠标操作是否不被挡。",
        "3. 按 `%s` 唤出面板，确认此时面板可点；再按一次收起，确认鼠标恢复穿透。" % panel_key,
        "4. 按 `%s` 隐藏 / 显示整个覆盖层。" % visible_key,
        "5. 若游戏开的是**独占全屏**，覆盖层会被系统隐藏，这是显示规则，改成无边框全屏即可。",
        "",
        "把结果告诉我，我按实测情况决定 P0 是否通过、是否要换原生 D3D 分层窗口方案。",
        "",
        "> 当前歌词为 P0 占位文本，真实歌词源（QRC / YRC）属于 P1，尚未接入。",
        "",
    ]
    with open(REPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def bootstrap(window):
    global hwnd
    hwnd = find_hwnd()
    selfcheck["window_found"] = bool(hwnd)
    if hwnd:
        configure_window(hwnd)
    else:
        selfcheck["errors"].append("FindWindowW 未找到覆盖层窗口")
    threading.Thread(target=hotkey_loop, args=(window,), daemon=True).start()
    write_report()
    smtc_loop(window)


def main():
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass
    w = user32.GetSystemMetrics(0)
    h = user32.GetSystemMetrics(1)
    window = webview.create_window(
        TITLE,
        url=OVERLAY_URL,
        width=w, height=h, x=0, y=0,
        frameless=True, transparent=True, on_top=True,
        easy_drag=False, resizable=False,
        background_color="#202020",
    )
    try:
        webview.start(bootstrap, (window,), gui="edgechromium", debug=False)
    finally:
        stop.set()


if __name__ == "__main__":
    main()
