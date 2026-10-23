/**
 * anthropic-compat —— Anthropic Messages 兼容网关的 provider 适配器。
 *
 * ## 来源与移植说明
 *
 * 本文件移植自 `dsh-lab/src/llm/anthropic-compat/index.ts`（同仓库，MIT 许可的
 * 内部资产）。移植时**只改了配置来源与错误文案**，协议逻辑一行未动——协议部分
 * 是最容易出错的地方（SSE 分帧、tool_result 折叠、thinking signature 回放），
 * 重新实现等于把已验证过的 bug 再写一遍。
 *
 * 改动清单：
 *   1. 配置从 `dsh-web` 自己的装配清单来，默认值改成本工程用的网关；
 *   2. 缺凭据时的报错文案从 "dsh-lab sessions / traj" 改成 Web 侧的表述。
 *
 * ## 为什么不直接用官方包
 *
 * 官方只发布了 DeepSeek 原生路由（`dsh-llm-deepseek-api-key`）与 pi-ai 多路由
 * 转发（`dsh-llm-pi-ai`），**没有**直接讲 Anthropic Messages + SSE 协议的适配器。
 * 而 MiniMax、Fuyao 这类 Anthropic 兼容网关在企业内很常见。`dsh-llm-pi-ai`
 * 理论上能用 `api: anthropic-messages` 声明式接上，但它要求该网关实现
 * `GET /v1/models` 列表语义，且 thinking signature 的回放规则由 pi-ai 决定——
 * 这两点在本工程的网关上没有验证过。移植已验证的实现是更稳的选择。
 *
 * 想切 DeepSeek 官方路由不需要动这个文件：`cordis.patch.yml` 里同时挂着
 * `llm-deepseek` 行，用 `DSH_MODEL_PROVIDER=deepseek-official` 切过去即可。
 *
 * @module dsh-web/services/anthropic-compat
 */
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmError, ToolCallId, attributionHeaders } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  Message,
  ReplayEnvelope,
  StreamChunk,
  TokenUsage,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

export const name = 'llm-anthropic-compat'
export const inject = ['llm']

/** 配置：路由名 + 端点 + 凭据引用（都能被环境变量覆盖）。 */
export interface Config {
  /** 注册到 llm 服务的路由名。 */
  provider: string
  /** Anthropic 兼容网关的基地址（不含 `/v1/messages`）。 */
  baseURL: string
  /** 凭据引用名，由 credentials 服务或启动环境解析。 */
  apiKeyEnv: string
  /** 该路由的默认模型。 */
  model: string
  /** 备用模型列表，供选择器展示。 */
  models: string[]
  /** 单次请求的输出上限默认值。 */
  maxTokens: number
  /** 请求头携带的 anthropic-version。 */
  anthropicVersion: string
  /** 供应商风格：MiniMax 要求回放 thinking 签名，Fuyao 允许省略无签名 thinking。 */
  vendor: 'minimax' | 'fuyao'
}

export const Config: z<Config> = z.object({
  provider: z.string().default('anthropic-compat'),
  baseURL: z.string().default('https://api.minimaxi.com/anthropic'),
  apiKeyEnv: z.string().default('LLM_API_KEY'),
  model: z.string().default('MiniMax-M3'),
  models: z.array(z.string()).default(['MiniMax-M3']),
  maxTokens: z.natural().default(8192),
  anthropicVersion: z.string().default('2023-06-01'),
  vendor: z.union(['minimax', 'fuyao'] as const).default('minimax'),
})

/** Anthropic stop_reason → dsh finish reason（只映射成功档位）。 */
const FINISH_REASON: Record<string, 'stop' | 'max-tokens' | 'tool-calls'> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'max-tokens',
  tool_use: 'tool-calls',
}

/**
 * 逐行解析 SSE 的 data 字段。
 *
 * EOF 时也消费最后一个没有换行的事件；畸形 JSON 视为协议错误直接抛出——静默丢弃
 * 会把"半个回答"标成成功。
 */
