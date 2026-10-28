// 版本更新服务：封装 electron-updater，语义对齐 Nav-Tools UpdateService。
// - 状态经 'update-status-changed' 推送给渲染进程
// - 偏好（自动检查 / 自动下载 / 忽略版本）由渲染端持久化并传入主进程
// - 开发环境下检查更新直接报错（electron-updater 依赖打包产物旁的 latest.yml）
import { app } from 'electron'
// electron-updater 是 CJS 包，ESM 主进程产物下需走默认导入再解构
import updaterPkg from 'electron-updater'
import type { UpdateStatusEvent, UpdaterPrefs } from '@shared/types'

const { autoUpdater } = updaterPkg

export const UPDATE_STATUS_CHANNEL = 'update-status-changed'

const DEFAULT_PREFS: UpdaterPrefs = { autoCheck: true, autoDownload: true }

interface UpdateStatusTarget {
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
}

/**
 * 清洗发布说明：latest.yml 缺省时 electron-updater 回退 GitHub Atom 源，
 * releaseNotes 是 HTML 字符串，直接渲染会显示标签；含换行的视为 Markdown 原文。
 */
function cleanReleaseNotes(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  if (!raw.includes('\n') && /<\/?[a-z][\s\S]*>/i.test(raw)) {
    return raw
      .replace(/<[^>]+>/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
  }
  return raw.trim()
}

/** 从整份更新日志切出 `## vX.Y.Z` 小节；找不到返回 null（调用方回退全文） */
export function extractReleaseNotesSection(markdown: string, version: string): string | null {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const start = markdown.search(new RegExp('^##\\s+v?' + escaped + '\\s*$', 'm'))
  if (start === -1) return null
  const rest = markdown.slice(start)
  const next = rest.slice(1).search(/^##\s+v/m)
  return (next === -1 ? rest : rest.slice(0, next + 1)).trim()
}

export class UpdateService {
  private target: UpdateStatusTarget | null = null
  private prefs: UpdaterPrefs = { ...DEFAULT_PREFS }
  private wired = false
  private prefsReceived = false
  private autoCheckDone = false
  /** electron-updater 可能在同一更新会话中重复发出较小的 percent；
   *  保留单调进度，避免 UI 到 100% 后又回到 0%。 */
  private downloadVersion: string | undefined
  private downloadPercent = 0
  private downloadStarted = false
  private downloadComplete = false
  private downloadPromise: Promise<void> | null = null

  attach(target: UpdateStatusTarget): void {
    this.target = target
    this.wireEvents()
  }

  applyPrefs(raw: unknown): void {
    const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const ignored = value.ignoredVersion
    this.prefs = {
      autoCheck: value.autoCheck !== false,
      autoDownload: value.autoDownload !== false,
      ignoredVersion: typeof ignored === 'string' && ignored ? ignored : undefined
    }
    autoUpdater.autoDownload = this.prefs.autoDownload
    autoUpdater.autoInstallOnAppQuit = true
    this.prefsReceived = true
    this.maybeAutoCheck()
  }

  async checkForUpdates(): Promise<void> {
    if (!app.isPackaged) {
      throw new Error('当前为开发环境，检查更新需在打包版本中运行')
    }
    await autoUpdater.checkForUpdates()
  }

  async downloadUpdate(): Promise<void> {
    if (!app.isPackaged) {
      throw new Error('当前为开发环境，更新需在打包版本中运行')
    }
    if (this.downloadComplete) return
    if (this.downloadPromise) return this.downloadPromise
    if (this.downloadStarted) return
    this.downloadStarted = true
    this.downloadPromise = autoUpdater
      .downloadUpdate()
      .then(() => undefined)
      .catch((error) => {
        this.downloadStarted = false
        throw error
      })
      .finally(() => {
        this.downloadPromise = null
      })
    return this.downloadPromise
  }

  /** 静默安装（/S）：沿用上次的安装目录与安装方式（NSIS 注册表记忆），跳过安装选项页；
   *  isForceRunAfter=true：装完自动重启并直达新版本，无需人工点「完成」。 */
  quitAndInstall(): void {
    autoUpdater.quitAndInstall(true, true)
  }

  private wireEvents(): void {
    if (this.wired) return
    this.wired = true

    autoUpdater.on('checking-for-update', () => this.send({ type: 'checking' }))
    autoUpdater.on('update-available', (info) => {
      if (this.downloadVersion !== info.version) {
        this.downloadVersion = info.version
        this.downloadPercent = 0
        this.downloadComplete = false
        this.downloadStarted = this.prefs.autoDownload
      }
      const notes = cleanReleaseNotes(info.releaseNotes)
      this.send({
        type: 'update-available',
        version: info.version,
        releaseNotes: notes ? (extractReleaseNotesSection(notes, info.version) ?? notes) : undefined
      })
    })
    autoUpdater.on('update-not-available', () => {
      this.resetDownloadState()
      this.send({ type: 'update-not-available' })
    })
    autoUpdater.on('download-progress', (progress) => {
      if (this.downloadComplete) return
      const percent = Math.max(this.downloadPercent, Math.min(100, Math.floor(progress.percent)))
      this.downloadStarted = true
      if (percent === this.downloadPercent) return
      this.downloadPercent = percent
      this.send({ type: 'download-progress', percent })
    })
    autoUpdater.on('update-downloaded', (info) => {
      this.downloadVersion = info.version
      this.downloadPercent = 100
      this.downloadStarted = true
      this.downloadComplete = true
      this.send({ type: 'update-downloaded', version: info.version })
    })
    autoUpdater.on('error', (err) => {
      this.resetDownloadState()
      this.send({ type: 'error', message: err?.message ?? String(err) })
    })

    autoUpdater.autoDownload = this.prefs.autoDownload
    autoUpdater.autoInstallOnAppQuit = true
    this.maybeAutoCheck()
  }

  private maybeAutoCheck(): void {
    if (this.autoCheckDone || !this.prefsReceived) return
    this.autoCheckDone = true
    if (app.isPackaged && this.prefs.autoCheck) {
      autoUpdater.checkForUpdates().catch(() => {})
    }
  }

  private send(payload: UpdateStatusEvent): void {
    if (this.target && !this.target.isDestroyed()) {
      this.target.send(UPDATE_STATUS_CHANNEL, payload)
    }
  }

  private resetDownloadState(): void {
    this.downloadVersion = undefined
    this.downloadPercent = 0
    this.downloadStarted = false
    this.downloadComplete = false
    this.downloadPromise = null
  }
}
