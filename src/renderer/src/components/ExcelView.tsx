import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'

const MAX_ROWS = 1000
const MAX_COLS = 100

export default function ExcelView({ url, title }: { url: string; title: string }) {
  const [workbook, setWorkbook] = useState<XLSX.WorkBook | null>(null)
  const [activeSheet, setActiveSheet] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setWorkbook(null)
    setError('')
    void (async () => {
      try {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const book = XLSX.read(await response.arrayBuffer(), { type: 'array', cellDates: true })
        if (book.SheetNames.length === 0) throw new Error('工作簿中没有工作表')
        if (cancelled) return
        setWorkbook(book)
        setActiveSheet(book.SheetNames[0])
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => { cancelled = true }
  }, [url])

  const rows = useMemo(() => {
    const sheet = workbook?.Sheets[activeSheet]
    if (!sheet) return []
    return XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: false,
      defval: '',
      blankrows: false
    }).slice(0, MAX_ROWS).map((row) => row.slice(0, MAX_COLS).map((cell) => String(cell ?? '')))
  }, [workbook, activeSheet])

  if (error) {
    return (
      <div className="reader-empty">
        <div className="re-error">
          <div className="re-error-icon">⚠</div>
          <div className="re-error-title">Excel 打开失败</div>
          <div className="re-error-desc">{error}</div>
        </div>
      </div>
    )
  }
  if (!workbook) return <div className="reader-empty"><div className="re-hint">正在解析 Excel…</div></div>

  const totalRows = workbook.Sheets[activeSheet] && XLSX.utils.decode_range(workbook.Sheets[activeSheet]['!ref'] ?? 'A1').e.r + 1
  return (
    <div className="excel-view">
      <div className="excel-toolbar">
        <div className="excel-sheets" role="tablist" aria-label="工作表">
          {workbook.SheetNames.map((name) => (
            <button
              key={name}
              role="tab"
              aria-selected={activeSheet === name}
              className={activeSheet === name ? 'active' : ''}
              onClick={() => setActiveSheet(name)}
            >
              {name}
            </button>
          ))}
        </div>
        <span className="excel-meta" title={title}>{activeSheet} · {totalRows} 行</span>
      </div>
      <div className="excel-table-wrap">
        <table className="excel-table">
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                <th className="excel-row-number">{rowIndex + 1}</th>
                {row.map((cell, colIndex) => <td key={colIndex}>{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="sb-empty">当前工作表为空</div>}
        {(totalRows > MAX_ROWS || rows.some((row) => row.length >= MAX_COLS)) && (
          <div className="excel-truncated">为保证阅读性能，仅显示前 {MAX_ROWS} 行、前 {MAX_COLS} 列</div>
        )}
      </div>
    </div>
  )
}
