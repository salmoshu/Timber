import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'

interface Props {
  url: string
  onClose(): void
}

/**
 * 应用内外链浮层：Electron 下用 <webview>（独立 partition，可后退/监控 HTTP 状态），
 * 纯 Web 预览回退 <iframe>。主文档返回 >=400 或加载失败时展示美化错误页。
 */
export default function ExternalPage({ url: initialUrl, onClose }: Props) {
  const bridge = window.timber
  const webviewRef = useRef<WebviewTag | null>(null)
  const [url, setUrl] = useState(initialUrl)
  const [canBack, setCanBack] = useState(false)
  const [err, setErr] = useState<{ kind: 'http' | 'net'; code?: number; desc?: string } | null>(
    null
  )

  // 新链接打开时重置状态
  useEffect(() => {
    setUrl(initialUrl)
    setErr(null)
    setCanBack(false)
  }, [initialUrl])

  // Esc 关闭浮层（capture 阶段，先于页面内 handler；作为 ✕ 按钮之外的保底关闭途径）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // 主文档 HTTP 状态（>=400 → 美化错误页）
  useEffect(() => {
    if (!bridge) return
    return bridge.onExtPageStatus((e) => {
      if (e.url === url || e.url.startsWith(url.split('#')[0])) {
        setErr({ kind: 'http', code: e.code })
      }
    })
  }, [bridge, url])

  // webview 事件：导航后更新地址与可后退状态；加载失败展示错误页
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    const onNav = (ev: Event): void => {
      const d = ev as WebviewEventDetail
      if (d.url) setUrl(d.url)
      setErr(null)
      setCanBack(wv.canGoBack())
    }
    const onFail = (ev: Event): void => {
      const d = ev as WebviewEventDetail
      if (d.isMainFrame === false) return
      setErr({ kind: 'net', desc: d.errorDescription ?? '网络错误' })
    }
    wv.addEventListener('did-navigate', onNav)
    wv.addEventListener('did-fail-load', onFail)
    return () => {
      wv.removeEventListener('did-navigate', onNav)
      wv.removeEventListener('did-fail-load', onFail)
    }
    // 仅挂载期绑定事件
  }, [])

  const goBack = (): void => {
    const wv = webviewRef.current
    if (wv?.canGoBack()) {
      wv.goBack()
      setErr(null)
    }
  }

  return (
    <div className="ext-page">
      <div className="ep-toolbar">
        <button className="ep-btn" onClick={goBack} disabled={!canBack} title="后退">
          ←
        </button>
        <button className="ep-btn" onClick={onClose} title="关闭">
          ✕
        </button>
        <div className="ep-url" title={url}>
          {url}
        </div>
        <button
          className="ep-btn"
          onClick={() => void bridge?.openInSystemBrowser(url)}
          title="用系统浏览器打开"
        >
          ↗
        </button>
      </div>

      <div className="ep-body">
        {bridge ? (
          <webview
            ref={webviewRef}
            src={initialUrl}
            partition="persist:an-external"
            style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
          />
        ) : (
          <iframe src={initialUrl} title={url} className="ep-iframe" sandbox="allow-scripts" />
        )}

        {err && (
          <div className="ep-error">
            <div className="ep-error-icon">{err.kind === 'http' ? '🧭' : '🔌'}</div>
            <div className="ep-error-title">
              {err.kind === 'http' ? `HTTP ${err.code} — 页面不存在或无法访问` : '页面加载失败'}
            </div>
            <div className="ep-error-desc">
              {url}
              {err.kind === 'net' && err.desc ? `（${err.desc}）` : ''}
            </div>
            <div className="ep-error-ops">
              <button className="btn-ghost sm" onClick={goBack} disabled={!canBack}>
                ← 返回
              </button>
              <button
                className="btn-ghost sm"
                onClick={() => webviewRef.current?.reload?.()}
              >
                重新加载
              </button>
              <button className="btn-primary sm" onClick={onClose}>
                关闭
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
