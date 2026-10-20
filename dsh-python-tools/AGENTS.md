# pytools-client —— 神经

> **给之后任何 agent 的话：先读这一页，再动手。你的手（Python）只跟这条神经打交道，
> 而这条神经只传两样东西：**指令**和**数据**。**

---

## 一句话架构

```
   大脑（agent）            神经（pytools 插件 + 本库）            手（你的 .py 文件）
       │                          │                                  │
       │  指令 + 数据             │  只转发，不思考                   │  用任何库做实现
       ├─────────────────────────►├─────────────────────────────────►│
       │                          │                                  │
       │  反馈（进度/事件/提问）   │  只传输，不解析                   │
       ◄─────────────────────────┤◄─────────────────────────────────┤
```

- **大脑**：发指令、给数据、收反馈、决定下一步。不写具体实现。
- **神经**：把指令送进去、把反馈带回来。**不理解业务，不做专用接口。**
- **手**：一个常驻的 Python 进程。用 numpy / pandas / ffmpeg / playwright / 任何库都行。

---

## 30 秒做一个能用的工具文件

把下面这段存成 `my_tools.py`，就是一只接上神经的手。

```python
from pytools_client import register, ToolContext

@register(description="把一段文字变成大写", timeout=30)
def shout(text: str, times: int = 1) -> dict:
    """重复若干次并大写。

    Args:
        text: 要处理的文字。
        times: 重复次数。
    """
    return {"result": (text.upper() + " ") * times}
```

就这些。**不需要** import 其他东西，**不需要**装包，**不需要** `main()`（有更稳，没有也能被调用）。
登记一次：

```
pytools install <这个文件的绝对路径>
```

---

## 常驻会话：让它一直听你指挥

一次性调用是「喊一声、跑一次、进程退出」。要让手一直在线：

```python
# 什么都不用写 —— 本库自带常驻入口
# 插件会用：python my_tools.py __pytools_serve__
```

进程起来后，stdin 一行一条指令，stdout 一行一条回帧：

```json
{"id": "1", "op": "call", "tool": "shout", "arguments": {"text": "hi"}}
{"id": "2", "op": "call", "tool": "shout", "arguments": {"text": "yo", "times": 3}}
{"id": "3", "op": "reply", "askId": "ask_abc", "answer": "用方案 A"}
{"op": "shutdown"}
```

多条指令可以**同时进来**（各自带 `id`），互不串号。这就是「排队多通信」。

---

## 回传反馈：内容由你自己设计

```python
from pytools_client import register, ToolContext

@register(description="跑一个长任务，边跑边汇报")
def long_job(steps: int = 5, ctx: ToolContext = None) -> dict:
    for i in range(steps):
        ctx.progress((i + 1) / steps, f"第 {i+1} 步")          # 进度条
        ctx.event({"step": i + 1, "note": "自定义内容"})        # 普通事件
        ctx.log("处理了一步", "debug")                          # 日志
    answer = ctx.ask("要继续吗？", ["继续", "停止"], timeout=120)  # 问大脑
    return {"answer": answer}
```

| 方法 | 作用 | 会不会阻塞 |
|---|---|---|
| `ctx.progress(v, msg)` | 进度 0..1 | 不 |
| `ctx.event(obj)` | 任意事件（内容你定） | 不 |
| `ctx.log(msg, level)` | 日志 | 不 |
| `ctx.ask(q, options)` | 问大脑并等答复 | **会**（唯一一种） |
| `ctx.dsh.call(tool, args)` | 反向调用 DSH 工具 | 会（需宿主支持） |

---

## 三条硬规矩

1. **只传指令和数据。** 不要为了某个功能让插件加专用接口 —— 功能差异全在你的 Python 文件里实现。
2. **不要依赖插件注入的路径。** 本库会自己找到自己的位置，但你的工具文件**必须**在任何工作目录下都能 `import pytools_client`。
3. **不要在模块顶层做重活。** 插件读声明时会等你的文件 import 完成，超过 20 秒算超时。

---

## 常见错误对照表

| 症状 | 真正原因 | 修法 |
|---|---|---|
| `ModuleNotFoundError: pytools_client` | 解释器里没有本库，且工作目录不是插件目录 | 装一次：`pip install -e .`，或把本目录加进 `PYTHONPATH` |
| 报 `'str' object is not callable` 指向 `def main` | 注释里用了 `# ─── 标题 ───` 装饰线，把下一行并进了同一逻辑行 | 换成 `# --- 标题 ---` |
| 同上，或 `TypeError` 出现在 `@skill(..., body=...)` 那行 | `body=` / `path=` 形式是「直接登记」，返回 `None`，不能加 `@` | 去掉 `body=`，把正文放在函数里 `return` |
| 工具没出现 | 没有 `@register`，或工具名不合法 | 用 `python your_tools.py --list` 自查 |
| 参数表里缺参数 | 参数注解是自定义类且无默认值 | 加类型注解或默认值；上下文参数命名为 `ctx` / `context` |
| 一直排队 / 超时 | 并发上限满了 | 用常驻会话，把多条指令带不同 `id` 一起发 |
| 改了文件但工具没变 | 文件语法错误，热重读失败 | `python your_tools.py --manifest` 看报错 |
| 想知道环境到底怎么了 | —— | `python your_tools.py --doctor` |

---

## 自检

```bash
python your_tools.py              # 名片：有哪些工具/技能
python your_tools.py --list       # 一行一条
python your_tools.py --manifest   # 插件读的清单
python your_tools.py --doctor     # 解释器 / 路径 / 协议 / 平台 / 问题清单
python your_tools.py __pytools_serve__   # 常驻会话
```

---

## 详细文档

- 写文件：`skills/pytools-authoring.md`
- 协议格式（不用本库也能对接）：`skills/pytools-offline-protocol.md`

这两份都注册成了技能，直接 `skill("pytools-authoring")` 就能加载。
