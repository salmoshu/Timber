// 主进程 / preload / 渲染进程共享类型

export interface ApiInfo {
  base: string
  token: string
}

export interface Project {
  id: string
  name: string
  path: string
  addedAt: string
  docCount: number
  /** 远程项目：所属远程连接 id（本地项目无此字段） */
  remoteId?: string
}

/** 远程连接配置（连接到远端机器上运行的 timberd 服务） */
export interface RemoteConfig {
  id: string
  name: string
  host: string
  port: number
  token: string
  connected: boolean
  lastError?: string
  /** 连接方式；旧数据缺省视为 custom */
  kind?: RemoteKind
  /** sidecar 持有的连接句柄 id（wsl/ssh 自动接入；断开时用于 teardown） */
  connId?: string
  /** kind=wsl：自动部署的发行版 */
  wsl?: { distro: string }
  /** kind=ssh：自动部署的 SSH 参数（凭据仅存本机 localStorage） */
  ssh?: SshConfig
  /** 本地记住的远程项目路径清单（本地为真相，远端 timberd 只是壳）；
   *  新建连接初始为 []（不采纳远端存量）；
   *  undefined = v0.3.11 前的老数据未迁移，首次重连时一次性采纳远端已注册项目 */
  projectPaths?: string[]
  /** 远程项目的本地快照（连接/同步时刷新）：断开后侧栏按原项目名占位显示，
   *  而不是只呈现一行连接名 */
  projects?: RemoteProjectInfo[]
  /** 分项目连接管理（v0.5.6）：已接入（可见）的项目快照 id 清单。
   *  undefined = 全部项目可见（首次连接/整连重连）；
   *  数组 = 仅这些项目可见，其余快照在侧栏显示为未连接占位，可逐个 ⟳ 接入 */
  connectedProjectIds?: string[]
}

/** 远程项目的本地快照条目（id 为远端 timberd 注册 id，路径 sha1 派生；
 *  呈现/操作时的合成项目 id = `${remoteId}:${id}`） */
export interface RemoteProjectInfo {
  id: string
  name: string
  path: string
  docCount: number
}

export type RemoteKind = 'wsl' | 'ssh' | 'docker' | 'custom'

export interface SshConfig {
  host: string
  port: number
  user: string
  auth: 'password' | 'key'
  password?: string
  keyPath?: string
}

export interface DocNode {
  name: string
  path: string
  type: 'dir' | 'doc'
  ext?: string
  size?: number
  children?: DocNode[]
}

export interface DocContent {
  path: string
  ext: string
  content: string
  size: number
  mtime: string
}

export type AnnotationStatus = 'open' | 'done'

/** 标注类型：标签（快速归类）/ 笔记（记录思考与备忘）/ 批注（要求修改，可交给 agent） */
export type AnnotationKind = 'tag' | 'note' | 'annotation'

export const ANNOTATION_KIND_LABELS: Record<AnnotationKind, string> = {
  tag: '标签',
  note: '笔记',
  annotation: '批注'
}

export interface Annotation {
  id: string
  doc: string
  quote: string
  prefix: string
  suffix: string
  text: string
  status: AnnotationStatus
  /** 缺省视为 annotation（v0.4.3 之前的历史数据） */
  kind?: AnnotationKind
  createdAt: string
  updatedAt: string
}

/** 可配置的文档格式组（设置页勾选，决定文件树/搜索/统计扫描哪些扩展名）。
 *  v0.4.5 起不再包含 json/yaml：这类文件不适合「阅读模式」渲染，改为经文档内
 *  链接以原始文本打开（见 MarkdownView 的 LINKABLE_EXTS）。 */
export interface DocFormatGroup {
  key: string
  label: string
  exts: string[]
}

export const DOC_FORMAT_GROUPS: DocFormatGroup[] = [
  { key: 'md', label: 'Markdown', exts: ['.md', '.markdown', '.mdown', '.mkd'] },
  { key: 'html', label: 'HTML', exts: ['.html', '.htm'] },
  { key: 'txt', label: '纯文本', exts: ['.txt'] },
  { key: 'xml', label: 'XML', exts: ['.xml'] },
  { key: 'csv', label: 'CSV', exts: ['.csv'] },
  { key: 'log', label: '日志', exts: ['.log'] }
]

// ---- Git 集成（sidecar /api/projects/:id/git/*） ----

export interface GitChange {
  /** 相对项目根（/ 分隔） */
  path: string
  /** 重命名前的路径 */
  orig?: string
  /** 暂存区状态码（M/A/D/R/U/?，空格为无变化） */
  index: string
  /** 工作区状态码 */
  work: string
}

export interface GitStatus {
  repo: boolean
  branch: string
  ahead: number
  behind: number
  changes: GitChange[]
  err?: string
}

// ---- 项目内全文搜索（sidecar /api/projects/:id/search） ----

export interface SearchMatch {
  line: number
  text: string
}

