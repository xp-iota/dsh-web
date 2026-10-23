#!/bin/sh
# dsh-web 容器入口
#
# 这个脚本刻意做得很薄：它只负责"选运行时 + 交给调度器"，其余全在
# runtime/run.mjs 与 src/server/main.ts 里。这样本地 `npm start` 与容器
# `docker run` 走的是同一条代码路径，不会出现"容器里能跑、本地跑不了"这类
# 无法定位的差异。
#
# ── 关于 PID 1 与信号 ──────────────────────────────────────────────
#
# 容器里这个脚本通过 `exec` 把自己换成 `node runtime/run.mjs`，于是调度器
# 就是 PID 1。**PID 1 不会执行内核对 SIGTERM 的默认动作**，所以调度器内部
# 装了显式的 handler，把 SIGTERM / SIGINT 转发给真正跑服务的子进程，等它
# 优雅退出（flush 会话日志、关 SQLite）后才退出。少了这一步，`docker stop`
# 只能等超时后 SIGKILL，会话数据会丢。
#
# ── 运行时切换 ────────────────────────────────────────────────────
#
# `DSH_RUNTIME=node|bun` 在**启动时**生效。切运行时 = 改环境变量 + 重启容器，
# 不需要换镜像。两套运行时跑同一份源码（src/server/main.ts）。

set -eu

cd /app

# 会话数据目录。镜像里默认 /data（已声明为卷），这里确保它存在。
# 宿主机目录挂载过来时属主可能与容器内 node 用户不同，mkdir 失败不该挡住
# 启动——真正写不进去时 dsh 侧会明确报错。
mkdir -p "${DSH_WEB_HOME:-/data}" 2>/dev/null || true

# 调度器负责：解析可执行文件、校验最低版本、转发信号。
# `exec` 让它成为 PID 1，从而收到 docker stop 发来的 SIGTERM。
exec node runtime/run.mjs src/server/main.ts
