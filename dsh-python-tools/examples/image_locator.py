"""用户发来的图片到底存在哪：从会话记录里按 attachmentId 精确定位。

解决的问题：对话里看到的图片不是"没有名字的一团哈希"。会话记录（jsonl.zstd）里
记着每张图的名字、媒体类型、宽高、字节数和 attachmentId；attachmentId 是
`sha256:<hex>`，直接换算就是附件仓里的绝对路径：

    <DSH_HOME>/attachments/v1/objects/<hex 前 2 位>/<hex>

所以定位一张图不需要扫描、不需要比对特征，读会话记录一步到位。

三个工具：
- `image-list`   列出一个会话里所有用户发来的图片（seq / 时间 / 名字 / 尺寸 / 路径）
- `image-locate` 取最近一张（或第 N 张）用户图片的元数据和绝对路径
- `image-save`   把它按 PNG 存到桌面（或指定位置），返回可交给直觉标注的路径

登记：
    pytools install C:\\Users\\computer\\Desktop\\dsh-python-tools\\examples\\image_locator.py
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import time
from typing import Any, Dict, List, Optional

import pytools_client as pytools
from pytools_client import register, skill

pytools.describe(
    "从会话记录里精确定位用户发来的图片：读 attachmentId、换算真实路径、按需存成 PNG。",
    tags=["image", "session", "attachments"],
)

DESKTOP = os.path.join(os.path.expanduser("~"), "Desktop")


# --- 路径 -------------------------------------------------------------------


def _dsh_home() -> str:
    home = os.environ.get("DSH_HOME")
    if home:
        return home
    return os.path.join(os.path.expanduser("~"), ".dsh")


def _sessions_root() -> str:
    explicit = os.environ.get("PYTOOLS_SESSIONS_DIR")
    if explicit:
        return explicit
    return os.path.join(_dsh_home(), "sessions")


def _objects_root() -> str:
    explicit = os.environ.get("PYTOOLS_ATTACHMENTS_DIR")
    if explicit:
        return explicit
    return os.path.join(_dsh_home(), "attachments", "v1", "objects")


def _object_path(attachment_id: str) -> Optional[str]:
    """`sha256:<hex>` -> 附件仓里的绝对路径。"""
    if not attachment_id:
        return None
    hexpart = attachment_id.split(":", 1)[-1].strip().lower()
    if not re.fullmatch(r"[0-9a-f]{64}", hexpart):
        return None
    return os.path.join(_objects_root(), hexpart[:2], hexpart)


def _candidate_sessions() -> List[Dict[str, Any]]:
    """扫所有会话文件，按修改时间倒序（最新的最可能就是"当前这个"）。"""
    root = _sessions_root()
    found: List[Dict[str, Any]] = []
    if not os.path.isdir(root):
        return found
    for workspace in os.listdir(root):
        wdir = os.path.join(root, workspace)
        if not os.path.isdir(wdir):
            continue
        for session in os.listdir(wdir):
            sdir = os.path.join(wdir, session)
            if not os.path.isdir(sdir):
                continue
            path = os.path.join(sdir, "session.v4.jsonl.zstd")
            if not os.path.isfile(path):
                continue
            try:
                stat = os.stat(path)
            except OSError:
                continue
            found.append(
                {
                    "sessionId": session,
                    "workspace": workspace,
                    "path": path,
                    "mtimeMs": int(stat.st_mtime * 1000),
                    "bytes": stat.st_size,
                }
            )
    found.sort(key=lambda item: item["mtimeMs"], reverse=True)
    return found


def _pick_session(session: str = "") -> Dict[str, Any]:
    candidates = _candidate_sessions()
    if not candidates:
        raise RuntimeError("找不到任何会话文件，先确认 DSH_HOME 是否正确：%s" % _sessions_root())
    if session:
        needle = session.strip()
        for item in candidates:
            if needle in item["sessionId"] or needle in item["path"]:
                return item
        raise RuntimeError("没有匹配这个字符串的会话：%s" % session)
    return candidates[0]


# --- 读会话 -----------------------------------------------------------------


def _read_events(path: str) -> List[Dict[str, Any]]:
    """列出会话事件：优先用 zstandard 流式解压（跨帧），否则退回纯文本。"""
    try:
        import zstandard
    except ImportError:
        zstandard = None

    raw = b""
    if zstandard is not None:
        try:
            with open(path, "rb") as handle:
                reader = zstandard.ZstdDecompressor().stream_reader(handle, read_across_frames=True)
                raw = reader.read()
        except Exception:
            raw = b""

    if not raw:
        with open(path, "r", encoding="utf-8", errors="ignore") as handle:
            text = handle.read()
    else:
        text = raw.decode("utf-8", "ignore")

    events: List[Dict[str, Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            events.append(json.loads(line))
        except ValueError:
            continue
    return events


def _images_in_session(session: str = "") -> Dict[str, Any]:
    """返回 {session: {...}, images: [...]}，按 seq 升序。"""
    info = _pick_session(session)
    events = _read_events(info["path"])

    images: List[Dict[str, Any]] = []
    for event in events:
        if event.get("type") != "user/message":
            continue
        content = (event.get("data") or {}).get("content")
        if not isinstance(content, list):
            continue
        for item in content:
            if not isinstance(item, dict) or item.get("type") != "image":
                continue
            attachment = item.get("attachment") or {}
            attachment_id = attachment.get("attachmentId") or ""
            path = _object_path(attachment_id)
            exists = bool(path and os.path.isfile(path))
            images.append(
                {
                    "seq": event.get("seq"),
                    "time": event.get("time"),
                    "timeText": _time_text(event.get("time")),
                    "name": attachment.get("name") or "",
                    "mediaType": attachment.get("mediaType") or "",
                    "width": attachment.get("width"),
                    "height": attachment.get("height"),
                    "bytes": attachment.get("bytes"),
                    "attachmentId": attachment_id,
                    "path": path or "",
                    "exists": exists,
                }
            )

    images.sort(key=lambda item: (item.get("seq") or 0))
    return {"session": info, "images": images}


def _time_text(ms: Any) -> str:
    try:
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(int(ms) / 1000))
    except (TypeError, ValueError, OSError):
        return ""


# --- 存成 PNG ---------------------------------------------------------------


def _save_png(source: str, target: str) -> Dict[str, Any]:
    """读源图并写成 PNG；源图不是 PNG 时顺带转换。"""
    from PIL import Image

    os.makedirs(os.path.dirname(os.path.abspath(target)), exist_ok=True)
    with Image.open(source) as image:
        original = image.format
        size = list(image.size)
        if original == "PNG":
            shutil.copyfile(source, target)
        else:
            if image.mode not in ("RGB", "RGBA"):
                image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
            image.save(target, format="PNG")
    return {
        "output": target,
        "sourceFormat": original,
        "width": size[0],
        "height": size[1],
        "bytes": os.path.getsize(target),
    }


def _default_output(index: int) -> str:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    return os.path.join(DESKTOP, "user-image-%s-%d.png" % (stamp, index))


# --- 工具 -------------------------------------------------------------------


@register(
    description="列出某个会话里用户发来的所有图片：seq、时间、文件名、尺寸、绝对路径。",
    timeout=60,
)
def image_list(session: str = "", limit: int = 50) -> Dict[str, Any]:
    """列出会话里的用户图片。

    Args:
        session: 会话 id 或路径片段，留空用最近修改的那个会话。
        limit: 最多返回几条（从最新的往前取）。
    """
    data = _images_in_session(session)
    images = data["images"][-max(1, limit):]
    info = data["session"]
    return {
        "sessionId": info["sessionId"],
        "workspace": info["workspace"],
        "sessionFile": info["path"],
        "total": len(data["images"]),
        "returned": len(images),
        "images": images,
    }


@register(
    description="定位用户发来的图片：取最近一张（或第 N 张），给出名字、尺寸和可直接读取的绝对路径。",
    timeout=60,
)
def image_locate(session: str = "", index: int = -1) -> Dict[str, Any]:
    """定位一张用户图片。

    Args:
        session: 会话 id 或路径片段，留空用最近修改的那个会话。
        index: -1 表示最后一张；0 表示第一张；也可给正数做 1 起的位置。
    """
    data = _images_in_session(session)
    images = data["images"]
    info = data["session"]
    if not images:
        raise RuntimeError("这个会话里没有任何用户图片：%s" % info["sessionId"])

    if index == -1:
        picked = images[-1]
    elif index == 0:
        picked = images[0]
    elif index > 0:
        if index > len(images):
            raise RuntimeError("一共只有 %d 张图片，取不到第 %d 张" % (len(images), index))
        picked = images[index - 1]
    else:
        raise RuntimeError("index 只能是 -1（最后一张）、0（第一张）或从 1 开始的正数")

    result = dict(picked)
    result["total"] = len(images)
    result["sessionId"] = info["sessionId"]
    result["sessionFile"] = info["path"]
    if not picked["exists"]:
        result["hint"] = "附件仓里没有这个对象，可能已被清理；可以试试 image_save 看具体报错"
    return result


@register(
    description="把用户发来的图片按 PNG 存到桌面（或指定路径），返回路径供直觉标注等工具直接使用。",
    timeout=120,
)
def image_save(
    session: str = "",
    index: int = -1,
    output: str = "",
    overwrite: bool = False,
) -> Dict[str, Any]:
    """保存用户图片为 PNG。

    Args:
        session: 会话 id 或路径片段，留空用最近修改的那个会话。
        index: -1 表示最后一张；0 表示第一张；也可给 1 起的正数。
        output: 目标路径；留空则存到桌面为 user-image-<时间>-<序号>.png。
        overwrite: 目标已存在时是否覆盖。
    """
    located = image_locate(session=session, index=index)
    if not located.get("exists"):
        raise RuntimeError("附件对象不存在：%s" % (located.get("attachmentId") or "(空)"))

    target = output or _default_output(index)
    if os.path.exists(target) and not overwrite:
        stem, ext = os.path.splitext(target)
        counter = 2
        while os.path.exists("%s-%d%s" % (stem, counter, ext)):
            counter += 1
        target = "%s-%d%s" % (stem, counter, ext)

    saved = _save_png(located["path"], target)
    saved.update(
        {
            "sessionId": located["sessionId"],
            "seq": located.get("seq"),
            "attachmentId": located.get("attachmentId"),
            "name": located.get("name"),
        }
    )
    return saved


# --- 技能 -------------------------------------------------------------------


@skill(
    "user-image-path",
    description="用户发来的图片在哪里：不要扫缓存、不要比对特征，读会话记录拿 attachmentId 一步定位。",
    when_to_use="需要把用户贴的图交给 mark / read_image / PIL 处理，或想不起图片存在哪个路径时。",
)
def user_image_path_guide() -> str:
    return """# 用户发来的图片在哪里

