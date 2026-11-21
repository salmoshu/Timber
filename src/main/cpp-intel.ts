import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import type { CodeHoverResult, CodeLocation, CodePosition, CodeRange, CodeSymbol } from '@shared/code'

/** 轻量 C/C++ 索引（v0.8.1）：不依赖 clangd，扫描项目内声明/定义，
 *  为 Monaco 提供定义跳转、引用查找、悬停与符号大纲。覆盖 C、C++、
 *  Objective-C 及常见头文件；宏、命名空间、类/结构体/枚举、typedef 与函数。 */

const CPP_EXTENSIONS = new Set([
  '.c', '.h', '.cc', '.cp', '.cpp', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h++',
  '.ipp', '.inl', '.tpp', '.txx', '.cu', '.cuh', '.m', '.mm'
])

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'out', 'build', 'target', 'release', 'release-ai-fix',
  'cmake-build-debug', 'cmake-build-release', 'cmakefiles', 'debug', 'obj', 'bin',
  'coverage', '.vs', '.idea', '.vscode', '.git', '.timber', '.cache'
])

const MAX_FILES = 4000
const MAX_FILE_BYTES = 1024 * 1024
const MAX_REFERENCES = 500

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'alignof', 'decltype', 'typeof',
  'static_assert', 'new', 'delete', 'throw', 'case', 'do', 'else', 'try', 'defined', 'noexcept',
  'requires', 'concept', 'template', 'using', 'namespace', 'class', 'struct', 'union', 'enum',
  'typedef', 'constexpr', 'consteval', 'constinit', 'override', 'final', 'explicit', 'virtual',
  'static', 'inline', 'friend', 'extern', 'mutable', 'volatile', 'register', 'auto', 'void', 'bool',
  'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned', 'wchar_t', 'char8_t',
  'char16_t', 'char32_t', 'operator', 'this', 'nullptr', 'true', 'false'
])

interface IndexedSymbol {
  name: string
  word: string
  kind: number
  detail: string
  path: string
  range: CodeRange
  selectionRange: CodeRange
  containerName?: string
}

interface IndexedFile {
  path: string
  content: string
  masked: string
  lineStarts: number[]
  symbols: IndexedSymbol[]
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

function fileExtension(name: string): string {
  return extname(name).toLowerCase()
}

function lineStartsOf(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return starts
}

function positionAt(starts: number[], index: number): CodePosition {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= index) lo = mid
    else hi = mid - 1
  }
  return { line: lo, character: index - starts[lo] }
}

function rangeAt(starts: number[], start: number, end: number): CodeRange {
  return { start: positionAt(starts, start), end: positionAt(starts, end) }
}

function lineRangeAt(content: string, starts: number[], index: number): CodeRange {
  const line = positionAt(starts, index).line
  const end = line + 1 < starts.length ? starts[line + 1] - 1 : content.length
  return {
    start: { line, character: 0 },
    end: { line, character: Math.max(0, end - starts[line]) }
  }
}

/** 把注释和字符串替换为空格（保留换行与下标），避免在它们内部误匹配标识符 */
function maskCode(source: string): string {
  const out = source.split('')
  let state: 'code' | 'line' | 'block' | 'single' | 'double' = 'code'
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    const next = source[i + 1]
    if (state === 'code') {
      if (char === '/' && next === '/') {
        out[i] = ' '
        out[i + 1] = ' '
        i++
        state = 'line'
      } else if (char === '/' && next === '*') {
        out[i] = ' '
        out[i + 1] = ' '
        i++
        state = 'block'
      } else if (char === '\'') {
        out[i] = ' '
        state = 'single'
      } else if (char === '"') {
        out[i] = ' '
        state = 'double'
      }
      continue
    }
    if (state === 'line') {
      if (char === '\n') state = 'code'
      else out[i] = ' '
      continue
    }
    if (state === 'block') {
      if (char === '*' && next === '/') {
        out[i] = ' '
        out[i + 1] = ' '
        i++
        state = 'code'
      } else if (char !== '\n') {
        out[i] = ' '
      }
      continue
    }
    // string literal
    if (char === '\\') {
      out[i] = ' '
      if (next !== undefined && next !== '\n') {
        out[i + 1] = ' '
        i++
      }
    } else if ((state === 'single' && char === '\'') || (state === 'double' && char === '"')) {
      out[i] = ' '
      state = 'code'
    } else {
      if (char !== '\n') out[i] = ' '
      else state = 'code'
    }
  }
  return out.join('')
}

