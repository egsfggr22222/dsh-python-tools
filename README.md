# Python Tools (DSH Plugin)

**中文 README:** [中文 README](https://github.com/egsfggr22222/dsh-python-tools/blob/main/dsh-python-tools/README.md)

**This plugin has no features of its own.** It does one simple thing: turn Python files into DSH tools and skills.

Any `.py` file that calls `pytools_client.register()` declares tools to DSH.
The plugin remembers where the file lives, calls its registered interfaces whenever needed, receives the data and feedback it returns, and monitors its location in real time — move or rename the file, and the plugin immediately knows the new location.

```
You write a .py  ──pytools install──►  plugin remembers its location  ──►  each register() function becomes a DSH tool
                                                                        └►  each skill() becomes a skill
         ▲                                                                          │
         └──────────────── JSON args in / data frames · result frames out ◄────────┘
```

## What it can put inside DSH

The plugin is just a channel. When the channel is open, **things in the Python ecosystem can become DSH tools**.

Concretely, once installed, DSH can:

### See

| Capability | Powered by | Result |
|---|---|---|
| Read images, video frames | `opencv-python`, `Pillow` | locate, measure, compare, extract frames |
| Object / face / text recognition | `opencv` / `ultralytics (YOLO)` / `paddleocr` | boxes, classes, confidence, text |
| Document parsing | `pymupdf`, `python-docx`, `openpyxl` | what's inside PDF/Word/Excel, and on which page |
| Visual question answering | anything | e.g. "what are the coordinates of the button in this screenshot?" |

### Compute & data

| Capability | Powered by | Result |
|---|---|---|
| Tabular analysis | `pandas`, `polars` | read millions of rows, group, aggregate, find anomalies |
| Numerical computing | `numpy`, `scipy` | matrices, fitting, optimization, signal processing |
| Machine learning | `scikit-learn` | classification / regression / clustering, with models and metrics |
| Visualization | `matplotlib`, `plotly` | save images directly; the agent gets a path and can look |
| Crawling & APIs | `requests`, `httpx`, `playwright` | fetch data, go through login, call APIs |

### Train models (worth calling out separately)

Long tasks shouldn't be "one call that runs to completion" — split them into three tools, and the agent watches them like a progress bar:

```python
@register(description="Start training, return immediately")
def train_start(config: dict) -> dict:
    ...  # spawn a background process, write a status file
    return {"job": job_id}

@register(description="Check training progress")
def train_status(job: str) -> dict:
    return {"epoch": 12, "loss": 0.043, "done": False}

@register(description="Stop training")
def train_stop(job: str) -> dict: ...
```

Now DSH can: start → poll every few seconds → stop immediately if loss plateaus → evaluate the final weights.
In between, `ctx.emit()` pushes per-epoch metrics back in real time.

GPU, CUDA, multi-GPU — none of that matters here. That's the Python side's business; the plugin doesn't touch it.

### Control the real world

| Capability | Powered by | Result |
|---|---|---|
| Control desktop apps | `pyautogui`, `pywinauto`, `uiautomation` | click buttons, fill forms, read control trees |
| Operate hardware | `pyserial`, `pymodbus` | serial ports, PLCs, sensors |
| Speak & make sound | `pyttsx3`, Windows TTS | read results aloud |
| Long-running services | anything | local HTTP services, background watchers, scheduled tasks |
| Call other DSH tools | `ctx.call()` | **reverse call**: from Python, ask DSH to read a file or run a command |
| Ask the user | `ctx.ask()` | need a human decision mid-run? just ask and wait |

### Real-world examples

| Project | What it does |
|---|---|
| **blackboard** | a window you can draw on: 14 tools driving a frameless canvas, frame-by-frame animation, walkthrough progress, Q&A, archiving |
| **whale host** | subtitles + speech + directory probing: a Qt floating window, offline TTS, per-character pacing, tree-shaped maps |
| **probe-tree** | map a directory's size and structure first, so the agent avoids large files and doesn't waste context |

So the point of this plugin is to extend the Python ecosystem into DSH.

Write a `.py`, register it once, and it takes effect immediately — no restart, no plugin code changes.

## One-minute quickstart

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


@register(description="Probe a directory: return a tree structure with each file's size and each folder's total size of all files beneath it.")
def probe_tree(path: str = ".", max_depth: int = 3) -> Dict[str, Any]:
    """Take a "size map" of a directory.

    Args:
        path: The directory to probe.
        max_depth: How many levels to expand.
    """
    root = os.path.abspath(os.path.expanduser(path))
    if not os.path.isdir(root):
        return {"ok": False, "error": "not a directory: %s" % root}

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
                    # Collect children first, then output them together after we know
                    # the total, otherwise children end up before their parent.
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
        "tree": "\n".join(lines) or "(empty directory)",
    }


