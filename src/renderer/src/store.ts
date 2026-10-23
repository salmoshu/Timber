import { askConfirm } from './utils/dialogs'
import { create } from 'zustand'
import type { Project, RemoteConfig } from '@shared/types'
import type { Annotation, AnnotationKind, ArchDeltaReceipt, ArchResult, ArchSpec, CommitDetail, CommitInfo, DocContent, DocNode } from '@shared/types'
import { api, apiWith, apiInfo, archSpec, gitLog, gitShow, type ApiCall, type ApiOpts } from './api'
import {
  establishRemote,
  loadRemotes,
  reestablishRemote,
  remoteBase,
  saveRemotes,
  syncRemoteProjects,
  teardownRemote,
  type ConnectParams,
  type LogLine
} from './utils/remote'
import { applyAppearance, loadSettings, saveSettings, type AppSettings } from './utils/settings'
import { DOC_FORMAT_GROUPS } from '@shared/types'

/** 当前设置选中的扩展名列表（拼到 tree/rescan/search 请求） */
function extsList(): string[] {
  const keys = useStore.getState().settings.docFormats
  return DOC_FORMAT_GROUPS.filter((g) => keys.includes(g.key)).flatMap((g) => g.exts)
}

function extsQuery(): string {
  const exts = extsList()
  return exts.length > 0 ? `&exts=${encodeURIComponent(exts.join(','))}` : ''
}

/** 源码 + 文本扩展名（代码视图树请求参数；原在 CodeView，v0.5.6 收敛到 store 供侧栏复用） */
export const CODE_EXTS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.go', '.py', '.rs', '.java', '.kt',
  '.vue', '.svelte', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.swift',
  '.scala', '.sh', '.ps1', '.css', '.scss', '.html',
  '.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.toml', '.xml', '.csv', '.log'
]

/** 资源视图中走 Reader（可编辑/阅读渲染）的扩展名；其余源码文件走 CodeReader（只读） */
const READER_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd', 'txt', 'html', 'htm', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'])

export function isReaderPath(path: string): boolean {
  return READER_EXTS.has((path.split('.').pop() ?? '').toLowerCase())
}

export type ViewMode = 'read' | 'source'

/** 文件树操作类型（sidecar /api/projects/:id/fs） */
export type FsOp = 'move' | 'copy' | 'delete' | 'mkdir' | 'create'

/** 一个打开的文档标签（VSCode 语义：preview 标签被单击复用，双击固定为独立标签） */
export interface DocTab {
  id: string
  /** 相对项目根路径 */
  path: string
  pinned: boolean
  mode: ViewMode
  /** 编辑草稿与脏状态随标签保留（切标签不丢） */
  draft: string
  dirty: boolean
  /** 阅读区滚动位置（切换后恢复） */
  scrollTop: number
  /** 已加载的文档内容缓存（切回标签即时呈现，后台校验新鲜度） */
  doc?: DocContent
}

export interface Toast {
  id: number
  kind: 'ok' | 'err' | 'info'
  text: string
}

/** 项目工作区缓存：切换项目时保存/还原打开的文档标签状态（会话内有效） */
const projectWorkspaces = new Map<string, { tabs: DocTab[]; activeTabId: string | null }>()

/** 提交历史分页大小 */
const COMMIT_PAGE_SIZE = 100
/** 架构影响懒算并发去重（sha 级） */
const pendingImpacts = new Set<string>()

/** 写入提交架构影响缓存（不可变更新 Map 触发订阅） */
function setImpact(
  set: (partial: Partial<State>) => void,
  get: () => State,
  sha: string,
  impact: CommitImpact
): void {
  const next = new Map(get().commitImpactCache)
  next.set(sha, impact)
  set({ commitImpactCache: next })
}

/** delta 回执摘要 → 徽章文案，如 `+2组件 −1连接 ~3改动`；无变化返回空串 */
function formatImpactSummary(receipt: ArchDeltaReceipt): string {
  const s = receipt.summary
  if (!s) return ''
  const parts: string[] = []
  const cAdd = s.components?.added ?? 0
  const cDel = s.components?.removed ?? 0
  const eAdd = s.connections?.added ?? 0
  const eDel = s.connections?.removed ?? 0
  const mod =
    (s.components?.changed ?? 0) +
    (s.components?.moved ?? 0) +
    (s.connections?.changed ?? 0) +
    (s.connections?.rerouted ?? 0)
  if (cAdd > 0) parts.push(`+${cAdd}组件`)
  if (cDel > 0) parts.push(`−${cDel}组件`)
  if (eAdd > 0) parts.push(`+${eAdd}连接`)
  if (eDel > 0) parts.push(`−${eDel}连接`)
  if (mod > 0) parts.push(`~${mod}改动`)
  return parts.join(' ')
}

const IMAGE_EXT_SET = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'])

/**
 * 活动文档外部变更轮询：标签打开期间磁盘原文被其它程序（agent / 编辑器）更新时，
 * 若本地没有未保存修改，自动重载内容——阅读模式经订阅整体重渲染，编辑模式刷新草稿。
 * 图片等二进制不校验；请求失败静默（远程项目网络抖动），下个周期再试。
 */
let activeDocWatcherStarted = false
function startActiveDocWatcher(): void {
  if (activeDocWatcherStarted) return
  activeDocWatcherStarted = true
  setInterval(() => {
    void (async () => {
      const s = useStore.getState()
      if (!s.activeDoc || !s.activeProjectId || !s.activeTabId || s.dirty || s.docLoading || s.docError) return
      if (IMAGE_EXT_SET.has(s.activeDoc.ext)) return
      try {
        const doc = await apiFor<DocContent>(s.activeProjectId)(
          'GET',
          `/api/projects/${s.activeProjectId}/doc?path=${encodeURIComponent(s.activeDoc.path)}`
        )
        const cur = useStore.getState()
        if (cur.activeTabId !== s.activeTabId || cur.dirty || cur.docLoading) return
        if (doc.mtime !== s.activeDoc.mtime || doc.size !== s.activeDoc.size) {
          cur.patchActiveTab({ doc })
          useStore.setState({ activeDoc: doc, draft: doc.content, dirty: false })
        }
      } catch {
        /* 静默重试 */
      }
    })()
  }, 5000)
}

/** 应用主视图：提交历史 / 架构图 / 资源（文档与代码合并，v0.5.9） */
export type AppView = 'history' | 'architecture' | 'resources'

/** 提交「架构影响」懒算结果（提交与其首个 parent 的 spec delta 摘要） */
export interface CommitImpact {
  /** 展示文本，如 `+2组件 −1连接 ~3改动`；空串 = 无变化 */
  text: string
}

/** 从架构视图/历史详情发起的 delta 对比请求（base/head 为 ref 或 sha） */
export interface ArchDeltaRequest {
  base: string
  head: string
}

/**
 * 旧品牌 localStorage key 一次性迁移（awesome-notes-* → timber-*）。
 * 仅在新 key 不存在时拷贝，旧 key 保留无副作用。须在 store 创建前执行
 * （loadLayout/loadSettings/loadRemotes 等在模块初始化即读 localStorage）。
 */
