/**
 * Live smoke test against the real OpenCode endpoints.
 * Usage: npx tsx scripts/smoke.ts
 *   SMOKE_BASE_URL (default https://opencode.ai/zen/v1)
 *   SMOKE_MODEL    (default glm-5.3-flash)
 */
import { OpenCodeModel, opencodeZen } from '../src/model.js'
import { Message, TextBlock, type StreamOptions } from '@strands-agents/sdk'

const model =
  process.env.SMOKE_BASE_URL === 'https://opencode.ai/zen/go/v1'
    ? opencodeGo({ modelId: process.env.SMOKE_MODEL ?? 'glm-5.3-flash' })
    : (process.env.SMOKE_BASE_URL
        ? new OpenCodeModel({ baseUrl: process.env.SMOKE_BASE_URL })
        : opencodeZen({ modelId: process.env.SMOKE_MODEL ?? 'glm-5.3-flash' }))

const options: StreamOptions = {
  systemPrompt: 'You are a helpful assistant.',
  toolSpecs: [
    {
      name: 'get_weather',
      description: 'Get the weather for a city',
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  ],
  toolChoice: { auto: {} } as StreamOptions['toolChoice'],
}

const messages = [
  new Message({ role: 'user', content: [new TextBlock('What is the weather in San Francisco?')] }),
]

let text = ''
let stopReason: string | undefined
let usage: unknown
let toolCallStarted = false

for await (const event of model.stream(messages, options)) {
  switch (event.type) {
    case 'modelMessageStartEvent':
      console.log('[message start]', event.role)
      break
    case 'modelContentBlockStartEvent':
      if (event.start?.type === 'toolUseStart') {
        toolCallStarted = true
        console.log('[tool use start]', event.start.name, event.start.toolUseId)
      }
      break
    case 'modelContentBlockDeltaEvent':
      if (event.delta.type === 'textDelta') text += event.delta.text
      if (event.delta.type === 'toolUseInputDelta') process.stdout.write(`[tool input delta] ${event.delta.input}`)
      break
    case 'modelContentBlockStopEvent':
      console.log('\n[block stop]')
      break
    case 'modelMessageStopEvent':
      stopReason = event.stopReason
      console.log('[message stop]', event.stopReason)
      break
    case 'modelMetadataEvent':
      usage = event.usage
      console.log('[usage]', JSON.stringify(event.usage))
      break
    default:
      break
  }
}

console.log('\n--- summary ---')
console.log('text:', JSON.stringify(text.slice(0, 200)))
console.log('toolCallStarted:', toolCallStarted)
console.log('stopReason:', stopReason)
console.log('usage:', JSON.stringify(usage))

if (!usage || !stopReason) {
  console.error('SMOKE FAILED: missing usage or stopReason')
  process.exit(1)
}
console.log('SMOKE PASSED')
