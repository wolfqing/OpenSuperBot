// 生成托盘图标：一个带两只眼睛的小圆团（和同事头像同一个样子）。
// macOS 用模板图（只有黑和透明，系统按深浅色自己上色）；Linux 用彩色的（深色面板上黑图看不见）。
// 跑法：node desktop/scripts/tray-icons.mjs（输出到 desktop/assets/，结果进版本库）
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')

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

/** 4×4 超采样抗锯齿 */
function icon(size, colors) {
  return png(size, (x, y) => {
    const acc = [0, 0, 0, 0]
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const part = shape((x + (sx + 0.5) / 4) / size, (y + (sy + 0.5) / 4) / size)
      const c = part ? colors[part] : null
      if (c) { acc[0] += c[0] * c[3]; acc[1] += c[1] * c[3]; acc[2] += c[2] * c[3]; acc[3] += c[3] }
    }
    const a = acc[3] / 16
    return a ? [Math.round(acc[0] / acc[3]), Math.round(acc[1] / acc[3]), Math.round(acc[2] / acc[3]), Math.round(a)] : [0, 0, 0, 0]
  })
}

const template = { body: [0, 0, 0, 255], eye: null, pupil: [0, 0, 0, 255] }
const colour = { body: [77, 159, 255, 255], eye: [255, 255, 255, 255], pupil: [20, 24, 32, 255] }
for (const [name, colors] of [['trayTemplate', template], ['tray', colour]]) {
  writeFileSync(join(OUT, `${name}.png`), icon(16, colors))
  writeFileSync(join(OUT, `${name}@2x.png`), icon(32, colors))
}
console.log('wrote tray icons to', OUT)