function migrateLegacyKeys(): void {
  try {
    const exact: [string, string][] = [
      ['awesome-notes-layout', 'timber-layout'],
      ['awesome-notes-hidden-projects', 'timber-hidden-projects'],
      ['awesome-notes-remotes', 'timber-remotes'],
      ['awesome-notes-settings', 'timber-settings'],
      ['awesome-notes-updater-prefs', 'timber-updater-prefs']
    ]
    const prefixes: [string, string][] = [
      ['awesome-notes-alias:', 'timber-alias:'],
      ['awesome-notes-blocked:', 'timber-blocked:']
    ]
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key) continue
      for (const [oldK, newK] of exact) {
        if (key === oldK && localStorage.getItem(newK) === null) {
          const v = localStorage.getItem(oldK)
          if (v !== null) localStorage.setItem(newK, v)
        }
      }
      for (const [oldP, newP] of prefixes) {
        if (key.startsWith(oldP)) {
          const newKey = newP + key.slice(oldP.length)
          if (localStorage.getItem(newKey) === null) {
            const v = localStorage.getItem(key)
            if (v !== null) localStorage.setItem(newKey, v)
          }
        }
      }
    }
  } catch {
    /* 存储不可用时跳过迁移 */
  }
}
migrateLegacyKeys()

// ---- 布局偏好：侧栏折叠/宽度、批注面板宽度（localStorage 持久化） ----
const LAYOUT_KEY = 'timber-layout'
export const SIDEBAR_MIN_W = 180
export const SIDEBAR_MAX_W = 520
export const ANN_MIN_W = 240
export const ANN_MAX_W = 640
/** 侧栏再宽也要给正文区留下的最小宽度 */
export const EDITOR_MIN_W = 360
const SIDEBAR_COLLAPSED_W = 36

interface LayoutPrefs {
  sidebarCollapsed: boolean
  sidebarWidth: number
  annPanelWidth: number
}

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(v)))

/** 动态上限：窗口宽度减去另一侧面板与正文最小宽，防止两侧栏把正文挤没（面板重叠遮挡工具栏） */
const sidebarDynMax = (annOpen: boolean, annW: number): number =>
  Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, window.innerWidth - (annOpen ? annW : 0) - EDITOR_MIN_W))
const annDynMax = (sbCollapsed: boolean, sbW: number): number =>
  Math.max(ANN_MIN_W, Math.min(ANN_MAX_W, window.innerWidth - (sbCollapsed ? SIDEBAR_COLLAPSED_W : sbW) - EDITOR_MIN_W))

function loadLayout(): LayoutPrefs {
  const def = { sidebarCollapsed: false, sidebarWidth: 240, annPanelWidth: 280 }
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (!raw) return def
    const p = JSON.parse(raw) as Partial<LayoutPrefs>
    return {
      sidebarCollapsed: p.sidebarCollapsed === true,
      sidebarWidth: clamp(Number(p.sidebarWidth) || def.sidebarWidth, SIDEBAR_MIN_W, SIDEBAR_MAX_W),
      annPanelWidth: clamp(Number(p.annPanelWidth) || def.annPanelWidth, ANN_MIN_W, ANN_MAX_W)
    }
  } catch {
    return def
  }
}

function saveLayout(l: LayoutPrefs): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(l))
  } catch { /* 存储不可用时布局仅在会话内有效 */ }
}

let tabSeq = 1
let toastSeq = 1
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null

function newTabId(): string {
  return 'tab-' + tabSeq++
}

interface State {
  ready: boolean
  fatalError: string | null
  /** 本地 + 已连接远程（合并视图，远程条目带 remoteId） */
  projects: Project[]
  localProjects: Project[]
  remotes: RemoteConfig[]
  addProjectOpen: boolean
  activeProjectId: string | null
  tree: DocNode | null
  treeLoading: boolean
  filter: string
  /** 文件树中选中的目录（「＋」新建的目标；null/'' = 项目根，文档树与源码树共享） */
  selectedDir: string | null
  tabs: DocTab[]
  activeTabId: string | null
  activeDoc: DocContent | null
  docLoading: boolean
  /** 文档打开失败的原因（呈现错误卡片与关闭按钮；null = 无错误） */
  docError: string | null
  mode: ViewMode
  draft: string
  dirty: boolean
  saving: boolean
  annotations: Annotation[]
  annPanelOpen: boolean
  composeQuote: { quote: string; prefix: string; suffix: string } | null
  toasts: Toast[]
  settings: AppSettings
  settingsOpen: boolean
  extPageUrl: string | null
  /** 搜索结果点击后待定位：打开文档后滚到首个命中处 */
  pendingLocate: { path: string; keyword: string } | null
  /** 左侧边栏折叠为窄条 */
  sidebarCollapsed: boolean
  /** 左侧边栏宽度（px，右缘拖拽调整） */
  sidebarWidth: number
  /** 右侧目录/批注面板宽度（px，左缘拖拽调整） */
  annPanelWidth: number
  /** 应用主视图（默认文档） */
  view: AppView
  /** 提交历史列表（分页追加） */
  commits: CommitInfo[]
  commitsTotal: number
  commitsLoading: boolean
  /** commits 所属项目（项目切换后需重载） */
  commitsProjectId: string | null
  selectedSha: string | null
  commitDetail: CommitDetail | null
  commitDetailLoading: boolean
  /** 架构 spec 缓存：ref（或 sha）→ spec；archRender/archDelta 复用 */
  archSpecCache: Map<string, ArchSpec>
  /** 架构 HTML 缓存：`<projectId>:<ref或sha对>` → 自包含 HTML */
  archHtmlCache: Map<string, string>
  /** 提交架构影响懒算缓存：sha → 摘要（text 为空 = 不显示徽章） */
  commitImpactCache: Map<string, CommitImpact>
  /** 资源视图的源码文件树（扩展名集合独立于文档树，v0.5.6 起由 store 托管供侧栏复用） */
  codeTree: DocNode | null
  codeTreeLoading: boolean
  /** 历史详情「查看架构对比」发起的 delta 请求（architecture 视图消费） */
  archDeltaRequest: ArchDeltaRequest | null

  setView(v: AppView): void
  /** 重新加载提交列表（第一页） */
  loadCommits(): Promise<void>
  /** 加载更多（skip 分页追加） */
  loadMoreCommits(): Promise<void>
  /** 选中提交并加载详情 */
  selectCommit(sha: string | null): Promise<void>
  /** 取某 ref 的架构 spec（带缓存；失败返回 { ok:false, error }，错误不缓存） */
  ensureArchSpec(ref: string): Promise<ArchResult>
  /** 懒算提交架构影响（与其首个 parent 的 delta 摘要），结果写入 commitImpactCache */
  ensureCommitImpact(c: CommitInfo): Promise<void>
  /** 在资源视图中打开文件（按类型路由 Reader/CodeReader） */
  openFile(path: string): void
  /** 切到 architecture 视图的 delta 对比模式 */
  openArchDelta(base: string, head: string): void

  toggleSidebar(): void
  setSidebarWidth(w: number): void
  setAnnPanelWidth(w: number): void

  setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void
  openSettings(): void
  closeSettings(): void
  openAddProject(): void
  closeAddProject(): void
  connectRemote(params: ConnectParams, onLog?: (l: LogLine) => void): Promise<string>
  /** 重连远程连接；带 projectId 时只接入该项目（分项目管理，v0.5.6） */
  /** 重连远程（可分项目接入）；返回是否成功（v0.6.0 起供侧栏成功后自动选中项目） */
  reconnectRemote(remoteId: string, projectId?: string): Promise<boolean>
  /** 断开连接：远程条目保留在列表中（未连接占位，可 ⟳ 重连），其项目从列表消失 */
  disconnectRemote(remoteId: string): void
  /** 从列表移除：远程条目彻底移除，不再呈现（不影响远端文件） */
  removeRemote(remoteId: string): void
  /** 在已连接的远程上导入目录为项目 */
  importRemoteProject(remoteId: string, path: string): Promise<void>
  openExtPage(url: string): void
  closeExtPage(): void
  setPendingLocate(v: { path: string; keyword: string } | null): void

