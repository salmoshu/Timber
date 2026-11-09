// Runs Reader + Muya + CodeMirror in an isolated Electron profile and temporary project.
// Build first: pnpm build. No installed app, real project or saved preferences are accessed.
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { createRequire } = require('node:module')
const root = path.resolve(__dirname, '..')
const temp = path.join(root, 'tmp', 'markdown-smoke-' + (process.env.TIMBER_SMOKE_ID || Date.now()))

if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE) {
  fs.mkdirSync(temp, { recursive: true })
  const env = { ...process.env, TIMBER_SMOKE_ID: path.basename(temp).replace('markdown-smoke-', '') }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename], {
    cwd: root, windowsHide: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let diagnostics = ''
  child.stdout.on('data', chunk => { diagnostics += chunk })
  child.stderr.on('data', chunk => { diagnostics += chunk })
  child.on('error', error => { console.error(error); process.exitCode = 1 })
  child.on('exit', code => {
    const report = path.join(temp, 'result.json')
    if (fs.existsSync(report)) console.log(fs.readFileSync(report, 'utf8'))
    if (code && diagnostics) console.error(diagnostics.slice(-16000))
    process.exitCode = code || 0
  })
} else {
  const { app, BrowserWindow } = require('electron')
  fs.mkdirSync(temp, { recursive: true })
  app.setPath('userData', path.join(temp, 'profile'))
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  const report = path.join(temp, 'result.json')
  let sidecar
  let win
  const generated = [path.join(root, 'out/renderer/__smoke-reader.html'), path.join(root, 'out/renderer/__smoke-reader.js')]
  const failures = []

  async function runBrowserChecks() {
    const checks = []
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
    const check = (condition, message) => { if (!condition) throw new Error(message) }
    const wait = async (predicate, message, timeout = 15000) => {
      const end = Date.now() + timeout
      while (Date.now() < end) { if (predicate()) return; await pause(40) }
      throw new Error(message)
    }
    const runtime = () => window.__writer.runtime()
    const value = () => window.__writer.value()
    const setValue = (element, next) => {
      const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, next)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const key = (element, value, options = {}) => { element.focus(); return element.dispatchEvent(new KeyboardEvent('keydown', { key: value, code: value, keyCode: value.length === 1 ? value.toUpperCase().charCodeAt(0) : 0, bubbles: true, cancelable: true, ...options })) }
    const documentWith = async (markdown, mode = 'source') => {
      window.__writer.setDocument(markdown, mode)
      await wait(() => {
        const current = runtime()
        return current && current.kind === (mode === 'source' ? 'source' : 'muya') && current.root.isConnected
      }, mode + ' editor did not initialize')
      await wait(() => mode === 'source' ? !!document.querySelector('.CodeMirror') : !!document.querySelector('.prose.mu-editor .mu-container'), 'editor DOM did not render')
      await pause(140)
      check(!window.__writer.dirty(), 'editor initialization marked the document dirty')
      return runtime().root
    }
    const selectSource = (_root, start = value().length, end = start) => {
      window.__writer.selectSource(start, end)
      document.dispatchEvent(new Event('selectionchange'))
    }
    const visibleTextNodes = prose => {
      const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement
          if (!parent || parent.closest('.mu-hide, .mu-remove, .mu-copy-header-link, .mu-fold-toggle, .mu-inline-image, .mu-image-container, .mu-math-render, .mu-ruby-render, .mu-code-line-numbers, .mu-language-input, [aria-hidden="true"]')) return NodeFilter.FILTER_REJECT
          return NodeFilter.FILTER_ACCEPT
        }
      })
      const nodes = []
      let node
      while ((node = walker.nextNode())) nodes.push(node)
      return nodes
    }
    const selectText = (prose, text, occurrence = 0) => {
      for (const node of visibleTextNodes(prose)) {
        const index = node.data.indexOf(text)
        if (index < 0 || occurrence-- > 0) continue
        prose.focus()
        const range = document.createRange()
        range.setStart(node, index); range.setEnd(node, index + text.length)
        window.getSelection().removeAllRanges(); window.getSelection().addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
        return
      }
      throw new Error('text missing from editor: ' + text)
    }
    const selectAcross = (prose, startText, endText) => {
      const nodes = visibleTextNodes(prose)
      let start
      let end
      for (const node of nodes) {
        const first = node.data.indexOf(startText)
        const last = node.data.indexOf(endText)
        if (!start && first >= 0) start = { node, offset: first }
        if (start && last >= 0) { end = { node, offset: last + endText.length }; break }
      }
      check(start && end, 'cross-block selection endpoints missing')
      const range = document.createRange()
      range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset)
      window.getSelection().removeAllRanges(); window.getSelection().addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    }
    const clickText = text => {
      const button = [...document.querySelectorAll('button')].find(element => element.textContent.trim() === text)
      check(button, 'button missing: ' + text); button.click()
    }
    const replaceSource = next => {
      selectSource(runtime().root, 0, value().length)
      runtime().execute({ command: 'paragraph', markdown: next })
    }

    const savedSettings = localStorage.getItem('timber-settings')
    try {
      localStorage.setItem('timber-settings', JSON.stringify({ serifFont: true }))
      check(window.__writer.loadSettings().editorFontFamily.includes('Georgia'), 'legacy serif font preference was lost')
      localStorage.setItem('timber-settings', JSON.stringify({ serifFont: false }))
      check(window.__writer.loadSettings().editorFontFamily.includes('Microsoft YaHei'), 'legacy sans-serif font preference was lost')
      localStorage.setItem('timber-settings', JSON.stringify({ editorFontFamily: '"Font, With Comma", Georgia', codeFontFamily: '', editorLineWidth: '640px' }))
      const restoredFonts = window.__writer.loadSettings()
      check(restoredFonts.editorFontFamily.startsWith('"Font, With Comma"') && restoredFonts.codeFontFamily === '' && restoredFonts.editorLineWidth === '640px', 'quoted families, empty default stack or editor width did not survive settings load')
    } finally {
      if (savedSettings === null) localStorage.removeItem('timber-settings')
      else localStorage.setItem('timber-settings', savedSettings)
    }
    checks.push('saved serif and sans-serif font preferences migrate to font families')

    const originalTypography = window.__writer.settings()
    const typography = { fontSize: 22, editorFontFamily: 'Georgia', lineHeight: 1.9, codeFontSize: 18, codeFontFamily: 'Consolas', wrapCodeBlocks: false, editorLineWidth: '640px' }
    const typographyDocument = 'Typography 正文\n\n```js\nconst longLine = "' + 'long code '.repeat(50) + '"\n```\n'
    const styledProse = await documentWith(typographyDocument, 'read')
    for (const [setting, value] of Object.entries(typography)) window.__writer.setting(setting, value)
    await pause(100)
    check(runtime().root === styledProse, 'changing typography remounted Muya')
    check(styledProse.getBoundingClientRect().width <= 641, 'maximum editor width did not reach Muya')
    check(getComputedStyle(styledProse).fontSize === '22px' && getComputedStyle(styledProse).fontFamily.includes('Georgia'), 'body font or size did not reach Muya')
    check(Math.abs(parseFloat(getComputedStyle(styledProse).lineHeight) - 22 * 1.9) < 0.1, 'body line height did not reach Muya')
    const styledCode = styledProse.querySelector('.mu-code-block .mu-code')
    check(styledCode && getComputedStyle(styledCode).fontSize === '18px' && getComputedStyle(styledCode).fontFamily.includes('Consolas'), 'code font or size did not reach Muya code blocks')
    check(getComputedStyle(styledCode).whiteSpace === 'pre', 'Muya code did not stop wrapping')
    window.__writer.mode('source')
    await wait(() => runtime()?.kind === 'source', 'source did not mount for typography checks')
    const styledSource = runtime().root
    const cm = styledSource.CodeMirror
    check(styledSource.getBoundingClientRect().width <= 641, 'maximum editor width did not reach CodeMirror')
    check(getComputedStyle(styledSource).fontSize === '18px' && getComputedStyle(styledSource).fontFamily.includes('Consolas'), 'code font or size did not reach CodeMirror')
    check(getComputedStyle(styledSource.querySelector('pre.CodeMirror-line')).whiteSpace === 'pre', 'source did not preserve disabled wrapping')
    cm.setSelection(cm.posFromIndex(1), cm.posFromIndex(5))
    window.__writer.setting('codeFontSize', 20)
    window.__writer.setting('wrapCodeBlocks', true)
    await pause(100)
    check(runtime().root === styledSource && cm.getSelection() === typographyDocument.slice(1, 5), 'changing source typography lost the editor or selection')
    check(getComputedStyle(styledSource).fontSize === '20px' && getComputedStyle(styledSource.querySelector('pre.CodeMirror-line')).whiteSpace === 'pre-wrap', 'source typography did not update in place')
    window.__writer.mode('read')
    await wait(() => runtime()?.kind === 'muya', 'Muya did not restore for typography checks')
    check(getComputedStyle(runtime().root.querySelector('.mu-code-block .mu-code')).whiteSpace === 'pre-wrap', 'Muya did not preserve enabled wrapping after remount')
    check(!window.__writer.dirty() && window.__writer.draft() === typographyDocument, 'typography changes altered the pristine document')
    for (const setting of Object.keys(typography)) window.__writer.setting(setting, originalTypography[setting])
    checks.push('live body/code typography and wrapping preserve selection and pristine drafts across modes')

    {
      const document = 'editor preference\n\n```js\nconst one = 1\nconst two = 2\n```\n'
      const root = await documentWith(document, 'read')
      check(!!root.querySelector('.mu-line-numbers-rows'), 'default code block line numbers are missing')
      const initialSettings = window.__writer.settings()
      window.__writer.setting('codeBlockLineNumbers', false)
      await wait(() => !root.querySelector('.mu-line-numbers-rows'), 'code block line numbers did not hide after changing the editor setting')
      window.__writer.setting('codeBlockLineNumbers', true)
      await wait(() => !!root.querySelector('.mu-line-numbers-rows'), 'code block line numbers did not return after changing the editor setting')
      check(runtime().root === root && !window.__writer.dirty() && window.__writer.draft() === document, 'code display settings remounted or changed the pristine document')
      await documentWith('one\ntwo', 'source')
      const sourceRoot = runtime().root
      window.__writer.setting('tabSize', 4)
      window.__writer.setting('sourceCodeLineNumbers', false)
      check(sourceRoot.CodeMirror.getOption('lineNumbers') === false, 'source line numbers setting was ignored')
      selectSource(sourceRoot, 0, 7)
      key(window.__writer.sourceInput(), 'Tab')
      check(value() === '    one\n    two', 'source Tab did not follow the four-space indentation preference')
      key(window.__writer.sourceInput(), 'Tab', { shiftKey: true })
      check(value() === 'one\ntwo', 'source Shift+Tab did not remove the configured indentation')
      for (const setting of ['tabSize', 'sourceCodeLineNumbers', 'codeBlockLineNumbers']) window.__writer.setting(setting, initialSettings[setting])
      check(runtime().root === sourceRoot, 'changing editor preferences recreated the source editor')
      await documentWith('', 'source')
      const input = window.__writer.sourceInput()
      window.__writer.toggle('autoPairBracket')
      check(key(input, '(', { code: 'Digit9', keyCode: 57, shiftKey: true }) && value() === '', 'disabled bracket pairing still intercepted source input')
      key(input, '"', { code: 'Quote', keyCode: 222, shiftKey: true })
      check(value() === '""', 'disabling brackets also disabled independent quote pairing')
      window.__writer.undo()
      window.__writer.toggle('autoPairBracket')
      window.__writer.toggle('autoPairQuote')
      check(key(input, '"', { code: 'Quote', keyCode: 222, shiftKey: true }) && value() === '', 'disabled quote pairing still intercepted source input')
      key(input, '(', { code: 'Digit9', keyCode: 57, shiftKey: true })
      check(value() === '()', 'disabling quotes also disabled independent bracket pairing')
      window.__writer.undo()
      window.__writer.toggle('autoPairQuote')
      checks.push('live code/source line numbers, configured Tab and independent bracket/quote pairing')
    }

    {
      const markdown = '# Icon controls\n\nPreview content.\n'
      await documentWith(markdown, 'read')
      const mode = document.querySelector('[aria-label="源码模式"]')
      const preview = document.querySelector('[aria-label="分页预览"]')
      check(mode?.querySelectorAll('svg').length === 2 && !mode.textContent.trim(), 'mode switch still contains visible text instead of read/source icons')
      check(preview?.querySelector('svg') && !preview.textContent.trim() && preview.hasAttribute('aria-pressed'), 'page preview is not an accessible icon button')
      preview.click()
      await wait(() => !!document.querySelector('.paged-preview') && preview.getAttribute('aria-pressed') === 'true', 'preview icon did not open paginated preview')
      preview.click()
      await wait(() => runtime()?.kind === 'muya' && preview.getAttribute('aria-pressed') === 'false', 'preview icon did not return to the reader')
      check(window.__writer.draft() === markdown && !window.__writer.dirty(), 'preview icon changed the pristine document')
      checks.push('icon-only read/source switch and page preview button toggle without editing the document')
    }

    let source = await documentWith('- task')
    let input = window.__writer.sourceInput()
    selectSource(source)
    key(input, 'Enter')
    check(value() === '- task\n- ', 'source list continuation failed: ' + value())
    key(input, 'Enter')
    check(value() === '- task\n', 'empty source list did not exit')
    checks.push('source list continuation and exit')

    source = await documentWith('hello')
    input = window.__writer.sourceInput()
    selectSource(source, 0, 5)
    key(input, 'b', { code: 'KeyB', ctrlKey: true })
    check(value() === '**hello**', 'source Ctrl+B did not format selection')
    window.__writer.undo()
    await pause(60)
    check(value() === 'hello', 'source formatting could not be undone: ' + value())
    selectSource(source)
    key(input, '(', { code: 'Digit9', shiftKey: true })
    check(value() === 'hello()', 'shifted bracket was not paired')
    key(input, ')', { code: 'Digit0', shiftKey: true })
    check(value() === 'hello()' && runtime().getSelectionOffsets().start === 7, 'closing bracket was duplicated')
    checks.push('source formatting, undo and paired punctuation')

    source = await documentWith('one\ntwo')
    input = window.__writer.sourceInput()
    selectSource(source, 0, 7)
    key(input, 'Tab')
    check(value() === '  one\n  two', 'source multi-line indent failed')
    key(input, 'Tab', { shiftKey: true })
    check(value() === 'one\ntwo', 'source multi-line outdent failed')
    checks.push('multi-line Tab and Shift+Tab')

    source = await documentWith('mode switch', 'source')
    replaceSource('mode switch edited')
    await wait(() => window.__writer.draft() === 'mode switch edited', 'source draft did not update before mode switch')
    window.__writer.mode('read')
    await wait(() => runtime()?.kind === 'muya', 'read mode did not mount after source edit')
    check(window.__writer.draft() === 'mode switch edited', 'mode switch lost source draft')
    window.__writer.mode('source')
    await wait(() => runtime()?.kind === 'source' && value().trim() === 'mode switch edited', 'source mode did not restore draft')
    checks.push('source and reading mode preserve draft')
    input = window.__writer.sourceInput()
    key(input, 'z', { code: 'KeyZ', ctrlKey: true })
    await wait(() => value() === 'mode switch', 'source undo history was lost after mode switch: ' + value())
    key(input, 'y', { code: 'KeyY', ctrlKey: true })
    await wait(() => value() === 'mode switch edited', 'source Ctrl+Y did not redo after mode switch')
    checks.push('source keyboard undo/redo survives editor remount')

    source = await documentWith('')
    input = window.__writer.sourceInput()
    selectSource(source)
    key(input, '/')
    await wait(() => !!document.querySelector('.writing-insert-palette'), 'slash palette did not open')
    setValue(document.querySelector('[aria-label="搜索插入格式"]'), '表格')
    setValue(document.querySelector('[aria-label="表格数据行数"]'), '4')
    setValue(document.querySelector('[aria-label="表格列数"]'), '5')
    await pause(60)
    document.querySelector('.writing-insert-list button').click()
    await pause(60)
    check(value().split('\n').filter(Boolean).length === 6 && value().split('\n')[0].split('|').length === 7, 'configured table dimensions were not used')
    checks.push('slash insertion and configurable tables')

    let prose = await documentWith('hello world\n', 'read')
    selectText(prose, 'hello')
    window.__writer.command('bold')
    await wait(() => value().includes('**hello**'), 'WYSIWYG bold did not reach Markdown draft: ' + value())
    const bold = prose.querySelector('b, strong')
    check(bold?.textContent === 'hello' && Number(getComputedStyle(bold).fontWeight) >= 600, 'WYSIWYG bold formatting was not rendered')
    window.__writer.undo()
    await wait(() => !value().includes('**hello**'), 'WYSIWYG operation was not undoable')
    checks.push('WYSIWYG selection formatting and undo')
    key(prose, 'y', { code: 'KeyY', ctrlKey: true })
    await wait(() => value().includes('**hello**'), 'Muya Ctrl+Y did not redo formatting')
    key(prose, 'z', { code: 'KeyZ', ctrlKey: true })
    await wait(() => !value().includes('**hello**'), 'Muya Ctrl+Z did not undo formatting')
    key(prose, 'z', { code: 'KeyZ', ctrlKey: true, shiftKey: true })
    await wait(() => value().includes('**hello**'), 'Muya Ctrl+Shift+Z did not redo formatting')
    window.__writer.mode('source')
    await wait(() => runtime()?.kind === 'source', 'source editor did not mount')
    replaceSource('changed in source\n')
    await wait(() => window.__writer.draft() === 'changed in source\n', 'source change did not reach shared draft')
    window.__writer.mode('read')
    await wait(() => runtime()?.kind === 'muya', 'Muya did not remount')
    prose = runtime().root
    key(prose, 'z', { code: 'KeyZ', ctrlKey: true })
    await wait(() => value().includes('**hello**'), 'Muya did not undo the source edit as a standalone step: ' + value())
    key(prose, 'z', { code: 'KeyZ', ctrlKey: true })
    await wait(() => value().trim() === 'hello world', 'Muya original history was lost after source edits: ' + value())
    key(prose, 'y', { code: 'KeyY', ctrlKey: true })
    key(prose, 'y', { code: 'KeyY', ctrlKey: true })
    await wait(() => value().trim() === 'changed in source', 'Muya could not redo across modes')
    checks.push('Muya keyboard history and source edits survive mode switches')

    prose = await documentWith('select annotation\n\nsecond paragraph\n', 'read')
    selectText(prose, 'annotation')
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await wait(() => !!document.querySelector('.mu-annotation-button'), 'Muya annotation button did not appear')
    check(document.querySelector('.mu-annotation-button svg')?.namespaceURI === 'http://www.w3.org/2000/svg' && !document.querySelector('.mu-annotation-button').textContent.trim(), 'annotation toolbar action is text rather than an icon')
    check(!document.querySelector('.ann-pop, .writing-toolbar'), 'duplicate Timber selection/writing toolbar remains')
    document.querySelector('.mu-annotation-button').click()
    await wait(() => window.__writer.compose()?.quote === 'annotation' && !!document.querySelector('.ap-compose'), 'Muya annotation lost selection or did not open composer')
    window.__writer.cancelCompose()
    runtime().focus()
    selectAcross(prose, 'select', 'paragraph')
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await pause(100)
    await wait(() => {
      const toolbar = document.querySelector('.mu-format-picker-container')
      return !toolbar || Number(getComputedStyle(toolbar).opacity) === 0
    }, 'cross-paragraph selection displayed a standalone annotation toolbar')
    check(!window.__writer.compose(), 'cross-paragraph selection unexpectedly opened annotation composition')
    checks.push('annotation icon shares normal formatting toolbar visibility; cross-paragraph selection hides the whole toolbar')

    prose = await documentWith('Heading target\n', 'read')
    selectText(prose, 'Heading target')
    window.__writer.command('h2')
    await wait(() => /^## Heading target/m.test(value()), 'heading transformation was not saved: ' + value())
    checks.push('WYSIWYG heading transformation')

    const rich = '---\ntitle: 保留元信息\ntags: [markdown, timber]\n---\n\n# 示例\n\nhello world\n\n- [x] done\n- [ ] todo\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```js\nconst n = 1\n```\n\n$$\nE=mc^2\n$$\n\n注释[^note1]\n\n[^note1]: 说明\n'
    prose = await documentWith(rich, 'read')
    const taskBoxes = prose.querySelectorAll('li.mu-task-list-item > input[type="checkbox"], li.mu-task-list-item > span.mu-task-list-checkbox')
    check(taskBoxes.length === 2, 'task list checkboxes are missing')
    for (const box of taskBoxes) {
      const shape = getComputedStyle(box, '::before')
      check(shape.width === shape.height && parseFloat(shape.borderTopLeftRadius) <= 3 && !shape.borderTopLeftRadius.includes('%'), 'Markdown task checkbox is still circular')
    }
    taskBoxes[1].click()
    await wait(() => /^- \[[xX]\] todo$/m.test(value()), 'square task checkbox did not toggle the Markdown task state')
    window.__writer.undo()
    await wait(() => /^- \[ \] todo$/m.test(value()), 'task checkbox toggle was not undoable')
    checks.push('square task checkboxes toggle Markdown state and support undo')
    selectText(prose, 'hello')
    window.__writer.command('italic')
    await wait(() => value().includes('*hello*'), 'rich document did not sync')
    const roundTrip = value()
    for (const fragment of ['title: 保留元信息', 'tags: [markdown, timber]', '| A', 'const n = 1', 'E=mc^2', '[^note1]']) check(roundTrip.includes(fragment), 'Markdown round trip lost: ' + fragment)
    check(/^- \[[xX]\] done$/m.test(roundTrip), 'Markdown round trip lost the completed task')
    checks.push('front matter, task, table, code, math and footnote round trip')

    prose = await documentWith('```cpp\n#include <vector>\nint main() { return 0; }\n```\n', 'read')
    await wait(() => !!prose.querySelector('.mu-code-block .token'), 'lazy C++ Prism grammar did not highlight the code block')
    check(value().includes('#include <vector>'), 'lazy grammar loading changed the code source')
    checks.push('lazy Prism grammar loading preserves code and dependency order')

    prose = await documentWith('**hello** HELLO other\n', 'read')
    key(prose, 'h', { code: 'KeyH', ctrlKey: true })
    await wait(() => !!document.querySelector('[aria-label="查找文本"]'), 'Ctrl+H did not open replacement')
    setValue(document.querySelector('[aria-label="查找文本"]'), 'hello')
    setValue(document.querySelector('[aria-label="替换文本"]'), '世界')
    await pause(240)
    clickText('全部替换')
    await wait(() => value().includes('世界') && !/hello/i.test(value()), 'WYSIWYG replace all failed: ' + value())
    check(value().includes('**世界**'), 'replacement removed existing bold formatting: ' + value())
    document.querySelector('[aria-label="关闭查找"]').click()
    checks.push('WYSIWYG replace all preserves inline formatting')

    source = await documentWith('Cat cat scatter')
    input = window.__writer.sourceInput()
    key(input, 'h', { code: 'KeyH', ctrlKey: true })
    await wait(() => !!document.querySelector('[aria-label="替换文本"]'), 'source replace did not open')
    setValue(document.querySelector('[aria-label="查找文本"]'), 'cat')
    setValue(document.querySelector('[aria-label="替换文本"]'), 'dog')
    document.querySelector('[aria-label="全字匹配"]').click()
    document.querySelector('[aria-label="区分大小写"]').click()
    await pause(240)
    clickText('全部替换')
    check(value() === 'Cat dog scatter', 'source case-sensitive whole-word replacement failed: ' + value())
    document.querySelector('[aria-label="关闭查找"]').click()
    checks.push('source find/replace with case and whole-word controls')

    prose = await documentWith('前文 **粗体文字** 与 [链接文字](https://example.com)\n\n第一段落\n\n第二段落\n\n重复目标 中间\n\n重复目标 后缀', 'read')
    selectText(prose, '粗体文字')
    const boldAnchor = window.__writer.selectionAnchor()
    check(boldAnchor?.quote === '粗体文字' && !boldAnchor.prefix.includes('**'), 'bold annotation included Markdown syntax')
    check(window.__writer.annotationRange(boldAnchor), 'bold annotation did not resolve')
    selectText(prose, '链接文字')
    const linkAnchor = window.__writer.selectionAnchor()
    check(linkAnchor?.quote === '链接文字' && !linkAnchor.suffix.includes('https://'), 'link annotation included the URL')
    check(window.__writer.annotationRange(linkAnchor), 'link annotation did not resolve')
    selectAcross(prose, '第一段落', '第二段落')
    const crossAnchor = window.__writer.selectionAnchor()
    check(crossAnchor?.quote.includes('第一段落') && crossAnchor.quote.includes('第二段落'), 'cross-paragraph anchor lost text')
    check(window.__writer.annotationRange(crossAnchor), 'cross-paragraph annotation did not resolve')
    selectText(prose, '重复目标', 1)
    const duplicateAnchor = window.__writer.selectionAnchor()
    const duplicateRange = window.__writer.annotationRange(duplicateAnchor)
    check(duplicateRange && duplicateRange.comparePoint(window.getSelection().anchorNode, window.getSelection().anchorOffset) === 0, 'duplicate quote context selected the wrong occurrence')
    selectText(prose, '第一段落')
    const missingAnchor = window.__writer.selectionAnchor()
    await documentWith('原文已经删除', 'read')
    check(!window.__writer.annotationRange(missingAnchor), 'deleted quote unexpectedly resolved')
    checks.push('Chinese, bold, link, cross-paragraph, duplicate and deleted annotation anchors')

    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 2
    canvas.getContext('2d').fillRect(0, 0, 2, 2)
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
    const file = new File([blob], 'screenshot.png', { type: 'image/png' })
    source = await documentWith('图片：\n')
    input = window.__writer.sourceInput()
    selectSource(source)
    let clipboard = new DataTransfer(); clipboard.items.add(file)
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }))
    await wait(() => /!\[screenshot\]\(assets\/image-[a-f0-9]+\.png\)/.test(value()), 'clipboard image did not save as a relative source link')
    const imageMarkdown = value()
    prose = await documentWith(imageMarkdown + '\n再次粘贴\n', 'read')
    await wait(() => {
      const image = prose.querySelector('.mu-inline-image img[src*="/raw/"]')
      return image?.complete && image.naturalWidth === 2
    }, 'local image did not load through the raw display URL')
    check(!/(?:\/raw\/|file:\/\/)/.test(value()), 'serialized Markdown contains a display-only image URL')
    selectText(prose, '再次粘贴')
    clipboard = new DataTransfer(); clipboard.items.add(file)
    prose.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }))
    await wait(() => (value().match(/assets\/image-/g) || []).length === 2, 'WYSIWYG image insertion failed: ' + value())
    clipboard = new DataTransfer(); clipboard.items.add(file)
    prose.dispatchEvent(new DragEvent('drop', { dataTransfer: clipboard, bubbles: true, cancelable: true }))
    await wait(() => (value().match(/assets\/image-/g) || []).length === 3, 'WYSIWYG image drop failed: ' + value())
    checks.push('source paste, WYSIWYG paste/drop and raw-only display image URLs')

    const exportSource = '---\ntitle: 导出元信息\n---\n\n' + imageMarkdown + '\n```mermaid\nflowchart LR\n  A[Start] --> B[End]\n```\n\n$$\nE=mc^2\n$$\n\n脚注[^n]\n\n[^n]: 内容\n'
    const html = await window.__writer.exportHtml(exportSource, 'HTML <标题>')
    check(html.includes('data:image/png;base64,'), 'HTML did not embed local images')
    check(html.includes('<svg'), 'HTML did not render Mermaid as a static SVG')
    check(html.includes('katex'), 'HTML did not render math')
    check(html.includes('导出元信息'), 'HTML lost front matter')
    check(!html.includes(window.__writer.apiBase + '/raw/'), 'HTML contains a live local image URL')
    check(html.includes('HTML &lt;标题&gt;'), 'HTML title was not escaped')
    check(!/<script\b/i.test(html), 'HTML export contains application scripts')
    checks.push('portable HTML embeds images, math, front matter and static diagrams')

    const long = Array.from({ length: 50 }, (_, i) => '# Heading ' + i + '\n\nParagraph ' + i).join('\n\n')
    prose = await documentWith(long, 'read')
    await wait(() => document.querySelectorAll('.toc-mark').length === 17, 'long outline does not respect the 17-mark cap')
    check(document.querySelectorAll('.toc-flyout-item').length === 50, 'outline popup lost headings')
    const rail = document.querySelector('.toc-compact')
    rail.scrollTop = rail.scrollHeight; rail.dispatchEvent(new Event('scroll'))
    await pause(80)
    check(document.querySelectorAll('.toc-mark').length <= 17, 'outline exceeds 17 marks while scrolling')
    checks.push('17-mark outline retains all 50 headings')

    selectText(prose, 'Paragraph 25')
    window.__writer.toggle('focus')
    await pause(120)
    check(!!document.querySelector('.writing-current-block'), 'focus mode did not track the selected paragraph')
    window.__writer.toggle('focus')
    window.__writer.toggle('distractionFree')
    await pause(50)
    check(getComputedStyle(document.querySelector('.project-sidebar')).display === 'none', 'immersive mode did not hide the sidebar')
    key(prose, 'Escape')
    await pause(50)
    check(!document.documentElement.classList.contains('writing-immersive'), 'Escape did not leave immersive mode')
    checks.push('focus and immersive modes')

    source = await documentWith(Array.from({ length: 45 }, (_, i) => '第 ' + i + ' 行内容').join('\n'))
    selectSource(source, value().indexOf('第 30 行'))
    window.__writer.toggle('typewriter')
    await wait(() => !!document.querySelector('.resource-reader.writing-typewriter'), 'typewriter mode did not activate')
    await pause(60)
    window.__writer.sourceInput().dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))
    await pause(140)
    const caret = window.__writer.caret()
    const body = source.closest('.reader-body').getBoundingClientRect()
    check(caret.top > body.top + body.height * .30 && caret.top < body.top + body.height * .65, 'typewriter caret was not centered: ' + JSON.stringify({ caretTop: caret.top, bodyTop: body.top, bodyHeight: body.height }))
    window.__writer.toggle('typewriter')
    checks.push('typewriter centering with CodeMirror geometry')

    check(window.__writer.resolveLink('notes/a.md', '../assets/p.png', '\\\\wsl.localhost\\Ubuntu-20.04\\home\\me\\e-wagon') === 'assets/p.png', 'WSL UNC project root was not resolved')
    check(window.__writer.resolveLink('notes/a.md', '/home/me/e-wagon/assets/p.png', '\\\\wsl.localhost\\Ubuntu-20.04\\home\\me\\e-wagon') === 'assets/p.png', 'absolute WSL project image was not resolved')
    checks.push('WSL path resolution fixtures (not a live remote-agent test)')

    await documentWith(rich + '\n' + imageMarkdown, 'read')
    return checks
  }

  app.whenReady().then(async () => {
    try {
      const projectDir = path.join(temp, 'project')
      fs.mkdirSync(projectDir, { recursive: true })
      fs.writeFileSync(path.join(projectDir, 'note.md'), '# Smoke\n')
      sidecar = spawn(path.join(root, 'sidecar/bin/timberd.exe'), ['-addr', '127.0.0.1:0', '-token', 'markdown-smoke', '-data', path.join(temp, 'data')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const port = await new Promise((resolve, reject) => {
        let output = ''
        const timeout = setTimeout(() => reject(new Error('smoke sidecar startup timed out')), 15000)
        sidecar.on('error', reject)
        sidecar.on('exit', code => reject(new Error('smoke sidecar exited: ' + code)))
        sidecar.stdout.on('data', chunk => { output += chunk; const match = output.match(/TIMBERD_READY port=(\d+)/); if (match) { clearTimeout(timeout); resolve(Number(match[1])) } })
      })
      const api = { base: 'http://127.0.0.1:' + port, token: 'markdown-smoke' }
      const response = await fetch(api.base + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Timber-Token': api.token }, body: JSON.stringify({ path: projectDir }) })
      if (!response.ok) throw new Error('smoke project registration failed: ' + await response.text())
      const project = await response.json()
      const { build } = createRequire(require.resolve('vite'))('esbuild')
      const fixture = `
        import { createRoot } from 'react-dom/client'
        import Reader from './src/renderer/src/components/Reader'
        import { useStore } from './src/renderer/src/store'
        import { runMarkdownCommand } from './src/renderer/src/utils/markdownCommands'
        import { toggleWritingPreference } from './src/renderer/src/utils/writingPreferences'
        import { getMarkdownEditor } from './src/renderer/src/utils/markdownEditorRuntime'
        import { renderMarkdownForExport, portableDocumentHtml } from './src/renderer/src/utils/documentExport'
        import MarkdownView, { selectionAnchor, resolveDocLink } from './src/renderer/src/components/MarkdownView'
        import { findAnnotationRange } from './src/renderer/src/utils/textRanges'
        import { THEME_PALETTES, loadSettings } from './src/renderer/src/utils/settings'
        const project = window.__smokeProject
        let tabSequence = 0
        window.__writer = {
          setDocument(markdown, mode) {
            const doc = { path: 'note.md', ext: 'md', content: markdown, size: markdown.length, mtime: Date.now() }
            const tabId = 'smoke-tab-' + (++tabSequence)
            const settings = { ...useStore.getState().settings, autoSaveDelayMs: 600000 }
            useStore.setState({ ready: true, activeProjectId: project.id, projects: [project], activeTabId: tabId, activeDoc: doc, draft: markdown, mode, dirty: false, saving: false, docLoading: false, annotations: [], composeQuote: null, settings, tabs: [{ id: tabId, path: 'note.md', mode, pinned: true, draft: markdown, dirty: false, scrollTop: 0, doc }] })
          },
          draft: () => useStore.getState().draft,
          dirty: () => useStore.getState().dirty,
          mode: mode => useStore.getState().setMode(mode),
          theme: theme => useStore.getState().setSetting('theme', theme),
          setting: (key, value) => useStore.getState().setSetting(key, value),
          settings: () => useStore.getState().settings,
          loadSettings,
          palettes: THEME_PALETTES,
          compose: () => useStore.getState().composeQuote,
          cancelCompose: () => useStore.getState().setComposeQuote(null),
          command: runMarkdownCommand,
          toggle: toggleWritingPreference,
          runtime: getMarkdownEditor,
          value: () => getMarkdownEditor()?.getValue(),
          history: () => getMarkdownEditor()?.root?.CodeMirror?.getHistory?.(),
          sourceInput: () => getMarkdownEditor()?.root.querySelector('textarea'),
          selectSource(start, end) { const editor = getMarkdownEditor(); editor.focus(); editor.setSelectionOffsets(start, end) },
          undo: () => getMarkdownEditor()?.undo(),
          caret: () => getMarkdownEditor()?.caretRect(),
          selectionAnchor: () => selectionAnchor(document.querySelector('.prose')),
          annotationRange(anchor) { return anchor && findAnnotationRange(document.querySelector('.prose'), anchor) },
          resolveLink: resolveDocLink,
          apiBase: window.__smokeApi.base,
          async exportHtml(markdown, title) { return portableDocumentHtml(await renderMarkdownForExport(markdown, 'note.md', project.id), title, project.id) }
        }
        window.__writer.setDocument('# Smoke\\n', 'read')
        createRoot(document.getElementById('root')).render(<div className="app"><div className="app-body"><aside className="project-sidebar" style={{width:140}}>Smoke project</aside><main className="reader-wrap"><Reader /></main></div></div>)
      `
      const bundle = (await build({
        stdin: { contents: fixture, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
        loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl', '.jpg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, tsconfig: path.join(root, 'tsconfig.json'),
        define: { __APP_VERSION__: JSON.stringify(require('../package.json').version), 'process.env.NODE_ENV': '"production"' },
        plugins: [{
          name: 'vite-inline-css',
          setup(build) {
            build.onResolve({ filter: /\.css\?inline$/ }, async args => {
              const request = args.path.replace(/\?inline$/, '')
              const resolved = await build.resolve(request, { resolveDir: args.resolveDir, kind: args.kind })
              return { path: resolved.path, namespace: 'vite-inline-css' }
            })
            build.onLoad({ filter: /.*/, namespace: 'vite-inline-css' }, args => ({ contents: 'export default ' + JSON.stringify(fs.readFileSync(args.path, 'utf8')), loader: 'js' }))
          }
        }]
      })).outputFiles[0].text
      fs.writeFileSync(generated[1], bundle)
      let html = fs.readFileSync(path.join(root, 'out/renderer/index.html'), 'utf8').replace(/<script\b[^>]*src="[^"]+"[^>]*><\/script>/g, '')
      const bootstrap = `window.__smokeApi=${JSON.stringify(api)};window.__smokeProject=${JSON.stringify(project).replace(/</g, '\\u003c')};window.timber={getApiInfo:async()=>window.__smokeApi,onApiInfoChanged:()=>()=>{}};`
      html = html.replace('</body>', `<script>${bootstrap}</script><script src="./__smoke-reader.js"></script></body>`)
      fs.writeFileSync(generated[0], html)
      win = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { backgroundThrottling: false, offscreen: true } })
      win.webContents.on('console-message', (_event, level, message, line, sourceId) => { if (level >= 3) failures.push(`${message} (${sourceId}:${line})`) })
      await win.loadFile(generated[0])
      const checks = await win.webContents.executeJavaScript('(' + runBrowserChecks.toString() + ')()', true)
      const imageFiles = fs.readdirSync(path.join(projectDir, 'assets')).length
      if (imageFiles !== 3) throw new Error('expected three independently saved images, got ' + imageFiles)
      for (const theme of Object.keys(await win.webContents.executeJavaScript('window.__writer.palettes'))) {
        await win.webContents.executeJavaScript(`(async () => {
          window.__writer.theme(${JSON.stringify(theme)})
          const deadline = Date.now() + 5000
          while (!document.querySelector('.timber-muya .mu-container')) {
            if (Date.now() > deadline) throw new Error('Editor did not apply ${theme} theme')
            await new Promise(resolve => setTimeout(resolve, 30))
          }
          document.querySelector('.reader-body').scrollTop = 0
          await new Promise(resolve => setTimeout(resolve, 300))
          const image = document.querySelector('.timber-muya .mu-inline-image img')
          if (!image?.complete || image.naturalWidth !== 2) throw new Error('Image failed after ${theme} theme initialization')
          if (window.__writer.dirty()) throw new Error('${theme} theme initialization marked a pristine document dirty')
          if (document.documentElement.dataset.palette !== ${JSON.stringify(theme)}) throw new Error('${theme} palette was not applied')
          const probe = document.createElement('span')
          probe.style.color = window.__writer.palettes[${JSON.stringify(theme)}].background
          document.body.appendChild(probe)
          const expected = getComputedStyle(probe).color
          probe.remove()
          if (getComputedStyle(document.querySelector('.prose')).backgroundColor !== expected) throw new Error('${theme} editor background does not match the palette')
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        })()`)
        if (['light', 'nord', 'catppuccin-latte', 'dracula'].includes(theme)) fs.writeFileSync(path.join(temp, theme + '.png'), (await win.webContents.capturePage()).toPNG())
      }
      checks.push('all 33 palettes initialize, render and preserve pristine documents')
      fs.writeFileSync(report, JSON.stringify({ passed: true, checks, savedImages: imageFiles, screenshots: temp, consoleErrors: failures }, null, 2))
      sidecar.kill()
      for (const file of generated) fs.unlinkSync(file)
      win.destroy()
      app.exit(0)
    } catch (error) {
      if (win && !win.isDestroyed()) {
        try { fs.writeFileSync(path.join(temp, 'failure.png'), (await win.webContents.capturePage()).toPNG()) } catch {}
      }
      const editorState = win && !win.isDestroyed() ? await win.webContents.executeJavaScript(`({
        draft: window.__writer?.draft(),
        prose: document.querySelector('.prose')?.innerHTML,
        source: window.__writer?.value(),
        history: window.__writer?.history?.(),
        selection: window.getSelection()?.toString()
      })`).catch(() => null) : null
      fs.writeFileSync(report, JSON.stringify({ passed: false, error: String(error.stack || error), editorState, consoleErrors: failures, diagnostics: temp }, null, 2))
      sidecar?.kill()
      // Keep the generated fixture on failure so syntax and runtime errors can be inspected.
      app.exit(1)
    }
  })
}
