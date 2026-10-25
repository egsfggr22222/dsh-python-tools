---
name: pytools-offline-protocol
description: Python Tools 调用协议的精确格式（pytools/2：调用帧 / 流帧 / 结果帧 / 常驻会话 / 环境变量），不用 pytools_client 也能对接。
whenToUse: 当需要用别的语言、别的 Python 环境、或手工构造一次调用；或者要调试「工具结果为什么是空的」。
---

# Python Tools 调用协议（协议版本 `pytools/2`）

插件与 Python 之间**只靠文件和管道通信**，没有端口、没有常驻服务、没有依赖包。
看懂这几组文件，就掌握了全部。

> **设计原则：只传指令和数据。**
> 插件不做业务判断，也不为任何具体功能加专用接口；功能差异全部在 Python 那一侧实现。
> 这意味着任何语言、任何解释器，只要能读写这几个文件，就能接上这条神经。

## 一次性调用：四个文件

插件在 `~/.dsh/python-tools/tmp/`（临时目录）里为每次调用创建：

| 文件 | 方向 | 内容 |
|---|---|---|
| `<callId>.call.json` | DSH → Python | 调用帧：工具名 + 参数 |
| `<callId>.stream.log` | Python → DSH | 流帧：追加写的行，边跑边读 |
| `<callId>.result.json` | Python → DSH | 结果帧：最终返回值或错误 |
| `<callId>.reply.json` | DSH → Python | 答复帧：对 `ask` 帧的回答 |
| （stdout/stderr） | Python → DSH | 只用于诊断；stderr 会显示在失败结果里 |

路径通过环境变量告诉 Python 进程：

```
PYTOOLS_CALL_FILE   = .../<callId>.call.json
PYTOOLS_RESULT_FILE = .../<callId>.result.json
PYTOOLS_STREAM_FILE = .../<callId>.stream.log
PYTOOLS_REPLY_FILE  = .../<callId>.reply.json     （可选，有 ask 时才用）
PYTOOLS_CALL_ID     = <callId>
PYTOOLS_HOST        = pytools
PYTOOLS_HOST_VERSION= 2
PYTOOLS_FILE        = <被调用的 .py 的绝对路径>
PYTOOLS_CLIENT_DIR  = <插件目录，pytools_client.py 所在>
```

命令行固定为：

```
python <tool-file.py> __pytools_call__
```

cwd 是 `<tool-file.py>` 所在目录。

## 调用帧（DSH → Python）

```json
{
  "protocol": "pytools/2",
  "callId": "pt_mabc123_x9k2",
  "tool": "add",
  "dshName": "add",
  "arguments": { "a": 1, "b": 2 },
  "file": "C:\\work\\my_tools.py",
  "cwd": "C:\\work",
  "startedAt": 1792503459.93
}
```

`tool` 是 Python 里声明的名字，`dshName` 是它在 DSH 里呈现的名字（重名时可能有前缀）。
`protocol` 为 `pytools/1` 或 `pytools/2` 都接受。

## 流帧（Python → DSH，可选但推荐）

一行一帧，行首标记固定为 `PYTOOLS-FRAME-BEGIN`，后面跟一个 JSON 对象：

```
PYTOOLS-FRAME-BEGIN {"seq":1,"t":1792503459.9,"kind":"progress","payload":{"value":0.5,"message":"一半了"}}
```

| kind | payload | 在结果里显示为 |
|---|---|---|
| `data` | 任意 JSON | `[数据] ...` |
| `notify` | 字符串 | `[通知] ...` |
| `log` | `{"level","message"}` | `[日志/level] ...` |
| `progress` | `{"value":0..1,"message"}` | `[进度] 50% ...` |
| `event` | 任意 JSON | `[事件] ...`（v2 新增：Python 主动反馈） |
| `ask` | `{"id","question","options"?}` | `[提问] ...`（v2 新增，见下） |
| `done` | `{"ok":bool}` | 不显示（只标记结束） |

要求：

- 每帧必须**一行**，写完 `flush()`（用 `buffering=1` 最省事）；
- 顺序即写入顺序，插件按字节偏移增量读取，**已经写入的帧不会丢**，即使工具跑到一半；
- 单次调用最多保留最近 500 帧；这不是日志文件，是反馈通道。

## 提问 / 答复（v2）

Python 需要大脑做决定时，写一条 `ask` 帧，然后轮询 `PYTOOLS_REPLY_FILE`：

```
PYTOOLS-FRAME-BEGIN {"kind":"ask","payload":{"id":"ask_1_ab12","question":"选哪个？","options":["A","B"]}}
```

大脑把答复写到答复帧（原子写）：

```json
{ "askId": "ask_1_ab12", "answer": "A", "at": 1792503460.1 }
```

Python 读到 `askId` 匹配的答复后继续执行，并删除该文件。
**没有答复通道时不要假装问过了** —— 应当直接抛错，让人知道这条路没接上。

## 结果帧（Python → DSH，必须写）

```json
{ "protocol": "pytools/2", "callId": "pt_...", "ok": true,  "value": { "sum": 3 } }
{ "protocol": "pytools/2", "callId": "pt_...", "ok": false, "error": { "type": "ValueError", "message": "x", "traceback": "..." } }
```

- `ok: true` 时，`value` 会原样作为工具结果（会被渲染成可读文本给模型）；
- `ok: false` 时，`error.type` / `error.message` / `error.traceback` 原样呈现；
- 原子写（先写 `.tmp` 再 `os.replace`）可以避免插件读到半个文件；
- 不写结果帧 = 工具失败，插件会报 `NoResultFrame` 并附上 stderr。

