/**
 * trajectory.ts —— 轨迹视图的数据加工。
 *
 * 数据来源是官方 `ctx.sessionQuery`（`dsh-session-query` 的精确读面），不是自建
 * 日志解析：`readSession()` 会做一次完整的 replay 校验，读出来的事件序列就是
 * 真正被信任的那一份。
 *
 * 加工出两个视图（对应前端两个标签）：
 *
 *   1. **对话**（transcript）—— 面向阅读的消息序列：人类的话、模型的答复、
 *      工具调用的结果。过滤掉运行时注入的上下文块（runtime-context、skills
 *      提示等），它们不是"对话"。
 *   2. **轨迹**（trajectory）—— 面向排查的结构化视图：turn 大纲（每个 turn 的
 *      编号、起止、耗时、提示词摘要、token 用量）+ 逐事件明细。
 *
 * @module dsh-web/server/trajectory
 */
import '../services.ts'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import '@deepseek-ai/dsh-session-query'

/** 一条事件的数据体（0.2.1 把负载统一放在 `data` 里）。 */
type EventData<T extends SessionEvent> = T['data']

/** turn 大纲的一行。 */
export interface TurnSummary {
  readonly number: number
  readonly startSeq: number
  readonly endSeq: number | undefined
  readonly startTime: number
  readonly endTime: number | undefined
  readonly durationMs: number
  readonly reason: string | undefined
  readonly prompt: string
  readonly steps: number
  readonly toolCalls: number
  readonly inputTokens: number
  readonly outputTokens: number
}

/** 对话视图的一条消息。 */
export interface TranscriptEntry {
  readonly kind: 'user' | 'assistant' | 'tool'
  readonly seq: number
  readonly time: number
  /** 消息正文（Markdown）。 */
  readonly text: string
  /** 工具名（kind === 'tool' 时有值）。 */
  readonly toolName?: string
  /** 工具是否失败。 */
  readonly isError?: boolean
  /** 工具调用参数（kind === 'tool' 时有值）。 */
  readonly arguments?: string
}

/** 轨迹视图的一条事件明细。 */
export interface TrajectoryEvent {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly detail: string
  readonly level: 'info' | 'muted' | 'accent'
}

/** 轨迹视图的完整响应。 */
export interface TrajectoryView {
  readonly sessionId: string
  readonly title: string | undefined
  readonly cwd: string | undefined
  readonly eventCount: number
  readonly turns: TurnSummary[]
  readonly events: TrajectoryEvent[]
  readonly totals: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly toolCalls: number
    readonly durationMs: number
  }
}

/**
 * 把事件序列折叠成 turn 列表。
 *
 * 与 dsh-lab 的同名函数同源：只认人类说的话（runtime-context、skills 提示也是
 * user/message，但把它们当"提示词"印进大纲毫无意义），且只取 turn 里的**第一条**
 * 人类消息。
 */
export function foldTurns(events: readonly SessionEvent[]): TurnSummary[] {
  const turns: TurnSummary[] = []
  let current:
    | {
        number: number
        startSeq: number
        startTime: number
        prompt: string
        steps: number
        toolCalls: number
        inputTokens: number
        outputTokens: number
      }
    | undefined
  let endSeq: number | undefined
  let endTime: number | undefined
  let reason: string | undefined

  const close = () => {
    if (current === undefined) return
    turns.push({
      ...current,
      endSeq,
      endTime,
      reason,
      durationMs: Math.max(0, (endTime ?? current.startTime) - current.startTime),
    })
    current = undefined
    endSeq = undefined
    endTime = undefined
    reason = undefined
  }

  for (const event of events) {
    const time = event.time ?? 0
    switch (event.type) {
      case 'turn/start': {
        close()
        const data = (event as { data: EventData<Extract<SessionEvent, { type: 'turn/start' }>> }).data
        current = {
          number: data.turn,
          startSeq: event.seq,
          startTime: time,
          prompt: '',
          steps: 0,
          toolCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
        }
        break
      }
      case 'user/message': {
        if (current !== undefined && current.prompt === '') {
          const data = (event as unknown as { data: Record<string, unknown> }).data
          if (isHumanMessage(data)) current.prompt = textOf(messageOf(data)?.content)
        }
        break
      }
      case 'step/start':
        if (current !== undefined) current.steps += 1
        break
      case 'tool/call':
        if (current !== undefined) current.toolCalls += 1
        break
      case 'assistant/message': {
        const data = (event as { data: { usage?: { inputTokens?: number; outputTokens?: number } } }).data
        if (current !== undefined && data.usage !== undefined) {
          current.inputTokens += data.usage.inputTokens ?? 0
          current.outputTokens += data.usage.outputTokens ?? 0
        }
        break
      }
      case 'turn/end': {
        const data = (event as { data: { turn: number; reason: unknown } }).data
        endSeq = event.seq
        endTime = time
        reason = reasonOf(data.reason)
        close()
        break
      }
      default:
        break
    }
  }
  close()
  return turns
}

