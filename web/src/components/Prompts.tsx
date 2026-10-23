/**
 * Prompts.tsx —— 审批与提问的交互面板。
 *
 * 这两个都是 dsh 的 waterfall：服务端在等前端的应答，前端不答，agent 就停在那里。
 * 所以它们是**模态**的——挡住其他操作是故意的，不是限制。
 *
 * @module dsh-web-ui/components/Prompts
 */
import { useState } from 'react'

/** 审批面板。 */
export function ApprovalPrompt(props: {
  toolName: string
  reason: string
  onAnswer: (outcome: 'allowed-once' | 'rejected') => void
}): React.JSX.Element {
  return (
    <div className="overlay">
      <div className="dialog">
        <h3 className="dialog-title">需要确认</h3>
        <p className="dialog-line">
          模型请求调用 <code className="code-inline">{props.toolName}</code>
        </p>
        {props.reason !== '' && <p className="dialog-reason">{props.reason}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn-ghost" onClick={() => props.onAnswer('rejected')}>
            拒绝
          </button>
          <button type="button" className="btn-primary" onClick={() => props.onAnswer('allowed-once')}>
            允许这一次
          </button>
        </div>
      </div>
    </div>
  )
}

/** 提问面板。 */
export function QuestionPrompt(props: {
  questions: { id: string; question: string; header?: string; detail?: string; options?: { label: string }[] }[]
  onAnswer: (answers: { id: string; selected: string[]; custom?: string }[]) => void
}): React.JSX.Element {
  // 每个问题的已选项：question id → 选中的 label 列表。
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  // 每个问题的自填答案。
  const [custom, setCustom] = useState<Record<string, string>>({})

  const toggle = (questionId: string, label: string) => {
    setSelected((previous) => {
      const current = previous[questionId] ?? []
      return {
        ...previous,
        [questionId]: current.includes(label)
          ? current.filter((item) => item !== label)
          : [...current, label],
      }
    })
  }

  const submit = () => {
    props.onAnswer(
      props.questions.map((question) => ({
        id: question.id,
        selected: selected[question.id] ?? [],
        ...(custom[question.id] !== undefined && custom[question.id] !== ''
          ? { custom: custom[question.id] }
          : {}),
      })),
    )
  }

  return (
    <div className="overlay">
      <div className="dialog wide">
        <h3 className="dialog-title">模型提问</h3>
        {props.questions.map((question) => (
          <div key={question.id} className="question">
            {question.header !== undefined && <div className="question-header">{question.header}</div>}
            <div className="question-text">{question.question}</div>
            {question.detail !== undefined && <div className="question-detail">{question.detail}</div>}
            {(question.options ?? []).length > 0 && (
              <div className="question-options">
                {(question.options ?? []).map((option) => {
                  const isOn = (selected[question.id] ?? []).includes(option.label)
                  return (
                    <button
                      key={option.label}
                      type="button"
                      className={isOn ? 'option on' : 'option'}
                      onClick={() => toggle(question.id, option.label)}
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            )}
            <input
              className="question-input"
              placeholder="或者自己写一个答案…"
              value={custom[question.id] ?? ''}
              onChange={(event) =>
                setCustom((previous) => ({ ...previous, [question.id]: event.target.value }))
              }
            />
          </div>
        ))}
        <div className="dialog-actions">
          <button type="button" className="btn-primary" onClick={submit}>
            提交
          </button>
        </div>
      </div>
    </div>
  )
}
