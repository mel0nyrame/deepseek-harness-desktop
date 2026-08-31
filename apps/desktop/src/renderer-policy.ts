import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Whether a main-frame URL is the exact bundled desktop renderer. */
export function isTrustedRendererUrl(value: string, rendererPath: string): boolean {
  try {
    const expected = pathToFileURL(rendererPath).href
    const actual = new URL(value)
    if (actual.hash !== '') return false
    const params = new URLSearchParams(actual.searchParams)
    actual.search = ''
    if (actual.href !== expected) return false
    if (params.size === 0) return true
    if (params.size === 1) return params.get('tracer') === '1'
    if (params.size !== 3 || params.get('tracer') !== 'native') return false
    const picked = params.getAll('pick')
    const opened = params.getAll('open')
    return picked.length === 1 && opened.length === 1
      && isAbsolute(picked[0] as string) && isAbsolute(opened[0] as string)
  } catch {
    return false
  }
}
