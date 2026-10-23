// archify 渲染服务：architecture 快照 HTML 与 delta 对比 HTML 的主进程生成与缓存。
// 渲染器为 vendor/archify 下的 ESM 脚本，经 ELECTRON_RUN_AS_NODE=1 用 Electron 内嵌 Node 执行；
// delta 合成直接动态 import 同目录的 architecture-delta.mjs。
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface ArchResult {
  ok: boolean
  html?: string
  receipt?: unknown
  error?: string
}

// vendor/archify 根目录：dev 取仓库内，打包后取 extraResources 拷贝位置
const vendorBase = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'vendor', 'archify')

/** 缓存目录：<userData>/arch */
function cacheDir(): string {
  const dir = join(app.getPath('userData'), 'arch')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 缓存键哈希：输入除 cacheKey 外含 spec 内容 —— spec 任何变化自动生成新缓存文件 */
function keyHash(cacheKey: string, specJson: string): string {
  return createHash('sha256')
    .update(cacheKey + '\n' + specJson)
    .digest('hex')
}

/** tmp+rename 原子写，避免渲染进程读到半截文件 */
function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, content, 'utf-8')
  renameSync(tmp, path)
}

/** 渲染 architecture spec 为自包含 HTML；缓存键含 spec 内容（spec 变化即失效重渲） */
export async function renderArchHtml(specJson: string, cacheKey: string): Promise<ArchResult> {
  // 迭代架构仅持久化当前 spec；渲染工作目录在完成后清理，不积累旧画布。
  if (cacheKey.startsWith('current:')) {
    const dir = mkdtempSync(join(cacheDir(), 'current-'))
    try { return await renderArchHtmlIn(specJson, cacheKey, dir) }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }
  return renderArchHtmlIn(specJson, cacheKey, cacheDir())
}

async function renderArchHtmlIn(specJson: string, cacheKey: string, dir: string): Promise<ArchResult> {
  try {
    const hash = keyHash(cacheKey, specJson)
    const outPath = join(dir, `${hash}.html`)
    if (existsSync(outPath)) {
      return { ok: true, html: readFileSync(outPath, 'utf-8') }
    }
    const specPath = join(dir, `${hash}.spec.json`)
    // vendor 渲染器对带 sources/meta.repository 的 spec 强制 --repo-root 证据校验（要求 git 顶层
    // 目录 + origin 匹配），对本地项目过于苛刻；渲染前剥离证据字段（不影响图形内容）
    const spec = JSON.parse(specJson) as {
      meta?: { repository?: unknown; output?: string }
      components?: Array<{ sources?: unknown }>
    }
    if (spec.meta) {
      delete spec.meta.repository
      // 渲染器 schema 要求 meta.output；契约 spec 未含，补默认值（实际输出以 argv[3] 为准）
      spec.meta.output ??= 'architecture.html'
    }
    for (const c of spec.components ?? []) delete c.sources
    writeAtomic(specPath, JSON.stringify(spec))

    const script = join(vendorBase, 'renderers', 'architecture', 'render-architecture.mjs')
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [script, specPath, outPath], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ARCHIFY_QUALITY_PROFILE: 'showcase' },
        windowsHide: true
      })
      let stderr = ''
      child.stderr?.on('data', (d) => {
        stderr += d.toString()
      })
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('archify 渲染超时（60s）'))
      }, 60_000)
      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        if (code === 0 && existsSync(outPath)) resolve()
        else reject(new Error(`archify 渲染失败 code=${code}：${stderr.trim()}`))
      })
    })
    return { ok: true, html: readFileSync(outPath, 'utf-8') }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) }
  }
}

/** 渲染并缓存 base/head 快照，再经 architecture-delta.mjs 合成对比 HTML（缓存键含两份 spec 内容） */
export async function compareArchDelta(
  baseJson: string,
  headJson: string,
  cacheKey: string
): Promise<ArchResult> {
  try {
    const dir = cacheDir()
    const hash = keyHash(cacheKey, baseJson + '\n' + headJson)
    const outPath = join(dir, `${hash}-delta.html`)
    if (existsSync(outPath)) {
      const receiptPath = join(dir, `${hash}-delta.receipt.json`)
      const receipt = existsSync(receiptPath)
        ? JSON.parse(readFileSync(receiptPath, 'utf-8'))
        : undefined
      return { ok: true, html: readFileSync(outPath, 'utf-8'), receipt }
    }

    // 动态 import：模块路径在运行时由打包/dev 双模式决定，无法静态引用（打包后位于 resources 下）
    const mod = (await import(
      pathToFileURL(join(vendorBase, 'delta', 'architecture-delta.mjs')).href
    )) as {
      compareArchitecture: (base: unknown, head: unknown, evidence?: unknown) => unknown
      extractArchitectureSvg: (html: string) => string
      extractArtifactCss: (html: string) => string
      buildDeltaSvg: (baseSvg: string, headSvg: string, receipt: unknown) => string
      renderArchitectureDeltaHtml: (args: {
        receipt: unknown
        baseSvg: string
        deltaSvg: string
        headSvg: string
        baseHtml?: string
        headHtml?: string
        artifactCss: string
      }) => string
    }

    const base = JSON.parse(baseJson)
    const head = JSON.parse(headJson)
    const receipt = mod.compareArchitecture(base, head, {})

    const baseRes = await renderArchHtml(baseJson, `${cacheKey}:base`)
    if (!baseRes.ok || baseRes.html === undefined) {
      return { ok: false, error: baseRes.error ?? 'base 架构渲染失败' }
    }
    const headRes = await renderArchHtml(headJson, `${cacheKey}:head`)
    if (!headRes.ok || headRes.html === undefined) {
      return { ok: false, error: headRes.error ?? 'head 架构渲染失败' }
    }

    const baseSvg = mod.extractArchitectureSvg(baseRes.html)
    const headSvg = mod.extractArchitectureSvg(headRes.html)
    const artifactCss = mod.extractArtifactCss(baseRes.html)
    const deltaSvg = mod.buildDeltaSvg(baseSvg, headSvg, receipt)
    const html = mod.renderArchitectureDeltaHtml({
      receipt,
      baseSvg,
      deltaSvg,
      headSvg,
      baseHtml: baseRes.html,
      headHtml: headRes.html,
      artifactCss
    })

    writeAtomic(outPath, html)
    writeAtomic(join(dir, `${hash}-delta.receipt.json`), JSON.stringify(receipt))
    return { ok: true, html, receipt }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) }
  }
}
