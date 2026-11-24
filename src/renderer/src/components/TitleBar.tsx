import { useEffect, useState } from 'react'
import { useStore, type AppView } from '../store'
import Logo from './Logo'
import { IconChevronDown, IconClose, IconMaximize, IconMinimize, IconPanelLeft, IconPanelRight, IconRestore, IconSettings, WorkspaceIcon } from './icons'

const VIEWS: { key: AppView; label: string }[] = [
  { key: 'resources', label: '资源' },
  { key: 'architecture', label: '架构' },
  { key: 'history', label: '历史' }
]

export default function TitleBar() {
  const b = window.timber
  const mac = b?.platform === 'darwin'
  const openSettings = useStore((s) => s.openSettings)
  const closeSettings = useStore((s) => s.closeSettings)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const annPanelOpen = useStore((s) => s.annPanelOpen)
  const toggleAnnPanel = useStore((s) => s.toggleAnnPanel)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const folderProject = useStore((s) => s.projects.some((p) => p.id === s.activeProjectId && p.kind !== 'file'))
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
    if (!b || mac) return
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
  }, [b, mac])

  return (
    <header className={`titlebar${mac ? ' mac-titlebar' : ''}`}>
      <div className="tb-drag">
        <Logo size={20} animated={false} />
        <span className="tb-name">Timber</span>
        {version && <span className="tb-version">{`v${version}`}</span>}
        <nav className="tb-views" aria-label="工作区导航">
          <WorkspaceIcon view={view} />
          <select
            className="tb-view-select"
            aria-label="工作区视图"
            title={folderProject ? '切换工作区' : '打开项目文件夹后可使用架构和历史'}
            value={view}
            onChange={(event) => {
              setView(event.target.value as AppView)
              if (settingsOpen) closeSettings()
            }}
          >
            {VIEWS.map((item) => (
              <option key={item.key} value={item.key} disabled={item.key !== 'resources' && !folderProject}>
                {item.label}
              </option>
            ))}
          </select>
          <IconChevronDown />
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
          title={view === 'history' ? '历史记录侧栏' : view === 'architecture' ? 'AI 对话侧栏' : '右侧边栏（文件 / 搜索 / Git）'}
          disabled={settingsOpen}
        >
          <IconPanelRight />
        </button>
        <button
          className={`tb-set ${settingsOpen ? 'on' : ''}`}
          onClick={() => (settingsOpen ? closeSettings() : openSettings())}
          title={settingsOpen ? '返回主界面' : '设置'}
        >
          <IconSettings />
        </button>
        {b && !mac && (
          <>
            <button className="tb-window" onClick={() => b.winMinimize()} title="最小化"><IconMinimize /></button>
            <button className="tb-window" onClick={() => b.winToggleMaximize()} title={maximized ? '还原' : '最大化'}>
              {maximized ? <IconRestore /> : <IconMaximize />}
            </button>
            <button className="tb-window tb-close" onClick={() => b.winClose()} title="关闭"><IconClose /></button>
          </>
        )}
      </div>
    </header>
  )
}
