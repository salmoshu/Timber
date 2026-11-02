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

/** 渲染容器内全部 Mermaid 块。Lute 静态导出使用 div.language-mermaid，
 *  编辑器预览使用 code.language-mermaid，两种结构都必须支持。
 *  width：测量宽度（px）。gantt 等按可用宽度排版的图（useMaxWidth）在渲染时
 *  直接读临时容器父级的 offsetWidth（即视口宽）作为自然宽，导致同一张图在
 *  编辑器、分页预览里尺寸各不相同——分页 / 导出管线传入 A4 内容宽（680），
 *  gantt 走 useWidth 固定排版宽度，与页面同宽（v0.6.11 修复尺寸不一致）。 */
export async function renderMermaidBlocks(root: ParentNode, dark = false, width?: number): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>('.language-mermaid')].filter(
    (el) => !el.querySelector('svg') && !!(el.textContent ?? '').trim()
  )
  if (blocks.length === 0) return
  let mermaid: MermaidGlobal
  try {
    mermaid = await loadMermaid()
  } catch (error) {
    console.error('[mermaid] 脚本加载失败', error)
    blocks.forEach((el) => el.setAttribute('data-mermaid-error', 'true'))
    return
  }
  // 初始化参数与 Vditor mermaidRender 对齐（securityLevel/family/时序图序号等）
  const gantt: Record<string, unknown> = { leftPadding: 75, rightPadding: 20 }
  if (width !== undefined) gantt.useWidth = Math.round(width)
  const config: Record<string, unknown> = {
    securityLevel: 'loose',
    altFontFamily: 'sans-serif',
    fontFamily: 'sans-serif',
    startOnLoad: false,
    flowchart: { htmlLabels: true, useMaxWidth: true },
    sequence: { useMaxWidth: true, diagramMarginX: 8, diagramMarginY: 8, boxMarginY: 8, boxMargin: 8, showSequenceNumbers: true },
    gantt
  }
  if (dark) config.theme = 'dark'
  mermaid.initialize(config)
  for (const el of blocks) {
    const code = el.textContent ?? ''
    const cacheKey = `${dark ? 'd' : 'l'}|${width ?? ''}|${code}`
    el.setAttribute('data-processed', 'true')
    try {
      let svg = svgCache.get(cacheKey)
      if (!svg) {
        svg = (await mermaid.render(`an-mermaid-${seq++}`, code)).svg
        if (svgCache.size > 40) svgCache.clear()
        svgCache.set(cacheKey, svg)
      } else {
        // 缓存命中：svg 内部 <style> 按 id 作用域，重用需整体换新 id 防重复冲突
        const oldId = /id="(an-mermaid-\d+)"/.exec(svg)?.[1]
        if (oldId) {
          const newId = `an-mermaid-${seq++}`
          svg = svg.split(oldId).join(newId)
        }
      }
      el.innerHTML = svg
      el.classList.add('mermaid-doc')
      if (el.parentElement?.tagName === 'PRE') el.parentElement.classList.add('mermaid-doc')
      styleMermaidSvgs(el, dark)
    } catch (error) {
      console.error('[mermaid] 图形渲染失败', error)
      el.removeAttribute('data-processed')
      el.setAttribute('data-mermaid-error', 'true')
    }
  }
}

/** HTML 标签的实际字体宽度可能与 Mermaid 预估值不同。只缩小异常标签，
 *  不扩张节点或改变图布局，避免文字裁切和相邻节点遮挡。 */
function fitMermaidLabels(svg: SVGElement): void {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) return
  const textProbe = document.createElement('div')
  svg.querySelectorAll<HTMLElement>('.nodeLabel, .edgeLabel').forEach((label) => {
    const frame = label.closest('foreignObject')
    if (!frame) return
    const availableWidth = Number(frame.getAttribute('width'))
    const availableHeight = Number(frame.getAttribute('height'))
    if (!Number.isFinite(availableWidth) || availableWidth <= 0) return
    frame.style.overflow = 'visible'
    label.style.overflow = 'visible'
    const style = getComputedStyle(label)
    const fontSize = Number.parseFloat(style.fontSize) || 16
    context.font = `${style.fontStyle} ${style.fontWeight} ${fontSize}px ${style.fontFamily || 'sans-serif'}`
    textProbe.innerHTML = label.innerHTML.replace(/<br\s*\/?>/gi, '\n')
    const lines = (textProbe.textContent ?? '').split('\n')
    const measuredWidth = Math.max(0, ...lines.map((line) => context.measureText(line).width))
    const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.2
    const widthRatio = measuredWidth > availableWidth + 0.5 ? availableWidth / measuredWidth : 1
    const heightRatio = availableHeight > 0 && lines.length * lineHeight > availableHeight + 0.5
      ? availableHeight / (lines.length * lineHeight)
      : 1
    const ratio = Math.min(1, widthRatio, heightRatio)
    if (ratio >= 1) return
    label.style.fontSize = `${Math.max(10, fontSize * ratio)}px`
  })
}

