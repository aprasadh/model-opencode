# @strands-agents/model-opencode

Strands Agents model provider for the OpenCode endpoints:

| Endpoint | Base URL | Auth |
| --- | --- | --- |
| OpenCode Zen | `https://opencode.ai/zen/v1` | `OPENCODE_API_KEY` bearer |
| OpenCode Go | `https://opencode.ai/zen/go/v1` | `OPENCODE_API_KEY` bearer |

Both endpoints speak the OpenAI-compatible Chat Completions protocol, so one
`OpenCodeModel` class covers both; presets `opencodeZen()` / `opencodeGo()`
encode the base URLs.

## Install

```sh
npm install @strands-agents/model-opencode
```

Peer dependencies: `@strands-agents/sdk`, `openai`.

## Usage

```ts
import { Agent } from '@strands-agents/sdk'
import { opencodeZen } from '@strands-agents/model-opencode'

const model = opencodeZen({ modelId: 'glm-5.3' })
const agent = new Agent({ model })
```

OpenCode Go requires a session id, sent as the `x-opencode-session` header:

```ts
import { opencodeGo } from '@strands-agents/model-opencode'

const model = opencodeGo({ modelId: 'qwen3.5-plus', sessionId: process.env.OPENCODE_SESSION_ID })
```

The API key is read from the `OPENCODE_API_KEY` environment variable unless
passed explicitly:

```ts
const model = opencodeZen({ modelId: 'glm-5.3', apiKey: process.env.MY_KEY })
```

Extra passthrough request fields:

```ts
const model = opencodeZen({
  modelId: 'glm-5.3',
  maxTokens: 4096,
  temperature: 0.7,
  params: { presence_penalty: 0.1 },
})
```

## Development

```sh
npm install
npm run check   # format + lint + type-check + test
npm run build   # emits dist/
```

## License

Apache-2.0
