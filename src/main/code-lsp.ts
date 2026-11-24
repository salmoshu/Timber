import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { readFile, rm, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection
} from 'vscode-jsonrpc/node.js'
import type {
  CodeDocumentInput,
  CodeDocumentRef,
  CodeHoverResult,
  CodeLanguageId,
  CodeLocation,
  CodePosition,
  CodeRange,
  CodeSymbol
} from '@shared/code'
import { codeLanguageForPath, usesClangd } from '@shared/code'
import { temporaryCompilationDatabase } from './clangd-workspace'

interface OpenDocument extends CodeDocumentRef {
  uri: string
  version: number
  content: string
}

interface ServerLaunch {
  name: string
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
  cwd?: string
}

interface LspLocation {
  uri: string
  range: CodeRange
}

interface LspLocationLink {
  targetUri: string
  targetRange: CodeRange
  targetSelectionRange: CodeRange
}

interface LspSymbol {
  name: string
  detail?: string
  kind: number
  containerName?: string
  range?: CodeRange
  selectionRange?: CodeRange
  children?: LspSymbol[]
  location?: {
    uri: string
    range: CodeRange
  }
}

interface LspHover {
  contents: unknown
  range?: CodeRange
}

function insideRoot(rootPath: string, absolutePath: string): boolean {
  const rel = relative(rootPath, absolutePath)
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
}

export function absoluteCodePath(rootPath: string, path: string): string {
  const root = resolve(rootPath)
  const absolute = resolve(root, path)
  if (!insideRoot(root, absolute)) throw new Error(`代码文件超出项目目录：${path}`)
  return absolute
}

export function relativeCodePath(rootPath: string, uri: string): string {
  const absolute = fileURLToPath(uri)
  const root = resolve(rootPath)
  if (!insideRoot(root, absolute)) throw new Error('语言服务返回了项目目录外的位置')
  return relative(root, absolute).split(sep).join('/')
}

function emptyRange(): CodeRange {
  return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
}

function normalizeLocations(rootPath: string, value: LspLocation | LspLocationLink | Array<LspLocation | LspLocationLink> | null): CodeLocation[] {
  const items = value === null ? [] : Array.isArray(value) ? value : [value]
  const locations: CodeLocation[] = []
  for (const item of items) {
    try {
      if ('uri' in item) locations.push({ path: relativeCodePath(rootPath, item.uri), range: item.range })
      else locations.push({ path: relativeCodePath(rootPath, item.targetUri), range: item.targetSelectionRange ?? item.targetRange })
    } catch {
      // Ignore definitions in files outside the imported project.
    }
  }
  return locations
}

function hoverText(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : []
  if (Array.isArray(value)) return value.flatMap(hoverText)
  if (typeof value === 'object' && value !== null && 'value' in value) {
    const text = String((value as { value: unknown }).value ?? '')
    if (!text) return []
    return 'language' in value && typeof (value as { language?: unknown }).language === 'string'
      ? [`\`\`\`${String((value as { language: string }).language)}\n${text}\n\`\`\``]
      : [text]
  }
  return []
}

function normalizeSymbols(rootPath: string, values: LspSymbol[] | null, documentPath = ''): CodeSymbol[] {
  if (!values) return []
  const result: CodeSymbol[] = []
  for (const value of values) {
    let path: string
    let range: CodeRange
    let selectionRange: CodeRange
    try {
      if (value.location) {
        path = relativeCodePath(rootPath, value.location.uri)
        range = value.location.range
        selectionRange = value.range ?? value.location.range
      } else {
        path = documentPath
        range = value.range ?? emptyRange()
        selectionRange = value.selectionRange ?? range
      }
    } catch {
      continue
    }
    result.push({
      name: value.name,
      detail: value.detail ?? '',
      kind: value.kind,
      path,
      range,
      selectionRange,
      containerName: value.containerName,
      children: value.children ? normalizeSymbols(rootPath, value.children, path) : undefined
    })
  }
  return result
}

function withDeadline<T>(promise: Thenable<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(message)), milliseconds)
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value) },
      (error) => { clearTimeout(timer); rejectPromise(error instanceof Error ? error : new Error(String(error))) }
    )
  })
}

class LspClient {
  private readonly documents = new Map<string, OpenDocument>()
  private readonly exited: Promise<void>
  private closed = false
  private shutdown: Promise<void> | undefined

