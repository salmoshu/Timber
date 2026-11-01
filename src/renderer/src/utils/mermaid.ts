// Mermaid 客户端渲染与外观重刷（v0.6.10 统一出口）。
// 编辑器内由 Vditor 自渲染；导出 / 分页预览管线（renderMarkdownForExport）
// 产出的是静态 HTML，无人触发渲染——分页预览里 Mermaid 只剩源码。这里补齐
// 与 Vditor 相同的脚本加载和初始化参数，供导出管线复用；
// styleMermaidSvgs 从 MarkdownView 迁出，编辑器与导出共用同一套 GitHub 风格配色。
type MermaidGlobal = {
  initialize(config: Record<string, unknown>): void
  render(id: string, code: string): Promise<{ svg: string }>
}

/** mermaid 脚本随应用内置（scripts/copy-vditor-libs.mjs → public/vditor-libs），离线可用 */
let mermaidReady: Promise<MermaidGlobal> | undefined

function loadMermaid(): Promise<MermaidGlobal> {
  if (!mermaidReady) {
    mermaidReady = new Promise<MermaidGlobal>((resolve, reject) => {
      const existing = (window as unknown as { mermaid?: MermaidGlobal }).mermaid
      if (existing) {
        resolve(existing)
        return
      }
      const script = document.createElement('script')
      script.src = 'vditor-libs/dist/js/mermaid/mermaid.min.js'
      script.onload = () => {
        const m = (window as unknown as { mermaid?: MermaidGlobal }).mermaid
        if (m) resolve(m)
        else {
          script.remove()
          reject(new Error('mermaid 加载失败'))
        }
      }
      script.onerror = () => {
        script.remove()
        reject(new Error('mermaid 脚本加载失败'))
      }
      document.head.appendChild(script)
    }).catch((error) => {
      mermaidReady = undefined
      throw error
    })
  }
  return mermaidReady
}

let seq = 0
/** 同源码的渲染结果缓存（分页预览随草稿高频重建，避免重复渲染） */
const svgCache = new Map<string, string>()

/** 渲染容器内全部 mermaid 代码块（code.language-mermaid）：
 *  成功 → 块内替换为 SVG 并做外观重刷；失败 → 保留源码文本并标记错误态。
 *  脚本加载失败静默保留源码（离线异常场景不阻塞导出）。 */
export async function renderMermaidBlocks(root: ParentNode, dark = false): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>('code.language-mermaid')].filter(
    (el) => el.getAttribute('data-processed') !== 'true'
  )
  if (blocks.length === 0) return
  let mermaid: MermaidGlobal
  try {
    mermaid = await loadMermaid()
  } catch {
    return
  }
  // 初始化参数与 Vditor mermaidRender 对齐（securityLevel/family/时序图序号等）
  const config: Record<string, unknown> = {
    securityLevel: 'loose',
    altFontFamily: 'sans-serif',
    fontFamily: 'sans-serif',
    startOnLoad: false,
    flowchart: { htmlLabels: true, useMaxWidth: true },
    sequence: { useMaxWidth: true, diagramMarginX: 8, diagramMarginY: 8, boxMarginY: 8, boxMargin: 8, showSequenceNumbers: true },
    gantt: { leftPadding: 75, rightPadding: 20 }
  }
  if (dark) config.theme = 'dark'
  mermaid.initialize(config)
  for (const el of blocks) {
    const code = el.textContent ?? ''
    if (!code.trim()) continue
    el.setAttribute('data-processed', 'true')
    try {
      let svg = svgCache.get(code)
      if (!svg) {
        svg = (await mermaid.render(`an-mermaid-${seq++}`, code)).svg
        if (svgCache.size > 40) svgCache.clear()
        svgCache.set(code, svg)
      } else {
        // 缓存命中：svg 内部 <style> 按 id 作用域，重用需整体换新 id 防重复冲突
        const oldId = /id="(an-mermaid-\d+)"/.exec(svg)?.[1]
        if (oldId) {
          const newId = `an-mermaid-${seq++}`
          svg = svg.split(oldId).join(newId)
        }
      }
      el.innerHTML = svg
      // 图卡容器：去掉代码块底色，居中呈现
      el.parentElement?.classList.add('mermaid-doc')
      styleMermaidSvgs(el, dark)
    } catch {
      el.removeAttribute('data-processed')
      el.setAttribute('data-mermaid-error', 'true')
    }
  }
}

