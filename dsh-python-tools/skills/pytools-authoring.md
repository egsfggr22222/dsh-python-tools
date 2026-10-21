---
name: pytools-authoring
description: 如何写一个 Python tools 文件（用 pytools_client 声明工具与技能），以及登记/更新/移动它时会发生什么。
whenToUse: 当用户想要新的能力、想脚本化一件事、需要写/改一个 .py 工具文件，或者需要理解某个 Python 工具为什么不工作时。
---

# 写一个 Python tools 文件

> 记住架构：**大脑（agent）下指令、给数据；神经（插件）只转发；手（你的 .py）用任何库实现。**
> 你要写的永远是「手」这一侧：一个普通的 Python 文件。

## 最小可用文件

```python
from pytools_client import register

@register(description="把两数相加")
def add(a: int, b: int) -> dict:
    """返回和。

    Args:
        a: 第一个数
        b: 第二个数
    """
    return {"sum": a + b}

if __name__ == "__main__":
    from pytools_client import main
    raise SystemExit(main())
```

三件事缺一不可：

1. 模块顶部 `import pytools_client`（或 `from pytools_client import register, main`）。
2. 每个工具用 `@register` 声明。
3. `if __name__ == "__main__": main()` —— 插件读取声明和执行调用都靠这个入口。
   **没有它，文件能 import，但插件永远读不到你的工具，也不会报错**（最容易踩的坑）。

## `pytools_client` 从哪来

v2 起有三种方式，**任选其一**即可，不再依赖插件注入环境变量：

| 方式 | 做法 |
|---|---|
| 已安装（推荐） | `pip install -e <插件目录>` 或 `pip install pytools-client` |
| 系统级路径 | 把插件目录放进 `site-packages` 的 `.pth` |
| 自带兜底 | 本库 import 时会自己查找 `PYTOOLS_CLIENT_DIR` / `PYTHONPATH` / `~/.dsh/python-tools` |

在任何解释器、任何工作目录下都能 `import pytools_client`。不确定时跑：

```bash
python your_tools.py --doctor
```

## 参数 schema 是怎么来的

`@register` 会从三处推导 JSON Schema，优先级从低到高：

1. 类型注解：`int` / `float` / `str` / `bool` / `list[str]` / `dict[str, int]` / `Optional[...]` / `X | Y`；
2. docstring 里的 `Args:` 段（写成 `:param name: ...` 也可以）；
3. `@register(parameters={"a": {...}}, schema={...})` 手写覆盖。

有默认值的参数不要求必填。想让某个参数**不出现在 schema 里**（比如给函数一个上下文），
把参数注解成 `ToolContext`，或者命名为 `ctx` / `context` 且不给默认值：

```python
from pytools_client import ToolContext, register

@register(description="报告本文件位置")
def where(ctx: ToolContext) -> dict:
    return {"file": ctx.file, "call_id": ctx.call_id, "dsh_name": ctx.dsh_name}
```

### 注解兼容性（3.8 ~ 3.13）

下面这些写法在 3.8 下也**同样可用**，不需要为了兼容而改写：

```python
def f(a: int | None = None, b: list[str] | None = None, c: Optional[dict] = None) -> dict: ...
```

（前提是文件里有 `from __future__ import annotations`；没有也没关系，本库对字符串注解做了安全解析，
**不会** eval 任何表达式。）

## 返回值

任何 JSON-able 的值都行：标量、列表、字典；dataclass（自动调 `to_dict` / `_asdict` / `model_dump`）、
namedtuple、bytes（按 UTF-8 或 base64）也都能自动转。返回值会原样出现在工具结果里。

抛异常不用怕：异常类型、消息和 traceback 会原样回到 agent 手里，是最快的调试方式。

## 边跑边回话（双向通道）

```python
from pytools_client import ToolContext, register

@register(description="分步处理并实时上报")
def slow(steps: int = 5, ctx: ToolContext = None) -> dict:
    for i in range(steps):
        ctx.progress((i + 1) / steps, f"第 {i + 1} 步")   # 进度
        ctx.event({"step": i + 1})                         # 普通事件（内容你定）
        ctx.log("处理了一步", "debug")                     # 日志
    choice = ctx.ask("要继续吗？", ["继续", "停止"])      # 问大脑，阻塞等答复
    ctx.dsh.notify("做完了")                               # 一句话提醒
    return {"steps": steps, "choice": choice}
```

