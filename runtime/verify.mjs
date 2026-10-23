/**
 * verify.mjs —— 两套运行时的并排校验，一条命令给出可比对的快照。
 *
 * 检查项（每套运行时各跑一遍，共 3 项）：
 *
 *   typecheck   `tsc -p tsconfig.json --noEmit`
 *   test        `node --test ./src` / `bun test ./src`
 *   boot        启动服务树并断言关键服务与工具数（Bun 侧顺带证明无需 shim）
 *
 * `boot` 是这里最有价值的一项：两套运行时"都能启动"很容易，但少一个工具是
 * **静默降级**——进程正常、命令照常能跑，只是某个能力消失了。把工具数和服务
 * 列表变成显式断言，才抓得住这类降级。
 *
 * 对 dsh-web 而言，这项检查还有一层特别的意义：dsh-lab 需要两个 Bun preload
 * shim 才能在 Bun 上跑通（`stripTypeScriptTypes` 与 subprocess 的 `--` 分隔符）。
 * dsh-web 是只读模式，不挂 PTC 与 subprocess，所以**不需要任何补丁**——这个
 * 结论就是靠这里的 boot 检查在两套运行时上比对出来的，不是假设。
 *
 * 结尾打印 `RUNTIMES_VERIFY_OK runtimes=2 checks=6` 作为脚本化判据。
 *
 * @module dsh-web/runtime/verify
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { PROJECT_ROOT, RUNTIME_NAMES, resolveRuntime, runtimeEntry } from './lib/runtimes.mjs'
import { runtimeEnv, spawnPlan } from './lib/spawn.mjs'

/**
 * 与 src/boot.test.ts 保持一致的必检服务。
 *
 * 实际断言在 runtime/boot-probe.ts（独立文件而非 `-e` 内联：Windows 上 Bun 经
 * `bun.cmd` → cmd.exe 解析，多行脚本会被拆坏）。
 */
const BOOT_PROBE_ENTRY = join(PROJECT_ROOT, 'runtime', 'boot-probe.ts')

/**
 * 跑一个子进程并收集输出。
 *
 * @param {{command: string, needsShell?: boolean}} runtime
 * @param {string[]} args
 * @param {Record<string, string|undefined>} env
 * @returns {Promise<{code: number, output: string}>}
 */
function capture(runtime, args, env) {
  const plan = spawnPlan(runtime, args)
  return new Promise((resolvePromise) => {
    const child = spawn(plan.command, plan.argv, { cwd: PROJECT_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      output += chunk.toString('utf8')
    })
    child.once('error', (error) => resolvePromise({ code: 1, output: `${output}\n${error.message}` }))
    child.once('exit', (code) => resolvePromise({ code: code ?? 1, output }))
  })
}

/** 从测试输出里取关键计数（两套运行时措辞不同，用宽松匹配）。 */
function testCounts(output) {
  const pass = output.match(/pass (\d+)/)?.[1] ?? output.match(/(\d+) pass/)?.[1] ?? '?'
  const fail = output.match(/fail (\d+)/)?.[1] ?? output.match(/(\d+) fail/)?.[1] ?? '?'
  return { pass, fail }
}

async function main() {
  const results = []

  for (const name of RUNTIME_NAMES) {
    const entry = runtimeEntry(name)
    const runtime = resolveRuntime(name)
    const env = runtimeEnv(name)
    const version = `${runtime.version}`

    // 1) 类型检查
    const tsc = join(PROJECT_ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
    if (!existsSync(tsc)) throw new Error('找不到 typescript，先跑 npm install')
    const typecheck = await capture(runtime, [tsc, '-p', 'tsconfig.json', '--noEmit'], env)
    results.push({
      name,
      version,
      check: 'typecheck',
      ok: typecheck.code === 0,
      detail: typecheck.code === 0 ? 'exit 0' : `exit ${typecheck.code}`,
    })

    // 2) 单元测试
    const testArgs = name === 'bun' ? ['test', './src'] : ['--test', './src']
    const test = await capture(runtime, testArgs, env)
    const counts = testCounts(test.output)
    results.push({
      name,
      version,
      check: 'test',
      ok: test.code === 0 && counts.fail === '0',
      detail: `${counts.pass} pass / ${counts.fail} fail`,
    })

    // 3) 启动探针（独立文件，两套运行时调用形式一致）
    const boot = await capture(runtime, [BOOT_PROBE_ENTRY], env)
    const probeLine = boot.output.split(/\r?\n/).find((lineText) => lineText.startsWith('BOOT_PROBE '))
    let detail = 'no probe output'
    if (probeLine !== undefined) {
      const parsed = JSON.parse(probeLine.slice('BOOT_PROBE '.length))
      detail =
        parsed.missing.length === 0
          ? `services ok, tools ${parsed.tools}`
          : `missing [${parsed.missing.join(', ')}], tools ${parsed.tools}`
    }
    results.push({ name, version, check: 'boot', ok: boot.code === 0, detail })
    void entry
  }

  // 跨运行时一致性：工具数必须相同。这是"无需 shim"这个结论的判据。
  const bootRows = results.filter((row) => row.check === 'boot')
  const toolCounts = bootRows
    .map((row) => row.detail.match(/tools (\d+)/)?.[1])
    .filter((value) => value !== undefined)
  const consistent = toolCounts.length < 2 || toolCounts.every((value) => value === toolCounts[0])
  if (!consistent) {
    results.push({
      name: 'cross',
      version: '-',
      check: 'parity',
      ok: false,
      detail: `工具数不一致：${toolCounts.join(' vs ')}`,
    })
  } else {
    results.push({
      name: 'cross',
      version: '-',
      check: 'parity',
      ok: true,
      detail: `两套运行时工具数一致（${toolCounts[0] ?? '?'}）`,
    })
  }

  // 并排输出
  const width = Math.max(...results.map((row) => row.check.length))
  console.log('')
  console.log('─'.repeat(78))
  console.log(`${'运行时'.padEnd(12)}${'版本'.padEnd(12)}${'检查'.padEnd(width + 4)}结果`)
  for (const row of results) {
    const mark = row.ok ? '✓' : '✗'
    console.log(
      `${row.name.padEnd(12)}${row.version.padEnd(12)}${row.check.padEnd(width + 4)}${mark} ${row.detail}`,
    )
  }
  console.log('─'.repeat(78))

  const failed = results.filter((row) => !row.ok)
  if (failed.length > 0) {
    console.error('')
    console.error(`RUNTIMES_VERIFY_FAILED runtimes=${RUNTIME_NAMES.length} checks=${results.length} failed=${failed.length}`)
    process.exitCode = 1
    return
  }

  console.log('')
  console.log(`RUNTIMES_VERIFY_OK runtimes=${RUNTIME_NAMES.length} checks=${results.length}`)
}

main().catch((error) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
