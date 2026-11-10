/**
 * 往容器电脑里放一个文件用的最小归档：沿途的目录各一条、文件一条，ustar 格式。
 * 只做这一件事，所以不为它引一个打包库。名字超过 100 字节（中文文件名很容易）时，前面加一条 PAX 扩展头带上完整路径。
 */

const BLOCK = 512
const NUL = String.fromCharCode(0)

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + NUL
}

function header(name: string, size: number, type: '0' | '5' | 'x', mode: number, mtimeSec: number): Buffer {
  const h = Buffer.alloc(BLOCK)
  Buffer.from(name, 'utf8').copy(h, 0, 0, 100) // 放不下的部分由 PAX 头补上
  h.write(octal(mode, 8), 100, 'latin1')
  h.write(octal(0, 8), 108, 'latin1') // uid
  h.write(octal(0, 8), 116, 'latin1') // gid
  h.write(octal(size, 12), 124, 'latin1')
  h.write(octal(mtimeSec, 12), 136, 'latin1')
  h.write('        ', 148, 'latin1') // 算校验和时这 8 格当空格
  h.write(type, 156, 'latin1')
  h.write(`ustar${NUL}00`, 257, 'latin1')
  const sum = h.reduce((acc, b) => acc + b, 0)
  h.write(`${sum.toString(8).padStart(6, '0')}${NUL} `, 148, 'latin1')
  return h
}

function padded(body: Buffer): Buffer {
  const rest = body.length % BLOCK
  return rest ? Buffer.concat([body, Buffer.alloc(BLOCK - rest)]) : body
}

/** PAX 记录是「长度 键=值\n」，长度把自己那几位数字也算进去 */
function paxPath(path: string): Buffer {
  const rest = ` path=${path}\n`
  let length = Buffer.byteLength(rest) + 1
  while (Buffer.byteLength(`${length}${rest}`) !== length) length = Buffer.byteLength(`${length}${rest}`)
  return Buffer.from(`${length}${rest}`, 'utf8')
}

/** path 是相对路径（如 uploads/1a2b3c4d-notes.md）；解到哪个目录下由调用方决定 */
export function tarFile(path: string, bytes: Buffer, mtimeMs: number = Date.now()): Buffer {
  const parts = path.split('/')
  if (path.startsWith('/') || path.includes('\\') || parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new Error(`not a safe relative path: ${path}`)
  }
  const mtime = Math.max(0, Math.floor(mtimeMs / 1000))
  const blocks: Buffer[] = []
  for (let i = 1; i < parts.length; i++) blocks.push(header(`${parts.slice(0, i).join('/')}/`, 0, '5', 0o755, mtime))
  if (Buffer.byteLength(path) > 100) {
    const record = paxPath(path)
    blocks.push(header('PaxHeader/upload', record.length, 'x', 0o644, mtime), padded(record))
  }
  blocks.push(header(path, bytes.length, '0', 0o644, mtime), padded(bytes), Buffer.alloc(BLOCK * 2))
  return Buffer.concat(blocks)
}
