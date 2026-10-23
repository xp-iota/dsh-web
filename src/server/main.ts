/**
 * main.ts —— dsh-web 服务入口。
 *
 * 职责：启动服务树 → 起 HTTP 服务 → 托管前端静态资源 → 优雅退出。
 *
 * ## 为什么用 node:http 而不是框架
 *
 * 1. **双运行时**：Node 与 Bun 都完整支持 `node:http`，而 Bun 的 `Bun.serve`
 *    是 Bun 独有的。选 `node:http` 意味着两套运行时跑的是**同一份代码**，
 *    不需要为 Bun 维护一条分支——这正是"运行时可随时指定"的前提。
 * 2. **依赖为零**：这个服务只需要路由 + SSE + 静态文件。引入框架要多一份依赖
 *    树，而框架并不能替代任何 dsh 侧的逻辑。
 *
 * ## 静态资源
 *
 * 生产环境（Docker 镜像）里前端构建产物在 `web/dist`，由本进程直接托管——
 * 部署就是单容器单进程，不需要再挂 Nginx。若 `web/dist` 不存在（开发模式），
 * 则只提供 API，前端由 Vite dev server 代理过来。
 *
 * @module dsh-web/server/main
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { bootWeb } from '../boot.ts'
import { handleRequest, type RouteContext } from './routes.ts'
import { SessionManager } from './sessions.ts'

/** 服务端口。 */
const PORT = Number(process.env.PORT ?? 8787)

/** 监听地址。默认 0.0.0.0（容器内必须，否则外部访问不到）。 */
const HOST = process.env.HOST ?? '0.0.0.0'

/** 前端构建产物目录。 */
const STATIC_ROOT = process.env.DSH_WEB_STATIC ?? resolve(process.cwd(), 'web', 'dist')

/** 允许的跨域来源。开发时前端在 5173。 */
const CORS_ORIGIN = process.env.DSH_WEB_CORS_ORIGIN

/** 静态资源的 MIME 类型。 */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/** 启动服务。 */
async function main(): Promise<void> {
  const web = await bootWeb()
  const sessions = new SessionManager(web.ctx)

  const route: RouteContext = {
    ctx: web.ctx,
    sessions,
    staticRoot: existsSync(STATIC_ROOT) ? STATIC_ROOT : undefined,
    runtime: { name: web.runtime, version: web.runtimeVersion },
    corsOrigin: CORS_ORIGIN,
  }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      try {
        const handled = await handleRequest(request, response, route)
        if (handled) return
        if (route.staticRoot !== undefined && serveStatic(route.staticRoot, request, response)) return
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('Not Found')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        }
        response.end(message)
      }
    })()
  })

  // SSE 是长连接，默认的 keep-alive 超时（5s）会把它掐掉。
  server.keepAliveTimeout = 0
  server.headersTimeout = 0

  await new Promise<void>((resolvePromise) => {
    server.listen(PORT, HOST, () => resolvePromise())
  })

  console.log(
    [
      '',
      'dsh-web 已启动',
      `  地址      http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`,
      `  运行时    ${web.runtime} ${web.runtimeVersion}`,
      `  工具      ${web.ctx.tools.schemas().length} 个（只读对话模式）`,
      `  路由      ${web.ctx.llm.listProviders().length} 个`,
      `  home      ${web.home}`,
      `  前端      ${route.staticRoot ?? '(未构建，仅 API)'}`,
      '',
    ].join('\n'),
  )

  // ── 优雅退出 ────────────────────────────────────────────────────────────
  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    console.log(`\n收到 ${signal}，正在释放…`)
    // 先关 HTTP（不再接新请求），再释放 dsh 服务树（flush 会话日志、关 SQLite）。
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
    await sessions.dispose()
    await web.dispose()
    console.log('已释放。')
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

/**
 * 托管静态文件。
 *
 * 路径安全：把请求路径 normalize 之后拼到 root 下，再确认结果仍在 root 之内，
 * 否则回 403。这挡住 `../` 穿越。
 */
function serveStatic(root: string, request: IncomingMessage, response: ServerResponse): boolean {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  let pathname = decodeURIComponent(url.pathname)
  if (pathname === '/') pathname = '/index.html'

  const candidate = resolve(join(root, normalize(pathname)))
  if (!candidate.startsWith(resolve(root))) {
    response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Forbidden')
    return true
  }

  let target = candidate
  if (existsSync(target) && statSync(target).isDirectory()) {
    target = join(target, 'index.html')
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    // SPA 回退：非 API 路径一律交给前端路由。
    target = join(root, 'index.html')
    if (!existsSync(target)) return false
  }

  const type = MIME_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream'
  response.writeHead(200, {
    'content-type': type,
    // 带 hash 的文件名可以长缓存；index.html 不缓存。
    'cache-control': target.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  })
  createReadStream(target).pipe(response)
  return true
}

main().catch((error: unknown) => {
  console.error(`✗ 启动失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