function translatedOffset(element: Element, svg: SVGElement): { x: number; y: number } {
  let x = 0
  let y = 0
  let current: Element | null = element
  while (current && current !== svg) {
    const match = /translate\(\s*([-\d.eE]+)(?:[,\s]+([-\d.eE]+))?\s*\)/.exec(current.getAttribute('transform') ?? '')
    if (match) {
      x += Number(match[1])
      y += Number(match[2] ?? 0)
    }
    current = current.parentElement
  }
  return { x, y }
}

/** Mermaid 的子图标题与首个节点可能占用同一垂直空间。把标题向上移到节点之外，
 *  并用不透明底衬隔离穿过的连线；不移动节点，也不改变图的水平布局。 */
function avoidClusterLabelOverlap(svg: SVGElement, background: string): void {
  svg.querySelectorAll<SVGGElement>('g.cluster').forEach((cluster) => {
    const label = cluster.querySelector<SVGGElement>(':scope > g.cluster-label')
    const frame = label?.querySelector<SVGElement>('foreignObject')
    if (!label || !frame) return
    const labelOffset = translatedOffset(frame, svg)
    const labelWidth = Number(frame.getAttribute('width'))
    const labelHeight = Number(frame.getAttribute('height'))
    if (labelWidth <= 0 || labelHeight <= 0) return
    const labelBox = {
      left: labelOffset.x,
      right: labelOffset.x + labelWidth,
      top: labelOffset.y,
      bottom: labelOffset.y + labelHeight
    }
    const clusterShape = cluster.querySelector<SVGRectElement>(':scope > rect')
    if (!clusterShape) return
    const clusterOffset = translatedOffset(clusterShape, svg)
    const clusterLeft = clusterOffset.x + Number(clusterShape.getAttribute('x') ?? 0)
    const clusterTop = clusterOffset.y + Number(clusterShape.getAttribute('y') ?? 0)
    const clusterRight = clusterLeft + Number(clusterShape.getAttribute('width'))
    const clusterBottom = clusterTop + Number(clusterShape.getAttribute('height'))
    let shift = 0
    svg.querySelectorAll<SVGGElement>('g.node').forEach((node) => {
      const shape = node.querySelector('rect')
      if (!shape) return
      const offset = translatedOffset(shape, svg)
      const left = offset.x + Number(shape.getAttribute('x') ?? 0)
      const top = offset.y + Number(shape.getAttribute('y') ?? 0)
      const right = left + Number(shape.getAttribute('width'))
      const bottom = top + Number(shape.getAttribute('height'))
      const centerX = (left + right) / 2
      const centerY = (top + bottom) / 2
      if (centerX < clusterLeft || centerX > clusterRight || centerY < clusterTop || centerY > clusterBottom) return
      const overlaps = labelBox.left < right && labelBox.right > left && labelBox.top < bottom && labelBox.bottom > top
      if (overlaps) shift = Math.max(shift, labelBox.bottom - top + 4)
    })
    frame.style.setProperty('background', background)
    if (shift <= 0) return
    const match = /translate\(\s*([-\d.eE]+)(?:[,\s]+([-\d.eE]+))?\s*\)/.exec(label.getAttribute('transform') ?? '')
    if (!match) return
    const nextY = Number(match[2] ?? 0) - shift
    label.setAttribute('transform', `translate(${Number(match[1])}, ${nextY})`)
    const viewBox = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number)
    if (viewBox.length === 4 && viewBox.every(Number.isFinite) && nextY < viewBox[1]) {
      const extra = viewBox[1] - nextY
      viewBox[1] -= extra
      viewBox[3] += extra
      svg.setAttribute('viewBox', viewBox.join(' '))
    }
  })
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
    paint('.edgeLabel, span.edgeLabel', { 'background-color': c.labelBg, color: c.ink })
    // 注释便签
    paint('.note, rect.note, g.note rect', { fill: c.note, stroke: c.noteStroke, 'stroke-width': '1.2px' })
    // 字体与字重保持 Mermaid 测量节点尺寸时的取值，避免混排标签生成后溢出。
    paint(
      'text, .nodeLabel, .edgeLabel, .label, .messageText, .noteText, .loopText, .cluster-label, .pieTitle, .legend, .sectionTitle, .taskText, .titleText',
      { color: c.ink, fill: c.ink }
    )
    // 圆角：矩形节点与分组框
    svg.querySelectorAll<SVGElement>('.node rect, g.classGroup rect, g.stateGroup rect, rect.actor, g.actor rect, .cluster rect, g.cluster rect, rect.note, g.note rect').forEach((el) => {
      el.setAttribute('rx', '8')
      el.setAttribute('ry', '8')
    })
    fitMermaidLabels(svg)
    avoidClusterLabelOverlap(svg, c.paper)
    svg.style.setProperty('background', c.paper, 'important')
  })
}
