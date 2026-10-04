import { describe, expect, it } from 'vitest'
import { JsonBlock, Message, TextBlock, ToolResultBlock, ToolUseBlock, type StreamOptions } from '@strands-agents/sdk'
import {
  formatMessages,
  formatRequest,
  mapChunkToEvents,
  mapStopReason,
  type ChatChunk,
  type UsageAccumulator,
} from '../src/chat-adapter.js'

describe('formatRequest', () => {
  it('builds a basic streaming request with params first so managed fields win', () => {
    const request = formatRequest(
      {
        modelId: 'glm-5.3',
        maxTokens: 512,
        temperature: 0.5,
        topP: 0.9,
        params: { model: 'should-be-overridden', temperature: 1.5, custom: 'kept' },
      },
      [],
      undefined,
    )

    expect(request).toMatchObject({
      model: 'glm-5.3',
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 512,
      temperature: 0.5,
      top_p: 0.9,
      custom: 'kept',
    })
  })

  it('includes tool specs and tool choice', () => {
    const options: StreamOptions = {
      toolSpecs: [
        {
          name: 'get_weather',
          description: 'Get weather',
          inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
      toolChoice: { auto: {} } as StreamOptions['toolChoice'],
    }
    const request = formatRequest({ modelId: 'm' }, [], options)
    expect(request.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
    ])
    expect(request.tool_choice).toBe('auto')
  })
})

describe('formatMessages', () => {
  it('puts string systemPrompt first as system message', () => {
    const out = formatMessages([], 'Be terse.')
    expect(out).toEqual([{ role: 'system', content: 'Be terse.' }])
  })

  it('joins text blocks for system prompt, skips empty/other blocks', () => {
    const out = formatMessages([], [new TextBlock('a'), new TextBlock('b')] as StreamOptions['systemPrompt'])
    expect(out).toEqual([{ role: 'system', content: 'ab' }])
  })

  it('maps user text and assistant tool use + tool results', () => {
    const messages: Message[] = [
      new Message({
        role: 'assistant',
        content: [
          new TextBlock('Let me check.'),
          new ToolUseBlock({ toolUseId: 'call_1', name: 'get_weather', input: { city: 'SF' } }),
        ],
      }),
      new Message({
        role: 'user',
        content: [
          new ToolResultBlock({
            toolUseId: 'call_1',
            status: 'success',
            content: [new JsonBlock({ json: { temp: 20 } })],
          }),
        ],
      }),
    ]

    const out = formatMessages(messages)
    expect(out).toEqual([
      {
        role: 'assistant',
        content: 'Let me check.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"SF"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"temp":20}' },
    ])
  })

  it('prefixes errors on failed tool results and handles empty content', () => {
    const messages: Message[] = [
      new Message({
        role: 'user',
        content: [
          new ToolResultBlock({
            toolUseId: 'call_2',
            status: 'error',
            content: [new TextBlock('boom')],
          }),
          new ToolResultBlock({
            toolUseId: 'call_3',
            status: 'success',
            content: [],
          }),
        ],
      }),
    ]
    const out = formatMessages(messages)
    expect(out).toEqual([
      { role: 'tool', tool_call_id: 'call_2', content: '[ERROR] boom' },
      { role: 'tool', tool_call_id: 'call_3', content: '[empty tool result]' },
    ])
  })
})

describe('mapStopReason', () => {
  it('maps known finish reasons', () => {
    expect(mapStopReason('stop')).toBe('endTurn')
    expect(mapStopReason('tool_calls')).toBe('toolUse')
    expect(mapStopReason('length')).toBe('maxTokens')
    expect(mapStopReason('content_filter')).toBe('contentFiltered')
  })

  it('falls back to camelCase for unknown reasons', () => {
    expect(mapStopReason('some_reason')).toBe('someReason')
  })
})

describe('mapChunkToEvents', () => {
  const acc: UsageAccumulator = {}
  const chunk = (overrides: Partial<ChatChunk>): ChatChunk => ({
    choices: [{ delta: { role: 'assistant', content: 'hi' }, finish_reason: null }],
    ...overrides,
  })

  it('emits message start then text start/delta, and stop at finish', () => {
    const state = { ...{ messageStarted: false, textBlockStarted: false, activeToolCalls: new Set<number>() } }
    const stateAny = state as never
    const evts = [
      ...mapChunkToEvents(chunk({}), stateAny, acc),
      ...mapChunkToEvents(chunk({ choices: [{ delta: { content: ' there' }, finish_reason: 'stop' }] }), stateAny, acc),
    ]

    expect(evts.map((e) => e.type)).toEqual([
      'modelMessageStartEvent',
      'modelContentBlockStartEvent',
      'modelContentBlockDeltaEvent',
      'modelContentBlockDeltaEvent',
      'modelContentBlockStopEvent',
      'modelMessageStopEvent',
    ])
  })

  it('emits toolUse start/input and closes blocks at finish', () => {
    const state = { ...{ messageStarted: false, textBlockStarted: false, activeToolCalls: new Set<number>() } }
    const stateAny = state as never
    const evts = [
      ...mapChunkToEvents(
        chunk({
          choices: [
            {
              delta: {
                role: 'assistant',
                tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'f', arguments: '{"a"' } }],
              },
              finish_reason: null,
            },
          ],
        }),
        stateAny,
        acc,
      ),
      ...mapChunkToEvents(
        chunk({
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: ':1}}' } }] }, finish_reason: 'tool_calls' },
          ],
        }),
        stateAny,
        acc,
      ),
    ]

    const types = evts.map((e) => e.type)
    expect(types).toEqual([
      'modelMessageStartEvent',
      'modelContentBlockStartEvent',
      'modelContentBlockDeltaEvent',
      'modelContentBlockDeltaEvent',
      'modelContentBlockStopEvent',
      'modelMessageStopEvent',
    ])
    const startEvt = evts[1] as { start: { name: string; toolUseId: string; type: string } }
    expect(startEvt.start).toEqual({ type: 'toolUseStart', name: 'f', toolUseId: 't1' })
    const inputs = evts
      .filter((e) => e.type === 'modelContentBlockDeltaEvent')
      .map((e) => (e.delta as { type: string; input?: string }).input)
      .join('')
    expect(inputs).toBe('{"a":1}}')
    expect((evts.at(-1) as { stopReason: string }).stopReason).toBe('toolUse')
  })

  it('captures usage from final chunk and emits no content events', () => {
    const state = { ...{ messageStarted: false, textBlockStarted: false, activeToolCalls: new Set<number>() } }
    const usageAcc: UsageAccumulator = {}
    const events = mapChunkToEvents(
      {
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          prompt_tokens_details: { cached_tokens: 3 },
        },
      },
      state as never,
      usageAcc,
    )
    expect(events).toEqual([])
    expect(usageAcc.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cacheReadInputTokens: 3,
    })
  })
})
