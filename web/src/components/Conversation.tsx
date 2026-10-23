/**
 * Conversation.tsx —— 对话视图。
 *
 * 渲染三类条目：
 *   - 用户消息（右侧气泡）；
 *   - 模型消息（左侧气泡，Markdown 渲染）；
 *   - 工具记录（左侧卡片，可折叠，默认折叠）。
 *
 * 工具卡片默认折叠是有意的：工具输出经常很长，而用户关心的是「模型得出了什么
 * 结论」。折叠让对话流保持可读，需要细节时再展开。
 *
 * @module dsh-web-ui/components/Conversation
 */
import { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { TranscriptEntry } from '../api.ts'

/** 对话视图。 */
export function Conversation(props: {
  transcript: TranscriptEntry[]
  streaming: boolean
}): React.JSX.Element {
  const bottomRef = useRef<HTMLDivElement | null>(null)

  // 流式输出时自动滚到底。依赖 transcript 的长度与最后一条的文本长度——
  // 只依赖长度会导致流式过程中不滚动（每帧长度可能不变）。
  const last = props.transcript[props.transcript.length - 1]
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [props.transcript.length, last?.text])

  if (props.transcript.length === 0) {
    return (
      <div className="empty">
        <p>这个会话还没有消息。</p>
      </div>
    )
  }

  return (
    <div className="conversation">
      {props.transcript.map((entry, index) => {
        if (entry.kind === 'user') {
          return (
            <div key={`u-${index}`} className="msg user">
              <div className="bubble">{renderMarkdown(entry.text)}</div>
            </div>
          )
        }
        if (entry.kind === 'assistant') {
          const isStreaming = entry.seq === -1
          return (
            <div key={`a-${index}`} className="msg assistant">
              <div className="bubble">
                {renderMarkdown(entry.text)}
                {isStreaming && <span className="caret" aria-label="生成中" />}
              </div>
            </div>
          )
        }
        return <ToolCard key={`t-${index}`} entry={entry} />
      })}
      <div ref={bottomRef} />
    </div>
  )
}

/** 工具调用卡片。 */
function ToolCard(props: { entry: TranscriptEntry }): React.JSX.Element {
  const entry = props.entry
  const isCall = entry.toolName !== 'result'
  const failed = entry.isError === true
  const label = isCall ? entry.toolName ?? 'tool' : failed ? '调用失败' : '调用结果'

  return (
    <div className={failed ? 'tool-card failed' : 'tool-card'}>
      <details>
        <summary>
          <span className="tool-badge">{failed ? '✗' : isCall ? '⚙' : '✓'}</span>
          <span className="tool-name">{label}</span>
          {!isCall && entry.text.trim() !== '' && (
            <span className="tool-preview">{entry.text.slice(0, 80)}</span>
          )}
        </summary>
        {isCall && entry.arguments !== undefined && entry.arguments !== '' && (
          <pre className="tool-args">{formatArguments(entry.arguments)}</pre>
        )}
        {!isCall && entry.text.trim() !== '' && <pre className="tool-result">{entry.text}</pre>}
      </details>
    </div>
  )
}

/** 把 JSON 参数格式化得可读一点；不是 JSON 就原样返回。 */
function formatArguments(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/** 渲染 Markdown。 */
function renderMarkdown(text: string): React.JSX.Element {
  if (text.trim() === '') return <span className="muted">（空）</span>
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: (props) => <a {...props} target="_blank" rel="noreferrer noopener" />,
        code: (props) => {
          const children = String(props.children ?? '')
          const isBlock = children.includes('\n')
          return isBlock ? (
            <code className="code-block" {...props} />
          ) : (
            <code className="code-inline" {...props} />
          )
        },
      }}
    >
      {text}
    </ReactMarkdown>
  )
}
