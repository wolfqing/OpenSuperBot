/** 最小但文件头真实的样本：只够让「按内容认类型」和读宽高的代码有东西可读，不是能显示的图 */

function u32be(n: number): number[] { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255] }
function u16be(n: number): number[] { return [(n >>> 8) & 255, n & 255] }
function u16le(n: number): number[] { return [n & 255, (n >>> 8) & 255] }
function u24le(n: number): number[] { return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255] }
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

export function png(width = 4, height = 3): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...u32be(13), ...ascii('IHDR'), ...u32be(width), ...u32be(height), 8, 6, 0, 0, 0, 0, 0, 0, 0,
    ...u32be(0), ...ascii('IEND'), 0xae, 0x42, 0x60, 0x82,
  ])
}

export function jpeg(width = 4, height = 3): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, ...u16be(16), ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xc0, ...u16be(11), 8, ...u16be(height), ...u16be(width), 1, 1, 0x11, 0,
    0xff, 0xd9,
  ])
}

export function gif(width = 4, height = 3): Buffer {
  return Buffer.from([...ascii('GIF89a'), ...u16le(width), ...u16le(height), 0, 0, 0, 0x3b])
}

/** VP8X（扩展格式）的 WebP 头：宽高各存「减一」的 24 位小端 */
export function webp(width = 4, height = 3): Buffer {
  const chunk = [...ascii('VP8X'), ...[10, 0, 0, 0], 0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)]
  const body = [...ascii('WEBP'), ...chunk]
  return Buffer.from([...ascii('RIFF'), body.length & 255, (body.length >>> 8) & 255, 0, 0, ...body])
}

export const pdf = (): Buffer => Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'latin1')
export const html = (): Buffer => Buffer.from('<!doctype html><script>alert(1)</script>', 'utf8')
export const b64 = (bytes: Buffer): string => bytes.toString('base64')
