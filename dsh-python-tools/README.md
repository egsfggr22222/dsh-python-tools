# Python Tools（DSH 插件）

**这个插件自己没有功能。** 它只做简单的一件事，让 Python 文件变成 DSH 的工具和技能。

任何一个 `.py` 文件，调用一次 `pytools_client.register()` 就向 DSH 声明了工具；
插件记住这个文件的位置，随时调用它注册的接口，接收它回传的数据和反馈，并实时监控
它的位置——文件被移动、改名，插件立刻感知新位置。

```
你写一个 .py  ──pytools install──►  插件记住位置 ──► 每个 register() 的函数变成 DSH 工具
                                                   └► 每个 skill() 变成技能
         ▲                                                  │
         └──────────── JSON 参数下去 / 数据帧·结果帧回来 ◄────┘
```

## 它能给 DSH 装上什么

插件只是一条通道。通道通着，**Python 生态里的东西能变成 DSH 的工具**。

具体说，装上它之后，DSH 可以：

### 看见

| 能力 | 靠什么 | 效果 |
|---|---|---|
| 读图片、视频帧 | `opencv-python`、`Pillow` | 定位、测量、比对、抽帧 |
| 物体/人脸/文字识别 | `opencv` / `ultralytics(YOLO)` / `paddleocr` | 拿到框、类别、置信度、文字 |
| 文档解析 | `pymupdf`、`python-docx`、`openpyxl` | PDF/Word/Excel 里有什么、在哪一页 |
| 看图作业 | 任意 | 比如「这张截图里的按钮坐标是多少」 |

### 计算与数据

| 能力 | 靠什么 | 效果 |
|---|---|---|
| 表格分析 | `pandas`、`polars` | 读几百万行、分组、聚合、找异常 |
| 数值计算 | `numpy`、`scipy` | 矩阵、拟合、优化、信号处理 |
| 机器学习 | `scikit-learn` | 分类/回归/聚类，出模型和指标 |
| 可视化 | `matplotlib`、`plotly` | 直接存图，agent 拿路径就能看 |
| 爬取与接口 | `requests`、`httpx`、`playwright` | 抓数据、走登录、调 API |

### 训练模型（这一点值得单独说）

长任务不是「一次调用干到底」，而是拆成三个工具，agent 像看进度条一样盯着：

```python
@register(description="启动训练，立刻返回")
def train_start(config: dict) -> dict:
    ...  # 起后台进程，写状态文件
    return {"job": job_id}

@register(description="查训练进度")
def train_status(job: str) -> dict:
    return {"epoch": 12, "loss": 0.043, "done": False}

@register(description="中止训练")
def train_stop(job: str) -> dict: ...
```

DSH 就能：起点 → 每几秒查一次 → loss 不动了立刻停 → 拿最终权重跑评估。
中间还能用 `ctx.emit()` 把每轮指标实时推回来。

GPU、CUDA、多卡都无所谓——那是 Python 那端的事，插件不碰。

### 控制真实世界

| 能力 | 靠什么 | 效果 |
|---|---|---|
| 控制桌面程序 | `pyautogui`、`pywinauto`、`uiautomation` | 点按钮、填表单、读控件树 |
| 操作硬件 | `pyserial`、`pymodbus` | 串口、PLC、传感器 |
| 播报与出声 | `pyttsx3`、Windows TTS | 把结果念出来 |
| 长驻服务 | 任意 | 本地 HTTP 服务、后台观察者、定时任务 |
| 调 DSH 的其它工具 | `ctx.call()` | **反向调用**：Python 里让 DSH 去读文件、跑命令 |
| 反问用户 | `ctx.ask()` | 跑到一半需要人来判断，直接问，等答复 |

### 已经跑通的实例

| 项目 | 做了什么 |
|---|---|
| **blackboard** | 一个能画的窗口：14 个工具驱动无边框画布、逐帧动画、讲解进度、问答、归档 |
| **whale host** | 字幕 + 语音 + 目录探测：Qt 悬浮窗、离线 TTS、逐字节奏控制、树形地图 |
| **probe-tree** | 先摸清目录体量和结构，让 agent 避开大文件、不浪费上下文 |

