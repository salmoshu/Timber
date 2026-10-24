import { useEffect, useState } from 'react'
import { useStore, type AppView } from '../store'
import Logo from './Logo'
import { IconMaximize, IconPanelLeft, IconPanelRight, IconRestore } from './icons'

const VIEWS: { key: AppView; label: string }[] = [
  { key: 'resources', label: '资源' },
  { key: 'architecture', label: '架构' },
  { key: 'history', label: '历史' }
]

export default function TitleBar() {
  const b = window.timber
  const openSettings = useStore((s) => s.openSettings)
  const closeSettings = useStore((s) => s.closeSettings)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const annPanelOpen = useStore((s) => s.annPanelOpen)
  const toggleAnnPanel = useStore((s) => s.toggleAnnPanel)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const [version, setVersion] = useState('')
  const [maximized, setMaximized] = useState(false)

  // 标题区版本号（Electron 环境从主进程取；纯 Web 预览不显示）
  useEffect(() => {
    let mounted = true
    b?.appVersion()
      .then((v) => {
        if (mounted) setVersion(v)
      })
      .catch(() => {})
    return () => {
      mounted = false
    }
  }, [b])

  // 最大化状态：初始化查询一次，随后跟随主进程推送（图标在单矩形/重叠矩形间切换）
  useEffect(() => {
    if (!b) return
    let mounted = true
    b.winIsMaximized()
      .then((m) => {
        if (mounted) setMaximized(m)
      })
      .catch(() => {})
    const off = b.onWindowMaximized(setMaximized)
    return () => {
      mounted = false
      off()
    }
  }, [b])

  return (
    <header className="titlebar">
      <div className="tb-drag">
        <Logo size={18} />
        <span className="tb-name">Timber</span>
        {version && <span className="tb-version">{`v${version}`}</span>}
        {/* 主视图切换（文档/代码/架构/历史）：左侧挨着版本号；位于拖拽区内需 no-drag */}
        <nav className="tb-views">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              className={`tb-view ${view === v.key ? 'active' : ''}`}
              onClick={() => setView(v.key)}
            >
              {v.label}
            </button>
          ))}
        </nav>
      </div>
      <div className="tb-btns">
        <button
          className={`tb-set ${sidebarCollapsed ? '' : 'on'}`}
          onClick={toggleSidebar}
          title={sidebarCollapsed ? '展开左侧边栏' : '折叠左侧边栏'}
        >
          <IconPanelLeft />
        </button>
        <button
          className={`tb-set ${annPanelOpen ? 'on' : ''}`}
          onClick={toggleAnnPanel}
          title={view === 'history' ? '历史记录侧栏' : '右侧边栏（文件 / 搜索 / Git）'}
          disabled={settingsOpen || (view !== 'resources' && view !== 'history')}
        >
          <IconPanelRight />
        </button>
        <button
          className={`tb-set ${settingsOpen ? 'on' : ''}`}
          onClick={() => (settingsOpen ? closeSettings() : openSettings())}
          title={settingsOpen ? '返回主界面' : '设置'}
        >
          ⚙
        </button>
        {b && (
          <>
            <button onClick={() => b.winMinimize()} title="最小化">—</button>
            <button onClick={() => b.winToggleMaximize()} title={maximized ? '还原' : '最大化'}>
              {maximized ? <IconRestore /> : <IconMaximize />}
            </button>
            <button className="tb-close" onClick={() => b.winClose()} title="关闭">✕</button>
          </>
        )}
      </div>
    </header>
  )
}
