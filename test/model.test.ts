import { afterEach, describe, expect, it } from 'vitest'
import { OPENCODE_API_KEY_ENV, opencodeGo, opencodeZen, OpenCodeModel } from '../src/model.js'
import { mapModelError } from '../src/errors.js'

describe('presets', () => {
  const originalKey = process.env[OPENCODE_API_KEY_ENV]

  afterEach(() => {
    if (originalKey === undefined) delete process.env[OPENCODE_API_KEY_ENV]
    else process.env[OPENCODE_API_KEY_ENV] = originalKey
  })

  it('opencodeZen uses the Zen base URL', () => {
    const model = opencodeZen({ modelId: 'glm-5.3' })
    expect(model.getConfig()).toMatchObject({ baseUrl: 'https://opencode.ai/zen/v1', modelId: 'glm-5.3' })
  })

  it('opencodeGo uses the Go base URL', () => {
    const model = opencodeGo({ modelId: 'qwen3.5-plus' })
    expect(model.getConfig()).toMatchObject({ baseUrl: 'https://opencode.ai/zen/go/v1', modelId: 'qwen3.5-plus' })
  })

  it('explicit baseUrl overrides the preset', () => {
    const model = opencodeZen({ baseUrl: 'https://proxy.example.com/v1' })
    expect(model.getConfig().baseUrl).toBe('https://proxy.example.com/v1')
  })
})

describe('OpenCodeModel config', () => {
  it('throws without a baseUrl', () => {
    expect(() => new OpenCodeModel({} as never)).toThrow(/baseUrl/)
  })

  it('updateConfig merges and client rebinds on baseUrl change', () => {
    const model = new OpenCodeModel({ baseUrl: 'https://a.example.com/v1' })
    model.updateConfig({ modelId: 'm2' })
    expect(model.getConfig().modelId).toBe('m2')
    model.updateConfig({ baseUrl: 'https://b.example.com/v1' })
    expect(model.getConfig().baseUrl).toBe('https://b.example.com/v1')
  })
})

describe('mapModelError', () => {
  it('maps 429 to ModelThrottledError', () => {
    const err = mapModelError({ status: 429, message: 'rate limited' })
    expect(err.name).toBe('ModelThrottledError')
  })

  it('maps 400 context overflow to ContextWindowOverflowError', () => {
    const err = mapModelError({ status: 400, message: "This model's maximum context length exceeded" })
    expect(err.name).toBe('ContextWindowOverflowError')
  })

  it('wraps other errors in ModelError', () => {
    const err = mapModelError(new Error('network down'))
    expect(err.name).toBe('ModelError')
    expect(err.cause).toBeInstanceOf(Error)
  })
})
