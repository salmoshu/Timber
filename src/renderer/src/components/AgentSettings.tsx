import { useEffect, useState } from 'react'
import { aiCliLogin, aiTest } from '../api'
import { useStore } from '../store'
import { AGENT_LABELS, CLI_AGENTS, DEFAULT_AGENT_OPTIONS, type ArchAgentKind, type ArchAgentPreferences, type CliAgent } from '../utils/archAgentOptions'
import { DEFAULT_ARCHITECTURE_PROMPT } from '../utils/settings'
import { connectionLabel, useAgentConnections } from '../utils/useAgentConnections'
import AgentOptionFields from './AgentOptionFields'
import { IconCopy } from './icons'

const INSTALL_DOCS: Record<CliAgent, string> = {
  kimi: 'https://github.com/MoonshotAI/kimi-code#installation',
  codex: 'https://github.com/openai/codex#quickstart'
}

export default function AgentSettings() {
  const ai = useStore((s) => s.settings.ai)
  const prefs = useStore((s) => s.settings.aiAgent)
  const remote = useStore((s) => s.projects.find((project) => project.id === s.activeProjectId && project.remoteId))
  const setSetting = useStore((s) => s.setSetting)
  const toast = useStore((s) => s.toast)
  const [scope, setScope] = useState<'local' | 'remote'>(remote ? 'remote' : 'local')
  const projectId = scope === 'remote' ? remote?.id ?? null : null
  const { connections, refresh } = useAgentConnections(projectId)
  const [loggingIn, setLoggingIn] = useState<CliAgent | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const legacy = !!(ai.baseUrl || ai.apiKey || ai.model)
  const apiReady = !!(ai.baseUrl && ai.apiKey && ai.model)
  const update = (patch: Partial<ArchAgentPreferences>) => setSetting('aiAgent', { ...useStore.getState().settings.aiAgent, ...patch })
  const sendKey = window.timber?.platform === 'darwin' ? '⌘ + Enter' : 'Ctrl + Enter'

  useEffect(() => {
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])

  const connect = async (agent: CliAgent) => {
    setLoggingIn(agent)
    try {
      const result = await aiCliLogin(agent)
      toast(result.ok ? 'ok' : 'err', result.message ?? '无法打开登录终端')
    } catch (error) {
      toast('err', String(error))
    } finally {
      setLoggingIn(null)
      refresh()
    }
  }

  const testLegacy = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await aiTest(ai)
      setTestResult({ ok: result.ok, text: result.ok ? `${result.model ?? ai.model} 已响应` : result.message ?? '连接失败' })
    } catch (error) {
      setTestResult({ ok: false, text: String(error) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="st-card ai-settings">
      <div className="st-card-title">AI 设置</div>
      <section className="ai-settings-section" aria-labelledby="agent-connection-title">
        <div className="ai-settings-heading">
          <div>
            <h2 id="agent-connection-title">服务商连接</h2>
            <p>使用所选机器上已安装的 CLI 和登录账号。</p>
          </div>
          {remote && (
            <select aria-label="检测 Agent 的机器" value={scope} onChange={(event) => setScope(event.target.value === 'remote' ? 'remote' : 'local')}>
              <option value="local">本机</option><option value="remote">当前远端</option>
            </select>
          )}
          <button className="btn-ghost sm" disabled={CLI_AGENTS.every((agent) => connections[agent].loading)} onClick={refresh}>重新检测</button>
        </div>
        <div className="ai-provider-list">
          {CLI_AGENTS.map((agent) => {
            const connection = connections[agent]
            const command = `${agent} login`
            return (
              <article className="st-agent-card" key={agent}>
                <div className="st-agent-head">
                  <span className={`st-agent-mark ${agent}`} aria-hidden="true">{agent === 'kimi' ? 'K' : 'C'}</span>
                  <div className="ai-provider-name"><strong>{AGENT_LABELS[agent]}</strong>{connection.version && <small>{connection.version}</small>}</div>
                  <span className={`st-agent-status ${connection.authenticated ? 'ok' : ''}`}>{connectionLabel(connection)}</span>
                </div>
                {connection.path && <code className="ai-provider-path" title={connection.path}>{connection.path}</code>}
                {connection.error && <div className="st-agent-error" role="alert">{connection.error}</div>}
                <div className="st-agent-actions">
                  {!connection.installed && !connection.loading && (
                    <a className="btn-ghost sm" href={INSTALL_DOCS[agent]} target="_blank" rel="noreferrer">安装说明 ↗</a>
                  )}
                  {!projectId && connection.installed && (
                    <button type="button" className="btn-primary sm" disabled={loggingIn !== null}
                      onClick={() => void connect(agent)}>
                      {loggingIn === agent ? '正在打开终端…' : connection.authenticated ? '重新登录' : '登录'}
                    </button>
                  )}
                  {projectId && connection.installed && (
                    <button type="button" className="btn-ghost sm ai-copy-login" title={`在远端运行 ${command}`}
                      onClick={() => void navigator.clipboard.writeText(command)
                        .then(() => toast('ok', `已复制 ${command}，请在远端终端运行`))
                        .catch(() => toast('err', '无法写入剪贴板'))}>
                      <IconCopy size={13} /> {command}
                    </button>
                  )}
                </div>
                <div className="ai-provider-options">
                  <div className="ai-provider-options-head">
                    <strong>默认运行配置</strong>
                    <button type="button" className="btn-ghost sm" onClick={() => update({ providers: { ...useStore.getState().settings.aiAgent.providers, [agent]: DEFAULT_AGENT_OPTIONS } })}>重置</button>
                  </div>
                  <AgentOptionFields
                    agent={agent} options={prefs.providers[agent]} modelLabel={`${AGENT_LABELS[agent]} 模型`}
                    onChange={(patch) => {
                      const providers = useStore.getState().settings.aiAgent.providers
                      update({ providers: { ...providers, [agent]: { ...providers[agent], ...patch } } })
                    }}
                  />
                </div>
              </article>
            )
          })}
        </div>
      </section>

      <section className="ai-settings-section">
        <div className="ai-settings-heading"><h2>新会话</h2></div>
        <div className="ai-option-fields ai-chat-defaults">
          <label><span>默认服务商</span>
            <select value={prefs.agent} onChange={(event) => update({ agent: event.target.value as ArchAgentKind })}>
              {(['auto', ...CLI_AGENTS, ...(legacy ? ['api' as const] : [])] as const).map((agent) =>
                <option key={agent} value={agent}>{AGENT_LABELS[agent]}</option>
              )}
            </select>
          </label>
          <label><span>默认会话模式</span>
            <select value={prefs.mode} onChange={(event) => update({ mode: event.target.value as ArchAgentPreferences['mode'] })}>
              <option value="auto">自动识别</option><option value="ask">问答</option><option value="edit">调整架构</option>
            </select>
          </label>
          <label><span>发送快捷键</span>
            <select value={prefs.sendShortcut} onChange={(event) => update({ sendShortcut: event.target.value as ArchAgentPreferences['sendShortcut'] })}>
              <option value="enter">Enter</option><option value="mod-enter">{sendKey}</option>
            </select>
          </label>
        </div>
      </section>

      <section className="ai-settings-section">
        <div className="ai-settings-heading">
          <label htmlFor="architecture-prompt"><h2>一键优化提示词</h2></label>
          <button className="btn-ghost sm" onClick={() => setSetting('ai', { ...ai, architecturePrompt: DEFAULT_ARCHITECTURE_PROMPT })}>恢复默认</button>
        </div>
        <textarea id="architecture-prompt" className="st-input st-prompt-input" aria-label="一键优化提示词" spellCheck={false}
          value={ai.architecturePrompt} onChange={(event) => setSetting('ai', { ...ai, architecturePrompt: event.target.value })} />
      </section>

      {legacy && <details className="ai-legacy-settings">
        <summary>已有的兼容 API 配置</summary>
        <div className="ai-option-fields">
          <label className="ai-option-model"><span>API 地址</span><input type="url" value={ai.baseUrl} onChange={(event) => setSetting('ai', { ...ai, baseUrl: event.target.value })} /></label>
          <label><span>API Key</span><input type={showKey ? 'text' : 'password'} autoComplete="off" value={ai.apiKey} onChange={(event) => setSetting('ai', { ...ai, apiKey: event.target.value })} /></label>
          <label><span>模型</span><input value={ai.model} onChange={(event) => setSetting('ai', { ...ai, model: event.target.value })} /></label>
        </div>
        <div className="st-agent-actions">
          <button className="btn-ghost sm" onClick={() => setShowKey(!showKey)}>{showKey ? '隐藏密钥' : '显示密钥'}</button>
          <button className="btn-primary sm" disabled={!apiReady || testing} onClick={() => void testLegacy()}>测试连接</button>
          {testResult && <span className={`st-test-msg ${testResult.ok ? 'ok' : 'err'}`} role="status">{testResult.text}</span>}
        </div>
      </details>}
    </div>
  )
}