所以这个插件的意义是Python 生态扩展到dsh。

写完一个 `.py`、登记一次，立刻生效，不用重启、不用改插件代码。

## 一分钟上手

```python
# my_tools.py
import os
from typing import Any, Dict

from pytools_client import register, main


def _human(size: int) -> str:
    if size < 1024:
        return "%dB" % size
    value = float(size)
    for unit in ("KB", "MB", "GB"):
        value /= 1024
        if value < 1024:
            return "%.1f%s" % (value, unit)
    return "%.1fTB" % (value / 1024)


@register(description="探测目录：返回树形结构，每个文件带大小，每个文件夹带其下所有文件的总大小。")
def probe_tree(path: str = ".", max_depth: int = 3) -> Dict[str, Any]:
    """给一个目录拍一张「体量地图」。

    Args:
        path: 要探测的目录。
        max_depth: 展开到第几层。
    """
    root = os.path.abspath(os.path.expanduser(path))
    if not os.path.isdir(root):
        return {"ok": False, "error": "不是目录：%s" % root}

    lines = []
    total_files = 0

    def walk(current: str, depth: int, prefix: str) -> int:
        nonlocal total_files
        size_sum = 0
        try:
            entries = sorted(os.scandir(current),
                             key=lambda e: (not e.is_dir(follow_symlinks=False), e.name.lower()))
        except OSError:
            return 0
        for index, entry in enumerate(entries):
            last = index == len(entries) - 1
            mark = "└─ " if last else "├─ "
            try:
                if entry.is_dir(follow_symlinks=False):
                    # 先把子项收下来，拿到汇总后再一起输出，
                    # 不然子项会跑到父项前面去。
                    before = len(lines)
                    sub = walk(entry.path, depth + 1, prefix + ("   " if last else "│  "))
                    size_sum += sub
                    child = lines[before:]
                    del lines[before:]
                    lines.append("%s%s%s/  %s" % (prefix, mark, entry.name, _human(sub)))
                    lines.extend(child)
                elif entry.is_file(follow_symlinks=False):
                    size = entry.stat(follow_symlinks=False).st_size
                    size_sum += size
                    total_files += 1
                    lines.append("%s%s%s  %s" % (prefix, mark, entry.name, _human(size)))
            except OSError:
                continue
        return size_sum

    total = walk(root, 1, "")
    return {
        "ok": True,
        "path": root,
        "total_human": _human(total),
        "file_count": total_files,
        "tree": "\n".join(lines) or "(空目录)",
    }


if __name__ == "__main__":
    raise SystemExit(main())
```

然后对 agent 说一句：`pytools install C:\path\my_tools.py`。

`probe_tree` 立刻成为一个可以像内置工具那样调用的 DSH 工具：参数 schema 从类型注解和
docstring 推导，返回值原样回到 agent 手里。**不用装包、不用写插件代码、不用重启。**

调用它会得到一张树形的目录地图 —— 每个文件带大小，每个文件夹带它下面所有文件的总和，
agent 拿这张图就能精确定位有价值的文件、避开大文件。

## 它解决了什么

| 以前 | 现在 |
|---|---|
| 想要新能力 → 写一个 Cordis 插件 → 安装 → 重启 | 写一个 `.py` → `pytools install` 一次 |
| Python 脚本要靠 shell 拼命令行、解析 stdout | 函数直接成为工具，参数是 JSON，返回值是结构化数据 |
| 长任务只能等它跑完 | 边跑边用 `ctx.emit()` 推数据/进度/日志，实时回到结果里 |
| 文件挪走了，工具静默失效 | 插件按内容哈希找回新位置，自动重新注册并通知 agent |
| 改了代码要重新安装 | 保存即热更新，声明变化自动重读 |
| 长工具一跑就没法停，点停止要干等 | 取消信号直达子进程，当场 SIGKILL、立刻返回 |

## 四个核心能力

### 1. 注册工具

```python
@register(description="...")
def my_tool(a: int, b: str = "x") -> dict:
    ...
```

