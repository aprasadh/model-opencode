/**
 * Chat Completions adapter for the OpenCode model provider.
 *
 * Pure functions translating between the Strands SDK message/event types and
 * the OpenAI-compatible Chat Completions wire protocol spoken by the OpenCode
 * Zen and OpenCode Go endpoints.
 *
 * @internal
 */

import type {
  Message,
  ModelStreamEvent,
  StopReason,
  StreamOptions,
  ToolChoice,
  ToolSpec,
  Usage,
} from '@strands-agents/sdk'

/** Shape of a streaming Chat Completions chunk (structural, for testability). */
export interface ChatChunk {
  choices?: Array<{
    delta?: {
      role?: string
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: string
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  } | null
}

/** Mutable stream state carried across chunks. @internal */
export interface ChatStreamState {
  messageStarted: boolean
  textBlockStarted: boolean
  /** Tool call indexes for which a block-start was emitted and not yet stopped. */
  activeToolCalls: Set<number>
  /** Finish reason already mapped to a message-stop event. */
  messageStopped: boolean
}

/** Creates fresh stream state. @internal */
export function createStreamState(): ChatStreamState {
  return {
    messageStarted: false,
    textBlockStarted: false,
    activeToolCalls: new Set(),
    messageStopped: false,
  }
}

/** Tracks cumulative usage across the stream. @internal */
export interface UsageAccumulator {
  usage?: Usage
}

/** Default model used when none is configured. */
export const DEFAULT_MODEL_ID = 'glm-5.3'

/**
 * Builds a Chat Completions streaming request body.
 *
 * User `params` are spread first so provider-managed fields always win.
 *
 * @internal
 */
export function formatRequest(
  config: {
    modelId?: string
    maxTokens?: number
    temperature?: number
    topP?: number
    params?: Record<string, unknown>
  },
  messages: Message[],
  options?: StreamOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...(config.params ?? {}),
    model: config.modelId ?? DEFAULT_MODEL_ID,
    messages: formatMessages(messages, options?.systemPrompt),
    stream: true,
    stream_options: { include_usage: true },
  }

  if (config.maxTokens !== undefined) body.max_tokens = config.maxTokens
  if (config.temperature !== undefined) body.temperature = config.temperature
  if (config.topP !== undefined) body.top_p = config.topP

  if (options?.toolSpecs && options.toolSpecs.length > 0) {
    body.tools = options.toolSpecs.map((spec: ToolSpec) => ({
      type: 'function',
      function: {
        name: spec.name,
        description: spec.description,
        parameters: spec.inputSchema,
      },
    }))

    if (options.toolChoice) {
      body.tool_choice = formatToolChoice(options.toolChoice)
    }
  }

  return body
}

/** Maps a Strands ToolChoice to the Chat Completions tool_choice field. @internal */
function formatToolChoice(toolChoice: ToolChoice): string | { type: 'function'; function: { name: string } } {
  if ('auto' in toolChoice) return 'auto'
  if ('any' in toolChoice) return 'required'
  if ('tool' in toolChoice) return { type: 'function', function: { name: toolChoice.tool.name } }
  return 'auto'
}

/**
 * Converts SDK messages into Chat Completions message params.
 *
 * - System prompt (string or text blocks) becomes a `system` message.
 * - Assistant `toolUseBlock`s become `tool_calls` on the assistant message.
 * - User `toolResultBlock`s become separate `tool`-role messages.
 * - Unsupported block types are skipped with a warning.
 *
 * @internal
 */
