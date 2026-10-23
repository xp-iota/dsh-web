/**
 * boot.test.ts —— 装配树的冒烟测试。
 *
 * 断言的不是"能启动"，而是"关键服务都在，且工具有没有被真的注册"。
 * 能启动但少服务是最难查的一类问题：进程正常、命令也能跑，只是某个能力静默消失了。
 *
 * @module dsh-web/boot.test
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { bootWeb, type Web } from './boot.ts'

/** 本工程依赖的服务；少一个就说明装配清单出了问题。 */
const REQUIRED_SERVICES = [
  'llm',
  'sessions',
  'sessionQuery',
  'sessionProjections',
  'tools',
  'agents',
  'agentLoop',
  'systemPrompt',
  'tokenMeter',
  'approval',
  'userQuestions',
  'commands',
  'storage',
  'storageDomain',
  'invariants',
] as const

/** 只读模式下必须存在的工具。 */
const REQUIRED_TOOLS = ['web_search', 'web_fetch', 'todo_write', 'ask_user_question'] as const

/** 只读模式下**绝对不能**出现的工具。 */
const FORBIDDEN_TOOLS = ['read', 'write', 'edit', 'bash', 'pwsh', 'subagent', 'skill', 'workflow'] as const

let web: Web

before(async () => {
  web = await bootWeb()
})

after(async () => {
  await web?.dispose()
})

test('装配树提供了全部关键服务', () => {
  const missing = REQUIRED_SERVICES.filter((name) => web.ctx.get(name as never) === undefined)
  assert.deepEqual(missing, [], `缺少服务：${missing.join(', ')}`)
})

test('只读模式的工具集正确', () => {
  const names = web.ctx.tools.schemas().map((schema) => schema.name)
  for (const expected of REQUIRED_TOOLS) {
    assert.ok(names.includes(expected), `缺少工具 ${expected}（现有：${names.join(', ')}）`)
  }
  // 只读模式的核心承诺：模型碰不到文件与 shell。
  for (const forbidden of FORBIDDEN_TOOLS) {
    assert.ok(!names.includes(forbidden), `只读模式不应注册工具 ${forbidden}`)
  }
})

test('anthropic-compat 与 deepseek 两条路由已注册', () => {
  const providers = web.ctx.llm.listProviders().map((info: { id?: string }) => info.id)
  assert.ok(providers.includes('anthropic-compat'), `路由列表：${providers.join(', ')}`)
  assert.ok(providers.includes('deepseek-official'), `路由列表：${providers.join(', ')}`)
})

test('默认模型选择可读', () => {
  // 这个断言防的是「agent 创建时不带 provider/model，第一次调模型就报
  // has no provider/model」。默认选择服务只回答问题，不会自动注入 agent。
  const service = web.ctx.get('agentDefaultModel' as never) as
    | { currentSelection?: () => { provider?: string; model?: string } }
    | undefined
  assert.ok(service !== undefined, '缺少 agentDefaultModel 服务')
  const selection = service!.currentSelection!()
  assert.ok((selection.provider ?? '').length > 0, '默认 provider 为空')
  assert.ok((selection.model ?? '').length > 0, '默认 model 为空')
})

test('持久化 home 落在工程内', () => {
  assert.ok(
    web.home.includes('.dsh-home') || process.env.DSH_WEB_HOME !== undefined,
    `home 应当在工程内，实际 ${web.home}`,
  )
})