if __name__ == "__main__":
    raise SystemExit(main())
```

Then tell the agent: `pytools install C:\path\my_tools.py`.

`probe_tree` immediately becomes a DSH tool you can call like any built-in one: the parameter schema is derived from type annotations and the docstring, and the return value goes straight back to the agent. **No package install, no plugin code, no restart.**

Calling it gives you a tree-shaped directory map — every file with its size, every folder with the total of everything beneath it. With that map, the agent can pinpoint the valuable files and avoid the large ones.

## What it solves

| Before | Now |
|---|---|
| Want a new capability → write a Cordis plugin → install → restart | Write a `.py` → `pytools install` once |
| Python scripts need shell command-line assembly and stdout parsing | Functions become tools directly; args are JSON, return values are structured data |
| Long tasks can only be waited on | Use `ctx.emit()` to push data/progress/logs while running, back into the result in real time |
| File moved, tool silently breaks | The plugin finds the new location by content hash, re-registers automatically, and notifies the agent |
| Code changes require reinstall | Save-to-hot-reload; declaration changes are re-read automatically |

## Four core capabilities

### 1. Register tools

```python
@register(description="...")
def my_tool(a: int, b: str = "x") -> dict:
    ...
```

`register` also supports the direct-call form `register(fn, description=...)`, a custom name `name="kebab-case"`, a hand-written schema `schema={...}`, incremental overrides `parameters={...}`, and a timeout `timeout=600`.

Parameter schema derivation order: type annotations → the `Args:` section of the docstring → hand-written overrides.
A `ToolContext` parameter won't appear in the schema — that's how the function gets its context.

### 2. Register skills

```python
@skill("Lookup conventions", description="When and how to look things up", when_to_use="When price tables are involved")
def guide() -> str:
    return "# Lookup conventions\n..."
```

You can also do `skill("name", description="...", path="docs/x.md")` to point at a file. The skill body is read on demand (`python file.py --skill <name>`), and edits to the markdown take effect immediately.

### 3. Bidirectional data channel

Data goes down, feedback comes up:

```python
@register(description="Process step by step with live reporting")
def process(ctx: ToolContext, n: int = 10) -> dict:
    for i in range(n):
        ctx.progress((i + 1) / n, f"step {i + 1}")   # progress
        ctx.emit({"partial": i})                      # data frame
        ctx.log("ok", "debug")                        # log
    ctx.dsh.notify("done")                            # a human-facing one-liner
    return {"n": n}
