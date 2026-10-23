/**
 * boot.ts —— 用官方装配机制启动 dsh-web 的服务树。
 *
 * 与 dsh-lab 的 boot.ts 结构一致，但有三处针对生产/Web 场景的改动：
 *
 *   1. **DSH_HOME 不再指向工程内的 `.dsh-home/`**，而是由环境变量 `DSH_HOME` 决定，
 *      默认落在 `DSH_WEB_HOME`（工程内 `.dsh-home/`）。生产环境把它挂成卷，
 *      会话就能跨容器重启保留。这是与 dsh-lab 最重要的一处差别。
 *   2. **不做 Windows 沙箱临时目录的探测**。dsh-lab 需要那段逻辑，是因为它的
 *      M07 要在 Windows 上跑 shell 命令；dsh-web 是只读对话模式，不挂 shell 与
 *      文件工具，根本不会去建沙箱临时目录。留着它只是无用代码。
 *   3. 暴露 `runtimeInfo`，让 `/api/health` 能报出当前跑在 Node 还是 Bun 上。
 *
 * @module dsh-web/boot
 */
import { Context } from '@deepseek-ai/cordis'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 工程根目录（本文件在 `<root>/src/boot.ts`）。 */
export const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 装配清单路径：根表 + patch 层。 */
export const ROOT_CONFIG = join(WEB_ROOT, 'cordis.yml')
export const PATCH_CONFIG = join(WEB_ROOT, 'cordis.patch.yml')

/**
 * 解析 harness home。
 *
 * 优先级：`DSH_WEB_HOME`（显式指定，生产环境挂卷用它）→ 工程内 `.dsh-home/`。
 * 然后把结果写回 `DSH_HOME` —— 下游的 dsh 包一律读 `DSH_HOME`。
 *
 * **不继承**外层 shell 的 `DSH_HOME`：那可能是某个交互式 dsh 实例的家目录，
 * 把生产会话写进去会污染它，也容易在排查时看错地方。要指定就显式给
 * `DSH_WEB_HOME`，别指望 `DSH_HOME` 能透传进来。
 */
export function ensureWebHome(): string {
  const explicit = process.env.DSH_WEB_HOME?.trim()
  const home = explicit
    ? resolve(explicit)
    : join(WEB_ROOT, '.dsh-home')
  process.env.DSH_HOME = home
  if (!existsSync(home)) mkdirSync(home, { recursive: true })
  return home
}

/** 一次启动的产物。 */
export interface Web {
  /** 装配好的 cordis 根 Context。 */
  readonly ctx: Context
  /** 生效的 harness home。 */
  readonly home: string
  /** 当前进程跑在哪个运行时上。 */
  readonly runtime: 'node' | 'bun'
  /** 当前运行时的版本号。 */
  readonly runtimeVersion: string
  /** 释放整棵树（flush 会话日志、关 SQLite、停子进程、注销工具）。 */
  dispose(): Promise<void>
}

/**
 * 启动服务树。
 *
 * @param options.prepare - 在服务树激活前运行的钩子。
 * @returns 已启动的 Web 服务树。
 * @throws 装配清单不可读、行无法激活、依赖缺失等任何启动期问题（fail loud）。
 */
export async function bootWeb(options: {
  prepare?: (ctx: Context) => void | Promise<void>
} = {}): Promise<Web> {
  const home = ensureWebHome()

  if (!existsSync(ROOT_CONFIG)) throw new Error(`dsh-web: 缺少根配置 ${ROOT_CONFIG}`)
  if (!existsSync(PATCH_CONFIG)) throw new Error(`dsh-web: 缺少装配清单 ${PATCH_CONFIG}`)

  // patch 层就是 YAML 顶层数组；loadOverlayPatches 会做结构校验，并把
  // `name: './src/...'` 这类相对路径锚定成本文件同目录的 file:// URL。
  const patches = loadOverlayPatches('dsh-web', PATCH_CONFIG)

  const ctx = await boot(
    'dsh-web',
    ROOT_CONFIG,
    patches,
    options.prepare,
    // 裸包名（'@deepseek-ai/dsh-llm'）从工程 node_modules 解析。
    pathToFileURL(WEB_ROOT + '/').href,
  )

  return {
    ctx,
    home,
    runtime: process.versions.bun ? 'bun' : 'node',
    runtimeVersion: process.versions.bun ?? process.versions.node,
    async dispose() {
      // cordis 的释放入口是 fiber：根 fiber 卸载会按注册逆序跑完全部 disposer。
      await ctx.fiber.dispose()
    },
  }
}
