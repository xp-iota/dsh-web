/**
 * services.ts —— 一次导入所有服务的 Context 类型增强。
 *
 * cordis 的服务声明是 `declare module '@deepseek-ai/cordis' { interface Context { ... } }`
 * 的形式，只有 import 了那个包，TypeScript 才能看到 ctx.xxx。运行时由
 * cordis.patch.yml 提供，编译期由这一个文件集中引入。
 *
 * @module dsh-web/services
 */
import '@deepseek-ai/dsh-llm'
import '@deepseek-ai/dsh-session'
import '@deepseek-ai/dsh-session-query'
import '@deepseek-ai/dsh-session-projection'
import '@deepseek-ai/dsh-tools'
import '@deepseek-ai/dsh-agent'
import '@deepseek-ai/dsh-agent-loop'
import '@deepseek-ai/dsh-system-prompt'
import '@deepseek-ai/dsh-token-meter'
import '@deepseek-ai/dsh-user-approval'
import '@deepseek-ai/dsh-user-questions'
import '@deepseek-ai/dsh-commands'
import '@deepseek-ai/dsh-storage'
import '@deepseek-ai/dsh-storage-domain'
import '@deepseek-ai/dsh-credentials'
import '@deepseek-ai/dsh-invariants'
import '@deepseek-ai/dsh-plan-mode'
import '@deepseek-ai/dsh-message-feedback'
