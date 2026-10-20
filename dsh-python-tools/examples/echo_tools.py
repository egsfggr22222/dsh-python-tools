"""示例：一个最小可用的 Python tools 文件。

把它登记进 DSH 只需要一次调用：

    pytools install C:\\Users\\computer\\Desktop\\123\\dsh-python-tools\\examples\\echo_tools.py

之后这个文件里的每个 ``@register`` 函数都会变成 DSH 工具，``@skill`` 声明会变成
技能。改了这个文件，工具定义跟着变 —— 不用装包、不用重启、不用重写插件。

它演示了四件事：
1. 类型注解 -> 参数 schema（agent 据此传参）；
2. 返回值 -> 工具结果（dict / list / 标量都行）；
3. ``ctx.emit`` -> 执行中的实时反馈（数据帧、进度、日志，会一起回到结果里）；
4. ``ctx`` 上下文参数 -> 拿到本次调用信息（文件路径、调用 id、DSH 会话）。
"""

from __future__ import annotations

import os
import platform
import random
import sys
import time
from typing import Any, Dict, List, Optional

import pytools_client as pytools
from pytools_client import ToolContext, register, skill

pytools.describe(
    "示例工具集：回声、问候、计算器、流式反馈演示。用来验证 Python Tools 插件是否工作。",
    tags=["example", "demo"],
)


@register(description="原样回传你给的任何 JSON，用来确认 Python 这一端的接口通了")
def echo(payload: Any = None, note: str = "") -> Dict[str, Any]:
    """把 ``payload`` 原样送回，并附上这一次运行的环境信息。

    Args:
        payload: 任何 JSON 值，原样回传。
        note: 一句附注，会跟着结果一起回来。
    """
    return {
        "echo": payload,
        "note": note,
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "where": __file__,
        "now": time.strftime("%Y-%m-%d %H:%M:%S"),
    }


@register(description="按名字和语言说一句问候（演示带默认值的参数）")
def greet(name: str, language: str = "zh") -> str:
    """生成一句问候语。

    Args:
        name: 要问候的对象。
        language: 语言代码，支持 zh / en / ja。
    """
    templates = {
        "zh": f"你好，{name}！",
        "en": f"Hello, {name}!",
        "ja": f"こんにちは、{name}!",
    }
    return templates.get(language, templates["zh"])


@register(description="四则运算（演示结构化参数与结构化返回）")
def calculate(a: float, b: float, op: str = "add") -> Dict[str, Any]:
    """做一次四则运算。

    Args:
        a: 第一个操作数。
        b: 第二个操作数。
        op: add / sub / mul / div 之一。
    """
    if op == "add":
        value = a + b
    elif op == "sub":
        value = a - b
    elif op == "mul":
        value = a * b
    elif op == "div":
        if b == 0:
            raise ZeroDivisionError("除数不能为 0")
        value = a / b
    else:
        raise ValueError(f"不认识的运算 {op!r}（支持 add / sub / mul / div）")
    return {"op": op, "a": a, "b": b, "value": value}


@register(
    description="演示双向数据通道：一边算一边把进度和数据帧推回 DSH，最后给汇总",
    timeout=60,
)
def stream_demo(steps: int = 5, delay: float = 0.2) -> Dict[str, Any]:
    """一边干活一边上报，让 agent 看到 Python 的实时反馈。

    Args:
        steps: 分几步，1..50。
        delay: 每步暂停秒数，0..5。
    """
    ctx = ToolContext.current_context()
    count = max(1, min(50, int(steps)))
    pause = max(0.0, min(5.0, float(delay)))
    total = 0
    for index in range(count):
        total += random.randint(1, 100)
        if ctx is not None:
            ctx.progress((index + 1) / count, f"第 {index + 1}/{count} 步")
            ctx.emit({"step": index + 1, "partial_sum": total}, kind="data")
            ctx.log(f"step {index + 1} 完成", "debug")
        time.sleep(pause)
    if ctx is not None:
        ctx.dsh.notify(f"stream_demo 完成：{count} 步，总和 {total}")
    return {"steps": count, "sum": total, "finished_at": time.time()}


@register(name="where-am-i", description="报告这个 Python 文件此刻的绝对位置（验证位置追踪）")
def where_am_i(ctx: ToolContext) -> Dict[str, Any]:
    """返回本文件的路径、pid 和调用 id —— 用来观察文件被移动后是否自动重新认领。"""
    return {
        "file": __file__,
        "cwd": os.getcwd(),
        "pid": os.getpid(),
        "call_id": ctx.call_id,
        "call_arguments": ctx.call_arguments,
        "dsh_name": ctx.dsh_name,
        "launched_by_dsh": ctx.registered,
    }


@register(description="故意抛异常：验证 Python 的报错与 traceback 会原样回到 agent 手里")
def explode(message: str = "boom") -> None:
    """一定会失败，用来检查错误通道。

    Args:
        message: 附加在异常里的信息。
    """
    raise RuntimeError(f"这是一次受控的爆炸：{message}")


@skill(
    "demo-guide",
    description="如何使用 echo_tools.py 这套示例工具（什么时候用哪个、怎么验证通道）",
    when_to_use="第一次接触 Python Tools，或需要确认 Python 侧调用通道是否正常时",
)
def demo_guide() -> str:
    return """# 示例工具集使用说明

这套工具是 Python Tools 插件的自检工具集，覆盖了调用协议的每一条通路：

| 工具 | 验证什么 |
|---|---|
| `echo` | 参数 JSON 能下去、返回值能上来 |
| `greet` / `calculate` | 类型注解生成的参数 schema 是否正确 |
| `stream-demo` | 执行中的数据帧 / 进度 / 日志能否实时回到结果里 |
| `where-am-i` | 文件位置与调用上下文；把它挪走再调用，观察是否自动重新认领 |
| `explode` | 异常与 traceback 是否原样呈现 |

## 建议的自检顺序

1. `echo` 传一个复杂 JSON（嵌套对象 + 数组），确认原样返回。
2. `calculate` 传 `op="div"`, `b=0`，确认抛出的 `ZeroDivisionError` 出现在结果里。
3. `stream-demo` 传 `steps=3`，确认结果里带着 3 个数据帧和 1 条通知。
4. `where-am-i`，记下路径；用系统文件管理器把 `echo_tools.py` 挪到别的文件夹，
   等两秒，再调用一次 —— 插件会告诉你新位置，并已经在新位置注册好了。
5. 把 `echo_tools.py` 删掉，再调用 `where-am-i`：工具会下线，`pytools list` 会显示缺失。

## 它同时也是模板

写自己的 Python tools 时，直接照抄这个文件的骨架：模块顶部 `import pytools_client`，
每个工具用 `@register`，需要技能就 `@skill`，最后 `if __name__ == "__main__": main()`。
"""


if __name__ == "__main__":
    sys.exit(pytools.main())
