// Runs the actual Reader + Vditor in an isolated Electron profile and a temporary project.
// Build first: pnpm build. No installed app, real project or saved preferences are accessed.
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { createRequire } = require('node:module')
const root = path.resolve(__dirname, '..')
const temp = path.join(root, 'tmp', 'markdown-smoke-' + (process.env.TIMBER_SMOKE_ID || Date.now()))

if (!process.versions.electron) {
  fs.mkdirSync(temp, { recursive: true })
  const child = spawn(require('electron'), [__filename], {
    cwd: root, windowsHide: true,
    env: { ...process.env, TIMBER_SMOKE_ID: path.basename(temp).replace('markdown-smoke-', '') },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let diagnostics = ''
  child.stdout.on('data', chunk => { diagnostics += chunk })
  child.stderr.on('data', chunk => { diagnostics += chunk })
  child.on('error', error => { console.error(error); process.exitCode = 1 })
  child.on('exit', code => {
    const report = path.join(temp, 'result.json')
    if (fs.existsSync(report)) console.log(fs.readFileSync(report, 'utf8'))
    if (code && diagnostics) console.error(diagnostics.slice(-12000))
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
    const wait = async (predicate, message, timeout = 12000) => {
      const end = Date.now() + timeout
      while (Date.now() < end) { if (predicate()) return; await pause(30) }
      throw new Error(message)
    }
    const setValue = (element, value) => {
      const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const key = (element, value, options = {}) => element.dispatchEvent(new KeyboardEvent('keydown', { key: value, code: value, bubbles: true, cancelable: true, ...options }))
    const documentWith = async (markdown, mode = 'source') => {
      window.__writer.setDocument(markdown, mode)
      await pause(160)
      await wait(() => mode === 'source' ? !!document.querySelector('.editor-plain') : !!document.querySelector('.prose[contenteditable="true"]'), 'editor did not initialize')
      await pause(80)
      return document.querySelector(mode === 'source' ? '.editor-plain' : '.prose[contenteditable="true"]')
    }
    const selectSource = (ta, start = ta.value.length, end = start) => { ta.focus(); ta.setSelectionRange(start, end); document.dispatchEvent(new Event('selectionchange')) }
    const selectText = (prose, text) => {
      const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) {
        const index = node.data.indexOf(text)
        if (index < 0) continue
        prose.focus()
        const range = document.createRange()
        range.setStart(node, index); range.setEnd(node, index + text.length)
        window.getSelection().removeAllRanges(); window.getSelection().addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
        return
      }
      throw new Error('text missing from editor: ' + text)
    }
    const clickText = text => {
      const button = [...document.querySelectorAll('button')].find(element => element.textContent.trim() === text)
      check(button, 'button missing: ' + text); button.click()
    }
    let ta = await documentWith('- task')
    selectSource(ta)
    key(ta, 'Enter')
    check(ta.value === '- task\n- ', 'source list continuation failed: ' + ta.value)
    key(ta, 'Enter')
    check(ta.value === '- task\n', 'empty source list did not exit')
    checks.push('source list continuation and exit')

    ta = await documentWith('hello')
    selectSource(ta, 0, 5)
    key(ta, 'b', { code: 'KeyB', ctrlKey: true })
    check(ta.value === '**hello**', 'source Ctrl+B did not format selection')
    document.execCommand('undo')
    await pause(60)
    check(ta.value === 'hello', 'source formatting could not be undone')
    selectSource(ta)
    key(ta, '(' , { code: 'Digit9', shiftKey: true })
    check(ta.value === 'hello()', 'shifted bracket was not paired')
    key(ta, ')', { code: 'Digit0', shiftKey: true })
    check(ta.value === 'hello()' && ta.selectionStart === 7, 'closing bracket was duplicated')
    checks.push('source formatting, undo and paired punctuation')

    ta = await documentWith('one\ntwo')
    selectSource(ta, 0, 7)
    key(ta, 'Tab')
    check(ta.value === '  one\n  two', 'source multi-line indent failed')
    key(ta, 'Tab', { shiftKey: true })
    check(ta.value === 'one\ntwo', 'source multi-line outdent failed')
    checks.push('multi-line Tab and Shift+Tab')

    ta = await documentWith('mode switch', 'source')
    setValue(ta, 'mode switch edited')
    await wait(() => window.__writer.draft() === 'mode switch edited', 'source draft did not update before mode switch')
    window.__writer.mode('read')
    await wait(() => !!document.querySelector('.prose[contenteditable="true"]'), 'read mode did not mount after source edit')
    check(window.__writer.draft() === 'mode switch edited', 'mode switch lost source draft')
    window.__writer.mode('source')
    await wait(() => document.querySelector('.editor-plain')?.value === 'mode switch edited', 'source mode did not restore draft')
    checks.push('source and reading mode preserve draft')

    ta = await documentWith('')
    selectSource(ta)
    key(ta, '/')
    await wait(() => !!document.querySelector('.writing-insert-palette'), 'slash palette did not open')
    setValue(document.querySelector('[aria-label="搜索插入格式"]'), '表格')
    setValue(document.querySelector('[aria-label="表格数据行数"]'), '4')
    setValue(document.querySelector('[aria-label="表格列数"]'), '5')
    await pause(60)
    document.querySelector('.writing-insert-list button').click()
    await pause(60)
    check(ta.value.split('\n').filter(Boolean).length === 6 && ta.value.split('\n')[0].split('|').length === 7, 'configured table dimensions were not used')
    checks.push('slash insertion and configurable tables')

    let prose = await documentWith('hello world\n', 'read')
    selectText(prose, 'hello')
    window.__writer.command('bold')
    await wait(() => window.__writer.draft().includes('**hello**'), 'WYSIWYG bold did not reach Markdown draft')
    const bold = prose.querySelector('b, strong')
    check(bold?.textContent === 'hello' && Number(getComputedStyle(bold).fontWeight) >= 600, 'WYSIWYG bold formatting was not rendered')
    await wait(() => !!document.querySelector('.vditor-toolbar [data-type="undo"]:not(.vditor-menu--disabled)'), 'WYSIWYG formatting was not recorded in undo history')
    document.querySelector('.vditor-toolbar [data-type="undo"]').click()
    await wait(() => !window.__writer.draft().includes('**hello**'), 'WYSIWYG toolbar operation was not undoable')
    checks.push('WYSIWYG selection formatting and undo')

    prose = await documentWith('Heading target\n', 'read')
    selectText(prose, 'Heading target')
    window.__writer.command('h2')
    await wait(() => /^## Heading target/m.test(window.__writer.draft()), 'heading transformation was not saved')
    checks.push('WYSIWYG heading transformation')

    const rich = '---\ntitle: 保留元信息\ntags: [markdown, timber]\n---\n\n# 示例\n\nhello world\n\n- [x] done\n- [ ] todo\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```js\nconst n = 1\n```\n\n$$\nE=mc^2\n$$\n\n注释[^note1]\n\n[^note1]: 说明\n'
    prose = await documentWith(rich, 'read')
    selectText(prose, 'hello')
    window.__writer.command('italic')
    await wait(() => window.__writer.draft().includes('*hello*'), 'rich document did not sync')
    const roundTrip = window.__writer.draft()
    for (const fragment of ['title: 保留元信息', 'tags: [markdown, timber]', '| A', 'const n = 1', 'E=mc^2', '[^note1]']) check(roundTrip.includes(fragment), 'Markdown round trip lost: ' + fragment)
    check(/^- \[[xX]\] done$/m.test(roundTrip), 'Markdown round trip lost the completed task')
    checks.push('front matter, task, table, code, math and footnote round trip')

    prose = await documentWith('**hello** HELLO other\n', 'read')
    key(prose, 'h', { code: 'KeyH', ctrlKey: true })
    await wait(() => !!document.querySelector('[aria-label="查找文本"]'), 'Ctrl+H did not open replacement')
    setValue(document.querySelector('[aria-label="查找文本"]'), 'hello')
    setValue(document.querySelector('[aria-label="替换文本"]'), '世界')
    await pause(200)
    clickText('全部替换')
    await wait(() => window.__writer.draft().includes('世界') && !/hello/i.test(window.__writer.draft()), 'WYSIWYG replace all failed: ' + window.__writer.draft())
    check(window.__writer.draft().includes('**世界**'), 'replacement removed existing bold formatting')
    document.querySelector('[aria-label="关闭查找"]').click()
    checks.push('WYSIWYG replace all preserves inline formatting')

    ta = await documentWith('Cat cat scatter')
    key(ta, 'h', { code: 'KeyH', ctrlKey: true })
    await wait(() => !!document.querySelector('[aria-label="替换文本"]'), 'source replace did not open')
    setValue(document.querySelector('[aria-label="查找文本"]'), 'cat')
    setValue(document.querySelector('[aria-label="替换文本"]'), 'dog')
    document.querySelector('[aria-label="全字匹配"]').click()
    document.querySelector('[aria-label="区分大小写"]').click()
    await pause(200)
    clickText('全部替换')
    check(ta.value === 'Cat dog scatter', 'source case-sensitive whole-word replacement failed: ' + ta.value)
    document.querySelector('[aria-label="关闭查找"]').click()
    checks.push('source find/replace with case and whole-word controls')

    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 2
    canvas.getContext('2d').fillRect(0, 0, 2, 2)
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
    const file = new File([blob], 'screenshot.png', { type: 'image/png' })
    ta = await documentWith('图片：\n')
    selectSource(ta)
    let clipboard = new DataTransfer(); clipboard.items.add(file)
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }))
    await wait(() => /!\[screenshot\]\(assets\/image-[a-f0-9]+\.png\)/.test(ta.value), 'clipboard image did not save as a relative source link')
    const imageMarkdown = ta.value
    prose = await documentWith(imageMarkdown + '\n再次粘贴\n', 'read')
    selectText(prose, '再次粘贴')
    clipboard = new DataTransfer(); clipboard.items.add(file)
    prose.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }))
    await wait(() => (window.__writer.draft().match(/assets\/image-/g) || []).length === 2, 'WYSIWYG image insertion failed')
    checks.push('source and WYSIWYG clipboard images saved to project assets')

    const exportSource = imageMarkdown + '\n```mermaid\nflowchart LR\n  A[Start] --> B[End]\n```\n\n$$\nE=mc^2\n$$\n'
    const html = await window.__writer.exportHtml(exportSource, 'HTML <标题>')
    check(html.includes('data:image/png;base64,'), 'HTML did not embed local images')
    check(html.includes('<svg'), 'HTML did not render Mermaid as a static SVG')
    check(!html.includes(window.__writer.apiBase + '/raw/'), 'HTML contains a live local image URL')
    check(html.includes('HTML &lt;标题&gt;'), 'HTML title was not escaped')
    check(!/<script\b/i.test(html), 'HTML export contains application scripts')
    checks.push('portable HTML embeds images and static diagrams')

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

    ta = await documentWith(Array.from({ length: 45 }, (_, i) => '第 ' + i + ' 行内容').join('\n'))
    selectSource(ta, ta.value.indexOf('第 30 行'))
    window.__writer.toggle('typewriter')
    await wait(() => !!document.querySelector('.resource-reader.writing-typewriter'), 'typewriter mode did not activate')
    await pause(60)
    ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))
    await pause(120)
    const caret = window.__writer.caret(ta)
    const body = ta.closest('.reader-body').getBoundingClientRect()
    check(caret.top > body.top + body.height * .30 && caret.top < body.top + body.height * .65, 'typewriter caret was not centered: ' + JSON.stringify({ caretTop: caret.top, bodyTop: body.top, bodyHeight: body.height }))
    window.__writer.toggle('typewriter')
    checks.push('typewriter centering with real textarea line geometry')
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
      const luteFile = fs.readdirSync(path.join(root, 'out/renderer/assets')).find(name => name.startsWith('lute.min-') && name.endsWith('.js'))
      if (!luteFile) throw new Error('Build first: pnpm build')
      const fixture = `
        import { createRoot } from 'react-dom/client'
        import Reader from './src/renderer/src/components/Reader'
        import { useStore } from './src/renderer/src/store'
        import { runMarkdownCommand } from './src/renderer/src/utils/markdownCommands'
        import { toggleWritingPreference } from './src/renderer/src/utils/writingPreferences'
        import { textareaCaretRect } from './src/renderer/src/utils/editorGeometry'
        import { renderMarkdownForExport, portableDocumentHtml } from './src/renderer/src/utils/documentExport'
        const project = window.__smokeProject
        window.__writer = {
          setDocument(markdown, mode) {
            const doc = { path: 'note.md', ext: 'md', content: markdown, size: markdown.length, mtime: Date.now() }
            const settings = { ...useStore.getState().settings, autoSaveDelayMs: 600000 }
            useStore.setState({ ready: true, activeProjectId: project.id, projects: [project], activeTabId: 'smoke-tab', activeDoc: doc, draft: markdown, mode, dirty: false, saving: false, docLoading: false, annotations: [], composeQuote: null, settings, tabs: [{ id: 'smoke-tab', path: 'note.md', mode, pinned: true, draft: markdown, dirty: false, scrollTop: 0, doc }] })
          },
          draft: () => useStore.getState().draft,
          mode: mode => useStore.getState().setMode(mode),
          theme: theme => useStore.getState().setSetting('theme', theme),
          command: runMarkdownCommand, toggle: toggleWritingPreference, caret: textareaCaretRect,
          apiBase: window.__smokeApi.base,
          async exportHtml(markdown, title) { return portableDocumentHtml(await renderMarkdownForExport(markdown, 'note.md', project.id), title, project.id) }
        }
        window.__writer.setDocument('# Smoke\\n', 'read')
        createRoot(document.getElementById('root')).render(<div className="app"><div className="app-body"><aside className="project-sidebar" style={{width:140}}>Smoke project</aside><main className="reader-wrap"><Reader /></main></div></div>)
      `
      const bundle = (await build({ stdin: { contents: fixture, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
        loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' }, tsconfig: path.join(root, 'tsconfig.json'),
        define: { __APP_VERSION__: JSON.stringify(require('../package.json').version), 'process.env.NODE_ENV': '"production"' },
        plugins: [{ name: 'lute-url', setup(build) { build.onResolve({ filter: /\?url$/ }, args => ({ path: args.path, namespace: 'lute-url' })); build.onLoad({ filter: /.*/, namespace: 'lute-url' }, () => ({ contents: 'export default ' + JSON.stringify('./assets/' + luteFile), loader: 'js' })) } }]
      })).outputFiles[0].text
      fs.writeFileSync(generated[1], bundle)
      let html = fs.readFileSync(path.join(root, 'out/renderer/index.html'), 'utf8').replace(/<script\b[^>]*src="[^"]+"[^>]*><\/script>/g, '')
      const bootstrap = `window.__smokeApi=${JSON.stringify(api)};window.__smokeProject=${JSON.stringify(project).replace(/</g, '\\u003c')};window.timber={getApiInfo:async()=>window.__smokeApi,onApiInfoChanged:()=>()=>{}};`
      html = html.replace('</body>', `<script>${bootstrap}</script><script src="./__smoke-reader.js"></script></body>`)
      fs.writeFileSync(generated[0], html)
      win = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { backgroundThrottling: false, offscreen: true } })
      win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) failures.push(message) })
      await win.loadFile(generated[0])
      const checks = await win.webContents.executeJavaScript('(' + runBrowserChecks.toString() + ')()', true)
      const imageFiles = fs.readdirSync(path.join(projectDir, 'assets')).length
      if (imageFiles !== 2) throw new Error('expected two independently saved images, got ' + imageFiles)
      for (const theme of ['light', 'dark']) {
        await win.webContents.executeJavaScript(`(async () => {
          window.__writer.theme(${JSON.stringify(theme)})
          const deadline = Date.now() + 5000
          while (!document.querySelector(${JSON.stringify(theme === 'dark' ? '.vditor--dark .prose' : '.vditor:not(.vditor--dark) .prose')})) {
            if (Date.now() > deadline) throw new Error('Editor did not apply ${theme} theme')
            await new Promise(resolve => setTimeout(resolve, 30))
          }
          document.querySelector('.reader-body').scrollTop = 0
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        })()`)
        fs.writeFileSync(path.join(temp, theme + '.png'), (await win.webContents.capturePage()).toPNG())
      }
      checks.push('light and dark themes initialize and render')
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
        source: document.querySelector('.editor-plain')?.value,
        selection: window.getSelection()?.toString()
      })`).catch(() => null) : null
      fs.writeFileSync(report, JSON.stringify({ passed: false, error: String(error.stack || error), editorState, consoleErrors: failures, diagnostics: temp }, null, 2))
      sidecar?.kill()
      for (const file of generated) { if (fs.existsSync(file)) fs.unlinkSync(file) }
      app.exit(1)
    }
  })
}