| 帧 | 作用 | 阻塞 |
|---|---|---|
| `ctx.emit(x)` / `ctx.event(x)` | 任意数据 / 事件 | 否 |
| `ctx.progress(v, msg)` | 进度 0..1 | 否 |
| `ctx.log(msg, level)` | 日志 | 否 |
| `ctx.ask(q, options)` | 向大脑提问并等答复 | **是** |
| `ctx.dsh.call(tool, args)` | 反向调用 DSH 工具 | 是（需宿主支持） |

逐帧写进流文件并 `flush`，agent 边跑边能看到，不是等进程结束才给。

## 常驻会话（让手一直听指挥）

一次性调用 = 起进程、跑一次、退出。要连续听指令，让进程常驻：

```bash
python your_tools.py __pytools_serve__
```

stdin 一行一条指令，stdout 一行一条回帧；多条指令**可以同时进来**，各带 `id`，互不串号：

```json
{"id": "1", "op": "call", "tool": "render", "arguments": {"page": 1}}
{"id": "2", "op": "call", "tool": "render", "arguments": {"page": 2}}
{"id": "3", "op": "reply", "askId": "ask_ab12", "answer": "继续"}
{"op": "shutdown"}
```

你的工具函数**不需要为常驻模式改一行代码**：`ctx` 会自动走 stdout 回帧。

## 反向申请（让 Python 主动找大脑）

上面那些都是「大脑调你」。要反过来 —— 你在跑的时候出了事想告诉大脑 —— 用这几个
申请接口。

**它们只写一个申请文件，不直接动手。** 插件读到后转交给 DSH，由 DSH 决定怎么做。
插件本身不主动做任何事。

```python
from pytools_client import interrupt, send_message, notify

send_message("黑板那边来了一句：通俗点", interrupt=True)  # 打断当前轮次，立刻插话
interrupt("用户点了停止")                                  # 只中止当前轮次
send_message("长任务跑完了")                                # 排到下一轮，不打断
notify("弹一条给用户看的提醒")                             # 不进对话，只提醒
```

| 函数 | 插件转成什么 | 效果 |
|---|---|---|
| `interrupt(reason)` | `agent.cancel(cause, {keepInbox})` | 中止当前轮次，保留待处理项 |
| `send_message(text)` | `agent.followup(input)` | 排到下一轮 |
| `send_message(text, interrupt=True)` | `agent.steer(input)` | **打断最近一步，立即插话** |
| `notify(text)` | `agent.steer(input)` | 同上，语义是提醒 |

申请写在 `~/.dsh/python-tools/requests/<你的文件名>.jsonl`，一行一条。

### 什么时候用

- 用户在窗口里说了话 → `send_message(text, interrupt=True)`，大脑会立刻停下来看
- 你自己的任务被中止了 → 不需要你管，插件会通知（见下一节）
- 长任务跑完了 → `send_message(text)`，排到下一轮

### 注意

- 这是**申请**，不是保证。没人在听的时候（比如大脑已经停了）申请就放那儿。
- 申请只在**本次插件运行期间**被读一次；插件重启时旧申请会被跳过，不会重放。

## 跟随终止（大脑停下时通知你）

长驻进程（窗口、订阅、后台服务）自己感知不到「用户把大脑停了」。声明一下，
大脑每轮结束时插件就会跑一次：

```python
from pytools_client import follow_lifecycle, lifecycle_event

follow_lifecycle()          # 在模块顶层声明

def main() -> int:
    if lifecycle_event() == "agent-idle":
        # 大脑停了：自己收尾。注意这是【新进程】，
        # 要影响正在跑的服务，得靠文件 / HTTP 这类进程间方式。
        return 0
    return real_main()
```

触发时机：正常答完、用户点停止、出错终止 —— 三种都算 `idle`。

## 通用小工具

这些是每个工具都要写的麻烦事，插件直接给了：

| 函数 | 作用 |
|---|---|
| `state_dir(name="")` | 统一的 `~/.dsh/python-tools/state/<名>/`，已创建 |
| `read_json(path)` / `write_json(path, data)` | 原子读写 JSON |
| `read_lines(path)` / `append_line(path, item)` | JSONL 读写 |
| `pid_alive(pid)` | 进程还活着吗 |
| `spawn_background(argv, log=...)` | 起一个脱离的常驻进程，返回 pid |
| `kill_process(pid)` | 精确杀一个进程，确认它真的没了 |
| `file_stamp(path)` | 文件 mtime；不存在就是 0 |
| `watch_file(path, on_change, should_stop=...)` | 盯文件变化（自建线程用） |
| `wait_until(check, timeout=...)` | 等一个条件成立 |

`state_dir()` 不传名字就用文件名，两个工具不会抢同一个目录。

## 技能

