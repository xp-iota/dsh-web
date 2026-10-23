/**
 * spawn.mjs —— 运行时之间的启动差异，全部集中在这里。
 *
 * 与 dsh-lab 的同名文件相比**少了两处**，都是因为只读对话模式不需要：
 *
 *   * dsh-lab 要注入 `BUN_OPTIONS=--preload` 来补 `node:module.stripTypeScriptTypes`
 *     （只有 `dsh-ptc-runtime-node` 用它）；
 *   * dsh-lab 还要用同一个 preload 修复 Bun 吞掉脚本路径后第一个 `--` 的问题
 *     （`dsh-subprocess-local` 的 runner 协议依赖那个分隔符）。
 *
 * dsh-web 既不挂 PTC 也不挂 subprocess，所以两个坑都不触及，这里**不注入任何
 * preload**。少一层补丁，就少一处"补丁本身过期"的风险。
 *
 * 仍然要清掉继承来的 `NODE_OPTIONS`：机器上装了 tsx、或用户全局设了别的 preload
 * 时，会让"本工程的运行环境"取决于外部状态 —— 那正是双运行时要避免的事。
 *
 * @module dsh-web/runtime/lib/spawn
 */
import { fileURLToPath } from 'node:url'

/**
 * 构造子进程环境。
 *
 * @param {'node'|'bun'} runtimeName
 * @param {Record<string, string|undefined>} [base]
 * @returns {Record<string, string|undefined>}
 */
export function runtimeEnv(runtimeName, base = process.env) {
  const env = { ...base }
  delete env.NODE_OPTIONS
  delete env.BUN_OPTIONS
  void runtimeName
  return env
}

/**
 * 按运行时解析结果拼出 spawn 参数。
 *
 * 只有"回退到 Windows 的 .cmd 包装脚本"时才需要经过 shell。这时**不用**
 * `shell: true`：Node 会报 DEP0190（参数不转义直接拼接），而且它在我们传入
 * 空 args 时仍会打印警告。改为自己拼命令行、显式调 `cmd.exe /d /s /c`，
 * 与 `shell: true` 内部做的事相同，但警告消失且行为可控。
 *
 * @param {{command: string, needsShell?: boolean}} runtime
 * @param {string[]} args
 * @returns {{command: string, argv: string[], shell: boolean}}
 */
export function spawnPlan(runtime, args) {
  if (runtime.needsShell !== true) return { command: runtime.command, argv: args, shell: false }
  // cmd.exe 的 `/s /c` 规则：整条命令若以引号开头，会被剥掉外层一对引号。
  // 所以这里**不加**外层引号，只在单个含空格的参数上加。
  const quote = (value) => (/[\s"]/.test(value) ? `"${value}"` : value)
  const line = [runtime.command, ...args].map(quote).join(' ')
  return { command: process.env.ComSpec ?? 'cmd.exe', argv: ['/d', '/s', '/c', line], shell: false }
}

/** 保留一个引用，避免打包器把这个纯 ESM 模块当成有副作用的脚本而 tree-shake 掉。 */
export const SPAWN_MODULE = fileURLToPath(import.meta.url)
