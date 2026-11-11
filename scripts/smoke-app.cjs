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
    fs.writeFileSync(second, '# second-open\n')
    fs.writeFileSync(path.join(projectDir, 'index.ts'), 'export const answer = 42\n')
    for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.com', 'commit', '-m', 'initial']]) {
      const result = spawnSync('git', args, { cwd: projectDir, stdio: 'pipe' })
      if (result.status !== 0) throw new Error('Git fixture setup failed: ' + result.stderr)
    }
    fs.writeFileSync(path.join(temp, 'profile/sidecar-data/projects.json'), JSON.stringify({ projects: [{ id: 'smoke-folder', name: 'Project folder', path: projectDir, addedAt: new Date().toISOString(), docCount: 2 }] }))
  }
  let win
  const consoleErrors = []
  const checks = []
  const screenshotWarnings = []
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  const evaluate = source => win.webContents.executeJavaScript(source, true)
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
      check(await evaluate("[...document.querySelectorAll('.tb-view')].filter(button => ['架构','历史'].includes(button.textContent)).every(button => button.disabled)"), 'Project features are enabled for a single file')
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
      check(await evaluate("document.querySelector('.titlebar').getBoundingClientRect().height === 44"), 'Titlebar does not use the standard 44px height')
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
      await evaluate("[...document.querySelectorAll('.st-prompt-actions button')].find(button => button.textContent === '恢复默认').click()")
      check(await evaluate("document.querySelector('[aria-label=\"一键优化提示词\"]').value") === defaultPrompt, 'Optimization prompt reset did not restore the default')
      checks.push('configurable source-backed optimization prompt and reset')
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
      await wait(() => evaluate("[...document.querySelectorAll('.tb-view')].filter(button => ['架构','历史'].includes(button.textContent)).every(button => !button.disabled)"), 'Project folder did not enable architecture/history')
      await evaluate(`(() => {
        window.__archRenderOriginal = window.timber.archRender
        window.timber.archRender = (...args) => new Promise(resolve => setTimeout(() => resolve(window.__archRenderOriginal(...args)), 900))
        return undefined
      })()`)
      await evaluate("[...document.querySelectorAll('.tb-view')].find(button => button.textContent === '架构').click()")
      await wait(() => evaluate("document.querySelector('.av-load-progress')?.getAttribute('aria-valuenow') === '65'"), 'Architecture initialization did not reach the data-ready progress stage')
      check(await evaluate("document.querySelector('.av-load-progress-track span')?.style.width === '65%'"), 'Architecture progress bar is not rendering its stage percentage')
      check(await evaluate("document.querySelector('.av-ai-title')?.textContent === 'AI 对话' && !!document.querySelector('.av-ai-optimize') && !document.querySelector('.av-ai-footnote') && ![...document.querySelectorAll('.av-ai-mode button')].length"), 'AI panel did not merge into a unified conversation with one-click optimization')
      await wait(() => evaluate("!!document.querySelector('.av-frame')"), 'Architecture diagram did not render after initialization')
      await evaluate("window.timber.archRender = window.__archRenderOriginal; undefined")
      check(await evaluate("!document.querySelector('.av-load-progress')"), 'Architecture progress stayed visible after rendering completed')
      checks.push('real architecture initialization progress and unified AI conversation')
      await evaluate("[...document.querySelectorAll('.tb-view')].find(button => button.textContent === '历史').click()")
      await wait(() => evaluate("document.querySelector('.tb-view.active')?.textContent === '历史'"), 'Folder history view did not open')
      await evaluate("[...document.querySelectorAll('.proj-item')].find(button => button.textContent.includes('second.markdown')).click()")
      await wait(() => evaluate("document.querySelector('.tb-view.active')?.textContent === '资源' && document.querySelector('.prose')?.textContent.includes('second-open')"), 'Selecting a file from history did not restore the resource view')
      checks.push('folder features enable correctly and returning to a single file exits history')
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
