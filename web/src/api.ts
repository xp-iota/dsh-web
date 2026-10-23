/**
 * api.ts —— 与 dsh-web 服务端交互的类型与客户端。
 *
 * 类型与服务端的 `src/server/trajectory.ts`、`src/server/sessions.ts` 一一对应。
 * 服务端没有独立的类型包（那需要额外的构建步骤），所以这里是手写的镜像——
 * 改动服务端类型时两边都要改，这是这个取舍的已知代价。
 */

/** 一条推给浏览器的 SSE 事件。 */
export interface WireEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
}

/** 对话视图的一条消息。 */
export interface TranscriptEntry {
  kind: 'user' | 'assistant' | 'tool'
  seq: number
  time: number
  text: string
  toolName?: string
  isError?: boolean
  arguments?: string
}

/** turn 大纲的一行。 */
export interface TurnSummary {
  number: number
  startSeq: number
  endSeq: number | undefined
  startTime: number
  endTime: number | undefined
  durationMs: number
  reason: string | undefined
  prompt: string
  steps: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
}

/** 轨迹视图的一条事件明细。 */
export interface TrajectoryEvent {
  seq: number
  time: number
  type: string
  detail: string
  level: 'info' | 'muted' | 'accent'
}

/** 轨迹视图。 */
export interface TrajectoryView {
  sessionId: string
  title: string | undefined
  cwd: string | undefined
  eventCount: number
  turns: TurnSummary[]
  events: TrajectoryEvent[]
  totals: {
    inputTokens: number
    outputTokens: number
    toolCalls: number
    durationMs: number
  }
}

/** 会话详情。 */
export interface SessionDetail {
  sessionId: string
  title: string
  cwd: string | null
  transcript: TranscriptEntry[]
  trajectory: TrajectoryView
}

/** 会话列表的一行。 */
export interface SessionSummary {
  sessionId: string
  title: string
  cwd: string | null
  live: boolean
  persisted: boolean
}

/** 健康检查。 */
export interface HealthInfo {
  ok: boolean
  runtime: { name: string; version: string }
  tools: number
  providers: string[]
  version: string
}

/** 请求一个 JSON 接口，失败时抛出带服务端消息的错误。 */
async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init?.headers,
    },
  })
  const text = await response.text()
  let payload: unknown
  try {
    payload = text === '' ? undefined : JSON.parse(text)
  } catch {
    throw new Error(`响应不是合法 JSON（HTTP ${response.status}）`)
  }
  if (!response.ok) {
    const message =
      payload !== null && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `HTTP ${response.status}`
    throw new Error(message)
  }
  return payload as T
}

/** 拉取健康信息。 */
export function fetchHealth(): Promise<HealthInfo> {
  return requestJson<HealthInfo>('/api/health')
}

/** 拉取会话列表。 */
export async function fetchSessions(): Promise<SessionSummary[]> {
  const payload = await requestJson<{ sessions: SessionSummary[] }>('/api/sessions')
  return payload.sessions
}

/** 新建会话。 */
export async function createSession(options: { provider?: string; model?: string } = {}): Promise<string> {
  const payload = await requestJson<{ sessionId: string }>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify(options),
  })
  return payload.sessionId
}

/** 拉取会话详情。 */
export function fetchSession(sessionId: string): Promise<SessionDetail> {
  return requestJson<SessionDetail>(`/api/sessions/${encodeURIComponent(sessionId)}`)
}

/** 发送一条用户消息。 */
export async function sendMessage(sessionId: string, text: string): Promise<void> {
  await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
}

/** 应答一次审批。 */
export async function answerApproval(
  sessionId: string,
  requestId: string,
  outcome: 'allowed-once' | 'rejected',
): Promise<void> {
  await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(requestId)}`, {
    method: 'POST',
    body: JSON.stringify({ outcome }),
  })
}

/** 应答一次提问。 */
export async function answerQuestions(
  sessionId: string,
  requestId: string,
  answers: { id: string; selected: string[]; custom?: string }[],
): Promise<void> {
  await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(requestId)}`, {
    method: 'POST',
    body: JSON.stringify({ answers }),
  })
}

/**
 * 订阅会话事件流。
 *
 * 用 `EventSource` 而不是手写 fetch 流：SSE 自带断线重连，而模型思考可能持续
 * 很久，中间被代理掐一次连接是常事。`EventSource` 会自动重连，我们只需要在
 * `onerror` 里更新 UI 状态。
 *
 * @returns 取消订阅的函数。
 */
export function subscribeEvents(sessionId: string, onEvent: (event: WireEvent) => void): () => void {
  const source = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/stream`)
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as WireEvent)
    } catch {
      // 坏帧不该打断整个流。
    }
  }
  return () => source.close()
}