export async function* parseSseData(body: AsyncIterable<Uint8Array>): AsyncGenerator<any> {
  const decoder = new TextDecoder()
  let buffer = ''

  const parseLine = (raw: string): any => {
    const line = raw.trimEnd()
    if (!line.startsWith('data:')) return undefined
    const data = line.slice(5).trim()
    if (!data) return undefined
    if (data === '[DONE]') return { type: '__done' }
    try {
      return JSON.parse(data)
    } catch (error) {
      throw new LlmError('anthropic-compat: SSE data 不是合法 JSON', 'PROTOCOL', { cause: error })
    }
  }

  const drain = function* (final: boolean) {
    let eol: number
    while ((eol = buffer.indexOf('\n')) >= 0) {
      const event = parseLine(buffer.slice(0, eol))
      buffer = buffer.slice(eol + 1)
      if (event !== undefined) yield event
    }
    if (final && buffer.length > 0) {
      const event = parseLine(buffer)
      buffer = ''
      if (event !== undefined) yield event
    }
  }

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    yield* drain(false)
  }
  buffer += decoder.decode()
  yield* drain(true)
}

interface ReplayBlock {
  type: 'text' | 'thinking' | 'tool_use'
  signature?: string
}

interface ActiveText {
  kind: 'text'
  text: string
}

interface ActiveReasoning {
  kind: 'reasoning'
  text: string
  signature: string
}

interface ActiveToolCall {
  kind: 'tool-call'
  id: ReturnType<typeof ToolCallId>
  name: string
  arguments: string
}

type ActiveBlock = ActiveText | ActiveReasoning | ActiveToolCall

function parseToolArguments(raw: string, toolName: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('工具参数必须是 JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    throw new LlmError(`anthropic-compat: 工具 "${toolName}" 的 arguments 不是合法 JSON object`, 'PROTOCOL', {
      cause: error,
    })
  }
}

function replayBlocks(message: Message): readonly ReplayBlock[] {
  if (message.role !== 'assistant') return []
  const replay = message.source.replayState
  if (!replay || typeof replay !== 'object') return []
  const blocks = (replay as { blocks?: unknown }).blocks
  return Array.isArray(blocks) ? (blocks as ReplayBlock[]) : []
}

/** tool 角色消息的 content → Anthropic `tool_result` 的内层 content。 */
function toAnthropicNestedBlock(block: ContentBlock): Record<string, unknown> {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'image':
      throw new LlmError('anthropic-compat: 当前适配器未装配附件读取能力，不能发送 image block', 'UNSUPPORTED')
    default:
      throw new LlmError(`anthropic-compat: tool_result 内不支持 ${JSON.stringify(block.type)} block`, 'UNSUPPORTED')
  }
}

/**
 * 把 dsh 的消息序列切成 Anthropic 的 `system` + `messages`。
 *
 * 三件事必须一起做，否则真实链路会在第一个 step 就 finish 成 error：
 *   1. `GenerateOptions.system`（一次性调用方传入）进顶层 system；
 *   2. `role: 'system'` 消息的 text block 也进顶层 system（Anthropic 只接受顶层 system）；
 *   3. `role: 'tool'` 消息折叠成 **前一条 user 消息**里的 `tool_result` block ——
 *      Anthropic 要求 tool_result 出现在 user 角色里，且要跟对应的 tool_use 相邻。
 */
export function splitSystem(options: GenerateOptions): {
  system: Array<{ type: 'text'; text: string }>
  messages: Message[]
} {
  const system: Array<{ type: 'text'; text: string }> = []
  if (options.system) system.push({ type: 'text', text: options.system })
  const messages: Message[] = []
  for (const raw of options.messages) {
    const message = raw as Message
    if (message.role !== 'system') {
      messages.push(message)
      continue
    }
    for (const block of message.content) {
      if (block.type !== 'text') {
        throw new LlmError(
          `anthropic-compat: system 消息只支持 text block，收到 ${JSON.stringify(block.type)}`,
          'UNSUPPORTED',
        )
      }
      if (block.text) system.push({ type: 'text', text: block.text })
    }
  }
  return { system, messages }
}

