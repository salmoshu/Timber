// 客户端本地的个性化数据：项目别名 / 项目屏蔽 / 文档与文件夹屏蔽。
// 这些是“阅读偏好”而非项目数据，随应用（localStorage）持久化，不落 sidecar。
const ALIAS_PREFIX = 'timber-alias:'
const BLOCKED_DOCS_PREFIX = 'timber-blocked:'
const HIDDEN_PROJECTS_KEY = 'timber-hidden-projects'

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw) return JSON.parse(raw) as T
  } catch {
    /* 损坏数据忽略 */
  }
  return fallback
}

function writeJSON(key: string, v: unknown): void {
  localStorage.setItem(key, JSON.stringify(v))
}

// ---- 项目别名（更名，仅影响本机显示） ----

export function projectAlias(projectId: string): string | null {
  const v = readJSON<string | null>(ALIAS_PREFIX + projectId, null)
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

export function setProjectAlias(projectId: string, name: string | null): void {
  if (name === null) localStorage.removeItem(ALIAS_PREFIX + projectId)
  else writeJSON(ALIAS_PREFIX + projectId, name)
}

// ---- 项目屏蔽（从列表隐藏，可随时恢复） ----

export function hiddenProjectIds(): string[] {
  return readJSON<string[]>(HIDDEN_PROJECTS_KEY, [])
}

function saveHidden(ids: string[]): void {
  writeJSON(HIDDEN_PROJECTS_KEY, ids)
}

export function isProjectHidden(projectId: string): boolean {
  return hiddenProjectIds().includes(projectId)
}

export function hideProject(projectId: string): void {
  const ids = hiddenProjectIds()
  if (!ids.includes(projectId)) saveHidden([...ids, projectId])
}

export function unhideProject(projectId: string): void {
  saveHidden(hiddenProjectIds().filter((id) => id !== projectId))
}

// ---- 文档 / 文件夹屏蔽（相对项目根，/ 分隔；屏蔽父目录即屏蔽子树） ----

function blockedKey(projectId: string): string {
  return BLOCKED_DOCS_PREFIX + projectId
}

export function blockedPaths(projectId: string): string[] {
  return readJSON<string[]>(blockedKey(projectId), [])
}

function saveBlocked(projectId: string, paths: string[]): void {
  writeJSON(blockedKey(projectId), paths)
}

/** 自身或任一祖先被屏蔽即视为屏蔽（子路径被屏蔽不影响父文件夹本身） */
export function isBlocked(projectId: string, path: string): boolean {
  return blockedPaths(projectId).some((b) => b === path || path.startsWith(b + '/'))
}

/** 该路径是否被精确屏蔽（用于右键菜单显示“取消屏蔽”） */
export function isExactBlocked(projectId: string, path: string): boolean {
  return blockedPaths(projectId).includes(path)
}

export function blockPath(projectId: string, path: string): void {
  const paths = blockedPaths(projectId)
  if (!paths.includes(path)) saveBlocked(projectId, [...paths, path])
}

export function unblockPath(projectId: string, path: string): void {
  saveBlocked(
    projectId,
    blockedPaths(projectId).filter((p) => p !== path && !p.startsWith(path + '/'))
  )
}

// ---- 架构图主题（archify HTML 皮肤；null = 未设置 = 跟随系统） ----

const ARCH_THEME_KEY = 'timber-arch-theme'

export function archTheme(): 'light' | 'dark' | null {
  const v = readJSON<string | null>(ARCH_THEME_KEY, null)
  return v === 'light' || v === 'dark' ? v : null
}

export function setArchTheme(t: 'light' | 'dark'): void {
  writeJSON(ARCH_THEME_KEY, t)
}

// ---- 最近打开的文件（项目级，v0.6.8；供右侧栏「最近」面板） ----

const RECENT_PREFIX = 'timber-recent:'
const RECENT_MAX = 20

/** 最近打开记录（新→旧，最多 20 条） */
export function recentFiles(projectId: string): string[] {
  const v = readJSON<unknown[]>(RECENT_PREFIX + projectId, [])
  return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string' && p !== '').slice(0, RECENT_MAX) : []
}

/** 记录一次打开：去重后置顶，超限截断 */
export function pushRecentFile(projectId: string, path: string): void {
  if (!path) return
  const list = [path, ...recentFiles(projectId).filter((p) => p !== path)].slice(0, RECENT_MAX)
  writeJSON(RECENT_PREFIX + projectId, list)
}

/** 路径移动/重命名后同步最近记录（目录移动按前缀展开） */
export function remapRecentFiles(projectId: string, from: string, to: string): void {
  const remap = (p: string): string => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : p)
  const list = recentFiles(projectId).map(remap)
  writeJSON(RECENT_PREFIX + projectId, [...new Set(list)].slice(0, RECENT_MAX))
}

/** 删除文件/目录后清掉对应记录（含子路径） */
export function pruneRecentFiles(projectId: string, from: string): void {
  const under = (p: string): boolean => p === from || p.startsWith(from + '/')
  writeJSON(RECENT_PREFIX + projectId, recentFiles(projectId).filter((p) => !under(p)))
}

export function clearRecentFiles(projectId: string): void {
  localStorage.removeItem(RECENT_PREFIX + projectId)
}
