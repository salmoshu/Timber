// 应用 Logo（与 resources/logo.svg 同源）：Kimi 式 squircle + Timber 的「树干 · 开枝散叶」。
// 设计理念：
//   · squircle 底板与几何化圆头线条 —— Kimi「理性秩序」；95% 中性色，唯一品牌蓝只做强调。
//   · 树干 = Timber 的字面（木/主干），也是提交历史的时间主干；分枝 = 项目长出的架构与能力；
//     枝端圆点 = 一次次提交结出的叶与果。
//   · 树冠最高处的蓝点 —— Kimi 的标志性蓝点，代表此刻最新的一次生长。
// 动画（animated 默认 true，约 1.8s 只播一次定格）：主干自下而上描边生长 → 主枝向两侧展开 →
// 次枝抽出 → 枝端叶片逐片冒出（带回弹）→ 最高处蓝点最后点亮，随后以 2.6s 周期
// 极轻微脉动（呼应 Kimi「icons pulse as you interact」）。prefers-reduced-motion 或
// animated=false 直接呈现静态终帧。关键帧定义在 styles.css「Logo 动画（0.5.3）」段。
import type { CSSProperties } from 'react'

const BLUE = '#1783FF'

type Stroke = {
  d: string
  width: number
  opacity: number
  /** 入场延迟/时长（秒） */
  delay: number
  dur: number
  /** 小于该尺寸时不渲染 */
  minSize?: number
}

type Leaf = {
  cx: number
  cy: number
  r: number
  opacity?: number
  blue?: boolean
  delay: number
  minSize?: number
}

// 所有枝条均为圆头描边：主干（底→顶）、两级分枝。整体包围盒中心 ≈ (252, 258)。
const STROKES: Stroke[] = [
  // 主干：自下而上生长
  { d: 'M 256 374 L 256 176', width: 52, opacity: 0.95, delay: 0.06, dur: 0.5 },
  // 一级分枝：向两侧展开
  { d: 'M 256 300 L 162 192', width: 30, opacity: 0.82, delay: 0.42, dur: 0.42 },
  { d: 'M 256 272 L 352 178', width: 30, opacity: 0.82, delay: 0.52, dur: 0.42 },
  // 二级分枝：更细、更淡，角度更平（越低越趋水平，接近真树的枝序）；16px 级小图标下省略
  { d: 'M 212 250 L 110 210', width: 18, opacity: 0.64, delay: 0.7, dur: 0.36, minSize: 30 },
  { d: 'M 304 225 L 388 194', width: 18, opacity: 0.64, delay: 0.8, dur: 0.36, minSize: 30 }
]

// 叶片：枝端结果；树冠最高处一片为品牌蓝（最后点亮）
const LEAVES: Leaf[] = [
  { cx: 162, cy: 192, r: 21, opacity: 0.86, delay: 1.02 },
  { cx: 352, cy: 178, r: 21, opacity: 0.86, delay: 1.12 },
  { cx: 110, cy: 210, r: 15, opacity: 0.68, delay: 1.2, minSize: 30 },
  { cx: 388, cy: 194, r: 15, opacity: 0.68, delay: 1.28, minSize: 30 },
  { cx: 256, cy: 146, r: 30, blue: true, delay: 1.36 }
]

export default function Logo({ size = 20, animated = true }: { size?: number; animated?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      className={animated ? 'timber-logo' : undefined}
      aria-label="Timber"
    >
      <defs>
        <linearGradient id="timber-shell" x1="0" y1="0" x2="0.6" y2="1">
          <stop offset="0" stopColor="#1A1A1A" />
          <stop offset="1" stopColor="#0D0D0D" />
        </linearGradient>
      </defs>

      {/* squircle 底板：近黑中性色，暗色界面下以极细描边勾勒轮廓 */}
      <path
        className={animated ? 'timber-shell' : undefined}
        d="M256 8 C396 8 504 116 504 256 C504 396 396 504 256 504 C116 504 8 396 8 256 C8 116 116 8 256 8 Z"
        fill="url(#timber-shell)"
        stroke="#FFFFFF"
        strokeOpacity="0.12"
        strokeWidth="2"
      />

      {/* 树干与枝条 */}
      {STROKES.filter((s) => size >= (s.minSize ?? 0)).map((s, i) => (
        <path
          key={i}
          className={animated ? 'timber-stroke' : undefined}
          d={s.d}
          pathLength={100}
          fill="none"
          stroke="#FFFFFF"
          strokeOpacity={s.opacity}
          strokeWidth={s.width}
          strokeLinecap="round"
          style={
            animated
              ? ({ animationDelay: `${s.delay}s`, animationDuration: `${s.dur}s` } as CSSProperties)
              : undefined
          }
        />
      ))}

      {/* 叶片；树冠最高处的蓝点即 Kimi 的“此刻”（延迟由 CSS 固定，避免覆盖双动画时序） */}
      {LEAVES.filter((l) => size >= (l.minSize ?? 0)).map((l, i) => (
        <circle
          key={i}
          className={animated ? (l.blue ? 'timber-now' : 'timber-leaf') : undefined}
          cx={l.cx}
          cy={l.cy}
          r={l.r}
          fill={l.blue ? BLUE : '#FFFFFF'}
          fillOpacity={l.blue ? 1 : l.opacity ?? 0.85}
          style={
            animated && !l.blue
              ? ({ animationDelay: `${l.delay}s` } as CSSProperties)
              : undefined
          }
        />
      ))}
    </svg>
  )
}
