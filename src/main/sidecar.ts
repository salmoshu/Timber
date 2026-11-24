// Go sidecar 生命周期管理：启动（自动分配端口 + 随机令牌）、就绪探测、退出清理、意外退出自动重启。
// windowsHide：Go 控制台程序在 Windows 下会弹 CMD 窗口，必须隐藏（用户误关会杀掉本地服务）。
import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { ApiInfo } from '@shared/types'

let child: ChildProcess | null = null
let quitting = false
let restartCount = 0
let lastToken = ''
let lastPort = 0

/** sidecar（重新）就绪后回调（主进程用它把新 base/token 推给渲染层缓存） */
let onReady: ((info: ApiInfo) => void) | null = null
export function setSidecarReadyListener(cb: (info: ApiInfo) => void): void {
  onReady = cb
}

export async function startSidecar(): Promise<ApiInfo> {
  const token = lastToken || randomBytes(16).toString('hex')
  lastToken = token
  const binary = process.platform === 'win32' ? 'timberd.exe' : 'timberd'
  const assetsDir = app.isPackaged ? join(process.resourcesPath, 'sidecar') : join(app.getAppPath(), 'sidecar', 'bin')
  const exe = join(assetsDir, binary)
  if (!existsSync(exe)) {
    throw new Error(`sidecar 二进制不存在：${exe}（请先执行 pnpm build:sidecar）`)
  }
  const dataDir = join(app.getPath('userData'), 'sidecar-data')

  // 优先复用上次端口（渲染层缓存了 base/token，减少失效）；被占用则回退随机端口
  const addr = lastPort > 0 ? `127.0.0.1:${lastPort}` : '127.0.0.1:0'
  child = spawn(exe, ['-addr', addr, '-token', token, '-data', dataDir, '-assets', assetsDir], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true
  })

  const info = await new Promise<ApiInfo>((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('sidecar 启动超时（10s）')), 10_000)
    child!.stdout!.on('data', (d) => {
      buf += d.toString()
      const m = buf.match(/TIMBERD_READY port=(\d+)/)
      if (m) {
        clearTimeout(timer)
        const port = parseInt(m[1], 10)
        lastPort = port
        resolve({ base: `http://127.0.0.1:${port}`, token })
      }
    })
    child!.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`sidecar 过早退出 code=${code}`))
    })
    child!.on('error', reject)
  })

  child.on('exit', (code) => {
    console.warn(`[sidecar] exited code=${code}`)
    child = null
    // 意外退出（非应用退出流程）：自动重启并把新地址推给渲染层
    if (!quitting && app.isReady()) {
      restartCount++
      if (restartCount > 5) {
        console.error('[sidecar] 重启次数过多，放弃自动恢复')
        return
      }
      setTimeout(() => {
        void startSidecar()
          .then((i) => {
            restartCount = 0
            onReady?.(i)
          })
          .catch((err) => console.error('[sidecar] 自动重启失败：', err))
      }, 800)
    }
  })

  return info
}

export function stopSidecar(): void {
  quitting = true
  try {
    child?.kill()
  } catch {
    /* ignore */
  }
  child = null
}
