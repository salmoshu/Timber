// 应用设置：localStorage 持久化（Web 预览模式同样可用），变更即生效
import { DOC_FORMAT_GROUPS } from '@shared/types'

export interface AppSettings {
  /** 主题：浅色 / 深色 / 跟随系统 */
  theme: 'light' | 'dark' | 'system'
  /** 阅读区正文字号（px） */
  fontSize: number
  /** 阅读区内容宽度（百分比 70–100，100 为全宽；阅读与编辑模式共用） */
  contentWidth: number
  /** 正文使用衬线字体 */
  serifFont: boolean
  /** 打开文档的默认模式 */
  defaultMode: 'read' | 'source'
  /** 打开文档时默认展开批注面板 */
  annPanelDefaultOpen: boolean
  /** 编辑器自动保存 */
  autoSave: boolean
  /** 文件树/搜索支持的文档格式组（key 见 DOC_FORMAT_GROUPS） */
  docFormats: string[]
  /** 自动保存延迟（ms） */
  autoSaveDelayMs: number
  /** 资源视图文件树只显示文档（关闭则显示全部源码文件） */
  resourceFilterDocs: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  fontSize: 16,
  contentWidth: 90,
  serifFont: true,
  defaultMode: 'read',
  annPanelDefaultOpen: true,
  autoSave: false,
  autoSaveDelayMs: 2000,
  docFormats: ['md', 'html', 'txt'],
  resourceFilterDocs: true
}

const SETTINGS_KEY = 'timber-settings'

/** v0.2.0 及之前 contentWidth 为像素值（760/820/960/9999），迁移到百分比档位 */
function normalizeWidth(w: unknown): number {
  if (w === 70 || w === 80 || w === 90 || w === 100) return w
  if (w === 9999) return 100
  if (w === 760) return 70
  if (w === 820) return 80
  if (w === 960) return 90
  return DEFAULT_SETTINGS.contentWidth
}

/** 清洗格式组勾选：剔除已下架的组（如 v0.4.5 移除的 json/yaml），清空则回默认 */
function normalizeFormats(raw: unknown): string[] {
  const valid = new Set(DOC_FORMAT_GROUPS.map((g) => g.key))
  const keys = Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string' && valid.has(k)) : []
  return keys.length > 0 ? keys : DEFAULT_SETTINGS.docFormats
}

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Omit<AppSettings, 'defaultMode'>> & {
        defaultMode?: string
        theme?: string
      }
      return {
        ...DEFAULT_SETTINGS,
        ...saved,
        theme: saved.theme === 'dark' || saved.theme === 'system' ? saved.theme : 'light',
        contentWidth: normalizeWidth(saved.contentWidth),
        defaultMode: saved.defaultMode === 'source' || saved.defaultMode === 'edit' ? 'source' : 'read',
        docFormats: normalizeFormats(saved.docFormats)
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
  root.style.setProperty(
    '--reader-width',
    s.contentWidth >= 100 ? 'none' : `${s.contentWidth}%`
  )
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
