/**
 * 探针：定位 `name.toUpperCase is not a function` 的真正来源。
 *
 * 怀疑对象：dsh-app-boot 的 boot() 会读三层 .env（进程环境 → 工程目录 .env →
 * DSH_HOME/.env），再交给 dsh-launch-environment 建快照。后者对 Windows 上
 * 每个变量名调 `name.toUpperCase()`。如果某一层的 values 里混进了非字符串的
 * **键**（而不是值），就会在这里炸。
 */
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(process.cwd())

function report(label: string, values: Record<string, unknown>) {
  for (const key of Object.keys(values)) {
    if (typeof key !== 'string') {
      console.log(`✗ ${label}: 键不是字符串 → ${typeof key} ${String(key)}`)
    }
  }
  // 顺便看看值里有没有对象（值不该参与 toUpperCase，但要排除）。
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && typeof value !== 'string') {
      console.log(`  · ${label} 的值 ${key} 类型是 ${typeof value}`)
    }
  }
}

console.log('process.env 键类型检查：')
report('process.env', process.env as Record<string, unknown>)

const patches = loadOverlayPatches('probe', join(ROOT, 'cordis.patch.yml'))
try {
  const ctx = await boot('probe', join(ROOT, 'cordis.yml'), patches, undefined, pathToFileURL(ROOT + '/').href)
  console.log('boot 成功')
  await ctx.fiber.dispose()
} catch (error) {
  console.log(`boot 失败：${error instanceof Error ? error.stack : String(error)}`)
}
