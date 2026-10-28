// 平滑滚动工具：scrollIntoView({ behavior: 'smooth' }) 在部分嵌入环境（IAB）
// 静默无效，统一改用 rAF 动画，效果一致且环境无关。

export function smoothScrollTo(container: HTMLElement, targetTop: number, duration = 120): void {
  const start = container.scrollTop
  const delta = targetTop - start
  if (Math.abs(delta) < 2 || duration <= 0) {
    container.scrollTop = targetTop
    return
  }
  const t0 = performance.now()
  const step = (t: number): void => {
    const k = Math.min(1, (t - t0) / duration)
    const ease = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
    container.scrollTop = start + delta * ease
    if (k < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

/** 滚动阅读区使元素可见：默认顶部对齐，center 时居中 */
export function scrollToEl(el: Element, opts?: { center?: boolean; duration?: number }): void {
  const container = el.closest('.reader-body') as HTMLElement | null
  if (!container) {
    el.scrollIntoView({ block: opts?.center ? 'center' : 'start' })
    return
  }
  const bodyRect = container.getBoundingClientRect()
  const elRect = el.getBoundingClientRect()
  const current = elRect.top - bodyRect.top + container.scrollTop
  const target = opts?.center
    ? current - container.clientHeight / 2 + elRect.height / 2
    : current - 12
  smoothScrollTo(container, Math.max(0, target), opts?.duration ?? 120)
}
