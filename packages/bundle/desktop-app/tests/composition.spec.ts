import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'

const PATCH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))

describe('desktop bundle composition', () => {
  it('inserts the sidebar glass contribution only on macOS', () => {
    const parsed = yaml.load(readFileSync(PATCH, 'utf8'), { schema: entryListSchema })
    if (!Array.isArray(parsed)) throw new TypeError('desktop patch must parse to a patch list')
    const insertion = parsed.find((patch): patch is { insert: unknown[] } => (
      typeof patch === 'object' && patch !== null && Array.isArray((patch as Record<string, unknown>)['insert'])
      && ((patch as Record<string, unknown>)['insert'] as Array<Record<string, unknown>>)
        .some(entry => entry['id'] === 'ui-sidebar-glass-macos')
    ))
    const entry = insertion?.insert.find((candidate): candidate is Record<string, unknown> => (
      typeof candidate === 'object' && candidate !== null
      && (candidate as Record<string, unknown>)['id'] === 'ui-sidebar-glass-macos'
    ))
    expect(entry?.['name']).toBe('@deepseek-ai/dsh-client-ui-theme/sidebar-glass')
    const expression = entry?.['disabled'] as { __jsExpr?: string } | undefined
    expect(expression?.__jsExpr).toBeDefined()
    expect(Boolean(evaluate({ process: { platform: 'darwin' } }, expression!.__jsExpr!))).toBe(false)
    expect(Boolean(evaluate({ process: { platform: 'linux' } }, expression!.__jsExpr!))).toBe(true)
    expect(Boolean(evaluate({ process: { platform: 'win32' } }, expression!.__jsExpr!))).toBe(true)
    expect(parsed.some(patch => (
      typeof patch === 'object' && patch !== null && (patch as Record<string, unknown>)['id'] === 'ui-theme'
    ))).toBe(false)
  })
})
