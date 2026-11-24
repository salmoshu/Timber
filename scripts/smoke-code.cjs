const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawn } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const packagedDir = process.env.TIMBER_CODE_SMOKE_PACKAGE ? path.resolve(root, process.env.TIMBER_CODE_SMOKE_PACKAGE) : null
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
  const appRoot = packagedDir ? path.join(packagedDir, 'resources', 'app.asar') : root
  if (packagedDir) {
    Object.defineProperty(app, 'isPackaged', { value: true })
    Object.defineProperty(process, 'resourcesPath', { value: path.join(packagedDir, 'resources') })
  }
  app.getAppPath = () => appRoot
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
  const nativeFiles = {
    'native-api.hpp': '#pragma once\nnamespace app {\nint measure(int value);\ndouble measure(double value);\n}\nnamespace other { int measure(int value); }\n',
    'native-api.cpp': '#include "native-api.hpp"\nint app::measure(int value) { return value; }\ndouble app::measure(double value) { return value; }\nint other::measure(int value) { return -value; }\n',
    'native-call.cpp': '#include "native-api.hpp"\n#if TIMBER_NATIVE\nint start() { return app::measure(1); }\n#endif\n',
    'native-client.cpp': '#include "native-api.hpp"\nint fromClient() { return app::measure(2); }\n',
    'native-other.cpp': '#include "native-api.hpp"\nint fromOther() { return other::measure(3); }\ndouble fromDouble() { return app::measure(4.0); }\n'
  }
  for (const [file, source] of Object.entries(nativeFiles)) fs.writeFileSync(path.join(projectDir, file), source)
  fs.writeFileSync(path.join(projectDir, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.16)\nproject(TimberSmoke LANGUAGES CXX)\n')
  fs.writeFileSync(path.join(projectDir, 'Makefile'), 'all:\n\t@echo Timber\n')
  const nativeBuild = path.join(projectDir, 'build')
  fs.mkdirSync(nativeBuild)
  fs.writeFileSync(path.join(nativeBuild, 'compile_commands.json'), JSON.stringify(Object.keys(nativeFiles).filter(file => file.endsWith('.cpp')).map(name => {
    const file = path.join(projectDir, name)
    return { directory: nativeBuild, file, arguments: ['clang++', '-DTIMBER_NATIVE=1', '-c', file] }
  })))
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
  const click = ({ x, y }, clickCount = 1) => {
    for (let count = 1; count <= clickCount; count++) {
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: count })
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: count })
    }
  }
  const openFile = name => evaluate(`(() => {
    const file = [...document.querySelectorAll('.tree-doc .doc-name')].find(node => node.textContent === ${JSON.stringify(name)})
    if (!file) return false
    file.click()
    return true
  })()`)
  const waitCodePath = name => wait(() => evaluate(`document.querySelector('.code-editor-host')?.dataset.codePath === ${JSON.stringify(name)}`), `${name} did not open in Monaco`)
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
  }, 120000)

  import(pathToFileURL(path.join(appRoot, 'out/main/index.js')).href).then(async () => {
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
      await wait(() => evaluate("!document.querySelector('.peekview-widget')"), 'Reference peek did not close with Escape')
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

      check(await openFile('CMakeLists.txt'), 'CMakeLists.txt did not appear in the project tree')
      await waitCodePath('CMakeLists.txt')
      await wait(() => evaluate("[...document.querySelectorAll('.code-editor-host .view-line span[class^=mtk]')].some(node => node.textContent === 'cmake_minimum_required')"), 'CMake command was not tokenized')
      check(await openFile('Makefile'), 'Extensionless Makefile did not appear in the project tree')
      await waitCodePath('Makefile')
      checks.push('CMake and extensionless Makefile open from the project tree')

      check(await openFile('native-call.cpp'), 'C++ source did not appear in the project tree')
      await waitCodePath('native-call.cpp')
      await wait(() => evaluate("!!document.querySelector('.code-editor-status.ready') && document.querySelector('.code-editor-status').textContent.includes('clangd')"), 'The code editor did not connect to clangd')
      const nativeDocument = { rootPath: projectDir, path: 'native-call.cpp', languageId: 'cpp' }
      await wait(async () => {
        const definitions = await evaluate(`window.timber.codeDefinition(${JSON.stringify(nativeDocument)}, { line: 2, character: 28 })`)
        return definitions.length === 1 && definitions[0].path === 'native-api.cpp' && definitions[0].range.start.line === 1
      }, 'clangd did not resolve the configured call to the correct overload')
      await wait(() => textPoint('measure').catch(() => null), 'C++ caller did not paint')
      win.webContents.focus()
      await evaluate("document.querySelector('.code-editor-host textarea')?.focus()")
      key('Home', ['control'])
      key('Down')
      key('Down')
      const column = nativeFiles['native-call.cpp'].split('\n')[2].indexOf('measure') + 2
      for (let step = 0; step < column; step++) key('Right')
      await wait(() => evaluate("document.querySelector('.cv-meta')?.textContent.includes('3:" + (column + 1) + "')"), 'Native keyboard did not place the cursor on the C++ call')
      key('F12')
      await waitCodePath('native-api.cpp')
      await wait(() => evaluate("!!document.querySelector('.code-editor-status.ready') && document.querySelector('.cv-meta')?.textContent.includes('2:')"), 'F12 selected the wrong overload')
      checks.push('C++ F12 jumps to the exact implementation through production IPC')

      const nativeDefinition = { rootPath: projectDir, path: 'native-api.cpp', languageId: 'cpp' }
      await wait(async () => {
        const references = await evaluate(`window.timber.codeReferences(${JSON.stringify(nativeDefinition)}, { line: 1, character: 10 })`)
        return references.some(item => item.path === 'native-client.cpp')
      }, 'clangd did not finish indexing the unopened consumer')
      key('F12', ['shift'])
      await wait(() => evaluate("[...document.querySelectorAll('.peekview-widget .reference-file')].some(node => node.textContent.includes('native-client.cpp'))"), 'C++ reference peek did not include the unopened consumer')
      check(await evaluate("!document.querySelector('.peekview-widget')?.textContent.includes('native-other.cpp')"), 'C++ reference peek mixed in an unrelated overload or namespace')
      await evaluate(`(() => {
        const group = [...document.querySelectorAll('.peekview-widget .reference-file')].find(node => node.textContent.includes('native-client.cpp'))
        const twistie = group?.closest('.monaco-list-row')?.querySelector('.monaco-tl-twistie.collapsed')
        twistie?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
      })()`)
      let clientReference
      await wait(async () => {
        clientReference = await evaluate(`(() => {
          const row = [...document.querySelectorAll('.peekview-widget .monaco-list-row')].find(node => node.textContent.includes('measure(2)'))
          if (!row) return null
          const rect = row.getBoundingClientRect()
          const x = Math.round(rect.left + rect.width / 2)
          const y = Math.round(rect.top + rect.height / 2)
          return row.contains(document.elementFromPoint(x, y)) ? { x, y } : null
        })()`)
        return clientReference
      }, 'C++ reference row did not become visible')
      click(clientReference, 2)
      await waitCodePath('native-client.cpp')
      await wait(() => evaluate("document.querySelector('.cv-meta')?.textContent.includes('2:')"), 'Reference jump did not select the call site')
      key('Left', ['alt'])
      await waitCodePath('native-api.cpp')
      await wait(() => evaluate("!!document.querySelector('.code-editor-status.ready')"), 'clangd did not reconnect after returning')
      key('O', ['alt'])
      await waitCodePath('native-api.hpp')
      checks.push('C++ references open the call site, preserve history, and switch to the header')

      const image = await win.webContents.capturePage().catch(() => null)
      if (image) fs.writeFileSync(path.join(temp, 'code-editor.png'), image.toPNG())
      const unhandled = await evaluate("window.__codeRejections")
      check(consoleErrors.length === 0, 'Renderer errors: ' + consoleErrors.join('\n') + '\n' + JSON.stringify(unhandled))
      check(unhandled.length === 0, 'Unhandled renderer rejections: ' + JSON.stringify(unhandled))
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
