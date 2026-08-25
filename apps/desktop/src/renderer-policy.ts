import { pathToFileURL } from 'node:url'

/** Whether a main-frame URL is the exact bundled desktop renderer. */
export function isTrustedRendererUrl(value: string, rendererPath: string): boolean {
  try {
    const expected = pathToFileURL(rendererPath).href
    return value === expected || value === `${expected}?tracer=1`
  } catch {
    return false
  }
}