  init(): Promise<void>
  toast(kind: Toast['kind'], text: string): void
  importProject(path: string): Promise<void>
  removeProject(id: string): Promise<void>
  selectProject(id: string): Promise<void>
  rescan(): Promise<void>
  /** 加载/刷新代码视图的源码文件树（selectProject/rescan/fsOp 后调用） */
  loadCodeTree(): Promise<void>

  /** 单击：预览语义（复用预览标签）；双击：固定为新标签 */
  openTab(path: string, opts?: { pinned?: boolean }): Promise<void>
  /** 兼容入口 = 预览打开（搜索/Git/目录跳转等） */
  openDoc(path: string): Promise<void>
  activateTab(id: string): Promise<void>
  closeTab(id: string): void
  /** 关闭除 id 外的所有标签（含未保存修改的标签需确认；激活标签被关时切到 id） */
  closeOtherTabs(id: string): void
  /** 关闭 id 右侧的所有标签（含未保存修改的标签需确认；激活标签被关时切到 id） */
  closeTabsToRight(id: string): void
  /** 固定标签（双击标签名，等效文件树双击） */
  pinTab(id: string): void
  /** 拖拽排序：把 fromId 标签移动到 toId 之前/之后（toId 为空则移到末尾） */
  reorderTabs(fromId: string, toId: string | null, position: 'before' | 'after'): void
  patchActiveTab(patch: Partial<DocTab>): void

  setFilter(f: string): void
  setSelectedDir(p: string | null): void
  setMode(m: ViewMode): void
  setDraft(d: string): void
  saveDoc(): Promise<void>
  /** 重新从磁盘读取当前文档（未保存修改将丢弃，需确认；图片不支持） */
  refreshActiveDoc(): Promise<void>
  /**
   * 文件树操作（重命名/移动、复制、删除、新建目录、新建文档）。
   * 成功后静默重扫文件树并维护打开的标签（移动改路径、删除关闭），
   * 批注锚点由 sidecar 在 move/delete 时同步迁移。silent 抑制错误 toast。
   */
  fsOp(op: FsOp, args: { from?: string; to?: string; content?: string }, opts?: { silent?: boolean }): Promise<boolean>
  loadAnnotations(): Promise<void>
  toggleAnnPanel(): void
  setComposeQuote(q: State['composeQuote']): void
  createAnnotation(text: string, kind: AnnotationKind): Promise<void>
  setAnnStatus(a: Annotation, status: 'open' | 'done'): Promise<void>
  /** 编辑批注内容（引用锚点不变） */
  editAnnotation(a: Annotation, text: string): Promise<void>
  deleteAnnotation(a: Annotation): Promise<void>
}

/** 远程项目合成 id（rm-xxx:origId）→ 还原为远端原始 id */
export function origProjectId(projectId: string): string {
  return projectId.replace(/^rm-[a-z0-9]+:/, '')
}

/** 按项目路由 API：远程项目走远端 timberd（并还原路径中的原始项目 id），本地项目走默认 */
export function apiFor<T = unknown>(
  projectId: string | null | undefined
): (method: string, path: string, body?: unknown, opts?: ApiOpts) => Promise<T> {
  const remotes = useStore.getState().remotes
  const remote =
    projectId && projectId.includes(':')
      ? remotes.find((r) => projectId.startsWith(r.id + ':'))
      : undefined
  if (remote) {
    const base = remoteBase(remote)
    const token = remote.token
    return (method: string, path: string, body?: unknown, opts?: ApiOpts) =>
      apiWith<T>(base, token, method, path.split(remote.id + ':').join(''), body, opts)
  }
  return (method: string, path: string, body?: unknown, opts?: ApiOpts) =>
    api<T>(method, path, body, opts)
}

/** 项目（含远程）对应的 /raw 文件服务 base（HTML iframe 用） */
export async function rawBaseFor(projectId: string | null | undefined): Promise<string> {
  const remotes = useStore.getState().remotes
  const remote =
    projectId && projectId.includes(':')
      ? remotes.find((r) => projectId.startsWith(r.id + ':'))
      : undefined
  if (remote) return remoteBase(remote)
  return (await apiInfo()).base
}

/** 按项目路由的通用调用器（api.ts 的 gitLog/gitShow/archRefs/archSpec 注入用；远程项目走远端 timberd） */
export function apiCallFor(projectId: string): ApiCall {
  return <T = unknown,>(method: string, path: string, body?: unknown, opts?: ApiOpts): Promise<T> =>
    apiFor<T>(projectId)(method, path, body, opts)
}

/** 两个远程配置是否指向同一目标（防重复连接导致项目翻倍） */
function sameRemoteTarget(a: RemoteConfig, b: RemoteConfig): boolean {
  if ((a.kind ?? 'custom') !== (b.kind ?? 'custom')) return false
  if (a.kind === 'wsl' && b.kind === 'wsl') return (a.wsl?.distro ?? '') === (b.wsl?.distro ?? '')
  if (a.kind === 'ssh' && b.kind === 'ssh')
    return a.ssh?.host === b.ssh?.host && a.ssh?.user === b.ssh?.user
  return a.host === b.host && a.port === b.port
}

