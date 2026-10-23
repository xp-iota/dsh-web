/**
 * sessions.ts —— 会话管理：agent 生命周期 + 事件桥接 + 人机交互应答。
 *
 * 这是 dsh-lab REPL 的 Web 化。REPL 用终端做界面，本模块用 HTTP + SSE 做界面，
 * **但只有界面换了**：turn/step 的推进、工具调度、压缩、重试全部仍由
 * dsh-agent-loop 完成，本模块不实现第二套循环。
 *
 * ## 三条数据通路
 *
 *   1. **人输入 → agent**：`agent.followup(createUserMessage(...))`（M04 的 inbox 接缝）
 *   2. **模型流 → 浏览器**：监听 `agent/assistant-stream`，把帧转成 SSE 事件
 *   3. **会话日志 → 轨迹页**：监听 `session/event`，落进会话日志，轨迹页再读回来
 *
 * ## 事件路由
 *
 * 一个进程里可以同时有多个会话（多个浏览器标签页）。dsh 的事件是**进程级**的
 * （`ctx.on('session/event', (session, event) => ...)`），所以必须按 session id
 * 过滤。`agent/assistant-stream` 的 payload 里带 agent 对象，用对象身份比对。
 *
 * ## 一个关键陷阱
 *
 * `'session/event'` 的签名是**两个位置参数** `(session, event)`，不像 `agent/*`
 * 那样收一个 payload 对象。按 payload 解构会让监听永远拿不到事件——而且不报错，
 * 只是工具行与 turn 收尾行从来不出现。dsh-lab 踩过这个坑。
 *
 * @module dsh-web/server/sessions
 */
import '../services.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import '@deepseek-ai/dsh-session-query'
import '@deepseek-ai/dsh-user-approval/types'
import '@deepseek-ai/dsh-user-questions'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionRequestEvent, AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'

/** 推给浏览器的事件类型。 */
export type WireEventType =
  | 'session/started'
  | 'turn/start'
  | 'turn/end'
  | 'step/start'
  | 'step/end'
  | 'assistant/delta'
  | 'assistant/reasoning'
  | 'assistant/block-end'
  | 'tool/call'
  | 'tool/result'
  | 'approval/request'
  | 'approval/decided'
  | 'questions/request'
  | 'questions/answered'
  | 'agent/error'
  | 'agent/status'
  | 'command/result'

/** 一条推给浏览器的 SSE 事件。 */
export interface WireEvent {
  type: WireEventType
  /** 事件序号（会话内单调递增），前端据此排序与去重。 */
  seq: number
  /** 事件发生时间（毫秒）。 */
  time: number
  /** 载荷。 */
  data: Record<string, unknown>
}

/** SSE 订阅者。 */
export type Subscriber = (event: WireEvent) => void

/** 一个会话的运行时状态。 */
interface SessionState {
  readonly id: string
  handle: AgentHandle | undefined
  agent: Agent | undefined
  readonly subscribers: Set<Subscriber>
  /** 待应答的审批请求。 */
  readonly approvals: Map<string, (outcome: ApprovalOutcome) => void>
  /** 待应答的提问请求。 */
  readonly questions: Map<string, (answer: AskUserQuestionAnswer) => void>
  /** 会话内事件序号。 */
  seq: number
  /** 本轮是否正在运行。 */
  running: boolean
}

/** 会话管理器。 */
export class SessionManager {
  private readonly ctx: Context
  private readonly sessions = new Map<string, SessionState>()
  private readonly disposers: (() => void)[] = []

  constructor(ctx: Context) {
    this.ctx = ctx
    this.installGlobalListeners()
  }

