// 架构 AI 助手：基于当前画布迭代或问答，成功校验后覆盖当前 spec。
// 后端二选一（v0.6.3）：设置页配置的 OpenAI 兼容接口（优先），
// 或本机 agent CLI（kimi 优先、codex 兜底）产出 archify spec
// → 前端基本校验 → window.timber.archRender 走既有渲染链路 → 主画布 iframe。
import { useEffect, useRef, useState } from 'react'
import type { ArchSpec } from '@shared/types'
import { aiCliStatus, archAiGenerate, type AiArchResult } from '../api'
import { apiCallFor, useStore } from '../store'

/** sidecar 错误码 → 面板状态文案 */
function aiErrorText(r: AiArchResult): string {
  switch (r.error) {
    case 'no-cli':
      return 'AI 未配置：请在 设置 → AI 填写 OpenAI 兼容接口（地址 / 密钥 / 模型），或安装并登录 kimi / codex CLI'
    case 'api':
      return `AI 接口调用失败：${r.message ?? '请检查 设置 → AI 中的地址 / 密钥 / 模型'}`
    case 'timeout':
      return r.message ?? '生成超时（180 秒），可简化描述后重试'
    case 'parse':
      return r.message ?? `未能解析 AI 输出${r.output ? `：${r.output.slice(0, 120)}` : ''}`
    case 'exec':
      return r.message ?? 'AI CLI 执行失败'
    default:
      return r.message ?? r.error ?? '生成失败'
  }
}

/** spec 里是否有连线文字（触发布局重叠校验的常见来源） */
function hasConnLabels(spec: unknown): boolean {
  const conns = (spec as { connections?: unknown })?.connections
  return (
    Array.isArray(conns) &&
    conns.some((c) => typeof (c as { label?: unknown })?.label === 'string' && (c as { label: string }).label)
  )
}

/** 删除所有 connections 的 label 字段（不可变拷贝，供降级重试） */
function stripConnLabels(spec: unknown): unknown {
  const clone = JSON.parse(JSON.stringify(spec)) as { connections?: Record<string, unknown>[] }
  for (const c of clone.connections ?? []) delete c.label
  return clone
}

function cliName(cli?: string): string {
  return cli === 'codex' ? 'Codex' : 'Kimi'
}

/** 结果回执的后端标签：API 模式显示模型名，CLI 模式显示 agent 名 */
function backendLabel(r: AiArchResult): string {
  if (r.backend === 'api') return r.model ? `API · ${r.model}` : 'API'
  return cliName(r.cli)
}

export interface ArchAiContext {
  spec?: ArchSpec
  mode: string
  ref: string
  baseSpec?: ArchSpec
  baseRef?: string
  sourceError?: string
}

