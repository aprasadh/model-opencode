# Strands Model Provider for OpenCode Endpoints — Design

**Date:** 2026-09-22
**Package:** `@strands-agents/model-opencode`
**Reference:** https://github.com/strands-agents/extension-template (TypeScript model provider skeleton)

## Purpose

A Strands Agents TypeScript model provider that connects Strands agents to LLMs
served through OpenCode's provider endpoints:

| Endpoint | Base URL | Auth | Env var |
| --- | --- | --- | --- |
| OpenCode Zen | `https://opencode.ai/zen/v1` | Bearer API key | `OPENCODE_API_KEY` |
| OpenCode Go | `https://opencode.ai/zen/go/v1` | Bearer API key | `OPENCODE_API_KEY` |

Both speak the OpenAI Chat Completions wire protocol (`/chat/completions`).
A single `OpenCodeModel` class parameterized by `baseUrl` covers both; preset
factories (`opencodeZen()`, `opencodeGo()`) encode the base URLs.

## Scope

Full agent loop: text streaming and tool calling (tool specs out, `toolUse`
blocks in, tool results back to the model). No multimodal, embeddings, caching,
or reasoning-signature handling; unsupported content blocks are skipped with a
warning.

## Architecture

- `src/model.ts` — `OpenCodeModel extends Model<OpenCodeModelConfig>`.
  Config: `baseUrl` (required), `apiKey` (required), `modelId`, `maxTokens`,
  `temperature`, `topP`, `params` (passthrough extra body fields).
  HTTP via the `openai` npm package (peer dep) with `baseURL` override; SSE
  streaming through `client.chat.completions.create({ stream: true })`.
- `src/chat-adapter.ts` — pure functions:
  - `formatRequest(config, messages, options)` — Strands messages/toolSpecs →
    Chat Completions body. System prompt → `system` message; assistant
    `toolUseBlock` → `tool_calls`; user `toolResultBlock` → `tool`-role
    messages; tool result JSON → stringified text.
  - `mapChunkToEvents(chunk, state)` — SSE chunks → Strands
    `ModelStreamEvent`s. Emits the full contract:
    `modelMessageStartEvent` → content block start/delta/stop (text + toolUse)
    → `modelMessageStopEvent` → `modelMetadataEvent` (usage from
    `stream_options.include_usage`, `cached_tokens` → `cacheReadInputTokens`).
  - Stop reasons: `stop`→`endTurn`, `tool_calls`→`toolUse`, `length`→`maxTokens`,
    `content_filter`→`contentFiltered`, unknown → camelCase fallback.
- `src/errors.ts` — maps `openai` `APIError`s: 429 → `ModelThrottledError`;
  400 with context-length signature → `ContextWindowOverflowError`; else
  `ModelError` with cause. Strands' base `streamAggregated` already wraps and
  converts `maxTokens` stop reason.
- `src/presets.ts` — `opencodeZen(config)` / `opencodeGo(config)` returning
  configured instances.
- `src/index.ts` — public exports.

## Packaging

Mirrors the extension template: ESM (`type: module`), `tsc` build to `dist/`,
`vitest` tests, prettier + eslint, Node >= 20, peer deps
`@strands-agents/sdk` (>=1 <2) and `openai` (>=5 <8). Adapter functions stay
structurally typed over chunk shapes so they are unit-testable without network.

## Testing

- Adapter: request formatting (system/tools/tool-results/tool-use) and chunk→
  event mapping (text, tool calls with argument fragments, finish reasons,
  usage/metadata, interleaved text+tools).
- Model: yields SDK events in contract order over a mocked client; error
  mapping for 429/400.
- Presets: base URL and env-var defaults.