function mergeProjects(local: Project[], remotes: RemoteConfig[], remoteProjects: Project[]): Project[] {
  return [...local, ...remoteProjects.filter((p) => {
    if (!p.remoteId) return false
    const r = remotes.find((x) => x.id === p.remoteId)
    if (!r?.connected) return false
    // 分项目连接管理（v0.5.6）：undefined = 全部可见；数组 = 仅清单内项目可见
    if (r.connectedProjectIds === undefined) return true
    return r.connectedProjectIds.includes(p.id.slice(p.remoteId.length + 1))
  })]
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  fatalError: null,
  projects: [],
  localProjects: [],
  remotes: loadRemotes(),
  addProjectOpen: false,
  activeProjectId: null,
  tree: null,
  treeLoading: false,
  filter: '',
  selectedDir: null,
  tabs: [],
  activeTabId: null,
  activeDoc: null,
  docLoading: false,
  docError: null,
  mode: 'read',
  draft: '',
  dirty: false,
  saving: false,
  annotations: [],
  annPanelOpen: true,
  composeQuote: null,
  toasts: [],
  settings: loadSettings(),
  settingsOpen: false,
  extPageUrl: null,
  pendingLocate: null,
  ...loadLayout(),

  view: 'resources',
  commits: [],
  commitsTotal: 0,
  commitsLoading: false,
  commitsProjectId: null,
  selectedSha: null,
  commitDetail: null,
  commitDetailLoading: false,
  archSpecCache: new Map(),
  archHtmlCache: new Map(),
  commitImpactCache: new Map(),
  codeTree: null,
  codeTreeLoading: false,
  archDeltaRequest: null,

  toggleSidebar() {
    const next = !get().sidebarCollapsed
    set({ sidebarCollapsed: next })
    saveLayout({ sidebarCollapsed: next, sidebarWidth: get().sidebarWidth, annPanelWidth: get().annPanelWidth })
  },

  setSidebarWidth(w) {
    const v = clamp(w, SIDEBAR_MIN_W, sidebarDynMax(get().annPanelOpen, get().annPanelWidth))
    set({ sidebarWidth: v })
    saveLayout({ sidebarCollapsed: get().sidebarCollapsed, sidebarWidth: v, annPanelWidth: get().annPanelWidth })
  },

  setAnnPanelWidth(w) {
    const v = clamp(w, ANN_MIN_W, annDynMax(get().sidebarCollapsed, get().sidebarWidth))
    set({ annPanelWidth: v })
    saveLayout({ sidebarCollapsed: get().sidebarCollapsed, sidebarWidth: get().sidebarWidth, annPanelWidth: v })
  },

  setView(v) {
    set({ view: v })
  },

  async loadCommits() {
    const id = get().activeProjectId
    if (!id) return
    set({ commitsLoading: true, commits: [], commitsTotal: 0, commitsProjectId: id })
    try {
      const r = await gitLog(id, 0, COMMIT_PAGE_SIZE, apiCallFor(id))
      if (get().activeProjectId !== id) return
      set({ commits: r.commits ?? [], commitsTotal: r.total ?? 0, commitsLoading: false })
    } catch (err) {
      if (get().activeProjectId !== id) return
      set({ commitsLoading: false })
      get().toast('err', `提交历史加载失败：${err}`)
    }
  },

  async loadMoreCommits() {
    const s = get()
    const id = s.activeProjectId
    if (!id || s.commitsLoading || s.commits.length >= s.commitsTotal) return
    set({ commitsLoading: true })
    try {
      const r = await gitLog(id, s.commits.length, COMMIT_PAGE_SIZE, apiCallFor(id))
      if (get().activeProjectId !== id) return
      set({ commits: [...get().commits, ...(r.commits ?? [])], commitsTotal: r.total ?? s.commitsTotal, commitsLoading: false })
    } catch (err) {
      if (get().activeProjectId !== id) return
      set({ commitsLoading: false })
      get().toast('err', `提交历史加载失败：${err}`)
    }
  },

  async selectCommit(sha) {
    const s = get()
    const id = s.activeProjectId
    set({ selectedSha: sha, commitDetail: null, commitDetailLoading: sha !== null })
    if (!sha || !id) return
    try {
      const detail = await gitShow(id, sha, apiCallFor(id))
      // 防止加载期间用户改选其它提交
      if (get().activeProjectId === id && get().selectedSha === sha) set({ commitDetail: detail, commitDetailLoading: false })
    } catch (err) {
      if (get().activeProjectId !== id) return
      if (get().selectedSha === sha) set({ commitDetailLoading: false })
      get().toast('err', `提交详情加载失败：${err}`)
    }
  },

  async ensureArchSpec(ref) {
    const id = get().activeProjectId
    if (!id) return { ok: false as const, error: 'no-project' }
    const cached = get().archSpecCache.get(ref)
    if (cached) return { ok: true as const, spec: cached }
    const r = await archSpec(id, ref, apiCallFor(id))
    if (get().activeProjectId !== id) return { ok: false as const, error: 'stale-project' }
    if (r.ok) {
      const next = new Map(get().archSpecCache)
      next.set(ref, r.spec)
      set({ archSpecCache: next })
    }
    return r
  },

  async ensureCommitImpact(c) {
    const id = get().activeProjectId
    if (!id) return
    if (get().commitImpactCache.has(c.sha)) return
    // 根提交：无 parent 可比，显示「初始提交」
    if (c.parents.length === 0) {
      setImpact(set, get, c.sha, { text: '初始提交' })
      return
    }
    // 并发去重：同一 sha 只算一次
    if (pendingImpacts.has(c.sha)) return
    pendingImpacts.add(c.sha)
    try {
      const parent = c.parents[0]
      const [baseR, headR] = await Promise.all([get().ensureArchSpec(parent), get().ensureArchSpec(c.sha)])
      if (get().activeProjectId !== id) return
      // 无源码/无提交等场景不显示徽章（text 空串）
      if (!baseR.ok || !headR.ok) {
        setImpact(set, get, c.sha, { text: '' })
        return
      }
      const b = window.timber
      if (!b) {
        setImpact(set, get, c.sha, { text: '' })
        return
      }
      const r = await b.archDelta(JSON.stringify(baseR.spec), JSON.stringify(headR.spec), `${id}:${parent}..${c.sha}`)
      if (get().activeProjectId !== id) return
      if (!r.ok || !r.receipt) {
        setImpact(set, get, c.sha, { text: '' })
        return
      }
      setImpact(set, get, c.sha, { text: formatImpactSummary(r.receipt) })
    } catch {
      if (get().activeProjectId === id) setImpact(set, get, c.sha, { text: '' })
    } finally {
      pendingImpacts.delete(c.sha)
    }
  },

  openFile(path) {
    set({ view: 'resources' })
    void get().openTab(path.replace(/\\/g, '/'), { pinned: false })
  },

  openArchDelta(base, head) {
    set({ archDeltaRequest: { base, head }, view: 'architecture' })
  },

  setSetting(key, value) {
    const next = { ...get().settings, [key]: value }
    saveSettings(next)
    set({ settings: next })
    applyAppearance(next)
  },

  openSettings() {
    set({ settingsOpen: true })
  },

  closeSettings() {
    set({ settingsOpen: false })
  },

  openAddProject() {
    set({ addProjectOpen: true })
  },

  closeAddProject() {
    set({ addProjectOpen: false })
  },

  async connectRemote(params, onLog) {
    try {
      const { remote } = await establishRemote(params, onLog)
      // 同一目标（发行版/主机/端口）重复连接时沿用旧配置 id 与本地项目清单，
      // 避免出现双份远程，也保证本地移除过的项目不会"复活"
      const dup = get().remotes.find((r) => r.id !== remote.id && sameRemoteTarget(r, remote))
      if (dup) {
        remote.id = dup.id
        // 沿用已存条目的本地项目清单；已存条目缺该字段（v0.3.11 前的老数据）时保持
        // undefined，由 syncRemoteProjects 首连一次性采纳远端注册表完成迁移
        remote.projectPaths = dup.projectPaths
      }
      const synced = await syncRemoteProjects(remote)
      const remotes = [...get().remotes.filter((r) => r.id !== synced.remote.id), synced.remote]
      saveRemotes(remotes)
      set({
        remotes,
        projects: mergeProjects(get().localProjects, remotes, [
          ...get().projects.filter((p) => p.remoteId && p.remoteId !== synced.remote.id),
          ...synced.projects
        ])
      })
      get().toast('ok', `已连接 ${synced.remote.name}（${synced.projects.length} 个项目）`)
      return synced.remote.id
    } catch (err) {
      get().toast('err', `连接失败：${err}`)
      throw err
    }
  },

  async reconnectRemote(remoteId, projectId) {
    const remote = get().remotes.find((r) => r.id === remoteId)
    if (!remote) return false
    // 分项目接入（v0.5.6）：连接还活着时，把占位项目加进可见清单即可，
    // 无需重建 SSH/WSL 通道；可见项目从快照清单重建（被过滤的项目不在当前列表里）
    if (remote.connected && remote.connId && projectId && remote.connectedProjectIds !== undefined) {
      const ids = [...new Set([...remote.connectedProjectIds, projectId])]
      const remotes = get().remotes.map((r) =>
        r.id === remoteId ? { ...r, connectedProjectIds: ids } : r
      )
      saveRemotes(remotes)
      const mine: Project[] = (remote.projects ?? [])
        .filter((sp) => ids.includes(sp.id))
        .map((sp) => ({ ...sp, id: `${remote.id}:${sp.id}`, remoteId: remote.id, addedAt: '' }))
      set({
        remotes,
        projects: mergeProjects(get().localProjects, remotes, [
          ...get().projects.filter((p) => p.remoteId && p.remoteId !== remoteId),
          ...mine
        ])
      })
      return true
    }
    try {
      const { remote: ok } = await reestablishRemote(remote)
      const synced = await syncRemoteProjects(ok)
      // 从某个项目占位发起重连时只接入该项目；从连接级占位重连则全部接入
      if (projectId) {
        synced.remote.connectedProjectIds =
          remote.connectedProjectIds === undefined
            ? [projectId]
            : [...new Set([...remote.connectedProjectIds, projectId])]
      } else {
        synced.remote.connectedProjectIds = undefined
      }
      const remotes = get().remotes.map((r) => (r.id === remoteId ? synced.remote : r))
      saveRemotes(remotes)
      set({
        remotes,
        projects: mergeProjects(get().localProjects, remotes, [
          ...get().projects.filter((p) => p.remoteId && p.remoteId !== remoteId),
          ...synced.projects
        ])
      })
      get().toast('ok', `${synced.remote.name} 已重新连接`)
      return true
    } catch (err) {
      const remotes = get().remotes.map((r) =>
        r.id === remoteId ? { ...r, connected: false, lastError: String(err) } : r
      )
      saveRemotes(remotes)
      set({ remotes, projects: mergeProjects(get().localProjects, remotes, get().projects) })
      get().toast('err', `重连失败：${err}`)
      return false
    }
  },

  disconnectRemote(remoteId) {
    const remote = get().remotes.find((r) => r.id === remoteId)
    if (!remote) return
    if (remote.connId) void teardownRemote(remote.connId)
    // 断开但保留条目：标为未连接占位，项目随 mergeProjects 过滤消失，可 ⟳ 重连
    const remotes = get().remotes.map((r) =>
      r.id === remoteId ? { ...r, connected: false, lastError: undefined, connId: undefined } : r
    )
    saveRemotes(remotes)
    const activeId = get().activeProjectId
    set({
      remotes,
      projects: mergeProjects(get().localProjects, remotes, get().projects),
      activeProjectId:
        activeId && activeId.startsWith(remoteId + ':') ? null : activeId,
      tree: activeId && activeId.startsWith(remoteId + ':') ? null : get().tree,
      tabs: activeId && activeId.startsWith(remoteId + ':') ? [] : get().tabs,
      activeTabId: activeId && activeId.startsWith(remoteId + ':') ? null : get().activeTabId,
      activeDoc: activeId && activeId.startsWith(remoteId + ':') ? null : get().activeDoc
    })
    get().toast('info', `已断开 ${remote.name}，需要时可点击 ⟳ 重新连接`)
  },

  removeRemote(remoteId) {
    const remote = get().remotes.find((r) => r.id === remoteId)
    if (remote?.connId) void teardownRemote(remote.connId)
    const remotes = get().remotes.filter((r) => r.id !== remoteId)
    saveRemotes(remotes)
    const activeId = get().activeProjectId
    set({
      remotes,
      projects: mergeProjects(get().localProjects, remotes, get().projects),
      activeProjectId:
        activeId && activeId.startsWith(remoteId + ':') ? null : activeId,
      tree: activeId && activeId.startsWith(remoteId + ':') ? null : get().tree,
      tabs: activeId && activeId.startsWith(remoteId + ':') ? [] : get().tabs,
      activeTabId: activeId && activeId.startsWith(remoteId + ':') ? null : get().activeTabId,
      activeDoc: activeId && activeId.startsWith(remoteId + ':') ? null : get().activeDoc
    })
    if (remote) get().toast('ok', `已从列表移除 ${remote.name}`)
  },

  openExtPage(url) {
    set({ extPageUrl: url })
  },

  closeExtPage() {
    set({ extPageUrl: null })
  },

  setPendingLocate(v) {
    set({ pendingLocate: v })
  },

  async init() {
    const settings = get().settings
    applyAppearance(settings)
    set({ annPanelOpen: true })
    startActiveDocWatcher()
    try {
      const r = await api<{ projects: Project[] }>('GET', '/api/projects')
      const localProjects = r.projects ?? []
      // 远程连接不自动重连：重启后保持未连接占位，由用户点击 ⟳ 手动重连（zcode 式）
      set({ localProjects, projects: mergeProjects(localProjects, get().remotes, []), ready: true })
    } catch (err) {
      set({ fatalError: String(err), ready: true })
      return
    }
    const first = get().projects[0]
    if (first) await get().selectProject(first.id)
  },

  toast(kind, text) {
    const id = toastSeq++
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }))
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    }, 3200)
  },

  async importProject(path) {
    try {
      const p = await api<Project>('POST', '/api/projects', { path })
      // POST 响应即完整项目信息，本地合并，省去整表重拉
      const localProjects = [...get().localProjects.filter((x) => x.id !== p.id), p]
      set({ localProjects, projects: mergeProjects(localProjects, get().remotes, get().projects) })
      get().toast('ok', `已导入 ${p.name}（${p.docCount} 篇文档）`)
      void get().selectProject(p.id)
    } catch (err) {
      get().toast('err', `导入失败：${err}`)
    }
  },

  async importRemoteProject(remoteId, path) {
    const remote = get().remotes.find((r) => r.id === remoteId)
    if (!remote) return
    try {
      const p = await apiWith<Project>(remoteBase(remote), remote.token, 'POST', '/api/projects', { path })
      // 本地合成远程项目条目，省去整表重拉
      const composed: Project = { ...p, id: `${remoteId}:${p.id}`, remoteId }
      // 记入本地项目清单与快照（本地为真相，重连时按清单恢复，断开后按原名占位）
      const remotes = get().remotes.map((r) =>
        r.id === remoteId
          ? {
              ...r,
              projectPaths: [...new Set([...(r.projectPaths ?? []), p.path])],
              projects: [
                ...(r.projects ?? []).filter((x) => x.id !== p.id),
                { id: p.id, name: p.name, path: p.path, docCount: p.docCount }
              ]
            }
          : r
      )
      saveRemotes(remotes)
      set({
        remotes,
        projects: mergeProjects(get().localProjects, remotes, [
          ...get().projects.filter((x) => x.remoteId && x.id !== composed.id),
          composed
        ])
      })
      get().toast('ok', `已导入 ${p.name}（${p.docCount} 篇文档）`)
      void get().selectProject(composed.id)
    } catch (err) {
      get().toast('err', `导入失败：${err}`)
      throw err
    }
  },

  async removeProject(id) {
    const p = get().projects.find((x) => x.id === id)
    // 在线远程项目取自项目列表；已断开连接的离线占位项目从连接快照中解析
    const snapRemote = p?.remoteId
      ? undefined
      : get().remotes.find((r) => (r.projects ?? []).some((sp) => `${r.id}:${sp.id}` === id))
    const remoteId = p?.remoteId ?? snapRemote?.id
    if (remoteId) {
      const path =
        p?.path ?? snapRemote?.projects?.find((sp) => `${snapRemote.id}:${sp.id}` === id)?.path
      // 本地清单为真相：从本地清单删除即不再呈现；在线时顺带尽力远端注销（远端 timberd 只是壳）
      if (get().remotes.find((r) => r.id === remoteId)?.connected) {
        try {
          await apiFor(id)('DELETE', `/api/projects/${id}`)
        } catch {
          /* 远端不可达不阻断本地移除 */
        }
      }
      const remotes = get().remotes.map((r) =>
        r.id === remoteId
          ? {
              ...r,
              projectPaths: (r.projectPaths ?? []).filter((x) => x !== path),
              projects: (r.projects ?? []).filter((sp) => `${r.id}:${sp.id}` !== id)
            }
          : r
      )
      saveRemotes(remotes)
      projectWorkspaces.delete(id)
      const activeId = get().activeProjectId
      set({ remotes, projects: get().projects.filter((x) => x.id !== id) })
      if (activeId === id) {
        set({ activeProjectId: null, tree: null, tabs: [], activeTabId: null, activeDoc: null, docError: null, annotations: [] })
        const first = get().projects[0]
        if (first) await get().selectProject(first.id)
      }
      get().toast('ok', '已从列表移除')
      return
    }
    try {
      await api('DELETE', `/api/projects/${id}`)
      projectWorkspaces.delete(id)
      // 本地过滤，省去整表重拉
      const localProjects = get().localProjects.filter((x) => x.id !== id)
      const { activeProjectId } = get()
      set({ localProjects, projects: mergeProjects(localProjects, get().remotes, get().projects) })
      if (activeProjectId === id) {
        set({ activeProjectId: null, tree: null, tabs: [], activeTabId: null, activeDoc: null, docError: null, annotations: [] })
        const first = get().projects[0]
        if (first) await get().selectProject(first.id)
      }
    } catch (err) {
      get().toast('err', `移除失败：${err}`)
    }
  },

  async selectProject(id) {
    const s = get()
    if (id === s.activeProjectId) return
    // 保存当前项目的工作区（打开的标签 + 活动标签状态）
    if (s.activeProjectId && s.tabs.length > 0) {
      const curScroll = document.querySelector('.reader-body')?.scrollTop ?? 0
      const tabs = s.tabs.map((t) =>
        t.id === s.activeTabId
          ? { ...t, mode: s.mode, draft: s.draft, dirty: s.dirty, scrollTop: curScroll }
          : t
      )
      projectWorkspaces.set(s.activeProjectId, { tabs, activeTabId: s.activeTabId })
    }
    set({
      activeProjectId: id,
      tree: null,
      treeLoading: true,
      tabs: [],
      activeTabId: null,
      activeDoc: null,
      annotations: [],
      composeQuote: null,
      selectedDir: null,
      // 历史/架构/代码域随项目切换清空（缓存按项目隔离，重进时重新加载）
      commits: [],
      commitsTotal: 0,
      commitsProjectId: null,
      selectedSha: null,
      commitDetail: null,
      archSpecCache: new Map(),
      archHtmlCache: new Map(),
      commitImpactCache: new Map(),
      codeTree: null,
      archDeltaRequest: null
    })
    void get().loadCodeTree()
    try {
      const tree = await apiFor<DocNode>(id)('GET', `/api/projects/${id}/tree?${extsQuery().slice(1)}`)
      if (get().activeProjectId !== id) return
      set({ tree, treeLoading: false })
    } catch (err) {
      if (get().activeProjectId !== id) return
      set({ treeLoading: false })
      get().toast('err', `文档树加载失败：${err}`)
    }
    // 还原该项目上次的工作区
    if (get().activeProjectId !== id) return
    const ws = projectWorkspaces.get(id)
    if (ws && ws.tabs.length > 0) {
      set({ tabs: ws.tabs, activeTabId: ws.activeTabId })
      const target = ws.tabs.find((t) => t.id === ws.activeTabId) ?? ws.tabs[0]
      if (target) await loadTabInto(target, set, get)
    }
  },

  async rescan() {
    const id = get().activeProjectId
    if (!id) return
    set({ treeLoading: true })
    try {
      await apiFor(id)('POST', `/api/projects/${id}/rescan`, { exts: extsList() })
      const tree = await apiFor<DocNode>(id)('GET', `/api/projects/${id}/tree?${extsQuery().slice(1)}`)
      set({ tree, treeLoading: false })
      get().toast('ok', '已重新扫描')
      void get().loadCodeTree()
    } catch (err) {
      set({ treeLoading: false })
      get().toast('err', `重新扫描失败：${err}`)
    }
  },

  async loadCodeTree() {
    const id = get().activeProjectId
    if (!id) return
    set({ codeTreeLoading: true })
    try {
      const codeTree = await apiFor<DocNode>(id)(
        'GET',
        `/api/projects/${id}/tree?exts=${encodeURIComponent(CODE_EXTS.join(','))}`
      )
      // 加载期间项目可能已切换，过期结果直接丢弃
      if (get().activeProjectId === id) set({ codeTree, codeTreeLoading: false })
    } catch {
      if (get().activeProjectId === id) set({ codeTree: null, codeTreeLoading: false })
    }
  },

  async openTab(path, opts) {
    // 文档链接/外部输入可能带 Windows 反斜杠，统一为正斜杠相对路径
    path = path.replace(/\\/g, '/')
    const s = get()
    const projectId = s.activeProjectId
    if (!projectId) return
    const pinned = opts?.pinned === true
    const mode = ['md', 'markdown', 'mdown', 'mkd', 'txt', 'html', 'htm'].includes((path.split('.').pop() ?? '').toLowerCase())
      ? s.settings.defaultMode : 'read'

    // 已开同路径标签：激活（双击则顺带固定）
    const existing = s.tabs.find((t) => t.path === path)
    if (existing) {
      if (pinned && !existing.pinned) {
        set({ tabs: s.tabs.map((t) => (t.id === existing.id ? { ...t, pinned: true } : t)) })
      }
      if (s.activeTabId !== existing.id) await get().activateTab(existing.id)
      return
    }

    if (pinned) {
      const tab: DocTab = { id: newTabId(), path, pinned: true, mode, draft: '', dirty: false, scrollTop: 0 }
      set({ tabs: [...s.tabs, tab] })
      await loadTabInto(tab, set, get)
      return
    }

    // 预览：复用现有预览标签（脏草稿需确认）
    const preview = s.tabs.find((t) => !t.pinned)
    if (preview) {
      if (preview.dirty && !await askConfirm('预览标签有未保存的修改，切换文档将丢弃。继续？')) return
      if (get().activeProjectId !== projectId || get().tabs !== s.tabs) return
      const tab: DocTab = { ...preview, path, mode, draft: '', dirty: false, scrollTop: 0, doc: undefined }
      set({ tabs: s.tabs.map((t) => (t.id === tab.id ? tab : t)) })
      await loadTabInto(tab, set, get)
      return
    }
    const tab: DocTab = { id: newTabId(), path, pinned: false, mode, draft: '', dirty: false, scrollTop: 0 }
    set({ tabs: [...s.tabs, tab] })
    await loadTabInto(tab, set, get)
  },

  async openDoc(path) {
    await get().openTab(path, { pinned: false })
  },

  async activateTab(id) {
    const s = get()
    const target = s.tabs.find((t) => t.id === id)
    if (!target || s.activeTabId === id) return
    // 快照当前标签状态（滚动位置直接读 DOM，避免组件卸载导致监听失效）
    const cur = s.tabs.find((t) => t.id === s.activeTabId)
    const curScroll = document.querySelector('.reader-body')?.scrollTop ?? 0
    if (cur) {
      set({
        tabs: s.tabs.map((t) =>
          t.id === cur.id
            ? { ...t, mode: s.mode, draft: s.draft, dirty: s.dirty, scrollTop: curScroll }
            : t
        )
      })
    }
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer)
      autoSaveTimer = null
    }
    set({ activeTabId: id, composeQuote: null })
    await loadTabInto(target, set, get)
  },

  async closeTab(id) {
    const s = get()
    const tab = s.tabs.find((t) => t.id === id)
    if (!tab) return
    if (tab.dirty && !await askConfirm('该标签有未保存的修改，关闭将丢弃。继续？')) return
    if (get().activeProjectId !== s.activeProjectId || get().tabs !== s.tabs) return
    const idx = s.tabs.findIndex((t) => t.id === id)
    const tabs = s.tabs.filter((t) => t.id !== id)
    if (s.activeTabId !== id) {
      set({ tabs })
      return
    }
    const next = tabs[Math.min(idx, tabs.length - 1)]
    set({ tabs, activeTabId: next?.id ?? null })
    if (next) {
      void loadTabInto(next, set, get)
    } else {
      // 全部标签关闭：清空阅读区状态
      set({ activeDoc: null, docError: null, draft: '', dirty: false, annotations: [], composeQuote: null })
    }
  },

  async closeOtherTabs(id) {
    const s = get()
    const target = s.tabs.find((t) => t.id === id)
    if (!target) return
    const closing = s.tabs.filter((t) => t.id !== id)
    if (closing.length === 0) return
    const dirtyCount = closing.filter((t) => t.dirty).length
    if (dirtyCount > 0 && !await askConfirm(`有 ${dirtyCount} 个标签包含未保存的修改，关闭将丢弃。继续？`)) return
    if (get().activeProjectId !== s.activeProjectId || get().tabs !== s.tabs) return
    if (s.activeTabId !== id) {
      // 激活标签被一并关闭：切到保留的 id 标签并加载（id 始终保留，不存在全关分支）
      set({ tabs: [target], activeTabId: id })
      void loadTabInto(target, set, get)
    } else {
      set({ tabs: [target] })
    }
  },

  async closeTabsToRight(id) {
    const s = get()
    const idx = s.tabs.findIndex((t) => t.id === id)
    if (idx < 0) return
    const closing = s.tabs.slice(idx + 1)
    if (closing.length === 0) return
    const dirtyCount = closing.filter((t) => t.dirty).length
    if (dirtyCount > 0 && !await askConfirm(`有 ${dirtyCount} 个标签包含未保存的修改，关闭将丢弃。继续？`)) return
    if (get().activeProjectId !== s.activeProjectId || get().tabs !== s.tabs) return
    const kept = s.tabs.slice(0, idx + 1)
    if (s.activeTabId && closing.some((t) => t.id === s.activeTabId)) {
      // 激活标签在右侧被关：回退激活 id 标签并加载
      set({ tabs: kept, activeTabId: id })
      void loadTabInto(kept[kept.length - 1], set, get)
    } else {
      set({ tabs: kept })
    }
  },

  pinTab(id) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, pinned: true } : t)) }))
  },

  reorderTabs(fromId, toId, position) {
    const tabs = [...get().tabs]
    const from = tabs.findIndex((t) => t.id === fromId)
    if (from < 0) return
    const [moved] = tabs.splice(from, 1)
    let to = toId ? tabs.findIndex((t) => t.id === toId) : tabs.length - 1
    if (to < 0) to = tabs.length - 1
    tabs.splice(position === 'after' ? to + 1 : to, 0, moved)
    set({ tabs })
  },

  patchActiveTab(patch) {
    const s = get()
    set({ tabs: s.tabs.map((t) => (t.id === s.activeTabId ? { ...t, ...patch } : t)) })
  },

  setFilter(f) {
    set({ filter: f })
  },

  setSelectedDir(p) {
    set({ selectedDir: p })
  },

  setMode(m) {
    const s = get()
    const cur = s.tabs.find((t) => t.id === s.activeTabId)
    if (cur) set({ tabs: s.tabs.map((t) => (t.id === cur.id ? { ...t, mode: m } : t)) })
    // 两个模式共用草稿，切换展示方式不能重置未保存的修改。
    set({ mode: m })
  },

  setDraft(d) {
    const s = get()
    const dirty = d !== s.activeDoc?.content
    const cur = s.tabs.find((t) => t.id === s.activeTabId)
    // tabs 与 draft 必须在同一次 set 中更新：分两次会让订阅方在中间态
    // 读到「旧 draft + 新 tabs」，编辑器订阅据此误判外部变更而整体重渲染，
    // 导致输入/退格后光标重置到文首（v0.4.3 修复）。
    set(
      cur
        ? { tabs: s.tabs.map((t) => (t.id === cur.id ? { ...t, draft: d, dirty } : t)), draft: d, dirty }
        : { draft: d, dirty }
    )
    // 自动保存：每次变更重置计时器，静止 delay 后落盘
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer)
      autoSaveTimer = null
    }
    const { settings } = get()
    if (settings.autoSave && get().dirty) {
      autoSaveTimer = setTimeout(() => {
        autoSaveTimer = null
        void get().saveDoc()
      }, settings.autoSaveDelayMs)
    }
  },

  async saveDoc() {
    const s = get()
    if (!s.activeDoc || !s.activeProjectId || !s.dirty) return
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer)
      autoSaveTimer = null
    }
    set({ saving: true })
    try {
      await apiFor(s.activeProjectId)('PUT', `/api/projects/${s.activeProjectId}/doc`, {
        path: s.activeDoc.path,
        content: s.draft
      })
      const cur = get().tabs.find((t) => t.id === get().activeTabId)
      if (cur) {
        set({ tabs: get().tabs.map((t) => (t.id === cur.id ? { ...t, draft: s.draft, dirty: false } : t)) })
        // 同步标签内容缓存（保存后即最新）
        cacheTabDoc(cur.id, { ...s.activeDoc, content: s.draft }, set, get)
      }
      set({
        activeDoc: { ...s.activeDoc, content: s.draft },
        dirty: false,
        saving: false
      })
      get().toast('ok', '已保存')
    } catch (err) {
      set({ saving: false })
      get().toast('err', `保存失败：${err}`)
    }
  },

  async refreshActiveDoc() {
    const s = get()
    const tabId = s.activeTabId
    if (!s.activeDoc || !s.activeProjectId || !tabId) return
    // 图片经 /raw 直读文件，无文本内容可刷新（与外部变更轮询一致跳过）
    if (IMAGE_EXT_SET.has(s.activeDoc.ext)) return
    if (s.dirty && !await askConfirm('当前有未保存的修改，刷新将丢弃。继续？')) return
    if (get().activeProjectId !== s.activeProjectId || get().activeTabId !== tabId || get().draft !== s.draft) return
    try {
      const doc = await apiFor<DocContent>(s.activeProjectId)(
        'GET',
        `/api/projects/${s.activeProjectId}/doc?path=${encodeURIComponent(s.activeDoc.path)}`
      )
      // 等待响应期间可能已切换标签/项目：仅仍是同一标签时落地
      if (get().activeTabId !== tabId) return
      cacheTabDoc(tabId, doc, set, get)
      set({ activeDoc: doc, draft: doc.content, dirty: false })
      get().toast('ok', '已刷新')
    } catch (err) {
      get().toast('err', `刷新失败：${err}`)
    }
  },

  async loadAnnotations() {
    const s = get()
    if (!s.activeProjectId || !s.activeDoc) return
    try {
      const r = await apiFor<{ annotations: Annotation[] }>(s.activeProjectId)(
        'GET',
        `/api/projects/${s.activeProjectId}/annotations?doc=${encodeURIComponent(s.activeDoc.path)}`
      )
      if (get().activeProjectId !== s.activeProjectId || get().activeDoc?.path !== s.activeDoc.path) return
      set({ annotations: r.annotations ?? [] })
    } catch {
      if (get().activeProjectId !== s.activeProjectId || get().activeDoc?.path !== s.activeDoc.path) return
      set({ annotations: [] })
    }
  },

  async fsOp(op, args, opts) {
    const s = get()
    const projectId = s.activeProjectId
    if (!projectId) return false
    try {
      await apiFor(projectId)('POST', `/api/projects/${projectId}/fs`, { op, ...args })
    } catch (err) {
      if (!opts?.silent) get().toast('err', `操作失败：${err}`)
      return false
    }

    // 移动：重映射打开标签与当前文档的路径（目录移动按前缀展开）
    if (op === 'move' && args.from && args.to) {
      const from = args.from
      const to = args.to
      const remap = (p: string): string =>
        p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : p
      const tabs = s.tabs.map((t) => ({
        ...t,
        path: remap(t.path),
        doc: t.doc ? { ...t.doc, path: remap(t.doc.path) } : t.doc
      }))
      const activeDocPath = s.activeDoc ? remap(s.activeDoc.path) : null
      set({ tabs, activeDoc: s.activeDoc ? { ...s.activeDoc, path: activeDocPath ?? s.activeDoc.path } : s.activeDoc })
      if (s.activeDoc && activeDocPath !== s.activeDoc.path) await get().loadAnnotations()
    }

    // 删除：关闭被删路径下的标签（含活动标签，关完落回首个标签）
    if (op === 'delete' && args.from) {
      const from = args.from
      const under = (p: string): boolean => p === from || p.startsWith(from + '/')
      const tabs = s.tabs.filter((t) => !under(t.path))
      if (tabs.length !== s.tabs.length) {
        const closedActive = !tabs.some((t) => t.id === s.activeTabId)
        set({ tabs })
        if (closedActive) {
          const next = tabs[0]
          if (next) await get().activateTab(next.id)
          else set({ activeTabId: null, activeDoc: null, docError: null, draft: '', dirty: false, annotations: [] })
        }
      } else if (s.activeDoc && under(s.activeDoc.path)) {
        await get().loadAnnotations()
      }
    }

    // 静默重扫（不走 rescan()，避免每次操作弹 toast）
    set({ treeLoading: true })
    try {
      await apiFor(projectId)('POST', `/api/projects/${projectId}/rescan`, { exts: extsList() })
      const tree = await apiFor<DocNode>(projectId)('GET', `/api/projects/${projectId}/tree?${extsQuery().slice(1)}`)
      set({ tree, treeLoading: false })
      void get().loadCodeTree()
    } catch {
      set({ treeLoading: false })
    }
    return true
  },

  toggleAnnPanel() {
    set((s) => ({
      annPanelOpen: !s.annPanelOpen,
      // 打开时按当前窗口宽度收敛面板宽，避免与侧栏合力挤没正文
      annPanelWidth: s.annPanelOpen ? s.annPanelWidth : clamp(s.annPanelWidth, ANN_MIN_W, annDynMax(s.sidebarCollapsed, s.sidebarWidth))
    }))
  },

  setComposeQuote(q) {
    set({ composeQuote: q })
  },

  async createAnnotation(text, kind) {
    const s = get()
    const q = s.composeQuote
    if (!s.activeProjectId || !s.activeDoc || !q) return
    try {
      await apiFor(s.activeProjectId)('POST', `/api/projects/${s.activeProjectId}/annotations`, {
        doc: s.activeDoc.path,
        quote: q.quote,
        prefix: q.prefix,
        suffix: q.suffix,
        text,
        kind,
        status: 'open'
      })
      set({ composeQuote: null })
      await get().loadAnnotations()
      get().toast('ok', kind === 'tag' ? '标签已保存' : kind === 'note' ? '笔记已保存' : '批注已保存')
    } catch (err) {
      get().toast('err', `保存失败：${err}`)
    }
  },

  async setAnnStatus(a, status) {
    const s = get()
    if (!s.activeProjectId) return
    await apiFor(s.activeProjectId)('PATCH', `/api/projects/${s.activeProjectId}/annotations`, {
      doc: a.doc,
      id: a.id,
      status
    })
    await get().loadAnnotations()
  },

  async editAnnotation(a, text) {
    const s = get()
    if (!s.activeProjectId) return
    try {
      await apiFor(s.activeProjectId)('PATCH', `/api/projects/${s.activeProjectId}/annotations`, {
        doc: a.doc,
        id: a.id,
        text
      })
      await get().loadAnnotations()
      get().toast('ok', '批注已更新')
    } catch (err) {
      get().toast('err', `批注更新失败：${err}`)
    }
  },

  async deleteAnnotation(a) {
    const s = get()
    if (!s.activeProjectId) return
    await apiFor(s.activeProjectId)(
      'DELETE',
      `/api/projects/${s.activeProjectId}/annotations?doc=${encodeURIComponent(a.doc)}&id=${encodeURIComponent(a.id)}`
    )
    await get().loadAnnotations()
  }
}))

