/**
 * macOS release-artifact evidence: the signature, image-integrity, and
 * Gatekeeper checks a produced desktop artifact must pass before the
 * packaging pipeline reports success. A side-effect-free module so the
 * unit suite can verify the command contract without running the packaging
 * pipeline.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** The electron-builder identity that opts into credential-free ad-hoc signing. */
export const AD_HOC_IDENTITY = '-'

/** One release-artifact check for a produced macOS artifact. */
export interface SignEvidenceStep {
  readonly label: string
  readonly command: string
  readonly args: readonly string[]
  /** Hard gate, or recorded evidence only. */
  readonly required: boolean
}

/**
 * The release-artifact checks for one produced artifact. "codesign
 * --verify" proves the signature and "hdiutil verify" the image: those
 * hold as gates for every signing tier. "spctl --assess" records the
 * Gatekeeper verdict: modern macOS rejects every ad-hoc signature
 * outright — even an unquarantined local build — so the verdict becomes a
 * hard gate only once Developer ID signing lands and a downloaded copy
 * must open without the unidentified-developer gate.
 */
/**
 * Whether the Gatekeeper verdict is a hard gate for the configured signing
 * identity: spctl rejects ad-hoc (and unsigned) artifacts on modern macOS, so
 * their verdict is recorded evidence, while a named Developer ID identity
 * enforces it.
 */
export function gatekeeperIsHardGate(identity: string | null | undefined): boolean {
  return identity !== undefined && identity !== null && identity !== AD_HOC_IDENTITY
}

export function signEvidenceSteps(artifact: string, enforceGatekeeper: boolean): SignEvidenceStep[] {
  if (artifact.endsWith('.dmg')) {
    return [
      { label: 'dmg integrity', command: 'hdiutil', args: ['verify', artifact], required: true },
      { label: 'dmg gatekeeper assessment', command: 'spctl', args: ['--assess', '--type', 'open', '--verbose=4', artifact], required: enforceGatekeeper },
    ]
  }
  return [
    { label: 'signature verification', command: 'codesign', args: ['--verify', '--deep', '--strict', '--verbose=2', artifact], required: true },
    { label: 'signature identity', command: 'codesign', args: ['-d', '--verbose=2', artifact], required: false },
    { label: 'gatekeeper assessment', command: 'spctl', args: ['--assess', '--type', 'execute', '--verbose=4', artifact], required: enforceGatekeeper },
  ]
}

/**
 * Classify electron-builder output entries into produced artifacts: ".app"
 * bundles below a "mac"-prefixed directory and ".dmg" images beside it.
 * The dir target's output directory carries an architecture suffix on
 * non-x64 hosts, so the bundle is discovered rather than named.
 */
export function discoverArtifacts(entries: readonly string[], outDir: string): string[] {
  const artifacts: string[] = []
  for (const entry of entries) {
    if (entry.startsWith('mac')) {
      const candidate = join(outDir, entry, 'DSH Desktop.app')
      if (existsSync(candidate)) artifacts.push(candidate)
    } else if (entry.endsWith('.dmg')) {
      artifacts.push(join(outDir, entry))
    }
  }
  return artifacts
}
