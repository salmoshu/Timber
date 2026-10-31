import { app, BrowserWindow, clipboard, ipcMain, nativeImage, net, session, shell } from 'electron'
import { cpSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { startSidecar, stopSidecar, setSidecarReadyListener } from './sidecar.js'
import { renderArchHtml, compareArchDelta } from './archify.js'
import { UpdateService, extractReleaseNotesSection } from './updater.js'
import type { ApiInfo } from '@shared/types'

let mainWindow: BrowserWindow | null = null
let apiInfo: ApiInfo | null = null
let startupError: string | null = null
const updateService = new UpdateService()

// 单实例锁
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    // userData 迁移：旧应用名 awesome-notes 的 sidecar-data 整体拷贝到新 userData
    const dataDir = app.getPath('userData')
    const oldDataDir = join(dirname(dataDir), 'awesome-notes', 'sidecar-data')
    if (!existsSync(join(dataDir, 'sidecar-data', 'projects.json')) && existsSync(join(oldDataDir, 'projects.json'))) {
      try {
        cpSync(oldDataDir, join(dataDir, 'sidecar-data'), { recursive: true })
        console.log('[migrate] 已从 awesome-notes 拷贝 sidecar-data')
      } catch (err) {
        console.error('[migrate] sidecar-data 迁移失败：', err)
      }
    }
    try {
      apiInfo = await startSidecar()
    } catch (err) {
      console.error('[sidecar] 启动失败：', err)
      startupError = String(err)
    }
    createWindow()
    watchExternalPageStatus()

    // sidecar 意外退出自动重启后，把新 base/token 推给渲染层缓存
    setSidecarReadyListener((info) => {
      apiInfo = info
      mainWindow?.webContents.send('api-info-changed', info)
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    stopSidecar()
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', stopSidecar)
}

// 外部链接统一在应用内浮层打开（主窗口导航被拦截后经 'open-external-page' 通知渲染层）；
// 浮层 webview 走独立 partition，监控其主文档 HTTP 状态以展示美化错误页
function openInOverlay(url: string): void {
  if (/^https?:/i.test(url)) mainWindow?.webContents.send('open-external-page', url)
}

app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) openInOverlay(url)
    else if (/^(mailto|tel):/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // 主窗口自身的导航（如 Markdown 链接误以 _self 打开）转浮层；webview 内导航放行
  contents.on('will-navigate', (e, url) => {
    if (mainWindow && contents.id === mainWindow.webContents.id) {
      const isAppUrl = process.env.ELECTRON_RENDERER_URL
        ? url.startsWith(process.env.ELECTRON_RENDERER_URL)
        : url.startsWith('file://')
      if (!isAppUrl) {
        e.preventDefault()
        openInOverlay(url)
      }
    }
  })
  // 标签快捷键：Ctrl+W / Ctrl+Tab 拦截后转发渲染层（默认会关窗口/切焦点）
  contents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !input.control) return
    if (input.key === 'w') {
      e.preventDefault()
      mainWindow?.webContents.send('tab-shortcut', 'close')
    } else if (input.key === 'Tab') {
      e.preventDefault()
      mainWindow?.webContents.send('tab-shortcut', 'next')
    }
  })
})

function watchExternalPageStatus(): void {
  const extSession = session.fromPartition('persist:an-external')
  extSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType === 'mainFrame' && details.statusCode >= 400) {
      mainWindow?.webContents.send('ext-page-status', {
        url: details.url,
        code: details.statusCode
      })
    }
    callback({ cancel: false })
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    frame: false,
    roundedCorners: false,
    backgroundColor: '#f7f8fb',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  updateService.attach(mainWindow.webContents)

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
  // 最大化状态推送：标题栏「最大化/还原」图标跟随切换
  mainWindow.on('maximize', () => mainWindow?.webContents.send('win:maximized-changed', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('win:maximized-changed', false))
}

// ---- IPC ----
ipcMain.handle('api:info', () => {
  if (startupError && !apiInfo) throw new Error(startupError)
  return apiInfo
})

// archify 架构图：渲染快照 / 对比 delta（结果缓存在 <userData>/arch）
ipcMain.handle('arch:render', (_e, spec: string, key: string) => renderArchHtml(spec, key))
ipcMain.handle('arch:delta', (_e, base: string, head: string, key: string) =>
  compareArchDelta(base, head, key)
)

