/**
 * Python Tools —— DSH 插件（Host 半边）。
 *
 * 这个插件**自己没有功能**。它只做四件事：
 *
 * 1. **登记位置**：任何 Python 文件调用 `pytools_client.register()`，就成为一个
 *    「已安装的 Python tools 文件」。插件把它的绝对路径持久化，重启后照旧认路。
 * 2. **转发声明**：用 `python <file> --manifest` 问那个文件「你声明了什么」，把
 *    Python 函数注册成 DSH tool，把 markdown 注册成 skill。
 * 3. **双向调用**：每次调用启动一次那个 Python 文件，把参数（JSON 帧）交给它，
 *    收下它写入的流帧（数据 / 进度 / 日志 / 通知）和最终结果帧 —— 数据能下去，
 *    反馈能上来。
 * 4. **盯住位置**：用 fs 服务的 watch + 轮询两道保险盯住每个文件。移动了就按内容
 *    哈希在新位置重新认领，删掉了就下线它的工具和技能，并在下一次对话里告诉 agent
 *    新位置。
 *
 * 这里没有面向某个具体功能的代码：所有能力都住在用户自己的 `.py` 文件里。
 */

import { createHash, randomUUID } from 'node:crypto'
import { spawnSync, spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

/** 插件自己的工具名。 */
const CONTROL_TOOL = 'pytools'

/** Python 子进程的桩参数：识别「这一次是 DSH 在调用我」。 */
const CLI_SUBCOMMAND = '__pytools_call__'

/** Python 往流文件里写的帧头。 */
const FRAME_BEGIN = 'PYTOOLS-FRAME-BEGIN'

const REGISTRY_VERSION = 1

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 3_600_000
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_RESULT_FRAME_BYTES = 8 * 1024 * 1024
const MAX_POLL_BYTES = 1024 * 1024
const MAX_TOOLS_PER_FILE = 200
const MAX_SKILLS_PER_FILE = 50
const MAX_EVENT_BACKLOG = 500

// 工具名仍然强制 ASCII：它会被 DSH 引用，改规则风险大。
const TOOL_NAME = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/u
// 但「被哪些字符破坏」要放宽：原来的 [^A-Za-z0-9._-] 会把中文全部换成 -，
// 于是「黑板作画」→ "----" → 去首尾 - → 空字符串 → 技能被默默丢弃。
// 改成保留任意语言的字母和数字，中文名就能原样活下来。
const NAME_BAD = /[^\p{L}\p{N}._-]+/gu

const IS_WINDOWS = process.platform === 'win32'

// ── 小工具 ───────────────────────────────────────────────────────────────────

const now = () => Date.now()

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把返回值清成「无损 JSON」。
 *
 * DSH 拒收带 undefined 字段的工具结果（value is not lossless JSON），而 Python
 * 的清单里到处是可选的 null 字段，很容易顺手带出 undefined。工具结果在边界上
 * 统一走一遍这里，不让内部形状泄漏到协议上。
 */
function lossless(value) {
  if (value === undefined) return undefined
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : lossless(item) ?? null))
  if (typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      const clean = lossless(item)
      if (clean !== undefined) out[key] = clean
    }
    return out
  }
  return String(value)
}

function pretty(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function slugName(raw) {
  const text = String(raw ?? '').trim()
  return text.replace(NAME_BAD, '-').replace(/^-+|-+$/gu, '').toLowerCase().slice(0, 64)
}

function randomTag() {
  return Math.random().toString(36).slice(2, 10)
}

function sha256OfFile(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return ''
  }
}

function isFile(file) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function statOf(file) {
  try {
    const stat = statSync(file)
    return { mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    return { mtimeMs: 0, size: 0 }
  }
}

function readJsonOrNull(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function tail(text, limit) {
  const value = String(text ?? '')
  return value.length <= limit ? value : `…${value.slice(value.length - limit)}`
}

function dshHome(...parts) {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), ...parts)
}

/**
 * 读插件自己的 config。
 *
 * Cordis 的 `ctx.config` 只有在 `inject: ['config']` 时才可读，未注入时访问会抛
 * 「cannot get property without inject」。这个插件在零配置下必须能用，所以读失败
 * 就当作没有配置。
 */
function readPluginConfig(ctx) {
  try {
    const value = ctx.config
    return isObject(value) ? value : {}
  } catch {
    return {}
  }
}

const dataDir = () => dshHome('python-tools')
const registryFile = () => join(dataDir(), 'registry.json')
const backupFile = () => join(dataDir(), 'registry.apply-backup.json')
const tempDir = () => join(dataDir(), 'tmp')

