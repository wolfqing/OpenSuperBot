import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Db } from './db.js'

/**
 * 操作者发给同事的文件。原件放网关自己的目录 <data>/uploads/<id>：不进任何 workspace，同事改不了，
 * 线程里看到和下载到的永远是操作者发的那一份。文件名只用 id，上传时给的名字只拿来显示。
 * 类型按内容认，不按声明认：这些文件之后要从网关自己的源上提供，认错了就是把别人的网页跑在操作者的登录下。
 */

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024
/** 请求体上限：base64 之后的大小，再留一点给 JSON 的名字和类型 */
export const MAX_UPLOAD_REQUEST_BYTES = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 4096
export const MAX_ATTACHMENTS = 8
/** 传上来却一直没挂到消息上的，留这么久 */
export const ORPHAN_MS = 24 * 3_600_000
/** 只防「几 KB 的文件撑爆浏览器缩略图」，不解码整张图 */
const MAX_IMAGE_SIDE = 10_000
const MAX_IMAGE_PIXELS = 50_000_000
const MAX_NAME_CHARS = 120
const MAX_COMPUTER_NAME_CHARS = 80

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
const TEXT_TYPES = ['text/plain', 'text/markdown'] as const
/** PDF 认得出来，但要等网关能把字抽出来才收：不收一个同事读不了的文件 */
export const ALLOWED_TYPES: readonly string[] = [...IMAGE_TYPES, ...TEXT_TYPES]
const ALIASES: Record<string, string> = { 'image/jpg': 'image/jpeg', 'text/x-markdown': 'text/markdown' }

const UPLOAD_ID = /^[0-9a-f]{32}$/

export type UploadErrorCode =
  | 'bad_request' | 'bad_base64' | 'too_large' | 'type_not_allowed' | 'type_mismatch' | 'image_too_big' | 'uploads_full'
export type ClaimErrorCode =
  | 'bad_request' | 'too_many_attachments' | 'attachment_unknown' | 'attachment_used' | 'attachment_repeated'

export type UploadRow = {
  id: string
  name: string
  mime: string
  size: number
  sha256: string
  width: number | null
  height: number | null
  thread_id: string | null
  message_id: number | null
  created_at: number
  deleted_at: number | null
}

/** 消息 payload 和接口回的都是这个形状 */
export type UploadView = { id: string; url: string; name: string; mime: string; size: number; width?: number; height?: number }

export type Sniffed = { mime: string; width?: number; height?: number }

const starts = (b: Buffer, bytes: number[], at = 0) => b.length >= at + bytes.length && bytes.every((v, i) => b[at + i] === v)
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

function jpegSize(b: Buffer): { width: number; height: number } | null {
  let at = 2
  while (at + 9 <= b.length) {
    if (b[at] !== 0xff) return null
    const marker = b[at + 1]!
    if (marker === 0xff) { at++; continue } // 填充字节
    // SOF0–SOF15 里带尺寸的那些（C4 是霍夫曼表、C8 保留、CC 是算术编码条件）
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(at + 5), width: b.readUInt16BE(at + 7) }
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { at += 2; continue } // 没有长度的段
    if (marker === 0xda || marker === 0xd9) return null // 到了图像数据还没见到 SOF
    at += 2 + b.readUInt16BE(at + 2)
  }
  return null
}

function webpSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 30) return null
  const chunk = b.toString('latin1', 12, 16)
  if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null
    const bits = b.readUInt32LE(21)
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }
  }
  if (chunk === 'VP8 ') {
    if (!starts(b, [0x9d, 0x01, 0x2a], 23)) return null
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
  }
  return null
}

/** 看文件头认类型；图片顺手读出宽高。认不出来（或图片头不完整）返回 null */
export function sniffType(b: Buffer): Sniffed | null {
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    if (b.length < 24 || b.toString('latin1', 12, 16) !== 'IHDR') return null
    return { mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
  }
  if (starts(b, [0xff, 0xd8, 0xff])) {
    const size = jpegSize(b)
    return size ? { mime: 'image/jpeg', ...size } : null
  }
  if (starts(b, ascii('GIF87a')) || starts(b, ascii('GIF89a'))) {
    if (b.length < 10) return null
    return { mime: 'image/gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) }
  }
  if (starts(b, ascii('RIFF')) && starts(b, ascii('WEBP'), 8)) {
    const size = webpSize(b)
    return size ? { mime: 'image/webp', ...size } : null
  }
  if (starts(b, ascii('%PDF-'))) return { mime: 'application/pdf' }
  if (b.length === 0 || b.includes(0)) return null
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b)
    return { mime: 'text/plain' }
  } catch {
    return null
  }
}

