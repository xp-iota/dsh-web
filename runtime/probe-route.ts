/**
 * probe-route.ts —— 打印 agent 实际会用的路由。
 *
 * 问题：网关报 `No worker available for model 'deepseek-v4.1-flash'`，而默认
 * 选择明明是 `fuyao-coding`。所以真正发出去的 model 不是默认值——要看见
 * agent-loop 组装出来的 request config。
 */
import { bootWeb } from '../src/boot.ts'
import { SessionManager } from '../src/server/sessions.ts'

const web = await bootWeb()
const sessions = new SessionManager(web.ctx)

try {
  const sessionId = await sessions.open()

  // 在 agent 作用域外订阅会话事件，打印 request/header 的内容。
  const disposer = web.ctx.on(
    'session/event',
    ((session: { id: string }, event: any) => {
      if (String(session.id) !== sessionId) return
      if (event.type === 'request/header') {
        console.log('request/header:', JSON.stringify(event.data?.header ?? event.data, null, 2).slice(0, 1500))
      }
      if (event.type === 'session/title-llm-request') {
        console.log('title-llm-request:', JSON.stringify(event.data, null, 2).slice(0, 1200))
      }
    }) as never,
  )

  await sessions.send(sessionId, '你好')
  await new Promise((r) => setTimeout(r, 25_000))
  disposer()
} finally {
  await sessions.dispose()
  await web.dispose()
}
