/**
 * diagnose.ts —— 端到端诊断：真发一条消息，把失败原因打出来。
 *
 * 为什么需要它：Web 层的失败只会表现为"turn 以 error 结束"，真正的错误信息在
 * `agent/error` 事件与 `turn/end` 的 reason 里。SSE 是单向的，事后订阅抓不到
 * 已经过去的事件——所以诊断要在**订阅之后**发消息。
 *
 * 用法：node runtime/diagnose.ts "你的问题"
 */
import { bootWeb } from '../src/boot.ts'
import { SessionManager } from '../src/server/sessions.ts'

const question = process.argv[2] ?? '用一句话说明什么是闭包，不要超过 30 字。'

const web = await bootWeb()
const sessions = new SessionManager(web.ctx)

try {
  const sessionId = await sessions.open()
  console.log(`会话：${sessionId}`)

  const events: string[] = []
  sessions.subscribe(sessionId, (event) => {
    const line = `[${event.type}] ${JSON.stringify(event.data)}`
    events.push(line)
    // 只打印关键事件，避免刷屏。
    if (['agent/error', 'turn/end', 'assistant/delta', 'assistant/block-end', 'turn/start'].includes(event.type)) {
      console.log(line.slice(0, 500))
    }
  })

  await sessions.send(sessionId, question)

  // 等 turn 结束（最多 120s）。
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (!sessions.isRunning(sessionId)) break
    await new Promise((r) => setTimeout(r, 300))
  }
  await new Promise((r) => setTimeout(r, 1500))

  console.log('\n--- 轨迹 ---')
  const { readTrajectory } = await import('../src/server/trajectory.ts')
  const view = await readTrajectory(web.ctx, sessionId)
  if (view !== undefined) {
    console.log(`事件 ${view.eventCount} 条，turn ${view.turns.length} 个`)
    console.log(
      `token: in=${view.totals.inputTokens} out=${view.totals.outputTokens} tools=${view.totals.toolCalls}`,
    )
    for (const turn of view.turns) {
      console.log(`turn ${turn.number}: reason=${turn.reason} 耗时=${turn.durationMs}ms prompt=${turn.prompt.slice(0, 60)}`)
    }
    for (const event of view.events) {
      console.log(`  ${event.seq} ${event.type} ${event.detail.slice(0, 120)}`)
    }
  }
} finally {
  await sessions.dispose()
  await web.dispose()
}