/** 只收规规矩矩的 base64：不带 data: 前缀、没有空白、填充齐全。别的一律当坏的，不去猜 */
export function decodeBase64Strict(data: unknown): Buffer | null {
  if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0) return null
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null
  const bytes = Buffer.from(data, 'base64')
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return bytes.length === (data.length / 4) * 3 - padding ? bytes : null
}

const chars = (s: string) => [...s]

/** 把名字截短但留住扩展名（太长的扩展名不算扩展名） */
function shorten(name: string, max: number): string {
  const all = chars(name)
  if (all.length <= max) return name
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? chars(name.slice(dot)) : []
  if (ext.length < 2 || ext.length > 10) return all.slice(0, max).join('')
  return all.slice(0, max - ext.length).join('') + ext.join('')
}

/** 显示用的名字：只留最后一段，去掉控制字符和改变文字方向的字符，空了就叫 file */
export function cleanName(name: unknown): string {
  const last = (typeof name === 'string' ? name : '').normalize('NFC').split(/[\\/]/).filter((part) => part.trim()).pop() ?? ''
  const cleaned = last
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim()
  return shorten(cleaned, MAX_NAME_CHARS) || 'file'
}

/**
 * 这个文件在同事电脑上的位置（相对 workspace）。id 的前 8 位打头：不用查重名，每位同事看到的路径一样，
 * Windows 上也不会撞上 CON、NUL 这些设备名。名字里只留字母、数字、点、横线和下划线。
 */
export function computerPath(upload: Pick<UploadRow, 'id' | 'name'>): string {
  const safe = cleanName(upload.name)
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/[. ]+$/, '')
  const prefix = `${upload.id.slice(0, 8)}-`
  return `uploads/${prefix}${shorten(safe || 'file', MAX_COMPUTER_NAME_CHARS - chars(prefix).length)}`
}

export const isImage = (mime: string): boolean => (IMAGE_TYPES as readonly string[]).includes(mime)

/**
 * 能放到模型眼前的图：按已知各家里最紧的一档取——Claude 经 Amazon Bedrock 时单张 base64 后不超过 5 MB、
 * 任何平台单边不超过 8000 px（Anthropic 的 vision 文档，2026-11 核对）。别家只会更宽，超了的图只给名字。
 */
export const MODEL_IMAGE_MAX_BYTES = 3_750_000
export const MODEL_IMAGE_MAX_SIDE = 8000
/** 一回合最多给模型看这么多张操作者发的图（等于一条消息能带的附件数；再多只给名字） */
export const MAX_IMAGES_PER_TURN = MAX_ATTACHMENTS

