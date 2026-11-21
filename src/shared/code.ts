export type CodeLanguageId =
  | 'typescript'
  | 'typescriptreact'
  | 'javascript'
  | 'javascriptreact'
  | 'c'
  | 'cpp'
  | 'objective-c'

export interface CodePosition {
  line: number
  character: number
}

export interface CodeRange {
  start: CodePosition
  end: CodePosition
}

export interface CodeDocumentRef {
  rootPath: string
  path: string
  languageId: CodeLanguageId
}

export interface CodeDocumentInput extends CodeDocumentRef {
  content: string
}

export interface CodeLocation {
  path: string
  range: CodeRange
  preview?: string
}

export interface CodeHoverResult {
  contents: string[]
  range?: CodeRange
}

export interface CodeSymbol {
  name: string
  detail: string
  kind: number
  path: string
  range: CodeRange
  selectionRange: CodeRange
  containerName?: string
  children?: CodeSymbol[]
}

export interface CodeServiceStatus {
  ok: boolean
  message?: string
}

export function codeLanguageForPath(path: string): CodeLanguageId | null {
  const ext = path.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'ts': return 'typescript'
    case 'tsx': return 'typescriptreact'
    case 'js':
    case 'mjs':
    case 'cjs': return 'javascript'
    case 'jsx': return 'javascriptreact'
    case 'c': return 'c'
    case 'h': return 'c'
    case 'cc':
    case 'cp':
    case 'cpp':
    case 'cxx':
    case 'c++':
    case 'hpp':
    case 'hh':
    case 'hxx':
    case 'h++':
    case 'ipp':
    case 'inl':
    case 'tpp':
    case 'txx':
    case 'cu':
    case 'cuh': return 'cpp'
    case 'm':
    case 'mm': return 'objective-c'
    default: return null
  }
}
