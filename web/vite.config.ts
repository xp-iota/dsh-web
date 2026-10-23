import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Vite 配置。
 *
 * 开发模式下前端跑在 5173，API 在 8787 —— 代理 `/api` 过去，这样前端的 fetch 与
 * EventSource 都用相对路径，不需要配置任何绝对地址。
 *
 * 生产模式下 `npm run build` 产出 `dist/`，由 dsh-web 的 Node/Bun 进程直接托管
 * （见 src/server/main.ts 的 serveStatic），部署就是单容器单进程。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        // SSE 必须关闭缓冲，否则事件会被攒着不发。
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['x-accel-buffering'] = 'no'
            }
          })
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
