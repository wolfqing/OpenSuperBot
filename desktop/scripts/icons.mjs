// 生成图标：一个带两只眼睛的小圆团（和同事头像同一个样子）。
//   托盘：macOS 用模板图（只有黑和透明，系统按深浅色自己上色）；Linux 用彩色的（深色面板上黑图看不见）。→ desktop/assets/
//   App 图标：1024×1024，深色圆角方块上放一个彩色小圆团，留出 macOS 图标网格的边距。→ desktop/resources/icon.png
//   （electron-builder 从它生成 macOS 的 icns 和 Linux 的各尺寸图标）
// 跑法：node desktop/scripts/icons.mjs（结果进版本库）
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'assets')
const APP_ICON = join(HERE, '..', 'resources', 'icon.png')

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td))
  return Buffer.concat([len, td, c])
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) raw.set(pixel(x, y), y * (size * 4 + 1) + 1 + x * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** 在 0..1 的坐标里：身体（略扁的圆）里挖两只眼睛；返回 'body' | 'eye' | 'pupil' | null */
function shape(u, v) {
  const inEye = (cx) => ((u - cx) / 0.11) ** 2 + ((v - 0.46) / 0.15) ** 2 <= 1
  const inPupil = (cx) => ((u - cx - 0.02) / 0.05) ** 2 + ((v - 0.49) / 0.07) ** 2 <= 1
  const body = ((u - 0.5) / 0.44) ** 2 + ((v - 0.54) / 0.4) ** 2 <= 1
  if (!body) return null
  for (const cx of [0.36, 0.64]) {
    if (inPupil(cx)) return 'pupil'
    if (inEye(cx)) return 'eye'
  }
  return 'body'
}

/** 4×4 超采样抗锯齿；paint(u, v) 返回 [r, g, b, a] 或 null */
function render(size, paint) {
  return png(size, (x, y) => {
    const acc = [0, 0, 0, 0]
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const c = paint((x + (sx + 0.5) / 4) / size, (y + (sy + 0.5) / 4) / size)
      if (c) { acc[0] += c[0] * c[3]; acc[1] += c[1] * c[3]; acc[2] += c[2] * c[3]; acc[3] += c[3] }
    }
    const a = acc[3] / 16
    return a ? [Math.round(acc[0] / acc[3]), Math.round(acc[1] / acc[3]), Math.round(acc[2] / acc[3]), Math.round(a)] : [0, 0, 0, 0]
  })
}

function icon(size, colors) {
  return render(size, (u, v) => { const part = shape(u, v); return part ? colors[part] : null })
}

/**
 * App 图标。macOS 的图标网格：1024 的画布里内容是居中的 824×824 圆角方块（圆角约 185），四周留 100 的边。
 * 方块是深色、上面略亮的竖向渐变；小圆团占方块的六成，用同事头像的蓝。
 */
function appIcon(size) {
  const M = 100 / 1024, R = 185 / 1024, S = 1 - 2 * M
  const inSquircle = (u, v) => {
    if (u < M || u > 1 - M || v < M || v > 1 - M) return false
    const dx = Math.max(M + R - u, 0, u - (1 - M - R)), dy = Math.max(M + R - v, 0, v - (1 - M - R))
    return dx * dx + dy * dy <= R * R
  }
  const blob = 0.6
  return render(size, (u, v) => {
    if (!inSquircle(u, v)) return null
    const part = shape(0.5 + (u - 0.5) / (S * blob), 0.5 + (v - 0.5) / (S * blob))
    if (part) return colour[part]
    const t = (v - M) / S // 0 顶 → 1 底
    return [Math.round(40 - 16 * t), Math.round(46 - 18 * t), Math.round(60 - 22 * t), 255]
  })
}

const template = { body: [0, 0, 0, 255], eye: null, pupil: [0, 0, 0, 255] }
const colour = { body: [77, 159, 255, 255], eye: [255, 255, 255, 255], pupil: [20, 24, 32, 255] }
for (const [name, colors] of [['trayTemplate', template], ['tray', colour]]) {
  writeFileSync(join(OUT, `${name}.png`), icon(16, colors))
  writeFileSync(join(OUT, `${name}@2x.png`), icon(32, colors))
}
console.log('wrote tray icons to', OUT)
mkdirSync(dirname(APP_ICON), { recursive: true })
writeFileSync(APP_ICON, appIcon(1024))
console.log('wrote the app icon to', APP_ICON)
