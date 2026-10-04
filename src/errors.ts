/**
 * Error mapping for the OpenCode model provider.
 *
 * Converts OpenAI SDK / HTTP errors into the Strands SDK error hierarchy so
 * the agent loop can react appropriately (retry on throttling, compress
 * context on overflow, etc.).
 *
 * @internal
 */

import { ContextWindowOverflowError, ModelError, ModelThrottledError } from '@strands-agents/sdk'

/** Signature fragments that indicate a context-window overflow (OpenAI-style). */
const CONTEXT_OVERFLOW_SIGNATURES = [
  'context length',
  'context_length',
  'maximum context',
  'reduce the length',
  'too many tokens',
]

/**
 * Maps an unknown error thrown during streaming to the appropriate Strands
 * ModelError subclass.
 *
 * @internal
 */
export function mapModelError(error: unknown): ModelError {
  if (error instanceof ModelError) return error

  const apiError = error as { status?: number; message?: string; name?: string }
  const status = typeof apiError?.status === 'number' ? apiError.status : undefined
  const message = typeof apiError?.message === 'string' ? apiError.message : String(error)

  if (status === 429) {
    return new ModelThrottledError(`OpenCode endpoint throttled the request: ${message}`, { cause: error })
  }

  if (status === 400 && CONTEXT_OVERFLOW_SIGNATURES.some((sig) => message.toLowerCase().includes(sig))) {
    return new ContextWindowOverflowError(`Input exceeds the model context window: ${message}`)
  }

  return new ModelError(`OpenCode model request failed: ${message}`, { cause: error })
}
