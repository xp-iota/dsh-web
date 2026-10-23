/**
 * boot-probe.ts —— 启动探针：断言只读服务树完整、工具数正确。
 *
 * 这个文件的价值在于**跨运行时比对**：Node 与 Bun 必须在同一组服务、同一组工具
 * 上一致。dsh-lab 需要两个 Bun preload shim 才能做到（`stripTypeScriptTypes` 与
 * subprocess 的 `--` 分隔符）；dsh-web 因为是只读模式、不挂 PTC 与 subprocess，
 * 理论上不需要任何补丁——这个探针就是用来**证伪或证实**那个理论的。
 *
 * 只读模式的"沉默降级"风险与 dsh-lab 同源：一个包因为运行时缺 API 而加载失败，
 * `boot()` 只会记成"该行 pending"，进程照常启动、命令照常能跑，只是某个工具
 * 悄悄消失了。把工具数变成显式断言，才抓得住这类降级。
 *
 * 输出一行机器可读标记，供 verify.mjs 解析：
 *
 *     BOOT_PROBE {"missing":[],"tools":9,"runtime":"node"}
 *
 * 退出码 0 表示"服务齐全且工具数正确"。
 *
 * @module dsh-web/runtime/boot-probe
 */
import { bootWeb } from '../src/boot.ts'

/** 只读模式下必须存在的服务。 */
const REQUIRED_SERVICES = [
  'llm',
  'sessions',
  'sessionQuery',
  'sessionProjections',
  'tools',
  'agents',
  'agentLoop',
  'systemPrompt',
  'tokenMeter',
  'approval',
  'userQuestions',
  'commands',
  'storage',
  'storageDomain',
  'invariants',
] as const

/**
 * 期望的工具数。
 *
 * 只读模式保留 5 个工具：web_search、web_fetch、todo_write、exit_plan_mode、
 * ask_user_question。注意**不含** read/write/edit/bash/pwsh/subagent/workflow/
 * skill —— 那是只读模式的核心承诺，工具数变了就说明装配清单被改坏了。
 */
const EXPECTED_TOOLS = 5

const web = await bootWeb()
try {
  const missing = REQUIRED_SERVICES.filter((name) => web.ctx.get(name as never) === undefined)
  const toolNames = web.ctx.tools.schemas().map((schema) => schema.name)
  const tools = toolNames.length
  console.log(
    `BOOT_PROBE ${JSON.stringify({ missing, tools, toolNames, runtime: web.runtime, version: web.runtimeVersion })}`,
  )
  process.exitCode = missing.length === 0 && tools === EXPECTED_TOOLS ? 0 : 1
} finally {
  await web.dispose()
}
