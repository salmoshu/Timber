// 架构洞察：概览 / 循环依赖 / 热点组件 / 最强耦合 / IPC 通道 / 组件明细。
// 仅走 sidecar HTTP（dev:web 可用）；缓存在组件内，refreshSeq 变化即重拉。
import { useEffect, useMemo, useState } from 'react'
import type { ArchInsights as ArchInsightsData, EntireCouplingPair } from '@shared/types'
import { archInsights, entireCoupling } from '../api'
import { apiCallFor, useStore } from '../store'
import { archErrorText } from './ArchitectureView'

interface Props {
  /** 快照 ref（洞察为单 ref 视图） */
  refName: string
  /** 刷新代际：变化即重拉 */
  refreshSeq: number
}

export default function ArchInsightsView({ refName, refreshSeq }: Props) {
  const activeProjectId = useStore((s) => s.activeProjectId)
  const [data, setData] = useState<ArchInsightsData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 会话耦合（Entire checkpoint 共现）；null = 无数据或加载失败，整节不渲染
  const [sessionPairs, setSessionPairs] = useState<EntireCouplingPair[] | null>(null)

  useEffect(() => {
    const id = activeProjectId
    if (!id) return
    let stale = false
    setLoading(true)
    setError(null)
    setSessionPairs(null)
    entireCoupling(id, 200, apiCallFor(id))
      .then((r) => {
        if (!stale && r.ok) setSessionPairs(r.pairs)
      })
      .catch(() => {})
    archInsights(id, refName, apiCallFor(id))
      .then((r) => {
        if (stale) return
        if (r.ok) setData(r)
        else {
          setError(archErrorText(r.error))
          setData(null)
        }
      })
      .catch((e) => {
        if (!stale) {
          setError(String(e))
          setData(null)
        }
      })
      .finally(() => {
        if (!stale) setLoading(false)
      })
    return () => {
      stale = true
    }
  }, [activeProjectId, refName, refreshSeq])

  // 组件 id → 展示名（环/边/通道清单里的 id 统一转 label）
  const labelOf = useMemo(() => {
    const m = new Map((data?.components ?? []).map((c) => [c.id, c.label]))
    return (cid: string): string => m.get(cid) ?? cid
  }, [data])

  // 会话耦合过滤：共现 ≥2 次，且两文件所属组件间没有静态 import 边（隐性依赖）
  const hiddenCoupling = useMemo(() => {
    if (!sessionPairs || !data) return []
    const dirs = data.components.map((c) => ({ id: c.id, dir: c.dir }))
    const compOf = (file: string): string | null => {
      let best: string | null = null
      let bestLen = -1
      for (const c of dirs) {
        const d = c.dir.replace(/\\/g, '/')
        if (d && (file === d || file.startsWith(d + '/')) && d.length > bestLen) {
          best = c.id
          bestLen = d.length
        }
      }
      return best
    }
    const importEdges = new Set(
      data.edges.filter((e) => e.kind !== 'ipc').map((e) => `${e.from}|${e.to}`)
    )
    return sessionPairs
      .filter((pr) => {
        if (pr.count < 2) return false
        const ca = compOf(pr.a)
        const cb = compOf(pr.b)
        // 同组件或无法归属：视为无静态 import 关系，保留
        if (!ca || !cb || ca === cb) return true
        return !importEdges.has(`${ca}|${cb}`) && !importEdges.has(`${cb}|${ca}`)
      })
      .slice(0, 20)
  }, [sessionPairs, data])

  if (loading) return <div className="hv-loading">架构洞察加载中…</div>
  if (error) return <div className="hv-empty">{error}</div>
  if (!data) return null

  const hotspots = [...data.components]
    .filter((c) => c.heat > 0)
    .sort((a, b) => b.heat - a.heat)
    .slice(0, 8)
  const maxHeat = hotspots[0]?.heat ?? 1
  const coupling = [...data.edges].sort((a, b) => b.count - a.count).slice(0, 8)
  const ipcEdges = data.edges.filter((e) => e.kind === 'ipc' && (e.channels?.length ?? 0) > 0)

  return (
    <div className="av-insights">
      {/* 概览：五个统计数字卡片 */}
      <section className="ai-section">
        <div className="ai-cards">
          <div className="ai-card">
            <div className="ai-num">{data.stats.components}</div>
            <div className="ai-cap">组件</div>
          </div>
          <div className="ai-card">
            <div className="ai-num">{data.stats.edges}</div>
            <div className="ai-cap">连接</div>
          </div>
          <div className="ai-card">
            <div className="ai-num">{data.stats.cycles}</div>
            <div className="ai-cap">环</div>
          </div>
          <div className="ai-card">
            <div className="ai-num">{data.stats.ipcChannels}</div>
            <div className="ai-cap">IPC 通道</div>
          </div>
          <div className="ai-card">
            <div className="ai-num">{data.stats.hotspots}</div>
            <div className="ai-cap">热点</div>
          </div>
        </div>
      </section>

      {/* 循环依赖 */}
      <section className="ai-section">
        <h3 className="ai-title">循环依赖</h3>
        {data.cycles.length === 0 ? (
          <div className="ai-ok">无循环依赖 ✓</div>
        ) : (
          data.cycles.map((cyc, i) => (
            <div key={i} className="ai-cycle">{cyc.map(labelOf).join(' → ')}</div>
          ))
        )}
      </section>

      {/* 热点组件：heat 降序 Top 8，条形图 */}
      <section className="ai-section">
        <h3 className="ai-title">热点组件</h3>
        {hotspots.length === 0 ? (
          <div className="ai-none">近 300 提交内无源码变更</div>
        ) : (
          hotspots.map((c) => (
            <div key={c.id} className="ai-hot">
              <span className="ai-hot-label" title={c.dir}>{c.label}</span>
              <span className="ai-hot-bar">
                <span style={{ width: `${(c.heat / maxHeat) * 100}%` }} />
              </span>
              <span className="ai-hot-n">近 300 提交触及 {c.heat} 次</span>
            </div>
          ))
        )}
      </section>

      {/* 最强耦合：count 降序 Top 8 */}
      <section className="ai-section">
        <h3 className="ai-title">最强耦合</h3>
        {coupling.length === 0 ? (
          <div className="ai-none">无组件间连接</div>
        ) : (
          coupling.map((e, i) => (
            <div key={i} className="ai-edge">
              <span className={`ai-kind${e.kind === 'ipc' ? ' ai-kind-ipc' : ''}`}>
                {e.kind === 'ipc' ? 'IPC' : 'import'}
              </span>
              <span className="ai-edge-text">
                {labelOf(e.from)} → {labelOf(e.to)} ×{e.count}
              </span>
            </div>
          ))
        )}
      </section>

      {/* 会话耦合（隐性依赖）：无 Entire 数据时整节不渲染 */}
      {hiddenCoupling.length > 0 && (
        <section className="ai-section">
          <h3 className="ai-title">会话耦合（隐性依赖）</h3>
          <div className="ai-note">同一 AI 会话中一起修改的文件对（来自 Entire 记录），已排除静态 import 关系</div>
          {hiddenCoupling.map((pr) => (
            <div key={`${pr.a}|${pr.b}`} className="ai-couple">
              <span className="ai-couple-files">{pr.a} ↔ {pr.b}</span>
              <span className="ai-couple-n">{pr.count} 次同改</span>
            </div>
          ))}
        </section>
      )}

      {/* IPC 通道清单：无 IPC 边则整区不显示 */}
      {ipcEdges.length > 0 && (
        <section className="ai-section">
          <h3 className="ai-title">IPC 通道</h3>
          {ipcEdges.flatMap((e) =>
            (e.channels ?? []).map((ch) => (
              <div key={`${e.from}:${e.to}:${ch}`} className="ai-ipc">
                <span className="ai-ipc-ch">{ch}</span>
                <span className="ai-ipc-route">
                  {labelOf(e.from)} → {labelOf(e.to)}
                </span>
              </div>
            ))
          )}
        </section>
      )}

      {/* 组件明细：可折叠列表 */}
      <section className="ai-section">
        <h3 className="ai-title">组件明细</h3>
        {data.components.map((c) => (
          <details key={c.id} className="ai-comp">
            <summary>
              <span className="ai-comp-label">{c.label}</span>
              <span className="ai-comp-dir">（{c.dir}）</span>
              <span className="ai-comp-meta">
                · {c.files} 文件 · {c.lines} 行 · {c.lang} · 热度 {c.heat}
              </span>
            </summary>
            <div className="ai-comp-body">
              {(c.topFiles?.length ?? 0) > 0 && (
                <div className="ai-sub">
                  <div className="ai-sub-title">主要文件</div>
                  {c.topFiles!.map((f) => (
                    <div key={f.path} className="ai-file">
                      <span className="ai-file-path">{f.path}</span>
                      <span className="ai-file-lines">{f.lines} 行</span>
                    </div>
                  ))}
                </div>
              )}
              {(c.symbols?.length ?? 0) > 0 && (
                <div className="ai-sub">
                  <div className="ai-sub-title">符号</div>
                  {c.symbols!.map((s, i) => (
                    <div key={i} className="ai-sym">
                      <span className="ai-sym-name">{s.name}</span>
                      <span className="ai-sym-kind">{s.kind}</span>
                      <span className="ai-sym-file">{s.file}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </details>
        ))}
      </section>
    </div>
  )
}
