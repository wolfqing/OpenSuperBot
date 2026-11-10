import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { insertMessage, openDb, upsertBot } from '../src/db.js'
import type { PdfReader } from '../src/pdf-text.js'
import {
  MAX_UPLOAD_BYTES, cleanName, computerPath, createUploads, decodeBase64Strict, describeUpload, sniffType,
} from '../src/uploads.js'
import { makePdf } from './fixtures/pdf-samples.js'
import { b64, gif, html, jpeg, pdf, png, webp } from './fixtures/upload-samples.js'

function setup(opts: { maxTotalBytes?: number; now?: () => number; pdf?: PdfReader } = {}) {
  const db = openDb(':memory:')
  upsertBot(db, { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' })
  const dataDir = mkdtempSync(join(tmpdir(), 'osb-uploads-'))
  const uploads = createUploads({ db, dataDir, ...opts })
  return { db, dataDir, uploads }
}

describe('recognising a file by its content', () => {
  it('reads the type and the size in pixels from the header of each image format', () => {
    expect(sniffType(png(640, 480))).toEqual({ mime: 'image/png', width: 640, height: 480 })
    expect(sniffType(jpeg(1024, 768))).toEqual({ mime: 'image/jpeg', width: 1024, height: 768 })
    expect(sniffType(gif(32, 16))).toEqual({ mime: 'image/gif', width: 32, height: 16 })
    expect(sniffType(webp(300, 200))).toEqual({ mime: 'image/webp', width: 300, height: 200 })
  })

  it('knows a PDF, plain text, and neither', () => {
    expect(sniffType(pdf())).toEqual({ mime: 'application/pdf' })
    expect(sniffType(Buffer.from('# Notes\n\n你好，世界\n', 'utf8'))).toEqual({ mime: 'text/plain' })
    expect(sniffType(Buffer.from([0x00, 0x01, 0x02, 0xff]))).toBeNull()
    expect(sniffType(Buffer.from([0xc3, 0x28]))).toBeNull() // 不是合法 UTF-8
    expect(sniffType(Buffer.from('a\u0000b', 'utf8'))).toBeNull()
  })

  it('does not take an image whose header is cut short', () => {
    expect(sniffType(png().subarray(0, 20))).toBeNull()
    expect(sniffType(jpeg().subarray(0, 6))).toBeNull()
  })
})

describe('strict base64', () => {
  it('decodes what is well formed and refuses the rest', () => {
    expect(decodeBase64Strict('aGVsbG8=')?.toString()).toBe('hello')
    expect(decodeBase64Strict('')).toBeNull()
    expect(decodeBase64Strict('aGVsbG8')).toBeNull() // 少了填充
    expect(decodeBase64Strict('aGV sbG8=')).toBeNull()
    expect(decodeBase64Strict('data:image/png;base64,aGVsbG8=')).toBeNull()
    expect(decodeBase64Strict('aGVsbG8=\n')).toBeNull()
    expect(decodeBase64Strict(42 as unknown as string)).toBeNull()
  })
})

describe('file names', () => {
  it('keeps a display name readable and free of paths and control characters', () => {
    expect(cleanName('../../etc/passwd')).toBe('passwd')
    expect(cleanName('C:\\Users\\me\\报告 final.pdf')).toBe('报告 final.pdf')
    expect(cleanName('a\u0000b\nc\u202e.txt')).toBe('abc.txt')
    expect(cleanName('...hidden')).toBe('hidden')
    expect(cleanName('   ')).toBe('file')
    expect(cleanName(undefined)).toBe('file')
    expect([...cleanName(`${'x'.repeat(300)}.png`)].length).toBeLessThanOrEqual(120)
  })

  it('builds the path on a teammate computer from the id and a safe form of the name', () => {
    const id = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
    expect(computerPath({ id, name: 'Q3 报告 (final).md' })).toBe('uploads/a1b2c3d4-Q3_报告_final_.md')
    expect(computerPath({ id, name: 'con' })).toBe('uploads/a1b2c3d4-con')
    expect(computerPath({ id, name: 'a<b>:"|?*.txt' })).toBe('uploads/a1b2c3d4-a_b_.txt')
    const long = computerPath({ id, name: `${'长'.repeat(200)}.jpeg` })
    expect(long.endsWith('.jpeg')).toBe(true)
    expect([...long].length).toBeLessThanOrEqual('uploads/a1b2c3d4-'.length + 80)
  })
})

describe('storing an upload', () => {
  it('keeps the bytes in the gateway folder under the id, never under the given name', async () => {
    const { uploads, dataDir } = setup()
    const saved = await uploads.save({ name: '../../evil.png', mime: 'image/png', data: b64(png(8, 6)) })
    if (!saved.ok) throw new Error(saved.code)
    expect(saved.upload).toMatchObject({ name: 'evil.png', mime: 'image/png', size: png().length, width: 8, height: 6 })
    expect(saved.upload.id).toMatch(/^[0-9a-f]{32}$/)
    expect(readdirSync(join(dataDir, 'uploads'))).toEqual([saved.upload.id])
    expect(readFileSync(join(dataDir, 'uploads', saved.upload.id))).toEqual(png(8, 6))
    if (process.platform !== 'win32') expect(statSync(join(dataDir, 'uploads', saved.upload.id)).mode & 0o777).toBe(0o600)
    expect(uploads.view(saved.upload)).toEqual({
      id: saved.upload.id, url: `/api/uploads/${saved.upload.id}`, name: 'evil.png', mime: 'image/png', size: png().length, width: 8, height: 6,
    })
  })

  it('takes text and markdown, and tells them apart by what was declared', async () => {
    const { uploads } = setup()
    const notes = await uploads.save({ name: 'notes.md', mime: 'text/markdown', data: b64(Buffer.from('# hi')) })
    const plain = await uploads.save({ name: 'a.txt', mime: 'text/plain', data: b64(Buffer.from('hi')) })
    expect(notes.ok && notes.upload.mime).toBe('text/markdown')
    expect(plain.ok && plain.upload.mime).toBe('text/plain')
    expect(notes.ok && uploads.view(notes.upload)).not.toHaveProperty('width')
  })

  it.each([
    ['a type that is not on the list', { name: 'a.svg', mime: 'image/svg+xml', data: b64(Buffer.from('<svg/>')) }, 'type_not_allowed', 415],
    ['a page dressed up as an image', { name: 'a.png', mime: 'image/png', data: b64(html()) }, 'type_mismatch', 415],
    ['an image declared as text', { name: 'a.txt', mime: 'text/plain', data: b64(png()) }, 'type_mismatch', 415],
    ['a jpeg declared as png', { name: 'a.png', mime: 'image/png', data: b64(jpeg()) }, 'type_mismatch', 415],
    ['binary declared as text', { name: 'a.txt', mime: 'text/plain', data: b64(Buffer.from([0, 1, 2])) }, 'type_mismatch', 415],
    ['a PDF declared as an image', { name: 'a.png', mime: 'image/png', data: b64(pdf()) }, 'type_mismatch', 415],
    ['broken base64', { name: 'a.png', mime: 'image/png', data: 'not base64!' }, 'bad_base64', 400],
    ['nothing at all', { name: 'a.txt', mime: 'text/plain', data: '' }, 'bad_base64', 400],
    ['a missing field', { name: 'a.txt', mime: 'text/plain' }, 'bad_request', 400],
    ['an image too wide to show', { name: 'a.png', mime: 'image/png', data: b64(png(10_001, 10)) }, 'image_too_big', 413],
    ['an image with too many pixels', { name: 'a.png', mime: 'image/png', data: b64(png(8000, 8000)) }, 'image_too_big', 413],
  ])('refuses %s', async (_what, input, code, status) => {
    const { uploads, dataDir } = setup()
    expect(await uploads.save(input)).toEqual({ ok: false, code, status })
    expect(existsSync(join(dataDir, 'uploads')) ? readdirSync(join(dataDir, 'uploads')) : []).toEqual([])
  })

  it('refuses a file over the size limit', async () => {
    const { uploads } = setup()
    const big = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x61)
    expect(await uploads.save({ name: 'big.txt', mime: 'text/plain', data: b64(big) })).toEqual({ ok: false, code: 'too_large', status: 413 })
  })

  it('accepts image/jpg as another spelling of image/jpeg', async () => {
    const { uploads } = setup()
    const saved = await uploads.save({ name: 'a.jpg', mime: 'image/jpg', data: b64(jpeg()) })
    expect(saved.ok && saved.upload.mime).toBe('image/jpeg')
  })

  it('stops taking files when the folder is full, and takes them again once one is removed', async () => {
    const { uploads } = setup({ maxTotalBytes: 100 })
    const text = (n: number) => ({ name: 'a.txt', mime: 'text/plain', data: b64(Buffer.alloc(n, 0x61)) })
    const first = await uploads.save(text(60))
    if (!first.ok) throw new Error(first.code)
    expect(await uploads.save(text(60))).toEqual({ ok: false, code: 'uploads_full', status: 507 })
    await uploads.remove(first.upload.id)
    expect((await uploads.save(text(60))).ok).toBe(true)
  })

  it('has no limit on the folder when the limit is 0', async () => {
    const { uploads } = setup({ maxTotalBytes: 0 })
    expect((await uploads.save({ name: 'a.txt', mime: 'text/plain', data: b64(Buffer.alloc(5000, 0x61)) })).ok).toBe(true)
  })
})

describe('reading, attaching and removing', () => {
  async function one(ctx: ReturnType<typeof setup>, name = 'a.txt') {
    const saved = await ctx.uploads.save({ name, mime: 'text/plain', data: b64(Buffer.from(`body of ${name}`)) })
    if (!saved.ok) throw new Error(saved.code)
    return saved.upload
  }

  it('hands back the bytes by id and nothing for an id it does not know', async () => {
    const ctx = setup()
    const up = await one(ctx)
    expect((await ctx.uploads.bytes(up.id))?.toString()).toBe('body of a.txt')
    expect(ctx.uploads.get('f'.repeat(32))).toBeNull()
    expect(ctx.uploads.get('../../etc/passwd')).toBeNull()
    expect(await ctx.uploads.bytes('../../etc/passwd')).toBeNull()
  })

  it('lets an upload be attached to one message only', async () => {
    const ctx = setup()
    const a = await one(ctx, 'a.txt')
    const b = await one(ctx, 'b.txt')
    expect(ctx.uploads.claim([{ id: a.id }, { id: b.id }])).toMatchObject({ ok: true, uploads: [{ id: a.id }, { id: b.id }] })
    const message = insertMessage(ctx.db, { threadId: 'dm:researcher', sender: 'user', kind: 'attachment', payload: ctx.uploads.view(a) })
    ctx.uploads.attach(a.id, 'dm:researcher', message.id)
    expect(ctx.uploads.get(a.id)).toMatchObject({ thread_id: 'dm:researcher', message_id: message.id })
    expect(ctx.uploads.claim([{ id: a.id }])).toEqual({ ok: false, code: 'attachment_used' })
    expect(ctx.uploads.claim([{ id: b.id }, { id: b.id }])).toEqual({ ok: false, code: 'attachment_repeated' })
    expect(ctx.uploads.claim([{ id: 'f'.repeat(32) }])).toEqual({ ok: false, code: 'attachment_unknown' })
    expect(ctx.uploads.claim([{ nope: 1 }])).toEqual({ ok: false, code: 'attachment_unknown' })
    expect(ctx.uploads.claim('x')).toEqual({ ok: false, code: 'bad_request' })
    expect(ctx.uploads.claim(Array.from({ length: 9 }, () => ({ id: b.id })))).toEqual({ ok: false, code: 'too_many_attachments' })
    expect(ctx.uploads.claim(undefined)).toEqual({ ok: true, uploads: [] })
  })

  it('removes the file, keeps the record, and will not serve or attach it again', async () => {
    const ctx = setup()
    const up = await one(ctx)
    const removed = await ctx.uploads.remove(up.id)
    expect(removed).toMatchObject({ id: up.id })
    expect(existsSync(join(ctx.dataDir, 'uploads', up.id))).toBe(false)
    expect(ctx.uploads.get(up.id)?.deleted_at).toBeTypeOf('number')
    expect(await ctx.uploads.bytes(up.id)).toBeNull()
    expect(ctx.uploads.claim([{ id: up.id }])).toEqual({ ok: false, code: 'attachment_unknown' })
    expect(await ctx.uploads.remove(up.id)).toBeNull()
  })

  it('remembers per teammate whether the file is on its computer and whether its model has seen it', async () => {
    const ctx = setup()
    const up = await one(ctx)
    expect(ctx.uploads.seen('researcher', [up.id]).get(up.id)).toBeUndefined()
    ctx.uploads.markPlaced(up.id, 'researcher')
    expect(ctx.uploads.seen('researcher', [up.id]).get(up.id)).toEqual({ placed: true, shown: false })
    ctx.uploads.markShown([up.id], 'researcher')
    ctx.uploads.markShown([up.id], 'chief')
    expect(ctx.uploads.seen('researcher', [up.id]).get(up.id)).toEqual({ placed: true, shown: true })
    expect(ctx.uploads.seen('chief', [up.id]).get(up.id)).toEqual({ placed: false, shown: true })
    expect(ctx.uploads.seen('chief', []).size).toBe(0)
  })
})

describe('cleaning up', () => {
  it('drops uploads that were never attached after a day, and leaves attached ones alone', async () => {
    let clock = 1_000_000
    const ctx = setup({ now: () => clock })
    const save = async (name: string) => {
      const saved = await ctx.uploads.save({ name, mime: 'text/plain', data: b64(Buffer.from(name)) })
      if (!saved.ok) throw new Error(saved.code)
      return saved.upload
    }
    const orphan = await save('orphan.txt')
    const kept = await save('kept.txt')
    const message = insertMessage(ctx.db, { threadId: 'dm:researcher', sender: 'user', kind: 'attachment', payload: {} })
    ctx.uploads.attach(kept.id, 'dm:researcher', message.id)
    clock += 23 * 3_600_000
    const fresh = await save('fresh.txt')
    expect(await ctx.uploads.sweep()).toEqual({ orphans: 0, strays: 0, missing: 0 })
    clock += 2 * 3_600_000
    expect(await ctx.uploads.sweep()).toEqual({ orphans: 1, strays: 0, missing: 0 })
    expect(ctx.uploads.get(orphan.id)).toBeNull()
    expect(readdirSync(join(ctx.dataDir, 'uploads')).sort()).toEqual([kept.id, fresh.id].sort())
  })

  it('squares the folder with the records: stray files go, records without a file are marked removed', async () => {
    const ctx = setup()
    const saved = await ctx.uploads.save({ name: 'a.txt', mime: 'text/plain', data: b64(Buffer.from('a')) })
    if (!saved.ok) throw new Error(saved.code)
    const message = insertMessage(ctx.db, { threadId: 'dm:researcher', sender: 'user', kind: 'attachment', payload: {} })
    ctx.uploads.attach(saved.upload.id, 'dm:researcher', message.id)
    writeFileSync(join(ctx.dataDir, 'uploads', 'e'.repeat(32)), 'stray')
    writeFileSync(join(ctx.dataDir, 'uploads', 'README'), 'not ours, not touched')
    const { rmSync } = await import('node:fs')
    rmSync(join(ctx.dataDir, 'uploads', saved.upload.id))
    expect(await ctx.uploads.sweep()).toEqual({ orphans: 0, strays: 1, missing: 1 })
    expect(readdirSync(join(ctx.dataDir, 'uploads'))).toEqual(['README'])
    expect(ctx.uploads.get(saved.upload.id)?.deleted_at).toBeTypeOf('number')
  })
})

describe('what a teammate is told about a file', () => {
  const md = { name: 'notes.md', mime: 'text/markdown', size: 12_345, width: null, height: null }
  const shot = { name: 'shot.png', mime: 'image/png', size: 2_500_000, width: 1280, height: 800 }

  it('names the file, its kind and size, and where it is on the computer', () => {
    expect(describeUpload(md, { path: 'uploads/1a2b3c4d-notes.md' }))
      .toBe('[file from your operator] notes.md (Markdown, 12 KB). It is in your folder as uploads/1a2b3c4d-notes.md.')
    expect(describeUpload({ ...md, mime: 'text/plain', name: 'a.txt', size: 900 }, {}))
      .toBe('[file from your operator] a.txt (text, 900 B). It is not on your computer.')
  })

  it('says whether an image is in front of the model, and why not when it is not', () => {
    const at = { path: 'uploads/1a2b3c4d-shot.png' }
    const base = '[image from your operator] shot.png (PNG, 1280×800, 2.4 MB)'
    const where = ' It is in your folder as uploads/1a2b3c4d-shot.png.'
    expect(describeUpload(shot, { ...at, image: 'now' })).toBe(`${base}, shown with this message.${where}`)
    expect(describeUpload(shot, { ...at, image: 'earlier' })).toBe(`${base}, shown to you earlier and not repeated here.${where}`)
    expect(describeUpload(shot, { ...at, image: 'no-vision' })).toBe(`${base}. You cannot see images with your current model.${where}`)
    expect(describeUpload(shot, { ...at, image: 'too-large' })).toBe(`${base}. It is too large to show to your model.${where}`)
    expect(describeUpload(shot, { ...at, image: 'too-many' })).toBe(`${base}. It is not shown: too many images arrived at once.${where}`)
  })

  it('says so when the operator removed the file', () => {
    expect(describeUpload(md, { removed: true })).toBe('[file from your operator] notes.md. Your operator has removed it.')
  })
})

describe('PDFs', () => {
  const twoPages = () => makePdf(['Quarterly plan', 'Risks: none'])

  it('are stored with their text beside them, so a teammate has something to read', async () => {
    const { uploads, dataDir } = setup()
    const saved = await uploads.save({ name: 'plan.pdf', mime: 'application/pdf', data: b64(twoPages()) })
    if (!saved.ok) throw new Error(saved.code)
    expect(saved.upload).toMatchObject({ mime: 'application/pdf', pages: 2, text_state: 'ok', size: twoPages().length })
    expect(readdirSync(join(dataDir, 'uploads')).sort()).toEqual([saved.upload.id, `${saved.upload.id}.txt`])
    expect(await uploads.text(saved.upload.id)).toBe('--- page 1 ---\nQuarterly plan\n\n--- page 2 ---\nRisks: none\n')
    expect(uploads.view(saved.upload)).toEqual({
      id: saved.upload.id, url: `/api/uploads/${saved.upload.id}`, name: 'plan.pdf', mime: 'application/pdf', size: twoPages().length,
      pages: 2, text: 'ok',
    })
    if (process.platform !== 'win32') expect(statSync(join(dataDir, 'uploads', `${saved.upload.id}.txt`)).mode & 0o777).toBe(0o600)
  })

  it('are accepted without text when they are scans or cannot be parsed, and say which', async () => {
    const { uploads, dataDir } = setup()
    const scan = await uploads.save({ name: 'scan.pdf', mime: 'application/pdf', data: b64(makePdf([null])) })
    const broken = await uploads.save({ name: 'broken.pdf', mime: 'application/pdf', data: b64(pdf()) })
    if (!scan.ok || !broken.ok) throw new Error('refused')
    expect(scan.upload).toMatchObject({ pages: 1, text_state: 'none' })
    expect(broken.upload).toMatchObject({ pages: null, text_state: 'failed' })
    expect(uploads.view(scan.upload)).toMatchObject({ pages: 1, text: 'none' })
    expect(uploads.view(broken.upload)).toMatchObject({ text: 'failed' })
    expect(uploads.view(broken.upload)).not.toHaveProperty('pages')
    expect(await uploads.text(scan.upload.id)).toBeNull()
    expect(readdirSync(join(dataDir, 'uploads')).sort()).toEqual([scan.upload.id, broken.upload.id].sort())
  })

  it('do not carry a text state when they are not PDFs', async () => {
    const { uploads } = setup()
    const saved = await uploads.save({ name: 'a.txt', mime: 'text/plain', data: b64(Buffer.from('a')) })
    expect(saved.ok && saved.upload).toMatchObject({ pages: null, text_state: null })
    expect(saved.ok && uploads.view(saved.upload)).not.toHaveProperty('text')
    expect(saved.ok && await uploads.text(saved.upload.id)).toBeNull()
  })

  it('lose their text too when removed, when never attached, and when the folder is squared', async () => {
    let clock = 1_000_000
    const ctx = setup({ now: () => clock })
    const save = async () => {
      const saved = await ctx.uploads.save({ name: 'plan.pdf', mime: 'application/pdf', data: b64(twoPages()) })
      if (!saved.ok) throw new Error(saved.code)
      return saved.upload
    }
    const dir = join(ctx.dataDir, 'uploads')
    const removed = await save()
    await ctx.uploads.remove(removed.id)
    expect(readdirSync(dir)).toEqual([])
    expect(await ctx.uploads.text(removed.id)).toBeNull()

    const kept = await save()
    const message = insertMessage(ctx.db, { threadId: 'dm:researcher', sender: 'user', kind: 'attachment', payload: {} })
    ctx.uploads.attach(kept.id, 'dm:researcher', message.id)
    const orphan = await save()
    writeFileSync(join(dir, `${'e'.repeat(32)}.txt`), 'text of an upload that is gone')
    clock += 25 * 3_600_000
    // 两条没挂上消息的记录都清掉：一条是没发出去的，一条是发之前就移除了的
    expect(await ctx.uploads.sweep()).toEqual({ orphans: 2, strays: 1, missing: 0 })
    expect(readdirSync(dir).sort()).toEqual([kept.id, `${kept.id}.txt`])
    expect(ctx.uploads.get(orphan.id)).toBeNull()
    expect(ctx.uploads.get(removed.id)).toBeNull()
  })

  it('can be given a reader of their own, and keep what it says', async () => {
    const { uploads } = setup({ pdf: async () => ({ state: 'truncated', pages: 900, text: '[Only the first 200 of 900 pages are in this file.]\n\n--- page 1 ---\nx\n' }) })
    const saved = await uploads.save({ name: 'long.pdf', mime: 'application/pdf', data: b64(twoPages()) })
    expect(saved.ok && saved.upload).toMatchObject({ pages: 900, text_state: 'truncated' })
  })

  it('are described to a teammate with where the text is, or why there is none', () => {
    const doc = { name: 'plan.pdf', mime: 'application/pdf', size: 1_300_000, width: null, height: null, pages: 12 }
    const at = { path: 'uploads/1a2b3c4d-plan.pdf' }
    const head = '[file from your operator] plan.pdf (PDF, 12 pages, 1.2 MB).'
    expect(describeUpload({ ...doc, text_state: 'ok' }, at))
      .toBe(`${head} It is in your folder as uploads/1a2b3c4d-plan.pdf, and its text as uploads/1a2b3c4d-plan.pdf.txt.`)
    expect(describeUpload({ ...doc, text_state: 'truncated' }, at))
      .toBe(`${head} It is in your folder as uploads/1a2b3c4d-plan.pdf, and the beginning of its text as uploads/1a2b3c4d-plan.pdf.txt.`)
    expect(describeUpload({ ...doc, text_state: 'none' }, at))
      .toBe(`${head} It is in your folder as uploads/1a2b3c4d-plan.pdf. It has no text to read; it is probably a scan.`)
    expect(describeUpload({ ...doc, pages: null, text_state: 'failed' }, at))
      .toBe('[file from your operator] plan.pdf (PDF, 1.2 MB). It is in your folder as uploads/1a2b3c4d-plan.pdf. Its text could not be extracted.')
    expect(describeUpload({ ...doc, pages: 1, text_state: 'ok' }, {}))
      .toBe('[file from your operator] plan.pdf (PDF, 1 page, 1.2 MB). It is not on your computer.')
  })
})
