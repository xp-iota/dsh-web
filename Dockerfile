# syntax=docker/dockerfile:1
#
# dsh-web 生产镜像
# ═══════════════════════════════════════════════════════════════════════
#
# 这个镜像有三个不平凡的地方，每一个都是为了一个具体需求：
#
#   1. **Node 与 Bun 同时装在一张镜像里**。
#      需求是"运行时可以随时指定为 nodejs 或者 bun"。如果做成两个镜像，
#      切换运行时就要换镜像 —— 换镜像和换运行时是两件事，生产上极易配错
#      （镜像里是 Bun，配置里却写着 node）。做成一张镜像、启动时用
#      `DSH_RUNTIME` 选，运行时切换就退化成"改一个环境变量 + 重启"。
#
#   2. **不编译 TypeScript**。
#      Node ≥ 22.18 原生支持 type stripping（`node src/server/main.ts`），
#      Bun 原生跑 .ts。镜像里不需要 tsc，也不需要 dist/ 产物 —— 少一层构建，
#      也少一类"容器里跑的和本地验的不是同一份代码"的问题。
#
#   3. **前端产物由同一个进程托管**。
#      `src/server/main.ts` 的 serveStatic 直接发 `web/dist`，部署是单容器
#      单进程，不需要再挂 Nginx 或 Caddy。
#
# ── 构建 ────────────────────────────────────────────────────────────
#     docker build -t dsh-web:latest .                 # 默认目标 = runtime
#     docker build --target verify -t dsh-web:verify . # 顺带跑双运行时校验
#
# ── 运行 ────────────────────────────────────────────────────────────
#     docker run -d -p 8787:8787 \
#       -e LLM_API_KEY=... -e LLM_BASE_URL=... -e LLM_MODEL=... \
#       -e DSH_RUNTIME=bun \
#       -v dsh-web-data:/data \
#       dsh-web:latest
#
# ── 换运行时 ────────────────────────────────────────────────────────
#     docker run -d -e DSH_RUNTIME=bun ... dsh-web:latest
#     # 或者不改镜像，只改环境变量后重启容器。
#
# 运行时切换是**启动时**生效的：改 `DSH_RUNTIME` 后必须重启容器。
# 两套运行时跑的是同一份源码（`src/server/main.ts`），没有各自的分支。
#
# ── 阶段顺序 ────────────────────────────────────────────────────────
#
# BuildKit 的默认目标是**文件里最后一个阶段**。所以 `runtime` 必须排在最后，
# 否则 `docker build .` 建出来的是别的东西。本文件的顺序是：
#
#     base ──> deps ──┐
#           └─> web ──┼──> runtime   ← 默认目标，最终镜像
#                  └──> verify        ← 可选目标，在镜像内跑双运行时校验
#
# `verify` 与 `runtime` 是 `base` 的兄弟节点，不是它的后继 —— 这样既能让
# `runtime` 当默认目标，又不用把两套运行时重复装两遍。

ARG NODE_VERSION=26.12.1
ARG BUN_VERSION=1.4.4

# ─────────────────────────────────────────────────────────────────────
# 基础阶段：Node + Bun
#
# Node 来自官方镜像；Bun 通过 npm 官方包安装（`bun` 包用 optionalDependencies
# 分发各平台的预编译二进制，不需要在镜像里下 GitHub release、不需要 unzip、
# 不需要编译）。
#
# 这个阶段**故意不设 NODE_ENV=production**：npm 会拿 NODE_ENV 决定要不要装
# devDependencies，一旦设了，后面 `npm ci` 想装 typescript 就会静默地装不上。
# 需要 devDependencies 的阶段（verify）显式写 `--include=dev`。
# ─────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG BUN_VERSION
RUN npm install -g "bun@${BUN_VERSION}" \
 && bun --version \
 && node --version

# ─────────────────────────────────────────────────────────────────────
# 阶段：后端生产依赖
#
# 只装 `dependencies`，`devDependencies`（typescript / @types/node）不进来。
# 单独一层的目的只有一个：package.json / package-lock.json 变了才重装，
# 改源码不会让 npm 重跑一遍。
# ─────────────────────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app

# 只拷清单：源码不进这一层，依赖安装因此可以稳定命中缓存。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# ─────────────────────────────────────────────────────────────────────
# 阶段：前端构建
#
# 用与后端同一个 Node 大版本构建，避免出现"构建机装得下、运行时跑不动"。
# ─────────────────────────────────────────────────────────────────────
FROM base AS web
WORKDIR /app/web

COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY web/ ./
# `npm run build` = `tsc -b && vite build`，产物在 /app/web/dist。
RUN npm run build

# ─────────────────────────────────────────────────────────────────────
# 阶段：校验（可选目标，`--target verify`）
#
# 在**镜像内部**再跑一遍双运行时校验（typecheck + test + 启动探针），
# 证明这台机器上的 Node 和 Bun 都能把只读服务树完整拉起来、且工具数一致。
#
# `--include=dev` 不能省：typescript 在 devDependencies 里。
# ─────────────────────────────────────────────────────────────────────
FROM base AS verify
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

COPY tsconfig.json cordis.yml cordis.patch.yml ./
COPY src ./src
COPY runtime ./runtime
# 这一步会打印 RUNTIMES_VERIFY_OK runtimes=2 checks=7；不绿则构建失败。
RUN node runtime/verify.mjs

# ─────────────────────────────────────────────────────────────────────
# 阶段：运行时镜像（默认目标）
# ─────────────────────────────────────────────────────────────────────
FROM base AS runtime

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PORT=8787 \
    HOST=0.0.0.0 \
    DSH_WEB_HOME=/data \
    DSH_RUNTIME=node

WORKDIR /app

# 后端：生产依赖 + 源码 + 装配清单 + 运行时调度层。
COPY --from=deps /app/node_modules ./node_modules
COPY package.json cordis.yml cordis.patch.yml tsconfig.json ./
COPY src ./src
COPY runtime ./runtime

# 前端：构建好的静态资源。
COPY --from=web /app/web/dist ./web/dist

COPY docker-entrypoint.sh /usr/local/bin/dsh-web-entrypoint
RUN chmod 0755 /usr/local/bin/dsh-web-entrypoint \
 && mkdir -p /data \
 && chown -R node:node /data /app

# 以非 root 运行。Node 官方镜像自带 node 用户（uid 1000）。
USER node

# 会话日志、SQLite 索引都落在这里，挂了卷就能跨重启保留。
VOLUME ["/data"]

EXPOSE 8787

# 健康检查直接打 /api/health：它会报出当前运行时、工具数、provider 数，
# 比"端口通"更能说明服务真的起来了。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dsh-web-entrypoint"]
