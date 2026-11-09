import { useStore } from '../store'
import { toggleWritingPreference, useWritingPreferences } from '../utils/writingPreferences'
import TypographySettings from './TypographySettings'

/** Adopt the editor preferences that both Timber's source editor and Muya support. */
export default function EditorSettings() {
  const { settings, setSetting } = useStore()
  const writing = useWritingPreferences()
  return <div className="editor-settings" aria-label="编辑器设置">
    <TypographySettings />
    <div className="st-card editor-behavior-settings">
      <h2 className="st-card-title">编辑器行为</h2>
      <h3>自动输入</h3>
      {([
        ['autoPairBracket', '括号自动配对'],
        ['autoPairQuote', '引号自动配对'],
        ['autoPairMarkdownSyntax', 'Markdown 标记自动配对'],
        ['smartLists', '源码列表与引用智能续行']
      ] as const).map(([key, label]) => <div className="st-row" key={key}>
        <label className="st-label" htmlFor={`writing-${key}`}>{label}</label>
        <input id={`writing-${key}`} type="checkbox" checked={writing[key]} onChange={() => toggleWritingPreference(key)} />
      </div>)}
      <h3>代码与缩进</h3>
      {([
        ['codeBlockLineNumbers', '代码块行号'],
        ['sourceCodeLineNumbers', '源码行号'],
        ['hideQuickInsertHint', '隐藏阅读模式的空行插入提示']
      ] as const).map(([key, label]) => <div className="st-row" key={key}>
        <label className="st-label" htmlFor={`editor-${key}`}>{label}</label>
        <input id={`editor-${key}`} type="checkbox" checked={settings[key]} onChange={(event) => setSetting(key, event.target.checked)} />
      </div>)}
      <div className="st-row">
        <label className="st-label" htmlFor="editor-tab-size">缩进宽度</label>
        <select id="editor-tab-size" className="editor-tab-size" value={settings.tabSize} onChange={(event) => setSetting('tabSize', Number(event.target.value))}>
          {[2, 4, 8].map((size) => <option key={size} value={size}>{size} 个空格</option>)}
        </select>
        <div className="st-hint">用于源码 Tab 缩进与代码中的制表符显示。</div>
      </div>
      <h3>写作模式</h3>
      {([
        ['focus', '专注模式（F8）'], ['typewriter', '打字机模式（F9）'], ['distractionFree', '沉浸模式（F10）']
      ] as const).map(([key, label]) => <div className="st-row" key={key}>
        <label className="st-label" htmlFor={`writing-${key}`}>{label}</label>
        <input id={`writing-${key}`} type="checkbox" checked={writing[key]} onChange={() => toggleWritingPreference(key)} />
      </div>)}
      <div className="st-row"><div className="st-label">自动保存</div><div className="st-hint">停止输入后自动保存；Ctrl+S 可立即保存。</div></div>
      <div className="st-row"><div className="st-label">自动保存延迟</div><div className="seg">
        {[1000, 2000, 3000].map((ms) => <button key={ms} className={settings.autoSaveDelayMs === ms ? 'active' : ''} onClick={() => setSetting('autoSaveDelayMs', ms)}>{ms / 1000}s</button>)}
      </div></div>
    </div>
  </div>
}