/**
 * 抽取对话视图。
 *
 * 与 dsh-lab 的 traj.ts 的差别：dsh-lab 面向终端打印，这里面向 JSON 传输，
 * 因此保留完整正文（不截断），并把工具调用与工具结果合成一条可读的记录。
 */
export function foldTranscript(events: readonly SessionEvent[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  /** 记住最近的工具调用名字与参数，用来给 tool/result 补上上下文。 */
  const pendingToolCalls = new Map<string, { name: string; arguments: string }>()

  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>
    switch (event.type) {
      case 'user/message': {
        if (!isHumanMessage(data)) break
        const text = textOf(messageOf(data)?.content)
        if (text.trim() === '') break
        entries.push({ kind: 'user', seq: event.seq, time: event.time ?? 0, text })
        break
      }
      case 'assistant/message': {
        const message = messageOf(data)
        const text = describeAssistantContent(message?.content)
        if (text.trim() === '') break
        entries.push({ kind: 'assistant', seq: event.seq, time: event.time ?? 0, text })
        break
      }
      case 'tool/call': {
        const name = String(data.name ?? '')
        const args = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {})
        const callId = String(data.id ?? data.callId ?? entries.length)
        pendingToolCalls.set(callId, { name, arguments: args })
        entries.push({
          kind: 'tool',
          seq: event.seq,
          time: event.time ?? 0,
          text: '',
          toolName: name,
          arguments: args,
        })
        break
      }
      case 'tool/result': {
        const message = messageOf(data)
        const isError = message?.isError === true
        const text = textOf(message?.content)
        entries.push({
          kind: 'tool',
          seq: event.seq,
          time: event.time ?? 0,
          text,
          toolName: 'result',
          isError,
        })
        break
      }
      default:
        break
    }
  }
  return entries
}

/**
 * 读取一个会话的完整轨迹视图。
 *
 * @param ctx - 已启动的服务树。
 * @param sessionId - 目标会话 id。
 */
export async function readTrajectory(ctx: Context, sessionId: string): Promise<TrajectoryView | undefined> {
  const id = SessionId(sessionId)
  let snapshot
  try {
    snapshot = await ctx.sessionQuery.readSession(id)
  } catch {
    return undefined
  }

  const events = snapshot.events
  const header = snapshot.session
  const turns = foldTurns(events)
  const title = await ctx.sessionQuery.readTitle(id).catch(() => undefined)

  const inputTokens = turns.reduce((sum, turn) => sum + turn.inputTokens, 0)
  const outputTokens = turns.reduce((sum, turn) => sum + turn.outputTokens, 0)
  const toolCalls = turns.reduce((sum, turn) => sum + turn.toolCalls, 0)
  const span = Math.max(0, (events[events.length - 1]?.time ?? 0) - (events[0]?.time ?? 0))

  return {
    sessionId: String(header.id),
    title: title?.title,
    cwd: header.cwd ?? undefined,
    eventCount: events.length,
    turns,
    events: events.map(describeEvent),
    totals: { inputTokens, outputTokens, toolCalls, durationMs: span },
  }
}