  /**
   * 进程级事件监听。
   *
   * 这些监听是**进程级**的（不是 agent 作用域），所以要自己按会话过滤。
   * 好处是后创建的会话也能收到事件；代价是必须小心过滤，否则会把 A 会话的
   * 事件推给 B 会话。
   */
  private installGlobalListeners(): void {
    const ctx = this.ctx

    // 流式帧：文本增量 / 推理增量 / 工具调用增量。
    //
    // 载荷结构是 `{ type: 'chunk', chunk: StreamChunk }`——**真正的 chunk 在
    // `frame.chunk` 里**，而 `frame.type` 恒为 'chunk'。按 `frame.type ===
    // 'text-delta'` 判断会永远不匹配，于是流式输出一个字都不显示，而 turn
    // 照常完成、会话日志照常有内容——症状是「模型答了但界面是空的」。
    const onStream = ctx.on(
      'agent/assistant-stream',
      ((payload: { agent: Agent; frame: any }) => {
        const state = this.findByAgent(payload.agent)
        if (state === undefined) return
        const frame = payload.frame
        if (frame?.type !== 'chunk') return
        const chunk = frame.chunk
        if (chunk === undefined) return
        switch (chunk.type) {
          case 'text-delta':
            this.emit(state, 'assistant/delta', { text: chunk.text ?? '' })
            break
          case 'reasoning-delta':
            this.emit(state, 'assistant/reasoning', { text: chunk.text ?? '' })
            break
          case 'block-end':
            this.emit(state, 'assistant/block-end', {
              blockType: chunk.block?.type ?? 'text',
              text: chunk.block?.text ?? '',
              toolName: chunk.block?.name,
              toolCallId: chunk.block?.id === undefined ? undefined : String(chunk.block.id),
            })
            break
          case 'tool-call-delta':
            this.emit(state, 'tool/call', {
              name: chunk.name ?? '',
              callId: chunk.id === undefined ? undefined : String(chunk.id),
              argumentsDelta: chunk.argumentsDelta ?? '',
            })
            break
          default:
            break
        }
      }) as never,
    )
    this.disposers.push(onStream as () => void)

    // 会话事件：注意是**两个位置参数**。
    const onEvent = ctx.on(
      'session/event',
      ((session: { id: string }, event: any) => {
        const state = this.sessions.get(String(session.id))
        if (state === undefined) return
        const data = (event.data ?? {}) as Record<string, unknown>
        switch (event.type) {
          case 'turn/start':
            this.emit(state, 'turn/start', { turn: data.turn })
            break
          case 'turn/end':
            state.running = false
            this.emit(state, 'turn/end', { turn: data.turn, reason: reasonText(data.reason) })
            break
          case 'step/start':
            this.emit(state, 'step/start', { step: data.step })
            break
          case 'step/end':
            this.emit(state, 'step/end', { step: data.step })
            break
          case 'tool/call':
            this.emit(state, 'tool/call', {
              name: String(data.name ?? ''),
              arguments: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {}),
            })
            break
          case 'tool/result': {
            const message = (data.message ?? {}) as { content?: unknown; isError?: boolean }
            this.emit(state, 'tool/result', {
              isError: message.isError === true,
              content: textOf(message.content),
            })
            break
          }
          default:
            break
        }
      }) as never,
    )
    this.disposers.push(onEvent as () => void)

    // 运行期错误必须可见。
    const onError = ctx.on(
      'agent/error',
      ((payload: { agent: Agent; error: unknown }) => {
        const state = this.findByAgent(payload.agent)
        if (state === undefined) return
        const message = payload.error instanceof Error ? payload.error.message : String(payload.error)
        state.running = false
        this.emit(state, 'agent/error', { message })
      }) as never,
    )
    this.disposers.push(onError as () => void)

