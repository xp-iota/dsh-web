/**
 * status.mjs —— 打印两套运行时的落地状态。
 *
 * 用途：部署前先确认「这台机器（或这个镜像）上两套运行时都能用」，以及当前
 * `DSH_RUNTIME` 默认会用哪一个。退出码非 0 表示至少有一套不可用。
 *
 * @module dsh-web/runtime/status
 */
import { RUNTIME_NAMES, currentRuntimeName, installedStatus, loadManifest } from './lib/runtimes.mjs'

const manifest = loadManifest()

console.log('')
console.log('dsh-web 运行时清单')
console.log('─'.repeat(72))
for (const name of RUNTIME_NAMES) {
  const entry = manifest.runtimes[name]
  console.log(`${entry.displayName}`)
  console.log(`  目标版本    ${entry.version}（${entry.channel}）`)
  console.log(`  最低版本    ${entry.minimumVersion}`)
  console.log(`  为什么需要  ${entry.reason}`)
  console.log(`  参考        ${entry.reference}`)
}

console.log('─'.repeat(72))
console.log('本机落地状态')
console.log('─'.repeat(72))

let missing = 0
for (const status of installedStatus()) {
  if (status.ok) {
    const resolved = status.resolved
    console.log(
      `✓ ${status.entry.displayName.padEnd(10)} ${String(resolved.version).padEnd(10)} ` +
        `来源=${resolved.source.padEnd(8)} 命令=${resolved.command}`,
    )
  } else {
    missing += 1
    console.log(`✗ ${status.entry.displayName.padEnd(10)} 不可用：${status.error.split('\n')[0]}`)
  }
}

console.log('─'.repeat(72))
console.log(`当前进程运行时      ${currentRuntimeName()}`)
console.log(`DSH_RUNTIME         ${process.env.DSH_RUNTIME ?? '(未设置，默认 node)'}`)
console.log('')

if (missing > 0) {
  console.error(`RUNTIME_STATUS_FAILED missing=${missing}`)
  process.exitCode = 1
} else {
  console.log('RUNTIME_STATUS_OK runtimes=2')
}
