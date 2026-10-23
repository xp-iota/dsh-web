/**
 * App.tsx —— 主界面：左侧会话列表 + 右侧对话/轨迹双标签。
 *
 * 布局参考产品截图：顶部是「对话 / 轨迹」两个标签，底部是输入框；对话区渲染
 * Markdown 与工具调用卡片；轨迹区是 turn 大纲 + 事件时间线。
 *
 * 状态管理刻意保持简单：所有服务端状态放在一个 `useState` 的会话对象里，SSE
 * 事件到达时做**增量更新**（追加文本、插入消息），而不是重新拉整份快照——
 * 后者会让流式输出变成"每次都闪一下"。
 *
 * @module dsh-web-ui/App
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  answerApproval,
  answerQuestions,
  createSession,
  fetchHealth,
  fetchSession,
  fetchSessions,
  sendMessage,
  subscribeEvents,
  type HealthInfo,
  type SessionDetail,
  type SessionSummary,
  type WireEvent,
} from './api.ts'
import { Conversation } from './components/Conversation.tsx'
import { TrajectoryView } from './components/TrajectoryView.tsx'
import { Composer } from './components/Composer.tsx'
import { SessionList } from './components/SessionList.tsx'
import { ApprovalPrompt, QuestionPrompt } from './components/Prompts.tsx'

/** 主界面。 */
export function App(): React.JSX.Element {
  const [health, setHealth] = useState<HealthInfo | undefined>()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [currentId, setCurrentId] = useState<string | undefined>()
  const [detail, setDetail] = useState<SessionDetail | undefined>()
  const [tab, setTab] = useState<'chat' | 'trajectory'>('chat')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | undefined>()
  /** 待应答的审批。 */
  const [approval, setApproval] = useState<{ requestId: string; toolName: string; reason: string } | undefined>()
  /** 待应答的提问。 */
  const [question, setQuestion] = useState<
    { requestId: string; questions: { id: string; question: string; header?: string; detail?: string; options?: { label: string }[] }[] } | undefined
  >()

  /** 当前会话 id，供 SSE 回调读取——这样 handleEvent 的身份保持稳定。 */
  const currentIdRef = useRef<string | undefined>(undefined)
  currentIdRef.current = currentId

  /** 刷新会话列表。 */
  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await fetchSessions())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  // 初始加载：健康信息 + 会话列表。
  useEffect(() => {
    void fetchHealth().then(setHealth).catch(() => undefined)
    void refreshSessions()
  }, [refreshSessions])

  /** 打开一个会话。 */
  const openSession = useCallback(async (sessionId: string) => {
    setCurrentId(sessionId)
    setError(undefined)
    try {
      setDetail(await fetchSession(sessionId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  /** 新建会话。 */
  const newSession = useCallback(async () => {
    try {
      const sessionId = await createSession()
      await refreshSessions()
      await openSession(sessionId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [openSession, refreshSessions])

  /**
   * 处理一条 SSE 事件。
   *
   * 增量更新策略：
   *   - `assistant/delta` 追加到当前流式文本；
   *   - `assistant/block-end` 把这段文本固化成一条 assistant 消息；
   *   - `tool/call` / `tool/result` 各插一条工具记录；
   *   - `turn/end` 收尾并标记不再流式。
   *
   * 依赖数组里**不含 currentId**：改用 `currentIdRef` 读当前会话。这样
   * `handleEvent` 的身份保持稳定，SSE 订阅不会因为切会话而反复重连。
   */
  const handleEvent = useCallback((event: WireEvent) => {
    const data = event.data ?? {}
    switch (event.type) {
      case 'assistant/delta': {
        const text = String(data.text ?? '')
        if (text === '') break
        setDetail((previous) => {
          if (previous === undefined) return previous
          const messages = [...previous.transcript]
          const last = messages[messages.length - 1]
          // 最后一条若是正在累积的 assistant 消息（seq 为负 = 尚未固化），就往上追加。
          if (last !== undefined && last.kind === 'assistant' && last.seq < 0) {
            messages[messages.length - 1] = { ...last, text: last.text + text }
          } else {
            messages.push({ kind: 'assistant', seq: -1, time: event.time, text })
          }
          return { ...previous, transcript: messages }
        })
        setStreaming(true)
        break
      }
      case 'assistant/block-end': {
        const blockType = String(data.blockType ?? 'text')
        if (blockType !== 'text') break
        setDetail((previous) => {
          if (previous === undefined) return previous
          const messages = [...previous.transcript]
          const last = messages[messages.length - 1]
          // 固化：把 seq 从负数换成真实序号。但**保持它为负数**——模型可能在
          // 同一个 turn 里输出多个 text block，后续 delta 还要接着往上追加。
          // 若这里把 seq 改成正数，下一段 delta 会被误判成"新消息"，
          // 结果是一条回答被切成好几条。
          if (last !== undefined && last.kind === 'assistant' && last.seq < 0) {
            messages[messages.length - 1] = { ...last, seq: -1 }
          }
          return { ...previous, transcript: messages }
        })
        break
      }
      case 'tool/call': {
        setDetail((previous) => {
          if (previous === undefined) return previous
          return {
            ...previous,
            transcript: [
              ...previous.transcript,
              {
                kind: 'tool',
                seq: event.seq,
                time: event.time,
                text: '',
                toolName: String(data.name ?? 'tool'),
                arguments: typeof data.arguments === 'string' ? data.arguments : undefined,
              },
            ],
          }
        })
        break
      }
      case 'tool/result': {
        setDetail((previous) => {
          if (previous === undefined) return previous
          return {
            ...previous,
            transcript: [
              ...previous.transcript,
              {
                kind: 'tool',
                seq: event.seq,
                time: event.time,
                text: String(data.content ?? ''),
                toolName: 'result',
                isError: data.isError === true,
              },
            ],
          }
        })
        break
      }
      case 'turn/end':
        setStreaming(false)
        // 用服务端的落盘快照校准 transcript。
        //
        // 为什么需要：流式期间前端是**增量拼接**的，而服务端的会话日志是权威
        // 事实。两者在正常情况下应当一致，但一旦有事件漏掉（比如连接中途重连），
        // 界面就会少内容。turn 结束时重新拉一次快照，用权威数据覆盖增量结果，
        // 代价是一次本地读取，换来"界面与日志永远一致"。
        void refreshSessions()
        const sessionId = currentIdRef.current
        if (sessionId !== undefined) {
          void fetchSession(sessionId).then(setDetail).catch(() => undefined)
        }
        break
      case 'approval/request':
        setApproval({
          requestId: String(data.requestId ?? ''),
          toolName: String(data.toolName ?? ''),
          reason: String(data.reason ?? ''),
        })
        break
      case 'questions/request':
        setQuestion({
          requestId: String(data.requestId ?? ''),
          questions: (data.questions ?? []) as never,
        })
        break
      case 'agent/error':
        setError(String(data.message ?? '未知错误'))
        setStreaming(false)
        break
      default:
        break
    }
  }, [refreshSessions])

  // 订阅当前会话的事件流。
  useEffect(() => {
    if (currentId === undefined) return undefined
    return subscribeEvents(currentId, handleEvent)
  }, [currentId, handleEvent])

  /** 发送一条消息。 */
  const handleSend = useCallback(
    async (text: string) => {
      if (currentId === undefined) return
      setError(undefined)
      // 先本地插入用户消息，让输入框立刻清空、内容立刻可见。
      setDetail((previous) =>
        previous === undefined
          ? previous
          : {
              ...previous,
              transcript: [
                ...previous.transcript,
                { kind: 'user', seq: -2, time: Date.now(), text },
              ],
            },
      )
      try {
        await sendMessage(currentId, text)
        setStreaming(true)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [currentId],
  )

  /** 应答审批。 */
  const handleApproval = useCallback(
    async (outcome: 'allowed-once' | 'rejected') => {
      if (currentId === undefined || approval === undefined) return
      const requestId = approval.requestId
      setApproval(undefined)
      try {
        await answerApproval(currentId, requestId, outcome)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [approval, currentId],
  )

  /** 应答提问。 */
  const handleQuestion = useCallback(
    async (answers: { id: string; selected: string[]; custom?: string }[]) => {
      if (currentId === undefined || question === undefined) return
      const requestId = question.requestId
      setQuestion(undefined)
      try {
        await answerQuestions(currentId, requestId, answers)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [currentId, question],
  )

  /** 切换到轨迹页时刷新一次（此时 turn 大纲与用量才是最新的）。 */
  const handleTabChange = useCallback(
    (next: 'chat' | 'trajectory') => {
      setTab(next)
      if (next === 'trajectory' && currentId !== undefined) {
        void fetchSession(currentId).then(setDetail).catch(() => undefined)
      }
    },
    [currentId],
  )

  const totals = useMemo(() => detail?.trajectory.totals, [detail])

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true" />
            <span className="brand-name">dsh-web</span>
          </div>
          <button type="button" className="btn-primary" onClick={() => void newSession()}>
            新会话
          </button>
        </div>
        <SessionList sessions={sessions} currentId={currentId} onSelect={(id) => void openSession(id)} />
        <div className="sidebar-foot">
          {health !== undefined ? (
            <>
              <span className="dot" aria-hidden="true" />
              <span>
                {health.runtime.name} {health.runtime.version}
              </span>
              <span className="muted">· {health.tools} 工具 · 只读</span>
            </>
          ) : (
            <span className="muted">连接中…</span>
          )}
        </div>
      </aside>

      <main className="main">
        <header className="main-head">
          <nav className="tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'chat'}
              className={tab === 'chat' ? 'tab active' : 'tab'}
              onClick={() => handleTabChange('chat')}
            >
              对话
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'trajectory'}
              className={tab === 'trajectory' ? 'tab active' : 'tab'}
              onClick={() => handleTabChange('trajectory')}
            >
              轨迹
            </button>
          </nav>
          {detail !== undefined && (
            <div className="head-meta">
              {totals !== undefined && (
                <span className="muted">
                  {totals.inputTokens.toLocaleString()} in / {totals.outputTokens.toLocaleString()} out
                </span>
              )}
              {streaming && <span className="pill live">生成中</span>}
            </div>
          )}
        </header>

        {error !== undefined && (
          <div className="banner error" role="alert">
            {error}
            <button type="button" className="btn-ghost" onClick={() => setError(undefined)}>
              关闭
            </button>
          </div>
        )}

        <div className="content">
          {detail === undefined ? (
            <div className="empty">
              <p>从左侧选一个会话，或新建一个开始对话。</p>
            </div>
          ) : tab === 'chat' ? (
            <Conversation transcript={detail.transcript} streaming={streaming} />
          ) : (
            <TrajectoryView trajectory={detail.trajectory} />
          )}
        </div>

        <Composer
          disabled={currentId === undefined || streaming || approval !== undefined || question !== undefined}
          noSession={currentId === undefined}
          onSend={(text) => void handleSend(text)}
        />
      </main>

      {approval !== undefined && (
        <ApprovalPrompt
          toolName={approval.toolName}
          reason={approval.reason}
          onAnswer={(outcome) => void handleApproval(outcome)}
        />
      )}
      {question !== undefined && (
        <QuestionPrompt questions={question.questions} onAnswer={(answers) => void handleQuestion(answers)} />
      )}
    </div>
  )
}
