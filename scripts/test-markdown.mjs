import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../src/renderer/src/utils/markdownEditing.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const { formatMarkdown, smartEnter, indentMarkdown, pairMarkdown, textMatches, documentStats, markdownTable, insideCodeFence } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'))
function apply(value, change) {
  assert.ok(change, 'expected an edit')
  const text = value.slice(0, change.start) + change.text + value.slice(change.end)
  assert.ok(change.selectionStart >= 0 && change.selectionStart <= text.length, 'selection is inside document')
  assert.ok(change.selectionEnd >= change.selectionStart && change.selectionEnd <= text.length, 'selection end is valid')
  return { text, selected: text.slice(change.selectionStart, change.selectionEnd), caret: change.selectionStart }
}

for (const [command, expected] of [['bold', '**hello**'], ['italic', '*hello*'], ['strike', '~~hello~~'], ['highlight', '==hello=='], ['inline-code', '`hello`'], ['inline-math', '$hello$']]) {
  test(`inline ${command} wraps selection and toggles without losing text`, () => {
    const inserted = formatMarkdown('hello', 0, 5, command)
    assert.deepEqual(apply('hello', inserted), { text: expected, selected: 'hello', caret: inserted.selectionStart })
    const removed = formatMarkdown(expected, inserted.selectionStart, inserted.selectionEnd, command)
    assert.equal(apply(expected, removed).text, 'hello')
  })
}
test('inline code chooses a delimiter longer than embedded backticks', () => {
  assert.equal(apply('a`b', formatMarkdown('a`b', 0, 3, 'inline-code')).text, '``a`b``')
  assert.equal(apply('`a`', formatMarkdown('`a`', 0, 3, 'inline-code')).text, '`` `a` ``')
})
test('empty inline command selects its editable placeholder', () => assert.equal(apply('', formatMarkdown('', 0, 0, 'bold')).selected, '文字'))
test('heading replaces a heading marker and toggles back to paragraph', () => {
  assert.equal(apply('## 标题', formatMarkdown('## 标题', 3, 5, 'h1')).text, '# 标题')
  assert.equal(apply('# 标题', formatMarkdown('# 标题', 2, 4, 'h1')).text, '标题')
})
test('line formatting does not include a following line at a selection boundary', () => assert.equal(apply('one\ntwo', formatMarkdown('one\ntwo', 0, 4, 'list')).text, '- one\ntwo'))
test('ordered lists number all selected lines', () => assert.equal(apply('a\nb\nc', formatMarkdown('a\nb\nc', 0, 5, 'ordered-list')).text, '1. a\n2. b\n3. c'))
test('ordered-list command toggles a complete numbered selection', () => assert.equal(apply('1. a\n2. b', formatMarkdown('1. a\n2. b', 0, 9, 'ordered-list')).text, 'a\nb'))
test('link insertion selects the URL', () => assert.equal(apply('标题', formatMarkdown('标题', 0, 2, 'link')).selected, 'https://'))
test('link labels escape unbalanced brackets', () => assert.equal(apply('a]b', formatMarkdown('a]b', 0, 3, 'link')).text, '[a\\]b](https://)'))
test('code blocks are separated from surrounding text', () => assert.equal(apply('before text after', formatMarkdown('before text after', 7, 11, 'code')).text, 'before \n\n```\ntext\n```\n\n after'))
test('front matter is inserted once and preserves the existing body', () => {
  const document = apply('body', formatMarkdown('body', 0, 0, 'frontmatter')).text
  assert.match(document, /^---\ntitle: ""\n---\n\nbody$/)
  assert.equal(apply(document, formatMarkdown(document, 0, 0, 'frontmatter')).text, document)
})
test('footnotes use unused IDs and append definitions without replacing body', () => {
  const doc = 'old[^note1]\n\n[^note1]: old'
  const result = apply(doc, formatMarkdown(doc, 3, 3, 'footnote'))
  assert.ok(result.text.startsWith('old[^note2][^note1]'))
  assert.ok(result.text.includes('[^note2]: 脚注内容'))
  assert.equal(result.selected, '脚注内容')
})
test('table dimensions include one header and the requested data rows', () => {
  assert.equal(markdownTable(4, 5).split('\n').length, 6)
  assert.equal(markdownTable(4, 5).split('\n')[0].split('|').length, 7)
  assert.equal(markdownTable(999, 999).split('\n').length, 52)
})
for (const [input, expected] of [['- item', '- item\n- '], ['9. item', '9. item\n10. '], ['3) item', '3) item\n4) '], ['- [x] done', '- [x] done\n- [ ] '], ['> quote', '> quote\n> '], ['> - [X] task', '> - [X] task\n> - [ ] ']]) {
  test(`Enter continues ${input}`, () => assert.equal(apply(input, smartEnter(input, input.length, input.length)).text, expected))
}
test('Enter on an empty list exits it', () => assert.equal(apply('- ', smartEnter('- ', 2, 2)).text, ''))
test('Enter on an empty nested list first outdents one level', () => assert.equal(apply('  - ', smartEnter('  - ', 4, 4)).text, '- '))
test('Enter on empty nested quote exits one quote level', () => assert.equal(apply('> > ', smartEnter('> > ', 4, 4)).text, '> '))
test('Enter in the middle of a list splits at the cursor', () => assert.equal(apply('- abcd', smartEnter('- abcd', 4, 4)).text, '- ab\n- cd'))
test('code-fence Enter inserts a matching closing fence and positions the caret', () => assert.deepEqual(apply('```js', smartEnter('```js', 5, 5)), { text: '```js\n\n```', selected: '', caret: 6 }))
test('existing closing fence is not duplicated', () => assert.equal(smartEnter('```js\n```', 5, 5), null))
test('list syntax inside a code fence remains code', () => assert.equal(apply('```md\n- code', smartEnter('```md\n- code', 12, 12)).text, '```md\n- code\n'))
test('long fences do not close at shorter or different markers', () => {
  assert.equal(insideCodeFence('````md\n```\n', 11), true)
  assert.equal(insideCodeFence('~~~md\n```\n~~~\n', 15), false)
})
test('multi-line indentation and outdent restore text and selection', () => {
  const value = 'first\nsecond\nthird'
  const indented = indentMarkdown(value, 0, 13, false)
  const next = apply(value, indented).text
  assert.equal(next, '  first\n  second\nthird')
  assert.equal(apply(next, indentMarkdown(next, indented.selectionStart, indented.selectionEnd, true)).text, value)
})
test('Tab inserts at caret while Shift+Tab handles an unindented line', () => {
  assert.equal(apply('ab', indentMarkdown('ab', 1, 1, false)).text, 'a  b')
  assert.equal(apply('ab', indentMarkdown('ab', 1, 1, true)).text, 'ab')
})
test('paired punctuation surrounds selections, skips closers and deletes empty pairs', () => {
  assert.equal(apply('text', pairMarkdown('text', 0, 4, '[')).text, '[text]')
  assert.deepEqual(apply('()', pairMarkdown('()', 1, 1, ')')), { text: '()', selected: '', caret: 2 })
  assert.equal(apply('[]', pairMarkdown('[]', 1, 1, 'Backspace')).text, '')
})
test('pairing respects apostrophes, escaped delimiters and existing text', () => {
  assert.equal(pairMarkdown('don', 3, 3, "'"), null)
  assert.equal(pairMarkdown('\\', 1, 1, '['), null)
  assert.equal(pairMarkdown('next', 0, 0, '('), null)
})
test('literal search escapes regexp syntax, respects case and whole words', () => {
  assert.deepEqual(textMatches('A.*b a.*b', '.*'), [{ start: 1, end: 3 }, { start: 6, end: 8 }])
  assert.equal(textMatches('Cat cat scatter', 'cat', false, true).length, 2)
  assert.equal(textMatches('Cat cat scatter', 'cat', true, true).length, 1)
  assert.deepEqual(textMatches('İx i', 'i'), [{ start: 3, end: 4 }])
  assert.equal(textMatches('anything', '').length, 0)
})
test('mixed Chinese and Latin statistics exclude Markdown and front matter', () => {
  const stats = documentStats('---\ntitle: ignored\n---\n# 你好 **world** don\'t')
  assert.equal(stats.words, 4)
  assert.equal(stats.characters, 12)
  assert.equal(stats.minutes, 1)
})
test('emoji characters use grapheme counts and empty documents are zero', () => {
  assert.equal(documentStats('👨‍👩‍👧‍👦').characters, 1)
  assert.equal(documentStats('').words, 0)
  assert.equal(documentStats('').minutes, 0)
})
test('task progress excludes examples inside fenced code', () => {
  const stats = documentStats('- [x] done\n- [ ] todo\n````md\n```\n- [ ] example\n````')
  assert.equal(stats.tasks, 2)
  assert.equal(stats.completed, 1)
})
