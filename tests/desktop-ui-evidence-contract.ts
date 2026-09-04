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
  '09-sidebar-collapsed.png',
  '10-sidebar-narrow-reopened.png',
  '11-sidebar-fullscreen.png',
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
    readonly brand: {
      readonly present: boolean
      readonly accessibleName: string | null
      readonly text: string
      readonly graphic: boolean
    }
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
    readonly initialWorkArea: { readonly width: number; readonly height: number }
    readonly window: { readonly width: number; readonly height: number }
    readonly viewport: { readonly width: number; readonly height: number }
    readonly sidebar: ResolvedRect | null
    readonly chrome: ResolvedRect | null
    readonly brand: ResolvedRect | null
    readonly panelControl: ResolvedRect | null
  }
  readonly visualContract: {
    readonly expectedInitialSize: { readonly width: number; readonly height: number }
    readonly windowSizing: {
      readonly actual: { readonly width: number; readonly height: number }
      readonly constrainedByWorkArea: boolean
      readonly reason: 'display-work-area' | null
    }
    readonly mismatches: string[]
  }
  readonly responsive: {
    readonly expanded: ResponsiveLayoutState
    readonly collapsed: ResponsiveLayoutState
    readonly narrowCollapsed: ResponsiveLayoutState
    readonly narrowReopened: ResponsiveLayoutState
    readonly resizedExpanded: ResponsiveLayoutState
    readonly fullscreenCollapsed: ResponsiveLayoutState
  }
  readonly frames: Array<{ readonly file: string; readonly bytes: number; readonly sha256: string }>
}

interface ResponsiveLayoutState {
  readonly window: { readonly width: number; readonly height: number }
  readonly fullscreen: boolean
  readonly collapsed: boolean
  readonly sidebarWidth: number
  readonly declaredSidebarWidth: number
  readonly control: 'collapse' | 'reveal'
  readonly controlLeft: number
  readonly headerPaddingLeft: number
  readonly tabsLeft: number | null
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
      brand: {
        present: true,
        accessibleName: 'deepseek HARNESS',
        text: '',
        graphic: true,
      },
      panelControl: {
        present: true,
        accessibleName: 'Collapse sidebar',
        text: '',
        graphic: true,
      },
      chromeRows: { separate: true },
    },
    geometry: {
      initialWindow: { width: 1280, height: expect.any(Number) },
      initialWorkArea: { width: expect.any(Number), height: expect.any(Number) },
      window: { width: 1280, height: expect.any(Number) },
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
      windowSizing: {
        actual: { width: 1280, height: expect.any(Number) },
        constrainedByWorkArea: expect.any(Boolean),
      },
      mismatches: [],
    },
    responsive: {
      expanded: {
        window: { width: 1280, height: expect.any(Number) }, fullscreen: false, collapsed: false,
        sidebarWidth: expect.any(Number), declaredSidebarWidth: expect.any(Number),
        control: 'collapse', controlLeft: 84,
        headerPaddingLeft: 20, tabsLeft: expect.any(Number),
      },
      collapsed: {
        window: { width: 1280, height: expect.any(Number) }, fullscreen: false, collapsed: true,
        sidebarWidth: 0, declaredSidebarWidth: 0, control: 'reveal', controlLeft: 84,
        headerPaddingLeft: 120, tabsLeft: expect.any(Number),
      },
      narrowCollapsed: {
        window: { width: 900, height: 640 }, fullscreen: false, collapsed: true,
        sidebarWidth: 0, declaredSidebarWidth: 0, control: 'reveal', controlLeft: 84,
        headerPaddingLeft: 120, tabsLeft: expect.any(Number),
      },
      narrowReopened: {
        window: { width: 900, height: 640 }, fullscreen: false, collapsed: false,
        sidebarWidth: expect.any(Number), declaredSidebarWidth: expect.any(Number),
        control: 'collapse', controlLeft: 84,
        headerPaddingLeft: 20, tabsLeft: expect.any(Number),
      },
      resizedExpanded: {
        window: { width: 1280, height: expect.any(Number) }, fullscreen: false, collapsed: false,
        sidebarWidth: expect.any(Number), declaredSidebarWidth: expect.any(Number),
        control: 'collapse', controlLeft: 84,
        headerPaddingLeft: 20, tabsLeft: expect.any(Number),
      },
      fullscreenCollapsed: {
        window: { width: expect.any(Number), height: expect.any(Number) },
        fullscreen: true, collapsed: true, sidebarWidth: 0, declaredSidebarWidth: 0,
        control: 'reveal', controlLeft: 12,
        headerPaddingLeft: 48, tabsLeft: expect.any(Number),
      },
    },
  })
  expect(evidence.responsive.expanded.sidebarWidth).toBeGreaterThanOrEqual(264)
  expect(evidence.responsive.narrowReopened.sidebarWidth).toBeGreaterThanOrEqual(264)
  expect(evidence.responsive.resizedExpanded.sidebarWidth).toBeGreaterThanOrEqual(264)
  expect(evidence.responsive.collapsed.tabsLeft ?? -1).toBeGreaterThanOrEqual(120)
  expect(evidence.responsive.narrowCollapsed.tabsLeft ?? -1).toBeGreaterThanOrEqual(120)
  expect(evidence.responsive.fullscreenCollapsed.tabsLeft ?? -1).toBeGreaterThanOrEqual(48)
  for (const state of Object.values(evidence.responsive)) {
    expect(state.sidebarWidth).toBe(state.declaredSidebarWidth)
  }
  const requested = evidence.visualContract.expectedInitialSize
  const actual = evidence.visualContract.windowSizing.actual
  const workArea = evidence.geometry.initialWorkArea
  if (actual.width === requested.width && actual.height === requested.height) {
    expect(evidence.visualContract.windowSizing).toMatchObject({
      constrainedByWorkArea: false,
      reason: null,
    })
  } else {
    expect(evidence.visualContract.windowSizing).toMatchObject({
      constrainedByWorkArea: true,
      reason: 'display-work-area',
    })
    expect(actual).toEqual({
      width: Math.min(requested.width, workArea.width),
      height: Math.min(requested.height, workArea.height),
    })
  }
  expect(evidence.geometry.initialWindow).toEqual(actual)
  expect(evidence.geometry.window).toEqual(actual)
  expect(evidence.responsive.expanded.window).toEqual(actual)
  expect(evidence.responsive.collapsed.window).toEqual(actual)
  expect(evidence.responsive.resizedExpanded.window.width)
    .toBe(Math.min(requested.width, workArea.width))
  expect(evidence.responsive.resizedExpanded.window.height)
    .toBeGreaterThanOrEqual(Math.min(640, workArea.height))
  expect(evidence.responsive.resizedExpanded.window.height)
    .toBeLessThanOrEqual(Math.min(requested.height, workArea.height))
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
