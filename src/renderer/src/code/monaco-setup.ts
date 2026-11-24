import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import { buildLanguageForPath, codeLanguageForPath } from '@shared/code'

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
  monaco.languages.register({ id: 'cmake' })
  monaco.languages.setMonarchTokensProvider('cmake', {
    tokenizer: {
      root: [
        [/#.*$/, 'comment'],
        [/\$\{[^}]*\}|\$<[^>]*>/, 'variable'],
        [/[A-Za-z_]\w*(?=\s*\()/, 'keyword'],
        [/"(?:[^"\\]|\\.)*"/, 'string'],
        [/[()]/, 'delimiter']
      ]
    }
  })
  monaco.languages.register({ id: 'makefile' })
  monaco.languages.setMonarchTokensProvider('makefile', {
    tokenizer: {
      root: [
        [/#.*$/, 'comment'],
        [/^\s*(?:include|sinclude|ifdef|ifndef|ifeq|ifneq|else|endif|define|endef|export|unexport)\b/, 'keyword'],
        [/^\s*[\w.-]+(?=\s*[:+?]?=)/, 'variable'],
        [/^[^#=\s:]+(?=\s*:(?!=))/, 'type.identifier'],
        [/\$\([^)]+\)|\$\{[^}]+\}|\$[@%<?^+*|]/, 'variable']
      ]
    }
  })
}

export function monacoLanguageForPath(path: string): string {
  const buildLanguage = buildLanguageForPath(path)
  if (buildLanguage) return buildLanguage
  const semantic = codeLanguageForPath(path)
  switch (semantic) {
    case 'c': return 'cpp'
    case 'objective-cpp': return 'objective-c'
    case 'typescriptreact': return 'typescript'
    case 'javascriptreact': return 'javascript'
    case null: break
    default: return semantic
  }
  const ext = path.split('.').pop()?.toLowerCase()
  const languages: Record<string, string> = {
    go: 'go', py: 'python', pyi: 'python', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
    cs: 'csharp',
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
