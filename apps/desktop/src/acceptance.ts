/**
 * Acceptance-driver helpers shared by the native-window journeys. Electron-free
 * by design: unit tests exercise the discovery logic over a stubbed supervisor
 * without importing Electron primitives.
 */

import type { DshSupervisor } from './supervisor.ts'

/** One unary desktop-protocol request over the supervisor bridge. */
export async function desktopRpc(
  supervisor: DshSupervisor,
  id: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await supervisor.request({
    type: 'request',
    id,
    url: `dsh://app/api/${method}`,
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: JSON.stringify({ type: 'client-request', rpcId: id, method, payload }),
  })
  if (response.status !== 200) throw new Error(`desktop ${method} returned status ${String(response.status)}`)
  const parsed = JSON.parse(response.body) as {
    type: string
    result: { ok: true; value: unknown } | { ok: false; error: unknown }
  }
  if (parsed.type !== 'server-response' || !parsed.result.ok) {
    throw new Error(`desktop ${method} failed: ${JSON.stringify(parsed)}`)
  }
  return parsed.result.value as Record<string, unknown>
}

/**
 * Discover the exactly-one session the real pick journey opened for the
 * acceptance workspace. The hero picker's `connectWorkspace` mints the
 * session when its reuse scan finds none, and the live composer only renders
 * once that minted session is open — so by the time this runs the workspace
 * must list exactly one session. Poll briefly because the mint's workspace
 * membership write can land just after the create response the client
 * consumed; more than one session means a second path minted, which fails
 * loudly instead of guessing.
 * @param supervisor - the DSH child bridge.
 * @param workspaceId - the acceptance workspace adopted before the reload.
 * @returns the session id the real user journey opened.
 */
export async function discoverAcceptanceSession(
  supervisor: DshSupervisor,
  workspaceId: string,
): Promise<string> {
  const deadline = Date.now() + 10_000
  for (let attempt = 0; ; attempt += 1) {
    const listed = await desktopRpc(supervisor, `accept-workspaces-${String(attempt)}`, 'workspace.list', {})
    const itemsValue: unknown = listed['items']
    if (!Array.isArray(itemsValue)) throw new Error('desktop acceptance: workspace.list returned no items')
    let listedSessionIds: unknown
    let workspaceFound = false
    for (const item of itemsValue as unknown[]) {
      if (typeof item !== 'object' || item === null) continue
      const view = item as { workspaceId?: unknown; sessionIds?: unknown }
      if (view.workspaceId !== workspaceId) continue
      workspaceFound = true
      listedSessionIds = view.sessionIds
      break
    }
    if (!workspaceFound) {
      throw new Error(`desktop acceptance: workspace.list omits the acceptance workspace ${workspaceId}`)
    }
    if (!Array.isArray(listedSessionIds)) {
      throw new Error('desktop acceptance: the acceptance workspace lists no session ids')
    }
    const sessionIds: unknown[] = listedSessionIds
    if (sessionIds.some(id => typeof id !== 'string')) {
      throw new Error('desktop acceptance: the acceptance workspace lists a non-string session id')
    }
    if (sessionIds.length > 1) {
      throw new Error(
        `desktop acceptance: expected the pick journey to open exactly one session, found ${String(sessionIds.length)}`,
      )
    }
    if (sessionIds.length === 1) return sessionIds[0] as string
    if (Date.now() > deadline) {
      throw new Error('desktop acceptance: the pick journey opened no session in the acceptance workspace')
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
}
