import { describe, expect, it, vi } from 'vitest'
import { OpenCodeModel } from '../src/model.js'

/** Builds a fake OpenAI-compatible client. */
function fakeClient(chunks: unknown[]) {
  return {
    chat: {
      completions: {
        create: vi.fn(async () => ({
          async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) yield chunk
          },
        })),
      },
    },
  }
}

describe('OpenCodeModel.stream', () => {
  it('yields the full event contract in order and collects usage', async () => {
    const model = new OpenCodeModel({ baseUrl: 'https://opencode.ai/zen/v1', apiKey: 'test', modelId: 'glm-5.3' })
    // Inject a fake client.
    const client = fakeClient([
      { choices: [{ delta: { role: 'assistant', content: 'Hel' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'lo!' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } },
    ])
    ;(model as unknown as { _client: unknown })._client = client

    const events = []
    for await (const event of model.stream([{ role: 'user', content: [{ type: 'textBlock', text: 'hi' }] } as never])) {
      events.push(event)
    }

    const types = events.map((e) => e.type)
    expect(types).toEqual([
      'modelMessageStartEvent',
      'modelContentBlockStartEvent',
      'modelContentBlockDeltaEvent',
      'modelContentBlockDeltaEvent',
      'modelContentBlockStopEvent',
      'modelMessageStopEvent',
      'modelMetadataEvent',
    ])

    const stop = events.find((e) => e.type === 'modelMessageStopEvent') as { stopReason: string }
    expect(stop.stopReason).toBe('endTurn')
    const metadata = events.find((e) => e.type === 'modelMetadataEvent') as { usage: { totalTokens: number } }
    expect(metadata.usage.totalTokens).toBe(9)

    // Request body sanity.
    const create = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >
    expect(create.model).toBe('glm-5.3')
    expect(create.stream).toBe(true)
    expect(create.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('emits tool use events and toolUse stop reason', async () => {
    const model = new OpenCodeModel({ baseUrl: 'https://opencode.ai/zen/v1', apiKey: 'test', modelId: 'm' })
    const client = fakeClient([
      {
        choices: [
          {
            delta: {
              role: 'assistant',
              tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'add', arguments: '{"x"' } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }, finish_reason: 'tool_calls' },
        ],
      },
    ])
    ;(model as unknown as { _client: unknown })._client = client

    const events = []
    for await (const event of model.stream([])) {
      events.push(event)
    }
    const start = events.find((e) => e.type === 'modelContentBlockStartEvent') as { start?: { type: string } }
    expect(start?.start?.type).toBe('toolUseStart')
    const stop = events.find((e) => e.type === 'modelMessageStopEvent') as { stopReason: string }
    expect(stop.stopReason).toBe('toolUse')
  })

  it('falls back to a minimal event sequence for an empty completion', async () => {
    const model = new OpenCodeModel({ baseUrl: 'https://opencode.ai/zen/v1', apiKey: 'test', modelId: 'm' })
    const client = fakeClient([{ choices: [{ delta: {}, finish_reason: 'stop' }] }])
    ;(model as unknown as { _client: unknown })._client = client

    const types: string[] = []
    for await (const event of model.stream([])) {
      types.push(event.type)
    }
    expect(types).toEqual(['modelMessageStartEvent', 'modelMessageStopEvent'])
  })

  it('propagates mapped errors on request failure', async () => {
    const model = new OpenCodeModel({ baseUrl: 'https://opencode.ai/zen/v1', apiKey: 'test', modelId: 'm' })
    const client = {
      chat: {
        completions: {
          create: vi.fn(async () => {
            throw { status: 429, message: 'too many requests' }
          }),
        },
      },
    }
    ;(model as unknown as { _client: unknown })._client = client

    await expect(async () => {
      for await (const _event of model.stream([])) {
        void _event
      }
    }).rejects.toMatchObject({ name: 'ModelThrottledError' })
  })
})
