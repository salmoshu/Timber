import { cp, mkdir, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const outputDir = resolve(root, 'sidecar/bin')
const output = resolve(outputDir, 'lsp/typescript-language-server.mjs')
await mkdir(outputDir, { recursive: true })
await build({
  entryPoints: [resolve(root, 'node_modules/typescript-language-server/lib/cli.mjs')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['typescript', 'typescript/*'],
  logLevel: 'warning'
})
await rm(resolve(outputDir, 'node_modules/typescript'), { recursive: true, force: true })
await cp(resolve(root, 'node_modules/typescript'), resolve(outputDir, 'node_modules/typescript'), { recursive: true, dereference: true })
await cp(resolve(root, 'node_modules/typescript-language-server/package.json'), resolve(outputDir, 'package.json'))
const info = await stat(output)
console.log(`TypeScript language server bundled: ${output} (${(info.size / 1024 / 1024).toFixed(1)} MB)`)
