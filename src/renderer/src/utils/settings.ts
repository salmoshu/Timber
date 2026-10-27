// 应用设置：localStorage 持久化（Web 预览模式同样可用），变更即生效
import { DOC_FORMAT_GROUPS } from '@shared/types'

/** AI 服务配置（OpenAI 兼容接口，v0.6.3）：架构 AI 助手经此生成/解释；
 *  三项齐全时优先走该接口，否则回退本机 kimi / codex CLI */
export interface AiSettings {
  baseUrl: string
  apiKey: string
  model: string
}

export interface AppSettings {
  /** 主题：浅色 / 深色 / 跟随系统 */
  theme: 'light' | 'dark' | 'system'
  /** 阅读区正文字号（px） */
  fontSize: number
  /** 正文使用衬线字体 */
  serifFont: boolean
  /** 打开文档的默认模式 */
  defaultMode: 'read' | 'source'
  /** 打开文档时默认展开批注面板（默认收起） */
  annPanelDefaultOpen: boolean
  /** 编辑器自动保存 */
  autoSave: boolean
  /** 文件树/搜索支持的文档格式组（key 见 DOC_FORMAT_GROUPS） */
  docFormats: string[]
  /** 自动保存延迟（ms） */
  autoSaveDelayMs: number
  /** 资源视图文件树按项目记忆：true=仅文档，无记录=全部源码文件（项目级化） */
  resourceFilterDocsByProject: Record<string, boolean>
  /** AI 服务（OpenAI 兼容接口） */
  ai: AiSettings
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  fontSize: 16,
  serifFont: true,
  defaultMode: 'read',
  annPanelDefaultOpen: false,
  autoSave: false,
  autoSaveDelayMs: 2000,
  docFormats: ['md', 'html', 'txt'],
  resourceFilterDocsByProject: {},
  ai: { baseUrl: '', apiKey: '', model: '' }
}

const SETTINGS_KEY = 'timber-settings'
const ANN_DEFAULT_COLLAPSED_KEY = 'timber-ann-default-collapsed-v1'

/** 清洗格式组勾选：剔除已下架的组（如 v0.4.5 移除的 json/yaml），清空则回默认 */
function normalizeFormats(raw: unknown): string[] {
  const valid = new Set(DOC_FORMAT_GROUPS.map((g) => g.key))
  const keys = Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string' && valid.has(k)) : []
  return keys.length > 0 ? keys : DEFAULT_SETTINGS.docFormats
}

/** 清洗项目级过滤表：只保留 boolean 值（旧版全局 resourceFilterDocs 字段自然丢弃） */
function normalizeFilterMap(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'boolean' && k) out[k] = v
  }
  return out
}

/** 项目级过滤 key：远程项目带连接前缀；用路径而非随机 id，删了重加不丢状态 */
export function filterKeyForProject(p: { path: string; remoteId?: string }): string {
  return p.remoteId ? `${p.remoteId}:${p.path}` : p.path
}

/** 该项目的文件树是否仅显示文档（无记录 = false = 全部文件） */
export function filterDocsForProject(
  s: AppSettings,
  p: { path: string; remoteId?: string }
): boolean {
  return s.resourceFilterDocsByProject[filterKeyForProject(p)] === true
}

/** 清洗 AI 配置：字段须为字符串（旧版本无该字段时回默认空配置） */
function normalizeAi(raw: unknown): AiSettings {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Partial<AiSettings>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  return { baseUrl: str(a.baseUrl).trim(), apiKey: str(a.apiKey).trim(), model: str(a.model).trim() }
}

export function loadSettings(): AppSettings {
  try {
    const migrateAnnDefault = localStorage.getItem(ANN_DEFAULT_COLLAPSED_KEY) !== '1'
    if (migrateAnnDefault) localStorage.setItem(ANN_DEFAULT_COLLAPSED_KEY, '1')
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Omit<AppSettings, 'defaultMode'>> & {
        defaultMode?: string
        theme?: string
      }
      return {
        ...DEFAULT_SETTINGS,
        ...saved,
        annPanelDefaultOpen: migrateAnnDefault ? false : saved.annPanelDefaultOpen === true,
        theme: saved.theme === 'dark' || saved.theme === 'system' ? saved.theme : 'light',
        defaultMode: saved.defaultMode === 'source' || saved.defaultMode === 'edit' ? 'source' : 'read',
        docFormats: normalizeFormats(saved.docFormats),
        resourceFilterDocsByProject: normalizeFilterMap(saved.resourceFilterDocsByProject),
        ai: normalizeAi(saved.ai)
      }
    }
  } catch {
    /* 损坏数据回退默认 */
  }
  return { ...DEFAULT_SETTINGS }
}

export function saveSettings(s: AppSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
}

/** 当前系统是否深色（跟随系统主题用） */
export function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** 解析设置中的主题为实际生效的浅/深 */
export function resolveTheme(theme: AppSettings['theme']): 'light' | 'dark' {
  return theme === 'dark' || (theme === 'system' && systemPrefersDark()) ? 'dark' : 'light'
}

// 跟随系统时监听系统主题切换，实时重应用外观
let systemThemeWatcher: (() => void) | null = null
let lastApplied: AppSettings | null = null

/** 把外观类设置应用到 DOM（主题、字号、宽度、字体经 CSS 变量生效） */
export function applyAppearance(s: AppSettings): void {
  lastApplied = s
  const root = document.documentElement
  root.dataset.theme = resolveTheme(s.theme)
  root.style.setProperty('--reader-font-size', `${s.fontSize}px`)
  root.style.setProperty('--reader-width', '100%')
  root.style.setProperty(
    '--reader-font-family',
    s.serifFont
      ? '"Source Han Serif SC", "Noto Serif CJK SC", Georgia, "Times New Roman", serif'
      : '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, -apple-system, sans-serif'
  )
  if (!systemThemeWatcher) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => {
      if (lastApplied?.theme === 'system') applyAppearance(lastApplied)
    }
    mq.addEventListener('change', onChange)
    systemThemeWatcher = () => mq.removeEventListener('change', onChange)
  }
}
