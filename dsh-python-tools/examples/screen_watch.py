"""示例：一个「会盯着东西」的 Python tool 文件。

它演示了插件最实用的一种组合 —— **有状态、会主动观察** 的 Python 脚本：

- `watch-start` 起一个后台观察者，按间隔给某个文件或目录算指纹，发现变化就把
  事件写进一个小 JSON 状态文件；
- `watch-poll` 让 agent 随时把新事件取走（Python 推，DSH 收）；
- `watch-status` 看观察者还活着没、盯的是哪个路径；
- `watch-stop` 停掉。

位置监控是插件自己的本职工作（文件被移动/改名/删除，插件立刻就知道），而这个
文件演示的是另一层：**被观察对象** 的变化由 Python 负责，通过同一个文件接口
来回传递。

登记：
    pytools install C:\\Users\\computer\\Desktop\\123\\dsh-python-tools\\examples\\screen_watch.py
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import time
from typing import Any, Dict, List, Optional

import pytools_client as pytools
from pytools_client import register, skill

pytools.describe(
    "一个会主动观察文件的 Python tool：起后台观察者、按需取事件、看状态、停掉。",
    tags=["example", "watch", "stateful"],
)

STATE_DIR = os.path.join(
    os.environ.get("PYTOOLS_WATCH_DIR")
    or os.path.join(os.path.expanduser("~"), ".dsh", "python-tools", "state"),
    "screen-watch",
)
STATE_FILE = os.path.join(STATE_DIR, "state.json")
EVENTS_FILE = os.path.join(STATE_DIR, "events.jsonl")
MAX_EVENTS = 500


# ── 状态 ─────────────────────────────────────────────────────────────────────


def _read_state() -> Dict[str, Any]:
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def _write_state(state: Dict[str, Any]) -> None:
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = STATE_FILE + f".{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False)
    os.replace(tmp, STATE_FILE)


def _pid_alive(pid: Any) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        if os.name == "nt":
            out = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            return str(pid) in out.stdout
        os.kill(pid, 0)
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def _fingerprint(target: str) -> Dict[str, Any]:
    """一次轻量的位置 + 内容指纹；目录看直接子项的名字与 mtime。"""
    try:
        stat = os.stat(target)
    except OSError:
        return {"exists": False, "path": target}
    if os.path.isdir(target):
        try:
            entries = sorted(os.listdir(target))
        except OSError:
            entries = []
        digest = hashlib.sha256("\n".join(entries).encode("utf-8")).hexdigest()[:16]
        return {
            "exists": True,
            "kind": "dir",
            "path": target,
            "mtime": stat.st_mtime,
            "entries": len(entries),
            "digest": digest,
        }
    try:
        with open(target, "rb") as handle:
            digest = hashlib.sha256(handle.read()).hexdigest()[:16]
    except OSError:
        digest = ""
    return {
        "exists": True,
        "kind": "file",
        "path": target,
        "size": stat.st_size,
        "mtime": stat.st_mtime,
        "digest": digest,
    }


def _append_event(event: Dict[str, Any]) -> None:
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(EVENTS_FILE, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False) + "\n")
    try:
        with open(EVENTS_FILE, "r", encoding="utf-8") as handle:
            lines = handle.readlines()
        if len(lines) > MAX_EVENTS:
            with open(EVENTS_FILE, "w", encoding="utf-8") as handle:
                handle.writelines(lines[-MAX_EVENTS:])
    except OSError:
        pass


# ── 工具 ─────────────────────────────────────────────────────────────────────


@register(description="后台开始观察一个文件或目录：位置/内容一变就记一条事件", timeout=30)
def watch_start(target: str, interval: float = 2.0, label: str = "") -> Dict[str, Any]:
    """起一个后台观察者（独立的 python 进程），盯住 target。

    Args:
        target: 要观察的文件或目录的绝对路径。
        interval: 检查间隔秒数，0.5..60。
        label: 可选的观察者名字，方便同时观察多个目标。
    """
    absolute = os.path.abspath(os.path.expanduser(target))
    if not os.path.exists(absolute):
        return {"ok": False, "error": f"路径不存在：{absolute}"}
    pause = max(0.5, min(60.0, float(interval)))
    name = label.strip() or hashlib.sha256(absolute.encode("utf-8")).hexdigest()[:8]
    state = _read_state()
    watchers = state.setdefault("watchers", {})
    existing = watchers.get(name)
    if isinstance(existing, dict) and _pid_alive(existing.get("pid")):
        return {
            "ok": True,
            "already": True,
            "label": name,
            "pid": existing["pid"],
            "target": existing.get("target"),
            "message": f"观察者 {name} 已经在跑了",
        }
    kwargs: Dict[str, Any] = {}
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(
            subprocess, "DETACHED_PROCESS", 0
        )
    else:
        kwargs["start_new_session"] = True
    child = subprocess.Popen(  # noqa: S603 —— 参数是本文件自己
        [sys.executable, os.path.abspath(__file__), "--watch-loop", absolute, str(pause), name],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        close_fds=True,
        **kwargs,
    )
    watchers[name] = {
        "pid": child.pid,
        "target": absolute,
        "interval": pause,
        "startedAt": time.time(),
        "python": sys.executable,
    }
    state["watchers"] = watchers
    _write_state(state)
    _append_event({"at": time.time(), "kind": "watcher-started", "label": name, "target": absolute})
    return {
        "ok": True,
        "label": name,
        "pid": child.pid,
        "target": absolute,
        "interval": pause,
        "message": f"观察者 {name}（pid {child.pid}）开始盯着 {absolute}，每 {pause}s 一次",
    }


@register(description="取走观察者新记下的事件（取走即清空，不会重复给）")
def watch_poll(limit: int = 20) -> Dict[str, Any]:
    """把尚未交付的事件取走。

    Args:
        limit: 最多取几条，1..200。
    """
    count = max(1, min(200, int(limit)))
    state = _read_state()
    delivered = int(state.get("delivered", 0))
    events: List[Dict[str, Any]] = []
    try:
        with open(EVENTS_FILE, "r", encoding="utf-8") as handle:
            for index, line in enumerate(handle):
                if index < delivered:
                    continue
                try:
                    events.append(json.loads(line))
                except ValueError:
                    continue
                if len(events) >= count:
                    delivered = index + 1
                    break
            else:
                delivered = max(delivered, index + 1 if "index" in dir() else delivered)
    except OSError:
        pass
    state["delivered"] = delivered
    _write_state(state)
    return {"ok": True, "count": len(events), "events": events, "cursor": delivered}


@register(description="看所有观察者是否还活着、盯的是哪里")
def watch_status() -> Dict[str, Any]:
    """列出观察者的 pid、目标、存活状态。"""
    state = _read_state()
    watchers = state.get("watchers") or {}
    rows = []
    alive = 0
    for name, info in sorted(watchers.items()):
        live = _pid_alive(info.get("pid"))
        alive += 1 if live else 0
        rows.append(
            {
                "label": name,
                "pid": info.get("pid"),
                "alive": live,
                "target": info.get("target"),
                "target_exists": os.path.exists(str(info.get("target") or "")),
                "interval": info.get("interval"),
                "uptime_s": round(time.time() - float(info.get("startedAt", time.time())), 1),
            }
        )
    return {
        "ok": True,
        "state_dir": STATE_DIR,
        "alive": alive,
        "total": len(rows),
        "watchers": rows,
    }


@register(description="停掉一个（或全部）观察者")
def watch_stop(label: str = "") -> Dict[str, Any]:
    """结束观察者进程。

    Args:
        label: 要停的观察者名；留空表示全部停掉。
    """
    state = _read_state()
    watchers = state.get("watchers") or {}
    stopped: List[Any] = []
    for name, info in list(watchers.items()):
        if label and name != label:
            continue
        pid = info.get("pid")
        if _pid_alive(pid):
            try:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, timeout=10)
                else:
                    os.kill(int(pid), 15)
            except (OSError, subprocess.SubprocessError):
                pass
            stopped.append({"label": name, "pid": pid})
        watchers.pop(name, None)
    state["watchers"] = watchers
    _write_state(state)
    _append_event({"at": time.time(), "kind": "watcher-stopped", "count": len(stopped)})
    return {"ok": True, "stopped": stopped, "remaining": len(watchers)}


# ── 后台循环（不是 DSH 工具，是这个文件自己用的子命令） ──────────────────────


def _watch_loop(target: str, interval: float, name: str) -> int:
    previous = _fingerprint(target)
    _append_event({"at": time.time(), "kind": "baseline", "label": name, **previous})
    while True:
        time.sleep(interval)
        current = _fingerprint(target)
        if current != previous:
            changed = []
            for key in set(previous) | set(current):
                if previous.get(key) != current.get(key):
                    changed.append(key)
            _append_event(
                {
                    "at": time.time(),
                    "kind": "changed",
                    "label": name,
                    "fields": changed,
                    "before": previous,
                    "after": current,
                }
            )
            previous = current
        # 观察者自己的登记被删掉了（watch_stop）就自己退出
        state = _read_state()
        if name not in (state.get("watchers") or {}):
            return 0


@skill(
    "watch-guide",
    description="screen_watch.py 的用法：怎样让它盯住一个文件/目录并在变化时把事件交回 DSH",
    when_to_use="需要持续观察某个文件或目录的变化（不是插件自己的位置，而是被观察对象）时",
)
def watch_guide() -> str:
    return """# screen_watch.py · 观察者使用说明

