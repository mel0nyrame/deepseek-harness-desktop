/** Transport-neutral asset source for the official web shell and composed Client modules. */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { extname, resolve, sep } from 'node:path'
import {
  injectBootManifest,
  type WebBootGraph,
} from '@deepseek-ai/dsh-client-modules'

const packageRequire = createRequire(import.meta.url)
const DESKTOP_UI_CSP = "default-src 'self'; base-uri 'none'; object-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'"

/** Client-module registry surface consumed by the desktop asset carrier. */
export interface ClientModuleAssets {
  graph(): WebBootGraph
  clientPath(id: string): string | undefined
}

/** Serializable response copied from the Host process to Electron's protocol handler. */
export interface DesktopUiAssetResponse {
  readonly status: 200 | 404
  readonly contentType: string
  readonly cacheControl: 'no-cache'
  readonly body: string
}

function contentType(path: string): string {
  if (path.endsWith('.js.map')) return 'application/json; charset=utf-8'
  switch (extname(path)) {
    case '.css': return 'text/css; charset=utf-8'
    case '.html': return 'text/html; charset=utf-8'
    case '.js': return 'text/javascript; charset=utf-8'
    case '.json':
    case '.webmanifest': return 'application/json; charset=utf-8'
    case '.svg': return 'image/svg+xml'
    default: return 'application/octet-stream'
  }
}

function notFound(): DesktopUiAssetResponse {
  return {
    status: 404,
    contentType: 'text/plain; charset=utf-8',
    cacheControl: 'no-cache',
    body: '',
  }
}

function decodeAssetPath(path: string): string | undefined {
  if (!path.startsWith('/') || path.length > 4_096 || path.includes('\0')) return undefined
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return undefined
  }
  if (decoded.split('/').some(segment => segment === '.' || segment === '..')) return undefined
  return decoded
}

/**
 * Read the official frontend and graph-advertised Client bundles without a socket.
 * URL decoding, traversal, unknown ids, missing files, and read failures resolve
 * to a bodyless 404; successful bodies are base64 and always marked `no-cache`.
 */
export class DesktopUiAssets {
  private readonly modules: ClientModuleAssets
  private readonly frontendRoot: string

  constructor(
    modules: ClientModuleAssets,
    frontendRoot = resolve(packageRequire.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html'), '..'),
  ) {
    this.modules = modules
    this.frontendRoot = resolve(frontendRoot)
  }

  /**
   * Resolve one URL pathname into a base64 transport response.
   * Only `/`, the published static allowlist, and advertised plugin Client files
   * are readable; malformed, escaping, missing, or unreadable paths are 404.
   */
  async read(path: string): Promise<DesktopUiAssetResponse> {
    const decoded = decodeAssetPath(path)
    if (decoded === undefined) return notFound()
    if (decoded === '/' || decoded === '/index.html') return this.readIndex()

    const plugin = /^\/plugins\/(.+)\/client\.js(\.map)?$/.exec(decoded)
    if (plugin !== null) {
      const id = plugin[1]
      if (id === undefined) return notFound()
      const bundle = this.modules.clientPath(id)
      if (bundle === undefined) return notFound()
      return this.readFile(`${bundle}${plugin[2] ?? ''}`)
    }

    if (decoded !== '/favicon.svg'
      && decoded !== '/manifest.webmanifest'
      && !decoded.startsWith('/assets/')) return notFound()
    const file = resolve(this.frontendRoot, `.${decoded}`)
    if (!file.startsWith(`${this.frontendRoot}${sep}`)) return notFound()
    return this.readFile(file)
  }

  private async readIndex(): Promise<DesktopUiAssetResponse> {
    try {
      const source = await readFile(resolve(this.frontendRoot, 'index.html'), 'utf8')
      const boot = injectBootManifest(source, this.modules.graph())
      const meta = `<meta http-equiv="Content-Security-Policy" content="${DESKTOP_UI_CSP}">`
      const head = boot.indexOf('<head>')
      const body = head === -1
        ? `${meta}${boot}`
        : `${boot.slice(0, head + 6)}${meta}${boot.slice(head + 6)}`
      return {
        status: 200,
        contentType: contentType('index.html'),
        cacheControl: 'no-cache',
        body: Buffer.from(body).toString('base64'),
      }
    } catch {
      return notFound()
    }
  }

  private async readFile(path: string): Promise<DesktopUiAssetResponse> {
    try {
      const body = await readFile(path)
      return {
        status: 200,
        contentType: contentType(path),
        cacheControl: 'no-cache',
        body: body.toString('base64'),
      }
    } catch {
      return notFound()
    }
  }
}
