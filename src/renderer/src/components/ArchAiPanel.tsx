import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ArchSpec } from '@shared/types'
import { archAiGenerate, type AiArchProgress, type AiArchResult } from '../api'
import { apiCallFor, useStore } from '../store'
import { DEFAULT_ARCHITECTURE_PROMPT } from '../utils/settings'
import { AGENT_LABELS, CLI_AGENTS, agentEffortChoices, archRuntimeOptionsForAgent, effectiveArchAgent, type ArchAgentKind, type ArchAgentOptions, type ArchChatMode } from '../utils/archAgentOptions'
import { createArchSession, finishArchTurn, readArchConversation, recentArchExchanges, saveArchConversation, type AiFailure, type ArchActivity, type ArchChatSession, type ArchChatTurn, type ArchConversation } from '../utils/archConversation'
import { askConfirm, askInput } from '../utils/dialogs'
import { connectionLabel, useAgentConnections } from '../utils/useAgentConnections'
import AgentOptionFields from './AgentOptionFields'
import { IconAnnotation, IconChevronDown, IconCopy, IconPlus, IconSettings } from './icons'
import './ArchAiPanel.css'

function apiFailure(r: AiArchResult): AiFailure {
  const detail = r.message ?? '接口未返回具体错误信息'
  const status = Number(/HTTP\s+(\d{3})/i.exec(detail)?.[1] ?? 0)
  let title = 'AI 接口调用失败'
  let hint = '检查 API 地址、密钥和模型名，在设置中测试连接后再重试。'
  if (status === 401 || status === 403) {
    title = 'API 密钥或访问权限验证失败'
    hint = '检查 API Key 是否有效、是否已过期，以及账户是否具备模型访问权限；修改后请先测试连接。'
  } else if (status === 404) {
    title = 'API 地址或模型不可用'
    hint = '确认 Base URL 是否正确（通常以 /v1 结尾），并核对服务商提供的模型名；不要重复拼接 /chat/completions。'
  } else if (status === 400) {
    title = 'AI 服务拒绝了请求'
    hint = '优先核对模型名和 Base URL 是否属于同一服务商，再根据下方接口返回的具体原因修正。'
  } else if (status === 429) {
    title = '请求受限或账户额度不足'
    hint = '稍后重试；如果接口返回配额或余额不足，请处理账户额度或更换可用密钥。'
  } else if (status >= 500) {
    title = 'AI 服务暂时不可用'
    hint = '稍后重试；持续失败时请检查服务商状态，或更换可用的 API 服务。'
  } else if (/dial tcp|connection refused|no such host|timeout|tls|certificate|network/i.test(detail)) {
    title = '无法连接 AI 服务'
    hint = '检查网络、代理和 Base URL；若服务部署在本机，请确认服务已经启动并监听相应端口。'
  }
  return { title, detail, hint, output: r.output, showSettings: true }
}

