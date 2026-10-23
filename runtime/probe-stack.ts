/**
 * probe-stack.ts —— 抓 `name.toUpperCase is not a function` 的真实堆栈。
 *
 * 直接复现调用链：走一次真实的模型请求，把错误对象的 stack 打出来。
 * 之前的诊断只打印了 `error.message`，看不到它从哪儿抛的。
 */
import { bootWeb } from '../src/boot.ts'
import { SessionManager } from '../src/server/sessions.ts'

const web = await bootWeb()
const sessions = new SessionManager(web.ctx)

try {
  const sessionId = await sessions.open()
  sessions.subscribe(sessionId, (event) => {
    if (event.type === 'agent/error') {
      const message = String(event.data.message ?? '')
      console.log('=== 错误 ===')
      console.log(message)
    }
  })
  await sessions.send(sessionId, '你好')
  await new Promise((r) => setTimeout(r, 30_000))
} finally {
  await sessions.dispose()
  await web.dispose()
}
