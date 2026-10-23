/**
 * runtimes.mjs —— 运行时解析器：把「node / bun」解析成具体可执行文件与版本。
 *
 * 与 dsh-lab 的同名文件结构一致，但**没有**沿用它的 Bun shim 机制，原因是
 * dsh-web 跑在只读对话模式：不挂 `dsh-ptc-runtime-node`（全仓唯一使用
 * `node:module.stripTypeScriptTypes` 的包），也不挂 `dsh-subprocess-local`
 * （Bun 会吞掉脚本路径后第一个 `--`，它的 runner 协议依赖那个分隔符）。
 * 两个坑都不再触及，因此 Bun 侧**不需要任何 preload 补丁**。
 *
 * 这个结论不是假设：`runtime/verify.mjs` 会在两套运行时上断言工具数与服务
 * 完全一致，任何 Bun 侧的静默降级都会让校验红掉。
 *
 * 唯一真相是 runtime/runtimes.json：脚本、状态打印、README 都引用它。
 *
 * @module dsh-web/runtime/lib/runtimes
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 工程根目录（本文件在 `<root>/runtime/lib/`）。 */
export const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** 清单文件位置。 */
export const MANIFEST_PATH = fileURLToPath(new URL('../runtimes.json', import.meta.url))

/** 支持的运行时名（顺序即 `--runtime` 的帮助顺序）。 */
export const RUNTIME_NAMES = ['node', 'bun']

let manifestCache

/** 读取运行时版本清单。 */
export function loadManifest() {
  if (!manifestCache) manifestCache = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  return manifestCache
}

/** 取某个运行时条目。 */
export function runtimeEntry(runtimeName, manifest = loadManifest()) {
  const entry = manifest.runtimes[runtimeName]
  if (!entry) throw new Error(`未知运行时：${runtimeName}（可选：${RUNTIME_NAMES.join(' / ')}）`)
  return entry
}

/** 把 `26.12.1` 解析成可比较的数字数组（忽略预发布后缀）。 */
function parseVersion(version) {
  return String(version)
    .replace(/^v/, '')
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0))
}

/** actual 是否 >= minimum。 */
export function versionAtLeast(actual, minimum) {
  const left = parseVersion(actual)
  const right = parseVersion(minimum)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a > b
  }
  return true
}

/** 探测可执行文件版本；不存在或执行失败返回 undefined。 */
function detectVersion(command, needsShell = false) {
  const plan = needsShell
    ? {
        // Windows 的 .cmd 必须经 cmd.exe 执行。这里不用 `shell: true`：
        // 那种写法会触发 DEP0190（args 不转义直接拼进命令行）。
        file: process.env.ComSpec ?? 'cmd.exe',
        args: ['/d', '/s', '/c', `${command} --version`],
      }
    : { file: command, args: ['--version'] }
  try {
    return execFileSync(plan.file, plan.args, {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().replace(/^v/, '')
  } catch {
    return undefined
  }
}

/**
 * 系统 PATH 里该运行时的候选命令，按优先级排列。
 *
 * Windows 上不能只写 `bun.exe`：用 npm 全局装的 Bun 是一组 `bun.cmd` / `bun.ps1`
 * 包装脚本，没有同名 exe，`spawn('bun.exe')` 会直接 ENOENT。`.cmd` 在 Windows 上
 * 需要经由 shell 才能执行，所以调用方要按返回的 `needsShell` 处理。
 */
function systemCandidates(runtimeName) {
  if (process.platform !== 'win32') return [{ command: runtimeName, needsShell: false }]
  if (runtimeName === 'node') {
    return [{ command: 'node.exe', needsShell: false }, { command: 'node.cmd', needsShell: true }]
  }
  return [{ command: 'bun.exe', needsShell: false }, { command: 'bun.cmd', needsShell: true }]
}

/**
 * 解析该用哪个可执行文件。
 *
 * 优先级：显式覆盖（DSH_NODE / DSH_BUN）> PATH 里的系统安装。
 * 两种情况都做最低版本检查 —— 版本不达标时的失败形式完全无关
 * （例如 Node 缺 `stripTypeScriptTypes`、Bun 缺 `getSystemErrorMessage`），
 * 不提前说清会让排查成本极高。
 *
 * @param {'node'|'bun'} runtimeName
 * @param {{env?: Record<string, string|undefined>}} [options]
 * @returns {{name: string, command: string, source: 'override'|'system', version: string, needsShell: boolean, expected: string}}
 */
export function resolveRuntime(runtimeName, options = {}) {
  const env = options.env ?? process.env
  const entry = runtimeEntry(runtimeName)
  const overrideVar = runtimeName === 'node' ? 'DSH_NODE' : 'DSH_BUN'
  const override = env[overrideVar]

  if (override) {
    if (!existsSync(override)) throw new Error(`${overrideVar} 指向的文件不存在：${override}`)
    const needsShell = /\.(cmd|bat)$/i.test(override)
    const version = detectVersion(override, needsShell) ?? entry.version
    assertVersion(runtimeName, entry, version, overrideVar)
    return { name: runtimeName, command: override, source: 'override', version, needsShell, expected: entry.version }
  }

  for (const candidate of systemCandidates(runtimeName)) {
    const detected = detectVersion(candidate.command, candidate.needsShell)
    if (!detected) continue
    assertVersion(runtimeName, entry, detected, `PATH 上的 ${candidate.command}`)
    return {
      name: runtimeName,
      command: candidate.command,
      source: 'system',
      version: detected,
      needsShell: candidate.needsShell,
      expected: entry.version,
    }
  }

  throw new Error([
    `没有找到可用的 ${entry.displayName}。`,
    `  请安装 ${entry.displayName} v${entry.version}：${entry.reference}`,
    `  （最低要求 v${entry.minimumVersion}；也可以用 DSH_${runtimeName.toUpperCase()} 指定可执行文件）`,
  ].join('\n'))
}

/** 版本低于最低要求时抛错，措辞里点明"会以无关错误的形式失败"。 */
function assertVersion(runtimeName, entry, version, where) {
  if (versionAtLeast(version, entry.minimumVersion)) return
  throw new Error([
    `${where} 的 ${entry.displayName} 是 ${version}，低于最低要求 ${entry.minimumVersion}。`,
    `  原因：${entry.reason}`,
    `  请升级到 v${entry.version}：${entry.reference}`,
  ].join('\n'))
}

/** 两套运行时的落地状态（供 `runtime:status` 打印）。 */
export function installedStatus() {
  return RUNTIME_NAMES.map((name) => {
    const entry = runtimeEntry(name)
    try {
      const resolved = resolveRuntime(name)
      return { name, entry, ok: true, resolved }
    } catch (error) {
      return { name, entry, ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

/**
 * 当前进程自己跑在哪个运行时上。
 *
 * 用 `process.versions.bun` 判定：Bun 会同时报告 node 版本（伪装成 Node），
 * 所以不能反过来查 node。
 *
 * @returns {'node'|'bun'}
 */
export function currentRuntimeName() {
  return process.versions.bun ? 'bun' : 'node'
}