export default function ArchAiPanel(props: {
  projectId: string
  getContext: () => Promise<ArchAiContext>
  onRendered: (html: string, spec: ArchSpec, prompt: string) => void
}) {
  const [prompt, setPrompt] = useState('')
  const [action, setAction] = useState<'edit' | 'ask'>('edit')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [answer, setAnswer] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  useEffect(() => () => { abortRef.current?.abort() }, [])

  // AI 后端就绪状态：设置页 API 配置（三项齐全）或本机 agent CLI（挂载时探测一次）
  const ai = useStore((s) => s.settings.ai)
  const hasApi = !!(ai.baseUrl && ai.apiKey && ai.model)
  const [cliReady, setCliReady] = useState<'kimi' | 'codex' | null | undefined>(undefined)
  useEffect(() => {
    let dead = false
    setCliReady(undefined)
    aiCliStatus(props.projectId, apiCallFor(props.projectId))
      .then((r) => { if (!dead) setCliReady(r.cli === 'kimi' || r.cli === 'codex' ? r.cli : null) })
      .catch(() => { if (!dead) setCliReady(null) })
    return () => { dead = true }
  }, [props.projectId])

  const generate = async (): Promise<void> => {
    const p = prompt.trim()
    if (!p || busy) return
    const ac = new AbortController()
    abortRef.current = ac
    setBusy(true)
    setStatus(action === 'ask' ? '正在阅读当前架构并分析问题…' : '正在基于当前架构调整，通常需要 1～3 分钟…')
    try {
      const context = await props.getContext()
      if (ac.signal.aborted) return
      const r = await archAiGenerate(props.projectId, p, ac.signal, apiCallFor(props.projectId), {
        action,
        context,
        ai: hasApi ? ai : undefined
      })
      if (ac.signal.aborted) return
      if (!r.ok) { setStatus(aiErrorText(r)); return }
      if (action === 'ask') {
        if (!r.answer) { setStatus('AI 未返回解释，请重试'); return }
        setAnswer(r.answer)
        setStatus(`已回答 · ${backendLabel(r)}`)
        return
      }
      if (!r.spec) { setStatus('AI 未返回有效架构，当前画布已保留'); return }
      const b = window.timber
      if (!b) { setStatus('架构渲染需要 Electron 环境'); return }
      // 验证成功之后才覆盖当前架构；渲染中允许取消，失败保留上次成果。
      let spec = r.spec
      let rr = await b.archRender(JSON.stringify(spec), `current:${props.projectId}`)
      if (ac.signal.aborted) return
      if (!rr.ok && /validation failed/i.test(rr.error ?? '') && hasConnLabels(spec)) {
        spec = stripConnLabels(spec) as ArchSpec
        rr = await b.archRender(JSON.stringify(spec), `current:${props.projectId}`)
        if (ac.signal.aborted) return
      }
      if (!rr.ok || !rr.html) { setStatus(`架构未通过渲染校验：${rr.error ?? 'unknown'}。当前画布已保留`); return }
      props.onRendered(rr.html, spec, p)
      setStatus(`当前架构已更新 · ${backendLabel(r)}`)
    } catch (e) {
      if (!ac.signal.aborted) setStatus(e instanceof Error ? e.message : String(e))
    } finally {
      if (abortRef.current === ac) { abortRef.current = null; setBusy(false) }
    }
  }
  return (
    <aside className="av-ai-panel" aria-label="架构 AI 助手">
      <div className="av-ai-title">AI 助手</div>
      <p className="av-ai-intro">围绕左侧当前内容，调整架构、优化表达或解释依赖关系。</p>
      {/* 后端就绪提示：两项都不可用时给出可操作的指引（v0.6.3） */}
      {hasApi ? (
        <div className="av-ai-backend api" title="在 设置 → AI 中修改">接口：{ai.model}</div>
      ) : cliReady === 'kimi' || cliReady === 'codex' ? (
        <div className="av-ai-backend cli" title="本机检测到的 agent CLI；配置 设置 → AI 后优先走接口">{cliName(cliReady)} CLI</div>
      ) : cliReady === null ? (
        <div className="av-ai-backend none">
          AI 未配置 —— 在
          <button className="av-ai-link" onClick={() => useStore.getState().openSettings()}>设置 → AI</button>
          填写 API 信息，或安装 kimi / codex CLI
        </div>
      ) : null}
      <div className="seg av-ai-mode">
        <button disabled={busy} className={action === 'edit' ? 'active' : ''} onClick={() => setAction('edit')}>调整架构</button>
        <button disabled={busy} className={action === 'ask' ? 'active' : ''} onClick={() => setAction('ask')}>问答解释</button>
      </div>
      {answer && <div className="av-ai-answer" aria-label="AI 回答">{answer}</div>}
      <div className="av-ai-composer">
        <textarea className="av-ai-input" placeholder={action === 'ask' ? '例如：这些模块之间如何传递数据？' : '例如：突出数据流，将存储层分开展示'} value={prompt} rows={5} disabled={busy} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void generate() } }} />
        <div className="av-ai-actions">
          <span>Ctrl + Enter</span>
          {busy ? <button className="av-ai-btn" onClick={() => { abortRef.current?.abort(); setBusy(false); setStatus('已取消，当前架构已保留') }}>取消</button> : <button className="av-ai-btn primary" disabled={!prompt.trim()} onClick={() => void generate()}>{action === 'ask' ? '提问' : '更新架构'}</button>}
        </div>
      </div>
      {status && <div className="av-ai-status" role="status">{status}</div>}
      <p className="av-ai-footnote">成功更新后覆盖当前架构，重新打开项目仍可继续迭代。</p>
    </aside>
  )
}