`register` 也支持直接调用形式 `register(fn, description=...)`、自定义名字
`name="kebab-case"`、手写 schema `schema={...}`、逐步覆盖 `parameters={...}`、
超时 `timeout=600`。

参数 schema 推导顺序：类型注解 → docstring 的 `Args:` 段 → 手写覆盖。
拿 `ToolContext` 参数不会出现在 schema 里，那是给函数拿上下文的。

### 2. 注册技能

```python
@skill("查表规范", description="何时查表、怎么查", when_to_use="涉及价格表时")
def guide() -> str:
    return "# 查表规范\n..."
```

也可以 `skill("名字", description="...", path="docs/x.md")` 指向文件。技能正文按需读取
（`python file.py --skill <name>`），改了 markdown 就立刻生效。

### 3. 双向数据通道

数据能下去，反馈能上来：

```python
@register(description="分步处理并实时上报")
def process(ctx: ToolContext, n: int = 10) -> dict:
    for i in range(n):
        ctx.progress((i + 1) / n, f"第 {i + 1} 步")   # 进度
        ctx.emit({"partial": i})                      # 数据帧
        ctx.log("ok", "debug")                        # 日志
    ctx.dsh.notify("完成了")                          # 面向人的一句话
    return {"n": n}
```

这些帧是**即时**写进流文件的（行缓冲 + flush），插件边跑边读——一个跑 30 秒的工具，
中途推的数据不会等到结束才出现。

### 4. 位置监控（这是插件的本职工作）

- **移动 / 改名** → 原路径消失，插件按**内容哈希**在已知目录里找回来，认领新位置、
  保留历史（调用次数、安装时间、备注），并在下一轮对话里告诉 agent 新旧路径。
- **删除** → 工具与技能下线，`pytools list` 显示缺失；文件放回来就自动恢复。
- **修改内容** → 热更新：重读声明、按需重注册，不用重装。
- **双重保险** → `fs.watch` 事件 + 定时轮询（默认 1.5 s），漏一个也还有另一个。

搜索范围默认是「所有已知文件所在目录」；文件可能被挪到别处时传
`watch: ["D:/projects"]` 加根目录。判定只看**内容哈希一致**，不会把同名但内容不同的
文件误认成同一个。

## `pytools` 工具

| action | 作用 |
|---|---|
| `install` | 登记一个 `.py`（读声明、注册工具与技能、开始盯位置、持久化） |
| `list` | 已登记文件、位置状态、工具/技能、移动历史 |
| `probe` | 只读地看一个文件声明了什么，不登记 |
| `relocate` | 立刻全量核对位置（平时自动做，这是手动兜底） |
| `inspect` | 一个文件或全部文件的详情 |
| `remove` | 撤销登记（只下线，不碰文件） |

参数：`path`、`pythonPath`（指定解释器）、`label`（短名，用于防重名）、`note`、`watch`。

## 文件构成

```
dsh-python-tools/
├── index.js                       Host 半边：注册表、监视器、调用桥、工具与技能注册
├── cordis.patch.yml               装载补丁（一行 insert）
├── pytools_client.py              ★ Python 声明库（register / skill / ToolContext）
├── skills/
│   ├── pytools-authoring.md       写 Python tools 的规范（agent 会看到）
│   └── pytools-offline-protocol.md 精确的帧格式与协议
├── examples/
│   ├── echo_tools.py              最小示例：回声 / 问候 / 计算 / 流式反馈 / 报错
│   └── screen_watch.py            有状态示例：后台观察者 + 按需取事件
├── tools/protocol-test.mjs        不装 DSH 也能验证一个文件的协议实现
└── icon.svg, README.md
```

## 能力边界（程序设计时先读这一节）

上面那些都能做，但底下是一套**进程模型**。不理解它，会写出跑不动的工具。

### 模型：一次调用 = 一个新进程

```
DSH 调工具
   └─► spawn 一个全新的 python 解释器
         └─► import 你的文件 → 调那个函数 → 写结果文件 → 进程结束
```

这意味着：

