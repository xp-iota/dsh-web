/**
 * routes.ts —— HTTP API 与 SSE 事件流。
 *
 * 端点一览：
 *
 *   GET  /api/health                健康检查（运行时、工具数、会话数）
 *   GET  /api/sessions              会话列表
 *   POST /api/sessions              新建会话 → { sessionId }
 *   POST /api/sessions/:id/messages 发送一条用户消息
 *   GET  /api/sessions/:id          会话详情（对话视图 + 轨迹视图）
 *   GET  /api/sessions/:id/stream   SSE 事件流（对话与轨迹都靠它）
 *   POST /api/sessions/:id/approvals/:requestId  应答审批
 *   POST /api/sessions/:id/questions/:requestId 应答提问
 *
 * ## 为什么用 SSE 而不是 WebSocket
 *
 * 事件流是**单向**的（服务端 → 浏览器）。用户输入走普通 POST，需要应答的审批与
 * 提问走普通 POST 回同一端点。SSE 有两个现实优势：它就是 HTTP（不需要额外的
 * 升级握手与鉴权通道，浏览器 `EventSource` 直接能用），而且**自动重连**是协议
 * 内置的——代理掐了连接，浏览器会自己重连并重新订阅。
 *
 * @module dsh-web/server/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import '@deepseek-ai/dsh-session-query'
import type { SessionManager, WireEvent } from './sessions.ts'
import { foldTranscript, readTrajectory } from './trajectory.ts'

/** 路由上下文。 */
export interface RouteContext {
  readonly ctx: Context
  readonly sessions: SessionManager
  /** 静态资源目录（前端构建产物）。生产环境由 Node/Bun 直接托管。 */
  readonly staticRoot: string | undefined
  /** 运行时信息，供 /api/health 报告。 */
  readonly runtime: { name: string; version: string }
  /** 允许的跨域来源；生产环境默认同源。 */
  readonly corsOrigin: string | undefined
}

/** 处理一个 HTTP 请求。 */
export async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  route: RouteContext,
): Promise<boolean> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  const path = url.pathname

  // CORS：开发时前端跑在 Vite dev server（5173），需要放行。
  if (route.corsOrigin !== undefined) {
    response.setHeader('access-control-allow-origin', route.corsOrigin)
    response.setHeader('access-control-allow-headers', 'content-type')
    response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end()
      return true
    }
  }

  if (path.startsWith('/api/')) {
    await handleApi(request, response, route, url)
    return true
  }

  return false
}

