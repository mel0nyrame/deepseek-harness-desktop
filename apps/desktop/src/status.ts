/**
 * The user-visible Host lifecycle surface: a single status page served at
 * `dsh://app/status.html` while the Host is starting, recovering, failed, or
 * stopping. Electron main pushes typed state into `window.renderStatus`; the
 * page's only privileged action is the narrow `window.dshRecovery` bridge the
 * preload exposes exclusively on this page. Electron-free module: main.ts
 * serves the HTML string, and unit tests assert the state mapping.
 */

import type { HostFailure, HostPhase } from './lifecycle.ts'

export const STATUS_PAGE_PATH = '/status.html'
export const STATUS_PAGE_URL = `dsh://app${STATUS_PAGE_PATH}`

/** State rendered by the status page's `window.renderStatus`. */
export interface DesktopStatusState {
  readonly phase: Exclude<HostPhase, 'running' | 'stopped'>
  readonly title: string
  readonly message: string
  readonly detail?: string
  /** Whether the page offers the Restart action. */
  readonly restartable: boolean
}

/** Map a lifecycle phase and failure onto the page state. */
export function statusStateFor(
  phase: HostPhase,
  failure?: HostFailure,
  restartAvailable = failure?.kind !== 'cleanup-incomplete',
): DesktopStatusState {
  switch (phase) {
    case 'starting':
      return { phase, title: 'DeepSeek Harness', message: 'Starting the bundled DSH runtime…', restartable: false }
    case 'recovering':
      return {
        phase,
        title: 'DeepSeek Harness',
        message: 'The DSH runtime stopped unexpectedly. Restarting it now…',
        ...(failure?.detail === undefined ? {} : { detail: failure.detail }),
        restartable: false,
      }
    case 'failed': {
      const detail = formatDetail(failure)
      return {
        phase,
        title: failure?.kind === 'startup-timeout'
          ? 'The DSH runtime did not start'
          : failure?.kind === 'startup-failed'
            ? 'The DSH runtime could not start'
            : 'The DSH runtime stopped',
        message: failure?.message ?? 'The DSH runtime failed.',
        ...(detail === undefined ? {} : { detail }),
        restartable: restartAvailable,
      }
    }
    case 'stopping':
      return { phase, title: 'DeepSeek Harness', message: 'Quitting — waiting for the DSH runtime to shut down…', restartable: false }
    case 'running':
    case 'stopped':
      throw new Error(`desktop status: phase ${phase} has no status page state`)
  }
}

function formatDetail(failure: HostFailure | undefined): string | undefined {
  if (failure === undefined) return undefined
  const survivors = failure.survivors === undefined || failure.survivors.length === 0
    ? ''
    : `\nSurviving processes:\n${failure.survivors.map(survivor => `  pid ${String(survivor.pid)}: ${survivor.command}`).join('\n')}`
  return `${failure.detail ?? ''}${survivors}`.trim() || undefined
}

/** The status page: system-appearance aware, no remote resources, no secrets. */
export const DESKTOP_STATUS_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>DeepSeek Harness</title>
<style>
  :root { color-scheme: light dark; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #f9fafb; color: #111827;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1115; color: #e5e7eb; }
  }
  main { max-width: 34rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.35rem; font-weight: 600; margin: 0 0 1rem; }
  p { font-size: 1rem; line-height: 1.5; }
  pre {
    text-align: left; white-space: pre-wrap; overflow-wrap: anywhere;
    max-height: 12rem; overflow: auto; font-size: 0.8rem; line-height: 1.4;
    padding: 0.75rem; border-radius: 0.5rem;
    background: rgba(127, 127, 127, 0.12);
  }
  #actions { margin-top: 1.5rem; }
  button {
    font: inherit; padding: 0.5rem 1.25rem; margin: 0 0.35rem;
    border-radius: 0.5rem; border: 1px solid rgba(127, 127, 127, 0.4);
    background: transparent; color: inherit; cursor: pointer;
  }
  button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
</style>
</head>
<body>
<main role="status">
  <h1 id="title">DeepSeek Harness</h1>
  <p id="message"></p>
  <pre id="detail" hidden></pre>
  <div id="actions" hidden>
    <button id="restart" type="button">Restart</button>
    <button id="quit" type="button">Quit</button>
  </div>
</main>
<script>
  window.renderStatus = (state) => {
    document.getElementById('title').textContent = state.title;
    document.getElementById('message').textContent = state.message;
    const detail = document.getElementById('detail');
    if (state.detail) { detail.textContent = state.detail; detail.hidden = false; }
    else { detail.hidden = true; detail.textContent = ''; }
    document.getElementById('actions').hidden = !state.restartable;
  };
  document.getElementById('restart').addEventListener('click', () => {
    if (typeof window.dshRecovery === 'function') window.dshRecovery('restart');
  });
  document.getElementById('quit').addEventListener('click', () => {
    if (typeof window.dshRecovery === 'function') window.dshRecovery('quit');
  });
</script>
</body>
</html>
`