| 后果 | 含义 |
|---|---|
| 没有跨调用内存状态 | 上次调用的全局变量下次就没了。状态写文件，或拉起常驻进程 |
| 每次都要重新 import | 顶层 `import torch` 就是每次十几秒，直接撞上超时 |
| 进程启动是固有开销 | 空转一次约 20–30ms；这决定了你不适合做每秒几百次的小调用 |

**这影响你的接口粒度。** 别把「点一下、查一下、再点一下」拆成十几个工具调用，
要把一段完整工作封装成一个工具，只把关键节点暴露出去。

### 硬数字（代码里的真实默认值）

| 项 | 值 | 位置 |
|---|---|---|
| 单次调用超时 | **120 秒** | `@register(timeout=秒)` 可改 |
| 读声明的预算 | **20 秒** | 顶层代码慢就失败 |
| 同时运行的调用 | **8** | `config.maxConcurrent` |
| 排队等超时 | **10 分钟** | `config.queueTimeoutMs` |
| 结果帧 | **8 MB** | 超了就传不回来 |
| 流帧 | 保留最近 **500** 帧 | 高频 `emit` 会丢掉早的 |

### 取消与停止

用户点「停止」或在对话里打断时，DSH 会把取消信号（`exec.signal`）交给工具。插件收到后
**立刻 SIGKILL 掉这次调用的 python 子进程**，调用当场返回 `ABORTED`，不等它自己跑完。

这件事必须做对，否则界面会「卡住」：DSH 的取消语义是**已经开始的工具体不会被丢弃，
必须等它 settle 之后才把结果标成 aborted**。插件如果无视信号，停止按钮就只能干等——
一个 `timeout=600` 的工具足以让停止卡十分钟。

| 行为 | 说明 |
|---|---|
| 收到取消 → 杀子进程 | 硬杀（SIGKILL），python 侧没有 `finally` 机会，可能留下半截文件 |
| 常驻服务不受影响 | `spawn_background()` 起的独立进程（字幕窗口、黑板窗口）不在这棵进程树里，不会被误杀 |
| 排队中的调用 | 还没抢到并发槽位时要等抢到才退——信号暂时没接进排队循环 |
| 工具自己的善后 | 需要清理就写状态文件，别指望被杀之前还能跑代码 |

所以：**有必须收尾的资源（临时文件、子进程、锁）的工具，要做成常驻服务 + 显式 stop
工具**，不要靠单次调用里的 `finally`。

### 重型库怎么放

```python
# 不好：每次读声明都等它加载，容易超时；每次调用也重新加载
import torch

# 好：声明秒出，用到才加载
def predict(...):
    import torch
    ...
```

模型反复加载也确实慢。如果调用频繁，要么缓存到模块级变量（同一进程内复用），
要么写成常驻服务（见下一节）。

### 场景：监督训练

训练是个跑几十分钟的长任务，不能写成 `train(epochs=100)` 然后干等——超时只是小事，
真正的问题是中途无法干预。

正确的形态是**常驻进程 + 状态文件**：

```python
@register(description="启动训练，立刻返回")
def train_start(config: dict) -> dict:
    # 起后台进程；把 config 写成文件，训练循环每轮重读
    return {"job": job_id, "pid": pid}

@register(description="查进度")
def train_status(job: str) -> dict:
    return {"epoch": 12, "loss": 0.043, "lr": 3e-4, "done": False}

@register(description="改训练参数（下一轮生效）")
def train_adjust(job: str, lr: float = 0) -> dict:
    # 改 config 文件，训练循环下轮读
    return {"ok": True}

@register(description="中止并保存权重")
def train_stop(job: str) -> dict: ...
```

DSH 就能：启动 → 每几秒查一次 → loss 不降了调小 lr → 出现 NaN 立刻停 → 拿最新权重跑评估。

GPU / CUDA / 多卡都无所谓——那是 Python 那端的事，插件不碰。

### 场景：爬虫

直接写就行，没什么特殊：

```python
@register(description="抓一个页面")
def fetch(url: str) -> dict:
    import requests
    ...
```

现实中的卡点不在插件：

