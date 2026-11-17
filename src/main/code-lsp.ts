import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
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
  CodeLocation,
  CodePosition,
  CodeRange,
  CodeSymbol
} from '@shared/code'
import { codeLanguageForPath } from '@shared/code'

interface OpenDocument extends CodeDocumentRef {
  uri: string
  version: number
  content: string
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

function normalizeSymbols(rootPath: string, values: LspSymbol[] | null): CodeSymbol[] {
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
        path = ''
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
      children: value.children ? normalizeSymbols(rootPath, value.children) : undefined
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

class TypeScriptClient {
  private readonly documents = new Map<string, OpenDocument>()
  private closed = false

  private constructor(
    private readonly rootPath: string,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly connection: MessageConnection,
    private readonly onClosed: () => void
  ) {
    child.on('exit', () => {
      this.closed = true
      connection.dispose()
      onClosed()
    })
    child.stderr.on('data', (chunk) => console.warn(`[code-lsp] ${String(chunk).trim()}`))
    connection.onError(([error]) => console.error('[code-lsp]', error.message))
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

  static async create(rootPath: string, cliPath: string, onClosed: () => void): Promise<TypeScriptClient> {
    const child = spawn(process.execPath, [cliPath, '--stdio'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin))
    const client = new TypeScriptClient(rootPath, child, connection, onClosed)
    try {
      await withDeadline(connection.sendRequest('initialize', {
        processId: process.pid,
        clientInfo: { name: 'Timber' },
        rootUri: pathToFileURL(rootPath).href,
        workspaceFolders: [{ uri: pathToFileURL(rootPath).href, name: 'Timber Project' }],
        capabilities: {
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
      }), 20_000, 'TypeScript 语言服务启动超时')
      connection.sendNotification('initialized', {})
      return client
    } catch (error) {
      child.kill()
      connection.dispose()
      throw error
    }
  }

  syncDocument(input: CodeDocumentInput): OpenDocument {
    if (this.closed) throw new Error('TypeScript 语言服务已停止')
    const absolute = absoluteCodePath(this.rootPath, input.path)
    const uri = pathToFileURL(absolute).href
    const previous = this.documents.get(uri)
    if (previous?.content === input.content && previous.languageId === input.languageId) return previous
    const document: OpenDocument = {
      rootPath: this.rootPath,
      path: input.path,
      languageId: input.languageId,
      uri,
      content: input.content,
      version: (previous?.version ?? 0) + 1
    }
    this.documents.set(uri, document)
    if (previous) {
      this.connection.sendNotification('textDocument/didChange', {
        textDocument: { uri, version: document.version },
        contentChanges: [{ text: input.content }]
      })
    } else {
      this.connection.sendNotification('textDocument/didOpen', {
        textDocument: { uri, languageId: input.languageId, version: document.version, text: input.content }
      })
    }
    return document
  }

  async requestLocations(method: string, document: CodeDocumentRef, position: CodePosition, extra: Record<string, unknown> = {}): Promise<CodeLocation[]> {
    const open = this.documents.get(pathToFileURL(absoluteCodePath(this.rootPath, document.path)).href)
    if (!open) throw new Error('代码文档尚未同步到语言服务')
    const result = await withDeadline(this.connection.sendRequest(method, {
      textDocument: { uri: open.uri },
      position,
      ...extra
    }), 15_000, '语言服务请求超时') as LspLocation | LspLocationLink | Array<LspLocation | LspLocationLink> | null
    return normalizeLocations(this.rootPath, result)
  }

  async sourceDefinition(document: CodeDocumentRef, position: CodePosition): Promise<CodeLocation[]> {
    const open = this.documents.get(pathToFileURL(absoluteCodePath(this.rootPath, document.path)).href)
    if (!open) throw new Error('代码文档尚未同步到语言服务')
    const result = await withDeadline(this.connection.sendRequest('workspace/executeCommand', {
      command: '_typescript.goToSourceDefinition',
      arguments: [open.uri, position]
    }), 15_000, '源码定义请求超时') as LspLocation[] | null
    return normalizeLocations(this.rootPath, result)
  }

  async hover(document: CodeDocumentRef, position: CodePosition): Promise<CodeHoverResult | null> {
    const open = this.documents.get(pathToFileURL(absoluteCodePath(this.rootPath, document.path)).href)
    if (!open) throw new Error('代码文档尚未同步到语言服务')
    const result = await withDeadline(this.connection.sendRequest('textDocument/hover', {
      textDocument: { uri: open.uri },
      position
    }), 10_000, 'Hover 请求超时') as LspHover | null
    if (!result) return null
    const contents = hoverText(result.contents)
    return contents.length ? { contents, range: result.range } : null
  }

  async documentSymbols(document: CodeDocumentRef): Promise<CodeSymbol[]> {
    const open = this.documents.get(pathToFileURL(absoluteCodePath(this.rootPath, document.path)).href)
    if (!open) throw new Error('代码文档尚未同步到语言服务')
    const result = await withDeadline(this.connection.sendRequest('textDocument/documentSymbol', {
      textDocument: { uri: open.uri }
    }), 15_000, '文档大纲请求超时') as LspSymbol[] | null
    return normalizeSymbols(this.rootPath, result).map((symbol) => ({ ...symbol, path: open.path }))
  }

  async workspaceSymbols(query: string): Promise<CodeSymbol[]> {
    const result = await withDeadline(this.connection.sendRequest('workspace/symbol', { query }), 15_000, '工作区符号请求超时') as LspSymbol[] | null
    return normalizeSymbols(this.rootPath, result)
  }

  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      await withDeadline(this.connection.sendRequest('shutdown'), 1_500, '语言服务关闭超时')
      this.connection.sendNotification('exit')
    } catch {
      this.child.kill()
    } finally {
      this.connection.dispose()
      setTimeout(() => { if (this.child.exitCode === null) this.child.kill() }, 500).unref()
    }
  }
}

export class CodeLanguageService {
  private readonly clients = new Map<string, Promise<TypeScriptClient>>()

  constructor(private readonly cliPath: string) {}

  private client(rootPath: string): Promise<TypeScriptClient> {
    const root = resolve(rootPath)
    let client = this.clients.get(root)
    if (!client) {
      client = TypeScriptClient.create(root, this.cliPath, () => this.clients.delete(root))
      this.clients.set(root, client)
      client.catch(() => this.clients.delete(root)).catch(() => undefined)
    }
    return client
  }

  async syncDocument(input: CodeDocumentInput): Promise<void> {
    if (codeLanguageForPath(input.path) !== input.languageId) throw new Error('代码语言与文件扩展名不匹配')
    const info = await stat(absoluteCodePath(input.rootPath, input.path))
    if (!info.isFile()) throw new Error('代码文件不存在')
    const client = await this.client(input.rootPath)
    client.syncDocument(input)
  }

  async definition(input: CodeDocumentRef, position: CodePosition): Promise<CodeLocation[]> {
    const client = await this.client(input.rootPath)
    return this.withPreviews(input.rootPath, await client.sourceDefinition(input, position))
  }

  async references(input: CodeDocumentRef, position: CodePosition): Promise<CodeLocation[]> {
    const client = await this.client(input.rootPath)
    const locations = await client.requestLocations('textDocument/references', input, position, {
      context: { includeDeclaration: true }
    })
    return this.withPreviews(input.rootPath, locations.slice(0, 500))
  }

  async hover(input: CodeDocumentRef, position: CodePosition): Promise<CodeHoverResult | null> {
    const client = await this.client(input.rootPath)
    return client.hover(input, position)
  }

  async documentSymbols(input: CodeDocumentRef): Promise<CodeSymbol[]> {
    const client = await this.client(input.rootPath)
    return client.documentSymbols(input)
  }

  async workspaceSymbols(rootPath: string, query: string): Promise<CodeSymbol[]> {
    const client = await this.client(rootPath)
    return client.workspaceSymbols(query)
  }

  private async withPreviews(rootPath: string, locations: CodeLocation[]): Promise<CodeLocation[]> {
    const cache = new Map<string, Promise<string[] | null>>()
    return Promise.all(locations.map(async (location) => {
      let lines = cache.get(location.path)
      if (!lines) {
        lines = readFile(absoluteCodePath(rootPath, location.path), 'utf8')
          .then((content) => content.length <= 2_000_000 ? content.split(/\r?\n/) : null)
          .catch(() => null)
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
