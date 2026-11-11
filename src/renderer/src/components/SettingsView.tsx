import { useEffect, useState } from 'react'
import type { UpdateStatusEvent, UpdaterPrefs } from '@shared/types'
import { DOC_FORMAT_GROUPS } from '@shared/types'
import { useStore } from '../store'
import { aiTest } from '../api'
import { loadUpdaterPrefs, saveUpdaterPrefs } from '../utils/updater-prefs'
import { DEFAULT_ARCHITECTURE_PROMPT, THEME_PALETTES, type ThemeId } from '../utils/settings'
import TypographySettings from './TypographySettings'
import EditorSettings from './EditorSettings'

type Section = 'appearance' | 'typography' | 'reading' | 'editor' | 'ai' | 'version'

const SECTIONS: Array<{ key: Section; icon: Section; label: string }> = [
  { key: 'appearance', icon: 'appearance', label: '外观' },
  { key: 'typography', icon: 'typography', label: '字体与排版' },
  { key: 'reading', icon: 'reading', label: '阅读与标注' },
  { key: 'editor', icon: 'editor', label: '编辑器' },
  { key: 'ai', icon: 'ai', label: 'AI' },
  { key: 'version', icon: 'version', label: '版本' }
]

function SettingsIcon({ section }: { section: Section }) {
  if (section === 'typography') return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3 19 6-14 6 14M5.5 13h7M16 10h6m-3 0v9" /></svg>
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {section === 'appearance' ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></> : section === 'reading' ? <><path d="M12 5v15M12 5C9 3 5 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-2-1-6-1-9 1Z" /></> : section === 'editor' ? <><path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14Z" /></> : section === 'ai' ? <><path d="M12 3l1.8 4.9L18.7 9.7l-4.9 1.8L12 16.4l-1.8-4.9L5.3 9.7l4.9-1.8L12 3Z" /><path d="M18.5 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2Z" /></> : <><path d="M20 7a9 9 0 1 0 1 9M20 3v5h-5" /></>}
  </svg>
}

/** 设置视图：占据整个内容区——左侧栏位置放设置导航（关闭按钮在标题上方），主体部分放设置内容 */
export default function SettingsView() {
  const { settings, setSetting } = useStore()
  const requestedSection = useStore((s) => s.settingsSection)
  const [section, setSection] = useState<Section>(requestedSection ?? 'appearance')
  useEffect(() => { if (requestedSection) setSection(requestedSection) }, [requestedSection])

  // ---- 版本区状态 ----
  const bridge = window.timber
  const [appVersion, setAppVersion] = useState('')
  const [updaterState, setUpdaterState] = useState<UpdateStatusEvent | null>(null)
  const [updaterPrefs, setUpdaterPrefs] = useState<UpdaterPrefs>(loadUpdaterPrefs)
  const [checking, setChecking] = useState(false)
  const [downloading, setDownloading] = useState(false)

  // ---- AI 区状态（v0.6.3） ----
  const ai = useStore((s) => s.settings.ai)
  const aiComplete = !!(ai.baseUrl && ai.apiKey && ai.model)
  const [showKey, setShowKey] = useState(false)
  const [aiTesting, setAiTesting] = useState(false)
  const [aiTestMsg, setAiTestMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const testAi = async (): Promise<void> => {
    if (!aiComplete || aiTesting) return
    setAiTesting(true)
    setAiTestMsg(null)
    try {
      const r = await aiTest(ai)
      setAiTestMsg(
        r.ok
          ? { ok: true, text: `连接成功（${r.model ?? ai.model} 已响应）` }
          : { ok: false, text: r.message ?? r.error ?? '测试失败' }
      )
    } catch (e) {
      setAiTestMsg({ ok: false, text: String(e instanceof Error ? e.message : e) })
    } finally {
      setAiTesting(false)
    }
  }

  useEffect(() => {
    bridge?.appVersion().then(setAppVersion).catch(() => {})
    setUpdaterPrefs(loadUpdaterPrefs())
    if (!bridge) return
    return bridge.onUpdateStatus((e) => {
      setUpdaterState((prev) => {
        if (e.type === 'download-progress') {
          return {
            ...e,
            version: e.version ?? prev?.version,
            percent: Math.max(prev?.percent ?? 0, e.percent ?? 0)
          }
        }
        if (e.type === 'update-downloaded') return { ...e, version: e.version ?? prev?.version, percent: 100 }
        return e
      })
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
  const preparing = updaterState?.type === 'download-progress' && (updaterState.percent ?? 0) >= 99
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
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg>
          <span>返回</span>
        </button>
        <div className="st-title">设置</div>
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            data-section={s.key}
            className={`st-item ${section === s.key ? 'active' : ''}`}
            onClick={() => setSection(s.key)}
          >
            <span className="st-icon"><SettingsIcon section={s.icon} /></span>
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
              <div className="theme-picker" role="group" aria-label="应用主题">
                <button className={`theme-option ${settings.theme === 'system' ? 'active' : ''}`} onClick={() => setSetting('theme', 'system')} aria-pressed={settings.theme === 'system'}>跟随系统</button>
                {([false, true] as const).map((dark) => <div className="theme-category" key={String(dark)}>
                  <span className="theme-category-label">{dark ? '深色' : '浅色'}</span>
                  <div className="theme-options">{(Object.entries(THEME_PALETTES) as [ThemeId, typeof THEME_PALETTES[ThemeId]][]).filter(([, palette]) => palette.dark === dark).map(([id, palette]) =>
                    <button key={id} className={`theme-option ${settings.theme === id ? 'active' : ''}`} onClick={() => setSetting('theme', id)} aria-pressed={settings.theme === id}>
                      <span className="theme-swatch" aria-hidden="true" style={{ background: palette.background, color: palette.text, borderColor: palette.accent }}>Aa<span style={{ background: palette.accent }} /></span>{palette.label}
                    </button>
                  )}</div>
                </div>)}
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

        {section === 'typography' && <TypographySettings />}

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

          </div>
        )}

        {section === 'editor' && <EditorSettings />}

        {section === 'ai' && (
          <div className="st-card">
            <div className="st-card-title">AI 服务</div>

            <div className="st-row">
              <div className="st-label">API 地址</div>
              <div className="st-input-wrap">
                <input
                  className="st-input"
                  type="text"
                  spellCheck={false}
                  placeholder="https://api.openai.com/v1"
                  value={ai.baseUrl}
                  onChange={(e) => setSetting('ai', { ...ai, baseUrl: e.target.value.trim() })}
                />
              </div>
              <div className="st-hint">OpenAI 兼容接口的 Base URL（OpenAI / DeepSeek / Moonshot / 智谱 / 本地 Ollama 等），通常以 /v1 结尾</div>
            </div>

            <div className="st-row">
              <div className="st-label">API Key</div>
              <div className="st-input-wrap st-key-row">
                <input
                  className="st-input mono"
                  type={showKey ? 'text' : 'password'}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="sk-…"
                  value={ai.apiKey}
                  onChange={(e) => setSetting('ai', { ...ai, apiKey: e.target.value })}
                />
                <button className="btn-ghost sm" onClick={() => setShowKey((v) => !v)}>
                  {showKey ? '隐藏' : '显示'}
                </button>
              </div>
              <div className="st-hint">仅保存在本机设置中，请求时直接发往所填服务商，不经过其它中间服务</div>
            </div>

            <div className="st-row">
              <div className="st-label">模型</div>
              <div className="st-input-wrap">
                <input
                  className="st-input mono"
                  type="text"
                  spellCheck={false}
                  placeholder="如 gpt-4o / deepseek-chat / glm-4.6 / kimi-k2"
                  value={ai.model}
                  onChange={(e) => setSetting('ai', { ...ai, model: e.target.value.trim() })}
                />
              </div>
              <div className="st-hint">填写服务商提供的模型名；生成质量随模型能力差异较大</div>
            </div>

            <div className="st-row">
              <div className="st-label">一键优化提示词</div>
              <div className="st-input-wrap">
                <textarea
                  className="st-input st-prompt-input"
                  aria-label="一键优化提示词"
                  spellCheck={false}
                  value={ai.architecturePrompt}
                  onChange={(e) => setSetting('ai', { ...ai, architecturePrompt: e.target.value })}
                />
                <div className="st-prompt-actions">
                  <span>仅用于架构视图的「一键优化」，不影响日常 AI 对话。</span>
                  <button className="btn-ghost sm" onClick={() => setSetting('ai', { ...ai, architecturePrompt: DEFAULT_ARCHITECTURE_PROMPT })}>恢复默认</button>
                </div>
              </div>
              <div className="st-hint">默认要求完全基于源码、配置和 Git 事实重新生成，不参考现有 AI 画布；可按团队架构规范自行调整。</div>
            </div>

            <div className="st-row">
              <div className="st-label">连接测试</div>
              <div className="st-control">
                <button className="btn-primary sm" disabled={!aiComplete || aiTesting} onClick={() => void testAi()}>
                  {aiTesting ? '测试中…' : '测试连接'}
                </button>
                {aiTestMsg && (
                  <span className={`st-test-msg ${aiTestMsg.ok ? 'ok' : 'err'}`}>{aiTestMsg.text}</span>
                )}
              </div>
              <div className="st-hint">
                三项填写齐全后，架构视图的「AI 助手」优先经此接口生成与解释架构；
                未配置时自动改用本机 kimi / codex CLI（需已安装并登录）。
              </div>
            </div>
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
                    ? preparing ? '准备中…' : '下载中…'
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
                <div style={{ width: '100%' }}>
                  <div className="st-hint" style={{ marginBottom: 6 }}>
                    {preparing ? '安装包已下载，正在校验并准备更新，无需重新下载。' : `正在下载 ${updaterState.percent ?? 0}%`}
                  </div>
                  <div className="uc-progress" style={{ marginTop: 0 }}>
                    <div
                      className={`uc-progress-bar${preparing ? ' indeterminate' : ''}`}
                      style={preparing ? undefined : { width: `${updaterState.percent ?? 0}%` }}
                    />
                  </div>
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
