/**
 * run.mjs —— 统一的运行时调度器：`node runtime/run.mjs [--runtime node|bun] <命令…>`
 *
 * 所有 npm script 都经由这里，好处是"换运行时"只有一处逻辑：定义默认值、
 * 在 Windows 上处理 .cmd 包装脚本。
 *
 * 支持的入口形式：
 *
 *     node runtime/run.mjs src/server/main.ts           # 跑一个入口文件
 *     node runtime/run.mjs --test                        # 跑单元测试
 *     node runtime/run.mjs --typecheck                   # 跑 tsc --noEmit
 *     node runtime/run.mjs --runtime bun src/server/main.ts
 *
 * 注意 `--runtime` 只能放在这里，不能透传给 npm：`npm run start -- --runtime bun`
 * 会被 npm 当成自己的配置项，报 `EUNKNOWNCONFIG`。改默认运行时请用
 * `DSH_RUNTIME=bun`，或直接用预置的 `start:bun` 之类脚本。
 *
 * @module dsh-web/runtime/run
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, RUNTIME_NAMES, resolveRuntime } from './lib/runtimes.mjs'
import { runtimeEnv, spawnPlan } from './lib/spawn.mjs'

const HELP = `
dsh-web 运行时调度器

用法：
  node runtime/run.mjs [--runtime <name>] <命令…>
  node runtime/run.mjs [--runtime <name>] --test
  node runtime/run.mjs [--runtime <name>] --typecheck

选项：
  -r, --runtime <name>   用 node 还是 bun（默认取 DSH_RUNTIME，否则 node）
      --test             跑单元测试
      --typecheck        跑 tsc --noEmit
  -h, --help             显示本帮助

环境变量：
  DSH_RUNTIME            默认运行时（等价于每次传 --runtime）
  DSH_NODE / DSH_BUN     指定可执行文件（覆盖 PATH 查找）
`.trim()

/**
 * 解析命令行。手写而不是引 commander：这里要在**任何运行时**下都能跑，
 * 保持零依赖。
 *
 * @param {string[]} argv
 * @returns {{runtime: string, mode: 'exec'|'test'|'typecheck'|'help', args: string[]}}
 */
function parseArgv(argv) {
  let runtime = process.env.DSH_RUNTIME?.trim() ?? ''
  let mode = 'exec'
  const args = []

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '-h' || token === '--help') {
      mode = 'help'
      continue
    }
    if (token === '-r' || token === '--runtime') {
      runtime = argv[index + 1] ?? ''
      index += 1
      continue
    }
    if (token.startsWith('--runtime=')) {
      runtime = token.slice('--runtime='.length)
      continue
    }
    if (token === '--test') {
      mode = 'test'
      continue
    }
    if (token === '--typecheck') {
      mode = 'typecheck'
      continue
    }
    // 第一个非选项之后全部原样透传。
    args.push(token)
  }

  return { runtime: runtime === '' ? 'node' : runtime, mode, args }
}

/**
 * 用指定的运行时跑一个子进程，stdout/stderr 直通终端。
 *
 * @param {{command: string, needsShell?: boolean}} runtime
 * @param {string[]} args
 * @param {Record<string, string|undefined>} env
 * @returns {Promise<number>}
 */
function runProcess(runtime, args, env) {
  const plan = spawnPlan(runtime, args)
  return new Promise((resolvePromise) => {
    const child = spawn(plan.command, plan.argv, {
      cwd: PROJECT_ROOT,
      env,
      stdio: 'inherit',
      shell: plan.shell,
    })

    // ── 信号转发 ──────────────────────────────────────────────────────────
    //
    // 容器里本文件是 PID 1。**PID 1 不会执行内核对 SIGTERM 的默认动作**（内核
    // 忽略 PID 1 的默认信号处理），所以必须显式装一个 handler，否则 `docker stop`
    // 只会等超时后 SIGKILL —— 会话日志来不及 flush、SQLite 不会正常关闭。
    //
    // 做法是把信号转给子进程（真正跑服务的那一层），等它自己优雅退出后再退出。
    // 这样既保住了 main.ts 里的 shutdown 逻辑，也保住了退出码。
    //
    // 子进程若在宽限期内不退出（比如卡在某个 await），超时后强制结束，避免
    // 容器永远停在 running 状态。
    const FORWARDED = ['SIGINT', 'SIGTERM']
    let shuttingDown = false
    const handlers = new Map()

    for (const signal of FORWARDED) {
      const handler = () => {
        if (shuttingDown) return
        shuttingDown = true
        try {
          child.kill(signal)
        } catch {
          // 子进程已经退出；忽略。
        }
        // 宽限期：15s 后还没退就 SIGKILL。
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // 忽略。
          }
        }, 15_000)
        timer.unref?.()
      }
      handlers.set(signal, handler)
      process.on(signal, handler)
    }

    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler)
      handlers.clear()
    }

    child.once('error', (error) => {
      cleanup()
      console.error(`✗ 无法启动 ${runtime.command}：${error.message}`)
      resolvePromise(1)
    })
    child.once('exit', (code) => {
      cleanup()
      resolvePromise(code ?? 1)
    })
  })
}

async function main() {
  const { runtime: runtimeName, mode, args } = parseArgv(process.argv.slice(2))

  if (mode === 'help') {
    console.log(HELP)
    return 0
  }

  if (!RUNTIME_NAMES.includes(runtimeName)) {
    console.error(`✗ 未知运行时 ${runtimeName}；可选：${RUNTIME_NAMES.join(' / ')}`)
    return 2
  }

  const runtime = resolveRuntime(runtimeName)
  const env = runtimeEnv(runtimeName)

  if (mode === 'test') {
    // Node 用 `--test`，Bun 用 `test` 子命令；两者都接受目录形式。
    // 之前试过 glob（`src/**/*.test.ts`）：Node 在 Windows 上要自己展开，
    // Bun 直接拒绝带通配符的过滤参数，所以统一用目录。
    const testArgs = runtimeName === 'bun' ? ['test', './src'] : ['--test', './src']
    return runProcess(runtime, testArgs, env)
  }

  if (mode === 'typecheck') {
    const tsc = join(PROJECT_ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
    if (!existsSync(tsc)) {
      console.error('✗ 找不到 typescript；先跑 npm install')
      return 1
    }
    return runProcess(runtime, [tsc, '-p', 'tsconfig.json', '--noEmit'], env)
  }

  if (args.length === 0) {
    console.error(HELP)
    return 2
  }

  return runProcess(runtime, args, env)
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  },
)
