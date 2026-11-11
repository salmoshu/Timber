// 应用设置：localStorage 持久化（Web 预览模式同样可用），变更即生效
import { DOC_FORMAT_GROUPS } from '@shared/types'
import { normalizeEditorWidth, normalizeFontStack, resolveFontStack } from '@shared/fontFamilies'
import { THEME_PALETTES, type ThemeId } from './themePalettes'
export { THEME_PALETTES, type ThemeId } from './themePalettes'

/** AI 服务配置（OpenAI 兼容接口，v0.6.3）：架构 AI 助手经此生成/解释；
 *  三项齐全时优先走该接口，否则回退本机 kimi / codex CLI */
export interface AiSettings {
  baseUrl: string
  apiKey: string
  model: string
  architecturePrompt: string
}

export const DEFAULT_ARCHITECTURE_PROMPT = `完全基于当前项目的源码、配置和 Git 事实重新生成架构图，不要参考现有 AI 画布的命名、分组、布局或推测。

- 先识别系统入口、核心业务模块、数据模型、外部服务和主要调用链，优先保留主流程。
- 每个组件和连接都必须有源码或配置证据；没有证据的关系省略，不要编造服务、模块或依赖。
- 以调用方 → 入口 → 核心业务 → 数据/外部依赖组织结构，控制为 4～12 个组件，文字简短，避免交叉与遮挡。
- 这是全量再生成，不是局部调整。输出完整 archify spec，不输出解释文字。`

export interface AppSettings {
  theme: ThemeId | 'system'
  /** Markdown 编辑器正文字号（px） */
  fontSize: number
  /** Markdown 编辑器正文的字体系列，可填写任意系统字体或 CSS 字体栈 */
  editorFontFamily: string
  /** Maximum editor column width: empty (fluid), px, ch, or %. */
  editorLineWidth: string
  /** Markdown 编辑器正文行高倍数 */
  lineHeight: number
  /** 代码块与源码编辑器字号（px） */
  codeFontSize: number
  /** 代码块与源码编辑器字体系列，可填写任意系统字体或 CSS 字体栈 */
  codeFontFamily: string
  /** 是否自动换行代码块 */
  wrapCodeBlocks: boolean
  codeBlockLineNumbers: boolean
  sourceCodeLineNumbers: boolean
  tabSize: number
  hideQuickInsertHint: boolean
  /** 打开文档的默认模式 */
  defaultMode: 'read' | 'source'
  /** 打开文档时默认展开批注面板（默认收起） */
  annPanelDefaultOpen: boolean
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
  editorFontFamily: 'Open Sans',
  editorLineWidth: '',
  lineHeight: 1.6,
  codeFontSize: 14,
  codeFontFamily: 'DejaVu Sans Mono',
  wrapCodeBlocks: true,
  codeBlockLineNumbers: true,
  sourceCodeLineNumbers: true,
  tabSize: 2,
  hideQuickInsertHint: false,
  defaultMode: 'read',
  annPanelDefaultOpen: false,
  autoSaveDelayMs: 2000,
  docFormats: ['md', 'html', 'txt'],
  resourceFilterDocsByProject: {},
  ai: { baseUrl: '', apiKey: '', model: '', architecturePrompt: DEFAULT_ARCHITECTURE_PROMPT }
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
  return {
    baseUrl: str(a.baseUrl).trim(),
    apiKey: str(a.apiKey).trim(),
    model: str(a.model).trim(),
    architecturePrompt: str(a.architecturePrompt).trim() || DEFAULT_ARCHITECTURE_PROMPT
  }
}