function indexFile(path: string, content: string): IndexedFile {
  const lineStarts = lineStartsOf(content)
  const masked = maskCode(content)
  const symbols: IndexedSymbol[] = []
  const seen = new Set<string>()

  const add = (name: string, kind: number, start: number, end: number, containerName?: string): void => {
    if (!name || start < 0 || end <= start) return
    if (KEYWORDS.has(name)) return
    // 去掉限定符用于按短名查找；完整名也保留，便于方法跳转
    const word = name.split('::').pop() ?? name
    if (!word || KEYWORDS.has(word)) return
    const key = `${name}:${start}`
    if (seen.has(key)) return
    seen.add(key)
    const line = positionAt(lineStarts, start).line
    const lineEnd = line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : content.length
    const detail = content.slice(lineStarts[line], lineEnd).trim().slice(0, 240)
    symbols.push({
      name,
      word,
      kind,
      detail,
      path,
      range: lineRangeAt(content, lineStarts, start),
      selectionRange: rangeAt(lineStarts, start, end),
      containerName
    })
  }

  // 预处理宏
  const defineRe = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)/gm
  for (let match = defineRe.exec(masked); match; match = defineRe.exec(masked)) {
    const start = match.index + match[0].lastIndexOf(match[1])
    add(match[1], 14, start, start + match[1].length)
  }

  // 命名空间
  const namespaceRe = /\bnamespace[ \t]+([A-Za-z_]\w*)/g
  for (let match = namespaceRe.exec(masked); match; match = namespaceRe.exec(masked)) {
    const start = match.index + match[0].lastIndexOf(match[1])
    add(match[1], 3, start, start + match[1].length)
  }

  // 枚举（先于 class，避免 enum class X 被识别成 class X）
  const enumRe = /\benum(?:[ \t]+class)?[ \t]+([A-Za-z_]\w*)/g
  for (let match = enumRe.exec(masked); match; match = enumRe.exec(masked)) {
    const start = match.index + match[0].lastIndexOf(match[1])
    add(match[1], 10, start, start + match[1].length)
  }

  // 类 / 结构体 / 联合体
  const typeRe = /\b(class|struct|union)[ \t]+([A-Za-z_]\w*)/g
  for (let match = typeRe.exec(masked); match; match = typeRe.exec(masked)) {
    const prefix = masked.slice(Math.max(0, match.index - 8), match.index)
    if (/enum[ \t]+$/.test(prefix)) continue
    const start = match.index + match[0].lastIndexOf(match[2])
    add(match[2], match[1] === 'class' ? 5 : 23, start, start + match[2].length)
  }

  // typedef / using 别名
  const typedefRe = /^[ \t]*typedef\b[^;{}]*?\b([A-Za-z_]\w*)[ \t]*;/gm
  for (let match = typedefRe.exec(masked); match; match = typedefRe.exec(masked)) {
    const start = match.index + match[0].lastIndexOf(match[1])
    add(match[1], 26, start, start + match[1].length)
  }
  const usingRe = /\busing[ \t]+([A-Za-z_]\w*)[ \t]*=/g
  for (let match = usingRe.exec(masked); match; match = usingRe.exec(masked)) {
    const start = match.index + match[0].lastIndexOf(match[1])
    add(match[1], 26, start, start + match[1].length)
  }

  // 函数 / 方法（标识符后紧跟括号；跳过控制关键字与预处理行）。
  // 只接受“类型 + 名称(”形式，避免把调用点也当成声明写进大纲。
  const fnRe = /\b([A-Za-z_]\w*(?:::[A-Za-z_~]\w*)*)[ \t\r\n]*\(/g
  for (let match = fnRe.exec(masked); match; match = fnRe.exec(masked)) {
    const name = match[1]
    if (KEYWORDS.has(name)) continue
    const lineStart = masked.lastIndexOf('\n', match.index) + 1
    const prefix = masked.slice(lineStart, match.index)
    if (prefix.trimStart().startsWith('#')) continue
    const trimmed = prefix.trim()
    const typeLike = /^[A-Za-z_][\w:<>,*&\s]*$/.test(trimmed) && !/\b(?:return|new|delete|case|goto)\b/.test(trimmed) && !trimmed.includes('=')
    if (!typeLike || (!trimmed && !name.includes('::'))) continue
    const start = match.index
    add(name, name.includes('::') ? 6 : 12, start, start + name.length, name.includes('::') ? name.split('::')[0] : undefined)
  }

  return { path, content, masked, lineStarts, symbols }
}

