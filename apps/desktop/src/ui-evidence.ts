/** Keyless evidence journey through the real composed desktop Client. */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { TERMINAL_TRACER_PROMPT } from './tracer-contract.js'

const REQUIRED_CLIENT_MODULES = [
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-directory-picker-native',
  '@deepseek-ai/dsh-client-ui-input-trigger',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-settings-general',
  '@deepseek-ai/dsh-client-ui-workspace',
  '@dsh-desktop/connection',
  '@dsh-desktop/ui',
] as const

async function waitFor(
  window: BrowserWindow,
  expression: string,
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ready = await window.webContents.executeJavaScript(`Boolean(${expression})`) as unknown
    if (ready === true) return
    if (Date.now() > deadline) {
      const diagnostic = await window.webContents.executeJavaScript(`(() => ({
        text: document.body.innerText.slice(0, 1500),
        input: document.querySelector('textarea')?.value,
        phase: document.querySelector('textarea')?.getAttribute('data-phase'),
        tools: [...document.querySelectorAll('[data-tool]')].map(row => ({
          tool: row.getAttribute('data-tool'), state: row.getAttribute('data-state'),
        })),
      }))()`)
      throw new Error(`desktop UI evidence timed out waiting for ${label}: ${JSON.stringify(diagnostic)}`)
    }
    await new Promise(done => setTimeout(done, 50))
  }
}

interface CapturedFrame {
  readonly file: string
  readonly bytes: number
  readonly sha256: string
}

async function capture(window: BrowserWindow, framesDir: string, name: string): Promise<CapturedFrame> {
  await window.webContents.executeJavaScript(
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  )
  const image = await window.webContents.capturePage()
  const png = image.toPNG()
  if (png.length < 20_000) throw new Error(`desktop UI evidence frame ${name} is unexpectedly empty`)
  const file = `${name}.png`
  writeFileSync(join(framesDir, file), png)
  return {
    file,
    bytes: png.length,
    sha256: createHash('sha256').update(png).digest('hex'),
  }
}

