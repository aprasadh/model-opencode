/**
 * OpenCode Model Provider.
 *
 * Connects Strands agents to LLMs served through OpenCode provider endpoints
 * (OpenCode Zen and OpenCode Go). Both endpoints speak the OpenAI-compatible
 * Chat Completions protocol, so a single {@link OpenCodeModel} class
 * parameterized by `baseUrl` covers both; use the {@link opencodeZen} and
 * {@link opencodeGo} presets for convenience.
 *
 * @example
 * ```ts
 * import { Agent } from '@strands-agents/sdk'
 * import { opencodeZen } from '@strands-agents/model-opencode'
 *
 * const model = opencodeZen({ modelId: 'glm-5.3' })
 * const agent = new Agent({ model })
 * ```
 */

import {
  Model,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
  type StreamOptions,
} from '@strands-agents/sdk'
import OpenAI from 'openai'
import { createStreamState, formatRequest, mapChunkToEvents, type UsageAccumulator } from './chat-adapter.js'
import { mapModelError } from './errors.js'

/** Base URL of the OpenCode Zen Chat Completions endpoint. */
export const OPENCODE_ZEN_BASE_URL = 'https://opencode.ai/zen/v1'

/** Base URL of the OpenCode Go Chat Completions endpoint. */
export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'

/** Environment variable holding the OpenCode API key. */
export const OPENCODE_API_KEY_ENV = 'OPENCODE_API_KEY'

/** HTTP header carrying the OpenCode Go session id. */
export const OPENCODE_SESSION_HEADER = 'x-opencode-session'

/** Default model used when none is configured. Re-exported from the adapter. */
export { DEFAULT_MODEL_ID } from './chat-adapter.js'

/** Configuration for {@link OpenCodeModel}. */
export interface OpenCodeModelConfig extends BaseModelConfig {
  /** Base URL of the OpenAI-compatible endpoint, e.g. https://opencode.ai/zen/v1 */
  baseUrl: string

  /** API key sent as a bearer token. Defaults to the OPENCODE_API_KEY env var. */
  apiKey?: string

  /**
   * Session id for the OpenCode Go endpoint, sent as the
   * `x-opencode-session` header. Required by OpenCode Go; unused by OpenCode
   * Zen.
   */
  sessionId?: string

  /**
   * Extra fields merged into every request body. Provider-managed fields
   * (model, messages, stream, stream_options, temperature, max_tokens, top_p,
   * tools, tool_choice) always win over entries here.
   */
  params?: Record<string, unknown>
}

/** Strands model provider for OpenCode Zen and OpenCode Go endpoints. */
export class OpenCodeModel extends Model<OpenCodeModelConfig> {
  private _config: OpenCodeModelConfig

  /** Lazily-created OpenAI client bound to the configured base URL. */
  private _client: OpenAI | undefined

  constructor(config: OpenCodeModelConfig) {
    super()
    if (!config.baseUrl) {
      throw new Error('OpenCodeModel requires a baseUrl (e.g. https://opencode.ai/zen/v1)')
    }
    this._config = { ...config }
  }

  override updateConfig(modelConfig: Partial<OpenCodeModelConfig>): void {
    const clientInvalidated =
      (modelConfig.baseUrl !== undefined && modelConfig.baseUrl !== this._config.baseUrl) ||
      (modelConfig.sessionId !== undefined && modelConfig.sessionId !== this._config.sessionId)
    this._config = { ...this._config, ...modelConfig }
    if (clientInvalidated) this._client = undefined
  }

  override getConfig(): OpenCodeModelConfig {
    return { ...this._config }
  }

  private get client(): OpenAI {
    if (!this._client) {
      const apiKey = this._config.apiKey ?? process.env[OPENCODE_API_KEY_ENV] ?? ''
      const sessionId = this._config.sessionId
      this._client = new OpenAI({
        apiKey,
        baseURL: this._config.baseUrl,
        ...(sessionId !== undefined &&
          sessionId !== '' && {
            defaultHeaders: { [OPENCODE_SESSION_HEADER]: sessionId },
          }),
      })
    }
    return this._client
  }

  override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const request = formatRequest(this._config, messages, options)

    let completion
    try {
      completion = await this.client.chat.completions.create({
        ...(request as unknown as Parameters<typeof this.client.chat.completions.create>[0]),
        stream: true,
      })
    } catch (error) {
      throw mapModelError(error)
    }

    const state = createStreamState()
    const usage: UsageAccumulator = {}
    let metadataEmitted = false

    try {
      for await (const chunk of completion) {
        const events = mapChunkToEvents(chunk as Parameters<typeof mapChunkToEvents>[0], state, usage)
        for (const event of events) {
          yield event
        }
      }
    } catch (error) {
      throw mapModelError(error)
    }

    if (usage.usage && !metadataEmitted) {
      metadataEmitted = true
      yield {
        type: 'modelMetadataEvent',
        usage: usage.usage,
        metrics: { latencyMs: 0 },
      }
    }
  }
}

/**
 * Creates a model configured for the OpenCode Zen endpoint.
 *
 * @param config - Model config; `baseUrl` defaults to the Zen endpoint and
 *   `apiKey` defaults to the `OPENCODE_API_KEY` environment variable.
 */
export function opencodeZen(config: Omit<OpenCodeModelConfig, 'baseUrl'> & { baseUrl?: string }): OpenCodeModel {
  return new OpenCodeModel({ baseUrl: OPENCODE_ZEN_BASE_URL, ...config })
}

/**
 * Creates a model configured for the OpenCode Go endpoint.
 *
 * @param config - Model config; `baseUrl` defaults to the Go endpoint,
 *   `apiKey` defaults to the `OPENCODE_API_KEY` environment variable, and
 *   `sessionId` is required (sent as the `x-opencode-session` header).
 */
export function opencodeGo(config: Omit<OpenCodeModelConfig, 'baseUrl'> & { baseUrl?: string }): OpenCodeModel {
  if (!config.sessionId) {
    throw new Error(
      'opencodeGo requires a sessionId; it is sent as the x-opencode-session header and is mandatory for the Go endpoint',
    )
  }
  return new OpenCodeModel({ baseUrl: OPENCODE_GO_BASE_URL, ...config })
}
