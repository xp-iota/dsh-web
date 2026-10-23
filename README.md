# dsh-web

基于 [`@deepseek-ai/dsh`](https://github.com/deepseek-ai/deepseek-harness) **0.2.1-rc.2** 的智能体 Web 服务。

一句话：**把 dsh 的只读对话能力包成一个能上生产的 Web 应用**——双标签界面（对话 / 轨迹）、流式输出、
一键切成 Bun 运行时、单容器单进程部署。

---

## 目录

- [它是什么](#它是什么)
- [架构：为什么自建薄层](#架构为什么自建薄层)
- [只读模式的边界](#只读模式的边界)
- [目录结构](#目录结构)
- [本地开发](#本地开发)
- [双运行时](#双运行时)
- [容器化与部署](#容器化与部署)
- [环境变量](#环境变量)
- [HTTP API](#http-api)
- [SSE 事件协议](#sse-事件协议)
- [已知限制与坑](#已知限制与坑)

---

## 它是什么

| 维度 | 取值 |
|:--|:--|
| 底座 | `@deepseek-ai/dsh` 0.2.1-rc.2（cordis 服务树，官方 `boot()` + 声明式 `cordis.patch.yml` 装配） |
| 服务端 | 自建薄层：`node:http` + SSE，**零 Web 框架依赖** |
| 前端 | React 19 + Vite 6（对话 / 轨迹双标签） |
| 运行时 | Node.js ≥ 22.18 与 Bun ≥ 1.4.4，**同一份源码，启动时选** |
| 部署 | 单镜像、单进程；Node 与 Bun 同时装在镜像里，`DSH_RUNTIME` 决定用哪个 |
| 能力边界 | **只读对话**：5 个工具，无文件、无 shell、无子进程 |

界面两个标签：

- **对话** —— Markdown 渲染、流式增量、工具调用卡片、用量统计（token in/out）。
- **轨迹** —— turn 大纲表 + 全量事件明细（时间轴、耗时、步数、token、结果）。

---

## 架构：为什么自建薄层

dsh 官方有一套 Web 栈（`dsh-api-gateway`、`dsh-api-session-controller`、`dsh-client-connection`、
`dsh-typert-protocol`）。**本工程没有用它**，原因很具体：

- `dsh-api-remote-access` 与 Typert generator 这两个上游包**尚未发布**（0.2.1-rc.2 里没有）。
  现在按官方栈装配，进程根本起不来，也就无从验证。

所以本工程自建一层薄 HTTP + SSE，只依赖 dsh 的**服务层**（agent / sessions / llm / tools），
不碰它的传输层。装配清单仍然走官方机制（`boot()` + patch 文件），没有手写服务连线。

三个关键选择：

**① `node:http` 而不是框架。**
Node 与 Bun 都完整支持 `node:http`；`Bun.serve` 是 Bun 独有的。选 `node:http` 意味着两套运行时
跑的是**同一份代码**，不需要为 Bun 维护分支——这是「运行时可随时指定」的前提。

**② SSE 而不是 WebSocket。**
事件流是单向的（服务端 → 浏览器），用户输入与审批应答走普通 POST。SSE 有两个现实优势：
它就是 HTTP（浏览器 `EventSource` 直接能用，不需要额外的升级握手与鉴权通道），
而且**自动重连是协议内置的**——代理掐了连接，浏览器会自己重连。

**③ 不编译 TypeScript。**
Node ≥ 22.18 原生支持 type stripping（`node src/server/main.ts`），Bun 原生跑 `.ts`。
镜像里不需要 tsc，也就不存在「容器里跑的和本地验的不是同一份代码」。

---

## 只读模式的边界

只读模式是这个工程的**核心承诺**，不是"暂不支持"。装配清单里没有、也不该有：

```
read / write / edit / bash / pwsh / subagent / workflow / skill
```

保留下来的 5 个工具：

| 工具 | 用途 |
|:--|:--|
| `web_search` | 联网搜索（需要 `DEEPSEEK_API_KEY`） |
| `web_fetch` | 抓取网页 |
| `todo_write` | 任务清单 |
| `exit_plan_mode` | 计划模式收尾 |
| `ask_user_question` | 反问用户 |

**工具数是硬断言**：`runtime/boot-probe.ts` 断言工具数必须恰好是 5，
`runtime/verify.mjs` 进一步断言 Node 与 Bun 上的工具数**一致**。
任何一次装配改动导致工具悄悄消失（比如某个包在某个运行时上加载失败），
校验立刻变红，而不是让一个"少了能力"的版本上线。

被砍掉的东西与原因，都写在 `cordis.patch.yml` 的注释里。举三个例子：

- **砍掉 `tool-skill` 全组** —— `tool-skill` → `workingDirectory` → `fs`（要 stat 路径）→
  `dsh-fs-local` → koffi 原生模块。只读 Web 对话没有工作区、没有磁盘技能，
  为一个用不上的能力付出一个真实文件系统访问面，不划算。
- **砍掉 `permission-presets`** —— 它的 inject 里含 `shell`，只读模式下永远 pending。
  审批策略由 `user-approval` 的 config 直接给出，语义等价。
- **砍掉 `dsh-command-compact`** —— 它在 rc.3 的 peer 约束与 rc.2 冲突。
  自动压缩由 `compaction-basic` 承担。

---

## 目录结构

```
dsh-web/
├── cordis.yml               空根表
├── cordis.patch.yml         ★ 唯一的装配清单（每一处删减都带决策注释）
├── package.json             只读依赖子集（锁定 0.2.1-rc.2）
├── Dockerfile               4 阶段：deps → web → runtime → verify
├── compose.yml              生产编排
├── docker-entrypoint.sh     容器入口（选运行时 + exec 成 PID 1）
├── .env.example             环境变量样例
├── src/
│   ├── boot.ts              用官方 boot() + loadOverlayPatches 启动服务树
│   ├── services.ts          Context 类型增强
│   ├── services/
│   │   └── anthropic-compat/index.ts   provider 适配器（从 dsh-lab 移植）
│   └── server/
│       ├── main.ts          node:http 服务 + 静态托管 + 优雅退出
│       ├── routes.ts        API 端点 + SSE
│       ├── sessions.ts      agent 生命周期、事件桥接、审批/提问应答
│       └── trajectory.ts    对话视图 / 轨迹视图折叠
├── runtime/
│   ├── run.mjs              运行时调度器（所有 npm script 都走它）
│   ├── verify.mjs           双运行时并排校验
│   ├── boot-probe.ts        启动探针（断言服务齐全 + 工具数 = 5）
│   ├── status.mjs           运行时状态盘点
│   ├── runtimes.json        版本清单（唯一真相）
│   └── lib/{runtimes,spawn}.mjs
└── web/                     React + Vite 前端
    └── src/{App.tsx, api.ts, components/*, styles.css}
```

---

## 本地开发

```bash
cd dsh-web
npm install                    # 装依赖
npm --prefix web install       # 装前端依赖

# 后端（8787）
npm start

# 前端（5173，代理 /api 到 8787）
npm run dev:web
```

密钥只走环境变量：

```bash
# PowerShell
$env:LLM_API_KEY = '...'
$env:LLM_BASE_URL = 'https://your-gateway.example.com'
$env:LLM_MODEL   = 'your-model-id'
$env:LLM_VENDOR  = 'fuyao'
npm start
```

跑测试与类型检查：

```bash
npm run typecheck
npm test
npm run verify                 # 双运行时并排校验
```

---

## 双运行时

两套运行时跑**同一份源码**，切换只是换一个可执行文件。

```bash
npm start                      # Node（默认）
npm run start:bun              # Bun
DSH_RUNTIME=bun npm start     # 同上，改默认值
```

⚠️ `--runtime` 是调度器自己的参数，不能透传给 npm：

```bash
npm run M07 -- --runtime bun   # ✗ EUNKNOWNCONFIG（npm 抢了这个 flag）
```

版本要求（`runtime/runtimes.json` 是唯一真相）：

| 运行时 | 最低 | 当前验证版本 | 为什么是这个下限 |
|:--|:--|:--|:--|
| Node.js | 22.18.0 | 26.12.1 | ≥ 22.18 才有原生 type stripping；`dsh-agent-loop` 用到 `Promise.withResolvers` |
| Bun | 1.4.4 | 1.4.4 | 更早的 Bun 缺 `node:util.getSystemErrorMessage` |

### 为什么 Bun 侧不需要任何补丁

`dsh-lab` 需要两个 Bun preload shim 才能跑通：`node:module.stripTypeScriptTypes`
（只有 `dsh-ptc-runtime-node` 用它）与 subprocess 的 `--` 分隔符（`dsh-subprocess-local` 的
runner 协议依赖它）。

`dsh-web` 是只读模式，**既不挂 PTC 也不挂 subprocess**，两个坑都不触及——于是**零 shim**。

这不是假设，是断言出来的：`runtime/verify.mjs` 在两套运行时上跑 typecheck + test + 启动探针，
并比对工具数必须一致。任何 Bun 侧的静默降级都会让校验红掉。

```
$ npm run verify
运行时        版本          检查         结果
node         26.12.1       typecheck    ✓ exit 0
node         26.12.1       test         ✓ 12 pass / 0 fail
node         26.12.1       boot         ✓ services ok, tools 5
bun          1.4.4         typecheck    ✓ exit 0
bun          1.4.4         test         ✓ 12 pass / 0 fail
bun          1.4.4         boot         ✓ services ok, tools 5
cross        -             parity       ✓ 两套运行时工具数一致（5）
RUNTIMES_VERIFY_OK runtimes=2 checks=7
```

---

## 容器化与部署

### 构建

```bash
docker build -t dsh-web:latest .
```

4 个阶段：

| 阶段 | 作用 | 进入最终镜像 |
|:--|:--|:--|
| `deps` | `npm ci --omit=dev` 装后端生产依赖 | ✓（只拷 node_modules） |
| `web` | `npm ci` + `tsc -b && vite build` 产出 `web/dist` | ✓（只拷 dist） |
| `runtime` | Node + Bun 并存的最终镜像 | — |
| `verify` | 在镜像**内部**再跑一遍双运行时校验 | ✗（独立目标） |

```bash
# 顺带验证镜像里的两套运行时
docker build --target verify -t dsh-web:verify .
```

### 运行

```bash
docker run -d --name dsh-web -p 8787:8787 \
  -e LLM_API_KEY=... \
  -e LLM_BASE_URL=... \
  -e LLM_MODEL=... \
  -e DSH_RUNTIME=bun \
  -v dsh-web-data:/data \
  dsh-web:latest
```

或者用 compose：

```bash
cp .env.example .env      # 填密钥
docker compose up -d --build
docker compose logs -f
```

### 切换运行时

**启动时生效**，不需要换镜像、不需要重新构建：

```bash
# compose
# 在 .env 里改 DSH_RUNTIME，然后
docker compose up -d

# 或者直接 docker run 覆盖
docker run -d -e DSH_RUNTIME=bun ... dsh-web:latest
```

验证当前跑在哪个运行时上：

```bash
curl http://127.0.0.1:8787/api/health
# {"ok":true,"runtime":{"name":"bun","version":"1.4.4"},"tools":5,...}
```

### 数据持久化

会话日志（每会话一份 JSONL）与 SQLite 索引都落在 `DSH_WEB_HOME` 下，
镜像里是 `/data`，compose 里挂了命名卷 `dsh-web-data`。

- `docker compose down` → 卷保留。
- `docker compose down -v` → **卷被删，全部历史会话丢失**。

### 容器内的信号处理

容器里 `docker-entrypoint.sh` 用 `exec` 把自己换成 `node runtime/run.mjs`，
于是调度器是 **PID 1**。PID 1 不会执行内核对 SIGTERM 的默认动作，所以调度器内部装了显式
handler，把 SIGTERM / SIGINT **转发**给真正跑服务的子进程，等它优雅退出
（flush 会话日志、关 SQLite）后才退出。

少了这一步，`docker stop` 只能等超时后 SIGKILL，会话数据会丢。

---

## 环境变量

### 模型路由（必填）

| 变量 | 说明 | 默认 |
|:--|:--|:--|
| `LLM_BASE_URL` | Anthropic 兼容网关基地址（不含 `/v1/messages`） | `https://api.minimaxi.com/anthropic` |
| `LLM_MODEL` | 模型 id，必须与网关实际支持的完全一致 | `MiniMax-M3` |
| `LLM_API_KEY` | 网关密钥 | — |
| `LLM_VENDOR` | `fuyao` \| `minimax` \| 空。决定请求头与端点细节 | 空 |
| `DSH_MODEL_PROVIDER` | 路由名，必须与 `cordis.patch.yml` 注册的一致 | `anthropic-compat` |
| `DSH_MODEL` | 模型（优先于 `LLM_MODEL`） | 同 `LLM_MODEL` |
| `DEEPSEEK_API_KEY` | 可选：DeepSeek 原生路由与 web 搜索用的 key | — |

> ⚠️ 变量**不要设成空字符串**。代码用的是 `process.env.X ?? 默认值`，空字符串不是 nullish，
> 会把默认值顶掉。用 `docker run -e VAR`（不赋值）或在 compose 里省略该行。

### 服务与运行时

| 变量 | 说明 | 默认 |
|:--|:--|:--|
| `DSH_RUNTIME` | `node` \| `bun`。**启动时**生效 | `node` |
| `PORT` | 监听端口 | `8787` |
| `HOST` | 监听地址 | `0.0.0.0` |
| `DSH_WEB_HOME` | 会话数据根目录 | 工程内 `.dsh-home/`（镜像里 `/data`） |
| `DSH_WEB_STATIC` | 前端产物目录 | `web/dist` |
| `DSH_WEB_CORS_ORIGIN` | 允许的跨域来源；生产默认同源，不用设 | — |

---

## HTTP API

| 方法 | 路径 | 说明 |
|:--|:--|:--|
| `GET` | `/api/health` | `{ok, runtime, tools, providers, version}` |
| `GET` | `/api/sessions` | `{sessions:[{sessionId, title, cwd, live, persisted}]}` |
| `POST` | `/api/sessions` | → `201 {sessionId}` |
| `GET` | `/api/sessions/:id` | `{sessionId, title, cwd, transcript, trajectory}` |
| `POST` | `/api/sessions/:id/messages` | → `202 {accepted}`；斜杠命令走 commands 服务 → `200 {kind, text}` |
| `GET` | `/api/sessions/:id/stream` | SSE 事件流 |
| `POST` | `/api/sessions/:id/approvals/:requestId` | `{ok}` |
| `POST` | `/api/sessions/:id/questions/:requestId` | `{ok}` |

非 `/api/` 的路径交给前端静态资源托管（SPA 回退到 `index.html`）。

---

## SSE 事件协议

每帧形如：

```
data: {"type":"assistant/delta","seq":12,"time":1792745937000,"data":{...}}
```

`seq` 在会话内单调递增；`type` 取值：

```
session/started   turn/start       turn/end        step/start      step/end
assistant/delta   assistant/reasoning   assistant/block-end
tool/call         tool/result
approval/request  approval/decided
questions/request questions/answered
agent/error       agent/status     command/result
```

心跳每 25 秒一条 SSE 注释帧（`: ping`），用来穿过反向代理的空闲超时。
响应头带 `x-accel-buffering: no`（Nginx 默认会缓冲 SSE）。

前端在 `turn/end` 时会**重新拉一次服务端快照**校准 transcript——用权威的落盘数据覆盖
增量拼接的结果，避免前端拼接与服务端记录漂移。

---

## 已知限制与坑

### 1. 会话标题的辅助调用与主对话共享错误收口

`session-title-llm` 的 `provider` / `model` **不继承** agent 的默认模型，缺省会落到它自己的
默认路由（`deepseek-v4.1-flash`）。在只装了一个 Anthropic 兼容网关的部署里那个路由不存在，
标题生成会 404——而且因为它跑在辅助调用上，**主对话会跟着一起失败**。

`cordis.patch.yml` 里已显式配上与主对话同路由的 provider/model。但如果你改了 provider，
记得同时改这一处。

### 2. `agent-default-model` 不会自动注入 agent

它只回答"新 agent 该用哪个模型"。创建入口必须主动查
`ctx.agentDefaultModel.currentSelection()`，否则首次调模型抛 `has no provider/model`。

### 3. dsh 0.2.1 的两处 API 漂移（已在移植时修正）

从 dsh-lab 移植 provider 适配器时踩到：dsh-lab 的旧代码带 `as any`，类型检查不报错，
但运行期会炸。

- `credentials.resolve()` 在 0.2.1 接受 **CredentialRef 字符串**（环境变量名），
  不是 `{ kind: 'env', name }` 对象。传对象会一路走到
  `dsh-launch-environment` 的 `lookupKey()`，炸成 `name.toUpperCase is not a function`。
- `resolveModel()` 必须返回 `{ provider, id, name }`（`id` 严格等于 model id），
  旧写法返回 `{ provider, model, displayName }` → `INVALID_MODEL_INFO`。

### 4. 事件载荷有两种形状

- `tool/result` 的消息体在 `data.message`；
- `user/message` / `assistant/message` 的负载直接摊在 `data` 上。

两种都要认。

### 5. `session/event` 是两个位置参数

`ctx.on('session/event', (session, event) => ...)`——按 payload 解构会**静默收不到事件**。
而 `agent/assistant-stream` / `agent/error` 是 payload 对象形式。

### 6. 流式帧的真实结构

`agent/assistant-stream` 的载荷是 `{ type: 'chunk', chunk: StreamChunk }`——
**真正的 chunk 在 `frame.chunk` 里**，而 `frame.type` 恒为 `'chunk'`。
按 `frame.type === 'text-delta'` 判断会永远不匹配，症状是「模型答了但界面全空」，
而 turn 照常完成、会话日志照常有内容。

### 7. 会话 SQLite 是内存库

`dsh-session-query-sqlite` 配了 `path: ':memory:'` + `openAt: never`。
历史会话靠 JSONL 日志回放，SQLite 只做当次进程内的索引。
这是刻意的：落盘的 SQLite 会引入锁与迁移问题，而只读场景不需要全文检索。

### 8. 前端构建产物由同一个进程托管

部署是单容器单进程，不需要再挂 Nginx。但如果前面有反向代理，**必须**关掉对
`/api/*/stream` 的缓冲，否则 SSE 会被攒着不发（响应头已带 `x-accel-buffering: no`，
但代理侧仍要确认 `proxy_buffering off`）。

---

## 相关文档

- [`dsh-lab`](https://github.com/xp-iota/hello-olleh/tree/main/dsh-lab) —— dsh 能力全量实验室，本工程的许多决策源自那里的实测。
- [`docs/hello-dsh/`](https://github.com/xp-iota/hello-olleh/tree/main/docs/hello-dsh) —— dsh 内部分析文档集。
