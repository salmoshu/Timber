const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawn } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const temp = path.join(root, 'tmp', 'code-app-smoke-' + (process.env.TIMBER_CODE_SMOKE_ID || Date.now()))
const projectDir = path.join(temp, 'code project')
const definitionFile = path.join(projectDir, 'index.ts')
const referenceFile = path.join(projectDir, 'consumer.ts')

if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE) {
  fs.mkdirSync(temp, { recursive: true })
  const env = { ...process.env, TIMBER_CODE_SMOKE_ID: path.basename(temp).replace('code-app-smoke-', '') }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename], { cwd: root, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let diagnostics = ''
  child.stdout.on('data', chunk => { diagnostics += chunk })
  child.stderr.on('data', chunk => { diagnostics += chunk })
  child.on('error', error => { console.error(error); process.exitCode = 1 })
  child.on('exit', code => {
    const report = path.join(temp, 'result.json')
    if (fs.existsSync(report)) console.log(fs.readFileSync(report, 'utf8'))
    if (code) console.error(diagnostics.slice(-12000))
    process.exitCode = code || 0
  })
} else {
  const { app, BrowserWindow } = require('electron')
  app.on('will-quit', () => app.exit(process.exitCode || 0))
  app.setPath('userData', path.join(temp, 'profile'))
  app.getAppPath = () => root
  app.getVersion = () => require('../package.json').version
  app.on('browser-window-created', (_event, window) => {
    window.webContents.setBackgroundThrottling(false)
    window.on('show', () => window.hide())
  })
  fs.mkdirSync(path.join(temp, 'profile/sidecar-data'), { recursive: true })
  fs.mkdirSync(projectDir, { recursive: true })
  fs.writeFileSync(definitionFile, "export function greet(name: string): string { return 'Hello ' + name }\n")
  fs.writeFileSync(referenceFile, "import { greet } from './index'\nexport const message = greet('Timber')\n")
  fs.writeFileSync(path.join(projectDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, moduleResolution: 'node' } }))
  fs.writeFileSync(path.join(temp, 'profile/sidecar-data/projects.json'), JSON.stringify({ projects: [{ id: 'code-smoke', name: 'Code project', path: projectDir, addedAt: new Date().toISOString(), docCount: 0 }] }))
  let win
  const consoleErrors = []
  const checks = []
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  const evaluate = source => win.webContents.executeJavaScript(source, true)
  const wait = async (predicate, message, timeout = 20000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (await predicate()) return
      await pause(100)
    }
    throw new Error(message)
  }
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const key = (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }
  const textPoint = needle => evaluate(`(() => {
    const walker = document.createTreeWalker(document.querySelector('.code-editor-host .view-lines'), NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) if (node.data.includes(${JSON.stringify(needle)})) break
    if (!node) return null
    const start = node.data.indexOf(${JSON.stringify(needle)})
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, start + ${JSON.stringify(needle)}.length)
    const rect = range.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  })()`)
  const timeout = setTimeout(() => {
    fs.writeFileSync(path.join(temp, 'result.json'), JSON.stringify({ passed: false, error: 'Code smoke timed out', checks, consoleErrors }))
    process.exitCode = 1
    app.quit()
  }, 90000)

  import(pathToFileURL(path.join(root, 'out/main/index.js')).href).then(async () => {
    try {
      await wait(() => { win = BrowserWindow.getAllWindows()[0]; return !!win }, 'Main window was not created')
      win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) consoleErrors.push(message) })
      await wait(() => evaluate("!!document.querySelector('.tree-doc .doc-name')").catch(() => false), 'Code project tree did not load')
      await evaluate("[...document.querySelectorAll('.tree-doc .doc-name')].find(node => node.textContent === 'consumer.ts').click()")
      await wait(() => evaluate("!!document.querySelector('.code-editor-host .monaco-editor') && document.querySelector('.code-editor-status.ready')"), 'Monaco or TypeScript language service did not become ready', 30000)
      await wait(() => evaluate("document.querySelectorAll('.code-editor-host .view-line').length > 0").catch(() => false), 'Monaco did not paint its first frame', 5000)
      const renderState = await evaluate("({ path: document.querySelector('.code-editor-host')?.dataset.codePath, lines: document.querySelectorAll('.code-editor-host .view-line').length, text: document.querySelector('.code-editor-host')?.textContent.slice(0, 300), status: document.querySelector('.code-editor-status')?.textContent, sizes: ['.code-editor-host', '.code-editor-shell', '.reader', '.code-editor-host .monaco-editor'].map(selector => { const rect = document.querySelector(selector)?.getBoundingClientRect(); return [selector, rect?.width, rect?.height] }) })")
      check(renderState.path === 'consumer.ts' && renderState.lines > 0, 'Code model did not render: ' + JSON.stringify({ ...renderState, html: await evaluate("document.querySelector('.code-editor-host').innerHTML.slice(0, 3000)") }))
      checks.push('production Monaco mounts with a live TypeScript language service')
      await evaluate("window.__codeRejections = []; window.addEventListener('unhandledrejection', event => window.__codeRejections.push({ name: event.reason?.name, message: event.reason?.message, stack: event.reason?.stack })); undefined")
      await pause(750)
      const directDefinition = await evaluate(`window.timber.codeDefinition(${JSON.stringify({ rootPath: projectDir, path: 'consumer.ts', languageId: 'typescript' })}, { line: 1, character: 24 })`)
      check(directDefinition.some(item => item.path === 'index.ts'), 'Production IPC did not return the definition: ' + JSON.stringify(directDefinition))

      win.webContents.focus()
      await evaluate("document.querySelector('.code-editor-host textarea')?.focus()")
      key('F', ['control'])
      await win.webContents.insertText('greet')
      check(await evaluate("document.querySelector('.find-widget .input')?.value === 'greet'"), 'Monaco find input did not receive native text')
      key('Escape')
      key('F12')
      await wait(() => evaluate("document.querySelector('.code-editor-host')?.dataset.codePath === 'index.ts'"), 'F12 did not navigate to the cross-file definition')
      await wait(() => evaluate("!!document.querySelector('.code-editor-status.ready')"), 'Language service did not recover after navigation')
      checks.push('F12 opens a cross-file definition through Timber tabs')

      const beforeReferences = await evaluate(`(async () => ({ active: document.activeElement?.outerHTML.slice(0, 250), meta: document.querySelector('.cv-meta')?.textContent, references: await window.timber.codeReferences(${JSON.stringify({ rootPath: projectDir, path: 'index.ts', languageId: 'typescript' })}, { line: 0, character: 18 }) }))()`)
      key('F12', ['shift'])
      await pause(1500)
      const referenceState = await evaluate("({ peek: document.querySelector('.peekview-widget')?.textContent, active: document.activeElement?.outerHTML.slice(0, 250), meta: document.querySelector('.cv-meta')?.textContent, status: document.querySelector('.code-editor-status')?.outerHTML })")
      check(referenceState.peek?.includes('consumer.ts'), 'Reference peek did not include the consumer file: ' + JSON.stringify({ beforeReferences, referenceState }))
      key('Escape')
      checks.push('Shift+F12 displays cross-file references in Monaco peek')

      key('Left', ['alt'])
      await wait(() => evaluate("document.querySelector('.code-editor-host')?.dataset.codePath === 'consumer.ts'"), 'Alt+Left did not restore the reference file')
      key('Right', ['alt'])
      await wait(() => evaluate("document.querySelector('.code-editor-host')?.dataset.codePath === 'index.ts'"), 'Alt+Right did not return to the definition')
      checks.push('cross-file back and forward history')

      key('Left', ['alt'])
      await wait(() => evaluate("document.querySelector('.code-editor-host')?.dataset.codePath === 'consumer.ts'"), 'Could not return to the consumer for Ctrl+Click')
      await wait(() => evaluate("document.querySelector('.code-editor-host .view-lines')?.textContent.includes('greet')").catch(() => false), 'Consumer did not repaint before Ctrl+Click')
      const clickPoint = await textPoint('greet')
      check(clickPoint, 'Could not locate the symbol for Ctrl+Click')
      win.webContents.sendInputEvent({ type: 'mouseDown', x: clickPoint.x, y: clickPoint.y, button: 'left', clickCount: 1, modifiers: ['control'] })
      win.webContents.sendInputEvent({ type: 'mouseUp', x: clickPoint.x, y: clickPoint.y, button: 'left', clickCount: 1, modifiers: ['control'] })
      await wait(() => evaluate("document.querySelector('.code-editor-host')?.dataset.codePath === 'index.ts'"), 'Ctrl+Click did not open the definition')
      await wait(() => evaluate("document.querySelector('.code-editor-host .view-lines')?.textContent.includes('greet')").catch(() => false), 'Definition did not repaint before hover')
      const hoverPoint = await textPoint('greet')
      check(hoverPoint, 'Could not locate the symbol for hover')
      const directHover = await evaluate(`window.timber.codeHover(${JSON.stringify({ rootPath: projectDir, path: 'index.ts', languageId: 'typescript' })}, { line: 0, character: 18 })`)
      check(directHover?.contents.some(item => item.includes('greet')), 'Production hover IPC did not return symbol information')
      win.webContents.sendInputEvent({ type: 'mouseMove', x: hoverPoint.x, y: hoverPoint.y })
      key('K', ['control'])
      key('I', ['control'])
      await wait(() => evaluate("[...document.querySelectorAll('.monaco-hover, .monaco-hover-content')].some(element => element.textContent.includes('greet'))"), 'Hover did not show symbol information')
      key('Escape')
      checks.push('Ctrl+Click navigation and semantic hover')

      key('O', ['control', 'shift'])
      await wait(() => evaluate("!!document.querySelector('.quick-input-widget') && document.querySelector('.quick-input-widget').textContent.includes('greet')"), 'Document outline did not list the function')
      key('Escape')
      checks.push('current-file symbol outline')

      key('T', ['control'])
      await wait(() => evaluate("!!document.querySelector('.code-symbol-input')"), 'Workspace symbol search did not open')
      await win.webContents.insertText('greet')
      await wait(() => evaluate("!!document.querySelector('.code-symbol-item')"), 'Workspace symbol search returned no result')
      key('Enter')
      await wait(() => evaluate("!document.querySelector('.code-symbol-palette') && document.querySelector('.code-editor-host')?.dataset.codePath === 'index.ts'"), 'Workspace symbol did not navigate to its definition')
      checks.push('workspace symbol search and navigation')

      const image = await win.webContents.capturePage()
      fs.writeFileSync(path.join(temp, 'code-editor.png'), image.toPNG())
      const unhandled = await evaluate("window.__codeRejections")
      check(consoleErrors.length === 0, 'Renderer errors: ' + consoleErrors.join('\n') + '\n' + JSON.stringify(unhandled))
      fs.writeFileSync(path.join(temp, 'result.json'), JSON.stringify({ passed: true, checks, consoleErrors, screenshots: temp }, null, 2))
      clearTimeout(timeout)
      app.quit()
    } catch (error) {
      if (win && !win.isDestroyed()) {
        const image = await win.webContents.capturePage().catch(() => null)
        if (image) fs.writeFileSync(path.join(temp, 'failure.png'), image.toPNG())
      }
      fs.writeFileSync(path.join(temp, 'result.json'), JSON.stringify({ passed: false, checks, error: String(error.stack || error), consoleErrors, screenshots: temp }, null, 2))
      clearTimeout(timeout)
      process.exitCode = 1
      app.quit()
    }
  }).catch(error => { console.error(error); process.exitCode = 1; clearTimeout(timeout); app.quit() })
}
