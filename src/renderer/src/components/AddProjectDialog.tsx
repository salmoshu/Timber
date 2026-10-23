import { askConfirm, askInput, askPath } from '../utils/dialogs'
import { useEffect, useRef, useState } from 'react'
import type { RemoteConfig, RemoteKind } from '@shared/types'
import { useStore } from '../store'
import { api } from '../api'
import { fsList, type FsEntry, type LogLine } from '../utils/remote'

type Mode = 'choose' | 'kind' | 'config' | 'connecting' | 'browse'

const KIND_CARDS: Record<RemoteKind, { icon: string; name: string; desc: string }> = {
  wsl: { icon: '🐧', name: 'WSL', desc: '选择已安装的发行版，自动部署 timberd 并接入' },
  ssh: { icon: '🔐', name: 'SSH', desc: '填写主机与凭据，自动部署 timberd 并建立端口转发' },
  docker: { icon: '🐳', name: 'Docker', desc: '连接容器内已运行的 timberd（docker run -p <端口>:37123）' },
  custom: { icon: '🌐', name: '自定义', desc: '连接任意可达的 timberd 地址（host:port + 令牌）' }
}

/** 添加项目：本地文件夹，或 zcode 式远程连接向导（选方式 → 配置 → 连接日志 → 选远程目录） */
export default function AddProjectDialog() {
  const store = useStore()
  const {
    addProjectOpen,
    closeAddProject,
    remotes,
    connectRemote,
    reconnectRemote,
    disconnectRemote,
    removeRemote,
    importProject,
    importRemoteProject,
    toast
  } = store

  const [mode, setMode] = useState<Mode>('choose')
  const [kind, setKind] = useState<RemoteKind>('wsl')

  // 通用表单
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('37123')
  const [token, setToken] = useState('')
  // SSH
  const [sshUser, setSshUser] = useState('')
  const [sshPort, setSshPort] = useState('22')
  const [sshAuth, setSshAuth] = useState<'password' | 'key'>('password')
  const [sshPassword, setSshPassword] = useState('')
  const [sshKeyPath, setSshKeyPath] = useState('')
  // WSL
  const [distros, setDistros] = useState<string[]>([])
  const [distro, setDistro] = useState('')
  const [detecting, setDetecting] = useState(false)

  // 连接日志
  const [logs, setLogs] = useState<LogLine[]>([])
  const [connErr, setConnErr] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  // 目录浏览
  const [browseRemote, setBrowseRemote] = useState<RemoteConfig | null>(null)
  const [cwd, setCwd] = useState('')
  const [home, setHome] = useState('')
  const [parent, setParent] = useState('')
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [showHidden, setShowHidden] = useState(false)
  const [browseLoading, setBrowseLoading] = useState(false)
  const [importing, setImporting] = useState(false)

  // 关闭时整体复位
  useEffect(() => {
    if (!addProjectOpen) {
      setMode('choose')
      setLogs([])
      setConnErr(null)
      setBrowseRemote(null)
      setShowHidden(false)
    }
  }, [addProjectOpen])

  // WSL：进入配置页时探测发行版
  useEffect(() => {
    if (addProjectOpen && mode === 'config' && kind === 'wsl' && distros.length === 0 && !detecting) {
      setDetecting(true)
      api<{ distros: string[] }>('GET', '/api/wsl/distros')
        .then((r) => {
          const list = (r.distros ?? []).filter((d) => !d.startsWith('docker-'))
          setDistros(list)
          if (list.length > 0) setDistro(list[0])
        })
        .catch((err) => toast('err', `WSL 探测失败：${err}`))
        .finally(() => setDetecting(false))
    }
  }, [addProjectOpen, mode, kind, distros.length, detecting, toast])

  // 日志自动滚底
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [logs])

  if (!addProjectOpen) return null

  const pushLog = (l: LogLine): void => setLogs((prev) => [...prev, l])

  const loadDir = (remote: RemoteConfig, path: string, all = showHidden): void => {
    setBrowseLoading(true)
    fsList(remote, path, all)
      .then((r) => {
        setCwd(r.path)
        setHome(r.home)
        setParent(r.parent)
        setEntries(r.entries)
      })
      .catch((err) => toast('err', `目录读取失败：${err}`))
      .finally(() => setBrowseLoading(false))
  }

  const openBrowse = (remote: RemoteConfig): void => {
    setBrowseRemote(remote)
    setMode('browse')
    loadDir(remote, '')
  }

  const startConnect = async (): Promise<void> => {
    setLogs([])
    setConnErr(null)
    setMode('connecting')
    try {
      let id: string
      if (kind === 'wsl') {
        id = await connectRemote({ kind: 'wsl', name, distro }, pushLog)
      } else if (kind === 'ssh') {
        id = await connectRemote(
          {
            kind: 'ssh',
            name,
            ssh: {
              host: host.trim(),
              port: Number(sshPort) || 22,
              user: sshUser.trim(),
              auth: sshAuth,
              password: sshPassword || undefined,
              keyPath: sshKeyPath.trim() || undefined
            }
          },
          pushLog
        )
      } else {
        id = await connectRemote(
          { kind, name, host: host.trim(), port: Number(port) || 37123, token: token.trim() },
          pushLog
        )
      }
      const remote = useStore.getState().remotes.find((r) => r.id === id)
      if (remote) {
        pushLog({ level: 'ok', msg: '连接成功，请选择要导入的目录' })
        openBrowse(remote)
      } else {
        closeAddProject()
      }
    } catch {
      setConnErr('连接失败，可返回修改配置后重试')
    }
  }

  const doImport = async (): Promise<void> => {
    if (!browseRemote || importing) return
    setImporting(true)
    try {
      await importRemoteProject(browseRemote.id, cwd)
      closeAddProject()
    } catch {
      /* toast 已提示 */
    } finally {
      setImporting(false)
    }
  }

  const onPickLocal = async (): Promise<void> => {
    if (window.timber) {
      const path = await askPath('folder')
      if (path) {
        await importProject(path)
        closeAddProject()
      }
    } else {
      const path = await askInput('纯 Web 预览模式：请输入项目目录的绝对路径')
      if (path) {
        await importProject(path)
        closeAddProject()
      }
    }
  }

  const configValid =
    kind === 'wsl'
      ? !!distro
      : kind === 'ssh'
        ? !!host.trim() && !!sshUser.trim() && (sshAuth === 'key' ? !!sshKeyPath.trim() : !!sshPassword)
        : !!host.trim()

  return (
    <div className="settings-mask" onClick={closeAddProject}>
      <div className={`remote-dialog ${mode === 'browse' ? 'wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="rd-title">添加项目</div>

        {mode === 'choose' && (
          <div className="rd-choose">
            <button className="rd-choice" onClick={() => void onPickLocal()}>
              <span className="rd-choice-icon">📁</span>
              <span className="rd-choice-name">本地文件夹</span>
              <span className="rd-choice-desc">导入本机目录（含 WSL/网络路径可直接粘贴）</span>
            </button>
            <button className="rd-choice" onClick={() => setMode('kind')}>
              <span className="rd-choice-icon">🌐</span>
              <span className="rd-choice-name">远程连接</span>
              <span className="rd-choice-desc">WSL / SSH 自动接入，Docker / 自定义 timberd 直连</span>
            </button>
          </div>
        )}

        {mode === 'kind' && (
          <>
            <div className="rd-sub">选择连接方式（WSL / SSH 会自动部署 timberd 到远端）</div>
            <div className="rd-choose">
              {(Object.keys(KIND_CARDS) as RemoteKind[]).map((k) => (
                <button
                  key={k}
                  className="rd-choice"
                  onClick={() => {
                    setKind(k)
                    setMode('config')
                  }}
                >
                  <span className="rd-choice-icon">{KIND_CARDS[k].icon}</span>
                  <span className="rd-choice-name">{KIND_CARDS[k].name}</span>
                  <span className="rd-choice-desc">{KIND_CARDS[k].desc}</span>
                </button>
              ))}
            </div>
            {remotes.length > 0 && (
              <>
                <div className="rd-divider" />
                <div className="rd-list-title">已保存的远程（重启应用后需重新连接）</div>
                <div className="rd-list">
                  {remotes.map((r) => (
                    <div key={r.id} className={`rd-item ${r.connected ? '' : 'off'}`}>
                      <span className="rd-dot" title={r.connected ? '已连接' : '未连接'} />
                      <span className="rd-name" title={r.lastError ?? r.name}>
                        {r.name}
                      </span>
                      <span className="rd-host">
                        {r.host}:{r.port}
                      </span>
                      <span className="rd-ops">
                        {r.connected && <button onClick={() => openBrowse(r)}>添加目录</button>}
                        {r.connected && (
                          <button onClick={() => disconnectRemote(r.id)}>断开</button>
                        )}
                        {!r.connected && <button onClick={() => void reconnectRemote(r.id)}>重连</button>}
                        <button
                          className="danger"
                          onClick={async () => {
                            if (await askConfirm(`确定从列表移除远程连接「${r.name}」？（不影响远端文件）`)) {
                              removeRemote(r.id)
                            }
                          }}
                        >
                          移除
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
            <button className="rd-back" onClick={() => setMode('choose')}>
              ← 返回
            </button>
          </>
        )}

        {mode === 'config' && (
          <>
            <div className="rd-sub">
              {KIND_CARDS[kind].icon} {KIND_CARDS[kind].name} —— {KIND_CARDS[kind].desc}
            </div>
            <form
              className="rd-form"
              onSubmit={(e) => {
                e.preventDefault()
                if (configValid) void startConnect()
              }}
            >
              <label className="rd-row">
                <span>名称</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="可选"
                  spellCheck={false}
                />
              </label>

              {kind === 'wsl' && (
                <label className="rd-row">
                  <span>发行版</span>
                  {detecting ? (
                    <span className="rd-hint">正在探测…</span>
                  ) : distros.length === 0 ? (
                    <span className="rd-hint">未探测到发行版（docker- 后端已忽略）</span>
                  ) : (
                    <select value={distro} onChange={(e) => setDistro(e.target.value)}>
                      {distros.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                  )}
                </label>
              )}

              {(kind === 'ssh' || kind === 'docker' || kind === 'custom') && (
                <label className="rd-row">
                  <span>主机</span>
                  <input
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder={kind === 'ssh' ? '例如：192.168.1.10' : '例如：127.0.0.1'}
                    spellCheck={false}
                    autoFocus
                  />
                </label>
              )}

              {kind === 'ssh' && (
                <>
                  <label className="rd-row">
                    <span>端口</span>
                    <input value={sshPort} onChange={(e) => setSshPort(e.target.value)} placeholder="22" spellCheck={false} />
                  </label>
                  <label className="rd-row">
                    <span>用户</span>
                    <input value={sshUser} onChange={(e) => setSshUser(e.target.value)} placeholder="登录用户名" spellCheck={false} />
                  </label>
                  <label className="rd-row">
                    <span>认证</span>
                    <select value={sshAuth} onChange={(e) => setSshAuth(e.target.value as 'password' | 'key')}>
                      <option value="password">密码</option>
                      <option value="key">私钥文件</option>
                    </select>
                  </label>
                  {sshAuth === 'password' ? (
                    <label className="rd-row">
                      <span>密码</span>
                      <input
                        type="password"
                        value={sshPassword}
                        onChange={(e) => setSshPassword(e.target.value)}
                        placeholder="仅保存在本机"
                        spellCheck={false}
                      />
                    </label>
                  ) : (
                    <label className="rd-row">
                      <span>私钥</span>
                      <input
                        value={sshKeyPath}
                        onChange={(e) => setSshKeyPath(e.target.value)}
                        placeholder="例如：C:\Users\xxx\.ssh\id_rsa"
                        spellCheck={false}
                      />
                    </label>
                  )}
                </>
              )}

              {(kind === 'docker' || kind === 'custom') && (
                <>
                  <label className="rd-row">
                    <span>端口</span>
                    <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="37123" spellCheck={false} />
                  </label>
                  <label className="rd-row">
                    <span>令牌</span>
                    <input
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder="访问令牌（X-Timber-Token）"
                      spellCheck={false}
                    />
                  </label>
                </>
              )}

              {kind === 'docker' && (
                <div className="rd-tip">容器内运行 timberd 并映射端口：docker run -p &lt;端口&gt;:37123 …，此处连接映射后的端口</div>
              )}
              {kind === 'ssh' && <div className="rd-tip">凭据仅保存在本机 localStorage；远端需为 Linux，将自动部署 timberd</div>}

              <button className="btn-primary rd-connect" type="submit" disabled={!configValid}>
                连接
              </button>
            </form>
            <button className="rd-back" onClick={() => setMode('kind')}>
              ← 返回
            </button>
          </>
        )}

        {mode === 'connecting' && (
          <>
            <div className="rd-sub">正在建立连接…</div>
            <div className="rd-log" ref={logRef}>
              {logs.map((l, i) => (
                <div key={i} className={`rd-log-line ${l.level}`}>
                  {l.level === 'ok' ? '✔ ' : l.level === 'err' ? '✖ ' : '› '}
                  {l.msg}
                </div>
              ))}
              {!connErr && <div className="rd-log-line info">…</div>}
            </div>
            {connErr && (
              <>
                <div className="rd-tip err">{connErr}</div>
                <button className="rd-back" onClick={() => setMode('config')}>
                  ← 返回修改
                </button>
              </>
            )}
          </>
        )}

        {mode === 'browse' && browseRemote && (
          <>
            <div className="rd-sub">
              {browseRemote.name} —— 选择要导入为项目的目录
            </div>
            <div className="rd-pathbar">
              <button title="上级目录" disabled={!parent} onClick={() => loadDir(browseRemote, parent)}>
                ↑
              </button>
              <button title="家目录" onClick={() => loadDir(browseRemote, home)}>
                ⌂
              </button>
              <span className="rd-cwd" title={cwd}>
                {cwd}
              </span>
              <label className="rd-hidden">
                <input
                  type="checkbox"
                  checked={showHidden}
                  onChange={(e) => {
                    setShowHidden(e.target.checked)
                    loadDir(browseRemote, cwd, e.target.checked)
                  }}
                />
                隐藏目录
              </label>
            </div>
            <div className="rd-dirs">
              {browseLoading && <div className="rd-hint pad">加载中…</div>}
              {!browseLoading && entries.length === 0 && <div className="rd-hint pad">（无子目录）</div>}
              {!browseLoading &&
                entries.map((e) => (
                  <button key={e.path} className="rd-dir" onClick={() => loadDir(browseRemote, e.path)}>
                    <span className="rd-dir-icon">📁</span>
                    <span className="rd-dir-name">{e.name}</span>
                    {e.hasDocs && <span className="rd-dir-badge">含文档</span>}
                  </button>
                ))}
            </div>
            <div className="rd-actions">
              <button className="btn-primary" disabled={!cwd || importing} onClick={() => void doImport()}>
                {importing ? '导入中…' : '导入该目录'}
              </button>
              <button className="rd-skip" onClick={closeAddProject}>
                完成，稍后再选
              </button>
            </div>
          </>
        )}

        <button className="st-close" onClick={closeAddProject} title="关闭">
          ✕
        </button>
      </div>
    </div>
  )
}
