/**
 * SessionList.tsx —— 左侧会话列表。
 *
 * @module dsh-web-ui/components/SessionList
 */
import type { SessionSummary } from '../api.ts'

/** 会话列表。 */
export function SessionList(props: {
  sessions: SessionSummary[]
  currentId: string | undefined
  onSelect: (sessionId: string) => void
}): React.JSX.Element {
  if (props.sessions.length === 0) {
    return <div className="session-list empty-list">还没有会话。</div>
  }

  return (
    <ul className="session-list">
      {props.sessions.map((session) => {
        const active = session.sessionId === props.currentId
        return (
          <li key={session.sessionId}>
            <button
              type="button"
              className={active ? 'session active' : 'session'}
              onClick={() => props.onSelect(session.sessionId)}
            >
              <span className="session-title">{session.title || '未命名会话'}</span>
              <span className="session-meta">
                {session.live && <span className="dot live" aria-label="在线" />}
                <span className="mono">{session.sessionId.slice(0, 8)}</span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
