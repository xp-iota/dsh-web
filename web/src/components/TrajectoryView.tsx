/**
 * TrajectoryView.tsx —— 轨迹视图。
 *
 * 两部分：
 *   1. **turn 大纲**——一行一个 turn：编号、起止时间、耗时、步数、工具调用数、
 *      token 用量、提示词摘要。这是"这次会话发生了什么"的总览。
 *   2. **事件时间线**——逐事件明细，用于排查某一步到底发生了什么。
 *
 * @module dsh-web-ui/components/TrajectoryView
 */
import type { TrajectoryView as Trajectory } from '../api.ts'

/** 轨迹视图。 */
export function TrajectoryView(props: { trajectory: Trajectory }): React.JSX.Element {
  const view = props.trajectory

  if (view.turns.length === 0 && view.events.length === 0) {
    return (
      <div className="empty">
        <p>还没有轨迹数据。</p>
      </div>
    )
  }

  return (
    <div className="trajectory">
      <section className="traj-section">
        <h2 className="traj-title">总览</h2>
        <div className="stat-row">
          <Stat label="事件" value={String(view.eventCount)} />
          <Stat label="turn" value={String(view.turns.length)} />
          <Stat label="工具调用" value={String(view.totals.toolCalls)} />
          <Stat label="token in" value={view.totals.inputTokens.toLocaleString()} />
          <Stat label="token out" value={view.totals.outputTokens.toLocaleString()} />
          <Stat label="耗时" value={formatDuration(view.totals.durationMs)} />
        </div>
      </section>

      {view.turns.length > 0 && (
        <section className="traj-section">
          <h2 className="traj-title">turn 大纲</h2>
          <table className="traj-table">
            <thead>
              <tr>
                <th>#</th>
                <th>时间</th>
                <th>耗时</th>
                <th>步</th>
                <th>工具</th>
                <th>token</th>
                <th>结果</th>
                <th>提示词</th>
              </tr>
            </thead>
            <tbody>
              {view.turns.map((turn) => (
                <tr key={turn.number}>
                  <td>{turn.number}</td>
                  <td className="mono">{formatClock(turn.startTime)}</td>
                  <td className="mono">{formatDuration(turn.durationMs)}</td>
                  <td className="mono">{turn.steps}</td>
                  <td className="mono">{turn.toolCalls}</td>
                  <td className="mono">
                    {turn.inputTokens}/{turn.outputTokens}
                  </td>
                  <td>
                    <span className={turn.reason === 'completed' ? 'pill ok' : 'pill bad'}>
                      {turn.reason ?? '进行中'}
                    </span>
                  </td>
                  <td className="prompt-cell">{turn.prompt || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {view.events.length > 0 && (
        <section className="traj-section">
          <h2 className="traj-title">事件明细</h2>
          <ol className="event-list">
            {view.events.map((event) => (
              <li key={event.seq} className={`event ${event.level}`}>
                <span className="event-seq mono">{event.seq}</span>
                <span className="event-time mono">{formatClock(event.time)}</span>
                <span className="event-detail">{event.detail}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  )
}

/** 一个统计块。 */
function Stat(props: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="stat">
      <span className="stat-value">{props.value}</span>
      <span className="stat-label">{props.label}</span>
    </div>
  )
}

/** 毫秒 → 人类可读的短时长。 */
function formatDuration(ms: number): string {
  if (ms <= 0) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m${seconds}s`
}

/** 时间戳 → HH:MM:SS。 */
function formatClock(time: number): string {
  if (time <= 0) return '--:--:--'
  const date = new Date(time)
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
}
