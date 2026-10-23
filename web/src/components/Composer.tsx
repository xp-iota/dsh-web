/**
 * Composer.tsx —— 输入框。
 *
 * 行为：
 *   - Enter 发送，Shift+Enter 换行；
 *   - 发送中或有待应答的交互时禁用（避免并发 turn）；
 *   - 输入框随内容自动增高，但有上限（否则长文本会把整个界面顶掉）。
 *
 * @module dsh-web-ui/components/Composer
 */
import { useEffect, useRef, useState } from 'react'

/** 输入框。 */
export function Composer(props: {
  disabled: boolean
  /** 未选中会话——与"生成中"是两种不同的禁用原因，提示文案要分开。 */
  noSession: boolean
  onSend: (text: string) => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // 内容变化时调整高度。上限 200px：再高就该让用户滚页面了。
  useEffect(() => {
    const element = textareaRef.current
    if (element === null) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`
  }, [text])

  const submit = () => {
    const trimmed = text.trim()
    if (trimmed === '' || props.disabled) return
    props.onSend(trimmed)
    setText('')
  }

  const placeholder = props.noSession
    ? '先在左侧选择或新建一个会话'
    : props.disabled
      ? '等待上一轮完成…'
      : '输入消息，Enter 发送，Shift+Enter 换行'

  return (
    <div className="composer">
      <textarea
        ref={textareaRef}
        className="composer-input"
        value={text}
        disabled={props.disabled}
        placeholder={placeholder}
        rows={1}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            submit()
          }
        }}
      />
      <button type="button" className="btn-primary composer-send" disabled={props.disabled || text.trim() === ''} onClick={submit}>
        发送
      </button>
    </div>
  )
}