```

These frames are written to the stream file **immediately** (line-buffered + flush), and the plugin reads them as they arrive — for a 30-second tool, intermediate data doesn't wait until the end to show up.

### 4. Location monitoring (the plugin's actual job)

- **Move / rename** → the original path disappears; the plugin finds it again by **content hash** in known directories, claims the new location, keeps history (call count, install time, notes), and tells the agent the old and new paths in the next turn.
- **Delete** → tools and skills go offline; `pytools list` shows them as missing; putting the file back restores them automatically.
- **Content change** → hot reload: re-read declarations, re-register as needed, no reinstall.
- **Double insurance** → `fs.watch` events + periodic polling (default 1.5 s), so if one misses something the other catches it.

The default search scope is "all directories of known files"; if a file might be moved elsewhere, pass `watch: ["D:/projects"]` to add root directories. Identity is decided **only by content-hash equality** — a same-named file with different content will never be mistaken for the same one.

## The `pytools` tool

| action | Purpose |
|---|---|
| `install` | Register a `.py` (read declarations, register tools and skills, start watching the location, persist) |
| `list` | Registered files, location status, tools/skills, move history |
| `probe` | Read-only: see what a file declares, without registering |
| `relocate` | Force a full location check right now (normally automatic; this is the manual fallback) |
| `inspect` | Details for one file or all files |
| `remove` | Unregister (takes it offline only; doesn't touch the file) |

Parameters: `path`, `pythonPath` (specify the interpreter), `label` (short name, for deduplication), `note`, `watch`.

## File layout

```
dsh-python-tools/
├── index.js                       Host half: registry, watcher, call bridge, tool & skill registration
├── cordis.patch.yml               Load patch (a single insert line)
├── pytools_client.py              ★ Python declaration library (register / skill / ToolContext)
├── skills/
│   ├── pytools-authoring.md       Conventions for writing Python tools (the agent sees this)
│   └── pytools-offline-protocol.md The exact frame formats and protocol
├── examples/
│   ├── echo_tools.py              Minimal example: echo / greet / compute / streaming feedback / errors
│   └── screen_watch.py            Stateful example: background watcher + on-demand event retrieval
├── tools/protocol-test.mjs        Verify a file's protocol implementation without DSH installed
└── icon.svg, README.md
```

## Capability boundaries (read this before designing)

All of the above is possible, but underneath is a **process model**. Not understanding it means writing tools that don't run.

### The model: one call = one new process

```
DSH calls a tool
   └─► spawn a brand-new python interpreter
         └─► import your file → call that function → write the result file → process exits
```

That means:

| Consequence | Meaning |
|---|---|
| No cross-call in-memory state | Globals from the previous call are gone next time. Write state to files, or spin up a long-running process |
| Re-import on every call | A top-level `import torch` means ten-plus seconds every time — straight into the timeout |
| Process startup is inherent overhead | An empty run costs ~20–30 ms; this is why you're not suited for hundreds of tiny calls per second |

**This shapes your interface granularity.** Don't split "click, check, click again" into a dozen tool calls; wrap a complete piece of work into one tool and expose only the key checkpoints.

### Hard numbers (real defaults in the code)

| Item | Value | Location |
|---|---|---|
| Single-call timeout | **120 s** | `@register(timeout=seconds)` can change it |
| Declaration-read budget | **20 s** | Slow top-level code fails |
| Concurrent running calls | **8** | `config.maxConcurrent` |
| Queue timeout | **10 minutes** | `config.queueTimeoutMs` |
| Result frame | **8 MB** | Anything larger can't come back |
| Stream frames | Keep the most recent **500** | High-frequency `emit` drops older ones |

### How to handle heavy libraries

```python
# Bad: every declaration read waits for it to load (easy to time out); every call reloads it
import torch

# Good: declarations are instant; load only when used
def predict(...):
    import torch
    ...
```

Reloading models repeatedly is genuinely slow, too. If calls are frequent, either cache at module level (reused within the same process) or write a long-running service (see the next section).

### Scenario: supervised training

Training is a long task that runs for tens of minutes; it can't be written as `train(epochs=100)` and then waited on — the timeout is the least of your problems, the real one is that you can't intervene mid-way.

The correct shape is **a long-running process + status files**:

```python
@register(description="Start training, return immediately")
def train_start(config: dict) -> dict:
    # spawn a background process; write config to a file, the training loop re-reads it each epoch
    return {"job": job_id, "pid": pid}

@register(description="Check progress")
def train_status(job: str) -> dict:
    return {"epoch": 12, "loss": 0.043, "lr": 3e-4, "done": False}

@register(description="Adjust training params (takes effect next epoch)")
def train_adjust(job: str, lr: float = 0) -> dict:
    # modify the config file, the training loop reads it next epoch
    return {"ok": True}

@register(description="Stop and save weights")
def train_stop(job: str) -> dict: ...
```

Now DSH can: start → poll every few seconds → lower lr when loss stops dropping → stop immediately on NaN → evaluate the latest weights.

GPU / CUDA / multi-GPU — all the Python side's business; the plugin doesn't touch it.

### Scenario: crawlers

Just write it directly; nothing special:

```python
@register(description="Fetch a page")
def fetch(url: str) -> dict:
    import requests
    ...