export function formatMessages(
  messages: Message[],
  systemPrompt?: StreamOptions['systemPrompt'],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []

  if (systemPrompt !== undefined) {
    if (typeof systemPrompt === 'string') {
      if (systemPrompt.trim().length > 0) {
        out.push({ role: 'system', content: systemPrompt })
      }
    } else if (Array.isArray(systemPrompt) && systemPrompt.length > 0) {
      const textBlocks = systemPrompt.filter((b) => b.type === 'textBlock')
      if (textBlocks.length > 0) {
        out.push({ role: 'system', content: textBlocks.map((b) => b.text).join('') })
      }
    }
  }

  for (const message of messages) {
    if (message.role === 'user') {
      const toolResults = message.content.filter((b) => b.type === 'toolResultBlock')
      const otherContent = message.content.filter((b) => b.type !== 'toolResultBlock')

      if (otherContent.length > 0) {
        const text = otherContent
          .filter((b): b is Extract<typeof b, { type: 'textBlock' }> => b.type === 'textBlock')
          .map((b) => b.text)
          .join('')
        if (text.length > 0) {
          out.push({ role: 'user', content: text })
        }
      }

      for (const toolResult of toolResults) {
        const text = toolResult.content
          .map((c) => {
            if (c.type === 'textBlock') return c.text
            if (c.type === 'jsonBlock') {
              try {
                return JSON.stringify(c.json)
              } catch {
                return '[unserializable tool result]'
              }
            }
            return ''
          })
          .join('')
        const effective = text.length === 0 ? '[empty tool result]' : text
        out.push({
          role: 'tool',
          tool_call_id: toolResult.toolUseId,
          content: toolResult.status === 'error' ? `[ERROR] ${effective}` : effective,
        })
      }
    } else {
      const toolCalls: Array<Record<string, unknown>> = []
      const textParts: string[] = []

      for (const block of message.content) {
        if (block.type === 'textBlock') {
          textParts.push(block.text)
        } else if (block.type === 'toolUseBlock') {
          toolCalls.push({
            id: block.toolUseId,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          })
        }
      }

      const text = textParts.join('')
      const assistant: Record<string, unknown> = { role: 'assistant', content: text }
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls
      if (text.length > 0 || toolCalls.length > 0) out.push(assistant)
    }
  }

  return out
}

/**
 * Maps one streaming Chat Completions chunk to zero or more Strands stream
 * events. Mutates `state` and `usage` as side effects.
 *
 * @internal
 */
export function mapChunkToEvents(
  chunk: ChatChunk,
  state: ChatStreamState,
  usage: UsageAccumulator,
): ModelStreamEvent[] {
  const events: ModelStreamEvent[] = []

  if (chunk.usage) {
    const promptTokens = chunk.usage.prompt_tokens ?? 0
    const completionTokens = chunk.usage.completion_tokens ?? 0
    const cached = chunk.usage.prompt_tokens_details?.cached_tokens
    usage.usage = {
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      totalTokens: chunk.usage.total_tokens ?? promptTokens + completionTokens,
      ...(cached !== undefined && { cacheReadInputTokens: cached }),
    }
    // Some providers (e.g. OpenCode Go) attach usage to content-bearing chunks,
    // so keep processing choices below instead of returning early.
  }

  if (!chunk.choices || chunk.choices.length === 0) return events
  const choice = chunk.choices[0]
  if (!choice) return events

  const delta = choice.delta
  if (delta?.role && !state.messageStarted) {
    state.messageStarted = true
    events.push({ type: 'modelMessageStartEvent', role: 'assistant' })
  }

  if (delta?.content && delta.content.length > 0) {
    if (!state.textBlockStarted) {
      state.textBlockStarted = true
      events.push({ type: 'modelContentBlockStartEvent' })
    }
    events.push({ type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: delta.content } })
  }

  if (delta?.tool_calls && delta.tool_calls.length > 0) {
    for (const toolCall of delta.tool_calls) {
      if (toolCall.id && toolCall.function?.name) {
        events.push({
          type: 'modelContentBlockStartEvent',
          start: { type: 'toolUseStart', name: toolCall.function.name, toolUseId: toolCall.id },
        })
        state.activeToolCalls.add(toolCall.index)
      }
      if (toolCall.function?.arguments) {
        events.push({
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'toolUseInputDelta', input: toolCall.function.arguments },
        })
      }
    }
  }

  if (choice.finish_reason && !state.messageStopped) {
    state.messageStopped = true

    // Some providers emit a finish_reason without ever sending a role delta.
    if (!state.messageStarted) {
      state.messageStarted = true
      events.push({ type: 'modelMessageStartEvent', role: 'assistant' })
    }

    if (state.textBlockStarted) {
      events.push({ type: 'modelContentBlockStopEvent' })
      state.textBlockStarted = false
    }
    state.activeToolCalls.forEach(() => {
      events.push({ type: 'modelContentBlockStopEvent' })
    })
    state.activeToolCalls.clear()

    events.push({ type: 'modelMessageStopEvent', stopReason: mapStopReason(choice.finish_reason) })
  }

  return events
}

/** Maps an OpenAI finish_reason to a Strands StopReason. @internal */
export function mapStopReason(finishReason: string): StopReason {
  const map: Record<string, StopReason> = {
    stop: 'endTurn',
    tool_calls: 'toolUse',
    length: 'maxTokens',
    content_filter: 'contentFiltered',
  }
  return map[finishReason] ?? snakeToCamel(finishReason)
}

function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()) as StopReason
}
