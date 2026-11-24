import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
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
const workspaceUrl = await compile(resolve(root, 'src/main/clangd-workspace.ts'), {
  "from '@shared/code'": `from '${sharedUrl}'`
})
const moduleUrl = await compile(resolve(root, 'src/main/code-lsp.ts'), {
  "from '@shared/code'": `from '${sharedUrl}'`,
  "from './clangd-workspace'": `from '${workspaceUrl}'`,
  "from 'vscode-jsonrpc/node.js'": `from '${pathToFileURL(require.resolve('vscode-jsonrpc/node')).href}'`
})
const { CodeLanguageService, absoluteCodePath } = await import(moduleUrl)
const { buildLanguageForPath, codeLanguageForPath } = await import(sharedUrl)
const fixture = resolve(root, 'tmp', `code-lsp-test-${process.pid}`)
const cli = resolve(root, 'sidecar/bin/lsp/typescript-language-server.mjs')
const clangd = process.env.TIMBER_CLANGD_PATH || (process.platform === 'linux'
  ? 'clangd'
  : resolve(root, 'sidecar/bin/clangd/bin', process.platform === 'win32' ? 'clangd.exe' : 'clangd'))
const aSource = 'export interface User { name: string }\nexport function greet(user: User): string { return `Hello ${user.name}` }\n'
const bSource = "import { greet } from './a'\nconst message = greet({ name: 'Timber' })\nconsole.log(message)\n"
const document = (path, content) => ({ rootPath: fixture, path, languageId: 'typescript', content })
const a = document('a.ts', aSource)
const b = document('b.ts', bSource)
const createService = () => new CodeLanguageService({ typescriptPath: cli, clangdPath: clangd })

