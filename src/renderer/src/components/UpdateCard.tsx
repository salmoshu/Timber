import { useEffect, useState } from 'react'
import type { UpdateStatusEvent, UpdaterPrefs } from '@shared/types'
import { compareVersions } from '../utils/version'
import { loadUpdaterPrefs, saveUpdaterPrefs } from '../utils/updater-prefs'
import { useStore } from '../store'

/**
 * 全局更新浮层卡片（右下角），语义对齐 Nav-Tools UpdateDialog：
 * - 自动下载开启时全程静默，仅下载完成待重启时出现；
 * - 自动下载关闭时，发现新版本出现「立即下载 / 忽略此版本」；
 * - 忽略版本持久化，仅出现更新版本号时才重新提醒。
 * 手动检查入口在设置页（版本区）。
 */
export default function UpdateCard() {
  const settingsOpen = useStore((s) => s.settingsOpen)
  const bridge = window.timber
  const [event, setEvent] = useState<UpdateStatusEvent | null>(null)
  const [prefs, setPrefs] = useState<UpdaterPrefs>(loadUpdaterPrefs)
  const [sessionHidden, setSessionHidden] = useState(false)
  const [manualDownloading, setManualDownloading] = useState(false)

  // 初始化：把持久化偏好送入主进程（触发打包环境下的启动自动检查）
  useEffect(() => {
    bridge?.updaterSetPrefs(prefs)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!bridge) return
    return bridge.onUpdateStatus((e) => {
      if (e.type === 'update-available') {
        setEvent(e)
        setSessionHidden(false)
        setManualDownloading(false)
      } else if (e.type === 'download-progress') {
        setEvent((prev) => {
          const percent = Math.max(prev?.percent ?? 0, e.percent ?? 0)
          return { ...e, version: e.version ?? prev?.version, percent }
        })
      } else if (e.type === 'update-downloaded') {
        setEvent(e)
        setSessionHidden(false)
        setManualDownloading(false)
      } else if (e.type === 'update-not-available' || e.type === 'error') {
        setEvent(null)
        setManualDownloading(false)
      }
    })
  }, [bridge])

  const version = event?.version ?? ''
  const percent = event?.percent ?? 0
  const ignored =
    Boolean(prefs.ignoredVersion) &&
    Boolean(version) &&
    compareVersions(version, prefs.ignoredVersion ?? '') <= 0

  type Phase = 'available' | 'progress' | 'ready'
  let phase: Phase | null = null
  if (event && !ignored) {
    if (event.type === 'update-downloaded') phase = 'ready'
    else if (!prefs.autoDownload && event.type === 'update-available') phase = 'available'
    else if (!prefs.autoDownload && event.type === 'download-progress' && manualDownloading)
      phase = 'progress'
  }
  const visible = phase !== null && !(phase === 'progress' && sessionHidden)

  const handleIgnore = () => {
    if (phase === 'progress') {
      setSessionHidden(true)
      return
    }
    if (version) {
      const next = { ...prefs, ignoredVersion: version }
      setPrefs(next)
      saveUpdaterPrefs(next)
    }
    setEvent(null)
  }

  // 设置页打开时更新状态由设置·版本区呈现，避免双进度条
  if (!visible || settingsOpen) return null

  return (
    <div className="update-card">
      <button className="uc-close" title="忽略此版本" onClick={handleIgnore}>
        ✕
      </button>
      {phase === 'ready' && (
        <>
          <div className="uc-title">更新已就绪</div>
          <p className="uc-desc">v{version} 已下载完成，重启后生效。</p>
          <div className="uc-actions">
            <button className="btn-ghost sm" onClick={handleIgnore}>
              稍后
            </button>
            <button className="btn-primary sm" onClick={() => void bridge?.updaterQuitAndInstall()}>
              立即重启
            </button>
          </div>
        </>
      )}
      {phase === 'available' && (
        <>
          <div className="uc-title">发现新版本 v{version}</div>
          <p className="uc-desc">有可用的更新，是否现在下载？</p>
          <div className="uc-actions">
            <button className="btn-ghost sm" onClick={handleIgnore}>
              忽略此版本
            </button>
            <button
              className="btn-primary sm"
              disabled={manualDownloading}
              onClick={() => {
                setManualDownloading(true)
                bridge?.updaterDownload().catch(() => setManualDownloading(false))
              }}
            >
              立即下载
            </button>
          </div>
        </>
      )}
      {phase === 'progress' && (
        <>
          <div className="uc-title">正在下载 v{version}</div>
          <div className="uc-progress">
            <div className="uc-progress-bar" style={{ width: `${percent}%` }} />
          </div>
        </>
      )}
    </div>
  )
}
