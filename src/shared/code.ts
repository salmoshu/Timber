export type CodeLanguageId =
  | 'typescript'
  | 'typescriptreact'
  | 'javascript'
  | 'javascriptreact'
  | 'c'
  | 'cpp'
  | 'objective-c'
  | 'objective-cpp'

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

const clangdLanguages = {
  c: 'c', h: 'c',
  cc: 'cpp', cp: 'cpp', cpp: 'cpp', cxx: 'cpp', 'c++': 'cpp',
  hpp: 'cpp', hh: 'cpp', hxx: 'cpp', 'h++': 'cpp',
  ipp: 'cpp', inl: 'cpp', tpp: 'cpp', txx: 'cpp',
  ixx: 'cpp', cppm: 'cpp', ccm: 'cpp', cxxm: 'cpp', 'c++m': 'cpp',
  cu: 'cpp', cuh: 'cpp', m: 'objective-c', mm: 'objective-cpp'
} as const satisfies Record<string, CodeLanguageId>

export const CLANGD_EXTENSIONS = Object.keys(clangdLanguages).map((ext) => `.${ext}`)

export function usesClangd(languageId: CodeLanguageId | null | undefined): languageId is 'c' | 'cpp' | 'objective-c' | 'objective-cpp' {
  return languageId === 'c' || languageId === 'cpp' || languageId === 'objective-c' || languageId === 'objective-cpp'
}

const buildFileLanguages: Record<string, string> = {
  'cmakelists.txt': 'cmake',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  'meson.build': 'python',
  'meson.options': 'python',
  'meson_options.txt': 'python'
}

const buildExtensionLanguages: Record<string, string> = {
  '.cmake': 'cmake', '.mk': 'makefile', '.ninja': 'ini',
  '.sln': 'plaintext', '.slnx': 'xml', '.vcxproj': 'xml', '.vcxitems': 'xml',
  '.props': 'xml', '.targets': 'xml', '.filters': 'xml',
  '.clangd': 'yaml', '.clang-format': 'yaml', '.clang-tidy': 'yaml'
}

export const BUILD_FILE_SELECTORS = [
  ...Object.keys(buildFileLanguages).map((name) => `=${name}`),
  ...Object.keys(buildExtensionLanguages)
]

export function buildLanguageForPath(path: string): string | null {
  const name = path.split(/[/\\]/).pop()?.toLowerCase() ?? ''
  if (Object.hasOwn(buildFileLanguages, name)) return buildFileLanguages[name]
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  const ext = name.slice(dot)
  return Object.hasOwn(buildExtensionLanguages, ext) ? buildExtensionLanguages[ext] : null
}

export function codeLanguageForPath(path: string): CodeLanguageId | null {
  const name = path.split(/[/\\]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  const suffix = name.slice(dot + 1)
  if (suffix === 'C' || suffix === 'H') return 'cpp'
  const ext = suffix.toLowerCase()
  if (Object.hasOwn(clangdLanguages, ext)) return clangdLanguages[ext as keyof typeof clangdLanguages]
  switch (ext) {
    case 'ts': return 'typescript'
    case 'tsx': return 'typescriptreact'
    case 'js':
    case 'mjs':
    case 'cjs': return 'javascript'
    case 'jsx': return 'javascriptreact'
    default: return null
  }
}