## 结论先说

用户贴进对话的图片**有名字、有尺寸、有确定路径**。别去缓存目录里靠特征猜。

三个地方，按可靠性排序：

| 位置 | 内容 | 用途 |
| --- | --- | --- |
| 会话记录 `~/.dsh/sessions/<工作区>/<会话>/session.v4.jsonl.zstd` | `name` / `mediaType` / `width` / `height` / `bytes` / `attachmentId` | **权威来源**，查这里 |
| 附件仓 `~/.dsh/attachments/v1/objects/<hex 前2位>/<hex>` | 原图本体（只读对象） | 真正的像素，画图量坐标用这里 |
| `~/.dsh/cache/attachments/request-images/<hash>` | 发送时转码的副本，尺寸可能被缩小 | 只当参考，**别用来量坐标** |

## attachmentId 就是路径

会话记录里长这样：

```json
{"type": "image", "attachment": {
  "attachmentId": "sha256:43f28e9c524ddc182697e12e26a2cd17f88cab9124dd06e3138a808766e69612",
  "mediaType": "image/png", "name": "image.png",
  "width": 1762, "height": 987, "bytes": 1580199}}
```

换算规则只有一条：去掉 `sha256:`，取前 2 位当目录名，剩下全部当文件名。

```
C:\\Users\\computer\\.dsh\\attachments\\v1\\objects\\43\\43f28e9c524ddc182697e12e26a2cd17f88cab9124dd06e3138a808766e69612
```

