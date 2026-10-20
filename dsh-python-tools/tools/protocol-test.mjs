/**
 * 协议自检脚本（开发工具，不属于插件运行时）。
 *
 * 用法：node tools/protocol-test.mjs <tool-file.py> <tool-name> '<json-arguments>'
 *
 * 它复刻插件调用 Python 的三步：写调用帧 -> 起 python -> 读流帧 + 结果帧，
 * 用来在装进 DSH 之前先验证一个 Python tools 文件是否符合协议。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const FRAME_BEGIN = 'PYTOOLS-FRAME-BEGIN'

const [, , rawFile, toolName, rawArgs] = process.argv
if (!rawFile || !toolName) {
  console.error("usage: node tools/protocol-test.mjs <file.py> <tool> ['{json}']")
  process.exit(2)
}
const file = resolve(rawFile)
if (!existsSync(file)) {
  console.error(`no such file: ${file}`)
  process.exit(2)
}
const args = rawArgs ? JSON.parse(rawArgs) : {}
const callId = `pt_test_${Date.now().toString(36)}`
const dir = join(tmpdir(), `pytools-protocol-${callId}`)
mkdirSync(dir, { recursive: true })
const callFile = join(dir, 'call.json')
const resultFile = join(dir, 'result.json')
const streamFile = join(dir, 'stream.log')
writeFileSync(callFile, JSON.stringify({
  protocol: 'pytools/1',
  callId,
  tool: toolName,
  arguments: args,
  file,
  cwd: dirname(file),
  startedAt: Date.now() / 1000,
}, null, 2))
writeFileSync(streamFile, '')

const started = Date.now()
const child = spawn(process.env.PYTOOLS_PYTHON || 'python', [file, '__pytools_call__'], {
  cwd: dirname(file),
  env: {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTOOLS_CALL_FILE: callFile,
    PYTOOLS_RESULT_FILE: resultFile,
    PYTOOLS_STREAM_FILE: streamFile,
    PYTOOLS_CALL_ID: callId,
  },
  windowsHide: true,
})
let stderr = ''
child.stderr.on('data', (chunk) => {
  stderr += chunk
})
child.stdout.on('data', () => {})
child.on('close', (code) => {
  const elapsed = Date.now() - started
  const stream = existsSync(streamFile) ? readFileSync(streamFile, 'utf8') : ''
  const frames = stream
    .split(/\r?\n/u)
    .filter((line) => line.includes(FRAME_BEGIN))
    .map((line) => {
      try {
        return JSON.parse(line.slice(line.indexOf(FRAME_BEGIN) + FRAME_BEGIN.length).trim())
      } catch {
        return { kind: 'unparsable', payload: line }
      }
    })
  const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : null
  console.log(`exit=${code} elapsed=${elapsed}ms`)
  console.log(`stream frames: ${frames.length}`)
  for (const frame of frames) console.log(`  [${frame.kind}] ${JSON.stringify(frame.payload)}`)
  console.log('result frame:')
  console.log(JSON.stringify(result, null, 2))
  if (stderr.trim() !== '') console.log(`stderr:\n${stderr}`)
  for (const name of [callFile, resultFile, streamFile]) {
    try {
      unlinkSync(name)
    } catch {
      // 已删除
    }
  }
  process.exit(result?.ok === true ? 0 : 1)
})