  private constructor(
    private readonly rootPath: string,
    private readonly name: string,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly connection: MessageConnection,
    onClosed: () => void
  ) {
    this.exited = new Promise((resolveExit) => {
      child.once('close', () => {
        this.closed = true
        this.documents.clear()
        connection.dispose()
        onClosed()
        resolveExit()
      })
    })
    child.on('error', (error) => console.warn(`[${name}] ${error.message}`))
    child.stderr.on('data', (chunk) => console.warn(`[${name}] ${String(chunk).trim()}`))
    connection.onError(([error]) => console.error(`[${name}]`, error.message))
    connection.onRequest('workspace/configuration', (params: { items: Array<{ section?: string }> }) =>
      params.items.map(() => ({}))
    )
    connection.onRequest('client/registerCapability', () => null)
    connection.onRequest('client/unregisterCapability', () => null)
    connection.onRequest('window/workDoneProgress/create', () => null)
    connection.onRequest('workspace/workspaceFolders', () => [{ uri: pathToFileURL(rootPath).href, name: 'Timber Project' }])
    connection.onNotification('window/logMessage', () => undefined)
    connection.onNotification('window/showMessage', () => undefined)
    connection.listen()
  }

  static async create(rootPath: string, launch: ServerLaunch, onClosed: () => void): Promise<LspClient> {
    const child = spawn(launch.command, launch.args, {
      env: launch.env,
      cwd: launch.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    await once(child, 'spawn')
    const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin))
    const client = new LspClient(rootPath, launch.name, child, connection, onClosed)
    try {
      await withDeadline(connection.sendRequest('initialize', {
        processId: process.pid,
        clientInfo: { name: 'Timber' },
        rootUri: pathToFileURL(rootPath).href,
        workspaceFolders: [{ uri: pathToFileURL(rootPath).href, name: 'Timber Project' }],
        capabilities: {
          general: { positionEncodings: ['utf-16'] },
          workspace: {
            configuration: true,
            workspaceFolders: true,
            symbol: { dynamicRegistration: false }
          },
          textDocument: {
            definition: { linkSupport: true },
            references: {},
            hover: { contentFormat: ['markdown', 'plaintext'] },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            publishDiagnostics: { relatedInformation: true, versionSupport: true }
          },
          window: { workDoneProgress: true }
        }
      }), 20_000, `${launch.name} 语言服务启动超时`)
      await connection.sendNotification('initialized', {})
      return client
    } catch (error) {
      child.kill()
      await client.exited
      throw error
    }
  }

  openDocument(path: string): OpenDocument | undefined {
    return this.documents.get(pathToFileURL(absoluteCodePath(this.rootPath, path)).href)
  }

  private document(path: string): OpenDocument {
    const open = this.openDocument(path)
    if (!open) throw new Error('代码文档尚未同步到语言服务')
    return open
  }

  async syncDocument(input: CodeDocumentInput): Promise<void> {
    if (this.closed) throw new Error(`${this.name} 语言服务已停止`)
    const uri = pathToFileURL(absoluteCodePath(this.rootPath, input.path)).href
    const previous = this.documents.get(uri)
    // Refresh recency when revisiting a tab. Monaco only needs a bounded set of open documents.
    this.documents.delete(uri)
    if (previous?.content === input.content && previous.languageId === input.languageId) {
      this.documents.set(uri, previous)
      return
    }
    const document: OpenDocument = {
      rootPath: this.rootPath,
      path: input.path,
      languageId: input.languageId,
      uri,
      content: input.content,
      version: (previous?.version ?? 0) + 1
    }
    this.documents.set(uri, document)
    const notification = previous
      ? this.connection.sendNotification('textDocument/didChange', {
          textDocument: { uri, version: document.version },
          contentChanges: [{ text: input.content }]
        })
      : this.connection.sendNotification('textDocument/didOpen', {
          textDocument: { uri, languageId: input.languageId, version: document.version, text: input.content }
        })
    if (this.documents.size > 24) {
      const oldest = this.documents.keys().next().value!
      this.documents.delete(oldest)
      await Promise.all([notification, this.connection.sendNotification('textDocument/didClose', { textDocument: { uri: oldest } })])
    } else {
      await notification
    }
  }

