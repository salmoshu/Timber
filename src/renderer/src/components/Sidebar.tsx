import { askConfirm, askInput } from '../utils/dialogs'
import { useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useStore } from '../store'
import type { DocNode, Project, RemoteConfig } from '@shared/types'
import Chevron from './Chevron'
import ContextMenu, { type MenuItem } from './ContextMenu'
import GitPanel from './GitPanel'
import SearchPanel from './SearchPanel'
import { CodeTree } from './CodeView'
import { filterDocsForProject, filterKeyForProject } from '../utils/settings'
import {
  blockPath,
  hiddenProjectIds,
  hideProject,
  isBlocked,
  isExactBlocked,
  projectAlias,
  setProjectAlias,
  unblockPath,
  unhideProject
} from '../utils/local-store'

/** 目录展开状态（path → open），跨重扫/重进项目保留 */
const treeOpenState = new Map<string, boolean>()

/** 拖拽中的源节点（HTML5 DnD 事件里不便传结构，用模块级变量交接） */
let dragNode: DocNode | null = null

/** 校验文件/目录名：非空且不含 Windows 保留字符 */
function validName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[\\/:*?"<>|]/.test(name) && !name.startsWith('.')
}

/** 拼接项目内相对路径（parent 为空表示根） */
function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

type TreeTab = 'docs' | 'search' | 'git'

function extIcon(ext?: string): string {
  switch (ext) {
    case '.md':
    case '.markdown':
    case '.mdown':
    case '.mkd':
      return 'M↓'
    case '.html':
    case '.htm':
      return '<>'
    default:
      return '≡'
  }
}

function extClass(ext?: string): string {
  if (ext === '.md' || ext === '.markdown' || ext === '.mdown' || ext === '.mkd') return 'ext-md'
  if (ext === '.html' || ext === '.htm') return 'ext-html'
  return 'ext-txt'
}

function matchFilter(node: DocNode, f: string): boolean {
  if (!f) return true
  if (node.name.toLowerCase().includes(f)) return true
  return (node.children ?? []).some((c) => matchFilter(c, f))
}

interface TreeCtx {
  projectId: string
  onMenu(e: ReactMouseEvent, node: DocNode, exactBlocked: boolean): void
  /** 拖拽目标高亮的目录路径（null = 无） */
  dropTarget: string | null
  /** 拖拽进入目录（含根：target 为 ''） */
  onDropInto(target: string): void
  onDragOverDir(target: string): void
  onDragLeaveDir(): void
  /** 「＋」新建的目标目录（点击目录行选中，null = 项目根） */
  selectedDir: string | null
  onSelectDir(target: string): void
}