async function eventually(task) {
  let lastError
  for (let attempt = 0; attempt < 50; attempt++) {
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

test('clangd reads build/compile_commands.json and distinguishes C++ overloads and namespaces', { timeout: 40_000 }, async () => {
  const cppFixture = resolve(root, 'tmp', `clangd C++ 示例 ${process.pid}`)
  const files = {
    'include/api.hpp': '#pragma once\nnamespace api {\nint calculate(int);\ndouble calculate(double);\n}\nnamespace other { int calculate(int); }\n',
    'src/api.cpp': '#include <api.hpp>\nnamespace api {\nint calculate(int a) { return a + 1; }\ndouble calculate(double a) { return a * 2; }\n}\nnamespace other { int calculate(int a) { return -a; } }\n',
    'src/main.cpp': '#include <api.hpp>\n#if TIMBER_USE_INT\nint run() { /* 中文🙂 */ return api::calculate(1); }\n#else\ndouble run() { return api::calculate(1.0); }\n#endif\n',
    'src/clients.cpp': '#include <api.hpp>\nint useApi() { return api::calculate(3); }\nint useOther() { return other::calculate(3); }\ndouble useDouble() { return api::calculate(3.0); }\n'
  }
  const main = { rootPath: cppFixture, path: 'src/main.cpp', languageId: 'cpp', content: files['src/main.cpp'] }
  const position = { line: 2, character: main.content.split('\n')[2].indexOf('calculate') + 2 }
  const service = createService()
  try {
    await Promise.all(['src', 'include', 'build'].map((dir) => mkdir(resolve(cppFixture, dir), { recursive: true })))
    await Promise.all(Object.entries(files).map(([path, content]) => writeFile(resolve(cppFixture, path), content)))
    const buildDir = resolve(cppFixture, 'build')
    const commands = Object.keys(files).filter((path) => path.endsWith('.cpp')).map((path) => {
      const file = resolve(cppFixture, path)
      return { directory: buildDir, file, arguments: ['clang++', '-I', resolve(cppFixture, 'include'), '-DTIMBER_USE_INT=1', '-c', file] }
    })
    await writeFile(resolve(buildDir, 'compile_commands.json'), JSON.stringify(commands))
    // Only the caller is open initially. Cross-file results must come from clangd's background index.
    await service.syncDocument(main)
    const definition = await eventually(async () => {
      const result = await service.definition(main, position)
      return result.some((item) => item.path === 'src/api.cpp') ? result : null
    })
    assert.deepEqual(definition.map((item) => [item.path, item.range.start.line]), [['src/api.cpp', 2]])
    assert.match(definition[0].preview, /^int calculate\(int a\)/)
    const references = await eventually(async () => {
      const result = await service.references(main, position)
      return result.some((item) => item.path === 'src/clients.cpp') ? result : null
    })
    assert.deepEqual(references.filter((item) => item.path === 'src/clients.cpp').map((item) => item.range.start.line), [1])
    assert.ok(references.some((item) => item.path === main.path && item.range.start.line === 2 && item.range.start.character === position.character - 2))
    assert.ok(references.filter((item) => item.path === 'src/api.cpp').every((item) => item.range.start.line === 2))
    const hover = await service.hover(main, position)
    assert.match(hover?.contents.join('\n') ?? '', /int calculate\(int/)
    const header = { rootPath: cppFixture, path: 'include/api.hpp', languageId: 'cpp' }
    const symbols = await service.documentSymbols(header)
    const namespace = symbols.find((item) => item.name === 'api')
    assert.ok(namespace?.children.some((item) => item.name === 'calculate' && item.path === header.path))
    const workspace = await service.workspaceSymbols(cppFixture, 'calculate', 'cpp')
    assert.ok(workspace.some((item) => item.path === 'src/api.cpp' && item.name === 'calculate'))
  } finally {
    await service.dispose()
    await rm(cppFixture, { recursive: true, force: true })
  }
})

test('clangd indexes a CMake project without a database and switches between source and header', { timeout: 40_000 }, async () => {
  const cFixture = resolve(root, 'tmp', `clangd-c-test-${process.pid}`)
  const files = {
    'counter.h': '#pragma once\nint count_items(int limit);\n',
    'counter.c': '#include "counter.h"\nint count_items(int limit) { return limit; }\n',
    'main.c': '#include "counter.h"\nint main(void) { return count_items(5); }\n',
    'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.20)\nproject(sample C)\nadd_executable(sample counter.c main.c)\n'
  }
  const main = { rootPath: cFixture, path: 'main.c', languageId: 'c', content: files['main.c'] }
  const service = createService()
  try {
    await mkdir(cFixture, { recursive: true })
    await Promise.all(Object.entries(files).map(([path, content]) => writeFile(resolve(cFixture, path), content)))
    await service.syncDocument(main)
    const position = { line: 1, character: 26 }
    const definition = await eventually(async () => (await service.definition(main, position)).find((item) => item.path === 'counter.c'))
    assert.equal(definition.range.start.line, 1)
    const references = await service.references(main, position)
    assert.ok(references.some((item) => item.path === 'counter.h'))
    assert.ok(references.some((item) => item.path === 'counter.c'))
    const header = await service.switchSourceHeader({ rootPath: cFixture, path: 'counter.c', languageId: 'c' })
    assert.equal(header?.path, 'counter.h')
    assert.deepEqual((await readdir(cFixture)).sort(), Object.keys(files).sort())
  } finally {
    await service.dispose()
    await rm(cFixture, { recursive: true, force: true })
  }
})

test('C-family source and build files use their expected editors', () => {
  assert.equal(codeLanguageForPath('src/CORE.C'), 'cpp')
  assert.equal(codeLanguageForPath('src/core.CPPM'), 'cpp')
  assert.equal(codeLanguageForPath('src/core.mm'), 'objective-cpp')
  assert.equal(buildLanguageForPath('src\\CMakeLists.txt'), 'cmake')
  assert.equal(buildLanguageForPath('src/GNUmakefile'), 'makefile')
  assert.equal(buildLanguageForPath('native.vcxproj'), 'xml')
})

test('clangd can start again after an executable launch failure', { timeout: 40_000 }, async () => {
  const retryFixture = resolve(root, 'tmp', `clangd-retry-${process.pid}`)
  const source = 'int boot(void) { return 1; }\n'
  const input = { rootPath: retryFixture, path: 'main.c', languageId: 'c', content: source }
  const options = { clangdPath: resolve(retryFixture, 'missing-clangd.exe') }
  const service = new CodeLanguageService(options)
  try {
    await mkdir(retryFixture, { recursive: true })
    await writeFile(resolve(retryFixture, 'main.c'), source)
    await assert.rejects(service.syncDocument(input))
    options.clangdPath = clangd
    await service.syncDocument(input)
    const symbols = await service.documentSymbols(input)
    assert.ok(symbols.some((item) => item.name === 'boot'))
  } finally {
    await service.dispose()
    await rm(retryFixture, { recursive: true, force: true })
  }
})

test('TypeScript LSP resolves cross-file navigation and symbols', { timeout: 40_000 }, async () => {
  const service = createService()
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