/** dsh provider-neutral 消息 → Anthropic Messages API 的单个 message。 */
function toAnthropicMessage(
  message: Message,
  vendor: Config['vendor'],
  callIds: Map<string, ToolCallId>,
): Record<string, unknown> {
  if (message.role === 'system') {
    throw new LlmError('anthropic-compat: system 消息必须通过 GenerateOptions.system 传入', 'PROTOCOL')
  }

  // tool 角色：折叠成 tool_result。
  if (message.role === 'tool') {
    // 调用方已经把 tool 消息分组成一条 user 消息（见 toAnthropicMessages），
    // 这里只负责单块投影。
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: String(message.toolCallId),
          content: message.content.map(toAnthropicNestedBlock),
          ...(message.isError === undefined ? {} : { is_error: message.isError }),
        },
      ],
    }
  }

  const replay = replayBlocks(message)
  const content: Array<Record<string, unknown>> = []
  const hasReplayableSibling = message.content.some((block) => block.type !== 'reasoning')

  message.content.forEach((block, index) => {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: block.text })
        break
      case 'reasoning': {
        const metadata = replay[index]
        if (metadata?.type === 'thinking' && metadata.signature) {
          content.push({ type: 'thinking', thinking: block.text, signature: metadata.signature })
          break
        }
        // Fuyao 的工具调用响应可能带无 signature 的 thinking；
        // 同一消息里还有 text/tool-call 可回放时省略它，绝不把思维伪装成正文。
        if (vendor === 'fuyao' && hasReplayableSibling) break
        throw new LlmError(`${vendor}: 无法回放缺少 Anthropic signature 的 reasoning block`, 'PROTOCOL')
      }
      case 'tool-call': {
        callIds.set(String(block.id), block.id)
        content.push({
          type: 'tool_use',
          id: String(block.id),
          name: block.name,
          input: parseToolArguments(block.arguments, block.name),
        })
        break
      }
      case 'image':
        throw new LlmError('anthropic-compat: 当前适配器未装配附件读取能力，不能发送 image block', 'UNSUPPORTED')
      case 'file':
      case 'tool-addition':
      case 'tool-removal':
        // 这些是装配侧的元数据块，provider 不可见。
        break
      default:
        throw new LlmError(`anthropic-compat: 不支持的消息块 ${(block as ContentBlock).type}`, 'UNSUPPORTED')
    }
  })

  if (content.length === 0) return { role: message.role, content: [{ type: 'text', text: '' }] }
  return { role: message.role, content }
}

/**
 * 批量投影：把连续的 tool 消息合并进同一条 user 消息。
 *
 * Anthropic 的硬性要求：一个 assistant 消息里的所有 tool_use，必须在**紧随其后的
 * 一条** user 消息里全部得到 tool_result。dsh 的序列是 assistant → tool → tool →
 * tool → user（每个结果一条消息），所以这里按"连续 tool 段"聚合成一条 user。
 */
export function toAnthropicMessages(messages: readonly Message[], vendor: Config['vendor']): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const callIds = new Map<string, ToolCallId>()
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!
    if (message.role === 'tool') {
      const blocks: Array<Record<string, unknown>> = []
      while (index < messages.length && messages[index]!.role === 'tool') {
        const current = messages[index] as Extract<Message, { role: 'tool' }>
        blocks.push({
          type: 'tool_result',
          tool_use_id: String(current.toolCallId),
          content: current.content.map(toAnthropicNestedBlock),
          ...(current.isError === undefined ? {} : { is_error: current.isError }),
        })
        index += 1
      }
      index -= 1
      out.push({ role: 'user', content: blocks })
      continue
    }
    out.push(toAnthropicMessage(message, vendor, callIds))
  }
  return out
}