这个文件演示「有状态的 Python tool」：Python 在后台持续工作，DSH 按需取结果。

## 典型流程

1. `watch-start(target="C:/path/to/file", interval=2)` —— 起一个独立的后台 python 进程。
2. 去做别的事。
3. `watch-poll()` —— 取走这期间记下的事件（`changed` / `baseline` / `watcher-started`）。
   取走即清空，不会重复交付；返回里的 `cursor` 就是游标。
4. `watch-status()` —— pid 还活着吗？盯的是哪个路径？目标还在不在？
5. `watch-stop()` —— 结束观察者。

## 和插件自己的位置监控有什么区别

| | 谁在盯 | 盯什么 |
|---|---|---|
| 插件 | DSH Host（fs.watch + 轮询） | **工具文件本身**的位置，决定工具还在不在 |
| 这个文件 | 它自己派生的 python 进程 | **被观察对象**，内容/位置变化当成数据交回 DSH |

两者互不干扰，可以叠着用：先让插件盯住工具文件，再让工具文件盯住业务数据。

## 状态放在哪

`~/.dsh/python-tools/state/screen-watch/`（可用环境变量 `PYTOOLS_WATCH_DIR` 覆盖）。
删掉这个目录等于遗忘所有观察者记录；观察者进程会在下一次循环时自己退出。
"""


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--watch-loop":
        raise SystemExit(_watch_loop(sys.argv[2], float(sys.argv[3]), sys.argv[4]))
    raise SystemExit(pytools.main())
