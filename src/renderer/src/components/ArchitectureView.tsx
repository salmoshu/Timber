// 架构视图：快照 / 对比（delta）/ 矩阵（DSM）/ 洞察 四种模式。
// 快照与对比把 archify 自包含 HTML 经 iframe 呈现（需 Electron 主进程渲染）；
// 矩阵与洞察为 React 原生渲染，仅走 sidecar HTTP（dev:web 亦可用）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ArchRefs } from '@shared/types'
import { archRefs } from '../api'
import { apiCallFor, useStore } from '../store'
import { archTheme, setArchTheme } from '../utils/local-store'
import ArchMatrix from './ArchMatrix'
import ArchInsightsView from './ArchInsights'
import ArchAiPanel, { type ArchAiContext } from './ArchAiPanel'
import { readCurrentArchitecture, saveCurrentArchitecture } from '../utils/architecture'
import { filterKeyForProject } from '../utils/settings'

type Mode = 'snapshot' | 'delta' | 'matrix' | 'insights'

/** 架构图皮肤（archify HTML 的 data-theme）；矩阵/洞察为 React 渲染，随应用主题，不受此影响 */
type ArchTheme = 'light' | 'dark'

/** arch/spec/insights 错误码 → 空态文案（矩阵/洞察组件共用） */
const ARCH_ERROR_TEXTS: Record<string, string> = {
  'no-commits': '该仓库暂无提交，无法生成架构快照',
  'unknown-ref': '未找到该 ref 对应的提交',
  'no-source': '未找到可分析的源码文件（支持 ts/js/go/py/rs/java 等）',
  'not-a-repo': '当前项目不是 Git 仓库'
}

export function archErrorText(code: string): string {
  return ARCH_ERROR_TEXTS[code] ?? `架构分析失败：${code}`
}

/** 把 archify 写死的深色替换为目标主题（仅替换首个出现，即 <html> 标签上的 data-theme） */
export function applyArchTheme(html: string, theme: ArchTheme): string {
  if (theme === 'dark') return html
  return html.replace('data-theme="dark"', `data-theme="${theme}"`)
}

/** 向 archify 自包含 HTML 注入滚动条样式（0.5.2）：10px 细滚动条、圆角半透明 thumb、hover 加深一档。
 *  iframe 内不感知应用主题变量，按 archify 的 data-theme 属性写死深浅两套中性灰值 */
export function injectArchChrome(html: string): string {
  const style = [
    '<style id="timber-arch-chrome">',
    '::-webkit-scrollbar { width: 10px; height: 10px; }',
    '::-webkit-scrollbar-track { background: transparent; }',
    '::-webkit-scrollbar-thumb { border-radius: 5px; background: rgba(0, 0, 0, 0.24); }',
    '::-webkit-scrollbar-thumb:hover { background: rgba(0, 0, 0, 0.38); }',
    "html[data-theme='dark'] ::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.22); }",
    "html[data-theme='dark'] ::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.36); }",
    "html[data-theme='light'] { scrollbar-width: thin; scrollbar-color: rgba(0, 0, 0, 0.24) transparent; }",
    "html[data-theme='dark'] { scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.22) transparent; }",
    '</style>'
  ].join('\n')
  const i = html.indexOf('</head>')
  // archify 输出为标准 HTML（必含 </head>）；异常结构兜底追加到末尾
  return i < 0 ? html + style : `${html.slice(0, i)}${style}\n${html.slice(i)}`
}

