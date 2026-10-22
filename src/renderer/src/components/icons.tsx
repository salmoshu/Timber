/** 标题栏 / 工具栏内联 SVG 图标集（v0.5.7）：currentColor 描边、同字号同粗细，
 *  替代字体渲染不一致的 Unicode 符号（▢/❐、☰/▤、⌸），成对图标保证视觉同源。 */

/** 窗口最大化（未最大化态）：单矩形框 */
export function IconMaximize({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

/** 窗口还原（已最大化态）：两个重叠矩形（后矩形在被遮挡处留缺口，线条不交叉） */
export function IconRestore({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path
        d="M5.5 5.2 V3.2 a1 1 0 0 1 1-1 h6.3 a1 1 0 0 1 1 1 v6.3 a1 1 0 0 1-1 1 h-2"
        fill="none" stroke="currentColor" strokeWidth="1.5"
      />
      <rect x="2.2" y="5.7" width="8.1" height="8.1" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

/** 左侧边栏开关：面板图标（左侧栏位），与 IconPanelRight 成对镜像 */
export function IconPanelLeft({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <rect x="2" y="2.8" width="12" height="10.4" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <line x1="6.2" y1="2.8" x2="6.2" y2="13.2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

/** 右侧边栏开关：面板图标（右侧栏位） */
export function IconPanelRight({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <rect x="2" y="2.8" width="12" height="10.4" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <line x1="9.8" y1="2.8" x2="9.8" y2="13.2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

/** 保存：通用软盘图标（替代自定义的 ⌸ 字符） */
export function IconSave({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  )
}

/** 导出 PDF：文档 + 向下箭头 */
export function IconExportPdf({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <polyline points="9 14.5 12 17.5 15 14.5" />
    </svg>
  )
}

/** 查找：上一个（chevron 上），与 IconChevronDown 成对 */
export function IconChevronUp({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path d="M3.5 10.5 8 6l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 查找：下一个（chevron 下） */
export function IconChevronDown({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path d="M3.5 5.5 8 10l4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
