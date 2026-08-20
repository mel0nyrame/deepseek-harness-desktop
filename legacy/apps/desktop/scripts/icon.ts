/**
 * Regenerate the application icon PNG from the committed SVG source.
 *
 * `build/icon.svg` carries the official DeepSeek Harness fish logo (the
 * FishLogo geometry, extracted from packages/client/ui-primitives) on a
 * light rounded tile. This script rasterizes it to the 1024x1024 PNG that
 * electron-builder consumes and converts into the bundle's icon.icns
 * (mac.icon in electron-builder.yml points at the PNG; sharp keeps the
 * render deterministic across machines).
 */

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(scriptDir, '..')
const svgPath = join(packageDir, 'build', 'icon.svg')
const pngPath = join(packageDir, 'build', 'icon.png')

const svg = await readFile(svgPath)
// The SVG is authored at 1024x1024; density 72 keeps the 1:1 raster size.
await sharp(svg, { density: 72 }).resize(1024, 1024).png().toFile(pngPath)
console.log('dsh-desktop icon: wrote ' + pngPath + ' from ' + svgPath)
