// Exercises the production main/preload/renderer with an isolated profile and temporary documents.
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawn, spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const temp = path.join(root, 'tmp', 'app-smoke-' + (process.env.TIMBER_APP_SMOKE_ID || Date.now()))
const projectDir = path.join(temp, 'folder with spaces')
const first = path.join(projectDir, '首次打开 & 空格.md')
const second = path.join(projectDir, 'second.markdown')
const extraDocs = Array.from({ length: 18 }, (_, index) => `overflow-${String(index + 1).padStart(2, '0')}.md`)

if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE) {
  fs.mkdirSync(temp, { recursive: true })
  const env = { ...process.env, TIMBER_APP_SMOKE_ID: path.basename(temp).replace('app-smoke-', '') }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename, first], { cwd: root, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
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
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.on('browser-window-created', (_event, window) => {
    window.webContents.setBackgroundThrottling(false)
    window.on('show', () => window.hide())
  })
  const secondary = process.env.TIMBER_APP_SMOKE_SECONDARY === '1'
  if (!secondary) {
    fs.mkdirSync(path.join(temp, 'profile/sidecar-data'), { recursive: true })
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(first, '# first-open\n\nAnnotation text.\n')
    fs.writeFileSync(second, '# second-open\n\n![large](large.png)\n')
    fs.copyFileSync(path.join(root, 'build/icon.png'), path.join(projectDir, 'large.png'))
    fs.writeFileSync(path.join(projectDir, 'index.ts'), 'export const answer = 42\n')
    for (const name of extraDocs) fs.writeFileSync(path.join(projectDir, name), `# ${name}\n`)
    const git = (...args) => {
      const result = spawnSync('git', args, { cwd: projectDir, stdio: 'pipe' })
      if (result.status !== 0) throw new Error('Git fixture setup failed: ' + result.stderr)
    }
    git('init')
    git('add', '.')
    git('-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.com', 'commit', '-m', 'initial')
    git('tag', 'smoke-base')
    fs.writeFileSync(path.join(projectDir, 'index.ts'), 'export const answer = 43\n')
    git('-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.com', 'commit', '-am', 'fix: update answer')
    fs.writeFileSync(path.join(temp, 'profile/sidecar-data/projects.json'), JSON.stringify({ projects: [{ id: 'smoke-folder', name: 'Project folder', path: projectDir, addedAt: new Date().toISOString(), docCount: 2 }] }))
  }
  let win
  const consoleErrors = []
  const checks = []
  const screenshotWarnings = []
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  const evaluate = source => win.webContents.executeJavaScript(source, true)
  const choose = (selector, value) => evaluate(`(() => {
    const select = document.querySelector(${JSON.stringify(selector)})
    select.value = ${JSON.stringify(value)}
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  const chooseView = value => choose('.tb-view-select', value)
  const fill = (selector, value) => evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)})
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  const screenshot = async (name, optional = false) => {
    // Wake a hidden compositor before taking the review image. A capture without
    // priming can return the previous page, and an invisible RAF can stay paused.
    let timer
    try {
      const capture = async () => {
        for (let attempt = 0; ; attempt++) {
          try { return await win.webContents.capturePage(undefined, { stayAwake: true }) }
          catch (error) {
            if (!String(error).includes('Current display surface not available') || attempt >= 4) throw error
            await pause(150)
          }
        }
      }
      const captured = await Promise.race([
        (async () => {
          await capture()
          await pause(150)
          return capture()
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Screenshot timed out: ' + name)), 15000) })
      ])
      fs.writeFileSync(path.join(temp, name), captured.toPNG())
    } catch (error) {
      // The final overview is diagnostic; Windows can discard a hidden surface
      // after reload even though all live DOM and native-input checks passed.
      if (!optional || !String(error).includes('Current display surface not available')) throw error
      screenshotWarnings.push({ name, error: String(error) })
    } finally { clearTimeout(timer) }
  }
  const wait = async (predicate, message, timeout = 20000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (await predicate()) return
      await pause(80)
    }
    throw new Error(message)
  }
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const key = (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }
  const timeout = secondary ? null : setTimeout(() => {
    fs.writeFileSync(path.join(temp, 'result.json'), JSON.stringify({ passed: false, error: 'Application smoke timed out', checks, consoleErrors }))
    process.exitCode = 1
    app.quit()
  }, 120000)

  import(pathToFileURL(path.join(root, 'out/main/index.js')).href).then(async () => {
    if (secondary) return
    try {
      await wait(() => { win = BrowserWindow.getAllWindows()[0]; return !!win }, 'Main window was not created')
      win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) consoleErrors.push(message) })
      await wait(() => evaluate("document.querySelector('.prose')?.textContent.includes('first-open')").catch(() => false), 'Cold-start Markdown argument was not opened')
      check(await evaluate("document.querySelector('.tb-view-select').value === 'resources' && [...document.querySelectorAll('.tb-view-select option:disabled')].map(option => option.value).join(',') === 'architecture,history'"), 'Project features are enabled for a single file')
      check(await evaluate("!document.querySelector('.writing-toolbar, .ann-pop')"), 'Removed Timber toolbars remain')
      check(await evaluate("document.querySelector('[aria-label=\"源码模式\"]')?.getAttribute('role') === 'switch' && document.querySelector('[aria-label=\"源码模式\"]')?.querySelectorAll('svg').length === 2 && document.querySelector('[aria-label=\"源码模式\"]')?.textContent.trim() === '' && document.querySelector('[aria-label=\"分页预览\"]')?.tagName === 'BUTTON' && document.querySelector('[aria-label=\"分页预览\"]')?.hasAttribute('aria-pressed') && document.querySelector('[aria-label=\"分页预览\"]')?.querySelector('svg') && document.querySelector('[aria-label=\"分页预览\"]')?.textContent.trim() === ''"), 'Read/source switch and page preview are not accessible icon controls')
      checks.push('cold-start file argument with Chinese, spaces and ampersand; single-file feature gates')

      const drag = await evaluate(`(() => {
        const walker = document.createTreeWalker(document.querySelector('.prose'), NodeFilter.SHOW_TEXT)
        let node
        while ((node = walker.nextNode())) if (node.data.includes('first-open')) break
        const range = document.createRange()
        range.selectNodeContents(node)
        const rect = range.getBoundingClientRect()
        return { startX: Math.round(rect.left + 2), endX: Math.round(rect.right - 2), y: Math.round(rect.top + rect.height / 2) }
      })()`)
      win.webContents.sendInputEvent({ type: 'mouseDown', x: drag.startX, y: drag.y, button: 'left', clickCount: 1 })
      for (let step = 1; step <= 8; step++) win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(drag.startX + (drag.endX - drag.startX) * step / 8), y: drag.y, buttons: 1 })
      win.webContents.sendInputEvent({ type: 'mouseUp', x: drag.endX, y: drag.y, button: 'left', clickCount: 1 })
      await wait(() => evaluate("window.getSelection().toString().includes('first-open')"), 'Native drag selection disappeared')
      await wait(() => evaluate("Number(getComputedStyle(document.querySelector('.mu-format-picker-container')).opacity) === 1"), 'Native drag selection did not show the format toolbar')
      check(await evaluate("Number(getComputedStyle(document.querySelector('.titlebar')).zIndex) > Number(getComputedStyle(document.querySelector('.tabs-bar')).zIndex)"), 'Block hover controls can overlap the titlebar')
      checks.push('native drag selection preserves the selected text and format toolbar')

      await evaluate("document.querySelector('[aria-label=\"源码模式\"]').click()")
      await wait(() => evaluate("!!document.querySelector('.CodeMirror textarea')"), 'Source switch did not mount CodeMirror')
      win.webContents.focus()
      await evaluate("document.querySelector('.CodeMirror').CodeMirror.focus()")
      key('A', ['control'])
      await win.webContents.insertText('# edited-native\n')
      await wait(() => evaluate("document.querySelector('.CodeMirror')?.textContent.includes('edited-native')"), 'Native source input did not reach the editor')
      const titlebarHeight = await evaluate("document.querySelector('.titlebar').getBoundingClientRect().height")
      check(Math.abs(titlebarHeight - 44) < 1, 'Titlebar does not use the standard 44px height: ' + titlebarHeight)
      check(await evaluate(`(() => {
        const preview = document.querySelector('.reader-preview-button').getBoundingClientRect()
        return [...document.querySelectorAll('.tabs-actions .rt-btn')].every(button => {
          const rect = button.getBoundingClientRect()
          return rect.width === preview.width && rect.height === preview.height
        })
      })()`), 'Export and annotation buttons do not match the page-preview button size')
      check(await evaluate(`(() => {
        const name = document.querySelector('.doc-tab.active .tab-name').getBoundingClientRect()
        const dot = document.querySelector('.doc-tab.active .tab-close.dirty .tc-dot').getBoundingClientRect()
        return Math.abs((name.top + name.height / 2) - (dot.top + dot.height / 2)) <= 1
      })()`), 'Dirty dot is not vertically centered with the tab filename')
      checks.push('standard titlebar, matching tab action sizes and centered dirty indicator')
      key('Z', ['control'])
      await wait(() => evaluate("document.querySelector('.CodeMirror')?.textContent.includes('first-open')"), 'Native Ctrl+Z failed')
      key('Y', ['control'])
      await wait(() => evaluate("document.querySelector('.CodeMirror')?.textContent.includes('edited-native')"), 'Native Ctrl+Y failed')
      key('S', ['control'])
      await wait(() => fs.readFileSync(first, 'utf8') === '# edited-native\n', 'Single-file save did not reach the original file')
      checks.push('real keyboard undo, redo and save through production preload and sidecar')

      await evaluate("[...document.querySelectorAll('.sb-tabs button')].find(button => button.textContent.trim() === '最近').click()")
      await wait(() => evaluate("!!document.querySelector('.rf-item')"), 'Recent file is missing')
      await evaluate("document.querySelector('.rf-item').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,cancelable:true,clientX:1100,clientY:210}))")
      check(await evaluate("['打开文档','复制相对路径','复制绝对路径','在资源管理器中显示','从最近记录移除'].every(label => [...document.querySelectorAll('.ctx-item')].some(item => item.textContent === label))"), 'Recent-file context menu is incomplete')
      await evaluate("[...document.querySelectorAll('.ctx-item')].find(button => button.textContent === '从最近记录移除').click()")
      await wait(() => evaluate("!document.querySelector('.rf-item')"), 'Removing a recent entry did not refresh the list')
      check(fs.existsSync(first), 'Removing a recent entry deleted the document')
      checks.push('recent-file context menu and removal without deleting the file')

      await evaluate("document.querySelector('.proj-import').click()")
      await wait(() => evaluate("!!document.querySelector('.remote-dialog .rd-choice')"), 'Add-project choices did not open')
      await evaluate("document.querySelector('.remote-dialog .rd-choice').click()")
      await wait(() => evaluate("!!document.querySelector('.local-path-picker .path-selection')"), 'Local project directory picker did not open')
      check(await evaluate("document.querySelector('.path-list-head')?.textContent.includes('子文件夹') && !!document.querySelector('.path-folder-icon svg') && !!document.querySelector('.path-selection-meta')"), 'Directory picker is missing its structured list, icons or selection metadata')
      await screenshot('project-directory-picker.png')
      await evaluate("document.querySelector('.local-path-picker [data-cancel]').click()")
      await wait(() => evaluate("!document.querySelector('.local-path-picker')"), 'Directory picker did not close')
      await evaluate("document.querySelector('.remote-dialog .st-close')?.click()")
      await wait(() => evaluate("!document.querySelector('.remote-dialog')"), 'Add-project dialog did not close')
      checks.push('structured project directory picker with folder counts and current selection')

      await evaluate("document.querySelector('.tb-set[title=\"设置\"]').click()")
      await wait(() => evaluate("!!document.querySelector('.theme-picker')"), 'Appearance settings did not open')
      check(await evaluate("document.querySelectorAll('.theme-option').length === 34"), 'Expected 33 palettes plus system theme')
      await evaluate("[...document.querySelectorAll('.theme-option')].find(button => button.textContent.endsWith('Nord')).click()")
      await wait(() => evaluate("document.documentElement.dataset.palette === 'nord'"), 'Nord palette did not apply')
      await screenshot('settings-nord.png')
      await evaluate("document.querySelector('[data-section=\"ai\"]').click()")
      await wait(() => evaluate("!!document.querySelector('[aria-label=\"一键优化提示词\"]')"), 'Architecture optimization prompt is missing from AI settings')
      const defaultPrompt = await evaluate("document.querySelector('[aria-label=\"一键优化提示词\"]').value")
      check(defaultPrompt.includes('完全基于当前项目的源码') && defaultPrompt.includes('不要参考现有 AI 画布'), 'Default optimization prompt does not enforce source-backed generation')
      await evaluate(`(() => {
        const input = document.querySelector('[aria-label="一键优化提示词"]')
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '自定义架构提示词')
        input.dispatchEvent(new Event('input', {bubbles:true}))
      })()`)
      await evaluate("[...document.querySelectorAll('.ai-settings-heading button')].find(button => button.textContent === '恢复默认').click()")
      check(await evaluate("document.querySelector('[aria-label=\"一键优化提示词\"]').value") === defaultPrompt, 'Optimization prompt reset did not restore the default')
      checks.push('configurable source-backed optimization prompt and reset')
      await evaluate(`(() => {
        const originalFetch = window.fetch.bind(window)
        window.__agentLoginCalls = 0
        window.__agentStatusOriginal = originalFetch
        window.fetch = (input, init) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
          const agent = /[?&]agent=(kimi|codex)(?:&|$)/.exec(url)?.[1]
          if (url.includes('/ai/cli/login')) {
            window.__agentLoginCalls++
            return Promise.resolve(new Response(JSON.stringify({ ok: true, message: 'login mocked' }), { status: 202, headers: { 'Content-Type': 'application/json' } }))
          }
          if (agent) return Promise.resolve(new Response(JSON.stringify({ ok: true, cli: agent, installed: true, authenticated: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
          return originalFetch(input, init)
        }
      })()`)
      await wait(() => evaluate("[...document.querySelectorAll('.ai-settings-heading button')].some(button => button.textContent === '重新检测' && !button.disabled)"), 'Initial Agent status check did not settle')
      await evaluate("[...document.querySelectorAll('.ai-settings-heading button')].find(button => button.textContent === '重新检测').click()")
      await wait(() => evaluate("document.querySelectorAll('.st-agent-card').length === 2 && [...document.querySelectorAll('.st-agent-status')].every(status => status.textContent === '未登录')"), 'Direct Kimi and Codex agent cards did not load their connection state')
      await evaluate("[...document.querySelectorAll('.st-agent-card')].find(card => card.textContent.includes('Kimi Code')).querySelector('.btn-primary').click()")
      await wait(() => evaluate("window.__agentLoginCalls === 1"), 'Agent card did not invoke the login endpoint')
      await fill('[aria-label="Codex 模型"]', 'codex-default-smoke')
      check(await evaluate("JSON.parse(localStorage.getItem('timber-settings')).aiAgent.providers.codex.model === 'codex-default-smoke'"), 'AI defaults were not persisted')
      await evaluate("window.fetch = window.__agentStatusOriginal; undefined")
      checks.push('Kimi/Codex cards expose direct connection state and login action without launching a real login in tests')
      await evaluate("document.querySelector('[data-section=\"editor\"]').click()")
      await wait(() => evaluate("!!document.querySelector('.editor-settings .typography-settings') && !!document.querySelector('#editor-codeBlockLineNumbers')"), 'Editor settings do not include fonts and behavior controls')
      const fonts = await evaluate('window.timber.listFontFamilies()')
      check(!fonts.error && fonts.families.length > 0, 'Native system font enumeration failed: ' + JSON.stringify(fonts))
      check(new Set(fonts.families.map(font => font.toLowerCase())).size === fonts.families.length, 'Font catalog contains duplicate families')
      await evaluate(`(() => {
        const width = document.getElementById('editor-line-width')
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(width, 'invalid-width')
        width.dispatchEvent(new Event('input', {bubbles:true}))
      })()`)
      await wait(() => evaluate("document.getElementById('editor-line-width').getAttribute('aria-invalid') === 'true'"), 'Invalid width did not show validation feedback')
      await evaluate("document.querySelector('.tp-reset').click()")
      check(await evaluate("document.getElementById('editor-line-width').value === '' && document.getElementById('editor-font-size-number').value === '16' && document.documentElement.dataset.palette === 'nord'"), 'Reset did not restore typography fields or changed the selected theme')
      const bodyFont = fonts.families.find(font => font === 'Georgia') || fonts.families.find(font => font !== 'Open Sans' && font !== 'DejaVu Sans Mono')
      const codeFont = fonts.families.find(font => font === 'Consolas') || bodyFont
      const cjkFont = fonts.families.find(font => /[^\x00-\x7F]/.test(font) && font !== bodyFont)
      let activeFontField = 'editor-font-family'
      const openPicker = async field => {
        activeFontField = field
        await evaluate(`document.getElementById(${JSON.stringify(field)}).scrollIntoView({block:'center'}); document.getElementById(${JSON.stringify(field)}).click()`)
        await wait(() => evaluate("!!document.querySelector('.font-picker-popup')"), 'Font dropdown did not open')
      }
      const searchFont = async font => {
        await evaluate(`(() => {
          const input = document.getElementById(${JSON.stringify(activeFontField)})
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(font)})
          input.dispatchEvent(new Event('input', {bubbles:true}))
        })()`)
      }
      const chooseFont = async (field, font) => {
        await openPicker(field)
        await searchFont(font)
        await wait(() => evaluate(`[...document.querySelectorAll('.font-picker-option')].some(button => button.dataset.fontFamily === ${JSON.stringify(font)})`), 'System font missing from picker: ' + font)
        await evaluate(`[...document.querySelectorAll('.font-picker-option')].find(button => button.dataset.fontFamily === ${JSON.stringify(font)}).click()`)
        await wait(() => evaluate("!document.querySelector('.font-picker-popup')"), 'Font picker stayed open after selecting a font')
      }
      await openPicker('editor-font-family')
      check(await evaluate(`(() => { const names = [...document.querySelectorAll('.font-picker-option')].map(button => button.dataset.fontFamily); return ${JSON.stringify(fonts.families)}.every(font => names.includes(font)) })()`), 'Dropdown does not contain the complete installed font catalog')
      check(await evaluate("document.getElementById('editor-font-family').getAttribute('role') === 'combobox' && !document.querySelector('.font-tag, .font-stack-add')"), 'Fonts still use tags rather than a single-choice dropdown')
      await screenshot('font-picker-all.png')
      await searchFont('Nonexistent-Timber-Font-12345')
      await wait(() => evaluate("!!document.querySelector('.font-picker-empty')"), 'Unmatched search did not show an empty state')
      const beforeInvalidFont = await evaluate("localStorage.getItem('timber-settings')")
      await evaluate("document.getElementById('editor-font-family').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',code:'Enter',bubbles:true,isComposing:true})); document.getElementById('editor-font-family').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',code:'Enter',bubbles:true}))")
      check(await evaluate("localStorage.getItem('timber-settings')") === beforeInvalidFont, 'IME or unmatched search inserted a nonexistent font')
      await evaluate("document.getElementById('editor-font-family').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',code:'Escape',bubbles:true,cancelable:true}))")
      check(await evaluate("!document.querySelector('.font-picker-popup') && !!document.querySelector('.typography-settings')"), 'Escape closed settings instead of the font picker')
      await chooseFont('editor-font-family', bodyFont)
      if (cjkFont) {
        await chooseFont('editor-font-family', cjkFont)
        check(await evaluate("document.getElementById('editor-font-family').value") === cjkFont, 'Chinese font did not become the selected dropdown value')
        await chooseFont('editor-font-family', bodyFont)
      }
      await chooseFont('code-font-family', codeFont)
      check(await evaluate("document.getElementById('editor-font-family').value") === bodyFont, 'Selecting a code font changed the body font')
      const faces = await evaluate(`(async () => {
        const result = []
        for (const family of ['Open Sans', 'DejaVu Sans Mono']) {
          for (const style of ['normal', 'italic']) for (const weight of [400, 700]) {
            const loaded = await document.fonts.load(style + ' ' + weight + ' 16px "' + family + '"', 'Timber 0123')
            result.push({ family, style, weight, loaded: loaded.length > 0 && loaded.every(face => face.status === 'loaded') })
          }
        }
        return result
      })()`)
      check(faces.every(face => face.loaded), 'Bundled font faces failed to load: ' + JSON.stringify(faces))
      checks.push('complete native font catalog, single-choice searchable dropdowns, Chinese fonts, IME/empty search and bundled font faces')
      await evaluate(`(() => {
        const set = (id, value) => {
          const input = document.getElementById(id)
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }
        set('editor-font-size', '22')
        set('editor-line-height', '1.9')
        set('code-font-size', '18')
        set('editor-line-width', '640px')
        document.getElementById('editor-line-width').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',code:'Enter',bubbles:true,cancelable:true}))
        document.getElementById('code-wrap').click()
      })()`)
      check(await evaluate(`(() => {
        const settings = JSON.parse(localStorage.getItem('timber-settings'))
        return settings.editorFontFamily.startsWith(${JSON.stringify(JSON.stringify(bodyFont))}) && settings.fontSize === 22 && settings.lineHeight === 1.9 && settings.codeFontFamily === ${JSON.stringify(JSON.stringify(codeFont))} && settings.codeFontSize === 18 && settings.wrapCodeBlocks === false && settings.editorLineWidth === '640px'
      })()`), 'Typography controls did not persist their values')
      check(await evaluate("getComputedStyle(document.querySelector('.tp-preview-body')).fontSize === '22px' && getComputedStyle(document.querySelector('.tp-preview-code')).fontSize === '18px'"), 'Live preview did not use the chosen typography')
      await evaluate("document.querySelector('.st-body-wrap').scrollTop = 0")
      await screenshot('settings-typography.png')
      await evaluate(`(() => {
        const size = document.getElementById('editor-tab-size')
        size.value = '4'
        size.dispatchEvent(new Event('change', {bubbles:true}))
        for (const id of ['editor-codeBlockLineNumbers', 'editor-sourceCodeLineNumbers', 'editor-hideQuickInsertHint', 'writing-autoPairBracket']) document.getElementById(id).click()
      })()`)
      check(await evaluate("(() => { const settings = JSON.parse(localStorage.getItem('timber-settings')); const writing = JSON.parse(localStorage.getItem('timber-writing-v1')); return settings.tabSize === 4 && settings.codeBlockLineNumbers === false && settings.sourceCodeLineNumbers === false && settings.hideQuickInsertHint === true && writing.autoPairBracket === false && writing.autoPairQuote === true })()"), 'Editor behavior controls did not persist independently')
      await evaluate("document.querySelector('.editor-behavior-settings').scrollIntoView({block:'start'})")
      await screenshot('settings-editor-behavior.png')
      await evaluate("document.querySelector('.st-close').click()")
      await wait(() => evaluate("!!document.querySelector('.CodeMirror')"), 'Editor did not restore after settings')
      check(await evaluate("document.documentElement.dataset.palette === 'nord'"), 'Theme was lost outside settings')
      const sourceTypography = await evaluate(`(() => {
        const element = document.querySelector('.CodeMirror')
        const style = getComputedStyle(element)
        return { fontSize: style.fontSize, fontFamily: style.fontFamily, wrapping: element.CodeMirror.getOption('lineWrapping'), lineNumbers: element.CodeMirror.getOption('lineNumbers'), tabSize: element.CodeMirror.getOption('tabSize'), width: element.getBoundingClientRect().width, maxWidth: style.maxWidth, readerWidth: getComputedStyle(document.documentElement).getPropertyValue('--reader-width') }
      })()`)
      check(sourceTypography.fontSize === '18px' && sourceTypography.fontFamily.includes(codeFont) && !sourceTypography.wrapping && sourceTypography.width <= 641, 'Saved typography did not reach the restored source editor: ' + JSON.stringify(sourceTypography))
      check(sourceTypography.lineNumbers === false && sourceTypography.tabSize === 4, 'Source line numbers and tab width did not reach CodeMirror')
      await evaluate("document.querySelector('.CodeMirror').CodeMirror.focus(); document.querySelector('.CodeMirror').CodeMirror.setCursor({line:1,ch:0})")
      key('Tab')
      await wait(() => evaluate("document.querySelector('.CodeMirror').CodeMirror.getValue().endsWith('\\n    ')"), 'Configured Tab did not insert four spaces')
      key('Z', ['control'])
      await wait(() => evaluate("document.querySelector('.CodeMirror').CodeMirror.getValue() === '# edited-native\\n'"), 'Configured indentation could not be undone')
      const persistedFonts = await evaluate("JSON.parse(localStorage.getItem('timber-settings')).editorFontFamily")
      win.webContents.reload()
      await wait(() => evaluate("!!document.querySelector('.prose, .CodeMirror') && document.documentElement.dataset.palette === 'nord'").catch(() => false), 'Editor did not restore after renderer restart')
      check(await evaluate("JSON.parse(localStorage.getItem('timber-settings')).editorFontFamily") === persistedFonts, 'Font selection was lost on restart')
      await evaluate("document.querySelector('.tb-set[title=\"设置\"]').click()")
      await evaluate("document.querySelector('[data-section=\"editor\"]').click()")
      await wait(() => evaluate("!!document.getElementById('editor-font-family')"), 'Font dropdown did not restore after restart')
      check(await evaluate("document.getElementById('editor-font-family').value") === bodyFont, 'Restored font dropdown lost its selection')
      check(await evaluate("document.getElementById('editor-tab-size').value === '4' && !document.getElementById('writing-autoPairBracket').checked && document.getElementById('writing-autoPairQuote').checked"), 'Editor preferences were lost on restart')
      await evaluate("document.querySelector('.st-close').click()")
      checks.push('live preview, saved font dropdown selections, line numbers, four-space Tab and split pairing restored after restart')
      checks.push('33 palette choices and themed settings/editor restoration')

      const env = { ...process.env, TIMBER_APP_SMOKE_SECONDARY: '1', TIMBER_APP_SMOKE_ID: path.basename(temp).replace('app-smoke-', '') }
      delete env.ELECTRON_RUN_AS_NODE
      const child = spawn(process.execPath, [__filename, second], { cwd: root, windowsHide: true, env, stdio: 'ignore' })
      await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code ? reject(new Error('Secondary launch failed: ' + code)) : resolve()) })
      await wait(() => evaluate("document.querySelector('.prose')?.textContent.includes('second-open')"), 'Running instance did not receive the second file argument')
      checks.push('actual second process forwards Markdown to the existing application')

      await evaluate("[...document.querySelectorAll('.proj-item')].find(button => button.textContent.includes('Project folder')).click()")
      await wait(() => evaluate("document.querySelectorAll('.tb-view-select option:disabled').length === 0"), 'Project folder did not enable architecture/history')
      await wait(() => evaluate("!!document.querySelector('.tree-doc .doc-icon')"), 'Project file tree did not finish loading')
      check(await evaluate(`(() => {
        const icon = document.querySelector('.tree-doc .doc-icon')?.getBoundingClientRect()
        const name = document.querySelector('.tree-doc .doc-name')?.getBoundingClientRect()
        return icon && name && Math.abs(icon.top + icon.height / 2 - name.top - name.height / 2) <= 1
      })()`), 'File-tree icon and filename are not vertically centered')
      await evaluate("document.querySelector('.tree-doc').click()")
      await wait(() => evaluate("!!document.querySelector('.doc-tab.active')"), 'A project document tab did not open')
      await evaluate("document.querySelector('.doc-tab.active').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,cancelable:true,clientX:420,clientY:92}))")
      await wait(() => evaluate("!!document.querySelector('.ctx-menu')"), 'Tab context menu did not open')
      check(await evaluate(`(() => {
        const menu = document.querySelector('.ctx-menu')
        const rect = menu.getBoundingClientRect()
        return menu.parentElement === document.body && menu.contains(document.elementFromPoint(rect.left + 12, rect.top + 12))
      })()`), 'Tab context menu remains inside a clipping stacking context')
      key('Escape')
      await wait(() => evaluate("!document.querySelector('.ctx-menu')"), 'Tab context menu did not close')
      await evaluate("document.querySelector('.sb-proj-ops button').click()")
      await evaluate("[...document.querySelectorAll('.ctx-item')].find(button => button.textContent === '新建文件夹').click()")
      await evaluate(`(() => {
        const input = document.querySelector('.tree-name-input')
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'empty-smoke')
        input.dispatchEvent(new Event('input', {bubbles:true}))
        input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true}))
      })()`)
      await wait(() => evaluate("[...document.querySelectorAll('.tree-dir .dir-name')].some(name => name.textContent === 'empty-smoke')"), 'New empty folder is missing from the file tree')
      checks.push('centered file-tree rows, unobstructed tab menu and visible empty directories')
      for (const name of extraDocs) {
        await evaluate(`document.querySelector('.tree-doc[title="${name}"]').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))`)
      }
      await wait(() => evaluate("document.querySelectorAll('.doc-tab').length >= 18 && !!document.querySelector('.tabs-overflow')"), 'Tab overflow controls did not appear')
      check(await evaluate("getComputedStyle(document.querySelector('.tabs-scroll')).scrollbarWidth === 'none'"), 'The old scrollbar remains visible')
      const beforeScroll = await evaluate("document.querySelector('.tabs-scroll').scrollLeft")
      await evaluate("document.querySelector('[aria-label=\"向左滚动标签\"]').click()")
      await wait(() => evaluate(`document.querySelector('.tabs-scroll').scrollLeft < ${beforeScroll}`), 'Tab arrow did not scroll the tab strip')
      await wait(() => evaluate("document.querySelector('.prose')?.textContent.includes('overflow-18.md')"), 'The active overflow tab did not load')
      await evaluate("document.querySelector('[aria-label=\"源码模式\"]').click()")
      await wait(() => evaluate("!!document.querySelector('.CodeMirror')?.CodeMirror"), 'Source editor did not mount for the active tab')
      await evaluate("document.querySelector('.CodeMirror').CodeMirror.setValue('# unsaved tab draft\\n')")
      const requestCloseAll = async () => {
        await evaluate("document.querySelector('.doc-tab.active').dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, clientX:420, clientY:92 }))")
        await evaluate("[...document.querySelectorAll('.ctx-item')].find(button => button.textContent === '关闭所有标签').click()")
      }
      await requestCloseAll()
      await wait(() => evaluate("document.querySelector('#dialog-description')?.textContent.includes('未保存')"), 'Close all tabs did not confirm unsaved changes')
      await evaluate("document.querySelector('.app-dialog [data-cancel]').click()")
      check(await evaluate("document.querySelectorAll('.doc-tab').length >= 18 && !!document.querySelector('.tab-close.dirty')"), 'Canceling close all lost the open tabs or unsaved edit')
      await requestCloseAll()
      await evaluate("document.querySelector('.app-dialog button[type=submit]').click()")
      await wait(() => evaluate("!document.querySelector('.doc-tab, .tabs-overflow')"), 'Close all tabs left documents or controls behind')
      check(fs.readFileSync(path.join(projectDir, extraDocs.at(-1)), 'utf-8') === '# overflow-18.md\n', 'Closing all tabs wrote a discarded edit to disk')
      checks.push('scrollable overflow controls, close all tabs and unsaved changes confirmation')
      await evaluate(`(() => {
        const originalFetch = window.fetch.bind(window)
        window.fetch = (input, init) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
          const agent = url.includes('/ai/cli') && /[?&]agent=(kimi|codex)(?:&|$)/.exec(url)?.[1]
          if (agent) return Promise.resolve(new Response(JSON.stringify({ ok: true, cli: agent, installed: true, authenticated: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
          return originalFetch(input, init)
        }
        window.__archRenderOriginal = window.timber.archRender
        window.timber.archRender = (...args) => new Promise(resolve => setTimeout(() => resolve(window.__archRenderOriginal(...args)), 900))
        return undefined
      })()`)
      await chooseView('architecture')
      await wait(() => evaluate("document.querySelector('.av-load-progress')?.getAttribute('aria-valuenow') === '65'"), 'Architecture initialization did not reach the data-ready progress stage')
      check(await evaluate("document.querySelector('.av-load-progress-track span')?.style.width === '65%'"), 'Architecture progress bar is not rendering its stage percentage')
      check(await evaluate("document.querySelector('.av-ai-title')?.textContent === 'AI 对话' && !!document.querySelector('.av-ai-optimize') && !document.querySelector('.av-ai-footnote') && ![...document.querySelectorAll('.av-ai-mode button')].length"), 'AI panel did not merge into a unified conversation with one-click optimization')
      check(await evaluate("document.querySelector('.architecture-sidebar .av-ai-panel') && !document.querySelector('.arch-view .av-ai-panel') && !document.querySelector('.tb-set[title=\"AI 对话侧栏\"]').disabled"), 'AI conversation did not move to the reusable application right sidebar')
      check(await evaluate("document.querySelector('.av-ai-optimize path')?.getAttribute('d') !== 'M12 5v14M5 12h14' && !!document.querySelector('.av-ai-model-menu') && getComputedStyle(document.querySelector('.av-ai-input')).resize === 'none'"), 'Optimization icon or unified model menu was not updated')
      await evaluate(`(() => {
        const input = document.querySelector('.av-ai-input')
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'one\\ntwo\\nthree\\nfour')
        input.dispatchEvent(new Event('input', {bubbles:true}))
      })()`)
      await wait(() => evaluate("document.querySelector('.av-ai-input').getBoundingClientRect().height > 64"), 'Input did not grow automatically with multiline content')
      check(await evaluate("getComputedStyle(document.querySelector('.av-ai-current-model')).display === 'none'"), 'Compact AI sidebar still shows crowded model controls')
      await evaluate("document.querySelector('.architecture-sidebar').style.width = '560px'")
      await wait(() => evaluate("getComputedStyle(document.querySelector('.av-ai-current-model')).display !== 'none' && getComputedStyle(document.querySelector('.av-ai-action-label')).display !== 'none'"), 'Wide AI sidebar did not reveal additional controls')
      await evaluate("document.querySelector('.architecture-sidebar').style.width = '280px'")
      await wait(() => evaluate("getComputedStyle(document.querySelector('.av-ai-current-model')).display === 'none'"), 'AI sidebar did not restore its compact layout')
      checks.push('application-level AI sidebar, rocket action, automatic input growth and responsive controls')
      await evaluate("document.querySelector('.av-ai-model-menu > summary').click()")
      await choose('[aria-label="架构 Agent"]', 'codex')
      check(await evaluate("document.querySelector('[aria-label=\"架构模型\"]').value === 'codex-default-smoke' && !!document.querySelector('[aria-label=\"速度\"]') && !!document.querySelector('[aria-label=\"权限\"]')"), 'Codex defaults or runtime options are missing')
      await choose('[aria-label="速度"]', 'priority')
      await choose('[aria-label="权限"]', 'workspace-write')
      await choose('[aria-label="思考强度"]', 'high')
      await choose('[aria-label="架构 Agent"]', 'kimi')
      check(await evaluate("!document.querySelector('[aria-label=\"速度\"], [aria-label=\"权限\"]') && !document.querySelector('[aria-label=\"架构模型\"]').value && !!document.querySelector('[aria-label=\"思考强度\"] option[value=\"max\"]')"), 'Kimi is showing unsupported Codex options')
      await fill('[aria-label="架构模型"]', 'kimi-session-smoke')
      await choose('[aria-label="架构 Agent"]', 'codex')
      check(await evaluate("document.querySelector('[aria-label=\"速度\"]').value === 'priority' && document.querySelector('[aria-label=\"权限\"]').value === 'workspace-write' && document.querySelector('[aria-label=\"思考强度\"]').value === 'high' && document.querySelector('[aria-label=\"架构模型\"]').value === 'codex-default-smoke'"), 'Switching providers dropped the existing per-provider preferences')
      await choose('[aria-label="架构 Agent"]', 'kimi')
      check(await evaluate("document.querySelector('[aria-label=\"架构模型\"]').value === 'kimi-session-smoke'"), 'Kimi session model was not restored')
      await screenshot('architecture-agent-options.png', true)
      checks.push('AI settings and per-conversation Kimi/Codex options remain independent')
      await wait(() => evaluate("!!document.querySelector('.av-frame')"), 'Architecture diagram did not render after initialization')
      await evaluate("window.timber.archRender = window.__archRenderOriginal; undefined")
      check(await evaluate("!document.querySelector('.av-load-progress')"), 'Architecture progress stayed visible after rendering completed')
      checks.push('real architecture initialization progress and unified AI conversation')
      await evaluate(`(() => {
        window.__archOriginalFetch = window.fetch.bind(window)
        window.__archRequests = []
        window.fetch = (input, init) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
          if (!url.includes('/ai/arch')) return window.__archOriginalFetch(input, init)
          window.__archRequests.push(JSON.parse(init.body))
          const index = window.__archRequests.length
          const encoder = new TextEncoder()
          const stream = new ReadableStream({
            start(controller) {
              const emit = value => controller.enqueue(encoder.encode(JSON.stringify(value) + '\\n'))
              emit({ event: 'progress', stage: 'tool', status: 'running', label: '执行命令', detail: 'git status', toolId: 'smoke-tool' })
              if (index >= 3) return
              setTimeout(() => {
                emit({ event: 'progress', stage: 'tool', status: 'done', label: '工具执行完成', detail: 'clean', toolId: 'smoke-tool' })
                emit({ event: 'progress', stage: 'answer', status: 'running', label: '正在整理回答', text: '**模拟**' })
              }, 500)
              setTimeout(() => {
                emit({ event: 'result', result: { ok: true, answer: '**模拟**完成 ' + index, backend: 'cli', cli: 'kimi' } })
                controller.close()
              }, 1000)
            }
          })
          return Promise.resolve(new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }))
        }
      })()`)
      await choose('[aria-label="会话模式"]', 'ask')
      await fill('.av-ai-input', '当前架构如何工作？')
      await evaluate("document.querySelector('[aria-label=\"发送\"]').click()")
      await wait(() => evaluate("document.querySelector('.av-ai-live-time')?.textContent.length > 0 && document.querySelector('.av-ai-live-detail')?.textContent === 'git status'"), 'Live Agent stage, elapsed time and tool preview did not render')
      await wait(() => evaluate("document.querySelector('.av-ai-answer strong')?.textContent === '模拟' && !!document.querySelector('.av-ai-live')"), 'Partial Markdown did not render while the request was running')
      await wait(() => evaluate("document.querySelector('.av-ai-answer')?.textContent === '模拟完成 1'"), 'Streamed Agent answer did not complete')
      await fill('.av-ai-input', '进一步说明调用链')
      await evaluate("document.querySelector('[aria-label=\"发送\"]').click()")
      await wait(() => evaluate("document.querySelectorAll('.av-ai-answer').length === 2 && document.querySelector('.ai-turn:last-child .av-ai-answer')?.textContent === '模拟完成 2'"), 'A follow-up replaced the previous turn or did not finish')
      check(await evaluate("window.__archRequests[1]?.history?.[0]?.prompt === '当前架构如何工作？' && window.__archRequests[1]?.options.model === 'kimi-session-smoke'"), 'A follow-up did not carry the session context and model')
      await fill('.av-ai-input', '停止这轮请求')
      await evaluate("document.querySelector('[aria-label=\"发送\"]').click()")
      await wait(() => evaluate("window.__archRequests.length === 3 && !!document.querySelector('[aria-label=\"停止当前请求\"]')"), 'Stop control did not appear')
      await evaluate("document.querySelector('[aria-label=\"停止当前请求\"]').click()")
      await wait(() => evaluate("document.querySelector('.ai-turn:last-child .ai-outcome')?.textContent === '已停止'"), 'Stopping a turn lost its status')
      const sessionId = await evaluate("document.querySelector('.ai-thread-select').value")
      await evaluate("document.querySelector('[aria-label=\"新建会话\"]').click()")
      await wait(() => evaluate("document.querySelectorAll('.ai-thread-select option').length === 2 && !document.querySelector('.ai-turn')"), 'The new thread shows previous messages')
      await fill('.av-ai-input', '保留的草稿')
      await chooseView('history')
      await wait(() => evaluate("!!document.querySelector('.hv-row.selected') && document.querySelector('.cd-subject')?.textContent === 'fix: update answer'"), 'History did not load and select the newest commit')
      await chooseView('architecture')
      await wait(() => evaluate("document.querySelector('.av-ai-input')?.value === '保留的草稿'"), 'Leaving the architecture view did not persist the draft')
      await choose('.ai-thread-select', sessionId)
      await wait(() => evaluate("document.querySelectorAll('.ai-turn').length === 3 && document.querySelectorAll('.av-ai-answer').length === 2"), 'Reopening a session lost turns or answers')
      await evaluate("window.fetch = window.__archOriginalFetch; undefined")
      checks.push('persistent project sessions, multi-turn context, Markdown streaming, tool timeline and stop without a real model call')

      await chooseView('history')
      await wait(() => evaluate("document.querySelector('.tb-view-select').value === 'history' && document.querySelectorAll('.hv-row').length === 2 && !!document.querySelector('.hv-day h3')"), 'Folder history navigation or date grouping failed')
      await fill('[aria-label="搜索提交"]', 'initial')
      await wait(() => evaluate("document.querySelectorAll('.hv-row').length === 1 && document.querySelector('.cd-subject')?.textContent === 'initial'"), 'Git log search did not narrow or select the result')
      await evaluate("document.querySelector('[aria-label=\"清除提交搜索\"]').click()")
      await wait(() => evaluate("document.querySelectorAll('.hv-row').length === 2 && !!document.querySelector('[aria-label=\"历史分支或标签\"] option[value=\"refs/tags/smoke-base\"]')"), 'Commit search reset or tag discovery failed')
      await choose('[aria-label="历史分支或标签"]', 'refs/tags/smoke-base')
      await wait(() => evaluate("document.querySelectorAll('.hv-row').length === 1 && document.querySelector('.cd-subject')?.textContent === 'initial'"), 'Commit history did not follow the selected tag')
      await fill('[aria-label="筛选变更文件"]', 'index.ts')
      await wait(() => evaluate("document.querySelectorAll('.cd-file').length === 1 && document.querySelector('.cd-path')?.textContent.trim() === 'index.ts'"), 'Changed-file filter did not work')
      await evaluate("document.querySelector('.cd-file').click()")
      await wait(() => evaluate("document.querySelector('.cd-diff-line.add')?.textContent.includes('answer = 42')"), 'Inline diff does not show the selected file')
      await evaluate("document.querySelector('.cd-diff-wrap').click()")
      check(await evaluate("document.querySelector('.cd-diff-scroll').classList.contains('wrap') && !!document.querySelector('[aria-label=\"下一处差异\"]')"), 'Diff controls did not apply wrapping or show hunk navigation')
      checks.push('history reference and commit search, auto selection, file filtering and inline diff controls')
      await evaluate("[...document.querySelectorAll('.proj-item')].find(button => button.textContent.includes('second.markdown')).click()")
      await wait(() => evaluate("document.querySelector('.tb-view-select').value === 'resources' && document.querySelector('.prose')?.textContent.includes('second-open')"), 'Selecting a file from history did not restore the resource view')
      checks.push('folder features enable correctly and returning to a single file exits history')
      await wait(() => evaluate("document.querySelector('.prose .mu-inline-image img')?.complete && document.querySelector('.prose .mu-inline-image img')?.naturalWidth > 0"), 'Fullscreen image fixture did not load')
      await evaluate(`(() => {
        const toolbar = document.querySelector('.mu-image-toolbar-container') || document.body.appendChild(document.createElement('div'))
        toolbar.classList.add('mu-float-wrapper', 'mu-image-toolbar-container')
        toolbar.style.opacity = '1'
      })()`)
      check(await evaluate("getComputedStyle(document.querySelector('.mu-image-toolbar-container')).display !== 'none'"), 'Muya image toolbar fixture is not visible before fullscreen')
      await evaluate("document.querySelector('.prose .mu-inline-image img').dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true,detail:2}))")
      await wait(() => evaluate("!!document.querySelector('.img-lightbox-stage img')"), 'Image lightbox did not open in the application')
      await pause(100)
      const lightboxLayout = await evaluate(`(() => {
        const image = document.querySelector('.img-lightbox-stage img').getBoundingClientRect()
        const stage = document.querySelector('.img-lightbox-stage').getBoundingClientRect()
        const toolbar = document.querySelector('.img-lightbox-meta')
        const toolbarRect = toolbar.getBoundingClientRect()
        const actions = [...document.querySelectorAll('.img-lightbox-action')]
        return {
          imageBottom: image.bottom, stageBottom: stage.bottom, toolbarTop: toolbarRect.top, toolbarPosition: getComputedStyle(toolbar).position,
          muyaToolbarDisplay: getComputedStyle(document.querySelector('.mu-image-toolbar-container')).display,
          actionCount: actions.length,
          actionStyles: actions.map(button => ({ display: getComputedStyle(button).display, icons: button.querySelectorAll('svg').length })),
          styledActions: actions.length === 2 && actions.every(button => ['flex', 'inline-flex'].includes(getComputedStyle(button).display) && button.querySelector('svg')),
        }
      })()`)
      check(lightboxLayout.muyaToolbarDisplay === 'none', 'Muya edit/alignment toolbar is still visible over the fullscreen image: ' + JSON.stringify(lightboxLayout))
      check(lightboxLayout.toolbarPosition === 'static' && lightboxLayout.stageBottom <= lightboxLayout.toolbarTop && lightboxLayout.imageBottom <= lightboxLayout.toolbarTop, 'Fullscreen image toolbar still covers the picture: ' + JSON.stringify(lightboxLayout))
      check(lightboxLayout.styledActions, 'Fullscreen copy actions still use native buttons: ' + JSON.stringify(lightboxLayout))
      await screenshot('image-lightbox.png', true)
      await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))")
      await wait(() => evaluate("!document.querySelector('.img-lightbox')"), 'Image lightbox did not close')
      check(await evaluate("getComputedStyle(document.querySelector('.mu-image-toolbar-container')).display !== 'none'"), 'Muya image toolbar did not restore after fullscreen closed')
      checks.push('fullscreen hides Muya image controls and uses separate styled copy actions without covering picture content')
      await screenshot('editor-nord.png', true)
      check(consoleErrors.length === 0, 'Renderer errors: ' + consoleErrors.join('\n'))
      fs.writeFileSync(path.join(temp, 'result.json'), JSON.stringify({ passed: true, checks, consoleErrors, screenshots: temp, screenshotWarnings }, null, 2))
      clearTimeout(timeout)
      app.quit()
    } catch (error) {
      if (win && !win.isDestroyed()) await screenshot('failure.png').catch(() => {})
      const editorState = win && !win.isDestroyed() ? await evaluate(`({
        focused: document.hasFocus(),
        activeElement: document.activeElement?.tagName,
        value: document.querySelector('.CodeMirror')?.CodeMirror?.getValue(),
        input: document.querySelector('.CodeMirror textarea')?.value
      })`).catch(() => null) : null
      fs.writeFileSync(path.join(temp, 'result.json'), JSON.stringify({ passed: false, checks, error: String(error.stack || error), editorState, consoleErrors, screenshots: temp }, null, 2))
      clearTimeout(timeout)
      process.exitCode = 1
      app.quit()
    }
  }).catch(error => { console.error(error); process.exitCode = 1; clearTimeout(timeout); app.quit() })
}
