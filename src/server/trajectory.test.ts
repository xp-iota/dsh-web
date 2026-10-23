/**
 * trajectory.test.ts —— 轨迹折叠的单元测试。
 *
 * 这两个函数（foldTurns / foldTranscript）是纯函数：输入事件序列，输出视图。
 * 它们承载了「哪些事件算人类的话」「工具结果怎么归类」这些判断，是整个轨迹页
 * 的正确性核心，所以值得单独测。
 *
 * @module dsh-web/server/trajectory.test
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldTranscript, foldTurns, textOf } from './trajectory.ts'

/** 构造一条事件的最小骨架。 */
function event(seq: number, type: string, data: Record<string, unknown>, time = seq * 1000): SessionEvent {
  return { seq, type, time, data } as unknown as SessionEvent
}

/** 人类的一条消息。 */
function userMessage(seq: number, text: string): SessionEvent {
  return event(seq, 'user/message', {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/** 运行时注入的上下文块（不是人话）。 */
function contextMessage(seq: number, text: string): SessionEvent {
  return event(seq, 'user/message', {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'runtime-context' },
  })
}

test('foldTurns 把事件折叠成 turn 列表', () => {
  const events: SessionEvent[] = [
    event(0, 'turn/start', { turn: 1 }),
    userMessage(1, '第一个问题'),
    event(2, 'step/start', { step: 1 }),
    event(3, 'tool/call', { name: 'web_fetch', arguments: '{}' }),
    event(4, 'assistant/message', { role: 'assistant', content: [{ type: 'text', text: '回答' }], usage: { inputTokens: 10, outputTokens: 20 } }),
    event(5, 'step/end', { step: 1 }),
    event(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    event(7, 'turn/start', { turn: 2 }),
    userMessage(8, '第二个问题'),
    event(9, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
  ]

  const turns = foldTurns(events)
  assert.equal(turns.length, 2)
  assert.equal(turns[0]!.number, 1)
  assert.equal(turns[0]!.prompt, '第一个问题')
  assert.equal(turns[0]!.steps, 1)
  assert.equal(turns[0]!.toolCalls, 1)
  assert.equal(turns[0]!.inputTokens, 10)
  assert.equal(turns[0]!.outputTokens, 20)
  assert.equal(turns[0]!.reason, 'completed')
  assert.equal(turns[1]!.prompt, '第二个问题')
})

test('foldTurns 只把人类的话当作提示词', () => {
  const events: SessionEvent[] = [
    event(0, 'turn/start', { turn: 1 }),
    contextMessage(1, 'runtime context: 你是一个助手'),
    userMessage(2, '真正的问题'),
    event(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]

  const turns = foldTurns(events)
  assert.equal(turns.length, 1)
  assert.equal(turns[0]!.prompt, '真正的问题', '运行时注入的上下文不该被当成提示词')
})

test('foldTurns 对未结束的 turn 仍然给出条目', () => {
  const events: SessionEvent[] = [
    event(0, 'turn/start', { turn: 1 }),
    userMessage(1, '问题'),
  ]
  const turns = foldTurns(events)
  assert.equal(turns.length, 1)
  assert.equal(turns[0]!.reason, undefined)
})

test('foldTranscript 抽取人类与模型的消息', () => {
  const events: SessionEvent[] = [
    contextMessage(0, 'runtime context'),
    userMessage(1, '你好'),
    event(2, 'assistant/message', { role: 'assistant', content: [{ type: 'text', text: '你好，有什么可以帮你？' }] }),
  ]

  const entries = foldTranscript(events)
  assert.equal(entries.length, 2, '运行时注入的上下文不该出现在对话视图里')
  assert.equal(entries[0]!.kind, 'user')
  assert.equal(entries[0]!.text, '你好')
  assert.equal(entries[1]!.kind, 'assistant')
  assert.equal(entries[1]!.text, '你好，有什么可以帮你？')
})

test('foldTranscript 认出 tool/result 的两种负载形态', () => {
  // 0.2.1 里 tool/result 的消息体在 data.message 里，
  // 而 user/message / assistant/message 的负载直接摊在 data 上。两种都要认。
  const events: SessionEvent[] = [
    event(0, 'tool/call', { name: 'web_fetch', arguments: '{"url":"https://example.com"}' }),
    event(1, 'tool/result', { message: { content: [{ type: 'text', text: '抓取结果' }] } }),
  ]

  const entries = foldTranscript(events)
  assert.equal(entries.length, 2)
  assert.equal(entries[0]!.kind, 'tool')
  assert.equal(entries[0]!.toolName, 'web_fetch')
  assert.equal(entries[0]!.arguments, '{"url":"https://example.com"}')
  assert.equal(entries[1]!.kind, 'tool')
  assert.equal(entries[1]!.text, '抓取结果')
  assert.equal(entries[1]!.isError, false)
})

test('foldTranscript 标记失败的工具结果', () => {
  const events: SessionEvent[] = [
    event(0, 'tool/result', { message: { content: [{ type: 'text', text: '超时' }], isError: true } }),
  ]
  const entries = foldTranscript(events)
  assert.equal(entries[0]!.isError, true)
})

test('textOf 处理字符串与 block 数组', () => {
  assert.equal(textOf('纯文本'), '纯文本')
  assert.equal(
    textOf([
      { type: 'text', text: '第一段' },
      { type: 'image', text: '忽略' },
      { type: 'text', text: '第二段' },
    ]),
    '第一段 第二段',
  )
  assert.equal(textOf(undefined), '')
})