export function toAnthropicTool(tool: ToolSchema): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }
}

export function tokenUsage(
  inputTotal: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): TokenUsage {
  return {
    inputTokens: Math.max(0, inputTotal - cacheReadTokens - cacheWriteTokens),
    outputTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
  }
}

/** Anthropic Messages 适配器本体。 */
class AnthropicCompatAdapter extends LlmAdapter {
  // 注意：Node 的原生 type-stripping 只删类型、不做转换，因此不能用 TS 的
  // "constructor parameter property"（`constructor(private readonly x)`）写法。
  private readonly config: Config
  private readonly resolveApiKey: () => Promise<string>

  constructor(config: Config, resolveApiKey: () => Promise<string>) {
    super()
    this.config = config
    this.resolveApiKey = resolveApiKey
  }

  override providerInfo(provider: string) {
    return { id: provider, name: `Anthropic-compatible (${this.config.vendor})` }
  }

  override async listModels(): Promise<readonly { id: string; name: string; provider: string }[]> {
    const ids = this.config.models.length > 0 ? this.config.models : [this.config.model]
    return ids.map((id) => ({ id, name: id, provider: this.config.provider }))
  }

  /**
   * 解析"精确模型"的元数据。
   *
   * 契约（`dsh-llm` 的 `normalizeModelInfo`）要求返回对象满足：
   *   - `provider` 必须是注册时的 provider id（字符串相等）；
   *   - `id` 必须**等于**被解析的 model id；
   *   - `name` 必须是非空字符串；
   *   - `context.contextWindow` 若存在必须是正整数。
   *
   * 字段名写错（比如返回 `model` / `displayName` 而不是 `id` / `name`）会让
   * 校验抛 `INVALID_MODEL_INFO`，表现为「一调模型就 error」，且错误信息完全
   * 指向不到真正的原因——所以这里逐条对齐。
   */
  override async resolveModel(provider: string, model: string) {
    return {
      provider,
      id: model,
      name: model,
      // 该网关的上下文窗口未知时不声明 context——声明错了会让压缩策略失准。
      capabilities: { toolCalls: true, reasoning: true },
    } as any
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.reasoningEffort !== undefined) {
      // 该网关没有与 dsh 不透明 reasoning effort 对应的档位；fail loud，
      // 避免调用方以为这个选项已经生效。
      throw new LlmError(
        `anthropic-compat: 不支持 reasoningEffort=${JSON.stringify(options.reasoningEffort)}`,
        'UNSUPPORTED',
      )
    }

    const apiKey = await this.resolveApiKey()
    const model = options.model || this.config.model
    const { system, messages } = splitSystem(options)
    const maxTokens = options.maxTokens ?? this.config.maxTokens