| 卡点 | 应对 |
|---|---|
| 反爬 / 频率限制 | 控制节奏、换 IP，这是爬虫本身的活 |
| 需要登录 | playwright 存 cookie；或 `ctx.ask()` 让人手动登一次 |
| 页面很大 | 结果帧 8MB 封顶——原文写盘，只返回路径 |
| 全站爬 | 单次超时 120 秒——分批，或做成常驻任务 |

### 场景：长驻服务

`whale host/talk.py` 是现成例子：工具调用只写一行请求到 `inbox.jsonl` 就返回，
常驻的 Qt 进程每 40ms 轮询处理。字幕、语音、动画都能这样。

其它用法：本地 HTTP 服务、文件监听、定时任务、模型服务。

### 双向调用

Python 不只能被动等调：

```python
ctx.emit({"partial": x})          # 推数据帧
ctx.progress(0.5, "一半了")        # 进度
ctx.log("debug", "...")          # 日志
ctx.dsh.notify("跑完了")           # 弹给用户看
ctx.call("ops_grep", {...})       # 反过来调 DSH 的工具
answer = ctx.ask("继续吗？", ["是", "否"])   # 向用户提问并等答复
```

`ctx.ask()` 会阻塞等用户回答（默认 300 秒）。适合「跑一半需要人拍板」的场合。

### 一句话总结

> 它快不快，不取决于数据量，而取决于**你切了几刀**。
> 一刀切得够大，它就是接近原生的；切得太碎，时间全花在 `python.exe` 启动上。

## 数据放在哪

`~/.dsh/python-tools/`（可用 `DSH_HOME` 改根目录）：

| 路径 | 内容 |
|---|---|
| `registry.json` | 已登记文件：路径、状态、声明、移动历史、调用统计 |
| `registry.apply-backup.json` | 上一版注册表（坏文件能救回来） |
| `tmp/<callId>.*` | 一次调用的调用帧 / 流帧 / 结果帧，用完即删 |

参数帧可能含敏感内容，所以调用结束立刻删除，只留下不需要保密的流帧和结果。

## 协议速览

一次调用只有四个文件（详见技能 `pytools-offline-protocol`）：

```
python <file> __pytools_call__      ← 环境变量指出帧在哪
  PYTOOLS_CALL_FILE    调用帧（工具名 + 参数 JSON）
  PYTOOLS_STREAM_FILE  流帧（Python 追加，插件增量读）
  PYTOOLS_RESULT_FILE  结果帧（原子的最终返回）
```

一行一帧，行首标记 `PYTOOLS-FRAME-BEGIN`，后面跟 JSON。
所以**不用 `pytools_client` 也能对接**——任何语言、任何 Python 环境，只要能读写这几个文件就行。

## 零配置可用

全部行为都有默认值；要调就写进插件 config：

| 键 | 默认 | 含义 |
|---|---|---|
| `pollMs` | 1500 | 位置轮询间隔 |
| `locateRoots` | `[]` | 找移动文件时额外搜索的目录 |
| `scanDepth` / `maxScanFiles` / `scanTtlMs` | 6 / 20000 / 5000 | 搜索预算 |
| `maxConcurrent` | 8 | 同时运行的 Python 调用上限 |

解释器查找顺序：登记时指定的 → `PYTOOLS_PYTHON` → `PYTHON` → `PATH` 里的
`python` / `python3` / `py`。`pytools_client.py` 的路径通过 `PYTHONPATH` 自动交给子进程，
所以工具文件**不需要**把它拷到旁边，也不需要 pip 安装。

## 已知边界

- 声明读取有 20 秒预算：模块顶层别做重活，重活放进函数里。
- `--manifest` 时 stdout 留给协议：顶层别 `print()` 出 `{` 开头的东西。
- 一次调用一个进程，没有常驻状态；需要状态就写进文件（见 `examples/screen_watch.py`）。
- 相对路径按文件所在目录解析（插件以该目录为工作目录）。
- 单次结果帧上限 8 MB，流帧保留最近 500 帧。
- 取消是 SIGKILL：工具跑不到 `finally`。需要善后就用常驻服务 + stop 工具（见「取消与停止」）。
- 内置示例（`examples/` 里的两个）不出现在设置面板里，也不能停用或删除：它们是自检基准。

## 许可
