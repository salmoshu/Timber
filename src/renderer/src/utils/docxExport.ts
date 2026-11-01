import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from 'docx'

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6]
const FONT = 'Microsoft YaHei'
const MONO = 'Consolas'

type DocxRun = TextRun | ExternalHyperlink | ImageRun

interface InlineStyle {
  bold?: boolean
  italics?: boolean
  code?: boolean
}

function imageKind(src: string, mime: string): 'png' | 'jpg' | 'gif' | 'bmp' | null {
  const value = `${src.split('?')[0]} ${mime}`.toLowerCase()
  if (value.includes('png')) return 'png'
  if (value.includes('jpg') || value.includes('jpeg')) return 'jpg'
  if (value.includes('gif')) return 'gif'
  if (value.includes('bmp')) return 'bmp'
  return null
}

async function imageRun(img: HTMLImageElement): Promise<ImageRun | null> {
  const src = img.getAttribute('src') ?? ''
  if (!src) return null
  try {
    const response = await fetch(src)
    if (!response.ok) return null
    const mime = response.headers.get('content-type') ?? ''
    const type = imageKind(src, mime)
    if (!type) return null
    const data = await response.arrayBuffer()
    const probe = new Image()
    probe.src = src
    await probe.decode()
    const naturalWidth = probe.naturalWidth || 600
    const naturalHeight = probe.naturalHeight || 400
    const requested = Number.parseInt(img.getAttribute('width') ?? '', 10)
    const width = Math.min(620, Math.max(40, Number.isFinite(requested) && requested > 0 ? requested : naturalWidth))
    return new ImageRun({
      data,
      type,
      transformation: { width, height: Math.round(width * naturalHeight / naturalWidth) }
    })
  } catch {
    return null
  }
}

async function inlineRuns(node: Node, style: InlineStyle = {}): Promise<DocxRun[]> {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? ''
    return text ? [new TextRun({ text, font: style.code ? MONO : FONT, size: style.code ? 20 : 24, bold: style.bold, italics: style.italics, color: style.code ? 'B83A32' : '222222' })] : []
  }
  if (!(node instanceof HTMLElement)) return []
  if (node.tagName === 'BR') return [new TextRun({ break: 1 })]
  if (node instanceof HTMLImageElement) {
    const run = await imageRun(node)
    return run ? [run] : []
  }
  const nextStyle: InlineStyle = {
    bold: style.bold || node.tagName === 'STRONG' || node.tagName === 'B',
    italics: style.italics || node.tagName === 'EM' || node.tagName === 'I',
    code: style.code || node.tagName === 'CODE'
  }
  if (node.tagName === 'A') {
    const children = (await Promise.all([...node.childNodes].map((child) => inlineRuns(child, nextStyle)))).flat()
      .filter((run): run is TextRun => run instanceof TextRun)
    return [new ExternalHyperlink({ children, link: node.getAttribute('href') ?? '' })]
  }
  return (await Promise.all([...node.childNodes].map((child) => inlineRuns(child, nextStyle)))).flat()
}

async function paragraph(element: HTMLElement, options: {
  heading?: (typeof HEADINGS)[number]
  bullet?: boolean
  prefix?: string
  quote?: boolean
  pageBreakBefore?: boolean
} = {}): Promise<Paragraph> {
  const runs = await inlineRuns(element)
  if (options.prefix) runs.unshift(new TextRun({ text: options.prefix, font: FONT, size: 24 }))
  return new Paragraph({
    children: runs.length > 0 ? runs : [new TextRun('')],
    heading: options.heading,
    bullet: options.bullet ? { level: 0 } : undefined,
    pageBreakBefore: options.pageBreakBefore,
    alignment: element.style.textAlign === 'center' ? AlignmentType.CENTER : undefined,
    indent: options.quote ? { left: 360 } : undefined,
    border: options.quote ? { left: { style: BorderStyle.SINGLE, size: 12, color: '1783FF', space: 8 } } : undefined,
    spacing: { before: options.heading ? 180 : 60, after: options.heading ? 100 : 80, line: 320 }
  })
}

async function table(element: HTMLTableElement): Promise<Table> {
  const rows = await Promise.all([...element.rows].map(async (row) => new TableRow({
    children: await Promise.all([...row.cells].map(async (cell) => new TableCell({
      children: [await paragraph(cell)],
      width: { size: Math.floor(100 / Math.max(1, row.cells.length)), type: WidthType.PERCENTAGE },
      shading: cell.tagName === 'TH' ? { type: ShadingType.CLEAR, fill: 'F2F2F2' } : undefined
    })))
  })))
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } })
}

async function blocks(root: HTMLElement): Promise<(Paragraph | Table)[]> {
  const out: (Paragraph | Table)[] = []
  for (const child of [...root.children]) {
    const element = child as HTMLElement
    const tag = element.tagName
    const pageBreakBefore = element.classList.contains('page-break')
    if (/^H[1-6]$/.test(tag)) out.push(await paragraph(element, { heading: HEADINGS[Number(tag[1]) - 1], pageBreakBefore }))
    else if (tag === 'P') out.push(await paragraph(element, { pageBreakBefore }))
    else if (tag === 'UL' || tag === 'OL') {
      let index = 0
      for (const item of [...element.children].filter((el) => el.tagName === 'LI')) {
        index++
        out.push(await paragraph(item as HTMLElement, tag === 'UL' ? { bullet: true, pageBreakBefore: index === 1 && pageBreakBefore } : { prefix: `${index}. `, pageBreakBefore: index === 1 && pageBreakBefore }))
      }
    } else if (tag === 'BLOCKQUOTE') {
      const parts = element.querySelectorAll('p').length > 0 ? [...element.querySelectorAll('p')] : [element]
      for (const part of parts) out.push(await paragraph(part as HTMLElement, { quote: true, pageBreakBefore }))
    } else if (tag === 'PRE') {
      for (const line of (element.textContent ?? '').split('\n')) {
        out.push(new Paragraph({
          children: [new TextRun({ text: line || ' ', font: MONO, size: 19 })],
          shading: { type: ShadingType.CLEAR, fill: 'F5F5F5' },
          spacing: { before: 0, after: 0, line: 280 },
          pageBreakBefore: out.length === 0 && pageBreakBefore
        }))
      }
    } else if (tag === 'TABLE') out.push(await table(element as HTMLTableElement))
    else if (tag === 'IMG') out.push(await paragraph(element, { pageBreakBefore }))
    else if (tag === 'HR') out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'BBBBBB', space: 6 } }, spacing: { before: 160, after: 160 } }))
    else if (element.classList.contains('page-break')) out.push(new Paragraph({ children: [], pageBreakBefore: true }))
    else if (element.textContent?.trim()) out.push(await paragraph(element, { pageBreakBefore }))
  }
  return out
}

export async function htmlToDocxBase64(bodyHtml: string, title: string): Promise<string> {
  const template = document.createElement('template')
  template.innerHTML = bodyHtml
  const root = template.content.firstElementChild as HTMLElement | null
  const content = root ? await blocks(root) : []
  const doc = new Document({
    creator: 'Timber',
    title,
    description: 'Timber Markdown 导出',
    styles: { default: { document: { run: { font: FONT, size: 24 }, paragraph: { spacing: { line: 320 } } } } },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 } } },
      children: content.length > 0 ? content : [new Paragraph('')]
    }]
  })
  return Packer.toBase64String(doc)
}
