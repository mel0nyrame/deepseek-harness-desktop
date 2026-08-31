import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isTrustedRendererUrl } from '../apps/desktop/src/renderer-policy.js'

const renderer = resolve(import.meta.dirname, '..', 'apps', 'desktop', 'renderer.html')

describe('desktop renderer navigation policy', () => {
  it('accepts only the product renderer and its tracer query', () => {
    const url = pathToFileURL(renderer).href

    expect(isTrustedRendererUrl(url, renderer)).toBe(true)
    expect(isTrustedRendererUrl(`${url}?tracer=1`, renderer)).toBe(true)
    expect(isTrustedRendererUrl(`${url}?tracer=native&pick=%2Ftmp%2Fpicked&open=%2Ftmp%2Fopened`, renderer)).toBe(true)
    expect(isTrustedRendererUrl(`${url}?tracer=native&pick=relative&open=%2Ftmp%2Fopened`, renderer)).toBe(false)
    expect(isTrustedRendererUrl(`${url}?tracer=native&pick=%2Ftmp%2Fpicked`, renderer)).toBe(false)
    expect(isTrustedRendererUrl(`${url}?tracer=0`, renderer)).toBe(false)
    expect(isTrustedRendererUrl(`${url}#unexpected`, renderer)).toBe(false)
    expect(isTrustedRendererUrl('dsh://app/index.html', renderer)).toBe(true)
    expect(isTrustedRendererUrl('dsh://app/', renderer)).toBe(true)
    expect(isTrustedRendererUrl('dsh://app/index.html?unexpected=1', renderer)).toBe(false)
    expect(isTrustedRendererUrl('dsh://other/index.html', renderer)).toBe(false)
    expect(isTrustedRendererUrl(pathToFileURL(resolve(renderer, '..', 'other.html')).href, renderer)).toBe(false)
    expect(isTrustedRendererUrl('https://example.com/', renderer)).toBe(false)
    expect(isTrustedRendererUrl('not a url', renderer)).toBe(false)
  })
})