    const response = await fetch(`${this.config.baseURL.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': this.config.anthropicVersion,
        // 0.2.1 契约：每个 provider 请求都必须带归属头。
        ...attributionHeaders(),
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        stream: true,
        ...(system.length > 0 ? { system } : {}),
        ...(options.tools?.length ? { tools: options.tools.map(toAnthropicTool) } : {}),
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.stop?.length ? { stop_sequences: options.stop } : {}),
        messages: toAnthropicMessages(messages, this.config.vendor),
      }),
      signal: options.signal ?? null,
    })

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '')
      throw new LlmError(
        `anthropic-compat: HTTP ${response.status} ${detail.slice(0, 300)}`,
        response.status === 401 || response.status === 403 ? 'AUTH' : 'HTTP',
      )
    }

    let inputTotal = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    let stopReason = 'end_turn'
    let terminal = false
    let responseId: string | undefined
    let responseModel: string | undefined
    const active = new Map<number, ActiveBlock>()
    const replay: ReplayBlock[] = []

    for await (const evt of parseSseData(response.body as unknown as AsyncIterable<Uint8Array>)) {
      if (evt.type === '__done') {
        terminal = true
        break
      }
      switch (evt.type) {
        case 'message_start': {
          responseId = evt.message?.id
          responseModel = evt.message?.model
          const usage = evt.message?.usage ?? {}
          inputTotal = usage.input_tokens ?? inputTotal
          outputTokens = usage.output_tokens ?? outputTokens
          cacheReadTokens = usage.cache_read_input_tokens ?? cacheReadTokens
          cacheWriteTokens = usage.cache_creation_input_tokens ?? cacheWriteTokens
          break
        }
        case 'content_block_start': {
          const index = evt.index
          const block = evt.content_block ?? {}
          if (block.type === 'text') {
            const text = block.text ?? ''
            active.set(index, { kind: 'text', text })
            yield { type: 'block-start', index, blockType: 'text' }
            if (text) yield { type: 'text-delta', index, text }
          } else if (block.type === 'thinking') {
            const text = block.thinking ?? ''
            active.set(index, { kind: 'reasoning', text, signature: block.signature ?? '' })
            yield { type: 'block-start', index, blockType: 'reasoning' }
            if (text) yield { type: 'reasoning-delta', index, text }
          } else if (block.type === 'tool_use') {
            const id = ToolCallId(String(block.id))
            const initial = block.input && Object.keys(block.input).length > 0 ? JSON.stringify(block.input) : ''
            active.set(index, { kind: 'tool-call', id, name: String(block.name), arguments: initial })
            yield { type: 'block-start', index, blockType: 'tool-call' }
            yield { type: 'tool-call-delta', index, id, name: String(block.name), argumentsDelta: initial }
          } else {
            throw new LlmError(
              `anthropic-compat: 不支持 Anthropic content block ${JSON.stringify(block.type)}`,
              'UNSUPPORTED',
            )
          }
          break
        }
        case 'content_block_delta': {
          const current = active.get(evt.index)
          if (!current) throw new LlmError(`anthropic-compat: 收到未知 block ${evt.index} 的 delta`, 'PROTOCOL')
          const delta = evt.delta ?? {}
          if (current.kind === 'text' && delta.type === 'text_delta') {
            const text = delta.text ?? ''
            current.text += text
            if (text) yield { type: 'text-delta', index: evt.index, text }
          } else if (current.kind === 'reasoning' && delta.type === 'thinking_delta') {
            const text = delta.thinking ?? ''
            current.text += text
            if (text) yield { type: 'reasoning-delta', index: evt.index, text }
          } else if (current.kind === 'reasoning' && delta.type === 'signature_delta') {
            current.signature += delta.signature ?? ''
          } else if (current.kind === 'tool-call' && delta.type === 'input_json_delta') {
            const fragment = delta.partial_json ?? ''
            current.arguments += fragment
            if (fragment) {
              yield { type: 'tool-call-delta', index: evt.index, id: current.id, argumentsDelta: fragment }
            }
          } else {
            throw new LlmError(
              `anthropic-compat: ${current.kind} block 收到不兼容 delta ${JSON.stringify(delta.type)}`,
              'PROTOCOL',
            )
          }
          break
        }
        case 'content_block_stop': {
          const current = active.get(evt.index)
          if (!current) throw new LlmError(`anthroph-compat: 收到未知 block ${evt.index} 的 stop`, 'PROTOCOL')
          active.delete(evt.index)
          if (current.kind === 'text') {
            yield { type: 'block-end', index: evt.index, block: { type: 'text', text: current.text } }
            replay.push({ type: 'text' })
          } else if (current.kind === 'reasoning') {
            yield { type: 'block-end', index: evt.index, block: { type: 'reasoning', text: current.text } }
            replay.push({ type: 'thinking', ...(current.signature ? { signature: current.signature } : {}) })
          } else {
            const argumentsRaw = current.arguments || '{}'
            parseToolArguments(argumentsRaw, current.name)
            yield {
              type: 'block-end',
              index: evt.index,
              block: { type: 'tool-call', id: current.id, name: current.name, arguments: argumentsRaw },
            }
            replay.push({ type: 'tool_use' })
          }
          break
        }
        case 'message_delta': {
          stopReason = evt.delta?.stop_reason ?? stopReason
          const usage = evt.usage ?? {}
          outputTokens = usage.output_tokens ?? outputTokens
          break
        }
        case 'message_stop':
          terminal = true
          break
        case 'ping':
          break
        case 'error':
          throw new LlmError(`anthropic-compat: 带内错误 ${JSON.stringify(evt.error ?? evt)}`, 'PROVIDER')
        default:
          // 未知事件类型一律忽略：网关经常追加私有事件。
          break
      }
      if (terminal) break
    }

    if (!terminal) throw new LlmError('anthropic-compat: 流在 message_stop 之前结束', 'PROTOCOL')
    if (active.size > 0) throw new LlmError('anthropic-compat: 流在 content_block_stop 之前结束', 'PROTOCOL')

    yield { type: 'usage', usage: tokenUsage(inputTotal, outputTokens, cacheReadTokens, cacheWriteTokens) }

    const kind = FINISH_REASON[stopReason] ?? 'stop'
    const replayState: ReplayEnvelope = { response: { id: responseId, model: responseModel, stopReason }, blocks: replay }
    yield {
      type: 'finish',
      reason: kind === 'max-tokens' ? { kind: 'max-tokens' } : kind === 'tool-calls' ? { kind: 'tool-calls' } : { kind: 'stop' },
      replayState,
    }
  }
}

/**
 * 挂载适配器：注册路由，并把凭据解析放在**每次请求**里做。
 *
 * 凭据缺失时不在启动期抛错——那样连 `/api/sessions`（纯本地读）都会失败。
 * 真正调用模型时才报 MISSING_CREDENTIAL，并且报错信息告诉用户设哪个环境变量
 * （fail loud，不静默降级）。
 */
export function apply(ctx: Context, config: Config): void {
  // 环境变量优先于 yaml：方便切网关而不改装配清单。
  const resolved: Config = {
    ...config,
    provider: process.env.DSH_MODEL_PROVIDER ?? config.provider,
    baseURL: process.env.LLM_BASE_URL ?? config.baseURL,
    model: process.env.LLM_MODEL ?? config.model,
    vendor:
      (process.env.LLM_VENDOR ?? '').toLowerCase() === 'fuyao'
        ? 'fuyao'
        : (process.env.LLM_VENDOR ?? '').toLowerCase() === 'minimax'
          ? 'minimax'
          : config.vendor,
  }
  if (resolved.vendor === 'fuyao' && !resolved.baseURL) {
    throw new Error('anthropic-compat: vendor=fuyao 时必须配置 baseURL（LLM_BASE_URL）')
  }

  const resolveApiKey = async (): Promise<string> => {
    const ref = resolved.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      // 0.2.1 的 `resolve()` 接受的是 **CredentialRef 字符串**（环境变量名），
      // 不是 0.1.5 时代的 `{ kind: 'env', name }` 对象。
      //
      // 这个差异不会在类型检查时报错（dsh-lab 的旧写法带 `as any`），但运行期
      // 会炸成 `name.toUpperCase is not a function`：对象被一路传到
      // `dsh-launch-environment` 的 `lookupKey()`，那里要对变量名做大小写折叠。
      // 表现是「一调模型就 error」，错误信息完全指不到真正的原因。
      const hit = await credentials.resolve(ref as never)
      if (hit !== undefined && hit.value.length > 0) return hit.value
    }
    const ambient = process.env[ref]
    if (ambient !== undefined && ambient.length > 0) return ambient
    throw new LlmError(
      `llm-anthropic-compat: 缺少 ${ref}；导出 ${ref}（或写进 .env）后再调用模型；` +
        `不调用模型的接口（会话列表、轨迹）不需要 key`,
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new AnthropicCompatAdapter(resolved, resolveApiKey)
  ctx.llm.registerAdapter([resolved.provider], adapter)
}