async function submitPrompt(window: BrowserWindow, prompt: string): Promise<void> {
  const encoded = JSON.stringify(prompt)
  await waitFor(window, `(() => {
    const input = document.querySelector('textarea')
    return input instanceof HTMLTextAreaElement && !input.disabled && !input.readOnly
  })()`, 'writable conversation composer')
  const filled = await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('textarea')
    if (!(input instanceof HTMLTextAreaElement)) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(input, ${encoded})
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${encoded} }))
    input.focus()
    return input.value === ${encoded}
  })()`) as unknown
  if (filled !== true) throw new Error('desktop UI evidence could not fill the composer')
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
}

/**
 * Exercise the real Client journey and write seven PNG frames plus `evidence.json`.
 * The journey adopts `pickedDirectory`, consumes replay, deliberately exhausts it
 * to render a terminal error, and persists the sidebar-material setting as false.
 */
export async function captureOfficialUiEvidence(
  window: BrowserWindow,
  framesDir: string,
  pickedDirectory: string,
): Promise<void> {
  mkdirSync(framesDir, { recursive: true })
  const frames: CapturedFrame[] = []
  await waitFor(window, `(() => {
    const graph = globalThis.__DSH_BOOT__
    return typeof graph === 'object' && graph !== null && Array.isArray(graph.entries)
  })()`, 'Client boot manifest')
  const boot = await window.webContents.executeJavaScript(`(() => ({
    ids: globalThis.__DSH_BOOT__.entries.map(row => row.id),
    body: document.body.innerText.slice(0, 500),
  }))()`) as { ids: string[]; body: string }
  const missing = REQUIRED_CLIENT_MODULES.filter(id => !boot.ids.includes(id))
  console.log(`DESKTOP_UI_BOOT ${JSON.stringify({ ids: boot.ids, missing, body: boot.body })}`)
  if (missing.length > 0) throw new Error(`desktop UI boot graph is missing ${missing.join(', ')}`)
  await waitFor(window, `document.querySelector('[class*="frame"]') !== null
    && document.querySelector('textarea') !== null
    && document.querySelector('[data-desktop-window-chrome]') !== null`, 'official Client surface')
  frames.push(await capture(window, framesDir, '01-workspace-picker'))

  const requested = await window.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('[data-composer-card]')
    if (!(card instanceof HTMLElement)) return false
    card.click()
    return true
  })()`) as unknown
  if (requested !== true) throw new Error('desktop UI evidence found no workspace picker trigger')
  await waitFor(window, `(() => {
    const input = document.querySelector('textarea')
    return input instanceof HTMLTextAreaElement && !input.disabled && !input.readOnly
  })()`, 'native workspace adoption')
  const expectedWorkspaceLabel = basename(pickedDirectory)
  const encodedWorkspaceLabel = JSON.stringify(expectedWorkspaceLabel)
  await waitFor(window, `[...document.querySelectorAll('button[aria-haspopup="menu"]')]
    .some(button => button.textContent?.trim() === ${encodedWorkspaceLabel})`, 'picked workspace label')
  frames.push(await capture(window, framesDir, '02-workspace-adopted'))

  const openedCommands = await window.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('[data-composer-card] button[aria-haspopup="listbox"]')
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false
    button.click()
    return true
  })()`) as unknown
  if (openedCommands !== true) throw new Error('desktop UI evidence found no Commands trigger')
  await waitFor(window, 'document.querySelector(\'[role="listbox"]\') !== null', 'input trigger suggestions')
  frames.push(await capture(window, framesDir, '03-input-triggers'))
  await window.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('[data-composer-card] button[aria-haspopup="listbox"]')
    if (button instanceof HTMLButtonElement) button.click()
  })()`)
  await waitFor(window, 'document.querySelector(\'[role="listbox"]\') === null', 'input trigger dismissal')

  await submitPrompt(window, TERMINAL_TRACER_PROMPT)
  await waitFor(window, `document.querySelector('[data-streaming="true"]') !== null
    || document.querySelector('[data-state="running"]') !== null`, 'incremental conversation state')
  frames.push(await capture(window, framesDir, '04-conversation-streaming'))
  await waitFor(window, `(() => {
    const tool = document.querySelector('[data-sample="bash"]')
    return tool?.getAttribute('data-state') === 'ok' && document.body.innerText.includes('DONE')
  })()`, 'streaming conversation and tool completion', 60_000)
  frames.push(await capture(window, framesDir, '05-conversation-complete'))

  await submitPrompt(window, 'Trigger the deterministic replay exhaustion error.')
  await waitFor(window, `[...document.querySelectorAll('[role="status"]')]
    .some(row => row.querySelector('code') !== null)`, 'terminal conversation error', 60_000)
  frames.push(await capture(window, framesDir, '06-conversation-error'))

  const openedSettings = await window.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('button[aria-haspopup="dialog"]')
    if (!(button instanceof HTMLButtonElement)) return false
    button.click()
    return true
  })()`) as unknown
  if (openedSettings !== true) throw new Error('desktop UI evidence found no Settings trigger')
  await waitFor(window, `(() => {
    const dialog = document.querySelector('[role="dialog"]')
    return dialog !== null && dialog.querySelector('.dsh-desktop-glass-row input[type="checkbox"]') !== null
  })()`, 'settings contributions')
  const toggled = await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.dsh-desktop-glass-row input[type="checkbox"]')
    if (!(input instanceof HTMLInputElement) || input.disabled) return false
    if (input.checked) input.click()
    return true
  })()`) as unknown
  if (toggled !== true) throw new Error('desktop UI evidence could not mutate the sidebar setting')
  await waitFor(window, `(() => {
    const input = document.querySelector('.dsh-desktop-glass-row input[type="checkbox"]')
    return input instanceof HTMLInputElement && !input.checked
  })()`, 'durable setting projection')
  frames.push(await capture(window, framesDir, '07-settings'))

  const rendererEvidence = await window.webContents.executeJavaScript(`(() => ({
    graph: globalThis.__DSH_BOOT__.entries.map(row => row.id),
    tool: document.querySelector('[data-sample="bash"]')?.getAttribute('data-state'),
    answer: document.body.innerText.includes('DONE'),
    error: [...document.querySelectorAll('[role="status"]')].some(row => row.querySelector('code') !== null),
    settings: document.querySelector('.dsh-desktop-glass-row input[type="checkbox"]')?.checked,
    desktopChrome: document.querySelector('[data-desktop-window-chrome]') !== null,
  }))()`) as Record<string, unknown>
  const evidence = {
    ...rendererEvidence,
    workspace: true,
    workspacePath: pickedDirectory,
    workspaceLabel: expectedWorkspaceLabel,
    streaming: true,
    frames,
  }
  writeFileSync(join(framesDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(`DESKTOP_UI_EVIDENCE ${JSON.stringify(evidence)}`)
}