## 别做的事

- 不要按文件名找：缓存里是内容哈希，读不出任何信息。
- 不要按尺寸 / 白底占比之类的特征去扫目录筛图：那是抽奖，而且筛到的多半是缩略副本。
- 不要用 `eye` 截自己的屏幕来代替原图：坐标会被窗口缩放带偏。

## 该做的事

用本文件提供的工具：

```
image-locate                        # 最近一张图的元数据 + 绝对路径
image-locate index=1                # 第一张图
image-list                          # 这个会话里所有用户图片
image-save                          # 存成桌面 PNG，返回可直接喂给 mark 的路径
image-save output=D:\\x\\a.png       # 指定路径
```

`image-save` 返回的 `output` 可以原样传给 `mark` 的 `image` 参数，坐标就按这张图
自己的像素算。

## 如果对象不见了

`exists` 为 false 说明附件仓里那个对象已被清理（清缓存/换机器）。这时只能退而求其次：
让用户重新发一次，或者用 `~/.dsh/cache/...` 里的转码副本，但要在回答里说明"这是缩略
副本，坐标精度较低"。
"""


def _doctor() -> int:
    print("dsh home      :", _dsh_home())
    print("sessions root :", _sessions_root(), "exists" if os.path.isdir(_sessions_root()) else "MISSING")
    print("objects root  :", _objects_root(), "exists" if os.path.isdir(_objects_root()) else "MISSING")
    print("desktop       :", DESKTOP, "exists" if os.path.isdir(DESKTOP) else "MISSING")
    try:
        import zstandard  # noqa: F401

        print("zstandard     : ok")
    except ImportError:
        print("zstandard     : MISSING（读不了 .zstd 会话文件，需要 pip install zstandard）")
    try:
        import PIL

        print("pillow        :", PIL.__version__)
    except ImportError:
        print("pillow        : MISSING（image-save 需要它）")
    sessions = _candidate_sessions()
    print("session files :", len(sessions))
    if sessions:
        newest = sessions[0]
        print("newest session:", newest["sessionId"], newest["path"])
        data = _images_in_session(newest["sessionId"])
        print("user images   :", len(data["images"]))
    return 0


def main() -> int:
    if sys.argv[1:2] == ["--doctor"]:
        return _doctor()
    return pytools.main()


if __name__ == "__main__":
    sys.exit(main())
