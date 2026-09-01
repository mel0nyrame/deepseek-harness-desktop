import path from 'node:path'
import { pathToFileURL } from 'node:url'

const main = path.join(process.resourcesPath, 'runtime', 'lib', 'main.js')
await import(pathToFileURL(main).href)