/** 把 tab 对应文档加载为当前显示（内部）。
 *  有缓存：立即呈现（切换无白闪），随后后台拉取校验新鲜度；
 *  无缓存：首载走 loading，完成后写入标签缓存。 */
async function loadTabInto(
  tab: DocTab,
  set: (partial: Partial<State>) => void,
  get: () => State
): Promise<void> {
  const projectId = get().activeProjectId
  if (!projectId) return
  const ext = (tab.path.split('.').pop() ?? '').toLowerCase()
  const isImage = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'].includes(ext)
  const cached = isImage
    ? ({ path: tab.path, ext, content: '', size: 0, mtime: '' } as DocContent)
    : tab.doc

  set({
    activeTabId: tab.id,
    docLoading: !cached,
    activeDoc: cached ?? null,
    docError: null,
    composeQuote: null,
    mode: tab.mode,
    draft: tab.dirty ? tab.draft : (cached?.content ?? tab.draft),
    dirty: tab.dirty
  })

  if (cached) {
    // 图片：不拉内容也不校验
    if (isImage) {
      set({ annotations: [] })
      cacheTabDoc(tab.id, cached, set, get)
      return
    }
    await get().loadAnnotations()
    restoreScroll(tab, get)
  }

  try {
    const doc = await apiFor<DocContent>(projectId)(
      'GET',
      `/api/projects/${projectId}/doc?path=${encodeURIComponent(tab.path)}`
    )
    // UTF-8 BOM（\uFEFF）是编码标记而非内容：留着会让首行 `# 标题` 的 # 不在行首，
    // ATX 标题不解析、井号原样显示（v0.5.7 修复）。加载即剥离，下次保存后文件也不再带 BOM。
    doc.content = doc.content.replace(/^\uFEFF/, '')
    if (get().activeProjectId !== projectId) return
    cacheTabDoc(tab.id, doc, set, get)
    if (get().activeTabId !== tab.id) return
    const fresh = get().tabs.find((t) => t.id === tab.id)
    if (!fresh) return
    if (!cached) {
      // 首载完成：呈现并恢复滚动位置
      const useDraft = fresh.dirty ? fresh.draft : doc.content
      set({ activeDoc: doc, draft: useDraft, dirty: fresh.dirty, docLoading: false })
      await get().loadAnnotations()
      restoreScroll(fresh, get)
    } else if (!fresh.dirty && (doc.mtime !== cached.mtime || doc.size !== cached.size)) {
      // 外部修改过：静默更新内容（不打扰未保存草稿）
      set({ activeDoc: doc, draft: doc.content, dirty: false })
    }
  } catch (err) {
    if (get().activeProjectId !== projectId || get().activeTabId !== tab.id) return
    if (!cached) {
      // 打开失败：保留标签，错误在正文区呈现（含关闭按钮），不再只弹一条 toast
      set({ docLoading: false, docError: String(err instanceof Error ? err.message : err) })
    }
    // 有缓存时后台校验失败保持现状（如远程刚断开）
  }
}

/** 文档内容写入标签缓存 */
function cacheTabDoc(
  tabId: string,
  doc: DocContent,
  set: (partial: Partial<State>) => void,
  get: () => State
): void {
  set({ tabs: get().tabs.map((t) => (t.id === tabId ? { ...t, doc } : t)) })
}

/** 恢复标签记忆的滚动位置（渲染完成后执行） */
function restoreScroll(tab: DocTab, get: () => State): void {
  const remembered = get().tabs.find((t) => t.id === tab.id)?.scrollTop ?? 0
  if (remembered > 0) {
    setTimeout(() => {
      if (get().activeTabId !== tab.id) return
      const body = document.querySelector('.reader-body')
      if (body) body.scrollTop = remembered
    }, 80)
  }
}