function systemTheme(): ArchTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export default function ArchitectureView() {
  const activeProjectId = useStore((s) => s.activeProjectId)
  const ensureArchSpec = useStore((s) => s.ensureArchSpec)
  const archHtmlCache = useStore((s) => s.archHtmlCache)
  const archDeltaRequest = useStore((s) => s.archDeltaRequest)

  const [refs, setRefs] = useState<ArchRefs | null>(null)
  const [mode, setMode] = useState<Mode>('snapshot')
  const [snapRef, setSnapRef] = useState('HEAD')
  // 对比模式默认「选中提交 → HEAD」
  const [baseRef, setBaseRef] = useState(() => useStore.getState().selectedSha ?? 'HEAD~1')
  const [headRef, setHeadRef] = useState('HEAD')
  const [html, setHtml] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 矩阵/洞察的刷新代际：点击 ⟳ 自增，子组件据此重拉
  const [refreshSeq, setRefreshSeq] = useState(0)
  const project = useStore((s) => s.projects.find((p) => p.id === s.activeProjectId))
  const projectKey = project ? filterKeyForProject(project) : activeProjectId ?? ''
  const [current, setCurrent] = useState(() => readCurrentArchitecture(projectKey))
  const [aiHtml, setAiHtml] = useState<string | null>(null)
  const displayingCurrent = mode === 'snapshot' && snapRef === 'HEAD' && current !== null

  // 架构图主题：未设置过则跟随系统；用户一切换即持久化并解除跟随
  const [followSystem, setFollowSystem] = useState(() => archTheme() === null)
  const [theme, setTheme] = useState<ArchTheme>(() => archTheme() ?? systemTheme())

  useEffect(() => {
    if (!followSystem) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent): void => setTheme(e.matches ? 'dark' : 'light')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [followSystem])

  const toggleTheme = (): void => {
    const next: ArchTheme = theme === 'dark' ? 'light' : 'dark'
    setArchTheme(next)
    setFollowSystem(false)
    setTheme(next)
  }

  // iframe srcDoc 前统一套用主题并注入滚动条样式（缓存命中分支同走此路径，切换主题即时生效）
  const themedHtml = useMemo(() => (html ? injectArchChrome(applyArchTheme(html, theme)) : null), [html, theme])
  const aiThemedHtml = useMemo(
    () => (aiHtml ? injectArchChrome(applyArchTheme(aiHtml, theme)) : null),
    [aiHtml, theme]
  )

  useEffect(() => {
    if (!current || !window.timber) return
    let stale = false
    window.timber.archRender(JSON.stringify(current.spec), `current:${activeProjectId}`).then((result) => {
      if (stale) return
      if (result.ok && result.html) setAiHtml(result.html)
      else setError(`当前架构加载失败：${result.error ?? 'unknown'}`)
    }).catch((err) => { if (!stale) setError(String(err)) })
    return () => { stale = true }
  }, [current, activeProjectId])

  const getAiContext = async (): Promise<ArchAiContext> => {
    const ref = mode === 'delta' ? headRef : snapRef
    if (displayingCurrent && current) return { spec: current.spec, ref: 'HEAD', mode: 'current' }
    const result = await ensureArchSpec(ref)
    if (!result.ok) return { ref, mode, sourceError: archErrorText(result.error) }
    const context: ArchAiContext = { spec: result.spec, ref, mode }
    if (mode === 'delta') {
      const base = await ensureArchSpec(baseRef)
      if (!base.ok) throw new Error(archErrorText(base.error))
      context.baseSpec = base.spec
      context.baseRef = baseRef
    }
    return context
  }

  // 可选 ref 清单（HEAD + branches + tags）
  useEffect(() => {
    if (!activeProjectId) return
    archRefs(activeProjectId, apiCallFor(activeProjectId))
      .then(setRefs)
      .catch(() => setRefs(null))
  }, [activeProjectId])

  // 历史详情「查看架构对比」跳入：消费 delta 请求参数
  useEffect(() => {
    if (!archDeltaRequest) return
    setMode('delta')
    setBaseRef(archDeltaRequest.base)
    setHeadRef(archDeltaRequest.head)
    useStore.setState({ archDeltaRequest: null })
  }, [archDeltaRequest])

  // ref 下拉选项（对比模式的 head 默认跟随选中提交）
  const refOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [{ value: 'HEAD', label: 'HEAD' }]
    for (const b of refs?.branches ?? []) opts.push({ value: b.name, label: `分支 ${b.name}` })
    for (const t of refs?.tags ?? []) opts.push({ value: t.name, label: `标签 ${t.name}` })
    return opts
  }, [refs])

  // 加载代际：跳入 delta 等场景会先发起来旧参数的快照加载，后到者不得覆盖新结果
  const loadSeq = useRef(0)
  const load = useCallback(
    async (bustCache: boolean) => {
      const seq = ++loadSeq.current
      const stale = (): boolean => seq !== loadSeq.current
      const id = activeProjectId
      if (!id) return
      // 矩阵/洞察由各自子组件加载（React 渲染，无需 Electron）
      if (mode === 'matrix' || mode === 'insights' || displayingCurrent) return
      const b = window.timber
      if (!b) {
        setError('架构渲染需要 Electron 环境')
        return
      }
      setLoading(true)
      setError(null)
      const key = mode === 'snapshot' ? `${id}:${snapRef}` : `${id}:${baseRef}..${headRef}`
      try {
        const cached = bustCache ? undefined : useStore.getState().archHtmlCache.get(key)
        if (cached) {
          if (!stale()) setHtml(cached)
          return
        }
        let result: { ok: boolean; html?: string; error?: string }
        if (mode === 'snapshot') {
          const r = await ensureArchSpec(snapRef)
          if (stale()) return
          if (!r.ok) {
            setError(archErrorText(r.error))
            setHtml(null)
            return
          }
          result = await b.archRender(JSON.stringify(r.spec), key)
        } else {
          const [baseR, headR] = await Promise.all([ensureArchSpec(baseRef), ensureArchSpec(headRef)])
          if (stale()) return
          if (!baseR.ok) {
            setError(archErrorText(baseR.error))
            setHtml(null)
            return
          }
          if (!headR.ok) {
            setError(archErrorText(headR.error))
            setHtml(null)
            return
          }
          result = await b.archDelta(JSON.stringify(baseR.spec), JSON.stringify(headR.spec), key)
        }
        if (stale()) return
        if (!result.ok || !result.html) {
          setError(archErrorText(result.error ?? 'unknown'))
          setHtml(null)
          return
        }
        // 写入 store HTML 缓存（不可变更新；缓存的是原始 HTML，主题在 srcDoc 前套用）
        const next = new Map(useStore.getState().archHtmlCache)
        next.set(key, result.html)
        useStore.setState({ archHtmlCache: next })
        setHtml(result.html)
      } catch (err) {
        if (!stale()) {
          setError(String(err))
          setHtml(null)
        }
      } finally {
        if (!stale()) setLoading(false)
      }
    },
    [activeProjectId, mode, snapRef, baseRef, headRef, ensureArchSpec, displayingCurrent]
  )

  // 参数变化时自动加载（缓存命中即时呈现）
  useEffect(() => {
    void load(false)
    return () => { ++loadSeq.current }
  }, [load])

  // 刷新：快照/对比丢弃 HTML 缓存重渲；矩阵丢弃 spec 缓存；洞察通知子组件重拉
  const refresh = (): void => {
    const id = activeProjectId
    if (!id) return
    if (displayingCurrent && current) {
      setAiHtml(null)
      setCurrent({ ...current })
      return
    }
    if (mode === 'matrix') {
      const next = new Map(useStore.getState().archSpecCache)
      next.delete(snapRef)
      useStore.setState({ archSpecCache: next })
      setRefreshSeq((s) => s + 1)
      return
    }
    if (mode === 'insights') {
      setRefreshSeq((s) => s + 1)
      return
    }
    const key = mode === 'snapshot' ? `${id}:${snapRef}` : `${id}:${baseRef}..${headRef}`
    const next = new Map(archHtmlCache)
    next.delete(key)
    useStore.setState({ archHtmlCache: next })
    void load(true)
  }

  if (!activeProjectId) return <div className="hv-empty">请先在左侧选择项目</div>

  return (
    <div className="arch-view">
      <div className="av-toolbar">
        <div className="av-mode seg">
          <button className={mode === 'snapshot' ? 'active' : ''} onClick={() => { setMode('snapshot'); setSnapRef('HEAD') }}>
            当前架构
          </button>
          <button className={mode === 'delta' ? 'active' : ''} onClick={() => setMode('delta')}>
            对比
          </button>
          <button className={mode === 'matrix' ? 'active' : ''} onClick={() => setMode('matrix')}>
            矩阵
          </button>
          <button className={mode === 'insights' ? 'active' : ''} onClick={() => setMode('insights')}>
            洞察
          </button>
        </div>
        {mode === 'delta' ? (
          <>
            <label className="av-field">
              基准
              <select value={baseRef} onChange={(e) => setBaseRef(e.target.value)}>
                {refOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
                {/* sha 等非清单值（历史跳入/选中提交）补一个显示项 */}
                {!refOptions.some((o) => o.value === baseRef) && (
                  <option value={baseRef}>{baseRef.slice(0, 7)}</option>
                )}
              </select>
            </label>
            <span className="av-arrow">→</span>
            <label className="av-field">
              目标
              <select value={headRef} onChange={(e) => setHeadRef(e.target.value)}>
                {refOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
                {!refOptions.some((o) => o.value === headRef) && (
                  <option value={headRef}>{headRef.slice(0, 7)}</option>
                )}
              </select>
            </label>
          </>
        ) : (
          <label className="av-field">
            {mode === 'snapshot' ? '版本' : 'ref'}
            <select value={snapRef} onChange={(e) => setSnapRef(e.target.value)}>
              {refOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
        )}
        <button
          className="av-theme"
          onClick={toggleTheme}
          title="架构图主题：首次跟随系统，切换后独立记忆"
        >
          {theme === 'dark' ? '☀' : '🌙'}
        </button>
        {displayingCurrent && <span className="av-current-label" title={current?.prompt}>AI 已更新</span>}
        <button className="av-refresh" onClick={refresh} title="重新渲染">⟳</button>
      </div>
      <div className="av-ai-wrap">
      <div className="av-body av-ai-main">
        {mode === 'matrix' ? <ArchMatrix refName={snapRef} refreshSeq={refreshSeq} /> : mode === 'insights' ? <ArchInsightsView refName={snapRef} refreshSeq={refreshSeq} /> : displayingCurrent ? (
          aiThemedHtml ? <iframe className="av-frame" sandbox="allow-scripts" srcDoc={aiThemedHtml} title="当前架构图" /> : <div className="hv-loading">{error ?? '当前架构加载中…'}</div>
        ) : (
          <>
            {loading && <div className="hv-loading">架构图渲染中…</div>}
            {!loading && error && <div className="hv-empty">{error}</div>}
            {!loading && !error && themedHtml && <iframe className="av-frame" sandbox="allow-scripts" srcDoc={themedHtml} title="架构图" />}
          </>
        )}
      </div>
      <ArchAiPanel projectId={activeProjectId} getContext={getAiContext} onRendered={(html, spec, prompt) => {
        const next = { spec, prompt, updatedAt: new Date().toISOString() }
        saveCurrentArchitecture(projectKey, next)
        setCurrent(next)
        setAiHtml(html)
        setError(null)
        setMode('snapshot')
        setSnapRef('HEAD')
      }} />
      </div>
    </div>
  )
}