## 常驻会话（v2）：`__pytools_serve__`

一次性调用是「起进程、跑一次、退出」。常驻模式让同一个进程连续听指令，
并且**多条指令可以同时执行**、各自回帧：

```
python <tool-file.py> __pytools_serve__
```

**stdin：一行一条指令**

```json
{"id":"1","op":"call","tool":"render","arguments":{"page":1}}
{"id":"2","op":"call","tool":"render","arguments":{"page":2}}
{"op":"reply","askId":"ask_1_ab12","answer":"继续"}
{"op":"ping"}
{"op":"manifest"}
{"op":"shutdown"}
```

`op` 取值：`call` / `ping` / `manifest` / `reply` / `shutdown`（缺省为 `call`）。

**stdout：一行一条回帧**

```json
{"kind":"ready","pid":1234,"protocol":"pytools/2","version":"2.0.0","tools":["render"]}
{"id":"1","kind":"event","payload":{"phase":"start"}}
{"id":"1","kind":"progress","payload":{"value":0.5,"message":"一半"}}
{"id":"2","kind":"ask","askId":"ask_x1","question":"选哪个？","options":["A","B"]}
{"id":"1","kind":"result","ok":true,"value":{...},"durationMs":812}
{"id":"2","kind":"result","ok":false,"error":{"type":"ValueError","message":"..."}}
```

要点：

- 每条回帧都带请求的 `id`，**天然分流、不会串号**；
- 同一个 `id` 可以有多条 `event` / `progress`，最后一条是 `result`；
- 大脑对 `ask` 的答复走 stdin 的 `reply`；
- `shutdown` 后进程退出。

## 声明读取（DSH → Python，登记/热更新时）

| 命令 | 输出 |
|---|---|
| `python <file> --manifest` | stdout 上是完整的清单 JSON（见下） |
| `python <file> --skill <name>` | stdout 上是这个技能的正文 |
| `python <file> --list` | `tool\t名字\t描述` 或 `skill\t名字\t描述`，一行一条（给人看） |
| `python <file> --doctor` | 自检 JSON：解释器、路径、协议、平台、问题清单（v2 新增） |

清单格式：

```json
{
  "protocol": "pytools/2",
  "python": "3.10.11",
  "executable": "C:\\Python310\\python.exe",
  "file": "C:\\work\\my_tools.py",
  "info": { "description": "这个文件是干什么的", "tags": ["..."] },
  "tools": [
    {
      "name": "add",
      "description": "把两数相加",
      "parameters": { "type": "object", "properties": { "a": {"type":"number"}, "b": {"type":"number"} }, "required": ["a","b"] },
      "timeoutMs": 120000,
      "output": null
    }
  ],
  "skills": [
    { "name": "guide", "description": "...", "whenToUse": "...", "path": null, "resources": [] }
  ],
  "warnings": ["声明期发现的问题，逐条读（v2 新增）"]
}
```

只有 `tools[].name` 是必需的。缺 `parameters` 时插件按「任意对象」处理；缺
`timeoutMs` 时用 120 秒。`warnings` 是 Python 侧自己发现的问题（例如注释里的制表符装饰线
会让下一行被吞），插件会原样显示给 agent。

## 不用 pytools_client 的最小实现

```python
import json, os, sys

def main():
    if len(sys.argv) > 1 and sys.argv[1] == "__pytools_call__":
        with open(os.environ["PYTOOLS_CALL_FILE"], encoding="utf-8") as f:
            frame = json.load(f)
        try:
            result = {"protocol": "pytools/2", "callId": frame["callId"],
                      "ok": True, "value": {"tool": frame["tool"], "args": frame["arguments"]}}
        except Exception as error:
            result = {"protocol": "pytools/2", "callId": frame.get("callId"), "ok": False,
                      "error": {"type": type(error).__name__, "message": str(error)}}
        with open(os.environ["PYTOOLS_RESULT_FILE"], "w", encoding="utf-8") as f:
            json.dump(result, f)
        return 0
    if len(sys.argv) > 1 and sys.argv[1] == "--manifest":
        print(json.dumps({
            "protocol": "pytools/2",
            "tools": [{"name": "hello", "description": "示例", "parameters": {"type": "object"}}],
            "skills": [],
        }, ensure_ascii=False))
        return 0
    return 0

raise SystemExit(main())
```

（这份手写版没有 `register()` 的便利，但协议上完全合法 —— 插件对 Python 只认这几条。）

## 失败原因速查

| 现象 | 原因 |
|---|---|
| `登记失败：Python 文件没有输出 manifest` | 没有 `main()`，或顶层抛异常（看 stderr），或顶层在等输入 |
| `ModuleNotFoundError: pytools_client` | 该解释器里没有本库，且工作目录不是插件目录。`pip install -e .` 或加 `PYTHONPATH` |
| `'str' object is not callable` 指向 `def main` | 注释里用了 `─` 制表符装饰线，把下一行并进同一逻辑行 |
| `NoResultFrame` | 写了 `sys.exit()` 才去写结果，或者把写结果的代码放进了 try 的 finally 之外 |
| 结果里没有流帧 | 没 `flush()`，或写的时候用的是块缓冲 |
| `Timeout` | 超过 `@register(timeout=...)`（默认 120 秒）；长任务请拆步或调大 |
| `QueueTimeout` | 并发已满且排队超过 `queueTimeoutMs`（默认 10 分钟） |
| `FileMissing` | 工具文件被删/挪走了，且没能在已知目录里按哈希找回 |
| `ask()` 抛 `RuntimeError` | 这个环境没有 `PYTOOLS_REPLY_FILE`，答复通道未接 |
