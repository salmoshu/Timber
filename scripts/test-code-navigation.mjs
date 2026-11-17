import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const compile = (source) => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText).toString('base64')
const storeUrl = compile('export const useStore = { getState: () => globalThis.__codeNavigationStore }')
const source = await readFile(resolve(root, 'src/renderer/src/code/navigation.ts'), 'utf8')
const navigationUrl = compile(source.replace("from '../store'", `from '${storeUrl}'`))
const navigation = await import(navigationUrl)
const { openCodeLocation, setActiveCodeLocation, consumePendingCodeLocation, navigateCodeHistory, resetCodeNavigation } = navigation
const point = (path, line = 1) => ({ projectId: 'project', path, range: { start: { line, character: 2 }, end: { line, character: 2 } } })

test('code navigation preserves back/forward history and pending locations', async () => {
  const opened = []
  globalThis.__codeNavigationStore = { openTab: async (path) => { opened.push(path) } }
  globalThis.window = { dispatchEvent: () => true }
  resetCodeNavigation()
  const a = point('a.ts', 2)
  const b = point('b.ts', 4)
  const c = point('c.ts', 6)
  await openCodeLocation(a)
  assert.equal(consumePendingCodeLocation('project', 'a.ts'), a)
  assert.equal(consumePendingCodeLocation('project', 'a.ts'), null)
  setActiveCodeLocation(a)
  await openCodeLocation(b)
  setActiveCodeLocation(b)
  await openCodeLocation(c)
  setActiveCodeLocation(c)
  assert.equal(await navigateCodeHistory(-1, 'project'), true)
  assert.equal(consumePendingCodeLocation('project', 'b.ts'), b)
  setActiveCodeLocation(b)
  assert.equal(await navigateCodeHistory(-1, 'project'), true)
  assert.equal(consumePendingCodeLocation('project', 'a.ts'), a)
  setActiveCodeLocation(a)
  assert.equal(await navigateCodeHistory(1, 'project'), true)
  assert.equal(consumePendingCodeLocation('project', 'b.ts'), b)
  setActiveCodeLocation(b)
  assert.deepEqual(opened, ['a.ts', 'b.ts', 'c.ts', 'b.ts', 'a.ts', 'b.ts'])
  await openCodeLocation(b)
  assert.equal(await navigateCodeHistory(-1, 'project'), true)
  assert.equal(consumePendingCodeLocation('project', 'a.ts'), a)
  assert.equal(await navigateCodeHistory(1, 'project'), true)
  resetCodeNavigation()
})