/** sidecar 错误码 → 可操作的错误卡片；CLI 的 stderr/stdout 不再被丢弃。 */
function aiFailure(r: AiArchResult): AiFailure {
  switch (r.error) {
    case 'no-cli':
      return {
        title: 'AI 尚未配置',
        detail: r.message ?? '未检测到可用的 Agent CLI',
        hint: '在 AI 设置中查看 Kimi Code 和 Codex 的安装与登录状态。',
        showSettings: true
      }
    case 'api':
      return apiFailure(r)
    case 'timeout':
      return {
        title: 'AI 生成超时',
        detail: r.message ?? '本次请求超出服务的等待时间',
        hint: '简化描述、减少需要分析的模块后重试；也可以检查网络或更换响应更快的模型。',
        output: r.output,
        showSettings: true
      }
    case 'parse':
      return {
        title: '无法解析 AI 返回内容',
        detail: r.message ?? 'AI 未返回有效的架构 JSON 或回答',
        hint: '当前画布已保留。请重试，或更换能够稳定按要求输出 JSON 的模型。',
        output: r.output,
        showSettings: true
      }
    case 'exec': {
      const output = r.output?.trim()
      const auth = /login|log in|unauthori[sz]ed|authentication|credential|登录|认证/i.test(output ?? '')
      const command = r.cli === 'codex' ? 'codex login' : 'kimi login'
      return {
        title: auth ? `${cliName(r.cli)} CLI 未登录或登录已过期` : `${cliName(r.cli)} CLI 执行失败`,
        detail: r.message ?? 'CLI 进程异常退出',
        hint: auth
          ? `在 AI 设置中启动登录，或在项目所在机器的终端运行 ${command}。`
          : '根据错误详情检查 CLI 登录状态、网络或权限。',
        output: r.output,
        showSettings: true
      }
    }
    default:
      return {
        title: 'AI 请求失败',
        detail: r.message ?? r.error ?? '未知错误',
        hint: '请根据错误详情修正后重试；当前画布已保留。',
        output: r.output,
        showSettings: true
      }
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

export interface ArchAiContext {
  spec?: ArchSpec
  mode: string
  ref: string
  baseSpec?: ArchSpec
  baseRef?: string
  sourceError?: string
}

const CHAT_MODES: Record<ArchChatMode, string> = { auto: '自动', ask: '问答', edit: '调整' }
const ACTION_LABELS = { ask: '问答', edit: '调整架构', optimize: '一键优化' }

function inferChatAction(prompt: string): 'edit' | 'ask' {
  return /[?？]\s*$/.test(prompt) ||
    /^(为什么|为何|如何|怎么|什么|哪些|哪个|解释|说明|分析|是否|有没有|能否|请介绍|告诉我|how\b|what\b|why\b|explain\b)/i.test(prompt)
    ? 'ask' : 'edit'
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes ? `${minutes}分${String(seconds % 60).padStart(2, '0')}秒` : `${seconds}秒`
}

function appendActivity(steps: ArchActivity[], event: AiArchProgress): ArchActivity[] {
  const key = event.toolId || event.stage
  const previous = steps.find((step) => step.key === key)
  const next: ArchActivity = {
    key, toolId: event.toolId, stage: event.stage, status: event.status,
    label: previous && event.label === '工具执行完成' ? previous.label : event.label,
    detail: event.text ? undefined : event.detail
  }
  if (event.stage === 'tool' && previous?.detail && event.status !== 'running') {
    next.detail = previous.detail
    next.output = event.detail !== previous.detail ? event.detail : undefined
  }
  return previous ? steps.map((step) => step.key === key ? next : step) : [...steps, next]
}

function copyMessage(text: string): void {
  void navigator.clipboard.writeText(text).then(() => useStore.getState().toast('ok', '已复制'))
    .catch(() => useStore.getState().toast('err', '无法写入剪贴板'))
}

function LiveActivity({ turn }: { turn: ArchChatTurn }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const step = turn.steps.findLast((item) => item.status === 'running') ?? turn.steps.at(-1)
  return (
    <div className="av-ai-live" role="status">
      <span className="spin-dot" aria-hidden="true" />
      <div className="av-ai-live-body">
        <strong>{step?.label ?? '正在启动 Agent'}</strong>
        {step?.detail && <span className="av-ai-live-detail">{step.detail}</span>}
      </div>
      <time className="av-ai-live-time">{formatElapsed(now - turn.startedAt)}</time>
    </div>
  )
}

function TurnCard({ turn, onRetry, onReuse, canRetry }: {
  turn: ArchChatTurn
  onRetry(): void
  onReuse(): void
  canRetry: boolean
}) {
  const running = turn.status === 'running'
  const [expanded, setExpanded] = useState<boolean | undefined>()
  const stepsOpen = expanded ?? running
  const failure = turn.failure
  const outcome = turn.status === 'stopped' ? '已停止' : turn.status === 'error' ? '请求失败' : turn.result
  return (
    <article className="ai-turn" aria-label={ACTION_LABELS[turn.action]}>
      <div className="ai-user-message">
        <div className="ai-user-meta">
          <span>{ACTION_LABELS[turn.action]}</span>
          {turn.ref && <code title={turn.ref}>{turn.ref}</code>}
          <button type="button" className="ai-icon" title="用作新草稿" aria-label="用作新草稿" onClick={onReuse}>↩</button>
        </div>
        <div className="ai-user-text">{turn.prompt}</div>
      </div>

      <div className="ai-response">
        <div className="ai-response-meta">
          <strong>{AGENT_LABELS[turn.backend]}</strong>
          {turn.model && <span className="ai-turn-model" title={turn.model}>{turn.model}</span>}
          {turn.finishedAt && <span className="ai-turn-duration">{formatElapsed(turn.finishedAt - turn.startedAt)}</span>}
          {turn.usage && <span className="ai-turn-usage" title="输入 / 输出 token">
            {turn.usage.inputTokens.toLocaleString()} 入 · {turn.usage.outputTokens.toLocaleString()} 出
          </span>}
        </div>
        {running && <LiveActivity turn={turn} />}
        {turn.steps.length > 0 && (
          <div className="av-ai-steps">
            <button type="button" className="av-ai-steps-header" aria-expanded={stepsOpen} onClick={() => setExpanded(!stepsOpen)}>
              <IconChevronDown size={12} />
              <span>执行过程</span><small>{turn.steps.length} 步</small>
            </button>
            {stepsOpen && <ol className="av-ai-steps-list">
              {turn.steps.map((step) => <li className="av-ai-step" data-status={step.status ?? 'done'} key={step.key}>
                <span className="av-ai-step-mark" aria-hidden="true" />
                <div className="av-ai-step-content">
                  <div className="av-ai-step-label">{step.label}</div>
                  {step.detail && <pre className="av-ai-step-detail">{step.detail}</pre>}
                  {step.output && <details className="ai-tool-output"><summary>查看输出</summary><pre>{step.output}</pre></details>}
                </div>
              </li>)}
            </ol>}
          </div>
        )}
        {turn.answer && (
          <div className="av-ai-answer" aria-label="AI 回答">
            <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={['img']}
              components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>
              {turn.answer}
            </ReactMarkdown>
          </div>
        )}
        {failure && (
          <div className="av-ai-error" role="alert">
            <strong>{failure.title}</strong>
            <div>{failure.detail}</div>
            <p>{failure.hint}</p>
            {failure.output && <details className="ai-tool-output"><summary>错误详情</summary><pre>{failure.output}</pre></details>}
            {failure.showSettings && <button className="btn-ghost sm" onClick={() => useStore.getState().openSettings('ai')}>AI 设置</button>}
          </div>
        )}
        {(outcome || turn.answer || failure) && !running && (
          <div className="ai-response-actions">
            {outcome && <span className={`ai-outcome ${turn.status}`}>{outcome}</span>}
            {turn.answer && <button type="button" className="ai-icon" title="复制回答" aria-label="复制回答" onClick={() => copyMessage(turn.answer!)}><IconCopy /></button>}
            {turn.status !== 'done' && <button className="btn-ghost sm" disabled={!canRetry} onClick={onRetry}>重试</button>}
          </div>
        )}
      </div>
    </article>
  )
}

interface RunningTurn {
  sessionId: string
  turnId: string
  controller: AbortController
}

function updateSession(conversation: ArchConversation, id: string, edit: (session: ArchChatSession) => ArchChatSession): ArchConversation {
  return { ...conversation, sessions: conversation.sessions.map((session) => session.id === id ? edit(session) : session) }
}

function updateTurn(conversation: ArchConversation, run: RunningTurn, edit: (turn: ArchChatTurn) => ArchChatTurn): ArchConversation {
  return updateSession(conversation, run.sessionId, (session) => ({
    ...session, turns: session.turns.map((turn) => turn.id === run.turnId ? edit(turn) : turn)
  }))
}

export default function ArchAiPanel({ projectId, projectKey, contextRef, getContext, onRendered }: {
  projectId: string
  projectKey: string
  contextRef: string
  getContext: (optimize?: boolean) => Promise<ArchAiContext>
  onRendered: (html: string, spec: ArchSpec, prompt: string) => void
}) {
  const ai = useStore((s) => s.settings.ai)
  const prefs = useStore((s) => s.settings.aiAgent)
  const { connections, ready } = useAgentConnections(projectId)
  const [conversation, setConversation] = useState(() => readArchConversation(projectKey))
  const state = useRef(conversation)
  const running = useRef<RunningTurn | null>(null)
  const storageWarning = useRef(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const transcript = useRef<HTMLDivElement>(null)
  const config = useRef<HTMLDetailsElement>(null)
  const sessionMenu = useRef<HTMLDetailsElement>(null)
  const following = useRef(true)
  const [showLatest, setShowLatest] = useState(false)
  const session = conversation.sessions.find((item) => item.id === conversation.activeId) ?? conversation.sessions[0]
  const busy = !!running.current
  const hasApi = !!(ai.baseUrl && ai.apiKey && ai.model)
  const agent = session.agent ?? prefs.agent
  const backend = effectiveArchAgent(agent, hasApi, ready)
  const options = { ...prefs.providers[backend], ...session.options?.[backend] }
  const mode = session.mode ?? prefs.mode
  const model = options.model.trim() || (backend === 'api' ? ai.model : '')
  const effort = agentEffortChoices(backend).find((item) => item.value === options.effort)?.label
  const connection = backend === 'api' ? null : connections[backend]
  const checkingAgent = agent === 'auto' && !hasApi && !ready && CLI_AGENTS.some((item) => connections[item].loading)

  const persist = useCallback((value: ArchConversation) => {
    try {
      saveArchConversation(projectKey, value)
      storageWarning.current = false
    } catch {
      if (!storageWarning.current) useStore.getState().toast('err', '无法保存 AI 会话，请检查本地存储空间')
      storageWarning.current = true
    }
  }, [projectKey])

  const change = (edit: (value: ArchConversation) => ArchConversation, save = true) => {
    const next = edit(state.current)
    state.current = next
    setConversation(next)
    if (save) persist(next)
  }

  const editSession = (patch: Partial<ArchChatSession>, save = true) => change(
    (value) => updateSession(value, session.id, (current) => ({ ...current, ...patch })), save
  )

  useEffect(() => () => {
    const run = running.current
    if (run) {
      running.current = null
      run.controller.abort()
      state.current = updateTurn(state.current, run, (turn) => finishArchTurn(turn, 'stopped'))
    }
    persist(state.current)
  }, [persist])

  useEffect(() => {
    const timer = window.setTimeout(() => persist(state.current), 350)
    return () => window.clearTimeout(timer)
  }, [session.draft, persist])

  useEffect(() => {
    const close = (event: PointerEvent) => {
      for (const details of [config.current, sessionMenu.current]) {
        if (details?.open && !details.contains(event.target as Node)) details.open = false
      }
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [])

  const scrollToLatest = useCallback(() => {
    const element = transcript.current
    if (element) element.scrollTop = element.scrollHeight
  }, [])
  useLayoutEffect(() => {
    if (following.current) scrollToLatest()
  }, [session.turns, scrollToLatest])

  const selectSession = (id: string) => {
    following.current = true
    setShowLatest(false)
    change((value) => ({ ...value, activeId: id }))
  }

  const newSession = () => {
    const next = createArchSession()
    following.current = true
    setShowLatest(false)
    change((value) => ({ activeId: next.id, sessions: [next, ...value.sessions] }))
    inputRef.current?.focus()
  }

  const removeSession = async () => {
    if (running.current?.sessionId === session.id || !await askConfirm(`删除「${session.title}」的本地会话记录？`, { title: '删除会话', confirmLabel: '删除' })) return
    const rest = state.current.sessions.filter((item) => item.id !== session.id)
    if (!rest.length) rest.push(createArchSession())
    following.current = true
    setShowLatest(false)
    change(() => ({ activeId: rest[0].id, sessions: rest }))
  }

  const finish = (run: RunningTurn, status: 'done' | 'stopped' | 'error', patch: Partial<ArchChatTurn> = {}) => {
    if (running.current !== run) return
    running.current = null
    change((value) => updateTurn(value, run, (turn) => finishArchTurn({ ...turn, ...patch }, status)))
  }

  const stop = () => {
    const run = running.current
    if (!run) return
    run.controller.abort()
    finish(run, 'stopped')
  }

  const send = async (request?: { prompt: string; action: ArchChatTurn['action'] }) => {
    const prompt = (request?.prompt ?? session.draft).trim()
    if (!prompt || running.current || checkingAgent) return
    const action = request?.action ?? (mode === 'auto' ? inferChatAction(prompt) : mode)
    const history = recentArchExchanges(session.turns)
    const run: RunningTurn = { sessionId: session.id, turnId: crypto.randomUUID(), controller: new AbortController() }
    const signal = run.controller.signal
    const turn: ArchChatTurn = {
      id: run.turnId, prompt, action, backend, model, startedAt: Date.now(), status: 'running',
      steps: [{ key: 'context', stage: 'context', label: '正在读取项目上下文', status: 'running' }]
    }
    running.current = run
    following.current = true
    setShowLatest(false)
    if (config.current) config.current.open = false
    change((value) => updateSession(value, session.id, (current) => ({
      ...current,
      title: current.title === '新会话' && !current.turns.length
        ? action === 'optimize' ? '一键优化架构' : Array.from(prompt.replace(/\s+/g, ' ')).slice(0, 34).join('')
        : current.title,
      draft: request ? current.draft : '',
      turns: [...current.turns, turn]
    })))

    const fail = (failure: AiFailure) => finish(run, 'error', { failure })
    const progress = (event: AiArchProgress) => {
      if (signal.aborted || running.current !== run) return
      change((value) => updateTurn(value, run, (current) => ({
        ...current,
        steps: appendActivity(current.steps, event),
        answer: event.text ? current.answer ? current.answer + (backend === 'codex' ? '\n\n' : '') + event.text : event.text : current.answer,
        usage: event.usage ?? current.usage
      })), false)
    }

    try {
      const context = await getContext(action === 'optimize')
      if (signal.aborted) return
      if (context.sourceError && action !== 'ask') {
        fail({ title: '缺少可用的架构', detail: context.sourceError, hint: '切换到含有可分析源码的版本后重试。' })
        return
      }
      change((value) => updateTurn(value, run, (current) => ({ ...current, ref: context.ref })), false)
      const result = await archAiGenerate(projectId, prompt, signal, apiCallFor(projectId), {
        action, agent: backend, options: archRuntimeOptionsForAgent(options, backend), context,
        ai: backend === 'api' && hasApi ? { ...ai, model } : undefined, history, onProgress: progress
      })
      if (signal.aborted) return
      if (!result.ok) { fail(aiFailure(result)); return }
      if (action === 'ask') {
        if (!result.answer?.trim()) {
          fail({ title: 'AI 未返回回答', detail: '请求已完成，回答内容为空。', hint: '重试，或在运行选项中选择其他模型。', showSettings: true })
          return
        }
        finish(run, 'done', { answer: result.answer, model: result.model || model })
        return
      }
      const bridge = window.timber
      if (!bridge || !result.spec) {
        fail({ title: '无法生成架构', detail: bridge ? '响应缺少可用的架构数据。' : '架构渲染需要 Timber 桌面应用。', hint: '检查当前环境后重试。' })
        return
      }
      progress({ stage: 'render', label: '正在校验和渲染架构', status: 'running' })
      let spec = result.spec
      let rendered = await bridge.archRender(JSON.stringify(spec), `current:${projectId}`)
      if (signal.aborted) return
      if (!rendered.ok && /validation failed/i.test(rendered.error ?? '') && hasConnLabels(spec)) {
        spec = stripConnLabels(spec) as ArchSpec
        rendered = await bridge.archRender(JSON.stringify(spec), `current:${projectId}`)
        if (signal.aborted) return
      }
      if (!rendered.ok || !rendered.html) {
        fail({ title: '架构渲染失败', detail: rendered.error ?? '渲染器未返回画布。', hint: '请缩小调整范围后重试。' })
        return
      }
      onRendered(rendered.html, spec, prompt)
      progress({ stage: 'render', label: '架构校验完成', status: 'done' })
      finish(run, 'done', { result: action === 'optimize' ? '已按源码重新生成架构' : '已更新当前架构', model: result.model || model })
    } catch (error) {
      if (!signal.aborted) {
        fail({ title: '无法完成请求', detail: error instanceof Error ? error.message : String(error), hint: '检查连接后重试。', showSettings: true })
      }
    }
  }

  const updateOptions = (patch: Partial<ArchAgentOptions>) => editSession({
    options: { ...session.options, [backend]: { ...session.options?.[backend], ...patch } }
  })

  const reuse = (prompt: string) => {
    editSession({ draft: prompt })
    inputRef.current?.focus()
  }
  const shortcut = window.timber?.platform === 'darwin' ? '⌘ + Enter' : 'Ctrl + Enter'
  const sendHint = prefs.sendShortcut === 'enter' ? 'Enter 发送 · Shift + Enter 换行' : `${shortcut} 发送`

  return (
    <section className="av-ai-panel" aria-label="架构 AI 对话" onKeyDown={(event) => {
      if (event.key !== 'Escape') return
      for (const details of [config.current, sessionMenu.current]) {
        if (details?.open) {
          details.open = false
          details.querySelector('summary')?.focus()
          event.stopPropagation()
        }
      }
    }}>
      <div className="ai-chat-head">
        <IconAnnotation />
        <span className="av-ai-title">AI 对话</span>
        <button type="button" className="ai-icon" title="新建会话" aria-label="新建会话" onClick={newSession}><IconPlus /></button>
        <button type="button" className="ai-icon" title="AI 设置" aria-label="AI 设置" onClick={() => useStore.getState().openSettings('ai')}><IconSettings size={15} /></button>
      </div>
      <div className="ai-thread-head">
        <select className="ai-thread-select" aria-label="切换 AI 会话" value={session.id} onChange={(event) => selectSession(event.target.value)}>
          {conversation.sessions.map((item) => <option key={item.id} value={item.id}>
            {item.title}{item.id === running.current?.sessionId ? ' · 运行中' : ''}
          </option>)}
        </select>
        <details className="ai-thread-menu" ref={sessionMenu}>
          <summary className="ai-icon" aria-label="会话操作" title="会话操作">···</summary>
          <div>
            <button type="button" onClick={() => {
              if (sessionMenu.current) sessionMenu.current.open = false
              void askInput('会话名称', session.title, '重命名会话').then((name) => {
                if (name?.trim()) editSession({ title: name.trim() })
              })
            }}>重命名</button>
            <button type="button" disabled={running.current?.sessionId === session.id} onClick={() => {
              if (sessionMenu.current) sessionMenu.current.open = false
              void removeSession()
            }}>删除会话</button>
          </div>
        </details>
      </div>
      <div className="ai-transcript-wrap">
        <div className="av-ai-conversation" ref={transcript} aria-label="会话消息" onScroll={(event) => {
          const node = event.currentTarget
          following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64
          setShowLatest(!following.current)
        }}>
          {session.turns.length === 0 && (
            <div className="ai-chat-empty">
              <div className="ai-empty-icon"><IconAnnotation size={24} /></div>
              <strong>{connection && !connection.loading && !connection.installed ? '连接 Kimi Code 或 Codex' : '开始一段架构对话'}</strong>
              <p>{connection && !connection.loading && !connection.installed ? '在 AI 设置中查看安装方式和登录状态。' : '询问项目中的模块、依赖关系，或描述想调整的架构。'}</p>
              <button className="btn-ghost sm" onClick={() => connection && !connection.installed
                ? useStore.getState().openSettings('ai')
                : reuse('请梳理当前项目的主要模块与调用链。')}>
                {connection && !connection.installed ? '打开 AI 设置' : '梳理主要模块'}
              </button>
            </div>
          )}
          {session.turns.map((item) => <TurnCard key={item.id} turn={item} canRetry={!busy && !checkingAgent}
            onReuse={() => reuse(item.prompt)} onRetry={() => void send({ prompt: item.prompt, action: item.action })} />)}
        </div>
        {showLatest && <button type="button" className="ai-jump-latest" onClick={() => {
          following.current = true
          setShowLatest(false)
          scrollToLatest()
        }}><IconChevronDown /> 最新消息</button>}
      </div>
      <div className="ai-composer-wrap">
        <div className="ai-composer-context">
          <span className="ai-ref-chip" title={contextRef}>{contextRef}</span>
          <label className="ai-chat-mode">
            <select aria-label="会话模式" value={mode} onChange={(event) => editSession({ mode: event.target.value as ArchChatMode })}>
              {Object.entries(CHAT_MODES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <IconChevronDown size={12} />
          </label>
        </div>
        <div className="av-ai-composer">
          <textarea
            ref={inputRef}
            className="av-ai-input"
            aria-label="架构对话输入"
            placeholder={mode === 'edit' ? '描述要调整的模块或布局…' : '向当前项目提问…'}
            value={session.draft}
            onChange={(event) => editSession({ draft: event.target.value }, false)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'ArrowUp' && !session.draft && session.turns.length) {
                event.preventDefault()
                reuse(session.turns.at(-1)!.prompt)
                return
              }
              if (event.key !== 'Enter' || event.shiftKey) return
              const modifier = event.ctrlKey || event.metaKey
              if (prefs.sendShortcut === 'mod-enter' && !modifier) return
              event.preventDefault()
              if (!busy) void send()
            }}
          />
          <div className="av-ai-actions">
            <button type="button" className="ai-icon av-ai-optimize" disabled={busy || checkingAgent} title="一键优化 · 按源码重新生成架构" aria-label="一键优化"
              onClick={() => void send({ prompt: ai.architecturePrompt.trim() || DEFAULT_ARCHITECTURE_PROMPT, action: 'optimize' })}>
              <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09ZM12 15l-3-3A18 18 0 0 1 22 2a18 18 0 0 1-10 13ZM9 12H4s.6-3 2-4c1.6-1 5 0 5 0m1 7v5s3-.6 4-2c1-1.6 0-5 0-5" /></svg>
              <span className="av-ai-action-label">优化</span>
            </button>
            <details className="av-ai-model-menu" ref={config}>
              <summary aria-label="Agent 与模型配置" title={`${AGENT_LABELS[backend]} · ${model || 'CLI 默认模型'}`}>
                <span className={`ai-connection-dot ${connection?.authenticated || hasApi && backend === 'api' ? 'ready' : ''}`} aria-hidden="true" />
                <span className="av-ai-current-agent">{AGENT_LABELS[backend]}</span>
                <span className="av-ai-current-model">{model || '默认模型'}</span>
                <IconChevronDown size={12} />
              </summary>
              <div className="av-ai-config-pop">
                <div className="ai-config-head">
                  <strong>本会话配置</strong>
                  <button className="btn-ghost sm" onClick={() => editSession({ agent: undefined, mode: undefined, options: undefined })}>恢复默认</button>
                </div>
                <label className="ai-config-agent"><span>服务商</span>
                  <select aria-label="架构 Agent" value={agent} onChange={(event) => editSession({ agent: event.target.value as ArchAgentKind })}>
                    {(['auto', ...CLI_AGENTS, ...(hasApi ? ['api' as const] : [])] as const).map((item) =>
                      <option key={item} value={item}>{AGENT_LABELS[item]}</option>
                    )}
                  </select>
                </label>
                <AgentOptionFields agent={backend} options={options} onChange={updateOptions} modelLabel="架构模型" apiModel={ai.model} />
                <div className="ai-config-footer">
                  <span>{connection ? connectionLabel(connection) : effort ?? '兼容 API'}</span>
                  <button className="btn-ghost sm" onClick={() => useStore.getState().openSettings('ai')}>AI 设置</button>
                </div>
              </div>
            </details>
            {busy ? (
              <button type="button" className="av-ai-send stop" title="停止当前请求" aria-label="停止当前请求" onClick={stop}>
                <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
              </button>
            ) : (
              <button type="button" className="av-ai-send" title={checkingAgent ? '正在检测 Agent' : sendHint} aria-label="发送" disabled={!session.draft.trim() || checkingAgent} onClick={() => void send()}>
                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5m0 0-6 6m6-6 6 6" /></svg>
              </button>
            )}
          </div>
        </div>
        {busy && running.current?.sessionId !== session.id && <div className="ai-other-running">另一个会话正在运行</div>}
      </div>
    </section>
  )
}
