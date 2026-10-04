/**
 * Public entry point for @strands-agents/model-opencode.
 */

export {
  OPENCODE_API_KEY_ENV,
  OPENCODE_GO_BASE_URL,
  OPENCODE_SESSION_HEADER,
  OPENCODE_ZEN_BASE_URL,
  DEFAULT_MODEL_ID,
  OpenCodeModel,
  opencodeGo,
  opencodeZen,
} from './model.js'
export type { OpenCodeModelConfig } from './model.js'
export { mapModelError } from './errors.js'
