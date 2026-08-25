import fs from 'node:fs'
import path from 'node:path'

/** Reject output outside one real generated-runtime directory. */
export function assertRuntimeOutput(output: string, generatedRoot: string): void {
  if (path.dirname(output) !== generatedRoot) throw new Error(`Refusing to replace unsafe runtime output: ${output}`)
  try {
    if (fs.lstatSync(generatedRoot).isSymbolicLink()) throw new Error(`Refusing to use linked runtime output root: ${generatedRoot}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** Copy an environment without credential-bearing variables. */
export function scrubRuntimeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([name, value]) => value !== undefined && !/(?:KEY|SECRET|TOKEN|PASSWORD)/i.test(name)))
}

/** Remove a generated runtime path without following a symbolic link or junction. */
export function removeRuntimeOutput(output: string): void {
  try {
    if (fs.lstatSync(output).isSymbolicLink()) {
      fs.unlinkSync(output)
      return
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  fs.rmSync(output, { recursive: true, force: true })
}