// 自定义文件夹选择器只通过桥读取目录，不调用系统原生弹窗。
ipcMain.handle('files:browse', async (_e, input?: string) => {
  const path = resolve(input?.trim() || homedir())
  if (!(await stat(path)).isDirectory()) throw new Error('该路径不是文件夹')
  const folders = (await readdir(path, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
  const roots = process.platform === 'win32'
    ? Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`).filter(existsSync)
    : ['/']
  return { path, parent: dirname(path), home: homedir(), roots, folders }
})
ipcMain.handle('files:exists', (_e, path: string) => existsSync(path))

ipcMain.handle('shell:reveal', (_e, p: string) => {
  shell.showItemInFolder(p)
})

ipcMain.handle('clipboard:write-image', async (_e, src: string) => {
  let image
  if (/^data:image\//i.test(src)) {
    image = nativeImage.createFromDataURL(src)
  } else if (/^https?:/i.test(src)) {
    const response = await net.fetch(src)
    if (!response.ok) throw new Error(`图片读取失败：HTTP ${response.status}`)
    image = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()))
  } else {
    throw new Error('仅支持 HTTP(S) 或 data URL 图片')
  }
  if (image.isEmpty()) throw new Error('无法识别该图片格式')
  clipboard.writeImage(image)
})

// 浮层「用系统浏览器打开」；仅放行 http(s)
ipcMain.handle('shell:open-external', (_e, url: string) => {
  if (!/^https?:/i.test(url)) throw new Error('仅支持 http(s) 链接')
  return shell.openExternal(url)
})

ipcMain.on('win:minimize', () => mainWindow?.minimize())
ipcMain.on('win:toggle-maximize', () => {
  if (!mainWindow) return
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
})
ipcMain.handle('win:is-maximized', () => mainWindow?.isMaximized() ?? false)
ipcMain.on('win:close', () => mainWindow?.close())

ipcMain.handle('app:version', () => app.getVersion())

// 导出 PDF（v0.5.7）：渲染器把文档渲染成独立 HTML 字符串（浅色打印样式、图片已重写为
// sidecar /raw 绝对 URL），这里写临时文件 → 隐藏窗口加载 → 等资源就绪 → printToPDF → 保存对话框。
// 不能用主窗口 printToPDF：那会把整个应用 UI 打进去。
ipcMain.handle('export:pdf', async (_e, payload: { html: string; path: string; overwrite: boolean }) => {
  const tmpHtml = join(tmpdir(), `timber-export-${process.pid}-${Date.now()}.html`)
  let win: BrowserWindow | null = null
  try {
    writeFileSync(tmpHtml, payload.html, 'utf-8')
    win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
    await win.loadFile(tmpHtml)
    // 等字体与图片（sidecar /raw、外链图）加载完再打印，避免 PDF 里图片缺位
    await win.webContents.executeJavaScript(
      `(async () => {
        if (document.fonts?.ready) await document.fonts.ready
        await Promise.all([...document.images].map((i) =>
          i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = () => r(0) })))
      })()`
    )
    if (!mainWindow) return { ok: false, error: '主窗口已关闭' }
    if (!isAbsolute(payload.path) || !/\.pdf$/i.test(payload.path)) throw new Error('无效的 PDF 保存路径')
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { marginType: 'custom', top: 0.55, bottom: 0.55, left: 0.6, right: 0.6 }
    })
    writeFileSync(payload.path, pdf, { flag: payload.overwrite ? 'w' : 'wx' })
    return { ok: true, path: payload.path }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) }
  } finally {
    win?.destroy()
    try { unlinkSync(tmpHtml) } catch { /* 临时文件清理失败可忽略 */ }
  }
})

// 版本更新：偏好由渲染端持久化并在初始化时传入，状态经 'update-status-changed' 推送
ipcMain.handle('update-check', () => updateService.checkForUpdates())
ipcMain.handle('update-download', () => updateService.downloadUpdate())
ipcMain.handle('update-quit-and-install', () => updateService.quitAndInstall())
ipcMain.on('update-set-prefs', (_e, prefs) => updateService.applyPrefs(prefs))

// 当前版本更新日志：release-notes.md 随包携带（extraResources），dev 下读项目根
ipcMain.handle('app:current-release-notes', () => {
  const candidates = [
    join(process.resourcesPath ?? '', 'release-notes.md'),
    join(app.getAppPath(), 'release-notes.md')
  ]
  for (const p of candidates) {
    try {
      if (p && existsSync(p)) {
        const md = readFileSync(p, 'utf-8')
        return extractReleaseNotesSection(md, app.getVersion()) ?? md.trim()
      }
    } catch {
      /* 尝试下一个候选路径 */
    }
  }
  return null
})