export function loadSettings(): AppSettings {
  try {
    const migrateAnnDefault = localStorage.getItem(ANN_DEFAULT_COLLAPSED_KEY) !== '1'
    if (migrateAnnDefault) localStorage.setItem(ANN_DEFAULT_COLLAPSED_KEY, '1')
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Omit<AppSettings, 'defaultMode' | 'theme'>> & {
        defaultMode?: string
        theme?: string
        /** 旧版本的字体开关 */
        serifFont?: boolean
      }
      const legacyEditorFont = saved.serifFont === true
        ? 'Source Han Serif SC, Noto Serif CJK SC, Georgia, Times New Roman'
        : saved.serifFont === false
          ? 'PingFang SC, Microsoft YaHei, Noto Sans CJK SC'
          : DEFAULT_SETTINGS.editorFontFamily
      const numberInRange = (value: unknown, fallback: number, min: number, max: number): number => {
        const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
        return Math.max(min, Math.min(max, n))
      }
      const fontValue = (value: unknown, fallback: string): string => {
        if (typeof value !== 'string') return fallback
        return normalizeFontStack(value)
      }
      return {
        ...DEFAULT_SETTINGS,
        ...saved,
        fontSize: numberInRange(saved.fontSize, DEFAULT_SETTINGS.fontSize, 12, 32),
        editorFontFamily: fontValue(saved.editorFontFamily, legacyEditorFont),
        editorLineWidth: normalizeEditorWidth(saved.editorLineWidth),
        lineHeight: numberInRange(saved.lineHeight, DEFAULT_SETTINGS.lineHeight, 1.2, 2),
        codeFontSize: numberInRange(saved.codeFontSize, DEFAULT_SETTINGS.codeFontSize, 12, 28),
        codeFontFamily: fontValue(saved.codeFontFamily, DEFAULT_SETTINGS.codeFontFamily),
        wrapCodeBlocks: saved.wrapCodeBlocks !== false,
        codeBlockLineNumbers: saved.codeBlockLineNumbers !== false,
        sourceCodeLineNumbers: saved.sourceCodeLineNumbers !== false,
        tabSize: typeof saved.tabSize === 'number' && [2, 4, 8].includes(saved.tabSize) ? saved.tabSize : DEFAULT_SETTINGS.tabSize,
        hideQuickInsertHint: saved.hideQuickInsertHint === true,
        annPanelDefaultOpen: migrateAnnDefault ? false : saved.annPanelDefaultOpen === true,
        theme: saved.theme === 'system' || isThemeId(saved.theme) ? saved.theme : 'light',
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

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && Object.hasOwn(THEME_PALETTES, value)
}

export function resolveTheme(theme: AppSettings['theme']): ThemeId {
  return theme === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : theme
}

export function isDarkTheme(theme: ThemeId): boolean {
  return THEME_PALETTES[theme].dark
}

export function themeProperties(theme: ThemeId): Record<string, string> {
  const palette = THEME_PALETTES[theme]
  const mix = (color: string, percent: number): string => `color-mix(in srgb, ${color} ${percent}%, transparent)`
  const properties: Record<string, string> = {
    '--Colors-KMBlue': palette.accent,
    '--Colors-KMBlue-hover': palette.accent,
    '--Colors-KMBlue-active': palette.accent,
    '--Others-KMBlue10': mix(palette.accent, 12),
    '--Others-KMBlueDisabled': mix(palette.accent, 40),
    '--Others-TextSelected': mix(palette.accent, 26),
    '--Others-LightBlueBg': mix(palette.accent, 12),
    '--Bg-Primary': palette.background,
    '--Bg-Primary90': mix(palette.background, 90),
    '--Bg-Primary70': mix(palette.background, 85),
    '--Bg-Secondary': palette.sidebar,
    '--Bg-Tertiary': palette.panel,
    '--Bg-Quaternary': palette.sidebar,
    '--Bg-GroundPC': palette.sidebar,
    '--Labels-Primary': palette.text,
    '--Labels-Secondary': mix(palette.text, 75),
    '--Labels-Tertiary': mix(palette.text, 58),
    '--Labels-Quaternary': mix(palette.text, 40),
    '--Separators-S1': mix(palette.text, 16),
    '--Separators-S1-hover': mix(palette.text, 22),
    '--Separators-S1-active': mix(palette.text, 28),
    '--Syntax-Keyword': palette.keyword,
    '--Syntax-String': palette.string,
    '--Syntax-Literal': palette.number,
    '--Syntax-Comment': palette.comment,
    '--Syntax-Metadata': palette.mark,
    '--Syntax-Punctuation': palette.punctuation,
    '--Syntax-Mark': palette.mark,
    '--code-background': palette.code,
    '--icon-color': palette.text,
    '--editor-color': palette.text,
    '--editor-color-80': mix(palette.text, 80),
    '--editor-color-50': mix(palette.text, 60),
    '--editor-color-30': mix(palette.text, 40),
    '--editor-color-10': mix(palette.text, 15),
    '--editor-color-04': mix(palette.text, 4),
    '--editor-bg-color': palette.background,
    '--code-block-bg-color': palette.code,
    '--float-bg-color': palette.panel
  }
  for (const [index, percent] of [5, 9, 18, 28].entries()) {
    for (const [suffix, extra] of [['', 0], ['-hover', 4], ['-active', 8]] as const)
      properties[`--Fills-F${index + 1}${suffix}`] = mix(palette.text, percent + extra)
  }
  return properties
}

// 跟随系统时监听系统主题切换，实时重应用外观
let systemThemeWatcher: (() => void) | null = null
let lastApplied: AppSettings | null = null

/** 把外观类设置应用到 DOM（主题、字号、宽度、字体经 CSS 变量生效） */
export function applyAppearance(s: AppSettings): void {
  lastApplied = s
  const root = document.documentElement
  const theme = resolveTheme(s.theme)
  root.dataset.theme = isDarkTheme(theme) ? 'dark' : 'light'
  root.dataset.palette = theme
  root.style.colorScheme = isDarkTheme(theme) ? 'dark' : 'light'
  for (const [property, value] of Object.entries(themeProperties(theme))) root.style.setProperty(property, value)
  root.style.setProperty('--reader-font-size', `${s.fontSize}px`)
  root.style.setProperty('--reader-line-height', `${s.lineHeight}`)
  root.style.setProperty('--editor-tab-size', `${s.tabSize}`)
  const width = normalizeEditorWidth(s.editorLineWidth)
  root.style.setProperty('--reader-width', width ? `min(100%, ${width})` : '100%')
  root.style.setProperty('--reader-font-family', resolveFontStack(s.editorFontFamily))
  root.style.setProperty('--code-font-family', resolveFontStack(s.codeFontFamily, true))
  root.style.setProperty('--md-code-font-size', `${s.codeFontSize}px`)
  root.style.setProperty('--md-code-line-height', `${s.lineHeight}`)
  if (!systemThemeWatcher) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => {
      if (lastApplied?.theme === 'system') applyAppearance(lastApplied)
    }
    mq.addEventListener('change', onChange)
    systemThemeWatcher = () => mq.removeEventListener('change', onChange)
  }
}
