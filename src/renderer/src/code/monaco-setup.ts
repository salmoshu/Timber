import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import { codeLanguageForPath } from '@shared/code'

let configured = false

export function configureMonaco(): void {
  if (configured) return
  configured = true
  self.MonacoEnvironment = {
    getWorker: (_workerId, label) => {
      if (label === 'typescript' || label === 'javascript') return new TsWorker()
      if (label === 'json') return new JsonWorker()
      if (['css', 'scss', 'less'].includes(label)) return new CssWorker()
      if (['html', 'handlebars', 'razor'].includes(label)) return new HtmlWorker()
      return new EditorWorker()
    }
  }
  for (const defaults of [monaco.languages.typescript.typescriptDefaults, monaco.languages.typescript.javascriptDefaults]) {
    defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true })
  }
}

export function monacoLanguageForPath(path: string): string {
  const semantic = codeLanguageForPath(path)
  // Monaco 没有独立的 C 语言，C 与 C++ 共用 cpp 语法
  if (semantic) return semantic === 'c' ? 'cpp' : semantic
  const ext = path.split('.').pop()?.toLowerCase()
  const languages: Record<string, string> = {
    go: 'go', py: 'python', pyi: 'python', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
    c: 'c', h: 'c', cc: 'cpp', cp: 'cpp', cpp: 'cpp', cxx: 'cpp', 'c++': 'cpp', hpp: 'cpp', hh: 'cpp',
    hxx: 'cpp', 'h++': 'cpp', ipp: 'cpp', inl: 'cpp', tpp: 'cpp', txx: 'cpp', cu: 'cpp', cuh: 'cpp',
    m: 'objective-c', mm: 'objective-c', cmake: 'ini', mk: 'ini', cs: 'csharp',
    rb: 'ruby', php: 'php', swift: 'swift', dart: 'dart', scala: 'scala', clj: 'clojure',
    ex: 'elixir', exs: 'elixir', lua: 'lua', pl: 'perl', r: 'r', sh: 'shell', bash: 'shell', zsh: 'shell',
    ps1: 'powershell', bat: 'bat', cmd: 'bat', css: 'css', scss: 'scss', sass: 'sass', less: 'less',
    vue: 'html', svelte: 'html', astro: 'html', json: 'json', jsonl: 'json', yaml: 'yaml', yml: 'yaml',
    toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', xml: 'xml', sql: 'sql', graphql: 'graphql', gql: 'graphql',
    proto: 'protobuf', properties: 'ini', md: 'markdown', markdown: 'markdown', rst: 'restructuredtext'
  }
  return languages[ext ?? ''] ?? 'plaintext'
}

export function monacoTheme(dark: boolean): string {
  const theme = dark ? 'timber-code-dark' : 'timber-code-light'
  monaco.editor.defineTheme(theme, {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': dark ? '#17191d' : '#ffffff',
      'editorWidget.background': dark ? '#202329' : '#ffffff',
      'editorStickyScroll.background': dark ? '#17191d' : '#ffffff',
      'editor.lineHighlightBackground': dark ? '#ffffff08' : '#00000005'
    }
  })
  return theme
}

export { monaco }