  async requestLocations(method: string, document: CodeDocumentRef, position: CodePosition, extra: Record<string, unknown> = {}): Promise<CodeLocation[]> {
    const open = this.document(document.path)
    const result = await withDeadline(this.connection.sendRequest(method, {
      textDocument: { uri: open.uri },
      position,
      ...extra
    }), 15_000, '语言服务请求超时') as LspLocation | LspLocationLink | Array<LspLocation | LspLocationLink> | null
    return normalizeLocations(this.rootPath, result)
  }

  async sourceDefinition(document: CodeDocumentRef, position: CodePosition): Promise<CodeLocation[]> {
    const open = this.document(document.path)
    const result = await withDeadline(this.connection.sendRequest('workspace/executeCommand', {
      command: '_typescript.goToSourceDefinition',
      arguments: [open.uri, position]
    }), 15_000, '源码定义请求超时') as LspLocation[] | null
    return normalizeLocations(this.rootPath, result)
  }

  async hover(document: CodeDocumentRef, position: CodePosition): Promise<CodeHoverResult | null> {
    const open = this.document(document.path)
    const result = await withDeadline(this.connection.sendRequest('textDocument/hover', {
      textDocument: { uri: open.uri },
      position
    }), 10_000, 'Hover 请求超时') as LspHover | null
    if (!result) return null
    const contents = hoverText(result.contents)
    return contents.length ? { contents, range: result.range } : null
  }

  async documentSymbols(document: CodeDocumentRef): Promise<CodeSymbol[]> {
    const open = this.document(document.path)
    const result = await withDeadline(this.connection.sendRequest('textDocument/documentSymbol', {
      textDocument: { uri: open.uri }
    }), 15_000, '文档大纲请求超时') as LspSymbol[] | null
    return normalizeSymbols(this.rootPath, result, open.path)
  }

  async workspaceSymbols(query: string): Promise<CodeSymbol[]> {
    const result = await withDeadline(this.connection.sendRequest('workspace/symbol', { query }), 15_000, '工作区符号请求超时') as LspSymbol[] | null
    return normalizeSymbols(this.rootPath, result)
  }

  async switchSourceHeader(document: CodeDocumentRef): Promise<CodeLocation | null> {
    const uri = await withDeadline(this.connection.sendRequest<string>('textDocument/switchSourceHeader', {
      uri: this.document(document.path).uri
    }), 10_000, '源文件与头文件切换超时')
    return uri ? normalizeLocations(this.rootPath, { uri, range: emptyRange() })[0] ?? null : null
  }

  dispose(): Promise<void> {
    return this.shutdown ??= this.stop()
  }

  private async stop(): Promise<void> {
    if (this.closed) return this.exited
    try {
      await withDeadline(this.connection.sendRequest('shutdown'), 1_500, '语言服务关闭超时')
      await this.connection.sendNotification('exit')
    } catch {
      this.child.kill()
    } finally {
      const timer = setTimeout(() => this.child.kill(), 500)
      await this.exited
      clearTimeout(timer)
    }
  }
}

interface CodeServiceOptions {
  typescriptPath?: string
  clangdPath?: string
  queryDriver?: string
}

export class CodeLanguageService {
  private readonly clients = new Map<string, Promise<LspClient>>()

  constructor(private readonly options: CodeServiceOptions) {}

  private client(rootPath: string, languageId?: CodeLanguageId): Promise<LspClient> {
    const root = resolve(rootPath)
    const clangd = usesClangd(languageId)
    const key = `${clangd ? 'clangd' : 'typescript'}:${root}`
    const existing = this.clients.get(key)
    if (existing) return existing

    const client = Promise.resolve().then(() => this.startClient(root, clangd, () => {
      if (this.clients.get(key) === client) this.clients.delete(key)
    }))
    this.clients.set(key, client)
    return client
  }