export interface SearchFileResult {
  path: string
  ext: string
  count: number
  matches: SearchMatch[]
}

export interface SearchResponse {
  query: string
  files: SearchFileResult[]
  truncated: boolean
}

// ---- Git 提交历史与架构分析（sidecar /api/projects/:id/git/log、/arch/*） ----

/** 提交条目（git log 列表项） */
export interface CommitInfo {
  sha: string
  short: string
  parents: string[]
  author: string
  email: string
  /** unix 秒 */
  time: number
  subject: string
  /** conventional 前缀或文件启发分类：feat/fix/docs/style/refactor/perf/test/build/ci/chore/revert/change */
  kind: string
  files: number
  insertions: number
  deletions: number
  /** Entire-Checkpoint trailer：存在即该提交有关联的 AI 会话 checkpoint */
  entireCheckpoint?: string
}

/** 提交中的文件变更 */
export interface CommitFile {
  path: string
  oldPath?: string
  /** A/M/D/R */
  status: string
  insertions: number
  deletions: number
}

/** 提交详情（git show） */
export interface CommitDetail {
  commit: CommitInfo
  body: string
  files: CommitFile[]
}

// ---- Entire AI 会话记录（sidecar /api/projects/:id/entire/*，只读 git 对象，不依赖 entire 二进制） ----

/** token 用量（checkpoint 级或会话级） */
export interface EntireTokenUsage {
  inputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  outputTokens: number
  apiCallCount: number
}

/** checkpoint 内的单个会话摘要 */
export interface EntireSessionInfo {
  index: number
  agent: string
  model: string
  sessionId: string
  /** RFC3339 */
  createdAt: string
  /** 首条用户 prompt 纯文本 */
  prompt: string
  filesTouched: string[]
  tokenUsage?: EntireTokenUsage
  turnCount: number
}

/** entire/checkpoint 成功响应 */
export interface EntireCheckpointDetail {
  ok: true
  checkpointId: string
  branch: string
  /** Entire CLI 版本（schema 线索，字段缺失宽容处理） */
  cliVersion: string
  filesTouched: string[]
  tokenUsage?: EntireTokenUsage
  sessions: EntireSessionInfo[]
}

/** not-synced = commit 有 trailer 但 checkpoint refs 未同步到本地 */
export type EntireCheckpointResult = EntireCheckpointDetail | { ok: false; error: string }

/** transcript.jsonl 的一行（宽容结构：type/content/ts 等字段缺省容忍） */
export interface EntireTranscriptLine {
  type?: string
  ts?: string
  agent?: string
  content?: { text?: string; type?: string; [k: string]: unknown }[]
  [k: string]: unknown
}

export type EntireTranscriptResult =
  | { ok: true; lines: EntireTranscriptLine[]; truncated: boolean }
  | { ok: false; error: string }

/** 会话耦合文件对 */
export interface EntireCouplingPair {
  a: string
  b: string
  count: number
}

export type EntireCouplingResult =
  | { ok: true; pairs: EntireCouplingPair[]; checkpointsUsed: number }
  | { ok: false; error: string }

/** entire/sync 响应；no-remote / fetch-failed 为可预期失败 */
export type EntireSyncResult =
  | { ok: true; synced: number }
  | { ok: false; error: string; detail?: string }

/** 会话搜索命中（按 checkpoint 聚合） */
export interface EntireSearchHit {
  checkpointId: string
  /** 命中的文件类别：prompt / transcript / metadata */
  files: string[]
  count: number
  /** 首条 prompt 首行摘要（≤120 字符） */
  prompt: string
}

export type EntireSearchResult =
  | { ok: true; results: EntireSearchHit[] }
  | { ok: false; error: string }

/** 架构快照可选 ref 清单 */
export interface ArchRefs {
  head: string
  branches: { name: string; sha: string }[]
  tags: { name: string; sha: string }[]
}

/** archify architecture v1 spec（字段宽松，渲染在 main 进程 archify 完成） */
export interface ArchSpec {
  schema_version: number
  diagram_type: string
  meta?: {
    title?: string
    quality_profile?: string
    repository?: { url?: string; revision?: string; provider?: string }
  }
  components?: {
    id: string
    type?: string
    label?: string
    sublabel?: string
    pos?: [number, number]
    size?: [number, number]
    sources?: { path: string }[]
  }[]
  boundaries?: { kind?: string; label?: string; wraps?: string[] }[]
  connections?: { id?: string; from: string; to: string; label?: string }[]
}

/** arch/spec 响应：成功为 spec 本体（顶层含 diagram_type），失败为 { ok:false, error } */
export type ArchResult = { ok: true; spec: ArchSpec } | { ok: false; error: string }

/** arch:delta 回执（summary 各项计数用于「架构影响」徽章） */
export interface ArchDeltaReceipt {
  summary?: {
    components?: { added?: number; removed?: number; changed?: number; moved?: number }
    connections?: { added?: number; removed?: number; changed?: number; rerouted?: number }
    [k: string]: unknown
  }
  [k: string]: unknown
}