/** 原子写：先写临时文件再改名，崩在半路也不会留下半个注册表。 */
function writeAtomic(file, content) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomTag()}.tmp`
  writeFileSync(tmp, content, 'utf8')
  try {
    renameSync(tmp, file)
  } catch {
    // Windows 上目标被占用时 rename 会失败：删掉再写一次。
    try {
      unlinkSync(file)
    } catch {
      // 目标本来就不在
    }
    writeFileSync(file, content, 'utf8')
    try {
      unlinkSync(tmp)
    } catch {
      // 临时文件已经没了
    }
  }
}

function safeUnlink(file) {
  try {
    unlinkSync(file)
  } catch {
    // 文件已经没了
  }
}

/** 读文件的一段字节（流式收帧用，不把整个文件读进来）。 */
function readFileRange(file, offset, maxBytes) {
  const fd = openSync(file, 'r')
  try {
    const stat = fstatSync(fd)
    const length = Math.max(0, Math.min(maxBytes, stat.size - offset))
    if (length === 0) return Buffer.alloc(0)
    const buffer = Buffer.alloc(length)
    const read = readSync(fd, buffer, 0, length, offset)
    return read === length ? buffer : buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

// ── 插件主体 ─────────────────────────────────────────────────────────────────

export function apply(ctx) {
  /** 已安装文件表：绝对路径 -> 条目。 */
  const files = new Map()
  /** 工具名的全局索引：DSH 工具名 -> 条目路径。 */
  const toolNames = new Map()
  /** 每条已注册工具对应的 disposer，键是 `${path}\x1f${rawName}`。 */
  const toolDisposers = new Map()
  /** 技能名 -> { disposer, path, signature }。 */
  const skillRegistrations = new Map()
  /** 静默期间攒下的变更，下一次对话时作为运行时上下文交付。 */
  const pendingNotices = []
  /** 运行中的调用。 */
  const running = new Set()
  /**
   * 本插件亲手 spawn 出去的 python 进程。
   *
   * 为什么要记：以前要停一个长驻工具，只能 `Stop-Process -Name python`，
   * 结果是把所有 python 进程（黑板、字幕、别的工具）一起杀掉。
   * 这里维护一份白名单，kill 只能杀名单里的 pid。
   */
  const spawnedPids = new Map()   // pid -> { path, startedAt }
  const MAX_TRACKED_PIDS = 64

  /**
   * 生命周期通知。
   *
   * 要解决的问题：用户点“停止”后 agent 死了，但字幕还在念、黑板还在动。
   * 那些长驻进程自己感知不到“agent 已经停了”，而 agent 也没机会去通知它们。
   *
   * 插件不一样：它跟着 DSH 活着，能收到 agent/status 事件。
   * 所以由插件转一手：agent 变 idle → 告诉所有声明了 follow_lifecycle 的文件。
   */
  const LIFE_EVENT_AGENT_IDLE = 'agent-idle'
  let lastLifeNotifyAt = 0
  const LIFE_NOTIFY_THROTTLE_MS = 500

  /**
   * 反向申请：Python → 插件 → DSH。
   *
   * 原则：Python 只能「申请」，插件只做「转交」。
   * 插件不自己决定什么时候打断、发什么内容，只把申请原样交上去。
   *
   * 申请写成 JSONL，一个文件一个通道：
   *   ~/.dsh/python-tools/requests/<文件名字>.jsonl
   */
  const REQUESTS_DIR = (() => {
    const explicit = process.env.PYTOOLS_REQUESTS_DIR
    if (typeof explicit === 'string' && explicit !== '') return explicit
    const home = process.env.DSH_HOME
    if (typeof home === 'string' && home !== '') return join(home, 'python-tools', 'requests')
    return join(homedir(), '.dsh', 'python-tools', 'requests')
  })()
  /**
   * 动作邮箱：DSH -> Python 的「去做什么」。
   *
   * 和反向申请是同一套文件思路，但方向相反：DSH 把动作写进这个文件的邮箱，
   * python 那边自己决定什么时候来读、要不要理。插件不解释动作含义，
   * 也不保证对方处理 —— 它只负责把话送到。
   */
  const ACTIONS_DIR = (() => {
    const explicit = process.env.PYTOOLS_ACTIONS_DIR
    if (typeof explicit === 'string' && explicit !== '') return explicit
    const home = process.env.DSH_HOME
    if (typeof home === 'string' && home !== '') return join(home, 'python-tools', 'actions')
    return join(homedir(), '.dsh', 'python-tools', 'actions')
  })()

  /** 已读到的位置：文件名 -> 已处理的字节数 */
  const requestOffsets = new Map()
  /**
   * 首次见到一个文件时，把它现有的内容当作「上一次会话的旧申请」跳过。
   *
   * 不这么做的话，插件一重启就会把所有历史申请重放一遍 ——
   * 黑板那边已经因为同样的毛病被坑过一次（遗留的 history-window.request
   * 每次启动都被当成刚发生）。申请是“此刻要发生的事”，不该回放。
   */
  let requestBaselineDone = false
  let requestTimer = null
  /** 最近一次 agent/status 里看到的 agent 对象，申请要发给它 */
  let lastSeenAgent = null

  let skillsApi = ctx.get('skills')
  let promptApi = ctx.get('systemPrompt')
  /**
   * tools 服务。启动瞬间它可能还没挂上——直接 ctx.get 会拿到 undefined，
   * 然後“静默跳过”，结果是那个文件的所有工具都不注册，而技能却正常。
   * 这就是「写一个工具就要调一次」的根源。这里改成：拿不到就排队，服务到了统一补。
   */
  let toolsApi = ctx.get('tools')
  const pendingToolFiles = new Set()
  let toolRetryTimer = null

  /**
   * 工具注册必须自己“重试”，不能依赖服务注入的时机。
   *
   * 实测：ctx.inject(['tools']) 的回调并不总在服务就绪时触发，
   * 结果是排队的文件永远等不到。所以这里自己拍一个定时器：
   * 每 200ms 看一眼 tools 服务到了没，到了就把排队的全部注上。
   */
  function ensureToolRetry() {
    if (toolRetryTimer !== null) return
    let tries = 0
    toolRetryTimer = setInterval(() => {
      tries += 1
      const registry = ctx.get('tools')
      if (registry !== undefined && typeof registry.register === 'function') {
        toolsApi = registry
        const waiting = [...pendingToolFiles]
        pendingToolFiles.clear()
        for (const path of waiting) {
          const entry = files.get(path)
          if (entry !== undefined) registerFileTools(entry)
        }
        if (pendingToolFiles.size === 0) {
          clearInterval(toolRetryTimer)
          toolRetryTimer = null
        }
        return
      }
      if (tries >= 150) {   // 30 秒还等不到，放弃（服务真的不在）
        clearInterval(toolRetryTimer)
        toolRetryTimer = null
      }
    }, 200)
    if (typeof toolRetryTimer?.unref === 'function') toolRetryTimer.unref()
  }

  /**
   * 可调行为。全部有默认值，正常使用不需要配置。
   *
   * Cordis 只在把 `config` 写进 inject 时才给插件 config，所以这里用 try 读一次；
   * 拿不到就用默认值 —— 这个插件在零配置下必须是完全可用的。
   *
   * - pollMs：位置轮询间隔（ms），fs.watch 之外的兜底保险。
   * - locateRoots：找「被移走的文件」时额外搜索的目录；所有已知文件所在目录自动加入。
   * - scanDepth / maxScanFiles / scanTtlMs：搜索预算，防止在大盘上把时间耗光。
   * - maxConcurrent：同时运行的 Python 调用上限。
   */
  const config = {
    pollMs: 1500,
    locateRoots: [],
    scanDepth: 6,
    maxScanFiles: 20_000,
    scanTtlMs: 5000,
    maxConcurrent: 8,
    queueTimeoutMs: 600_000,
    ...(readPluginConfig(ctx)),
  }

  let skillDigestCache = { text: '', at: 0 }
  let locateCache = null

  // 服务可能晚于本插件挂上：注入一次，到了就用。
  ctx.inject(['skills'], (scoped) => {
    skillsApi = scoped.skills
    skillDigestCache = { text: '', at: 0 }
    registerBuiltinSkills()
    for (const entry of files.values()) syncFileSkills(entry)
  })
  ctx.inject(['systemPrompt'], (scoped) => {
    promptApi = scoped.systemPrompt
    registerPromptContributions(scoped.systemPrompt)
  })

  // tools 服务到了就用；顺手把启动时没排上的文件补注册一遍。
  ctx.inject(['tools'], (scoped) => {
    toolsApi = scoped.tools
    if (toolsApi === undefined || typeof toolsApi.register !== 'function') return
    for (const entry of files.values()) registerFileTools(entry)
    pendingToolFiles.clear()
    ensureToolRetry()
  })

  /**
   * 给一个文件发生命周期通知。
   *
   * 走的是“再跑一次 Python 文件”这条路：把事件名当参数传进去，
   * 由文件自己在 __main__ 里处理。这样不需要长驻连接，进程退出了也不影响。
   */
  function notifyLifecycle(entry, event) {
    try {
      const result = runSync(entry, ['--lifecycle', event], { timeoutMs: 8_000 })
      if (!result.ok) {
        // 通知失败不报错：工具可能本来就没在跑
        return false
      }
      return true
    } catch {
      return false
    }
  }

  /** agent 停下时，通知所有声明了 follow_lifecycle 的文件。 */
  function notifyAgentIdle() {
    const now = Date.now()
    if (now - lastLifeNotifyAt < LIFE_NOTIFY_THROTTLE_MS) return
    lastLifeNotifyAt = now
    const targets = [...files.values()].filter((entry) => entry.followLifecycle === true)
    for (const entry of targets) notifyLifecycle(entry, LIFE_EVENT_AGENT_IDLE)
  }

  // ── 反向申请：把 Python 的申请转交给 DSH ────────────────────────────────

  /**
   * 把一个申请交给 DSH。只转交，不自己判断。
   *
   * DSH 的 agent 句柄提供三个方法（来自 dsh-agent 的公开约定）：
   *   agent.steer(input)     打断最近的一步，立即插入这条消息
   *   agent.followup(input)  排到下一轮，不打断当前
   *   agent.cancel(cause, o) 中止当前活动；keepInbox 保留待处理项
   * 插件只负责把 Python 的申请翻成这三个调用。
   */
  function deliverRequest(item) {
    const agent = lastSeenAgent
    if (agent === undefined || agent === null) return false
    const kind = String(item?.kind ?? '')
    const text = String(item?.text ?? '')
    try {
      if (kind === 'interrupt') {
        if (typeof agent.cancel !== 'function') return false
        agent.cancel(
          { kind: 'pytools', reason: String(item?.reason ?? '') },
          { keepInbox: true },
        )
        return true
      }
      if (kind === 'action') {
        // Python 申请一个动作。插件不执行它，只把「该做什么」原样交给 agent，
        // actionId 一并带上，这样反馈回路才对得上号。
        const actionId = String(item?.actionId ?? '')
        const name = String(item?.name ?? '')
        if (actionId === '' || name === '') return false
        const detail = item?.arguments === undefined ? '' : `\n参数：${JSON.stringify(item.arguments)}`
        const input = {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: `【python 动作申请】${name}（actionId=${actionId}）${detail}\n${String(item?.note ?? '')}`.trim() }],
          source: { kind: 'pytools' },
        }
        if (typeof agent.followup !== 'function') return false
        agent.followup(input)
        return true
      }
      if (kind === 'message' || kind === 'notify') {
        const input = {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'pytools' },
        }
        if (item?.interrupt === true) {
          if (typeof agent.steer !== 'function') return false
          agent.steer(input)
          return true
        }
        if (typeof agent.followup !== 'function') return false
        agent.followup(input)
        return true
      }
      return false
    } catch {
      return false
    }
  }

  /** 扫一遍申请目录，处理新增的行。 */
  async function pumpRequests() {
    let names = []
    try {
      names = readdirSync(REQUESTS_DIR).filter((name) => name.endsWith('.jsonl'))
    } catch {
      return
    }
    // 第一次扫：把已存在的文件长度当基线，旧申请一律不重放
    if (!requestBaselineDone) {
      requestBaselineDone = true
      for (const name of names) {
        try {
          requestOffsets.set(name, readFileSync(join(REQUESTS_DIR, name), 'utf8').length)
        } catch {
          requestOffsets.set(name, 0)
        }
      }
      return
    }
    for (const name of names) {
      const full = join(REQUESTS_DIR, name)
      let text = ''
      try {
        text = readFileSync(full, 'utf8')
      } catch {
        continue
      }
      const consumed = requestOffsets.get(name) ?? 0
      if (text.length <= consumed) continue
      const chunk = text.slice(consumed)
      // 只处理完整的行
      const lastBreak = chunk.lastIndexOf('\n')
      if (lastBreak < 0) continue
      const complete = chunk.slice(0, lastBreak)
      requestOffsets.set(name, consumed + lastBreak + 1)
      for (const line of complete.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        let item
        try {
          item = JSON.parse(trimmed)
        } catch {
          continue
        }
        await deliverRequest(item)
      }
    }
  }

  // 定时扫申请：不主动做事，只把已有申请转上去
  requestTimer = setInterval(() => {
    void pumpRequests()
  }, 400)
  if (typeof requestTimer?.unref === 'function') requestTimer.unref()

  // DSH 的 agent 状态事件：status 变 idle 就说明这一轮结束了（正常结束或被中止都算）。
  try {
    if (typeof ctx.on === 'function') {
      ctx.on('agent/status', (payload) => {
        // 记住 agent 对象：Python 的申请要发回给“当前这个 agent”
        if (payload?.agent !== undefined) lastSeenAgent = payload.agent
        const status = payload?.status
        if (status === 'idle') notifyAgentIdle()
      })
    }
  } catch {
    // 拿不到事件就算了，不拖垮整个插件
  }

  // 设置页里的控制面板：列表 / 开关 / 删除 / 搜索
  registerPanelRoutes(ctx)

  // ══════════════════════════════════════════════════════════════════════════
  // 1. 注册表持久化
  // ══════════════════════════════════════════════════════════════════════════

  function blankEntry(absolute, { pythonPath = '', label = '', note = '' } = {}) {
    return {
      path: absolute,
      label: label || basename(absolute),
      pythonPath,
      note,
      // 面板上的滑动开关：disabled=true 时不注册它的工具与技能
      disabled: false,
      // 是否要收「agent 已停」这类生命周期通知（由 Python 侧 follow_lifecycle() 声明）
      followLifecycle: false,
      addedAt: now(),
      lastSeenAt: null,
      status: 'pending',
      error: '',
      hash: '',
      mtimeMs: 0,
      size: 0,
      manifest: null,
      tools: [],
      skills: [],
      moves: 0,
      lastMove: null,
      calls: 0,
      lastCallAt: null,
      missingSince: null,
      // 以下为运行时字段，不持久化
      dshTools: new Map(),
      dshSkills: new Set(),
      skillBodies: new Map(),
      lastInterpreter: '',
      watcher: null,
      watcherController: null,
      pollTimer: null,
      recheckTimer: null,
    }
  }

  function loadRegistry() {
    const fromDisk = readJsonOrNull(registryFile())
    const raw = fromDisk ?? readJsonOrNull(backupFile())
    if (raw === null) return []
    const list = Array.isArray(raw?.files) ? raw.files : []
    const result = []
    for (const item of list) {
      if (typeof item?.path !== 'string' || item.path === '') continue
      const absolute = resolve(item.path)
      if (result.some((entry) => entry.path === absolute)) continue
      const entry = blankEntry(absolute, {
        pythonPath: typeof item.pythonPath === 'string' ? item.pythonPath : '',
        label: typeof item.label === 'string' && item.label !== '' ? item.label : '',
        note: typeof item.note === 'string' ? item.note : '',
      })
      entry.disabled = item.disabled === true
      entry.addedAt = Number.isFinite(item.addedAt) ? item.addedAt : now()
      entry.lastSeenAt = Number.isFinite(item.lastSeenAt) ? item.lastSeenAt : null
      entry.missingSince = Number.isFinite(item.missingSince) ? item.missingSince : null
      entry.status = ['ready', 'missing', 'pending', 'broken', 'relocating'].includes(item.status) ? item.status : 'pending'
      entry.error = typeof item.error === 'string' ? item.error : ''
      entry.hash = typeof item.hash === 'string' ? item.hash : ''
      entry.mtimeMs = Number.isFinite(item.mtimeMs) ? item.mtimeMs : 0
      entry.size = Number.isFinite(item.size) ? item.size : 0
      entry.manifest = isObject(item.manifest) ? item.manifest : null
      entry.tools = Array.isArray(item.tools) ? item.tools : []
      entry.skills = Array.isArray(item.skills) ? item.skills : []
      entry.followLifecycle = item.followLifecycle === true
      entry.moves = Number.isFinite(item.moves) ? item.moves : 0
      entry.lastMove = isObject(item.lastMove) ? item.lastMove : null
      entry.calls = Number.isFinite(item.calls) ? item.calls : 0
      entry.lastCallAt = Number.isFinite(item.lastCallAt) ? item.lastCallAt : null
      result.push(entry)
    }
    return result
  }

  function serializeRegistry() {
    return {
      version: REGISTRY_VERSION,
      savedAt: now(),
      files: [...files.values()].map((entry) => ({
        path: entry.path,
        label: entry.label,
        pythonPath: entry.pythonPath,
        note: entry.note,
        disabled: entry.disabled === true,
        addedAt: entry.addedAt,
        lastSeenAt: entry.lastSeenAt,
        missingSince: entry.missingSince,
        status: entry.status,
        error: entry.error,
        hash: entry.hash,
        mtimeMs: entry.mtimeMs,
        size: entry.size,
        manifest: entry.manifest,
        tools: entry.tools,
        skills: entry.skills,
      followLifecycle: entry.followLifecycle === true,
        moves: entry.moves,
        lastMove: entry.lastMove,
        calls: entry.calls,
        lastCallAt: entry.lastCallAt,
      })),
    }
  }

  let saveTimer = null
  function saveRegistrySoon() {
    if (saveTimer !== null) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveRegistryNow()
    }, 150)
    if (typeof saveTimer?.unref === 'function') saveTimer.unref()
  }

  function saveRegistryNow() {
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    try {
      const json = JSON.stringify(serializeRegistry(), null, 2)
      writeAtomic(registryFile(), json)
      try {
        copyFileSync(registryFile(), backupFile())
      } catch {
        // 备份是尽力而为
      }
    } catch {
      // 持久化失败不影响本次会话的调用能力
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 2. 运行 Python
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * 候选解释器链。
   *
   * 顺序很重要，也是本次修复的重点：
   *   1. 显式指定的 pythonPath（必须真的排第一）；
   *   2. 上一次成功用过的解释器；
   *   3. 环境变量；
   *   4. 平台默认名。
   *
   * 以前 runSync/runAsync 会优先用 lastInterpreter，导致显式指定的 pythonPath 被
   * 旧值遮蔽 —— 这正是「传了 pythonPath 却没生效」的原因。
   */
  function candidateInterpreters(preferred) {
    const list = []
    const push = (value) => {
      if (typeof value === 'string' && value.trim() !== '' && !list.includes(value.trim())) {
        list.push(value.trim())
      }
    }
    push(preferred)
    push(process.env.PYTOOLS_PYTHON)
    push(process.env.PYTHON)
    if (IS_WINDOWS) {
      push('py') // py 启动器能找到注册表里的所有版本
      push('python')
      push('python3')
    } else {
      push('python3')
      push('python')
    }
    return list
  }

  /** 本条目实际应该先试哪个解释器：显式配置优先于历史记录。 */
  function preferredInterpreter(entry) {
    return entry.pythonPath || entry.lastInterpreter || ''
  }

  /**
   * 子进程环境。
   *
   * 关键一行是 PYTHONPATH：任何 Python tools 文件都能 `import pytools_client`，
   * 不需要 pip 安装、不需要把库拷到文件旁边。已有的 PYTHONPATH 会被保留，
   * 只用分隔符接在后面（Windows 是 `;`，其余是 `:`）。
   */
  function baseEnv(entry, extra = {}) {
    const env = {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      PYTOOLS_HOST: CONTROL_TOOL,
      PYTOOLS_HOST_VERSION: '1',
      PYTOOLS_FILE: entry.path,
      PYTOOLS_CLIENT_DIR: MODULE_DIR,
      PATH: withClientDir(process.env.PATH),
      PYTHONPATH: withClientDir(process.env.PYTHONPATH),
      ...extra,
    }
    return env
  }

  /** 把插件目录接到 PATH 类环境变量的最前面去（保留原有内容）。 */
  function withClientDir(value) {
    const separator = IS_WINDOWS ? ';' : ':'
    const current = typeof value === 'string' ? value : ''
    if (current.split(separator).some((item) => item.trim() === MODULE_DIR)) return current
    return current === '' ? MODULE_DIR : `${MODULE_DIR}${separator}${current}`
  }

  /** 阻塞式运行（读清单、读技能正文）：短、可预期、不打断主流程。 */
  function runSync(entry, args, { timeoutMs = 20_000, env = {} } = {}) {
    const tried = []
    let last = null
    for (const interpreter of candidateInterpreters(preferredInterpreter(entry))) {
      tried.push(interpreter)
      const argv = IS_WINDOWS && interpreter === 'py'
        ? ['py', '-3', entry.path, ...args]
        : [interpreter, entry.path, ...args]
      const out = spawnSync(argv[0], argv.slice(1), {
        cwd: dirname(entry.path),
        env: baseEnv(entry, env),
        timeout: timeoutMs,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      if (out.error !== undefined && out.error !== null) {
        const code = out.error.code === 'ENOENT' ? 'ENOENT' : 'SPAWN_FAILED'
        last = { ok: false, code, message: String(out.error.message ?? out.error), stdout: '', stderr: '', exitCode: null, interpreter }
        if (code === 'ENOENT') continue
        return last
      }
      const result = {
        ok: out.status === 0,
        code: out.status === 0 ? 'OK' : 'EXIT',
        message: out.status === 0 ? '' : `python 退出码 ${out.status}`,
        stdout: String(out.stdout ?? ''),
        stderr: String(out.stderr ?? ''),
        exitCode: out.status,
        interpreter,
      }
      if (!result.ok && out.status === null) {
        result.code = 'TIMEOUT'
        result.message = `python 超过 ${timeoutMs}ms 未返回`
      }
      return result
    }
    return last ?? {
      ok: false,
      code: 'NO_PYTHON',
      message: `找不到可用的 python 解释器（试过：${tried.join(', ') || '空'}）`,
      stdout: '',
      stderr: '',
      exitCode: null,
      interpreter: '',
    }
  }

  /** 异步运行：调用工具时用，不阻塞 Host 事件循环。 */
  function runAsync(entry, args, { timeoutMs, env = {}, signal } = {}) {
    return new Promise((settle) => {
      const argv = [entry.path, ...args]
      let child
      try {
        child = spawn(preferredInterpreter(entry) || (IS_WINDOWS ? 'python' : 'python3'), argv, {
          cwd: dirname(entry.path),
          env: baseEnv(entry, env),
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        settle({ ok: false, code: 'SPAWN_FAILED', message: String(error?.message ?? error), stdout: '', stderr: '', exitCode: null, durationMs: 0 })
        return
      }
      // 记下这个进程，供 pytools kill 精确停止
      if (typeof child.pid === 'number') {
        spawnedPids.set(child.pid, { path: entry.path, startedAt: now() })
        if (spawnedPids.size > MAX_TRACKED_PIDS) {
          const oldest = spawnedPids.keys().next().value
          spawnedPids.delete(oldest)
        }
        child.on('close', () => spawnedPids.delete(child.pid))
      }
      const started = now()
      const stdoutChunks = []
      const stderrChunks = []
      let stdoutBytes = 0
      let settled = false
      const finish = (payload) => {
        if (settled) return
        settled = true
        settle({
          ...payload,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          durationMs: now() - started,
        })
      }
      child.on('error', (error) => {
        finish({ ok: false, code: error?.code === 'ENOENT' ? 'ENOENT' : 'SPAWN_FAILED', message: String(error?.message ?? error), exitCode: null })
      })
      child.stdout?.on('data', (chunk) => {
        if (stdoutBytes >= MAX_OUTPUT_BYTES) return
        stdoutBytes += chunk.length
        stdoutChunks.push(chunk)
      })
      child.stderr?.on('data', (chunk) => {
        if (stderrChunks.length < 512) stderrChunks.push(chunk)
      })
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // 已经退出了
        }
        finish({ ok: false, code: 'TIMEOUT', message: `python 工具超过 ${timeoutMs}ms 未返回`, exitCode: null })
      }, timeoutMs)
      if (typeof timer?.unref === 'function') timer.unref()
      // On DSH cancel (stop button / agent.cancel) kill the python child at once.
      // Otherwise DSH waits for this tool body to settle before aborting.
      const onAbort = () => {
        try {
          child.kill('SIGKILL')
        } catch {
          // already gone
        }
        finish({ ok: false, code: 'ABORTED', message: 'python call cancelled', exitCode: null })
      }
      if (signal !== undefined && signal !== null) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
      child.on('close', (code) => {
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        finish({
          ok: code === 0,
          code: code === 0 ? 'OK' : 'EXIT',
          message: code === 0 ? '' : `python 退出码 ${code}`,
          exitCode: code,
        })
      })
    })
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3. 读取 Python 文件自己的声明
  // ══════════════════════════════════════════════════════════════════════════

  function probeManifest(entry, { timeoutMs = 20_000 } = {}) {
    const result = runSync(entry, ['--manifest'], { timeoutMs })
    if (!result.ok) return { ok: false, error: describeFailure(result, entry.path) }
    const text = extractManifestJson(result.stdout)
    if (text === null) {
      return {
        ok: false,
        error: [
          'Python 文件没有输出 manifest。',
          `它需要在模块顶部调用 pytools_client.register()，并在 __main__ 里调用 pytools_client.main()。`,
          result.stderr.trim() === '' ? '' : `stderr：\n${tail(result.stderr, 3000)}`,
        ].filter(Boolean).join('\n'),
      }
    }
    try {
      return { ok: true, manifest: normalizeManifest(JSON.parse(text)), interpreter: result.interpreter }
    } catch (error) {
      return { ok: false, error: `manifest 不是合法 JSON：${String(error?.message ?? error)}` }
    }
  }

  function extractManifestJson(stdout) {
    const trimmed = String(stdout ?? '').trim()
    if (trimmed === '') return null
    if (trimmed.startsWith('{')) return trimmed
    const lines = trimmed.split(/\r?\n/u)
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim()
      if (line.startsWith('{')) return lines.slice(index).join('\n')
    }
    return null
  }

  function describeFailure(result, target) {
    if (result.code === 'NO_PYTHON') return result.message
    if (result.code === 'TIMEOUT') return '读取声明超时（Python 太慢，或模块顶层在等输入）'
    // ENOENT 有两种：解释器找不到，和目标文件不存在。
    // 以前一律说成「解释器不存在」，把一个显而易见的路径问题误导成环境问题。
    if (result.code === 'ENOENT') {
      if (typeof target === 'string' && target !== '' && !isFile(target)) {
        return `文件不存在：${target}`
      }
      return 'python 解释器不存在'
    }
    const detail = (result.stderr || result.stdout).trim()
    return `python 运行失败（退出码 ${result.exitCode ?? '?'}）${detail === '' ? '' : `：\n${tail(detail, 3000)}`}`
  }

  /** 把 Python 给的东西收紧成 DSH 能吃的形状：只校验，不做业务判断。 */
  function normalizeManifest(raw) {
    const tools = []
    const skills = []
    const warnings = []
    for (const item of (Array.isArray(raw?.tools) ? raw.tools : []).slice(0, MAX_TOOLS_PER_FILE)) {
      const name = slugName(item?.name)
      if (name === '') {
        warnings.push('有一个工具没有名字，已跳过')
        continue
      }
      if (!TOOL_NAME.test(name)) {
        warnings.push(`工具名 ${JSON.stringify(item?.name)} 规范化后仍不合法，已跳过`)
        continue
      }
      if (tools.some((tool) => tool.name === name)) {
        warnings.push(`工具 ${name} 在同一文件里重复声明，保留第一个`)
        continue
      }
      const timeoutMs = Number.isFinite(item?.timeoutMs) && item.timeoutMs > 0
        ? Math.min(MAX_TIMEOUT_MS, Math.round(item.timeoutMs))
        : DEFAULT_TIMEOUT_MS
      tools.push({
        name,
        description: typeof item?.description === 'string' && item.description.trim() !== ''
          ? item.description.trim().slice(0, 4000)
          : name,
        parameters: isObject(item?.parameters) ? item.parameters : { type: 'object', additionalProperties: true },
        timeoutMs,
        output: isObject(item?.output) ? item.output : null,
      })
    }
    for (const item of (Array.isArray(raw?.skills) ? raw.skills : []).slice(0, MAX_SKILLS_PER_FILE)) {
      const name = slugName(item?.name)
      if (name === '') continue
      if (skills.some((skill) => skill.name === name)) continue
      skills.push({
        name,
        description: typeof item?.description === 'string' && item.description.trim() !== ''
          ? item.description.trim().slice(0, 2000)
          : name,
        whenToUse: typeof item?.whenToUse === 'string' && item.whenToUse !== '' ? item.whenToUse.slice(0, 1000) : undefined,
        path: typeof item?.path === 'string' && item.path !== '' ? item.path : undefined,
        resources: Array.isArray(item?.resources) ? item.resources.filter((value) => typeof value === 'string') : [],
      })
    }
    // Python 侧自己在声明期发现的「这样写会出问题」，原样带上来。
    for (const item of (Array.isArray(raw?.warnings) ? raw.warnings : []).slice(0, 50)) {
      if (typeof item === 'string' && item.trim() !== '') warnings.push(item.trim())
    }
    return {
      protocol: typeof raw?.protocol === 'string' ? raw.protocol : 'pytools/1',
      python: typeof raw?.python === 'string' ? raw.python : '',
      executable: typeof raw?.executable === 'string' ? raw.executable : '',
      info: isObject(raw?.info) ? raw.info : {},
      tools,
      skills,
      warnings,
      // Python 侧调了 follow_lifecycle()，就会把这一项置 true
      followLifecycle: raw?.followLifecycle === true,
      probedAt: now(),
    }
  }

  function manifestSignature(manifest) {
    if (manifest === null || manifest === undefined) return ''
    return JSON.stringify({
      tools: (manifest.tools ?? []).map((tool) => [tool.name, tool.description, tool.parameters, tool.timeoutMs]),
      skills: (manifest.skills ?? []).map((skill) => [skill.name, skill.description, skill.whenToUse]),
    })
  }

  function summaryOfManifest(manifest) {
    const tools = (manifest?.tools ?? []).map((tool) => tool.name)
    const skills = (manifest?.skills ?? []).map((skill) => skill.name)
    const parts = [tools.length === 0 ? '0 个工具' : `${tools.length} 个工具（${tools.join(', ')}）`]
    if (skills.length > 0) parts.push(`${skills.length} 个技能（${skills.join(', ')}）`)
    return parts.join('，')
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 4. 安装 / 刷新 / 下线
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * 工具在 DSH 里的名字。
   *
   * 同一个文件里的工具没有冲突，直接用原名；不同文件同名时加文件名前缀，
   * 再加序号兜底 —— 名字必须稳定，否则模型上一轮的记忆就失效了。
   */
  function dshToolName(entry, rawName, reserved = new Set()) {
    if (!toolNames.has(rawName)) return rawName
    const prefix = slugName(entry.label.replace(/\.py$/iu, '')) || slugName(basename(dirname(entry.path))) || 'py'
    let candidate = `${prefix}--${rawName}`
    for (let index = 2; toolNames.has(candidate); index += 1) {
      candidate = `${prefix}--${rawName}--${index}`
    }
    while (reserved.has(candidate)) candidate = `${candidate}--x`
    reserved.add(candidate)
    return candidate
  }

  function registerFileTools(entry) {
    const registry = toolsApi
    // 服务还没就绪：排进待办，等 ctx.inject(['tools']) 回来时统一补注册。
    // 绝不静默放弃——那会让这个文件的工具凭空消失。
    if (registry === undefined || typeof registry.register !== 'function') {
      pendingToolFiles.add(entry.path)
      ensureToolRetry()
      return
    }
    pendingToolFiles.delete(entry.path)
    // 面板关掉的条目不注册（先撤掉旧的，才能保证关掉后真的消失）
    // 内置基础设施例外：无论 disabled 字段是什么，都照常注册。
    if (entry.disabled === true && !isBuiltinFile(entry)) {
      stopFileTools(entry)
      return
    }
    // 先撤掉本文件自己之前的注册。这一步必须**在**查重之前：认领新位置后
    // 条目路径变了，旧注册在新路径下查不到，它们就会变成幽灵名字，
    // 把自己的原名挤成带前缀的样子。
    stopFileTools(entry)
    const reserved = new Set()
    for (const tool of entry.tools) {
      const name = dshToolName(entry, tool.name, reserved)
      try {
        const disposer = registry.register(buildToolDefinition(entry, tool, name))
        toolDisposers.set(`${entry.path}\x1f${tool.name}`, disposer)
        toolNames.set(name, entry.path)
        entry.dshTools.set(tool.name, name)
      } catch (error) {
        entry.error = `注册工具 ${tool.name} 失败：${String(error?.message ?? error)}`
      }
    }
  }

  function stopFileTools(entry) {
    for (const [, name] of entry.dshTools) {
      if (toolNames.get(name) === entry.path) toolNames.delete(name)
    }
    for (const [rawName] of entry.dshTools) {
      const disposer = toolDisposers.get(`${entry.path}\x1f${rawName}`)
      if (typeof disposer === 'function') {
        try {
          disposer()
        } catch {
          // 服务已经先走了
        }
        toolDisposers.delete(`${entry.path}\x1f${rawName}`)
      }
    }
    entry.dshTools.clear()
  }

  function buildToolDefinition(entry, tool, name) {
    return {
      name,
      description: [
        tool.description,
        `(Python tool · ${entry.label} · ${entry.path})`,
      ].join('\n'),
      parameters: tool.parameters,
      timeoutMs: Math.min(MAX_TIMEOUT_MS, tool.timeoutMs + 20_000),
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            value: {},
            valueText: { type: 'string' },
            events: { type: 'array', items: { type: 'object', additionalProperties: true } },
            error: { type: 'object', additionalProperties: true },
            location: { type: 'object', additionalProperties: true },
            durationMs: { type: 'number' },
            file: { type: 'string' },
          },
        },
        render: (_args, value) => renderCall(value),
      },
      // 第二个参数 exec 里有 DSH 给的确切在线 agent（exec.agent）。
      // 记下来：Python 提申请时，插件要把申请交回给“当前这个 agent”。
      // agent/status 也能给到 agent，但它只在状态变化时触发，单靠它可能一直是空的。
      execute: async (args, exec) => {
        if (exec?.agent !== undefined && exec?.agent !== null) lastSeenAgent = exec.agent
        return lossless(await callPythonTool(entry, tool, args ?? {}, exec?.signal))
      },
    }
  }

  function syncFileSkills(entry) {
    if (entry.disabled === true && !isBuiltinFile(entry)) return
    if (skillsApi === undefined || typeof skillsApi.register !== 'function') return
    for (const skill of entry.skills) {
      const signature = JSON.stringify([skill.description, skill.whenToUse, skill.path ?? ''])
      const existing = skillRegistrations.get(skill.name)
      if (existing !== undefined) {
        if (existing.path === entry.path && existing.signature === signature) {
          entry.dshSkills.add(skill.name)
          continue
        }
        if (existing.path !== entry.path) {
          // 同名技能先到先得：后到的文件不能抢走。
          entry.dshSkills.add(skill.name)
          continue
        }
        try {
          existing.disposer()
        } catch {
          // 忽略
        }
        skillRegistrations.delete(skill.name)
      }
      try {
        const disposer = skillsApi.register({
          name: skill.name,
          description: skill.description,
          whenToUse: skill.whenToUse,
          source: 'custom',
          provider: CONTROL_TOOL,
          invocation: { modelInvocable: true, userInvocable: true },
          // DSH 的 renderSkillContent 直接拼 skill.content，不做任何调用，
          // 所以这里必须给字符串。以前传的是函数 () => loadSkillBody(...)，
          // 结果 DSH 拿到函数就报 "content must be a string"。
          content: loadSkillBody(entry, skill),
        })
        skillRegistrations.set(skill.name, { disposer, path: entry.path, signature })
        entry.dshSkills.add(skill.name)
      } catch (error) {
        entry.error = `注册 skill ${skill.name} 失败：${String(error?.message ?? error)}`
      }
    }
    skillDigestCache = { text: '', at: 0 }
  }

  function stopFileSkills(entry) {
    for (const name of entry.dshSkills) {
      const registration = skillRegistrations.get(name)
      if (registration !== undefined && registration.path === entry.path) {
        try {
          registration.disposer()
        } catch {
          // 忽略
        }
        skillRegistrations.delete(name)
      }
    }
    entry.dshSkills.clear()
    skillDigestCache = { text: '', at: 0 }
  }

  /** 技能正文由 Python 文件提供（`--skill <name>`），文件改了正文就跟着改。 */
  function loadSkillBody(entry, skill) {
    const cached = entry.skillBodies.get(skill.name)
    if (cached !== undefined && cached.hash === entry.hash) return cached.text
    let text = ''
    const result = runSync(entry, ['--skill', skill.name], { timeoutMs: 20_000 })
    if (result.ok) text = result.stdout
    if (text.trim() === '' && skill.path !== undefined && existsSync(skill.path)) {
      try {
        text = readFileSync(skill.path, 'utf8')
      } catch {
        text = ''
      }
    }
    if (text.trim() === '') {
      text = [
        `# ${skill.name}`,
        '',
        skill.description,
        '',
        `（正文来自 Python 文件 ${entry.path}，读取失败：${result.ok ? '内容为空' : result.message}）`,
      ].join('\n')
    }
    entry.skillBodies.set(skill.name, { hash: entry.hash, text })
    return text
  }

  /**
   * 登记一个文件：读声明 -> 注册工具与技能 -> 开始盯位置。
   *
   * 这是 install / 启动 / 热更新 / 认领新位置共用的唯一入口。
   */
  async function installFile(path, { pythonPath = '', label = '', note = '', silent = false, movedFrom = null } = {}) {
    const absolute = resolve(path)
    if (!isFile(absolute)) return { ok: false, error: `找不到文件：${absolute}` }
    if (extname(absolute).toLowerCase() !== '.py') return { ok: false, error: `不是 .py 文件：${absolute}` }

    let entry = files.get(absolute)
    if (entry === undefined) {
      entry = blankEntry(absolute, { pythonPath, label, note })
      files.set(absolute, entry)
    }
    if (pythonPath !== '') entry.pythonPath = pythonPath
    if (label !== '') entry.label = label
    if (note !== '') entry.note = note

    const previousSignature = manifestSignature(entry.manifest)
    entry.hash = sha256OfFile(entry.path)
    const info = statOf(entry.path)
    entry.mtimeMs = info.mtimeMs
    entry.size = info.size
    entry.missingSince = null

    const probed = probeManifest(entry)
    if (!probed.ok) {
      entry.status = 'broken'
      entry.error = probed.error
      saveRegistrySoon()
      if (!silent) scheduleNotice(`Python tools 文件读取声明失败：${entry.path}\n${probed.error}`)
      // 旧注册保留：文件暂时坏了，不等于它声明的工具立刻不该用。
      return { ok: false, entry, error: probed.error }
    }
    if (entry.pythonPath === '' && probed.manifest.executable !== '') entry.pythonPath = probed.manifest.executable
    entry.lastInterpreter = probed.interpreter || entry.lastInterpreter || (entry.pythonPath !== '' ? entry.pythonPath : '') || (IS_WINDOWS ? 'python' : 'python3')
    entry.manifest = probed.manifest
    entry.tools = probed.manifest.tools
    entry.skills = probed.manifest.skills
    entry.followLifecycle = probed.manifest.followLifecycle === true
    entry.status = 'ready'
    entry.error = ''
    entry.lastSeenAt = now()

    // 面板上被关掉的条目不注册工具/技能；但 watcher 照样挂着，
    // 这样用户重新打开开关时不用重新扫描。
    // 内置基础设施永远视为启用（面板上也点不动）。
    if (entry.disabled === true && !isBuiltinFile(entry)) {
      stopFileTools(entry)
      stopFileSkills(entry)
    } else {
      registerFileTools(entry)
      syncFileSkills(entry)
    }
    ensureWatcher(entry)
    saveRegistrySoon()

    const nextSignature = manifestSignature(entry.manifest)
    if (!silent && movedFrom === null && entry.tools.length === 0 && entry.skills.length === 0) {
      scheduleNotice(`Python tools 文件已登记，但里面没有声明任何工具或技能：${entry.path}`)
    }
    return { ok: true, entry, changed: previousSignature !== nextSignature, previousSignature }
  }

  function uninstallFile(absolute, { reason = '手动移除', notify = true } = {}) {
    const entry = files.get(absolute)
    if (entry === undefined) return false
    stopWatcher(entry)
    stopFileTools(entry)
    stopFileSkills(entry)
    files.delete(absolute)
    saveRegistryNow()
    if (notify) scheduleNotice(`Python tools 文件已移除（${reason}）：${absolute}`)
    return true
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 5. 盯住位置：fs.watch + 轮询
  // ══════════════════════════════════════════════════════════════════════════

  function ensureWatcher(entry) {
    if (entry.fileWatcher === undefined && entry.watcher === null && entry.watcherController === null) {
      const fsService = ctx.get('fs')
      if (fsService !== undefined && typeof fsService.watch === 'function' && typeof fsService.resolve === 'function') {
        const controller = new AbortController()
        entry.watcherController = controller
        fsService.resolve(entry.path)
          .then((target) => fsService.watch(target, (error) => {
            if (error !== undefined) {
              // 监控自身坏了：撤掉它，轮询继续负责。
              stopFsWatcher(entry)
              return
            }
            scheduleRecheck(entry, 'fs.watch')
          }, controller.signal))
          .then((close) => {
            entry.watcher = close
          })
          .catch(() => {
            stopFsWatcher(entry)
          })
      }
    }
    // 轮询是第二道保险：跨盘移动、另存为、网络盘、漏报的 rename 都能兜住。
    if (entry.pollTimer === null) {
      const interval = Math.max(400, Number(config.pollMs) || 1500)
      entry.pollTimer = setInterval(() => scheduleRecheck(entry, 'poll'), interval)
      if (typeof entry.pollTimer?.unref === 'function') entry.pollTimer.unref()
    }
  }

  function stopFsWatcher(entry) {
    const controller = entry.watcherController
    entry.watcherController = null
    try {
      controller?.abort()
    } catch {
      // 已经关了
    }
    const close = entry.watcher
    entry.watcher = null
    if (typeof close === 'function') Promise.resolve(close()).catch(() => {})
  }

  function stopWatcher(entry) {
    stopFsWatcher(entry)
    if (entry.pollTimer !== null) {
      clearInterval(entry.pollTimer)
      entry.pollTimer = null
    }
    if (entry.recheckTimer !== null) {
      clearTimeout(entry.recheckTimer)
      entry.recheckTimer = null
    }
  }

  /** 短时间内的多个事件合成一次核查。 */
  function scheduleRecheck(entry, trigger) {
    if (!files.has(entry.path)) return
    if (entry.recheckTimer !== null) return
    entry.recheckTimer = setTimeout(() => {
      entry.recheckTimer = null
      recheck(entry, trigger).catch(() => {})
    }, 120)
    if (typeof entry.recheckTimer?.unref === 'function') entry.recheckTimer.unref()
  }

  /**
   * 一次位置核查。
   *
   * - 文件还在、内容没变：什么都不做。
   * - 文件还在、内容变了：重新读声明（用户改代码 = 热更新，不用重装）。
   * - 文件不在：进入「找新位置」；找不到就先标记 missing 并下线它的工具。
   */
  async function recheck(entry, trigger) {
    if (!files.has(entry.path)) return
    if (!isFile(entry.path)) {
      if (entry.status === 'missing') return
      entry.status = 'relocating'
      entry.missingSince = entry.missingSince ?? now()
      const found = await locateMovedFile(entry)
      if (found !== null) {
        await relocate(entry, found, trigger)
        return
      }
      entry.status = 'missing'
      stopFileTools(entry)
      stopFileSkills(entry)
      saveRegistrySoon()
      scheduleNotice([
        `⚠️ Python tools 文件从原位置消失了：${entry.path}`,
        `它的工具已下线。插件仍在按内容哈希找它（同名或同内容都认），`,
        `找到后会自动在新位置重新注册；也可以把文件放回原处，或 pytools install 新位置。`,
      ].join('\n'))
      return
    }
    if (entry.status === 'missing' || entry.status === 'relocating') {
      // 文件回来了（用户撤销了移动/删除）
      const restored = await installFile(entry.path, {
        pythonPath: entry.pythonPath,
        label: entry.label,
        note: entry.note,
        silent: true,
      })
      scheduleNotice(restored.ok
        ? `Python tools 文件已回到原位置并恢复：${entry.path} → ${summaryOfManifest(entry.manifest)}`
        : `Python tools 文件回来了，但读取失败：${entry.path}\n${entry.error}`)
      return
    }
    const info = statOf(entry.path)
    if (info.mtimeMs !== entry.mtimeMs || info.size !== entry.size) {
      const oldHash = entry.hash
      const oldSignature = manifestSignature(entry.manifest)
      const result = await installFile(entry.path, {
        pythonPath: entry.pythonPath,
        label: entry.label,
        note: entry.note,
        silent: true,
      })
      if (result.ok && (oldHash !== entry.hash || oldSignature !== manifestSignature(entry.manifest))) {
        scheduleNotice(`🔄 Python tools 文件内容已更新（热更新，无需重装）：${entry.path} → ${summaryOfManifest(entry.manifest)}`)
      }
      return
    }
    entry.lastSeenAt = entry.lastSeenAt ?? now()
  }

  /**
   * 找被移动的文件。
   *
   * 只有内容哈希完全一致才认领，避免把同名但内容不同的文件误认成同一个。
   * 搜索范围：config.locateRoots + 所有已知文件所在目录。
   */
  function locateMovedFile(entry) {
    if (entry.hash === '') return null
    const wanted = entry.hash
    const oldName = basename(entry.path)
    const index = buildIndex()
    const tried = new Set([entry.path])
    const consider = (candidate) => {
      if (tried.has(candidate)) return null
      tried.add(candidate)
      if (!isFile(candidate)) return null
      if (sha256OfFile(candidate) !== wanted) return null
      return { path: candidate, how: basename(candidate) === oldName ? 'same-name' : 'same-content' }
    }
    // ① 同名文件（用户只是挪了目录）
    for (const candidate of index.byName.get(oldName) ?? []) {
      const hit = consider(candidate)
      if (hit !== null) return hit
    }
    // ② 同内容文件（用户连名字一起改了）
    for (const candidate of index.byHash.get(wanted) ?? []) {
      const hit = consider(candidate)
      if (hit !== null) return hit
    }
    // ③ 老目录就在旁边：现场再搜一遍（索引可能还没刷新）
    for (const candidate of scanForName(dirname(entry.path), oldName, wanted)) {
      const hit = consider(candidate)
      if (hit !== null) return hit
    }
    return null
  }

  function scanRoots() {
    const roots = new Set()
    for (const item of Array.isArray(config.locateRoots) ? config.locateRoots : []) {
      if (typeof item === 'string' && item !== '') roots.add(resolve(item))
    }
    for (const entry of files.values()) roots.add(dirname(entry.path))
    return [...roots]
  }

  function buildIndex() {
    const ttl = Math.max(500, Number(config.scanTtlMs) || 5000)
    const roots = scanRoots()
    const key = roots.join('\x1f')
    if (locateCache !== null && now() - locateCache.at < ttl && locateCache.key === key) return locateCache
    const byName = new Map()
    const byHash = new Map()
    const budget = { left: Math.max(200, Number(config.maxScanFiles) || 20_000) }
    for (const root of roots) walkDirectory(root, byName, byHash, budget, 0)
    locateCache = { at: now(), key, byName, byHash }
    return locateCache
  }

  const SKIP_DIRS = /^(node_modules|\.git|\.hg|__pycache__|venv|\.venv|site-packages|Windows|WinSxS|AppData)$/iu

  /**
   * 递归搜一个目录，收集 .py 的名字索引与内容哈希索引。
   *
   * `depth` 是相对**搜索根**的层数，不是相对盘符：搜索根是 Desktop 时，
   * `Desktop\a\b` 的绝对路径深度是 4，但相对搜索根只有 2，不能算超深。
   */
  function walkDirectory(root, byName, byHash, budget, depth) {
    if (budget.left <= 0) return
    const maxDepth = Math.max(1, Number(config.scanDepth) || 6)
    if (depth > maxDepth) return
    let names
    try {
      names = readdirSync(root)
    } catch {
      return
    }
    for (const name of names) {
      if (budget.left <= 0) return
      if (name.startsWith('.') || name.startsWith('$')) continue
      const full = join(root, name)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (SKIP_DIRS.test(name)) continue
        walkDirectory(full, byName, byHash, budget, depth + 1)
        continue
      }
      if (!stat.isFile()) continue
      if (extname(name).toLowerCase() !== '.py') continue
      budget.left -= 1
      push(byName, name, full)
      if (stat.size > 0 && stat.size <= 4 * 1024 * 1024) {
        const hash = sha256OfFile(full)
        if (hash !== '') push(byHash, hash, full)
      }
    }
  }

  function push(map, key, value) {
    const list = map.get(key)
    if (list === undefined) map.set(key, [value])
    else if (!list.includes(value)) list.push(value)
  }

  function scanForName(root, name, wanted) {
    const hits = []
    if (!existsSync(root)) return hits
    const budget = { left: Math.max(500, Number(config.maxScanFiles) || 20_000) }
    const stack = [root]
    let depthGuard = 0
    while (stack.length > 0 && budget.left > 0 && depthGuard < 200_000) {
      depthGuard += 1
      const current = stack.pop()
      let names
      try {
        names = readdirSync(current)
      } catch {
        continue
      }
      for (const child of names) {
        if (budget.left <= 0) break
        if (child.startsWith('.') || SKIP_DIRS.test(child)) continue
        const full = join(current, child)
        let stat
        try {
          stat = statSync(full)
        } catch {
          continue
        }
        if (stat.isDirectory()) {
          stack.push(full)
          continue
        }
        budget.left -= 1
        if (stat.isFile() && child === name && sha256OfFile(full) === wanted) hits.push(full)
      }
    }
    return hits
  }

  /** 认领新位置：保留历史（调用次数、安装时间、备注），换路径重新注册。 */
  async function relocate(entry, found, trigger) {
    const previousPath = entry.path
    const previousDir = dirname(previousPath)
    const nextDir = dirname(found.path)
    stopWatcher(entry)
    files.delete(previousPath)
    entry.path = resolve(found.path)
    if (entry.label === basename(previousPath)) entry.label = basename(entry.path)
    entry.moves += 1
    entry.lastMove = {
      at: now(),
      from: previousPath,
      to: entry.path,
      how: found.how,
      via: trigger,
    }
    entry.missingSince = null
    entry.status = 'pending'
    entry.skillBodies = new Map()
    entry.dshSkills = new Set()
    // 路径变了，本文件旧的工具注册必须在换路径之前撤掉：撤销靠的是「工具名 -> 路径」
    // 这个映射，路径一变就找不到它们，名字会被自己的幽灵条目堵住。
    // 然后立即用新的默认名字重新注册，让工具名不因路径变化而漂移。
    files.set(entry.path, entry)
    locateCache = null
    const result = await installFile(entry.path, {
      pythonPath: entry.pythonPath,
      label: entry.label,
      note: entry.note,
      silent: true,
      movedFrom: previousPath,
    })
    saveRegistryNow()
    const dirNote = previousDir === nextDir ? '' : `\n  目录也从 ${previousDir} 变成了 ${nextDir}`
    scheduleNotice([
      '📍 Python tools 文件位置变了，已自动重新认领：',
      `  旧位置：${previousPath}`,
      `  新位置：${entry.path}${dirNote}`,
      `  依据：${found.how === 'same-content' ? '内容哈希一致（连文件名都改过也认得）' : '同名 + 内容哈希一致'}`,
      result.ok
        ? `  已在新位置注册：${summaryOfManifest(entry.manifest)}`
        : `  新位置读取失败：${entry.error}`,
    ].join('\n'))
    return result
  }

  /** 全量核查（启动时、以及 pytools relocate）。 */
  async function auditAll() {
    const report = []
    for (const entry of [...files.values()]) {
      if (!isFile(entry.path)) {
        entry.status = 'relocating'
        const found = locateMovedFile(entry)
        if (found !== null) {
          await relocate(entry, found, 'audit')
          report.push({
            path: entry.path,
            status: 'moved',
            from: entry.lastMove?.from ?? '',
            how: entry.lastMove?.how ?? '',
            tools: [...entry.dshTools.values()],
            skills: [...entry.dshSkills],
          })
          continue
        }
        entry.status = 'missing'
        stopFileTools(entry)
        stopFileSkills(entry)
        ensureWatcher(entry)
        report.push({ path: entry.path, status: 'missing' })
        continue
      }
      if (entry.status === 'missing' || entry.status === 'relocating') {
        await installFile(entry.path, { pythonPath: entry.pythonPath, silent: true })
      } else {
        ensureWatcher(entry)
      }
      report.push({ path: entry.path, status: entry.status, tools: [...entry.dshTools.values()], skills: [...entry.dshSkills] })
    }
    saveRegistrySoon()
    return report
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 6. 调用：JSON 下去，流帧 + 结果帧回来
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * 调用一个 Python 工具。
   *
   *   1. 写调用帧（tool + arguments）到临时目录；
   *   2. 启动 `python <file> __pytools_call__`，环境变量指出帧在哪；
   *   3. 边跑边读它追加进流文件的帧（data / notify / log / progress）——
   *      这就是「来自朋友 python 的反馈和数据」，原样放回工具结果；
   *   4. 读结果帧，把 value / error 交回模型。
   *
   * Python 不必常驻、不必装包、不必开端口：一个文件就是全部接口。
   */
  async function callPythonTool(entry, tool, args, signal) {
    // 调用前最后确认一次位置：上一轮对话之后文件可能被挪走了。
    if (!isFile(entry.path)) {
      const found = locateMovedFile(entry)
      if (found === null) {
        entry.status = 'missing'
        stopFileTools(entry)
        stopFileSkills(entry)
        saveRegistrySoon()
        return {
          ok: false,
          file: entry.path,
          tool: tool.name,
          error: {
            type: 'FileMissing',
            message: `Python 文件不在原处（${entry.path}），也没能在已知目录里按内容哈希找回。它的工具已下线；请 pytools install 新位置，或把文件放回原处。`,
          },
          events: [],
          location: currentLocation(entry),
        }
      }
      await relocate(entry, found, 'call')
    }
    const limit = Math.max(1, Number(config.maxConcurrent) || 4)
    // 以前：并发数一满就直接返回 Busy，多个调用只能失败一个等一个。
    // 现在：排队 —— 等一个位置出来再跑，谁先到谁先上，超时才算放弃。
    const waitStarted = now()
    const maxWaitMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, Number(config.queueTimeoutMs) || 600_000))
    while (running.size >= limit) {
      if (now() - waitStarted > maxWaitMs) {
        return {
          ok: false,
          file: entry.path,
          tool: tool.name,
          error: {
            type: 'QueueTimeout',
            message: `排队超过 ${Math.round(maxWaitMs / 1000)} 秒还没轮到（并发上限 ${limit}）。已运行的：${[...running].join(', ') || '无'}`,
          },
          events: [],
          location: currentLocation(entry),
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    const callId = `pt_${now().toString(36)}_${randomTag()}`
    const dir = tempDir()
    const callFile = join(dir, `${callId}.call.json`)
    const resultFile = join(dir, `${callId}.result.json`)
    const streamFile = join(dir, `${callId}.stream.log`)
    try {
      mkdirSync(dir, { recursive: true })
      writeAtomic(callFile, JSON.stringify({
        protocol: 'pytools/1',
        callId,
        tool: tool.name,
        dshName: entry.dshTools.get(tool.name) ?? tool.name,
        arguments: args,
        file: entry.path,
        cwd: dirname(entry.path),
        startedAt: now() / 1000,
      }))
      writeFileSync(streamFile, '', 'utf8')
    } catch (error) {
      return {
        ok: false,
        file: entry.path,
        tool: tool.name,
        error: { type: 'IoError', message: `无法准备调用帧：${String(error?.message ?? error)}` },
        events: [],
        location: currentLocation(entry),
      }
    }

    const state = { events: [], offset: 0, partial: '' }
    running.add(callId)
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, tool.timeoutMs || DEFAULT_TIMEOUT_MS)
    const pump = setInterval(() => drainStream(state, streamFile), 70)
    if (typeof pump?.unref === 'function') pump.unref()

    let outcome
    try {
      outcome = await runAsync(entry, [CLI_SUBCOMMAND], {
        timeoutMs,
        signal,
        env: {
          PYTOOLS_CALL_FILE: callFile,
          PYTOOLS_RESULT_FILE: resultFile,
          PYTOOLS_STREAM_FILE: streamFile,
          PYTOOLS_CALL_ID: callId,
        },
      })
    } finally {
      clearInterval(pump)
      drainStream(state, streamFile)
      running.delete(callId)
      // 调用帧里有参数，可能含敏感内容：用完即删。
      safeUnlink(callFile)
    }

    const finishedAt = now()
    entry.calls += 1
    entry.lastCallAt = finishedAt
    entry.lastSeenAt = finishedAt
    saveRegistrySoon()

    const resultFrame = readResultFrame(resultFile)
    safeUnlink(resultFile)
    safeUnlink(streamFile)

    let value = null
    let valueText = ''
    let error = null
    if (resultFrame !== null) {
      if (resultFrame.ok === true) {
        value = resultFrame.value ?? null
        valueText = typeof value === 'string' ? value : pretty(value)
      } else {
        error = normalizeError(resultFrame.error) ?? { type: 'PythonError', message: 'Python 返回失败但没有给原因' }
      }
    } else if (outcome.code === 'TIMEOUT') {
      error = { type: 'Timeout', message: `Python 工具超时（${timeoutMs}ms）：${entry.path}` }
    } else if (!outcome.ok) {
      error = {
        type: outcome.code,
        message: outcome.message || 'python 执行失败',
        stderr: tail(outcome.stderr, 4000),
      }
    } else {
      error = {
        type: 'NoResultFrame',
        message: 'Python 进程正常退出，但没有写结果帧。文件里可能调用了 sys.exit()，或者 main() 没走到写结果那一步。',
        stderr: tail(outcome.stderr, 4000),
      }
    }
    if (error !== null && typeof error.message === 'string' && error.message.includes('ModuleNotFoundError') === false) {
      // 常见失败给出可执行的下一步
      if (error.type === 'ModuleNotFoundError' || /No module named 'pytools_client'/u.test(`${error.message} ${error.stderr ?? ''}`)) {
        error.message += `\n提示：需要把 ${join(MODULE_DIR, 'pytools_client.py')} 放到这个文件旁边，或设置 PYTHONPATH 指向它。`
      }
    }

    // 调用期间文件被挪走了：顺手处理，下一次调用就能找到。
    if (!isFile(entry.path)) scheduleRecheck(entry, 'post-call')

    const startedAt = Number.isFinite(resultFrame?.startedAt) ? Math.round(resultFrame.startedAt * 1000) : finishedAt - (outcome.durationMs ?? 0)
    const payload = {
      ok: error === null,
      file: entry.path,
      tool: tool.name,
      dshName: entry.dshTools.get(tool.name) ?? tool.name,
      callId,
      durationMs: Math.max(0, finishedAt - startedAt),
      value,
      valueText,
      events: state.events,
      ...(state.dropped ? { eventsDropped: state.dropped } : {}),
      location: currentLocation(entry),
    }
    if (error !== null) payload.error = error
    return lossless(payload)
  }

  /** 追一次流文件：只处理新增的完整行，半行留到下次。 */
  function drainStream(state, streamFile) {
    let text
    try {
      const buffer = readFileRange(streamFile, state.offset, MAX_POLL_BYTES)
      if (buffer.length === 0) return
      state.offset += buffer.length
      text = buffer.toString('utf8')
    } catch {
      return
    }
    const combined = state.partial + text
    const lines = combined.split('\n')
    state.partial = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trim()
      if (line === '') continue
      const marker = line.indexOf(FRAME_BEGIN)
      if (marker < 0) continue
      const json = line.slice(marker + FRAME_BEGIN.length).trim()
      if (json === '') continue
      let frame
      try {
        frame = JSON.parse(json)
      } catch {
        continue
      }
      if (state.events.length >= MAX_EVENT_BACKLOG) {
        // 上限是保护，不是静默丢失：丢了多少要能说清楚，否则 600 帧看起来像 500 帧，
        // 而且从第 100 帧开始，读的人根本不知道前面还有。
        state.events.shift()
        state.dropped = (state.dropped ?? 0) + 1
      }
      state.events.push({
        kind: typeof frame?.kind === 'string' ? frame.kind : 'data',
        payload: frame?.payload ?? null,
        // 只有数据帧的 dataType 有意义：它说明「这段数据是什么」。插件原样转交，不解释。
        ...(typeof frame?.dataType === 'string' && frame.dataType !== '' ? { dataType: frame.dataType } : {}),
        at: Number.isFinite(frame?.t) ? Math.round(frame.t * 1000) : now(),
      })
    }
  }

  function readResultFrame(file) {
    let stat
    try {
      stat = statSync(file)
    } catch {
      return null
    }
    if (stat.size > MAX_RESULT_FRAME_BYTES) return null
    return readJsonOrNull(file)
  }

  function normalizeError(error) {
    if (typeof error === 'string') return { type: 'PythonError', message: error }
    if (!isObject(error)) return null
    return {
      type: typeof error.type === 'string' ? error.type : 'PythonError',
      message: typeof error.message === 'string' ? error.message : pretty(error),
      ...(typeof error.traceback === 'string' ? { traceback: error.traceback } : {}),
      ...(typeof error.stderr === 'string' ? { stderr: error.stderr } : {}),
    }
  }

  /** 一个文件此刻的位置状态。 */
  function currentLocation(entry) {
    const present = isFile(entry.path)
    return {
      path: entry.path,
      label: entry.label,
      status: present ? entry.status : (entry.status === 'relocating' ? 'relocating' : 'missing'),
      present,
      watched: entry.watcher !== null || entry.pollTimer !== null,
      moves: entry.moves,
      lastMove: entry.lastMove,
      hash: entry.hash.slice(0, 16),
      mtime: entry.mtimeMs,
      size: entry.size,
      lastSeenAt: entry.lastSeenAt,
    }
  }

  /** 结果卡片：模型读到的就是这段文字。 */
  function renderCall(value) {
    if (!isObject(value)) return [{ type: 'text', text: pretty(value) }]
    const lines = []
    lines.push(`${value.ok === true ? '✅' : '❌'} ${value.tool ?? 'python tool'} · ${value.file ?? ''} · ${value.durationMs ?? '?'}ms`)
    if (value.ok === true) {
      lines.push('')
      const body = typeof value.valueText === 'string' && value.valueText !== '' ? value.valueText : pretty(value.value)
      lines.push(body.length > 20_000 ? `${body.slice(0, 20_000)}\n…（已截断）` : body)
    } else if (isObject(value.error)) {
      lines.push('')
      lines.push(`错误（${value.error.type ?? 'Error'}）：${value.error.message ?? pretty(value.error)}`)
      if (typeof value.error.stderr === 'string' && value.error.stderr.trim() !== '') {
        lines.push('', 'stderr：', tail(value.error.stderr, 4000))
      }
      if (typeof value.error.traceback === 'string' && value.error.traceback.trim() !== '') {
        lines.push('', 'traceback：', tail(value.error.traceback, 4000))
      }
    }
    const events = Array.isArray(value.events) ? value.events : []
    if (events.length > 0) {
      const dropped = Number(value.eventsDropped) || 0
      lines.push('', `Python 反馈（${events.length} 帧${dropped > 0 ? `，另有 ${dropped} 帧因超出上限未保留` : ''}）：`)
      for (const event of events.slice(-40)) {
        const kind = event.kind ?? 'data'
        if (kind === 'done') continue
        if (kind === 'notify') lines.push(`  · [通知] ${String(event.payload ?? '')}`)
        else if (kind === 'log') lines.push(`  · [日志/${event.payload?.level ?? 'info'}] ${event.payload?.message ?? pretty(event.payload)}`)
        else if (kind === 'progress') lines.push(`  · [进度] ${Math.round((Number(event.payload?.value) || 0) * 100)}% ${event.payload?.message ?? ''}`)
        else if (kind === 'event') lines.push(`  · [事件] ${pretty(event.payload)}`)
        else if (kind === 'ack') lines.push(`  · [动作已收到] ${event.payload?.actionId ?? ''}`)
        else if (kind === 'result') lines.push(`  · [动作完成] ${event.payload?.actionId ?? ''} ${event.payload?.ok === false ? '（失败）' : ''} ${pretty(event.payload?.value ?? event.payload?.error ?? '')}`.trimEnd())
        else if (kind === 'done') { /* 结束标记，不单独占一行 */ }
        else if (typeof event.dataType === 'string' && event.dataType !== '') lines.push(`  · [数据/${event.dataType}] ${pretty(event.payload)}`)
        else lines.push(`  · [数据] ${pretty(event.payload)}`)
      }
    }
    if (isObject(value.location) && Number(value.location.moves) > 0) {
      lines.push('', `📍 该文件移动过 ${value.location.moves} 次，当前位于 ${value.location.path}`)
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 7. 提示词与通知：让 agent 知道「有哪些 Python 工具、在哪」
  // ══════════════════════════════════════════════════════════════════════════

  function scheduleNotice(text) {
    pendingNotices.push({ at: now(), text })
    if (pendingNotices.length > 30) pendingNotices.shift()
  }

  function fileStateBadge(entry) {
    if (!isFile(entry.path)) {
      const age = entry.missingSince === null ? 0 : now() - entry.missingSince
      return age < 10_000 ? '🔎 刚被移走，正在找' : '❌ 不在原位置'
    }
    if (entry.status === 'broken') return '⚠️ 声明读不出来'
    return '✅'
  }

  function filesSummaryLines() {
    const entries = [...files.values()]
    if (entries.length === 0) return ['（这台机器上还没有登记任何 Python tools 文件）']
    return entries.map((entry) => {
      const bits = [`${fileStateBadge(entry)} \`${entry.path}\``]
      const tools = [...entry.dshTools.values()]
      bits.push(tools.length === 0 ? '工具：无' : `工具：${tools.join(', ')}`)
      if (entry.dshSkills.size > 0) bits.push(`技能：${[...entry.dshSkills].join(', ')}`)
      if (entry.note !== '') bits.push(`备注：${entry.note}`)
      return `- ${bits.join(' | ')}`
    })
  }

  function skillDigest() {
    const ttl = Math.max(500, Number(config.skillDigestTtlMs) || 3000)
    if (skillDigestCache.text !== '' && now() - skillDigestCache.at < ttl) return skillDigestCache.text
    const lines = []
    for (const entry of files.values()) {
      if (!isFile(entry.path)) continue
      for (const skill of entry.skills) {
        if (!entry.dshSkills.has(skill.name)) continue
        lines.push(`  · \`${skill.name}\` — ${skill.description}（来自 ${entry.path}）`)
      }
    }
    const text = lines.join('\n')
    skillDigestCache = { text, at: now() }
    return text
  }

  /**
   * 插件自带的规范文档（skills/*.md）也注册成技能。
   *
   * 以前它们是「写在文件夹里的 markdown」：提示词里叫你去看 `pytools-authoring`，
   * 但技能目录里根本没有这两个名字，agent 只能手动翻文件、甚至以为不需要看。
   * 现在直接注册进来，`skill` 工具按名字就能加载。
   */
  function registerBuiltinSkills() {
    if (skillsApi === undefined || typeof skillsApi.register !== 'function') return
    const builtins = [
      {
        name: 'pytools-authoring',
        description: '如何写一个 Python tools 文件（用 pytools_client 声明工具与技能），以及登记/更新/移动它时会发生什么。',
        whenToUse: '当用户想要新的能力、想脚本化一件事、需要写/改一个 .py 工具文件，或者需要理解某个 Python 工具为什么不工作时。',
        file: 'pytools-authoring.md',
      },
      {
        name: 'pytools-offline-protocol',
        description: 'Python Tools 调用协议的精确格式（调用帧 / 流帧 / 结果帧 / 环境变量），不用 pytools_client 也能对接。',
        whenToUse: '当需要用别的语言、别的 Python 环境、或手工构造一次调用；或者要调试「工具结果为什么是空的」。',
        file: 'pytools-offline-protocol.md',
      },
    ]
    for (const item of builtins) {
      if (skillRegistrations.has(item.name)) continue
      const file = join(MODULE_DIR, 'skills', item.file)
      if (!isFile(file)) continue
      try {
        const disposer = skillsApi.register({
          name: item.name,
          description: item.description,
          whenToUse: item.whenToUse,
          source: 'custom',
          provider: CONTROL_TOOL,
          invocation: { modelInvocable: true, userInvocable: true },
          content: () => readFileSync(file, 'utf8'),
        })
        skillRegistrations.set(item.name, { disposer, path: file, signature: 'builtin' })
      } catch {
        // 注册不上也不影响工具本身
      }
    }
    skillDigestCache = { text: '', at: 0 }
  }

  function registerPromptContributions(api) {    // 变更通知：只在真发生移动/增删/热更新时出现，读完即清。
    ctx.effect(() => api.context({
      name: 'python-tools-notices',
      order: 962,
      text: () => {
        if (pendingNotices.length === 0) return ''
        const blocks = pendingNotices.map((notice) => notice.text)
        pendingNotices.length = 0
        return blocks.join('\n\n')
      },
    }), 'python-tools: change notices')

    // 常驻清单：哪些 Python 工具存在、在哪、活着没。文件为零时不占提示词。
    ctx.effect(() => api.section({
      name: 'python-tools',
      order: 645,
      text: () => {
        if (files.size === 0) return ''
        const digest = skillDigest()
        const lines = [
          '## Python Tools（这台机器上的 Python 扩展）',
          '',
          '下列 `.py` 文件各自声明了若干 DSH 工具与技能，由一个只做转发的 `pytools` 插件登记并调用。',
          '它们和内置工具一样直接可用；需要新能力而清单里没有时，写一个 `.py` 再 `pytools install`，',
          '不用写插件、不用重启。清单是实时状态：',
          '',
          ...filesSummaryLines(),
        ]
        if (digest !== '') {
          lines.push('', '可用的 Python 技能（用 `skill` 工具按名字加载正文）：', digest)
        }
        lines.push(
          '',
          '要点：',
          '- Python 函数就是工具；返回值和它执行中推回的数据帧都会出现在结果里。',
          '- 改了文件就是改了工具（插件自动重读）；报错与 traceback 会原样回到结果里。',
          '- 文件被移动或改名时，插件按内容哈希找回新位置，并在下一轮对话里告知你。',
          '',
          '**写新工具前先读这些（省掉反复试错）：**',
          `- 总览与 30 秒模板：文件 \`${join(MODULE_DIR, 'AGENTS.md')}\``,
          `- 写法细则：文件 \`${join(MODULE_DIR, 'skills', 'pytools-authoring.md')}\``,
          `- 协议格式：文件 \`${join(MODULE_DIR, 'skills', 'pytools-offline-protocol.md')}\``,
          '（这三份也已注册为技能 `pytools-authoring` / `pytools-offline-protocol`，能加载就优先用技能。）',
          '',
          '三条铁律：',
          '1. 只传指令和数据，不要为某个功能加专用接口；功能差异全在 Python 文件里实现。',
          '2. 工具文件必须带 `if __name__ == "__main__": main()`，否则插件读不到它的工具。',
          '3. 注释不要用 `─` 制表符装饰线（会吞行，报出看不懂的 `str is not callable`）。',
          '',
          '卡住时的第一条命令：`python <你的文件> --doctor`，它会把解释器、路径、协议、问题一次说清。',
        )
        return lines.join('\n')
      },
    }), 'python-tools: prompt section')
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 8. `pytools` 工具：登记 / 查看 / 移除 / 核对位置
  // ══════════════════════════════════════════════════════════════════════════

  function registerControlTool() {
    // 启动瞬间 `tools` 服务不一定已挂上；直接 ctx.get 拿到 undefined 会静默 return，
    // 结果就是 `pytools` 工具凭空消失（实测踩过）。改成 inject：服务到了再注册。
    const attach = (registry) => {
      if (registry === undefined || typeof registry.register !== 'function') return
      ctx.effect(() => registry.register({
        name: CONTROL_TOOL,
        description: [
          'Python Tools 的总开关（本插件自身没有任何功能，只负责转发）。',
          '任意 Python 文件调用 pytools_client.register() 之后，用 install 把它登记进来：',
          '文件里每个注册的函数立刻成为一个可以像内置工具那样调用的 DSH 工具，',
          '它声明的 markdown 立刻出现在技能目录里。登记会持久化，重启后仍在。',
          '插件持续盯住文件位置：被移动/改名会按内容哈希自动找回新位置并重新注册，',
          '被删除会下线它的工具并在下一轮对话中告知。',
          'list 看现状，probe 只读地试读一个文件声明了什么（不登记），relocate 立刻全量核对位置。',
        ].join(' '),
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'install', 'remove', 'relocate', 'inspect', 'probe', 'pids', 'kill', 'channel', 'send'],
              description: 'list=已登记文件与位置状态；install=登记；remove=撤销；relocate=立刻核对位置；inspect=一个文件的详情；probe=只读试读声明；pids/kill=看/停自己起的 python 进程；send=给 python 投一个动作（写进它的邮箱，由它自己决定怎么处理）。',
            },
            path: {
              type: 'string',
              description: 'install/remove/inspect/probe 的目标 .py 文件路径（相对路径按会话工作目录解析）。',
            },
            pythonPath: {
              type: 'string',
              description: 'install 时指定解释器（默认自动查找：登记的 > PYTOOLS_PYTHON > PATH 里的 python/python3/py）。',
            },
            label: {
              type: 'string',
              description: 'install 时的短名字，用于展示和避免工具重名。',
            },
            note: {
              type: 'string',
              description: 'install 时记一条备注。',
            },
            watch: {
              type: 'array',
              items: { type: 'string' },
              description: '附加的搜索目录：文件可能被移动到这里（也用于之后找新位置）。',
            },
            name: {
              type: 'string',
              description: 'send 时的动作名，例如 "resize"。python 那边按名字自己决定做什么。',
            },
            arguments: {
              type: 'object',
              additionalProperties: true,
              description: 'send 时的动作参数（任意 JSON），原样交给 python。',
            },
            actionId: {
              type: 'string',
              description: 'send 时的动作 id（可选，不传自动生成）；python 回反馈时用它对齐。',
            },
          },
          required: ['action'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: true,
            properties: {
              action: { type: 'string' },
              ok: { type: 'boolean' },
              files: { type: 'array', items: { type: 'object', additionalProperties: true } },
              file: { type: 'object', additionalProperties: true },
              manifest: { type: 'object', additionalProperties: true },
              message: { type: 'string' },
            },
          },
            render: (_args, value) => renderControl(value),
          },
          timeoutMs: 120_000,
          execute: (args, exec) => controlAction(args, exec),
        }), 'python-tools: control tool')
    }

    const inline = ctx.get('tools')
    if (inline !== undefined && typeof inline.register === 'function') {
      attach(inline)
      return
    }
    ctx.inject(['tools'], (scoped) => attach(scoped.tools))
  }

  /** `pytools` 的六个动作。返回值最后统一走 lossless()。 */
  async function controlAction(args, exec) {
    const response = await controlActionRaw(args, exec)
    return lossless(response)
  }

  async function controlActionRaw(args, exec) {
    {
        const action = typeof args?.action === 'string' ? args.action : 'list'
        const cwd = resolveCwd(exec)
        const rawPath = typeof args?.path === 'string' ? args.path.trim() : ''
        const path = rawPath === '' ? '' : (isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath))
        if (Array.isArray(args?.watch)) {
          config.locateRoots = mergeRoots(config.locateRoots, args.watch, cwd)
          locateCache = null
        }
        if (action === 'install') {
          if (path === '') return { action, ok: false, message: 'install 需要 path' }
          const result = await installFile(path, {
            pythonPath: typeof args?.pythonPath === 'string' ? args.pythonPath : '',
            label: typeof args?.label === 'string' ? args.label : '',
            note: typeof args?.note === 'string' ? args.note : '',
          })
          saveRegistryNow()
          if (!result.ok) {
            // file 是 object 类型：给 null 会被 DSH 判为非法输出，整条结果被丢掉，
            // 用户就看不到「登记失败」的真正原因了。没有条目就干脆不带这个字段。
            return { action, ok: false, message: `登记失败：${result.error}`, ...(result.entry === undefined ? {} : { file: describeFile(result.entry) }) }
          }
          const movedTo = result.entry.path !== path ? `（实际登记在 ${result.entry.path}）` : ''
          return {
            action,
            ok: true,
            file: describeFile(result.entry),
            message: `已登记 ${result.entry.path}${movedTo}：${summaryOfManifest(result.entry.manifest)}`,
          }
        }
        if (action === 'remove') {
          if (path === '') return { action, ok: false, message: 'remove 需要 path' }
          const entry = [...files.values()].find((item) => item.path === resolve(path))
          if (entry === undefined) return { action, ok: false, message: `没有登记过 ${path}` }
          uninstallFile(entry.path, { reason: '经 pytools remove', notify: false })
          return { action, ok: true, message: `已移除 ${entry.path}（它的工具与技能已下线，文件本身没有动）` }
        }
        if (action === 'inspect') {
          if (path === '') return { action, ok: true, files: [...files.values()].map(describeFile) }
          const entry = [...files.values()].find((item) => item.path === resolve(path))
          return { action, ok: entry !== undefined, message: entry === undefined ? `没有登记过 ${path}` : '', ...(entry === undefined ? {} : { file: describeFile(entry) }) }
        }
        if (action === 'probe') {
          if (path === '') return { action, ok: false, message: 'probe 需要 path' }
          const probeEntry = blankEntry(resolve(path), {})
          const probed = probeManifest(probeEntry)
          if (!probed.ok) return { action, ok: false, message: `读不出 ${path} 的声明：${probed.error}` }
          return {
            action,
            ok: true,
            manifest: probed.manifest,
            message: `${path} 声明了 ${summaryOfManifest(probed.manifest)}（python ${probed.manifest.python || '?'}）`,
          }
        }
        if (action === 'relocate') {
          const report = await auditAll()
          saveRegistryNow()
          return { action, ok: true, files: report, message: `核对完成：${report.length} 个文件` }
        }
        if (action === 'channel') {
          // 诊断：反向通道到底能不能用。重启后用来验证。
          const agent = lastSeenAgent
          const caps = {
            steer: typeof agent?.steer === 'function',
            followup: typeof agent?.followup === 'function',
            cancel: typeof agent?.cancel === 'function',
          }
          let pendingFiles = []
          try {
            pendingFiles = readdirSync(REQUESTS_DIR).filter((n) => n.endsWith('.jsonl'))
          } catch {
            pendingFiles = []
          }
          return {
            action,
            ok: true,
            agentCaptured: agent !== undefined && agent !== null,
            agentId: agent?.id ?? null,
            capabilities: caps,
            requestsDir: REQUESTS_DIR,
            requestFiles: pendingFiles,
            message: agent === undefined || agent === null
              ? '还没捕获到 agent。调一次任意 Python 工具后就会捕获。'
              : `agent 已捕获，能力：${Object.entries(caps).filter(([, v]) => v).map(([k]) => k).join(', ') || '（都没有）'}`,
          }
        }
        if (action === 'pids') {
          const list = [...spawnedPids.entries()].map(([pid, info]) => ({
            pid,
            path: info.path,
            runningMs: Math.round(now() - info.startedAt),
          }))
          return {
            action,
            ok: true,
            pids: list,
            message: list.length === 0
              ? '当前没有正在跑的 python 调用'
              : `${list.length} 个正在跑的 python 调用`,
          }
        }
        if (action === 'kill') {
          if (path === '') return { action, ok: false, message: 'kill 需要 path（要停哪个工具文件）' }
          const target = resolve(path)
          const victims = [...spawnedPids.entries()].filter(([, info]) => info.path === target)
          if (victims.length === 0) {
            return {
              action,
              ok: false,
              message: `没有在跑的调用属于 ${target}。\n`
                + '注意：长时间跑的工具（如黑板、字幕）通常由它自己的 close/stop 工具停止，'
                + '不走这里。',
            }
          }
          const killed = []
          for (const [pid] of victims) {
            try {
              process.kill(pid)
              killed.push(pid)
            } catch {
              // 已经自己退了
            }
            spawnedPids.delete(pid)
          }
          return {
            action,
            ok: true,
            killed,
            message: `已停止 ${target} 的 ${killed.length} 个调用（pid ${killed.join(', ')}）`,
          }
        }
        if (action === 'send') {
          // DSH -> Python 的动作投递。插件不执行动作，只把它写进这个文件的邮箱：
          // python 那边自己决定何时读、要不要理。没有对应处理函数是它自己的事，
          // 插件不干预（也不会因此报错）。
          if (path === '') return { action, ok: false, message: 'send 需要 path（发给哪个工具文件）' }
          const target = resolve(path)
          const entry = files.get([...files.keys()].find((key) => resolve(key) === target) ?? '')
          if (entry === undefined) return { action, ok: false, message: `没有登记过 ${target}，先 install` }
          const name = typeof args?.name === 'string' ? args.name.trim() : ''
          if (name === '') return { action, ok: false, message: 'send 需要 name（动作名）' }
          const actionId = (typeof args?.actionId === 'string' && args.actionId.trim() !== '')
            ? args.actionId.trim()
            : `act_${now().toString(36)}_${randomTag()}`
          const stem = basename(entry.path, extname(entry.path))
          const safe = stem.replace(/[^\p{L}\p{N}._-]+/gu, '_') || 'unknown'
          const mailbox = join(ACTIONS_DIR, `${safe}.jsonl`)
          const record = {
            actionId,
            name,
            arguments: isObject(args?.arguments) ? args.arguments : {},
            at: now() / 1000,
            file: entry.path,
          }
          try {
            mkdirSync(ACTIONS_DIR, { recursive: true })
            writeFileSync(mailbox, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' })
          } catch (error) {
            return { action, ok: false, message: `写动作邮箱失败：${String(error?.message ?? error)}` }
          }
          return {
            action,
            ok: true,
            actionId,
            mailbox,
            file: describeFile(entry),
            message: `已把动作 ${name}（actionId=${actionId}）投进 ${mailbox}。\n`
              + '这不是调用：python 那边要自己来读才会生效；它不读也不会报错。',
          }
        }
        return { action, ok: true, files: [...files.values()].map(describeFile) }
    }
  }

  function describeFile(entry) {
    if (entry === undefined || entry === null) return null
    const present = isFile(entry.path)
    return {
      path: entry.path,
      label: entry.label,
      status: present ? entry.status : (entry.status === 'relocating' ? 'relocating' : 'missing'),
      present,
      note: entry.note,
      pythonPath: entry.pythonPath,
      installedAt: entry.addedAt,
      lastSeenAt: entry.lastSeenAt,
      moves: entry.moves,
      lastMove: entry.lastMove,
      calls: entry.calls,
      lastCallAt: entry.lastCallAt,
      tools: entry.tools.map((tool) => ({
        name: tool.name,
        dshName: entry.dshTools.get(tool.name) ?? tool.name,
        description: tool.description,
        registered: entry.dshTools.has(tool.name),
      })),
      skills: entry.skills.map((skill) => ({ name: skill.name, description: skill.description })),
      error: entry.error,
      watched: entry.watcher !== null || entry.pollTimer !== null,
      hash: entry.hash.slice(0, 16),
    }
  }

  function renderControl(value) {
    const lines = []
    if (typeof value?.message === 'string' && value.message !== '') lines.push(value.message)
    if (Array.isArray(value?.files)) {
      if (value.files.length === 0) lines.push('（还没有登记任何 Python tools 文件）')
      for (const file of value.files) {
        if (file === null) continue
        const badge = file.status === 'ready'
          ? '✅'
          : file.status === 'missing'
            ? '❌ 文件不在原位'
            : file.status === 'relocating'
              ? '🔎 正在寻找新位置'
              : `⚠️ ${file.status}`
        lines.push(`${badge} ${file.path}`)
        if (file.note) lines.push(`   备注：${file.note}`)
        // 两种形状：describeFile 给的是 {tools:[{dshName,description}], skills:[{name}]}，
        // relocate 的核查报告给的是字符串数组。两者都要能读。
        if (Array.isArray(file.tools) && file.tools.length > 0) {
          const rendered = file.tools.map((tool) => (typeof tool === 'string' ? tool : `${tool.dshName ?? tool.name}（${tool.description ?? ''}）`))
          lines.push(`   工具：${rendered.join('；')}`)
        }
        if (Array.isArray(file.skills) && file.skills.length > 0) {
          lines.push(`   技能：${file.skills.map((skill) => (typeof skill === 'string' ? skill : skill.name)).join(', ')}`)
        }
        if (file.from !== undefined && file.from !== '') {
          lines.push(`   已从 ${file.from} 认出${file.how === 'same-content' ? '（内容哈希一致）' : ''}`)
        }
        if (file.moves > 0 && file.lastMove) {
          lines.push(`   位置变化 ${file.moves} 次，最近一次：${file.lastMove.from} → ${file.lastMove.to}（${new Date(file.lastMove.at).toLocaleString()}）`)
        }
        if (file.error) lines.push(`   错误：${file.error}`)
      }
    }
    if (isObject(value?.manifest)) {
      lines.push(`声明：${summaryOfManifest(value.manifest)}`)
      for (const tool of value.manifest.tools ?? []) lines.push(`  · 工具 ${tool.name}：${tool.description}`)
      for (const skill of value.manifest.skills ?? []) lines.push(`  · 技能 ${skill.name}：${skill.description}`)
      if (Array.isArray(value.manifest.warnings) && value.manifest.warnings.length > 0) {
        lines.push(`提示：${value.manifest.warnings.join('；')}`)
      }
    }
    if (isObject(value?.file) && Array.isArray(value.file.tools)) {
      // install 的返回里也带 file
    }
    return [{ type: 'text', text: lines.join('\n') || pretty(value) }]
  }

  function resolveCwd(exec) {
    const working = ctx.get('workingDirectory')
    const agent = exec?.agent
    if (working !== undefined && agent !== undefined) {
      try {
        if (typeof working.get === 'function') {
          const dir = working.get(agent)
          if (typeof dir === 'string' && dir !== '') return dir
        }
      } catch {
        // 退回到进程 cwd
      }
    }
    return process.cwd()
  }

  function mergeRoots(current, extra, cwd) {
    const list = Array.isArray(current) ? [...current] : []
    for (const item of extra) {
      if (typeof item !== 'string' || item.trim() === '') continue
      const raw = item.trim()
      const absolute = isAbsolute(raw) ? raw : resolve(cwd, raw)
      if (!list.includes(absolute)) list.push(absolute)
    }
    return list
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 启动与收尾
  // ══════════════════════════════════════════════════════════════════════════

  for (const entry of loadRegistry()) files.set(entry.path, entry)

  if (promptApi !== undefined && promptApi !== null) registerPromptContributions(promptApi)
  registerControlTool()

  // 登记过的文件逐个上线：读声明、注册工具与技能、开始盯位置。
  // 上一次关机的最后一刻文件可能被挪过，所以启动时先做一次全量核查。
  void (async () => {
    for (const entry of [...files.values()]) {
      if (isFile(entry.path)) {
        await installFile(entry.path, {
          pythonPath: entry.pythonPath,
          label: entry.label,
          note: entry.note,
          silent: true,
        }).catch(() => {})
      } else {
        ensureWatcher(entry)
      }
    }
    await auditAll().catch(() => {})
    saveRegistryNow()
  })()

  // ══════════════════════════════════════════════════════════════════════════
  //  面板 HTTP 路由：给设置页用的列表 / 开关 / 删除 / 搜索
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * 内置基础设施：插件目录 examples/ 里的那两个示例。
   * 它们是「这条通路能不能用」的自检基准，不是用户自己的工具，
   * 所以面板上标为系统项：不能停用，也不允许删除。
   */
  function isBuiltinFile(entry) {
    const examples = join(MODULE_DIR, 'examples')
    return resolve(entry.path).toLowerCase().startsWith(examples.toLowerCase())
  }

  /** 面板看到的「一条」：文件 + 它的工具/技能 + 当前开关状态。 */
  function panelEntryView(entry) {
    return {
      path: entry.path,
      label: entry.label,
      note: entry.note,
      disabled: entry.disabled === true,
      status: entry.status,
      error: entry.error,
      calls: entry.calls,
      lastCallAt: entry.lastCallAt,
      tools: (entry.tools || []).map((tool) => ({
        name: tool.name,
        dshName: entry.dshTools instanceof Map ? (entry.dshTools.get(tool.name) ?? tool.name) : tool.name,
        description: tool.description || '',
      })),
      skills: (entry.skills || []).map((skill) => ({
        name: skill.name,
        description: skill.description || '',
      })),
    };
  }

  function panelView() {
    // 内置基础设施（examples/ 里的自检示例）根本不出现在面板里：没有 UI，也无从停用或删除。
    const items = [...files.values()]
      .filter((entry) => !isBuiltinFile(entry))
      .map(panelEntryView);
    return {
      ok: true,
      count: items.length,
      enabled: items.filter((item) => !item.disabled).length,
      disabled: items.filter((item) => item.disabled).length,
      items,
    }
  }

  function registerPanelRoutes(ctx) {
    const ROUTE = '/api/dsh-python-tools-panel';

    const sendJson = (res, status, payload) => {
      const body = JSON.stringify(payload);
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Length', Buffer.byteLength(body));
      res.end(body);
    };

    const readBody = (req) => new Promise((settle) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > 256 * 1024) {
          settle({});
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          settle(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch {
          settle({});
        }
      });
      req.on('error', () => settle({}));
    });

    const handler = async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname.slice(ROUTE.length).replace(/\/+$/u, '') || '/'
      const method = String(req.method ?? 'GET').toUpperCase()

      if (method === 'GET' && (path === '/' || path === '/list')) {
        return sendJson(res, 200, panelView())
      }

      if (method === 'POST' && path === '/toggle') {
        const body = await readBody(req)
        const target = typeof body?.path === 'string' ? resolve(body.path) : ''
        const entry = files.get(target)
        if (entry === undefined) return sendJson(res, 404, { ok: false, error: 'not registered' })
        // 内置基础设施不允许停用：它们是自检基准
        if (isBuiltinFile(entry)) {
          return sendJson(res, 409, { ok: false, error: 'builtin' })
        }
        entry.disabled = body?.disabled === true
        if (entry.disabled) {
          stopFileTools(entry)
          stopFileSkills(entry)
        } else {
          registerFileTools(entry)
          syncFileSkills(entry)
        }
        saveRegistryNow()
        return sendJson(res, 200, panelView())
      }

      if (method === 'POST' && path === '/remove') {
        const body = await readBody(req)
        const target = typeof body?.path === 'string' ? resolve(body.path) : ''
        if (!files.has(target)) return sendJson(res, 404, { ok: false, error: 'not registered' })
        // 内置基础设施不允许删除
        if (isBuiltinFile(files.get(target))) {
          return sendJson(res, 409, { ok: false, error: 'builtin' })
        }
        uninstallFile(target, { reason: '面板上删除', notify: false })
        saveRegistryNow()
        return sendJson(res, 200, panelView())
      }

      if (method === 'POST' && path === '/install') {
        const body = await readBody(req)
        const raw = typeof body?.path === 'string' ? body.path.trim() : ''
        if (raw === '') {
          return sendJson(res, 400, { ok: false, error: 'empty-path', message: '请输入 .py 文件的完整路径' })
        }
        const absolute = resolve(raw)
        if (files.has(absolute)) {
          return sendJson(res, 409, {
            ok: false,
            error: 'already-registered',
            message: `已经登记过了：${absolute}`,
          })
        }
        if (!isFile(absolute)) {
          return sendJson(res, 400, {
            ok: false,
            error: 'not-found',
            message: `找不到这个文件：${absolute}`,
          })
        }
        if (extname(absolute).toLowerCase() !== '.py') {
          return sendJson(res, 400, {
            ok: false,
            error: 'not-python',
            message: `不是 .py 文件：${absolute}`,
          })
        }
        // 和 pytools install 走同一个函数，行为完全一致
        const outcome = await installFile(absolute, {
          pythonPath: typeof body?.pythonPath === 'string' ? body.pythonPath : '',
          label: typeof body?.label === 'string' ? body.label : '',
          note: typeof body?.note === 'string' ? body.note : '',
        }).catch((error) => ({ ok: false, error: String(error?.message ?? error) }))
        if (!outcome?.ok) {
          return sendJson(res, 400, {
            ok: false,
            error: 'install-failed',
            message: String(outcome?.error ?? '登记失败'),
          })
        }
        saveRegistryNow()
        const view = panelView()
        return sendJson(res, 200, {
          ...view,
          installed: {
            path: absolute,
            tools: (outcome.entry?.tools ?? []).map((tool) => tool.name),
            skills: (outcome.entry?.skills ?? []).map((item) => item.name),
          },
        })
      }

      return sendJson(res, 404, { ok: false, error: 'not found' })
    }

    ctx.inject(['webServer'], (scoped) => {
      scoped.effect(
        () => scoped.webServer.register({ kind: 'prefix', path: ROUTE, handler }),
        'python-tools: panel routes',
      )
    })
  }

  ctx.effect(() => () => {
    for (const entry of files.values()) stopWatcher(entry)
    for (const [, disposer] of toolDisposers) {
      try {
        disposer()
      } catch {
        // 忽略
      }
    }
    toolDisposers.clear()
    for (const [, registration] of skillRegistrations) {
      try {
        registration.disposer()
      } catch {
        // 忽略
      }
    }
    skillRegistrations.clear()
    saveRegistryNow()
  }, 'python-tools: teardown')
}