  private async startClient(root: string, clangd: boolean, onClosed: () => void): Promise<LspClient> {
    let temporary: string | undefined
    const cleanup = (): void => {
      if (temporary) {
        void rm(temporary, { recursive: true, force: true }).catch(() => undefined)
        temporary = undefined
      }
      onClosed()
    }
    try {
      if (clangd) {
        const { clangdPath, queryDriver } = this.options
        if (!clangdPath) throw new Error('未找到 clangd。可运行 pnpm build:code-tools，或通过 TIMBER_CLANGD_PATH 指定 clangd 的绝对路径。')
        temporary = await temporaryCompilationDatabase(root)
        const args = ['--background-index', '--enable-config', '--log=error', '-j=2']
        if (temporary) args.push(`--compile-commands-dir=${temporary}`)
        if (queryDriver) args.push(`--query-driver=${queryDriver}`)
        return await LspClient.create(root, { name: 'clangd', command: clangdPath, args, cwd: root }, cleanup)
      }
      const { typescriptPath } = this.options
      if (!typescriptPath) throw new Error('TypeScript 语言服务资源缺失，请先执行 pnpm build:code-tools')
      return await LspClient.create(root, {
        name: 'TypeScript',
        command: process.execPath,
        args: [typescriptPath, '--stdio'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      }, cleanup)
    } catch (error) {
      cleanup()
      throw error
    }
  }

  async syncDocument(input: CodeDocumentInput): Promise<void> {
    if (codeLanguageForPath(input.path) !== input.languageId) throw new Error('代码语言与文件扩展名不匹配')
    const info = await stat(absoluteCodePath(input.rootPath, input.path))
    if (!info.isFile()) throw new Error('代码文件不存在')
    const client = await this.client(input.rootPath, input.languageId)
    await client.syncDocument(input)
  }

  private async documentClient(input: CodeDocumentRef): Promise<LspClient> {
    if (codeLanguageForPath(input.path) !== input.languageId) throw new Error('代码语言与文件扩展名不匹配')
    const absolute = absoluteCodePath(input.rootPath, input.path)
    const client = await this.client(input.rootPath, input.languageId)
    // An evicted document or a restarted server can be resynced from this read-only workspace.
    if (!client.openDocument(input.path)) {
      const content = await readFile(absolute, 'utf8')
      if (!client.openDocument(input.path)) await client.syncDocument({ ...input, content })
    }
    return client
  }

  async definition(input: CodeDocumentRef, position: CodePosition): Promise<CodeLocation[]> {
    const client = await this.documentClient(input)
    const locations = usesClangd(input.languageId)
      ? await client.requestLocations('textDocument/definition', input, position)
      : await client.sourceDefinition(input, position)
    return this.withPreviews(input.rootPath, client, locations)
  }

  async references(input: CodeDocumentRef, position: CodePosition): Promise<CodeLocation[]> {
    const client = await this.documentClient(input)
    const locations = await client.requestLocations('textDocument/references', input, position, {
      context: { includeDeclaration: true }
    })
    return this.withPreviews(input.rootPath, client, locations.slice(0, 500))
  }

  async hover(input: CodeDocumentRef, position: CodePosition): Promise<CodeHoverResult | null> {
    return (await this.documentClient(input)).hover(input, position)
  }

  async documentSymbols(input: CodeDocumentRef): Promise<CodeSymbol[]> {
    return (await this.documentClient(input)).documentSymbols(input)
  }

  async workspaceSymbols(rootPath: string, query: string, languageId?: CodeLanguageId): Promise<CodeSymbol[]> {
    return (await this.client(rootPath, languageId)).workspaceSymbols(query)
  }

  async switchSourceHeader(input: CodeDocumentRef): Promise<CodeLocation | null> {
    if (!usesClangd(input.languageId)) return null
    return (await this.documentClient(input)).switchSourceHeader(input)
  }

  private async withPreviews(rootPath: string, client: LspClient, locations: CodeLocation[]): Promise<CodeLocation[]> {
    const cache = new Map<string, Promise<string[] | null>>()
    const readLines = async (path: string): Promise<string[] | null> => {
      const open = client.openDocument(path)
      if (open) return open.content.split(/\r?\n/)
      const absolute = absoluteCodePath(rootPath, path)
      const info = await stat(absolute)
      return info.isFile() && info.size <= 2_000_000 ? (await readFile(absolute, 'utf8')).split(/\r?\n/) : null
    }
    return Promise.all(locations.map(async (location) => {
      let lines = cache.get(location.path)
      if (!lines) {
        lines = readLines(location.path).catch(() => null)
        cache.set(location.path, lines)
      }
      const line = (await lines)?.[location.range.start.line]?.trim()
      return { ...location, preview: line }
    }))
  }

  async dispose(): Promise<void> {
    const clients = [...this.clients.values()]
    this.clients.clear()
    await Promise.allSettled(clients.map(async (client) => (await client).dispose()))
  }
}