/** Mermaid 外观重刷（GitHub 风格）：白底卡片节点 + 石板灰边线 + 系统字体 +
 *  轻投影，深色模式镜像。只改颜色/圆角/投影不动布局；pie/甘特等按颜色表意
 *  的图形不覆盖填充色，仅统一文字。 */
export function styleMermaidSvgs(root: ParentNode, dark: boolean): void {
  const c = dark
    ? {
        node: '#1c2635', nodeStroke: '#4a6488', edge: '#8199b4', ink: '#e6edf3',
        paper: '#141b24', cluster: '#111823', clusterStroke: '#33445a', labelBg: '#141b24',
        note: '#3d3213', noteStroke: '#a08420', actor: '#132a44', actorStroke: '#3f7fc2',
        shadow: 'drop-shadow(0 2px 6px rgba(0,0,0,.5))'
      }
    : {
        node: '#ffffff', nodeStroke: '#8296b0', edge: '#71809a', ink: '#1f2b3d',
        paper: '#ffffff', cluster: '#f4f6f9', clusterStroke: '#d5dde6', labelBg: '#ffffff',
        note: '#fdf6d8', noteStroke: '#d6a72c', actor: '#e8f3ff', actorStroke: '#54a3ff',
        shadow: 'drop-shadow(0 2px 6px rgba(31,43,61,.16))'
      }
  const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"
  root.querySelectorAll<SVGElement>('.language-mermaid svg').forEach((svg) => {
    const paint = (selector: string, styles: Record<string, string>): void => {
      svg.querySelectorAll<SVGElement | HTMLElement>(selector).forEach((el) => {
        Object.entries(styles).forEach(([property, value]) => el.style.setProperty(property, value, 'important'))
      })
    }
    // 节点形状（流程图 / 状态图 / 类图 / ER / 旅程 / 思维导图）
    paint(
      '.node rect, .node circle, .node ellipse, .node polygon, .node path, g.classGroup rect, g.stateGroup rect, g.stateGroup circle, g.entityBox rect, rect.actor, g.actor rect',
      { fill: c.node, stroke: c.nodeStroke, 'stroke-width': '1.3px', filter: c.shadow }
    )
    // 时序图参与者与激活条：淡蓝底区分
    paint('rect.actor, g.actor rect, rect.activation0, rect.activation1, rect.activation2', { fill: c.actor, stroke: c.actorStroke, 'stroke-width': '1.2px' })
    // 分组框：浅灰底弱边
    paint('.cluster rect, g.cluster rect', { fill: c.cluster, stroke: c.clusterStroke, 'stroke-width': '1.2px' })
    // 边线 / 生命线 / 消息线 / 循环框 / 类图分隔线 / 思维导图连线
    paint(
      '.edgePath path, path.flowchart-link, .actor-line, .signal, .messageLine0, .messageLine1, .loopLine, g.classGroup line, .er.relationshipLine, .transition path, .mindmap-edges path',
      { stroke: c.edge, 'stroke-width': '1.5px' }
    )
    paint('marker path, marker polygon, .arrowheadPath, .arrowMarkerPath', { fill: c.edge, stroke: c.edge })
    // 边标签：与画布同底，避免文字压线
    paint('.edgeLabel rect, g.edgeLabel rect', { fill: c.labelBg, stroke: 'none' })
    paint('.edgeLabel, span.edgeLabel', { 'background-color': c.labelBg, color: c.ink, 'font-family': font })
    // 注释便签
    paint('.note, rect.note, g.note rect', { fill: c.note, stroke: c.noteStroke, 'stroke-width': '1.2px' })
    // 文字统一（含标题 / 图例 / 甘特分区）
    paint(
      'text, .nodeLabel, .edgeLabel, .label, .messageText, .noteText, .loopText, .cluster-label, .pieTitle, .legend, .sectionTitle, .taskText, .titleText',
      { color: c.ink, fill: c.ink, 'font-family': font }
    )
    // 圆角：矩形节点与分组框
    svg.querySelectorAll<SVGElement>('.node rect, g.classGroup rect, g.stateGroup rect, rect.actor, g.actor rect, .cluster rect, g.cluster rect, rect.note, g.note rect').forEach((el) => {
      el.setAttribute('rx', '8')
      el.setAttribute('ry', '8')
    })
    svg.style.setProperty('background', c.paper, 'important')
  })
}