export class CppIndex {  private readonly files = new Map<string, IndexedFile>()
  private readonly byName = new Map<string, IndexedSymbol[]>()
  private loading: Promise<void> | null = null
  private loaded = false

  constructor(private readonly root: string) {}

  private ensure(): Promise<void> {
    if (this.loaded) return Promise.resolve()
    if (!this.loading) {
      this.loading = this.build().then(() => {
        this.loaded = true
      }).finally(() => {
        this.loading = null
      })
    }
    return this.loading
  }

  private async build(): Promise<void> {
    this.files.clear()
    this.byName.clear()
    let count = 0
    const walk = async (dir: string): Promise<void> => {
      if (count >= MAX_FILES) return
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (count >= MAX_FILES) return
        if (entry.isDirectory()) {
          const lower = entry.name.toLowerCase()
          if (SKIP_DIRS.has(lower) || (entry.name.startsWith('.') && entry.name !== '.')) continue
          await walk(join(dir, entry.name))
          continue
        }
        if (!entry.isFile() || !CPP_EXTENSIONS.has(fileExtension(entry.name))) continue
        const absolute = join(dir, entry.name)
        try {
          const info = await stat(absolute)
          if (!info.isFile() || info.size > MAX_FILE_BYTES) continue
          const content = await readFile(absolute, 'utf8')
          const path = normalizePath(relative(this.root, absolute))
          this.files.set(path, indexFile(path, content))
          count++
        } catch {
          // 忽略不可读文件
        }
      }
    }
    await walk(this.root)
    this.rebuildNameIndex()
  }

  private rebuildNameIndex(): void {
    this.byName.clear()
    const push = (key: string, symbol: IndexedSymbol): void => {
      const list = this.byName.get(key)
      if (list) list.push(symbol)
      else this.byName.set(key, [symbol])
    }
    for (const file of this.files.values()) {
      for (const symbol of file.symbols) {
        push(symbol.name, symbol)
        if (symbol.word !== symbol.name) push(symbol.word, symbol)
      }
    }
  }

  async updateFile(path: string, content: string): Promise<void> {
    await this.ensure()
    const rel = normalizePath(path)
    if (content.length > MAX_FILE_BYTES) {
      this.files.delete(rel)
    } else {
      this.files.set(rel, indexFile(rel, content))
    }
    this.rebuildNameIndex()
  }

  private tokenAt(path: string, position: CodePosition): string | null {
    const file = this.files.get(normalizePath(path))
    if (!file) return null
    const lineStart = file.lineStarts[position.line]
    if (lineStart === undefined) return null
    const offset = lineStart + Math.max(0, position.character)
    const lineEnd = position.line + 1 < file.lineStarts.length ? file.lineStarts[position.line + 1] - 1 : file.content.length
    const line = file.content.slice(lineStart, lineEnd)
    let start = Math.min(Math.max(0, position.character), line.length)
    if (start > 0 && !/[A-Za-z0-9_]/.test(line[start] ?? '')) start--
    let left = start
    while (left > 0 && /[A-Za-z0-9_]/.test(line[left - 1])) left--
    let right = start
    while (right < line.length && /[A-Za-z0-9_]/.test(line[right])) right++
    if (right <= left) return null
    return line.slice(left, right)
  }

  private lookup(token: string): IndexedSymbol[] {
    return this.byName.get(token) ?? []
  }

  private symbolAt(path: string, position: CodePosition): IndexedSymbol | null {
    const file = this.files.get(normalizePath(path))
    if (!file) return null
    const line = position.line
    for (const symbol of file.symbols) {
      if (symbol.selectionRange.start.line !== line) continue
      const start = symbol.selectionRange.start.character
      const end = symbol.selectionRange.end.character
      if (position.character >= start && position.character <= end) return symbol
    }
    return null
  }

  private locations(symbols: IndexedSymbol[]): CodeLocation[] {
    const seen = new Set<string>()
    const out: CodeLocation[] = []
    for (const symbol of symbols) {
      const key = `${symbol.path}:${symbol.selectionRange.start.line}:${symbol.selectionRange.start.character}`
      if (seen.has(key)) continue
      seen.add(key)
      const file = this.files.get(symbol.path)
      const preview = file?.content.split(/\r?\n/)[symbol.selectionRange.start.line]?.trim()
      out.push({ path: symbol.path, range: symbol.selectionRange, preview })
    }
    return out
  }

  async definition(path: string, position: CodePosition): Promise<CodeLocation[]> {
    await this.ensure()
    const token = this.tokenAt(path, position)
    if (!token) return []
    const symbols = this.lookup(token)
    if (symbols.length) return this.locations(symbols)
    // 当前光标就在声明上时，回退到该位置本身
    const current = this.symbolAt(path, position)
    return current ? this.locations([current]) : []
  }

  async references(path: string, position: CodePosition): Promise<CodeLocation[]> {
    await this.ensure()
    const token = this.tokenAt(path, position)
    if (!token) return []
    const symbol = this.symbolAt(path, position) ?? this.lookup(token)[0]
    const word = (symbol?.word ?? token.split('::').pop() ?? token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!word || word.length < 2) return []
    const wordRe = new RegExp(`\\b${word}\\b`, 'g')
    const out: CodeLocation[] = []
    const seen = new Set<string>()
    for (const file of this.files.values()) {
      for (let match = wordRe.exec(file.masked); match; match = wordRe.exec(file.masked)) {
        const key = `${file.path}:${match.index}`
        if (seen.has(key)) continue
        seen.add(key)
        const range = rangeAt(file.lineStarts, match.index, match.index + match[0].length)
        out.push({
          path: file.path,
          range,
          preview: file.content.split(/\r?\n/)[range.start.line]?.trim()
        })
        if (out.length >= MAX_REFERENCES) return out
      }
      wordRe.lastIndex = 0
    }
    return out
  }

  async hover(path: string, position: CodePosition): Promise<CodeHoverResult | null> {
    await this.ensure()
    const token = this.tokenAt(path, position)
    if (!token) return null
    const symbol = this.symbolAt(path, position) ?? this.lookup(token)[0]
    if (!symbol) return null
    return {
      contents: [
        `\`${symbol.detail || symbol.name}\``,
        `${symbol.path}:${symbol.selectionRange.start.line + 1}`
      ],
      range: symbol.selectionRange
    }
  }

  async documentSymbols(path: string): Promise<CodeSymbol[]> {
    await this.ensure()
    const file = this.files.get(normalizePath(path))
    if (!file) return []
    return file.symbols
      .slice()
      .sort((a, b) => a.selectionRange.start.line - b.selectionRange.start.line || a.selectionRange.start.character - b.selectionRange.start.character)
      .map((symbol) => ({
        name: symbol.name,
        detail: symbol.detail,
        kind: symbol.kind,
        path: symbol.path,
        range: symbol.range,
        selectionRange: symbol.selectionRange,
        containerName: symbol.containerName
      }))
  }

  async workspaceSymbols(query: string): Promise<CodeSymbol[]> {
    await this.ensure()
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    const out: CodeSymbol[] = []
    for (const symbols of this.byName.values()) {
      for (const symbol of symbols) {
        if (!symbol.name.toLowerCase().includes(needle) && !symbol.detail.toLowerCase().includes(needle)) continue
        out.push({
          name: symbol.name,
          detail: symbol.detail,
          kind: symbol.kind,
          path: symbol.path,
          range: symbol.range,
          selectionRange: symbol.selectionRange,
          containerName: symbol.containerName
        })
        if (out.length >= 200) return out
      }
    }
    return out
  }
}
