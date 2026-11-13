import { useId, type CSSProperties, type ReactNode } from 'react'

/**
 * 同事头像：一个纯色的小形状 + 一双会动的眼睛，取代原来的 emoji。
 * 长相（形状、颜色、眼型、腮红）由 id 哈希稳定地推出来，不用存库；
 * 状态靠动作表达（index.css 里的 av-* 动画）：闲着眨眼张望、干活时颠着往上看、等你时蹦一下、
 * 卡住时摇头眯眼、干完了笑成弯月。
 */

type Shape = 'orb' | 'squircle' | 'capsule' | 'egg' | 'diamond' | 'flower' | 'star' | 'cat' | 'bubble' | 'duo'

/** 每种形状的身体，以及眼睛放哪（32×32 画布里的中心高度和半间距） */
const SHAPES: Record<Shape, { body: ReactNode; eyeY: number; gap: number }> = {
  orb: { body: <circle cx="16" cy="16" r="13" />, eyeY: 15, gap: 4.6 },
  squircle: { body: <rect x="3.5" y="3.5" width="25" height="25" rx="9" />, eyeY: 15, gap: 4.8 },
  capsule: { body: <rect x="5.5" y="2.5" width="21" height="27" rx="10.5" />, eyeY: 13.5, gap: 4.4 },
  egg: { body: <path d="M16 3c6.5 0 11.5 7.5 11.5 14.5S22.5 29 16 29 4.5 24.5 4.5 17.5 9.5 3 16 3z" />, eyeY: 17, gap: 4.4 },
  diamond: { body: <rect x="6" y="6" width="20" height="20" rx="6.5" transform="rotate(45 16 16)" />, eyeY: 16, gap: 4.2 },
  flower: {
    body: (
      <>
        <circle cx="16" cy="16" r="9.5" />
        {[0, 1, 2, 3, 4, 5].map((i) => {
          const a = (Math.PI / 3) * i - Math.PI / 2
          return <circle key={i} cx={16 + 8 * Math.cos(a)} cy={16 + 8 * Math.sin(a)} r="5.4" />
        })}
      </>
    ),
    eyeY: 16, gap: 4.2,
  },
  star: {
    body: <path d="M16 5.5l3.1 6.3 6.9 1-5 4.9 1.2 6.9L16 21.3l-6.2 3.3 1.2-6.9-5-4.9 6.9-1z" strokeWidth="5" strokeLinejoin="round" data-outlined="" />,
    eyeY: 16, gap: 3.6,
  },
  cat: {
    body: (
      <>
        <rect x="4" y="9" width="24" height="20" rx="8" />
        <path d="M6 15V6l8 4.5z" strokeWidth="3" strokeLinejoin="round" data-outlined="" />
        <path d="M26 15V6l-8 4.5z" strokeWidth="3" strokeLinejoin="round" data-outlined="" />
      </>
    ),
    eyeY: 18.5, gap: 4.6,
  },
  bubble: { body: <path d="M16 3c8 0 13 5 13 13s-5 13-13 13H7a4 4 0 0 1-4-4v-9C3 8 8 3 16 3z" />, eyeY: 15.5, gap: 4.6 },
  // 群聊：后面再探出半个脑袋
  duo: { body: <circle cx="13.5" cy="18" r="11" />, eyeY: 17.5, gap: 4 },
}

/** [亮部, 主色]：身体是很浅的一道渐变，看着是纯色但不死板 */
const COLORS: [string, string][] = [
  ['#5b9dff', '#2f6bf0'], // blue
  ['#ff8a4c', '#f1590f'], // orange
  ['#2dd4bf', '#0d9f8e'], // teal
  ['#ff6b6b', '#e03a3a'], // red
  ['#ff6fb5', '#e0398a'], // pink
  ['#a78bfa', '#7c4ff0'], // violet
  ['#ffc145', '#ee9a0a'], // amber
  ['#4ade80', '#18a84f'], // green
  ['#818cf8', '#4f52e0'], // indigo
  ['#38bdf8', '#0b8fd0'], // sky
]

