import { describe, expect, it, vi } from 'vitest'
import { OPENCODE_SESSION_HEADER, OpenCodeModel, opencodeGo } from '../src/model.js'

// Capture the options passed to the OpenAI constructor so we can assert which
// defaultHeaders the provider configures without making a network call.
const constructorCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>)

vi.mock('openai', () => {
  class FakeOpenAI {
    chat = { completions: { create: vi.fn() } }
    constructor(options: Record<string, unknown>) {
      constructorCalls.push(options)
    }
  }
  return { default: FakeOpenAI }
})

describe('x-opencode-session header', () => {
  it('is sent as a defaultHeader when sessionId is configured', () => {
    constructorCalls.length = 0
    const model = new OpenCodeModel({
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiKey: 'k',
      sessionId: 'sess-abc',
    })
    void (model as unknown as { client: unknown }).client // trigger lazy client construction

    expect(constructorCalls.at(-1)?.defaultHeaders).toEqual({ [OPENCODE_SESSION_HEADER]: 'sess-abc' })
  })

  it('is omitted when sessionId is absent', () => {
    constructorCalls.length = 0
    const model = new OpenCodeModel({ baseUrl: 'https://opencode.ai/zen/v1', apiKey: 'k' })
    void (model as unknown as { client: unknown }).client

    expect(constructorCalls.at(-1)?.defaultHeaders).toBeUndefined()
  })

  it('is required by the opencodeGo preset', () => {
    expect(() => opencodeGo({ modelId: 'qwen3.5-plus' })).toThrow(/sessionId/)
  })
})