    // 运行状态变化。
    const onStatus = ctx.on(
      'agent/status',
      ((payload: { agent: Agent; status: string }) => {
        const state = this.findByAgent(payload.agent)
        if (state === undefined) return
        this.emit(state, 'agent/status', { status: String(payload.status) })
      }) as never,
    )
    this.disposers.push(onStatus as () => void)
  }

  /**
   * 读取当前默认模型选择。
   *
   * 服务不存在时（装配清单里没有 `agent-default-model` 行）返回空对象——调用方
   * 会因为缺 provider/model 而在真正调模型时报一个明确的错，而不是在这里就崩。
   */
  private currentDefaultSelection(): { provider?: string; model?: string } {
    const service = this.ctx.get('agentDefaultModel' as never) as
      | { currentSelection?: () => { provider?: string; model?: string } }
      | undefined
    if (service?.currentSelection === undefined) return {}
    try {
      return service.currentSelection()
    } catch {
      return {}
    }
  }

  /** 按 agent 对象找会话（用对象身份，而不是 id 字符串比较）。 */
  private findByAgent(agent: Agent): SessionState | undefined {
    for (const state of this.sessions.values()) {
      if (state.agent === agent) return state
    }
    return undefined
  }

  /** 给一个会话发事件。 */
  private emit(state: SessionState, type: WireEventType, data: Record<string, unknown>): void {
    state.seq += 1
    const event: WireEvent = { type, seq: state.seq, time: Date.now(), data }
    for (const subscriber of state.subscribers) {
      try {
        subscriber(event)
      } catch {
        // 单个订阅者出错不能影响其他订阅者与事件流本身。
      }
    }
  }

  /**
   * 创建或恢复一个会话。
   *
   * @param options.resume - 要恢复的会话 id；省略则新建。
   * @param options.provider - 覆盖模型路由。
   * @param options.model - 覆盖模型名。
   */
  async open(options: { resume?: string; provider?: string; model?: string } = {}): Promise<string> {
    const agentOptions: { provider?: string; model?: string } = {}

    // 默认模型来自 `dsh-agent-default-model` 服务。
    //
    // 关键点：那个服务**只回答「新 agent 该用哪个模型」**，它不会自动把默认值
    // 注入 agent。创建 agent 的入口必须主动查一次——否则 agent-loop 在第一次
    // 请求时就会抛 "has no provider/model"，而且这个错误只在真正调模型时
    // 才出现，表现为「turn 以 error 结束」，非常难查。
    //
    // 显式传入的 provider/model 优先于默认值（前端可以切换模型）。
    const defaults = this.currentDefaultSelection()
    agentOptions.provider = options.provider ?? defaults.provider
    agentOptions.model = options.model ?? defaults.model

    const existing = options.resume === undefined ? undefined : this.sessions.get(options.resume)
    if (existing !== undefined && existing.agent !== undefined) {
      return existing.id
    }

    const sessionId = options.resume ?? crypto.randomUUID()
    const state: SessionState = {
      id: sessionId,
      handle: undefined,
      agent: undefined,
      subscribers: new Set(),
      approvals: new Map(),
      questions: new Map(),
      seq: 0,
      running: false,
    }
    this.sessions.set(sessionId, state)

    const handle =
      options.resume === undefined
        ? await this.ctx.agents.create({
            sessionId: SessionId(sessionId),
            meta: { cwd: process.cwd() },
            agentOptions,
            setup: (agentCtx: Context) => this.composeAgentScope(agentCtx, state),
          })
        : await this.ctx.agents.resume({
            resumeSessionId: SessionId(options.resume),
            agentOptions,
            setup: (agentCtx: Context) => this.composeAgentScope(agentCtx, state),
          })

    state.handle = handle
    state.agent = handle.agent
    this.emit(state, 'session/started', { sessionId: state.id })
    return state.id
  }

  /**
   * agent 作用域内的接缝装配：审批回答器 + 提问回答器。
   *
   * 两者都是 **waterfall**：返回结果就"认领"这次请求。这里把请求转成 SSE 帧推给
   * 浏览器，然后等前端 POST 回答案再 resolve。终端是最后一道，所以这里直接返回
   * 结果——Web 场景下前端就是那道终端。
   */
  private composeAgentScope(agentCtx: Context, state: SessionState): void {
    agentCtx.on(
      'approval/request',
      async (request: { toolName: string; reason?: string }): Promise<ApprovalOutcome> => {
        const requestId = crypto.randomUUID()
        this.emit(state, 'approval/request', {
          requestId,
          toolName: request.toolName,
          reason: request.reason ?? '',
        })
        const outcome = await new Promise<ApprovalOutcome>((resolve) => {
          state.approvals.set(requestId, resolve)
          // 兜底：前端断开时不能让 agent 永远挂起。
          setTimeout(() => {
            if (state.approvals.delete(requestId)) resolve('rejected')
          }, 5 * 60_000).unref?.()
        })
        this.emit(state, 'approval/decided', { requestId, outcome })
        return outcome
      },
    )

    agentCtx.on(
      'user-questions/request',
      async (request: AskUserQuestionRequestEvent): Promise<AskUserQuestionAnswer> => {
        const requestId = crypto.randomUUID()
        this.emit(state, 'questions/request', {
          requestId,
          questions: (request.questions ?? []) as unknown,
        })
        const answer = await new Promise<AskUserQuestionAnswer>((resolve) => {
          state.questions.set(requestId, resolve)
          setTimeout(() => {
            if (state.questions.delete(requestId)) resolve({ answers: [] })
          }, 5 * 60_000).unref?.()
        })
        this.emit(state, 'questions/answered', { requestId })
        return answer
      },
    )
  }

  /**
   * 提交一条用户消息。
   *
   * 走的是和 dsh-lab REPL 完全一样的接缝：`agent.followup(createUserMessage(...))`。
   */
  async send(sessionId: string, text: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (state === undefined) throw new Error(`会话不存在：${sessionId}`)
    const agent = state.agent
    if (agent === undefined) throw new Error(`会话未就绪：${sessionId}`)
    state.running = true
    agent.followup(
      createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    )
    // 不 await whenIdle：请求立即返回，模型输出通过 SSE 推送。
    // 这是"发送即返回、事件流式到达"的关键。
  }

  /** 应答一次审批请求。 */
  answerApproval(sessionId: string, requestId: string, outcome: ApprovalOutcome): boolean {
    const state = this.sessions.get(sessionId)
    if (state === undefined) return false
    const resolve = state.approvals.get(requestId)
    if (resolve === undefined) return false
    state.approvals.delete(requestId)
    resolve(outcome)
    return true
  }

  /** 应答一次提问请求。 */
  answerQuestions(sessionId: string, requestId: string, answer: AskUserQuestionAnswer): boolean {
    const state = this.sessions.get(sessionId)
    if (state === undefined) return false
    const resolve = state.questions.get(requestId)
    if (resolve === undefined) return false
    state.questions.delete(requestId)
    resolve(answer)
    return true
  }

  /** 订阅某会话的事件流。返回退订函数。 */
  subscribe(sessionId: string, subscriber: Subscriber): (() => void) | undefined {
    const state = this.sessions.get(sessionId)
    if (state === undefined) return undefined
    state.subscribers.add(subscriber)
    return () => {
      state.subscribers.delete(subscriber)
    }
  }

  /** 会话是否正在运行。 */
  isRunning(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.running === true
  }

  /**
   * 取某会话的 agent 对象（供斜杠命令执行用）。
   *
   * 这是给路由层用的公开入口，而不是让路由去摸内部 Map——那会让内部结构
   * 变成事实上的公开 API，改一次字段名就要改两个文件。
   */
  agentOf(sessionId: string): Agent | undefined {
    return this.sessions.get(sessionId)?.agent
  }

  /** 关闭一个会话：释放 agent 并清掉订阅者。 */
  async close(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (state === undefined) return
    // 未应答的请求要主动 resolve，否则 agent 释放时会挂在 waterfall 上。
    for (const resolve of state.approvals.values()) resolve('rejected')
    state.approvals.clear()
    for (const resolve of state.questions.values()) resolve({ answers: [] })
    state.questions.clear()
    state.subscribers.clear()
    if (state.handle !== undefined) {
      const handle = state.handle
      state.handle = undefined
      state.agent = undefined
      await handle.dispose()
    }
    this.sessions.delete(sessionId)
  }

  /** 释放管理器：关掉所有会话与全局监听。 */
  async dispose(): Promise<void> {
    for (const disposer of this.disposers.splice(0)) {
      try {
        disposer()
      } catch {
        // 已经解绑的监听再 dispose 一次是安全的。
      }
    }
    for (const id of [...this.sessions.keys()]) {
      await this.close(id)
    }
  }
}

/** 取 content（block 数组或字符串）里的纯文本。 */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: { type?: string; text?: string }) => (block?.type === 'text' ? (block.text ?? '') : ''))
    .filter(Boolean)
    .join(' ')
}

/** `turn/end` 的 reason 是结构化对象（`{kind:'completed'}`），不是字符串。 */
export function reasonText(reason: unknown): string {
  if (typeof reason === 'string') return reason
  if (reason !== null && typeof reason === 'object' && 'kind' in reason) {
    return String((reason as { kind: unknown }).kind)
  }
  return String(reason ?? '')
}

/** 导出 StreamChunk 类型，供服务端其他模块引用。 */
export type { StreamChunk }