/** 处理 API 路由。 */
async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  route: RouteContext,
  url: URL,
): Promise<void> {
  const path = url.pathname
  const method = request.method ?? 'GET'

  try {
    // ── 健康检查 ──────────────────────────────────────────────────────────
    if (path === '/api/health' && method === 'GET') {
      const tools = route.ctx.tools.schemas().length
      const providers = route.ctx.llm.listProviders().map((info: { id?: string }) => info.id)
      sendJson(response, 200, {
        ok: true,
        runtime: route.runtime,
        tools,
        providers,
        version: '0.1.0',
      })
      return
    }

    // ── 会话列表 ──────────────────────────────────────────────────────────
    if (path === '/api/sessions' && method === 'GET') {
      const records = await route.ctx.sessionQuery.listSessions()
      const items = []
      for (const record of records) {
        const id = String(record.header.id)
        const title = await route.ctx.sessionQuery.readTitle(record.header.id).catch(() => undefined)
        items.push({
          sessionId: id,
          title: title?.title ?? '',
          cwd: record.header.cwd ?? null,
          live: record.live === true,
          persisted: record.persisted === true,
        })
      }
      sendJson(response, 200, { sessions: items })
      return
    }

    // ── 新建会话 ──────────────────────────────────────────────────────────
    if (path === '/api/sessions' && method === 'POST') {
      const body = await readJson(request)
      const sessionId = await route.sessions.open({
        provider: typeof body?.provider === 'string' ? body.provider : undefined,
        model: typeof body?.model === 'string' ? body.model : undefined,
      })
      sendJson(response, 201, { sessionId })
      return
    }

    // ── 会话详情 ──────────────────────────────────────────────────────────
    const detailMatch = /^\/api\/sessions\/([^/]+)$/.exec(path)
    if (detailMatch !== null && method === 'GET') {
      const sessionId = decodeURIComponent(detailMatch[1]!)
      const trajectory = await readTrajectory(route.ctx, sessionId)
      if (trajectory === undefined) {
        sendJson(response, 404, { error: '会话不存在' })
        return
      }
      const snapshot = await route.ctx.sessionQuery.readSession(sessionId as never).catch(() => undefined)
      sendJson(response, 200, {
        sessionId,
        title: trajectory.title ?? '',
        cwd: trajectory.cwd ?? null,
        transcript: snapshot === undefined ? [] : foldTranscript(snapshot.events),
        trajectory,
      })
      return
    }

    // ── 发送消息 ──────────────────────────────────────────────────────────
    const messageMatch = /^\/api\/sessions\/([^/]+)\/messages$/.exec(path)
    if (messageMatch !== null && method === 'POST') {
      const sessionId = decodeURIComponent(messageMatch[1]!)
      const body = await readJson(request)
      const text = typeof body?.text === 'string' ? body.text.trim() : ''
      if (text === '') {
        sendJson(response, 400, { error: '消息内容为空' })
        return
      }

      // 斜杠命令走 commands 服务（落进会话日志）；其余进 agent inbox。
      if (text.startsWith('/')) {
        const parsed = parseCommand(text)
        if (parsed !== undefined) {
          const agent = route.sessions.agentOf(sessionId)
          if (agent !== undefined) {
            const execution = await route.ctx.commands.execute(
              agent,
              text,
              [],
              new AbortController().signal,
            )
            if (execution !== undefined) {
              sendJson(response, 200, {
                kind: execution.result.kind,
                text: execution.result.text ?? '',
              })
              return
            }
          }
        }
      }

      await route.sessions.send(sessionId, text)
      sendJson(response, 202, { accepted: true })
      return
    }

    // ── SSE 事件流 ────────────────────────────────────────────────────────
    const streamMatch = /^\/api\/sessions\/([^/]+)\/stream$/.exec(path)
    if (streamMatch !== null && method === 'GET') {
      const sessionId = decodeURIComponent(streamMatch[1]!)
      await serveEventStream(request, response, route, sessionId)
      return
    }

    // ── 审批应答 ──────────────────────────────────────────────────────────
    const approvalMatch = /^\/api\/sessions\/([^/]+)\/approvals\/([^/]+)$/.exec(path)
    if (approvalMatch !== null && method === 'POST') {
      const sessionId = decodeURIComponent(approvalMatch[1]!)
      const requestId = decodeURIComponent(approvalMatch[2]!)
      const body = await readJson(request)
      const outcome = body?.outcome === 'allowed-once' ? 'allowed-once' : 'rejected'
      const ok = route.sessions.answerApproval(sessionId, requestId, outcome)
      sendJson(response, ok ? 200 : 404, { ok })
      return
    }

    // ── 提问应答 ──────────────────────────────────────────────────────────
    const questionMatch = /^\/api\/sessions\/([^/]+)\/questions\/([^/]+)$/.exec(path)
    if (questionMatch !== null && method === 'POST') {
      const sessionId = decodeURIComponent(questionMatch[1]!)
      const requestId = decodeURIComponent(questionMatch[2]!)
      const body = await readJson(request)
      const answer = { answers: Array.isArray(body?.answers) ? body.answers : [] }
      const ok = route.sessions.answerQuestions(sessionId, requestId, answer)
      sendJson(response, ok ? 200 : 404, { ok })
      return
    }

    sendJson(response, 404, { error: '未知接口' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendJson(response, 500, { error: message })
  }
}

/**
 * 建立 SSE 事件流。
 *
 * 心跳很重要：反向代理与负载均衡器通常有空闲超时（常见 60s），而模型可能思考
 * 很久才吐第一个字。心跳让连接保持"活着"，也顺便让客户端知道服务还在。
 */
async function serveEventStream(
  request: IncomingMessage,
  response: ServerResponse,
  route: RouteContext,
  sessionId: string,
): Promise<void> {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // 反向代理（Nginx）默认会缓冲响应，SSE 会被攒着不发。
    'x-accel-buffering': 'no',
  })

  // 先推一条 hello，让前端知道连接已建立（也能立刻校验鉴权）。
  writeSse(response, { type: 'session/started', seq: 0, time: Date.now(), data: { sessionId } })

  const unsubscribe = route.sessions.subscribe(sessionId, (event: WireEvent) => {
    writeSse(response, event)
  })

  const heartbeat = setInterval(() => {
    // 注释行是 SSE 规范的"注释帧"，客户端会忽略它，但能保活连接。
    response.write(': ping\n\n')
  }, 25_000)
  heartbeat.unref?.()

  const cleanup = () => {
    clearInterval(heartbeat)
    unsubscribe?.()
  }
  request.on('close', cleanup)
  request.on('error', cleanup)
}

/** 写一条 SSE 帧。 */
function writeSse(response: ServerResponse, event: WireEvent): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}

/** 发送 JSON 响应。 */
function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/** 读取并解析 JSON 请求体。 */
async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    // 上限 1 MiB：会话消息不该有这么大，防止内存被撑爆。
    if (size > 1024 * 1024) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}
