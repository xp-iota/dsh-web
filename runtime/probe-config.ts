/**
 * probe-config.ts —— 打印实际生效的默认模型选择与路由配置。
 */
import { bootWeb } from '../src/boot.ts'

const web = await bootWeb()
try {
  const service = web.ctx.get('agentDefaultModel' as never) as
    | { currentSelection?: () => { provider?: string; model?: string } }
    | undefined
  console.log('agentDefaultModel 存在：', service !== undefined)
  console.log('currentSelection():', JSON.stringify(service?.currentSelection?.()))

  const providers = web.ctx.llm.listProviders()
  console.log('路由：', JSON.stringify(providers))

  console.log('环境变量快照：')
  for (const key of ['DSH_MODEL', 'LLM_MODEL', 'DSH_MODEL_PROVIDER', 'LLM_VENDOR', 'LLM_BASE_URL']) {
    console.log(`  ${key} = ${JSON.stringify(process.env[key])}`)
  }
} finally {
  await web.dispose()
}
