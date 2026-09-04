import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'vitest'

export const VISUAL_SESSION_IDS = [
  'visual-review-desktop-experience',
  'visual-polish-readme-preview',
  'visual-refine-native-window-chrome',
] as const

export const VISUAL_SESSION_TITLES = [
  'Review desktop experience',
  'Polish the README preview',
  'Refine native window chrome',
] as const

export const VISUAL_EVIDENCE_FILES = [
  '01-workspace-picker.png',
  '02-workspace-adopted.png',
  '03-input-triggers.png',
  '04-visual-reference.png',
  '05-conversation-streaming.png',
  '06-conversation-complete.png',
  '07-conversation-error.png',
  '08-settings.png',
] as const

interface ResolvedRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface UiEvidence {
  readonly graph: string[]
  readonly workspace: boolean
  readonly streaming: boolean
  readonly workspacePath: string
  readonly workspaceLabel: string
  readonly tool: string
  readonly answer: boolean
  readonly error: boolean
  readonly settings: boolean
  readonly desktopChrome: boolean
  readonly deterministic: {
    readonly locale: string
    readonly appearance: string
    readonly zoomFactor: number
    readonly sessionIds: string[]
    readonly sessionOrder: string[]
    readonly sessions: Array<{
      readonly sessionId: string
      readonly title: string
      readonly blank: boolean
      readonly replayMarker: string
    }>
    readonly replayComplete: boolean
    readonly animationsRunning: number
    readonly compositorFrames: number
    readonly relativeTime: { readonly asserted: boolean; readonly excludedFromImages: boolean }
  }
  readonly semantics: {
    readonly brand: { readonly present: boolean; readonly text: string; readonly graphic: boolean }
    readonly panelControl: {
      readonly present: boolean
      readonly accessibleName: string | null
      readonly text: string
      readonly graphic: boolean
    }
    readonly chromeRows: { readonly separate: boolean }
  }
  readonly geometry: {
    readonly initialWindow: { readonly width: number; readonly height: number }
    readonly window: { readonly width: number; readonly height: number }
    readonly viewport: { readonly width: number; readonly height: number }
    readonly sidebar: ResolvedRect | null
    readonly chrome: ResolvedRect | null
    readonly brand: ResolvedRect | null
    readonly panelControl: ResolvedRect | null
  }
  readonly visualContract: {
    readonly expectedInitialSize: { readonly width: number; readonly height: number }
    readonly mismatches: string[]
  }
  readonly frames: Array<{ readonly file: string; readonly bytes: number; readonly sha256: string }>
}

/** Assert the shared source and installed-product visual-evidence contract. */
export function assertOfficialUiEvidence(
  evidence: UiEvidence,
  framesDirectory: string,
  workspacePath: string,
): Buffer[] {
  expect(evidence).toMatchObject({
    workspace: true,
    streaming: true,
    workspacePath,
    workspaceLabel: 'deepseek-harness',
    tool: 'ok',
    answer: true,
    error: true,
    settings: false,
    desktopChrome: true,
    deterministic: {
      locale: 'en',
      appearance: 'light',
      zoomFactor: 1,
      sessionIds: [...VISUAL_SESSION_IDS],
      sessionOrder: [...VISUAL_SESSION_TITLES],
      sessions: [
        {
          sessionId: VISUAL_SESSION_IDS[0],
          title: VISUAL_SESSION_TITLES[0],
          blank: false,
          replayMarker: 'VISUAL_REPLAY_THREE',
        },
        {
          sessionId: VISUAL_SESSION_IDS[1],
          title: VISUAL_SESSION_TITLES[1],
          blank: false,
          replayMarker: 'VISUAL_REPLAY_TWO',
        },
        {
          sessionId: VISUAL_SESSION_IDS[2],
          title: VISUAL_SESSION_TITLES[2],
          blank: false,
          replayMarker: 'VISUAL_REPLAY_ONE',
        },
      ],
      replayComplete: true,
      animationsRunning: 0,
      compositorFrames: 2,
      relativeTime: { asserted: true, excludedFromImages: true },
    },
    semantics: {
      brand: { present: true, text: 'DeepSeek', graphic: false },
      panelControl: {
        present: true,
        accessibleName: 'Collapse sidebar',
        text: '‹',
        graphic: false,
      },
      chromeRows: { separate: false },
    },
    geometry: {
      initialWindow: { width: 900, height: 640 },
      window: { width: 900, height: 640 },
      viewport: { width: expect.any(Number), height: expect.any(Number) },
      sidebar: { x: 0, y: 0, width: expect.any(Number), height: expect.any(Number) },
      chrome: { x: expect.any(Number), y: expect.any(Number), width: expect.any(Number), height: expect.any(Number) },
      brand: { x: expect.any(Number), y: expect.any(Number), width: expect.any(Number), height: expect.any(Number) },
      panelControl: {
        x: expect.any(Number),
        y: expect.any(Number),
        width: expect.any(Number),
        height: expect.any(Number),
      },
    },
    visualContract: {
      expectedInitialSize: { width: 1280, height: 840 },
      mismatches: [
        'brand.identity',
        'sidebar.panel-control',
        'sidebar.chrome-rows',
        'window.initial-size',
      ],
    },
  })
  const images = VISUAL_EVIDENCE_FILES.map(file => readFileSync(join(framesDirectory, file)))
  expect(images.every(image => image.subarray(0, 8).toString('hex') === '89504e470d0a1a0a')).toBe(true)
  expect(images.every(image => image.byteLength > 20_000)).toBe(true)
  expect(new Set(images.map(image => image.toString('base64'))).size).toBe(VISUAL_EVIDENCE_FILES.length)
  expect(evidence.frames).toEqual(VISUAL_EVIDENCE_FILES.map((file, index) => ({
    file,
    bytes: images[index]?.byteLength,
    sha256: createHash('sha256').update(images[index] as Buffer).digest('hex'),
  })))
  return images
}