/** 把一条事件渲染成一行摘要。 */
function describeEvent(event: SessionEvent): TrajectoryEvent {
  const data = (event.data ?? {}) as Record<string, unknown>
  const type = String(event.type)

  // `permission/preset` / `sandbox/mode` / `approval/policy` 等事件来自
  // permission-presets、sandbox-policy 这些扩展包，不在核心 SessionEvent 联合里，
  // 所以先按字符串比一次，再进穷尽 switch —— 否则 TS 会把它们当成不可达分支。
  if (type === 'permission/preset') return ev(event, `权限预设 ${String(data.preset ?? '')}`, 'muted')
  if (type === 'sandbox/mode') return ev(event, `沙箱模式 ${String(data.mode ?? '')}`, 'muted')
  if (type === 'approval/policy') return ev(event, `审批策略 ${String(data.policy ?? '')}`, 'muted')
  if (type === 'session/end-seed') return ev(event, 'session 播种结束', 'muted')

  switch (event.type) {
    case 'turn/start':
      return ev(event, `turn ${String(data.turn)} 开始`, 'accent')
    case 'turn/end':
      return ev(event, `turn ${String(data.turn)} 结束 (${reasonOf(data.reason)})`, 'accent')
    case 'step/start':
      return ev(event, `step ${String(data.step)} 开始`, 'info')
    case 'step/end':
      return ev(event, `step ${String(data.step)} 结束`, 'info')
    case 'user/message': {
      const text = textOf(messageOf(data)?.content)
      if (!isHumanMessage(data)) return ev(event, `context  ${oneLine(text, 70)}`, 'muted')
      return ev(event, `user     ${oneLine(text, 90)}`, 'info')
    }
    case 'assistant/message':
      return ev(event, `assistant ${oneLine(describeAssistantContent(messageOf(data)?.content), 90)}`, 'info')
    case 'tool/call':
      return ev(event, `tool      ${String(data.name)} ${oneLine(String(data.arguments ?? ''), 70)}`, 'info')
    case 'tool/result': {
      const message = messageOf(data)
      const failed = message?.isError === true
      return ev(event, `result${failed ? '✗' : ' '}   ${oneLine(textOf(message?.content), 80)}`, failed ? 'accent' : 'muted')
    }
    case 'approval/asked':
      return ev(event, `approval  询问 ${String(data.toolName ?? '')}`, 'accent')
    case 'approval/decided':
      return ev(event, `approval  结果 ${String(data.outcome ?? '')}`, 'muted')
    case 'command/run':
      return ev(event, `command   /${String(data.name ?? '')}`, 'info')
    case 'command/done':
      return ev(event, `command   完成 ${String(data.kind ?? '')}`, 'muted')
    default:
      return ev(event, type, 'muted')
  }
}

/** 构造一条轨迹事件。 */
function ev(event: SessionEvent, detail: string, level: TrajectoryEvent['level']): TrajectoryEvent {
  return { seq: event.seq, time: event.time ?? 0, type: String(event.type), detail, level }
}

/**
 * 取 content（block 数组或字符串）里的纯文本。
 */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: { type?: string; text?: string }) => (block?.type === 'text' ? (block.text ?? '') : ''))
    .filter(Boolean)
    .join(' ')
}

/**
 * 把一条 assistant 的内容渲染成可读摘要。
 *
 * 只取 text 会漏掉"这一步其实是在调工具"——纯 tool-call 的 assistant 消息
 * 会渲染成空行，看上去像是模型什么都没说。这里把 tool-call 也标出来。
 */
export function describeAssistantContent(content: unknown): string {
  const text = textOf(content)
  if (!Array.isArray(content)) return text
  const calls = content
    .filter((block: { type?: string }) => block?.type === 'tool-call')
    .map((block: { name?: string }) => block.name ?? '?')
  if (calls.length === 0) return text
  const callText = `→ ${calls.join(', ')}`
  return text === '' ? callText : `${text} ${callText}`
}

/**
 * 从一条事件的 `data` 里取消息体。
 *
 * 0.2.1 的两种形状必须都认，否则渲染出来是空行：
 *   * `user/message` / `assistant/message` 事件（消息被直接记录）—— 负载在 `data` 本身；
 *   * `tool/result` 事件 —— 负载在 `data.message` 里，因为它记录的是"一条 tool 消息"。
 */
function messageOf(data: Record<string, unknown>): { content?: unknown; isError?: boolean } | undefined {
  const direct = data as { content?: unknown; role?: string; isError?: boolean }
  if (direct.role !== undefined && direct.content !== undefined) return direct
  const wrapped = data.message as { content?: unknown; isError?: boolean } | undefined
  return wrapped
}

/** 只保留人真正说的话，过滤掉运行时注入的上下文块。 */
function isHumanMessage(data: Record<string, unknown>): boolean {
  const source = data.source as { kind?: string } | undefined
  // source 缺席时按人类消息处理：不是每个写入方都会标 source。
  return source?.kind === undefined || source.kind === 'user'
}

/** `turn/end` 的 reason 是结构化对象（`{kind:'completed'}`），不是字符串。 */
function reasonOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && 'kind' in value) {
    return String((value as { kind: unknown }).kind)
  }
  return String(value)
}

/** 截断到一行。 */
function oneLine(text: string, limit = 100): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : flat.slice(0, limit - 1) + '…'
}