/** 自带的几位同事给定长相，免得哈希撞脸；键是 SOUL.md 里的 emoji */
const PRESETS: Record<string, [Shape, number]> = {
  '🔎': ['bubble', 0], '🔍': ['bubble', 0],
  '📈': ['diamond', 7], '📊': ['diamond', 7],
  '📥': ['capsule', 6], '📬': ['capsule', 6],
  '🎖': ['star', 5], '🏅': ['star', 5],
}

const POOL: Shape[] = ['orb', 'squircle', 'capsule', 'egg', 'diamond', 'flower', 'star', 'cat', 'bubble']

function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  // 末尾再搅一次，让各个位段互不相关
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  return h >>> 0
}

export type AvatarLook = { shape: Shape; color: number; tallEyes: boolean; blush: boolean; delay: number }

export function avatarLook(seed: string, emoji?: string): AvatarLook {
  const h = hash(seed)
  const rest = { tallEyes: ((h >>> 13) & 1) === 1, blush: ((h >>> 17) & 1) === 1, delay: ((h >>> 19) % 50) / 10 }
  const e = (emoji ?? '').replace(/️/g, '')
  if (e === '👥') return { shape: 'duo', color: (h >>> 7) % COLORS.length, ...rest }
  const preset = PRESETS[e]
  if (preset) return { shape: preset[0], color: preset[1], ...rest }
  return { shape: POOL[h % POOL.length], color: (h >>> 7) % COLORS.length, ...rest }
}

/** 单聊用同事的 id 当种子，这样侧栏、群里发言、@ 菜单里是同一张脸 */
export function conversationSeed(c: { id: string; kind: 'dm' | 'group'; members: string[] }): string {
  return c.kind === 'dm' ? c.members[0] ?? c.id : c.id
}

type Props = {
  seed: string
  emoji?: string
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  state?: string
  title?: string
}

const INK = '#141821'

export function BotAvatar({ seed, emoji, size = 'md', state, title }: Props) {
  const look = avatarLook(seed, emoji)
  const { body, eyeY, gap } = SHAPES[look.shape]
  const [light, base] = COLORS[look.color]
  const fill = `av-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const rx = look.tallEyes ? 2.5 : 3
  const ry = look.tallEyes ? 3.6 : 3
  const eyes = [16 - gap, 16 + gap]
  return (
    <span
      className={`avatar avatar-${size}`}
      data-state={state}
      data-shape={look.shape}
      title={title}
      style={{ '--av-delay': `-${look.delay}s` } as CSSProperties}
    >
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <defs>
          <linearGradient id={fill} gradientUnits="userSpaceOnUse" x1="6" y1="3" x2="26" y2="30">
            <stop offset="0" stopColor={light} />
            <stop offset="1" stopColor={base} />
          </linearGradient>
        </defs>
        <g className="av-body">
          {look.shape === 'duo' ? <circle cx="22.5" cy="11" r="7.5" fill={light} opacity="0.55" /> : null}
          <g fill={`url(#${fill})`} stroke={`url(#${fill})`} strokeWidth="0">{body}</g>
          {look.blush ? (
            <g fill="#fff" opacity="0.28">
              <ellipse cx={eyes[0] - 2.6} cy={eyeY + 4.4} rx="1.9" ry="1.2" />
              <ellipse cx={eyes[1] + 2.6} cy={eyeY + 4.4} rx="1.9" ry="1.2" />
            </g>
          ) : null}
          <g className="av-eyes">
            {eyes.map((cx) => (
              <g key={cx}>
                <ellipse cx={cx} cy={eyeY} rx={rx} ry={ry} fill="#fff" />
                <circle className="av-pupil" cx={cx} cy={eyeY + 0.3} r="1.55" fill={INK} />
              </g>
            ))}
          </g>
          <g className="av-happy" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round">
            {eyes.map((cx) => (
              <path key={cx} d={`M${cx - 2.6} ${eyeY + 1}q2.6 -3.4 5.2 0`} />
            ))}
          </g>
        </g>
      </svg>
    </span>
  )
}