// ---- 架构洞察（sidecar /api/projects/:id/arch/insights） ----

/** 洞察符号条目（组件内的主要函数/类型等） */
export interface ArchInsightSymbol {
  name: string
  kind: string
  file: string
}

/** 洞察组件条目：目录级组件 + 规模与热度明细 */
export interface ArchInsightComponent {
  id: string
  label: string
  dir: string
  type: string
  files: number
  lines: number
  lang: string
  /** 近 300 提交触及次数 */
  heat: number
  symbols?: ArchInsightSymbol[]
  topFiles?: { path: string; lines: number }[]
}

/** 洞察连接：kind=import 为源码依赖；kind=ipc 为主/渲染进程通道（channels 为通道名清单） */
export interface ArchInsightEdge {
  from: string
  to: string
  count: number
  kind: string
  channels?: string[]
}

/** arch/insights 成功响应本体 */
export interface ArchInsights {
  ok: true
  sha: string
  components: ArchInsightComponent[]
  edges: ArchInsightEdge[]
  /** 循环依赖环（组件 id 序列，首尾相同，如 ["a","b","a"]） */
  cycles: string[][]
  stats: {
    components: number
    edges: number
    cycles: number
    ipcChannels: number
    hotspots: number
  }
}

/** arch/insights 响应：成功为 ArchInsights，失败为 { ok:false, error }（no-commits/unknown-ref/no-source/not-a-repo） */
export type ArchInsightsResult = ArchInsights | { ok: false; error: string }

// preload 暴露给渲染进程的桥
export interface TimberBridge {
  getApiInfo(): Promise<ApiInfo>
  browseLocal(path?: string): Promise<{ path: string; parent: string; home: string; roots: string[]; folders: { name: string; path: string }[] }>
  pathExists(path: string): Promise<boolean>
  revealPath(p: string): Promise<void>
  /** 将 HTTP(S) / data URL 图片复制到系统剪贴板 */
  copyImage(src: string): Promise<void>
  winMinimize(): void
  winToggleMaximize(): void
  /** 查询窗口是否处于最大化（标题栏图标初始化） */
  winIsMaximized(): Promise<boolean>
  /** 最大化状态变化推送（标题栏图标跟随） */
  onWindowMaximized(cb: (maximized: boolean) => void): () => void
  winClose(): void
  platform: string
  appVersion(): Promise<string>
  updaterCheck(): Promise<void>
  updaterDownload(): Promise<void>
  updaterQuitAndInstall(): Promise<void>
  updaterSetPrefs(prefs: UpdaterPrefs): void
  onUpdateStatus(cb: (e: UpdateStatusEvent) => void): () => void
  /** 读取 release-notes.md 中当前版本小节；找不到返回 null */
  getCurrentReleaseNotes(): Promise<string | null>
  /** 应用内打开外部网页（浮层）。来自主窗口导航拦截 / window.open */
  onOpenExternalPage(cb: (url: string) => void): () => void
  /** 浮层页面主文档的 HTTP 状态（>=400 时用于展示美化错误页） */
  onExtPageStatus(cb: (e: { url: string; code: number }) => void): () => void
  /** 用系统浏览器打开（浮层右上角 ↗） */
  openInSystemBrowser(url: string): Promise<void>
  /** 导出 PDF：渲染器产出独立文档 HTML，主进程隐藏窗口 printToPDF，保存到自定义选择器选定的位置 */
  exportPdf(payload: { html: string; path: string; overwrite: boolean }): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
  /** 标签快捷键（主进程拦截 Ctrl+W / Ctrl+Tab 后转发） */
  onTabShortcut(cb: (kind: 'close' | 'next') => void): () => void
  /** sidecar 自动重启后新 base/token（更新渲染层缓存） */
  onApiInfoChanged(cb: (info: ApiInfo) => void): () => void
  /** archify 渲染架构快照 HTML（自包含字符串，主进程带缓存） */
  archRender(specJson: string, cacheKey: string): Promise<{ ok: boolean; html?: string; error?: string }>
  /** archify 架构对比：返回 delta HTML 与回执 */
  archDelta(
    baseJson: string,
    headJson: string,
    cacheKey: string
  ): Promise<{ ok: boolean; html?: string; receipt?: ArchDeltaReceipt; error?: string }>
}

// ---- 版本更新（对齐 Nav-Tools UpdateService 语义） ----

export type UpdateStatusType =
  | 'checking'
  | 'update-available'
  | 'update-not-available'
  | 'download-progress'
  | 'update-downloaded'
  | 'error'

export interface UpdateStatusEvent {
  type: UpdateStatusType
  version?: string
  releaseNotes?: string
  percent?: number
  message?: string
}

export interface UpdaterPrefs {
  autoCheck: boolean
  autoDownload: boolean
  ignoredVersion?: string
}