```

The real blockers aren't the plugin:

| Blocker | Response |
|---|---|
| Anti-bot / rate limiting | Pace requests, rotate IPs — that's crawler work itself |
| Login required | Save cookies with playwright; or `ctx.ask()` to have a human log in once |
| Huge pages | Result-frame cap is 8 MB — write the raw content to disk and return the path |
| Whole-site crawl | Single-call timeout is 120 s — batch it, or make it a long-running task |

### Scenario: long-running services

`whale host/talk.py` is a working example: a tool call just writes one request line to `inbox.jsonl` and returns; the resident Qt process polls and handles it every 40 ms. Subtitles, speech, animation all work this way.

Other uses: local HTTP services, file watchers, scheduled tasks, model servers.

### Bidirectional calls

Python isn't limited to waiting passively:

```python
ctx.emit({"partial": x})          # push a data frame
ctx.progress(0.5, "halfway")       # progress
ctx.log("debug", "...")          # log
ctx.dsh.notify("finished")         # pop something up for the user
ctx.call("ops_grep", {...})       # call a DSH tool in reverse
answer = ctx.ask("Continue?", ["yes", "no"])   # ask the user and wait for a reply
```

`ctx.ask()` blocks waiting for the user's answer (default 300 s). Good for "need a human to decide mid-run" situations.

### One-sentence summary

> How fast it is doesn't depend on data volume — it depends on **how many cuts you make**.
> Make each cut big enough and it's near-native; cut too finely and all the time goes to `python.exe` startup.

## Where data lives

`~/.dsh/python-tools/` (override the root with `DSH_HOME`):

| Path | Contents |
|---|---|
| `registry.json` | Registered files: path, status, declarations, move history, call stats |
| `registry.apply-backup.json` | Previous registry version (so a corrupt file can be recovered) |
| `tmp/<callId>.*` | Per-call call frame / stream frames / result frame, deleted after use |

Argument frames may contain sensitive content, so they're deleted as soon as the call ends; only the non-sensitive stream and result frames remain.

## Protocol at a glance

A call involves only four files (see the `pytools-offline-protocol` skill for details):

```
python <file> __pytools_call__      ← environment variables tell it where the frames are
  PYTOOLS_CALL_FILE    call frame (tool name + args JSON)
  PYTOOLS_STREAM_FILE  stream frames (Python appends, the plugin reads incrementally)
  PYTOOLS_RESULT_FILE  result frame (the atomic final return)
```

One frame per line; the line starts with the marker `PYTOOLS-FRAME-BEGIN`, followed by JSON.
So **you can integrate without `pytools_client`** — any language, any Python environment, as long as it can read and write these files.

## Zero-config usable

Everything has defaults; to tune it, put these in the plugin config:

| Key | Default | Meaning |
|---|---|---|
| `pollMs` | 1500 | Location polling interval |
| `locateRoots` | `[]` | Extra directories to search when locating moved files |
| `scanDepth` / `maxScanFiles` / `scanTtlMs` | 6 / 20000 / 5000 | Search budget |
| `maxConcurrent` | 4 | Max concurrent Python calls |

Interpreter lookup order: specified at registration → `PYTOOLS_PYTHON` → `PYTHON` → `python` / `python3` / `py` on `PATH`. The path to `pytools_client.py` is handed to the child process via `PYTHONPATH`, so tool files **don't** need a copy next to them and don't need a pip install.

## Known boundaries

- Declaration reading has a 20 s budget: don't do heavy work at module top level; put it inside functions.
- With `--manifest`, stdout belongs to the protocol: don't `print()` anything starting with `{` at top level.
- One call, one process, no resident state; need state, write it to files (see `examples/screen_watch.py`).
- Relative paths resolve against the file's directory (the plugin uses that as the working directory).
- Result-frame cap is 8 MB; stream frames keep the most recent 500.
- The built-in examples (the two in `examples/`) don't appear in the settings panel and can't be disabled or deleted: 
