"""P0 验证 1：读取 Windows SMTC 媒体会话。

用法：python tools/p0_smtc.py
输出 JSON，列出所有会话及当前会话的曲目、播放状态、时间轴。
"""
import asyncio
import json
import sys

from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager


def span_seconds(span):
    try:
        return round(span.total_seconds(), 3)
    except Exception:
        return None


async def describe(session):
    item = {"app": session.source_app_user_model_id}
    try:
        props = await session.try_get_media_properties_async()
        item.update({
            "title": props.title,
            "artist": props.artist,
            "album": props.album_title,
            "has_thumbnail": props.thumbnail is not None,
        })
    except Exception as e:
        item["props_error"] = repr(e)
    try:
        info = session.get_playback_info()
        status = info.playback_status
        item["status"] = getattr(status, "name", str(status))
        item["status_value"] = int(status)
    except Exception as e:
        item["playback_error"] = repr(e)
    try:
        tl = session.get_timeline_properties()
        item.update({
            "position_s": span_seconds(tl.position),
            "end_s": span_seconds(tl.end_time),
            "start_s": span_seconds(tl.start_time),
            "last_updated_s": span_seconds(tl.last_updated_time),
        })
    except Exception as e:
        item["timeline_error"] = repr(e)
    return item


async def main():
    mgr = await GlobalSystemMediaTransportControlsSessionManager.request_async()
    result = {"sessions": [], "current": None, "ok": False}
    sessions = mgr.get_sessions()
    for s in sessions:
        result["sessions"].append(await describe(s))
    cur = mgr.get_current_session()
    if cur:
        result["current"] = cur.source_app_user_model_id
        result["current_detail"] = await describe(cur)
    result["ok"] = bool(result["sessions"])
    return result


if __name__ == "__main__":
    try:
        data = asyncio.run(main())
        print(json.dumps(data, ensure_ascii=False, indent=2))
        sys.exit(0 if data["ok"] else 2)
    except Exception as exc:
        print(json.dumps({"ok": False, "fatal": repr(exc)}, ensure_ascii=False, indent=2))
        sys.exit(1)
