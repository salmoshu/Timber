import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..')
const compile = async (path, replacements = {}) => {
  let source = await readFile(path, 'utf8')
  for (const [from, to] of Object.entries(replacements)) source = source.replaceAll(from, to)
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  return 'data:text/javascript;base64,' + Buffer.from(output).toString('base64')
}
const sharedUrl = await compile(resolve(root, 'src/shared/code.ts'))
const moduleUrl = await compile(resolve(root, 'src/main/code-lsp.ts'), {
  "from '@shared/code'": `from '${sharedUrl}'`,
  "from 'vscode-jsonrpc/node.js'": `from '${pathToFileURL(require.resolve('vscode-jsonrpc/node')).href}'`
})
const { CodeLanguageService, absoluteCodePath } = await import(moduleUrl)
const fixture = resolve(root, 'tmp', `code-lsp-test-${process.pid}`)
const cli = resolve(root, 'sidecar/bin/lsp/typescript-language-server.mjs')
const aSource = 'export interface User { name: string }\nexport function greet(user: User): string { return `Hello ${user.name}` }\n'
const bSource = "import { greet } from './a'\nconst message = greet({ name: 'Timber' })\nconsole.log(message)\n"
const document = (path, content) => ({ rootPath: fixture, path, languageId: 'typescript', content })
const a = document('a.ts', aSource)
const b = document('b.ts', bSource)
const service = new CodeLanguageService(cli)

async function eventually(task) {
  let lastError
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const result = await task()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
  }
  throw lastError ?? new Error('Language service did not become ready')
}

test('TypeScript LSP resolves cross-file navigation and symbols', { timeout: 40_000 }, async () => {
  try {
    await mkdir(fixture, { recursive: true })
    await writeFile(resolve(fixture, 'a.ts'), aSource)
    await writeFile(resolve(fixture, 'b.ts'), bSource)
    await writeFile(resolve(fixture, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, moduleResolution: 'node' } }))
    await service.syncDocument(a)
    await service.syncDocument(b)
    const definition = await eventually(async () => {
      const result = await service.definition(b, { line: 1, character: 18 })
      return result.some((item) => item.path === 'a.ts' && item.range.start.line === 1) ? result : null
    })
    assert.ok(definition[0].preview.includes('greet'))
    const references = await service.references(b, { line: 1, character: 18 })
    assert.ok(references.some((item) => item.path === 'a.ts'))
    assert.ok(references.some((item) => item.path === 'b.ts'))
    const hover = await service.hover(b, { line: 1, character: 18 })
    assert.ok(hover?.contents.some((item) => item.includes('greet')))
    const symbols = await service.documentSymbols(a)
    assert.ok(symbols.some((item) => item.name === 'greet'))
    const workspace = await service.workspaceSymbols(fixture, 'greet')
    assert.ok(workspace.some((item) => item.path === 'a.ts' && item.name === 'greet'))
    assert.throws(() => absoluteCodePath(fixture, '../outside.ts'), /超出项目目录/)
    console.log(JSON.stringify({ definitions: definition.length, references: references.length, symbols: symbols.length, workspaceSymbols: workspace.length }))
  } finally {
    await service.dispose()
    await rm(fixture, { recursive: true, force: true })
  }
})