const KIND: Record<string, string> = {
  'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP', 'image/gif': 'GIF',
  'text/markdown': 'Markdown', 'text/plain': 'text', 'application/pdf': 'PDF',
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 这张图此刻在不在模型眼前；不在的话是为什么 */
export type ImageNote = 'now' | 'earlier' | 'no-vision' | 'too-large' | 'too-many'

const IMAGE_NOTE: Record<ImageNote, string> = {
  now: ', shown with this message.',
  earlier: ', shown to you earlier and not repeated here.',
  'no-vision': '. You cannot see images with your current model.',
  'too-large': '. It is too large to show to your model.',
  'too-many': '. It is not shown: too many images arrived at once.',
}

/**
 * 历史里一条附件消息在模型眼里的样子：一行说明。只在文件真的放到这位同事电脑上了才给路径——
 * 说了「在你电脑上」而其实不在，它会去读一个不存在的文件，然后编。
 */
export function describeUpload(
  upload: Pick<UploadRow, 'name' | 'mime' | 'size' | 'width' | 'height'>,
  where: { path?: string; image?: ImageNote; removed?: boolean },
): string {
  const image = isImage(upload.mime)
  const head = `[${image ? 'image' : 'file'} from your operator] ${upload.name}`
  if (where.removed) return `${head}. Your operator has removed it.`
  const facts = [KIND[upload.mime] ?? upload.mime, ...(upload.width && upload.height ? [`${upload.width}×${upload.height}`] : []), humanSize(upload.size)]
  const seen = image && where.image ? IMAGE_NOTE[where.image] : '.'
  const place = where.path ? `It is in your folder as ${where.path}.` : 'It is not on your computer.'
  return `${head} (${facts.join(', ')})${seen} ${place}`
}

export type Uploads = ReturnType<typeof createUploads>

export function createUploads(opts: { db: Db; dataDir: string; maxTotalBytes?: number; now?: () => number }) {
  const { db } = opts
  const dir = join(opts.dataDir, 'uploads')
  const now = opts.now ?? Date.now
  const maxTotal = opts.maxTotalBytes ?? 0
  const file = (id: string) => join(dir, id)

  const view = (u: UploadRow): UploadView => ({
    id: u.id, url: `/api/uploads/${u.id}`, name: u.name, mime: u.mime, size: u.size,
    ...(u.width && u.height ? { width: u.width, height: u.height } : {}),
  })

  function get(id: unknown): UploadRow | null {
    if (typeof id !== 'string' || !UPLOAD_ID.test(id)) return null
    return (db.prepare('SELECT * FROM uploads WHERE id = ?').get(id) as UploadRow | undefined) ?? null
  }

  const stored = (): number =>
    (db.prepare('SELECT COALESCE(SUM(size), 0) AS total FROM uploads WHERE deleted_at IS NULL').get() as { total: number }).total

  async function save(input: unknown): Promise<{ ok: true; upload: UploadRow } | { ok: false; code: UploadErrorCode; status: 400 | 413 | 415 | 507 }> {
    const refuse = (code: UploadErrorCode, status: 400 | 413 | 415 | 507) => ({ ok: false as const, code, status })
    const body = input && typeof input === 'object' ? input as { name?: unknown; mime?: unknown; data?: unknown } : {}
    if (typeof body.mime !== 'string' || typeof body.data !== 'string') return refuse('bad_request', 400)
    const declared = body.mime.trim().toLowerCase().split(';')[0]!.trim()
    const mime = ALIASES[declared] ?? declared
    if (!ALLOWED_TYPES.includes(mime)) return refuse('type_not_allowed', 415)
    // 先按 base64 的长度拦一道，别为一个注定要拒的文件解码几十兆
    if (body.data.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 4) return refuse('too_large', 413)
    const bytes = decodeBase64Strict(body.data)
    if (!bytes) return refuse('bad_base64', 400)
    if (bytes.length > MAX_UPLOAD_BYTES) return refuse('too_large', 413)
    const found = sniffType(bytes)
    const asText = (TEXT_TYPES as readonly string[]).includes(mime)
    if (!found || (asText ? found.mime !== 'text/plain' : found.mime !== mime)) return refuse('type_mismatch', 415)
    if (found.width !== undefined && found.height !== undefined) {
      if (found.width < 1 || found.height < 1) return refuse('type_mismatch', 415)
      if (found.width > MAX_IMAGE_SIDE || found.height > MAX_IMAGE_SIDE || found.width * found.height > MAX_IMAGE_PIXELS) {
        return refuse('image_too_big', 413)
      }
    }
    if (maxTotal > 0 && stored() + bytes.length > maxTotal) return refuse('uploads_full', 507)

    const row: UploadRow = {
      id: randomBytes(16).toString('hex'),
      name: cleanName(body.name),
      mime,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      width: found.width ?? null,
      height: found.height ?? null,
      thread_id: null,
      message_id: null,
      created_at: now(),
      deleted_at: null,
    }
    await mkdir(dir, { recursive: true })
    await writeFile(file(row.id), bytes, { flag: 'wx', mode: 0o600 })
    db.prepare(
      `INSERT INTO uploads (id, name, mime, size, sha256, width, height, created_at)
       VALUES (@id, @name, @mime, @size, @sha256, @width, @height, @created_at)`,
    ).run(row)
    return { ok: true, upload: row }
  }

  async function bytes(id: unknown): Promise<Buffer | null> {
    const row = get(id)
    if (!row || row.deleted_at !== null) return null
    return readFile(file(row.id)).catch(() => null)
  }

  /** 发消息前先验一遍：都在、都没用过、没有重复。真正挂上去由 attach 在落消息的那个事务里做 */
  function claim(list: unknown): { ok: true; uploads: UploadRow[] } | { ok: false; code: ClaimErrorCode } {
    if (list === undefined || list === null) return { ok: true, uploads: [] }
    if (!Array.isArray(list)) return { ok: false, code: 'bad_request' }
    if (list.length > MAX_ATTACHMENTS) return { ok: false, code: 'too_many_attachments' }
    const found: UploadRow[] = []
    for (const item of list) {
      const row = get((item as { id?: unknown } | null)?.id)
      if (!row || row.deleted_at !== null) return { ok: false, code: 'attachment_unknown' }
      if (row.message_id !== null) return { ok: false, code: 'attachment_used' }
      if (found.some((f) => f.id === row.id)) return { ok: false, code: 'attachment_repeated' }
      found.push(row)
    }
    return { ok: true, uploads: found }
  }

  function attach(id: string, threadId: string, messageId: number): void {
    db.prepare('UPDATE uploads SET thread_id = ?, message_id = ? WHERE id = ? AND message_id IS NULL').run(threadId, messageId, id)
  }

  /** 删文件、留记录（线程里那条消息要能显示「已移除」）。已经删过或不认识的返回 null */
  async function remove(id: unknown): Promise<UploadRow | null> {
    const row = get(id)
    if (!row || row.deleted_at !== null) return null
    const at = now()
    db.prepare('UPDATE uploads SET deleted_at = ? WHERE id = ?').run(at, row.id)
    await rm(file(row.id), { force: true })
    return { ...row, deleted_at: at }
  }

  function seen(botId: string, ids: string[]): Map<string, { placed: boolean; shown: boolean }> {
    const out = new Map<string, { placed: boolean; shown: boolean }>()
    if (!ids.length) return out
    const rows = db.prepare(
      `SELECT upload_id, placed_at, shown_at FROM upload_seen WHERE bot_id = ? AND upload_id IN (${ids.map(() => '?').join(',')})`,
    ).all(botId, ...ids) as { upload_id: string; placed_at: number | null; shown_at: number | null }[]
    for (const r of rows) out.set(r.upload_id, { placed: r.placed_at !== null, shown: r.shown_at !== null })
    return out
  }

  function markPlaced(id: string, botId: string): void {
    db.prepare(
      `INSERT INTO upload_seen (upload_id, bot_id, placed_at) VALUES (?, ?, ?)
       ON CONFLICT(upload_id, bot_id) DO UPDATE SET placed_at = COALESCE(placed_at, excluded.placed_at)`,
    ).run(id, botId, now())
  }

  function markShown(ids: string[], botId: string): void {
    const mark = db.prepare(
      `INSERT INTO upload_seen (upload_id, bot_id, shown_at) VALUES (?, ?, ?)
       ON CONFLICT(upload_id, bot_id) DO UPDATE SET shown_at = COALESCE(shown_at, excluded.shown_at)`,
    )
    const at = now()
    for (const id of ids) mark.run(id, botId, at)
  }

  /**
   * 收拾：没挂到消息上、放了一天的上传连记录一起删；目录里像我们的文件却没有记录的删掉；
   * 记录还在、文件没了的标成已移除（别让线程里留一个点了 404 的文件条）。不像我们的文件不碰。
   */
  async function sweep(onMissing?: (upload: UploadRow) => void): Promise<{ orphans: number; strays: number; missing: number }> {
    const cutoff = now() - ORPHAN_MS
    const orphans = db.prepare('SELECT id FROM uploads WHERE message_id IS NULL AND created_at < ?').all(cutoff) as { id: string }[]
    for (const { id } of orphans) {
      await rm(file(id), { force: true })
      db.prepare('DELETE FROM uploads WHERE id = ?').run(id)
    }
    const onDisk = new Set((await readdir(dir).catch(() => [] as string[])).filter((name) => UPLOAD_ID.test(name)))
    const live = db.prepare('SELECT * FROM uploads WHERE deleted_at IS NULL').all() as UploadRow[]
    let missing = 0
    for (const row of live) {
      if (onDisk.delete(row.id)) continue
      const at = now()
      db.prepare('UPDATE uploads SET deleted_at = ? WHERE id = ?').run(at, row.id)
      onMissing?.({ ...row, deleted_at: at })
      missing++
    }
    for (const name of onDisk) await rm(file(name), { force: true })
    return { orphans: orphans.length, strays: onDisk.size, missing }
  }

  return { save, get, bytes, view, claim, attach, remove, seen, markPlaced, markShown, sweep, stored }
}