function TreeNode({ node, depth, ctx }: { node: DocNode; depth: number; ctx: TreeCtx }) {
  const { activeDoc, openDoc, filter } = useStore()
  // 默认全部折叠，由用户自行展开；展开状态记入模块级表，重扫不丢
  const [, force] = useState(0)
  const open = treeOpenState.get(node.path) ?? false
  const f = filter.trim().toLowerCase()
  if (!matchFilter(node, f)) return null

  const blocked = isBlocked(ctx.projectId, node.path)
  const exactBlocked = isExactBlocked(ctx.projectId, node.path)
  const dragOver = ctx.dropTarget === node.path

  if (node.type === 'doc') {
    const active = activeDoc?.path === node.path
    return (
      <button
        className={`tree-doc ${active ? 'active' : ''} ${blocked ? 'blocked' : ''}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        draggable={!blocked}
        onDragStart={(e) => {
          dragNode = node
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', node.path)
        }}
        onDragEnd={() => {
          dragNode = null
          ctx.onDragLeaveDir()
        }}
        onClick={() => {
          if (blocked) return
          void openDoc(node.path)
        }}
        onDoubleClick={() => {
          if (blocked) return
          void useStore.getState().openTab(node.path, { pinned: true })
        }}
        onContextMenu={(e) => ctx.onMenu(e, node, exactBlocked)}
        title={node.path}
      >
        <span className={`doc-icon ${extClass(node.ext)}`}>{extIcon(node.ext)}</span>
        <span className="doc-name">{node.name}</span>
      </button>
    )
  }

  return (
    <div>
      <button
        className={`tree-dir ${blocked ? 'blocked' : ''} ${dragOver ? 'drag-over' : ''} ${ctx.selectedDir === node.path ? 'sel' : ''}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        draggable={!blocked}
        onDragStart={(e) => {
          dragNode = node
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', node.path)
        }}
        onDragEnd={() => {
          dragNode = null
          ctx.onDragLeaveDir()
        }}
        onDragOver={(e) => {
          if (!dragNode || blocked) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          ctx.onDragOverDir(node.path)
        }}
        onDragLeave={() => ctx.onDragLeaveDir()}
        onDrop={(e) => {
          e.preventDefault()
          ctx.onDropInto(node.path)
        }}
        onClick={() => {
          if (blocked) return
          treeOpenState.set(node.path, !open)
          ctx.onSelectDir(node.path)
          force((v) => v + 1)
        }}
        onContextMenu={(e) => ctx.onMenu(e, node, exactBlocked)}
      >
        <Chevron open={open && !blocked} />
        <span className="dir-name">{node.name}</span>
        <span className="dir-count">{countDocs(node)}</span>
      </button>
      {open && !blocked && node.children?.map((c) => (
        <TreeNode key={c.path} node={c} depth={depth + 1} ctx={ctx} />
      ))}
    </div>
  )
}

function countDocs(node: DocNode): number {
  if (node.type === 'doc') return 1
  return (node.children ?? []).reduce((acc, c) => acc + countDocs(c), 0)
}

export default function Sidebar({ section = 'projects' }: { section?: 'projects' | 'files' }) {
  const {
    projects,
    activeProjectId,
    selectProject,
    removeProject,
    openTab,
    openAddProject,
    disconnectRemote,
    removeRemote,
    reconnectRemote,
    remotes,
    rescan,
    tree,
    treeLoading,
    filter,
    setFilter,
    toast,
    sidebarCollapsed,
    sidebarWidth,
    annPanelWidth,
    setSidebarWidth,
    settings,
    setSetting,
    selectedDir,
    setSelectedDir
  } = useStore()

  /** 右缘拖拽调宽（HTML 文档 iframe 会吞 mousemove，拖拽期间禁用指针事件） */
  const startResize = (e: ReactMouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = e.currentTarget.parentElement!.getBoundingClientRect().width
    const onMove = (ev: MouseEvent): void => section === 'files' ? useStore.getState().setAnnPanelWidth(startW - ev.clientX + startX) : setSidebarWidth(startW + ev.clientX - startX)
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('col-resizing')
    }
    document.body.classList.add('col-resizing')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const [projCollapsed, setProjCollapsed] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [tab, setTab] = useState<TreeTab>('docs')
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [storeRev, setStoreRev] = useState(0) // 别名/屏蔽变更后强制重渲染
  // 重连中条目的 key：连接级占位为远程 id，项目级占位为「远程id:项目id」——
  // 同一远程下的多个项目互不串扰（v0.5.7 修复点一个项目、全部转圈的问题）
  const [connecting, setConnecting] = useState<Set<string>>(new Set())
  const [dropTarget, setDropTarget] = useState<string | null>(null) // 拖拽放置目标（'' = 项目根）
  // 新建文件/文件夹使用内联命名卡片。
  const [namePrompt, setNamePrompt] = useState<{ kind: 'file' | 'dir'; dir: string } | null>(null)
  const [nameValue, setNameValue] = useState('')
  const bump = () => setStoreRev((v) => v + 1)

  const onReconnect = async (remoteId: string, projectId?: string) => {
    const key = projectId ? `${remoteId}:${projectId}` : remoteId
    setConnecting((s) => new Set(s).add(key))
    try {
      const ok = await reconnectRemote(remoteId, projectId)
      // 从项目占位发起的重连：成功后直接选中该项目（v0.6.0，此前需再点一次才切换）；
      // 失败由 reconnectRemote 内部 toast 报错，不切换
      if (ok && projectId) await selectProject(`${remoteId}:${projectId}`)
    } finally {
      setConnecting((s) => {
        const next = new Set(s)
        next.delete(key)
        return next
      })
    }
  }

  const active = useMemo(
    () => projects.find((p) => p.id === activeProjectId),
    [projects, activeProjectId]
  )
  const hiddenIds = useMemo(() => hiddenProjectIds(), [storeRev])
  const displayName = (p: Project) => projectAlias(p.id) ?? p.name

  const onRemove = async (p: Project) => {
    if (await askConfirm(`确定从列表移除「${displayName(p)}」？（不会删除磁盘文件）`, { title: '移除项目', confirmLabel: '移除' })) {
      await removeProject(p.id)
    }
  }

  const onRemoveRemote = async (remoteId: string) => {
    const r = remotes.find((x) => x.id === remoteId)
    if (!r) return
    if (await askConfirm(`确定从列表移除远程连接「${r.name}」？其项目将不再呈现（不影响远端文件）。`)) {
      removeRemote(remoteId)
    }
  }

  const onRename = async (p: Project) => {
    const next = await askInput('项目显示名称（留空恢复默认）', displayName(p))
    if (next === null) return
    setProjectAlias(p.id, next.trim() === '' ? null : next.trim())
    bump()
    toast('ok', next.trim() === '' ? '已恢复默认名称' : '已更名（仅本机显示）')
  }

  const projectMenu = (e: ReactMouseEvent, p: Project): void => {
    e.preventDefault()
    const hidden = hiddenIds.includes(p.id)
    const items: MenuItem[] = [
      { key: 'open', label: '打开项目', onClick: () => void selectProject(p.id) },
      { key: 'rename', label: '重命名…', onClick: () => onRename(p) },
      {
        key: 'abs',
        label: '复制绝对路径',
        onClick: () => {
          navigator.clipboard.writeText(p.path)
          toast('ok', '绝对路径已复制')
        }
      },
      {
        key: 'rel',
        label: '复制相对路径（文件夹名）',
        onClick: () => {
          navigator.clipboard.writeText(p.name)
          toast('ok', '相对路径已复制')
        }
      },
      {
        key: 'hide',
        label: hidden ? '取消屏蔽' : '屏蔽（从列表隐藏）',
        separatorBefore: true,
        onClick: () => {
          if (hidden) {
            unhideProject(p.id)
            bump()
            return
          }
          if (p.id === activeProjectId) {
            toast('info', '当前项目使用中，请先切换到其他项目再屏蔽')
            return
          }
          hideProject(p.id)
          bump()
        }
      },
      ...(p.remoteId
        ? [
            {
              key: 'remove',
              label: '从列表移除…',
              danger: true,
              separatorBefore: true,
              onClick: () => void onRemove(p)
            },
            {
              key: 'disconnect',
              label: '断开远程连接',
              onClick: () => disconnectRemote(p.remoteId!)
            }
          ]
        : [
            {
              key: 'remove',
              label: '从列表移除…',
              danger: true,
              onClick: () => void onRemove(p)
            }
          ])
    ]
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  /** 未连接远程占位条目的右键菜单：重连 / 从列表移除 */
  const remoteMenu = (e: ReactMouseEvent, r: RemoteConfig): void => {
    e.preventDefault()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { key: 'reconnect', label: '重新连接', onClick: () => void onReconnect(r.id) },
        {
          key: 'rm-remote',
          label: '从列表移除…',
          danger: true,
          separatorBefore: true,
          onClick: () => onRemoveRemote(r.id)
        }
      ]
    })
  }

  /** 已断开远程的项目占位条目右键菜单：重连 / 移除该项目（离线可删，本地清单为真相） */
  const offlineProjectMenu = (e: ReactMouseEvent, r: RemoteConfig, p: Project): void => {
    e.preventDefault()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { key: 'reconnect', label: r.connected ? '接入该项目' : '重新连接', onClick: () => void onReconnect(r.id, p.id.slice(r.id.length + 1)) },
        {
          key: 'remove',
          label: '从列表移除…',
          danger: true,
          separatorBefore: true,
          onClick: () => void onRemove(p)
        }
      ]
    })
  }

  /** 重命名文件/目录（仅改最后一段名字，保持所在目录不变） */
  const onRenameNode = async (node: DocNode) => {
    const next = await askInput(`重命名「${node.name}」`, node.name)
    if (next === null) return
    const name = next.trim()
    if (name === node.name) return
    if (!validName(name)) {
      toast('err', '名称不能为空，且不能包含 \\ / : * ? " < > | 或以 . 开头')
      return
    }
    const parent = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : ''
    if (await useStore.getState().fsOp('move', { from: node.path, to: joinPath(parent, name) })) {
      toast('ok', `已重命名为「${name}」`)
    }
  }

  /** 复制副本：同名冲突时依次尝试「副本」「副本 2」…（最多 9） */
  const onCopyNode = async (node: DocNode) => {
    const dot = node.name.lastIndexOf('.')
    const base = node.type === 'doc' && dot > 0 ? node.name.slice(0, dot) : node.name
    const ext = node.type === 'doc' && dot > 0 ? node.name.slice(dot) : ''
    const parent = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : ''
    for (let i = 1; i <= 9; i++) {
      const name = i === 1 ? `${base} 副本${ext}` : `${base} 副本 ${i}${ext}`
      const ok = await useStore.getState().fsOp('copy', { from: node.path, to: joinPath(parent, name) }, { silent: true })
      if (ok) {
        toast('ok', `已复制为「${name}」`)
        return
      }
    }
    toast('err', '未能创建副本（同名文件过多）')
  }

  /** 打开新建命名输入卡（dir 为 '' 表示项目根） */
  const openNamePrompt = (kind: 'file' | 'dir', dir: string): void => {
    setNameValue('')
    setNamePrompt({ kind, dir })
  }

  /** 提交新建：文件无扩展名自动补 .md；重名/越界由 sidecar 报错（fsOp 失败已 toast，卡片保留便于改名重试） */
  const submitNamePrompt = async (): Promise<void> => {
    if (!namePrompt) return
    let name = nameValue.trim()
    if (!validName(name)) {
      toast('err', '名称不能为空，且不能包含 \\ / : * ? " < > | 或以 . 开头')
      return
    }
    if (namePrompt.dir !== '') treeOpenState.set(namePrompt.dir, true)
    if (namePrompt.kind === 'file') {
      if (!name.includes('.')) name = `${name}.md`
      const to = joinPath(namePrompt.dir, name)
      const title = name.replace(/\.(md|markdown|txt)$/i, '')
      if (await useStore.getState().fsOp('create', { to, content: `# ${title}\n\n` })) {
        toast('ok', `已创建「${name}」`)
        setNamePrompt(null)
        void useStore.getState().openDoc(to)
      }
    } else if (await useStore.getState().fsOp('mkdir', { to: joinPath(namePrompt.dir, name) })) {
      toast('ok', `已创建文件夹「${name}」`)
      setNamePrompt(null)
    }
  }

  const onDeleteNode = async (node: DocNode) => {
    const tip = node.type === 'dir' ? '目录内的全部内容将一并删除。' : ''
    if (!await askConfirm(`确定删除「${node.name}」？${tip}此操作不可撤销。`)) return
    if (await useStore.getState().fsOp('delete', { from: node.path })) {
      toast('ok', `已删除「${node.name}」`)
    }
  }

  /** 拖拽移动到目标目录（'' = 项目根）；目录不能移入自身或其子孙 */
  const onDropInto = async (target: string) => {
    const node = dragNode
    dragNode = null
    setDropTarget(null)
    if (!node || !active) return
    if (target === node.path || target.startsWith(node.path + '/')) {
      toast('info', '不能移动到自身或其子目录内')
      return
    }
    const parent = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : ''
    if (parent === target) {
      toast('info', '已在该目录内')
      return
    }
    const to = joinPath(target, node.name)
    if (await useStore.getState().fsOp('move', { from: node.path, to })) {
      toast('ok', `已移动「${node.name}」到 ${target === '' ? '项目根目录' : `「${target}」`}`)
      if (target !== '') treeOpenState.set(target, true)
    }
  }

  const treeMenu = (e: ReactMouseEvent, node: DocNode, exactBlocked: boolean): void => {
    e.preventDefault()
    if (!active) return
    const abs = `${active.path}\\${node.path.replace(/\//g, '\\')}`
    const items: MenuItem[] = []
    if (node.type === 'doc') {
      items.push({
        key: 'open',
        label: '打开文档',
        onClick: () => void useStore.getState().openDoc(node.path)
      })
      items.push({ key: 'rename', label: '重命名…', onClick: () => void onRenameNode(node) })
      items.push({ key: 'copy', label: '复制（副本）', onClick: () => void onCopyNode(node) })
    } else {
      items.push({ key: 'newdoc', label: '新建文件…', onClick: () => openNamePrompt('file', node.path) })
      items.push({ key: 'newdir', label: '新建文件夹…', onClick: () => openNamePrompt('dir', node.path) })
      items.push({ key: 'rename', label: '重命名…', separatorBefore: true, onClick: () => void onRenameNode(node) })
      items.push({ key: 'copy', label: '复制（副本）', onClick: () => void onCopyNode(node) })
    }
    items.push({
      key: 'reldoc',
      label: '复制相对路径',
      separatorBefore: node.type === 'doc',
      onClick: () => {
        navigator.clipboard.writeText(node.path)
        toast('ok', '相对路径已复制')
      }
    })
    items.push({
      key: 'absdoc',
      label: '复制绝对路径',
      onClick: () => {
        navigator.clipboard.writeText(abs)
        toast('ok', '绝对路径已复制')
      }
    })
    items.push({
      key: 'delete',
      label: '删除…',
      danger: true,
      separatorBefore: true,
      onClick: () => void onDeleteNode(node)
    })
    items.push({
      key: 'block',
      label: exactBlocked ? '取消屏蔽' : '屏蔽',
      danger: !exactBlocked,
      onClick: () => {
        if (exactBlocked) {
          unblockPath(active.id, node.path)
          toast('ok', `已取消屏蔽「${node.name}」`)
        } else {
          blockPath(active.id, node.path)
          toast('ok', `已屏蔽「${node.name}」`)
        }
        bump()
      }
    })
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  const visibleProjects = projects.filter((p) => showHidden || !hiddenIds.includes(p.id))
  const hiddenCount = projects.filter((p) => hiddenIds.includes(p.id)).length
  // 未连接的远程连接：重启后不自动重连，占位显示 + ⟳ 手动重连（zcode 式）；
  // v0.5.6 起分项目管理——连接在线但仅部分项目接入时，其余项目同样显示占位
  const disconnectedRemotes = remotes
    .map((r) => {
      const snaps = r.projects ?? []
      if (!r.connected) return { remote: r, snaps }
      if (r.connectedProjectIds === undefined) return { remote: r, snaps: [] as typeof snaps }
      return { remote: r, snaps: snaps.filter((sp) => !r.connectedProjectIds!.includes(sp.id)) }
    })
    .filter((e) => !e.remote.connected || e.snaps.length > 0)

  // 折叠态：不渲染侧栏（折叠/展开统一由标题栏 ☰ 按钮控制）
  if (section === 'projects' && sidebarCollapsed) return null

  return (
    <aside className={`sidebar ${section === 'files' ? 'resource-sidebar' : 'project-sidebar'}`} style={{ width: section === 'files' ? annPanelWidth : sidebarWidth }} aria-label={section === 'files' ? '项目文件' : '项目列表'}>
      <div className="sb-resizer" onMouseDown={startResize} title="拖拽调整宽度" />
      {section === 'projects' && <div className="sb-projects">
        <div className="sb-head-row">
        <button className="sb-proj-toggle" onClick={() => setProjCollapsed(!projCollapsed)}>
          <Chevron open={!projCollapsed} />
          项目（{visibleProjects.length}）
          {hiddenCount > 0 && (
            <span
              className="sb-hidden-count"
              title="显示/隐藏被屏蔽的项目"
              onClick={(e) => {
                e.stopPropagation()
                setShowHidden(!showHidden)
              }}
            >
              屏蔽 {hiddenCount}
            </span>
          )}
        </button>
        </div>
        {!projCollapsed && (
          <div className="sb-proj-list">
            {visibleProjects.map((p) => {
              const hidden = hiddenIds.includes(p.id)
              return (
                <button
                  key={p.id}
                  className={`proj-item ${p.id === activeProjectId ? 'active' : ''} ${hidden ? 'blocked' : ''}`}
                  onClick={() => void selectProject(p.id)}
                  onContextMenu={(e) => projectMenu(e, p)}
                  title={`${displayName(p)}\n${p.path}\n（右键：更名/屏蔽/复制路径/移除）`}
                >
                  <span className="proj-name">{p.remoteId ? '🌐 ' : '💻 '}{displayName(p)}</span>
                  <span className="proj-count">{p.docCount} 篇</span>
                </button>
              )
            })}
            {disconnectedRemotes.flatMap(({ remote: r, snaps }) => {
              // 无项目快照：保留连接名占位（否则该连接无从重连/移除）
              if (snaps.length === 0) {
                return [
                  <div
                    key={r.id}
                    className="proj-item proj-remote-off"
                    onContextMenu={(e) => remoteMenu(e, r)}
                    title={`${r.name}\n${r.host}:${r.port}\n未连接${r.lastError ? `\n上次失败：${r.lastError}` : ''}\n（右键：重连/从列表移除）`}
                  >
                    <span className="proj-name">🌐 {r.name}</span>
                    <button
                      className={`proj-reconnect ${connecting.has(r.id) ? 'spin' : ''}`}
                      title="重新连接"
                      disabled={connecting.has(r.id)}
                      onClick={() => void onReconnect(r.id)}
                    >
                      ⟳
                    </button>
                  </div>
                ]
              }
              // 断开后按原项目名占位（而非连接名）；点击/⟳ 只接入该项目（分项目管理），
              // 右键可移除单个项目；连接在线时接入是本地操作（秒回）
              return snaps.map((sp) => {
                const proj: Project = { ...sp, id: `${r.id}:${sp.id}`, remoteId: r.id, addedAt: '' }
                return (
                  <div
                    key={proj.id}
                    className="proj-item proj-remote-off"
                    onClick={() => void onReconnect(r.id, sp.id)}
                    onContextMenu={(e) => offlineProjectMenu(e, r, proj)}
                    title={`${displayName(proj)}\n${sp.path}\n${r.connected ? '未接入' : '未连接'}${!r.connected && r.lastError ? `（上次失败：${r.lastError}）` : ''}\n（点击接入；右键：接入/移除）`}
                  >
                    <span className="proj-name">🌐 {displayName(proj)}</span>
                    <button
                      className={`proj-reconnect ${connecting.has(proj.id) ? 'spin' : ''}`}
                      title={r.connected ? '接入该项目' : '重新连接'}
                      disabled={connecting.has(proj.id)}
                      onClick={(e) => {
                        e.stopPropagation()
                        void onReconnect(r.id, sp.id)
                      }}
                    >
                      ⟳
                    </button>
                  </div>
                )
              })
            })}
            <button className="proj-import" onClick={openAddProject}>
              ＋ 添加项目
            </button>
          </div>
        )}
      </div>}

      {section === 'files' && !active && <div className="sb-empty">选择项目后浏览文件</div>}
      {section === 'files' && active && (
        <>
          <div
            className={`sb-proj-head ${dropTarget === '' ? 'drag-over' : ''}`}
            onDragOver={(e) => {
              if (!dragNode) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setDropTarget('')
            }}
            onDragLeave={() => setDropTarget(null)}
            onDrop={(e) => {
              e.preventDefault()
              void onDropInto('')
            }}
          >
            <div className="sb-proj-name" title={active.path}>
              {displayName(active)}
            </div>
            <div className="sb-proj-head-right">
              <button
                className={`pf-chip ${filterDocsForProject(settings, active) ? 'on' : ''}`}
                title={
                  filterDocsForProject(settings, active)
                    ? '文件树：仅文档（点击显示全部文件）'
                    : '文件树：全部文件（点击仅显示文档）'
                }
                onClick={() =>
                  setSetting('resourceFilterDocsByProject', {
                    ...settings.resourceFilterDocsByProject,
                    [filterKeyForProject(active)]: !filterDocsForProject(settings, active)
                  })
                }
              >
                {filterDocsForProject(settings, active) ? '文档' : '全部'}
              </button>
              <div className="sb-proj-ops">
                <button
                  onClick={(e) =>
                    setMenu({
                      x: e.clientX,
                      y: e.clientY,
                      items: [
                        { key: 'newfile', label: '新建文件…', onClick: () => openNamePrompt('file', selectedDir ?? '') },
                        { key: 'newdir', label: '新建文件夹…', onClick: () => openNamePrompt('dir', selectedDir ?? '') }
                      ]
                    })
                  }
                  title={selectedDir ? `新建文件 / 文件夹（${selectedDir} 下）` : '新建文件 / 文件夹（项目根；点击目录行可选目标）'}
                >
                  ＋
                </button>
                <button onClick={() => void rescan()} title="重新扫描文档">⟳</button>
                <button onClick={() => void onRemove(active)} title="从列表移除">✕</button>
              </div>
            </div>
          </div>

          {namePrompt && (
            <div className="sb-newfile-card">
              <div className="sb-newfile-title">
                {namePrompt.kind === 'file' ? '新建文件' : '新建文件夹'}
                {namePrompt.dir ? `（${namePrompt.dir} 下）` : '（项目根）'}
              </div>
              <input
                autoFocus
                value={nameValue}
                onChange={(e) => setNameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void submitNamePrompt()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setNamePrompt(null)
                  }
                }}
                placeholder={namePrompt.kind === 'file' ? '文件名（无扩展名自动补 .md）' : '文件夹名'}
                spellCheck={false}
              />
              <div className="sb-newfile-ops">
                <button className="btn-primary sm" onClick={() => void submitNamePrompt()}>
                  创建
                </button>
                <button className="btn-ghost sm" onClick={() => setNamePrompt(null)}>
                  取消
                </button>
              </div>
            </div>
          )}

          <div className="sb-tabs">
            <button
              className={tab === 'docs' ? 'active' : ''}
              onClick={() => setTab('docs')}
            >
              文件
            </button>
            <button
              className={tab === 'search' ? 'active' : ''}
              onClick={() => setTab('search')}
              title="搜索项目文档内容"
            >
              搜索
            </button>
            <button className={tab === 'git' ? 'active' : ''} onClick={() => setTab('git')}>
              Git
            </button>
          </div>

          {tab === 'docs' ? (
            // 项目级过滤：文档（默认记录为 true 时）或全部源码文件树（无记录/关）
            filterDocsForProject(settings, active) ? (
            <>
              <div className="sb-filter">
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="过滤文档名…"
                  spellCheck={false}
                />
              </div>
              <div className="sb-tree">
                {treeLoading && <div className="sb-empty">扫描中…</div>}
                {!treeLoading && tree && (tree.children?.length ?? 0) === 0 && (
                  <div className="sb-empty">未找到 Markdown / HTML / TXT 文档</div>
                )}
                {tree?.children?.map((c) => (
                    <TreeNode
                      key={c.path}
                      node={c}
                      depth={0}
                      ctx={{
                        projectId: active.id,
                        onMenu: treeMenu,
                        dropTarget,
                        onDropInto: (t) => void onDropInto(t),
                        onDragOverDir: (t) => setDropTarget((cur) => (cur === t ? cur : t)),
                        onDragLeaveDir: () => setDropTarget(null),
                        selectedDir,
                        onSelectDir: (t) => setSelectedDir(t)
                      }}
                    />
                  ))}
              </div>
            </>
            ) : (
              <CodeTree />
            )
          ) : tab === 'search' ? (
            <div className="sb-tree git-tree">
              <SearchPanel projectId={active.id} />
            </div>
          ) : (
            <div className="sb-tree git-tree">
              <GitPanel projectId={active.id} />
            </div>
          )}
        </>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </aside>
  )
}
