import type { Hono } from 'hono'
import { readBodyUpTo } from './body.js'
import {
  MAX_UPLOAD_REQUEST_BYTES, isImage, type ClaimErrorCode, type UploadErrorCode, type UploadRow, type Uploads,
} from './uploads.js'

/** 接口回的英文说明（日志和别的客户端看这个）；界面按 code 翻译 */
export const UPLOAD_ERRORS: Record<UploadErrorCode, string> = {
  bad_request: 'send { name, mime, data } as JSON, with data as base64',
  bad_base64: 'data is not valid base64',
  too_large: 'the file is larger than 8 MB',
  type_not_allowed: 'this kind of file is not accepted',
  type_mismatch: 'the file is not what its type says it is',
  image_too_big: 'the image has too many pixels',
  uploads_full: 'the uploads folder is full',
}

export const CLAIM_ERRORS: Record<ClaimErrorCode, string> = {
  bad_request: 'attachments must be a list of { id }',
  too_many_attachments: 'a message can carry at most 8 attachments',
  attachment_unknown: 'an attachment is not an upload this gateway has',
  attachment_used: 'an attachment was already sent in another message',
  attachment_repeated: 'the same attachment is listed twice',
}

/** RFC 5987：encodeURIComponent 放过的 ' ( ) * 在这里也得转 */
const headerName = (name: string) => encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

/**
 * 上传、取回、移除。走 JSON + base64：改状态的请求只收 application/json 是防跨站表单的那道闸，不为上传开例外。
 * 取回时的响应头是第二道保险：类型已经按内容认过，这里再保证它在网关自己的源上永远不会被当成网页跑。
 */
export function mountUploads(app: Hono, deps: { uploads: Uploads | null; onRemoved: (upload: UploadRow) => void }): void {
  const { uploads } = deps

  app.post('/api/uploads', async (c) => {
    if (!uploads) return c.json({ error: 'uploads need a data folder' }, 503)
    const tooLarge = () => c.json({ error: UPLOAD_ERRORS.too_large, code: 'too_large' }, 413)
    if (Number(c.req.header('content-length') ?? 0) > MAX_UPLOAD_REQUEST_BYTES) return tooLarge()
    const raw = await readBodyUpTo(c.req.raw.body, MAX_UPLOAD_REQUEST_BYTES)
    if (raw === null) return tooLarge()
    let body: unknown
    try {
      body = JSON.parse(raw.toString('utf8'))
    } catch {
      return c.json({ error: UPLOAD_ERRORS.bad_request, code: 'bad_request' }, 400)
    }
    const saved = await uploads.save(body)
    if (!saved.ok) return c.json({ error: UPLOAD_ERRORS[saved.code], code: saved.code }, saved.status)
    return c.json(uploads.view(saved.upload), 201)
  })

  app.get('/api/uploads/:id', async (c) => {
    const upload = uploads?.get(c.req.param('id'))
    if (!upload) return c.json({ error: 'not found' }, 404)
    const bytes = upload.deleted_at === null ? await uploads!.bytes(upload.id) : null
    if (!bytes) return c.json({ error: 'this file was removed' }, 410)
    const image = isImage(upload.mime)
    return c.body(new Uint8Array(bytes), 200, {
      'Content-Type': upload.mime.startsWith('text/') ? `${upload.mime}; charset=utf-8` : upload.mime,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': `${image ? 'inline' : 'attachment'}; filename*=UTF-8''${headerName(upload.name)}`,
      'Cache-Control': 'private, max-age=31536000, immutable',
    })
  })

  /** 移除：文件删掉，线程里那条消息留着并标成已移除。已经放到同事电脑上的那份不追删 */
  app.delete('/api/uploads/:id', async (c) => {
    const removed = await uploads?.remove(c.req.param('id'))
    if (!removed) return c.json({ error: 'not found' }, 404)
    deps.onRemoved(removed)
    return c.body(null, 204)
  })
}
