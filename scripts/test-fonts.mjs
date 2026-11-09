import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../src/shared/fontFamilies.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const { parseFontFamilies, serializeFontFamilies, normalizeFontStack, resolveFontStack, normalizeEditorWidth } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'))

test('font stacks preserve multiword names, quoted commas, Chinese and generic families', () => {
  assert.deepEqual(parseFontFamilies('Open Sans, "Font, With Comma", \'思源宋体\', sans-serif'), ['Open Sans', 'Font, With Comma', '思源宋体', 'sans-serif'])
})

test('font names containing quotes or backslashes survive saving and loading', () => {
  const families = ['Font "A"', 'Font\\B', '微软雅黑', 'sans-serif']
  assert.deepEqual(parseFontFamilies(serializeFontFamilies(families)), families)
})

test('normalization removes duplicate names without changing fallback priority', () => {
  assert.deepEqual(parseFontFamilies(normalizeFontStack(' Georgia, Arial, "georgia", 思源黑体, arial ')), ['Georgia', 'Arial', '思源黑体'])
})

test('generic families keep their CSS meaning while custom names are quoted', () => {
  assert.equal(serializeFontFamilies(['Times New Roman', 'SANS-SERIF', 'ui-serif']), '"Times New Roman", sans-serif, ui-serif')
})

test('an intentionally empty stack stays empty and resolves to bundled defaults', () => {
  assert.equal(normalizeFontStack(''), '')
  assert.equal(serializeFontFamilies([]), '')
  assert.equal(parseFontFamilies(resolveFontStack(''))[0], 'Open Sans')
  assert.equal(parseFontFamilies(resolveFontStack('', true))[0], 'DejaVu Sans Mono')
})

test('custom body and code fonts remain ahead of automatic fallbacks', () => {
  assert.deepEqual(parseFontFamilies(resolveFontStack('"思源宋体", Georgia')).slice(0, 2), ['思源宋体', 'Georgia'])
  const code = parseFontFamilies(resolveFontStack('Consolas, "DejaVu Sans Mono"', true))
  assert.equal(code[0], 'Consolas')
  assert.equal(code.filter((font) => font === 'DejaVu Sans Mono').length, 1)
  assert.ok(code.includes('monospace'))
})

test('maximum editor width accepts MarkText units and fluid layout', () => {
  for (const width of ['800px', '80ch', '80%', '640.5px', '']) assert.equal(normalizeEditorWidth(width), width)
  assert.equal(normalizeEditorWidth(' 800PX '), '800px')
})

test('invalid or nonpositive widths cannot collapse the document or add CSS declarations', () => {
  for (const width of ['0px', '-20ch', 'NaNpx', '800', 'calc(100% - 1px)', '80%;color:red', null, 800]) assert.equal(normalizeEditorWidth(width), '')
})