```python
from pytools_client import skill

# 写法一：装饰器（正文来自函数返回值）
@skill("查表规范", description="何时查表、怎么查、查完怎么记", when_to_use="涉及价格表时")
def guide() -> str:
    return "# 查表规范\n\n..."

# 写法二：直接给正文 —— 注意这里【不能】加 @
skill("团队约定", description="...", body="# 内容\n...")
skill("另一个技能", description="...", path="docs/team.md")
```

**`body=` / `path=` 形式会直接登记并返回 `None`。** 如果写成 `@skill(..., body="...")`，
Python 会报 `TypeError: 'str' object is not callable`。v2 会额外打印一条明确的 WARN 告诉你正确写法。

技能正文在需要时才被取（`python <file> --skill <name>`），所以改了 markdown 就立刻生效。

## 多工具的命名

- 一个文件里可以有任意多个工具；名字默认是函数名的 kebab-case（`get_time` → `get-time`），
  用 `@register(name="...")` 覆盖。
- 两个文件出现同名工具时，后登记的那个会被自动改名成 `<文件名>--<工具名>`，不会覆盖前一个。
- 工具名必须匹配 `^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$`。
- **技能名也必须是这套 kebab-case （英文）**。DSH 会校验技能名，中文名会被拒：
  `invalid skill name "黑板作画"`。中文只能放在 `description` 和正文里。

## 登记、更新、移动

| 动作 | 怎么做 | 会发生什么 |
|---|---|---|
| 登记 | `pytools install <绝对路径>` | 读声明、注册工具与技能、开始盯位置，并持久化到重启之后 |
| 改代码 | 直接保存文件 | 插件用 fs.watch + 轮询发现 mtime/size 变化，自动重读声明（热更新） |
| 移动/改名 | 用资源管理器或 `mv` | 插件发现原路径没了，按**内容哈希**在新位置认领，并在下一轮对话里报告新路径 |
| 删除 | 删掉文件 | 工具与技能下线，`pytools list` 显示「不在原位置」，仍在继续找 |
| 撤销登记 | `pytools remove <路径>` | 只下线，不碰文件 |
| 只读试读 | `pytools probe <路径>` | 看一个文件声明了什么，不登记 |

想加搜索范围（文件可能被移到别的盘），在 `install` / `relocate` 时传 `watch: ["D:/projects"]`。

## 并发

同一个文件里的多个工具调用**可以同时跑**，插件会排队而不是直接拒绝：

- 并发上限默认 8（配置项 `maxConcurrent`）；
- 满了就排队等空位，不是立刻报 Busy；排队超过 `queueTimeoutMs`（默认 10 分钟）才算超时；
- 每个调用一条独立流通道，进度/事件按 `callId` 分流，不串号。

需要长时间连续交互时，用常驻会话比反复调用更划算。

## 约定与坑

- **不要在模块顶层做重活**：导入时插件就在等你的声明，超过 20 秒会被判超时。
- **stdout 留给协议**：`--manifest` 时模块顶层的 `print()` 会污染清单输出。调试请用 `ctx.log` 或 stderr。
- **相对路径按文件所在目录（cwd）解析**：插件用文件所在目录作为进程工作目录。
- **注释里不要用 `─ │` 这类制表符画装饰线**：它们会把下一行并进同一逻辑行，
  让后面的 `def` 缩进错位，最后报出和真实原因无关的 `'str' object is not callable`。
  用 `# --- 标题 ---`。v2 会在声明时直接 WARN 你。
- **别把 `main` 这个名字遮蔽**：`from pytools_client import main` 之后再定义 `def main()` 会互相覆盖。
  要么用 `import pytools_client` 然后 `pytools_client.main()`，要么给自己换个名字。
- **需要第三方库**：用跑得起来的那个解释器（`@register` 不受影响，调用时才需要库）；
  想指定解释器就 `pytools install <路径> pythonPath="C:/Python312/python.exe"`（v2 起它真的会优先使用）。
- **超时**：默认 120 秒；`@register(timeout=600)` 可以抬高（上限 1 小时）。
- **状态放哪**：`~/.dsh/python-tools/` 是插件自己的目录（注册表、临时帧）；
  你自己的文件可以随便放，但别把临时文件堆在那里。

## 自检

```bash
python your_tools.py                    # 打印名片：有哪些工具/技能
python your_tools.py --manifest         # 插件读的清单
python your_tools.py --list             # 一行一条
python your_tools.py --skill <name>     # 某个技能的正文
python your_tools.py --doctor           # 解释器 / 路径 / 协议 / 平台 / 问题清单
python your_tools.py __pytools_serve__  # 常驻会话
```

如果 `--manifest` 里出现 `warnings`，逐条读：那是本库在声明期就发现的问题，通常就是失败原因。
