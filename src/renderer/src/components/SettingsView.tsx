import { useEffect, useState } from 'react'
import type { UpdateStatusEvent, UpdaterPrefs } from '@shared/types'
import { DOC_FORMAT_GROUPS } from '@shared/types'
import { useStore } from '../store'
import { loadUpdaterPrefs, saveUpdaterPrefs } from '../utils/updater-prefs'

type Section = 'appearance' | 'reading' | 'editor' | 'version'

const SECTIONS: Array<{ key: Section; icon: string; label: string }> = [
  { key: 'appearance', icon: '🎨', label: '外观' },
  { key: 'reading', icon: '📖', label: '阅读与标注' },
  { key: 'editor', icon: '✏️', label: '编辑' },
  { key: 'version', icon: '⟳', label: '版本' }
]

/** 设置视图：占据整个内容区——左侧栏位置放设置导航（关闭按钮在标题上方），主体部分放设置内容 */
export default function SettingsView() {
  const { settings, setSetting } = useStore()
  const [section, setSection] = useState<Section>('appearance')

  // ---- 版本区状态 ----
  const bridge = window.timber
  const [appVersion, setAppVersion] = useState('')
  const [updaterState, setUpdaterState] = useState<UpdateStatusEvent | null>(null)
  const [updaterPrefs, setUpdaterPrefs] = useState<UpdaterPrefs>(loadUpdaterPrefs)
  const [checking, setChecking] = useState(false)
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    bridge?.appVersion().then(setAppVersion).catch(() => {})
    setUpdaterPrefs(loadUpdaterPrefs())
    if (!bridge) return
    return bridge.onUpdateStatus((e) => {
      setUpdaterState((prev) =>
        e.type === 'download-progress' || e.type === 'update-downloaded'
          ? { ...e, version: e.version ?? prev?.version }
          : e
      )
      if (e.type === 'checking') {
        setChecking(true)
      } else {
        setChecking(false)
        if (e.type !== 'download-progress') setDownloading(false)
      }
    })
  }, [bridge])

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') useStore.getState().closeSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const handlePrefChange = (key: keyof UpdaterPrefs, value: boolean): void => {
    const next = { ...updaterPrefs, [key]: value }
    setUpdaterPrefs(next)
    saveUpdaterPrefs(next)
  }

  const handleUpdateAction = async (): Promise<void> => {
    if (!bridge) {
      useStore.getState().toast('info', '纯 Web 预览模式不支持检查更新')
      return
    }
    if (updaterState?.type === 'update-downloaded') {
      await bridge.updaterQuitAndInstall()
      return
    }
    if (updaterState?.type === 'update-available' && !updaterPrefs.autoDownload) {
      if (downloading) return
      setDownloading(true)
      try {
        await bridge.updaterDownload()
      } catch {
        setDownloading(false)
      }
      return
    }
    setChecking(true)
    try {
      await bridge.updaterCheck()
    } catch (err) {
      setChecking(false)
      const raw = String(err instanceof Error ? err.message : err)
      const msg = raw.includes('Error:') ? raw.split('Error:').pop()!.trim() : raw
      useStore.getState().toast('info', msg)
    }
  }

  const downloaded = updaterState?.type === 'update-downloaded'
  const downloadingNow =
    updaterState?.type === 'download-progress' ||
    downloading ||
    (updaterState?.type === 'update-available' && updaterPrefs.autoDownload)

  const toggleFormat = (key: string): void => {
    const cur = settings.docFormats
    if (cur.includes(key)) {
      if (cur.length === 1) {
        useStore.getState().toast('info', '至少保留一种文件格式')
        return
      }
      setSetting('docFormats', cur.filter((k) => k !== key))
    } else {
      setSetting('docFormats', [...cur, key])
    }
    // 格式变化立即重扫当前项目
    const st = useStore.getState()
    if (st.activeProjectId) void st.rescan()
  }

  return (
    <div className="st-view">
      <div className="st-side">
        <button
          className="st-close"
          onClick={() => useStore.getState().closeSettings()}
          title="返回 (Esc)"
        >
          ← 返回
        </button>
        <div className="st-title">设置</div>
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            className={`st-item ${section === s.key ? 'active' : ''}`}
            onClick={() => setSection(s.key)}
          >
            <span className="st-icon">{s.icon}</span>
            {s.label}
          </button>
        ))}
      </div>

      <div className="st-body-wrap">
        {section === 'appearance' && (
          <div className="st-card">
            <div className="st-card-title">外观</div>

            <div className="st-row">
              <div className="st-label">主题</div>
              <div className="seg">
                <button className={settings.theme === 'system' ? 'active' : ''} onClick={() => setSetting('theme', 'system')} title="跟随系统深浅色自动切换">
                  系统
                </button>
                <button className={settings.theme === 'light' ? 'active' : ''} onClick={() => setSetting('theme', 'light')}>
                  浅色
                </button>
                <button className={settings.theme === 'dark' ? 'active' : ''} onClick={() => setSetting('theme', 'dark')}>
                  深色
                </button>
              </div>
            </div>

            <div className="st-row">
              <div className="st-label">正文字号</div>
              <div className="st-control">
                <input
                  type="range"
                  min={13}
                  max={18}
                  step={1}
                  value={settings.fontSize}
                  onChange={(e) => setSetting('fontSize', Number(e.target.value))}
                />
                <span className="st-value">{settings.fontSize}px</span>
              </div>
              <div className="st-hint">作用于 Markdown 阅读区正文</div>
            </div>

            <div className="st-row">
              <div className="st-label">阅读区宽度</div>
              <div className="seg">
                {[70, 80, 90, 100].map((w) => (
                  <button key={w} className={settings.contentWidth === w ? 'active' : ''} onClick={() => setSetting('contentWidth', w)}>
                    {w === 100 ? '全宽' : `${w}%`}
                  </button>
                ))}
              </div>
              <div className="st-hint">按阅读区宽度的百分比控制内容行宽，阅读与编辑模式同时生效</div>
            </div>

            <div className="st-row">
              <div className="st-label">正文字体</div>
              <div className="seg">
                <button className={!settings.serifFont ? 'active' : ''} onClick={() => setSetting('serifFont', false)}>
                  无衬线
                </button>
                <button className={settings.serifFont ? 'active' : ''} onClick={() => setSetting('serifFont', true)}>
                  衬线
                </button>
              </div>
            </div>

            <div className="st-row">
              <div className="st-label">支持格式</div>
              <div className="fmt-groups">
                {DOC_FORMAT_GROUPS.map((g) => (
                  <label key={g.key} className="fmt-group">
                    <input
                      type="checkbox"
                      checked={settings.docFormats.includes(g.key)}
                      onChange={() => toggleFormat(g.key)}
                    />
                    {g.label}
                    <span className="fmt-exts">{g.exts.join(' ')}</span>
                  </label>
                ))}
              </div>
              <div className="st-hint">决定文件树与搜索扫描哪些文件；改动后立即重新扫描当前项目</div>
            </div>
          </div>
        )}

        {section === 'reading' && (
          <div className="st-card">
            <div className="st-card-title">阅读与标注</div>

            <div className="st-row">
              <div className="st-label">打开文档默认模式</div>
              <div className="seg">
                <button className={settings.defaultMode === 'read' ? 'active' : ''} onClick={() => setSetting('defaultMode', 'read')}>
                  阅读模式
                </button>
                <button className={settings.defaultMode === 'source' ? 'active' : ''} onClick={() => setSetting('defaultMode', 'source')}>
                  编辑模式
                </button>
              </div>
            </div>

            <div className="st-row">
              <div className="st-label">默认展开标注面板</div>
              <button
                className={`switch ${settings.annPanelDefaultOpen ? 'on' : ''}`}
                onClick={() => setSetting('annPanelDefaultOpen', !settings.annPanelDefaultOpen)}
              >
                <span className="switch-dot" />
              </button>
              <div className="st-hint">打开文档时自动带出右侧标注面板</div>
            </div>
          </div>
        )}

        {section === 'editor' && (
          <div className="st-card">
            <div className="st-card-title">编辑</div>

            <div className="st-row">
              <div className="st-label">自动保存</div>
              <button
                className={`switch ${settings.autoSave ? 'on' : ''}`}
                onClick={() => setSetting('autoSave', !settings.autoSave)}
              >
                <span className="switch-dot" />
              </button>
              <div className="st-hint">停止输入后自动落盘；Ctrl+S 手动保存始终可用</div>
            </div>

            {settings.autoSave && (
              <div className="st-row">
                <div className="st-label">自动保存延迟</div>
                <div className="seg">
                  {[1000, 2000, 3000].map((ms) => (
                    <button key={ms} className={settings.autoSaveDelayMs === ms ? 'active' : ''} onClick={() => setSetting('autoSaveDelayMs', ms)}>
                      {ms / 1000}s
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {section === 'version' && (
          <div className="st-card">
            <div className="st-card-title">版本</div>

            <div className="st-row version-row">
              <span className="st-label">
                当前版本 <span className="tag">v{appVersion || '…'}</span>
              </span>
              <button
                className={downloaded ? 'btn-danger sm' : 'btn-primary sm'}
                disabled={checking || downloadingNow}
                onClick={() => void handleUpdateAction()}
              >
                {downloaded
                  ? '立即重启更新'
                  : downloadingNow
                    ? '下载中…'
                    : checking
                      ? '检查中…'
                      : updaterState?.type === 'update-available'
                        ? '立即下载'
                        : '检查更新'}
              </button>
            </div>

            {updaterState?.type === 'update-available' && (
              <div className="st-row">
                <div className="st-hint">发现新版本 v{updaterState.version}{updaterPrefs.autoDownload ? '，正在后台下载…' : ''}</div>
              </div>
            )}
            {updaterState?.type === 'download-progress' && (
              <div className="st-row">
                <div className="uc-progress" style={{ marginTop: 0 }}>
                  <div className="uc-progress-bar" style={{ width: `${updaterState.percent ?? 0}%` }} />
                </div>
              </div>
            )}
            {updaterState?.type === 'update-not-available' && (
              <div className="st-row">
                <div className="st-hint">当前已是最新版本</div>
              </div>
            )}
            {updaterState?.type === 'update-downloaded' && (
              <div className="st-row">
                <div className="st-hint">新版本 v{updaterState.version} 已下载完成；现在重启立即更新，或退出应用时自动安装</div>
              </div>
            )}
            {updaterState?.type === 'error' && (
              <div className="st-row">
                <div className="st-hint" style={{ color: 'var(--danger)' }}>
                  检查更新失败：{updaterState.message}（更新源托管在 GitHub Releases，网络受限时可能无法访问）
                </div>
              </div>
            )}

            <div className="st-divider" />

            <div className="st-row">
              <div className="st-label">自动更新</div>
              <div className="st-col">
                <label className="st-switch-row">
                  <button
                    className={`switch ${updaterPrefs.autoCheck ? 'on' : ''}`}
                    onClick={() => handlePrefChange('autoCheck', !updaterPrefs.autoCheck)}
                  >
                    <span className="switch-dot" />
                  </button>
                  启动时自动检查更新
                </label>
                <label className="st-switch-row">
                  <button
                    className={`switch ${updaterPrefs.autoDownload ? 'on' : ''}`}
                    onClick={() => handlePrefChange('autoDownload', !updaterPrefs.autoDownload)}
                  >
                    <span className="switch-dot" />
                  </button>
                  发现新版本后自动下载
                </label>
              </div>
            </div>

            <div className="st-hint" style={{ marginTop: 12 }}>
              手动下载安装包时，若 Windows 提示“已保护你的电脑”，请点击“更多信息 → 仍要运行”。
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
