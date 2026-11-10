import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createFakeComputer } from '../src/computer.js'
import { ensureDmThread, ensureGroupThread, listMessages, openDb, upsertBot } from '../src/db.js'
import type { AssistantTurn, ChatMsg, LLM } from '../src/llm.js'
import { createPool } from '../src/pool.js'
import { createApp } from '../src/server.js'
import { MAX_UPLOAD_REQUEST_BYTES, MODEL_IMAGE_MAX_BYTES } from '../src/uploads.js'
import { b64, html, png } from './fixtures/upload-samples.js'

const scout = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }
const ticker = { id: 'market-watch', name: 'Ticker', role: 'markets', emoji: '📈', soul_path: '' }
const chief = { id: 'chief', name: 'Chief', role: 'coordination', emoji: '🧭', soul_path: '' }
const GROUP = 'group:offsite-crew'
const DM = 'dm:researcher'
const textTurn = (content = 'Done.'): AssistantTurn => ({ content, toolCalls: [], raw: { role: 'assistant', content } })
const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

type Sent = { bot: string; messages: ChatMsg[] }

function setup(opts: { vision?: boolean; computers?: boolean; uploadsMaxMb?: number; putFile?: (path: string, bytes: Buffer) => Promise<void> } = {}) {
  const db = openDb(':memory:')
  for (const b of [scout, ticker, chief]) { upsertBot(db, b); ensureDmThread(db, b.id) }
  ensureGroupThread(db, GROUP, 'Offsite crew', [scout.id, ticker.id, chief.id])
  const dataDir = mkdtempSync(join(tmpdir(), 'osb-upapi-'))
  const sent: Sent[] = []
  // 每位同事一个模型客户端，好知道是谁在看
  const llmFor = (botId: string) => ({
    vision: opts.vision ?? true,
    llm: { chat: async (messages: ChatMsg[]) => { sent.push({ bot: botId, messages: messages.map((m) => ({ ...m })) }); return textTurn(`${botId} done`) } } satisfies LLM,
  })
  const computers = new Map<string, ReturnType<typeof createFakeComputer>>()
  const computerOf = (botId: string) => {
    if (!computers.has(botId)) computers.set(botId, createFakeComputer(opts.putFile ? { putFile: opts.putFile } : {}))
    return computers.get(botId)!
  }
  const pool = opts.computers === false ? undefined : createPool({ dataDir, makeComputer: async (botId) => computerOf(botId) })
  const gateway = createApp({
    db, llm: llmFor('nobody').llm, llmFor, dataDir, chiefId: chief.id,
    ...(pool ? { pool } : {}), ...(opts.uploadsMaxMb !== undefined ? { uploadsMaxMb: opts.uploadsMaxMb } : {}),
  })
  const { app } = gateway
  const upload = async (name: string, mime: string, bytes: Buffer) => {
    const res = await app.request('/api/uploads', json({ name, mime, data: b64(bytes) }))
    return { res, body: (await res.json()) as { id: string; url: string; name: string; mime: string; size: number; error?: string; code?: string } }
  }
  const send = (threadId: string, body: unknown) => app.request(`/api/threads/${threadId}/messages`, json(body))
  const idle = () => vi.waitFor(() => { for (const b of [scout, ticker, chief]) expect(gateway.isBusy(b.id)).toBe(false) })
  const userLines = (s: Sent) => s.messages.filter((m) => m.role === 'user')
  return { db, dataDir, gateway, app, sent, computerOf, upload, send, idle, userLines }
}

describe('POST /api/uploads', () => {
  it('stores a file and answers with its id, address, name, type and size', async () => {
    const { upload } = setup()
    const { res, body } = await upload('shot.png', 'image/png', png(640, 480))
    expect(res.status).toBe(201)
    expect(body).toEqual({ id: body.id, url: `/api/uploads/${body.id}`, name: 'shot.png', mime: 'image/png', size: png().length, width: 640, height: 480 })
  })

  it('answers every refusal with a code the interface can translate', async () => {
    const { upload, app } = setup()
    const mismatch = await upload('a.png', 'image/png', html())
    expect(mismatch.res.status).toBe(415)
    expect(mismatch.body).toMatchObject({ code: 'type_mismatch', error: expect.any(String) })
    const svg = await upload('a.svg', 'image/svg+xml', Buffer.from('<svg/>'))
    expect(svg.body.code).toBe('type_not_allowed')
    const garbled = await app.request('/api/uploads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' })
    expect(garbled.status).toBe(400)
    expect(await garbled.json()).toMatchObject({ code: 'bad_request' })
  })

  it('turns away a request that is too big before reading it all', async () => {
    const { app } = setup()
    const declared = await app.request('/api/uploads', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(MAX_UPLOAD_REQUEST_BYTES + 1) }, body: '{}',
    })
    expect(declared.status).toBe(413)
    expect(await declared.json()).toMatchObject({ code: 'too_large' })
    // 没报长度、边读边超的也一样
    const undeclared = await app.request('/api/uploads', json({ name: 'a.txt', mime: 'text/plain', data: 'A'.repeat(MAX_UPLOAD_REQUEST_BYTES + 8) }))
    expect(undeclared.status).toBe(413)
  })

  it('stops taking files when the folder is full', async () => {
    const { upload } = setup({ uploadsMaxMb: 1 })
    expect((await upload('a.txt', 'text/plain', Buffer.alloc(700_000, 0x61))).res.status).toBe(201)
    const second = await upload('b.txt', 'text/plain', Buffer.alloc(700_000, 0x61))
    expect(second.res.status).toBe(507)
    expect(second.body.code).toBe('uploads_full')
  })

  it('is not there without a data folder', async () => {
    const db = openDb(':memory:')
    const { app } = createApp({ db, llm: { chat: async () => textTurn() } })
    expect((await app.request('/api/uploads', json({ name: 'a.txt', mime: 'text/plain', data: 'YQ==' }))).status).toBe(503)
  })
})

describe('GET /api/uploads/:id', () => {
  it('serves an image inline, with headers that keep it from ever running as a page', async () => {
    const { upload, app } = setup()
    const { body } = await upload('shot.png', 'image/png', png())
    const res = await app.request(body.url)
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(png())
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(res.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''shot.png")
    expect(res.headers.get('cache-control')).toContain('private')
  })

  it('serves anything else as a download under its own name', async () => {
    const { upload, app } = setup()
    const { body } = await upload('会议 纪要.md', 'text/markdown', Buffer.from('# hi'))
    const res = await app.request(body.url)
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename*=UTF-8''${encodeURIComponent('会议 纪要.md')}`)
    expect(await res.text()).toBe('# hi')
  })

  it('answers 404 for an id it never had and 410 for a file that was removed', async () => {
    const { upload, app } = setup()
    expect((await app.request(`/api/uploads/${'f'.repeat(32)}`)).status).toBe(404)
    expect((await app.request('/api/uploads/..%2F..%2Fauth-token')).status).toBe(404)
    const { body } = await upload('a.txt', 'text/plain', Buffer.from('a'))
    expect((await app.request(body.url, { method: 'DELETE' })).status).toBe(204)
    expect((await app.request(body.url)).status).toBe(410)
    expect((await app.request(body.url, { method: 'DELETE' })).status).toBe(404)
  })
})

describe('screenshots', () => {
  it('are served with nosniff too', async () => {
    const { app, dataDir } = setup()
    const { saveScreenshot } = await import('../src/screenshots.js')
    const shot = await saveScreenshot(dataDir, scout.id, { buffer: png(), width: 4, height: 3 }, 1_700_000_000_000)
    expect((await app.request(shot.url)).headers.get('x-content-type-options')).toBe('nosniff')
  })
})

describe('sending a message with attachments', () => {
  it('posts the text, then one message per file, and starts one turn that sees them all', async () => {
    const ctx = setup()
    const shot = (await ctx.upload('shot.png', 'image/png', png(640, 480))).body
    const notes = (await ctx.upload('notes.md', 'text/markdown', Buffer.from('# plan'))).body
    const res = await ctx.send(DM, { text: 'what do you make of these?', attachments: [{ id: shot.id }, { id: notes.id }] })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ ok: true, attachments: [shot.id, notes.id] })
    await ctx.idle()
    const rows = listMessages(ctx.db, DM)
    expect(rows.map((m) => [m.sender, m.kind])).toEqual([['user', 'text'], ['user', 'attachment'], ['user', 'attachment'], [scout.id, 'text']])
    expect(rows[1]!.payload).toEqual({ id: shot.id, url: shot.url, name: 'shot.png', mime: 'image/png', size: shot.size, width: 640, height: 480 })
    expect(rows[2]!.payload).toEqual({ id: notes.id, url: notes.url, name: 'notes.md', mime: 'text/markdown', size: 6 })
    expect(ctx.sent).toHaveLength(1)
    const lines = ctx.userLines(ctx.sent[0]!)
    const short = (id: string) => id.slice(0, 8)
    expect(lines[0]!.content).toBe('what do you make of these?')
    expect(lines[1]!.content).toBe(`[image from your operator] shot.png (PNG, 640×480, ${shot.size} B), shown with this message. It is in your folder as uploads/${short(shot.id)}-shot.png.`)
    expect(lines[1]).toMatchObject({ images: [`data:image/png;base64,${b64(png(640, 480))}`], keepImages: true })
    expect(lines[2]!.content!.split('\n')[0]).toBe(`[file from your operator] notes.md (Markdown, 6 B). It is in your folder as uploads/${short(notes.id)}-notes.md.`)
    expect(lines[2]).not.toHaveProperty('images')
    const computer = ctx.computerOf(scout.id)
    expect(computer.files.get(`uploads/${short(shot.id)}-shot.png`)).toEqual(png(640, 480))
    expect(computer.files.get(`uploads/${short(notes.id)}-notes.md`)?.toString()).toBe('# plan')
  })

  it('shows the image once: on the next turn it is named, not sent, and not put on the computer again', async () => {
    const ctx = setup()
    const shot = (await ctx.upload('shot.png', 'image/png', png())).body
    await ctx.send(DM, { text: 'look', attachments: [{ id: shot.id }] })
    await ctx.idle()
    await ctx.send(DM, { text: 'and the corner?' })
    await ctx.idle()
    expect(ctx.sent).toHaveLength(2)
    const again = ctx.userLines(ctx.sent[1]!).find((m) => m.content?.startsWith('[image from your operator]'))!
    expect(again.content).toContain('shown to you earlier and not repeated here')
    expect(again).not.toHaveProperty('images')
    expect(ctx.computerOf(scout.id).calls.filter((c) => c.startsWith('put:'))).toHaveLength(1)
  })

  it('takes files without any text, and refuses a message with neither', async () => {
    const ctx = setup()
    const notes = (await ctx.upload('notes.md', 'text/markdown', Buffer.from('# plan'))).body
    expect((await ctx.send(DM, { attachments: [{ id: notes.id }] })).status).toBe(202)
    await ctx.idle()
    expect(listMessages(ctx.db, DM).map((m) => m.kind)).toEqual(['attachment', 'text'])
    expect((await ctx.send(DM, { text: '   ', attachments: [] })).status).toBe(400)
    expect((await ctx.send(DM, {})).status).toBe(400)
  })

  it('refuses an upload that was used before, is unknown, or comes in too great a number, and posts nothing', async () => {
    const ctx = setup()
    const notes = (await ctx.upload('notes.md', 'text/markdown', Buffer.from('# plan'))).body
    await ctx.send(DM, { text: 'one', attachments: [{ id: notes.id }] })
    await ctx.idle()
    const before = listMessages(ctx.db, DM).length
    const used = await ctx.send(DM, { text: 'two', attachments: [{ id: notes.id }] })
    expect(used.status).toBe(400)
    expect(await used.json()).toMatchObject({ code: 'attachment_used' })
    expect((await (await ctx.send(DM, { text: 'x', attachments: [{ id: 'f'.repeat(32) }] })).json())).toMatchObject({ code: 'attachment_unknown' })
    expect((await (await ctx.send(DM, { text: 'x', attachments: Array.from({ length: 9 }, () => ({ id: notes.id })) })).json())).toMatchObject({ code: 'too_many_attachments' })
    expect((await (await ctx.send(GROUP, { text: 'x', attachments: [{ id: notes.id }] })).json())).toMatchObject({ code: 'attachment_used' })
    expect(listMessages(ctx.db, DM)).toHaveLength(before)
    expect(listMessages(ctx.db, GROUP)).toHaveLength(0)
  })

  it('does not take a thumbs-up with a file attached for an approval', async () => {
    const ctx = setup()
    const notes = (await ctx.upload('notes.md', 'text/markdown', Buffer.from('# plan'))).body
    const res = await ctx.send(DM, { text: '👍', attachments: [{ id: notes.id }] })
    expect(await res.json()).toEqual({ ok: true, attachments: [notes.id] })
    await ctx.idle()
  })

  it('tells a model that cannot see images so, and still puts the file on the computer', async () => {
    const ctx = setup({ vision: false })
    const shot = (await ctx.upload('shot.png', 'image/png', png())).body
    await ctx.send(DM, { text: 'look', attachments: [{ id: shot.id }] })
    await ctx.idle()
    const line = ctx.userLines(ctx.sent[0]!)[1]!
    expect(line.content).toContain('You cannot see images with your current model.')
    expect(line.content).toContain('It is in your folder as uploads/')
    expect(line).not.toHaveProperty('images')
  })

  it('names an image too large for a model without sending it', async () => {
    const ctx = setup()
    const big = Buffer.concat([png(100, 100), Buffer.alloc(MODEL_IMAGE_MAX_BYTES, 1)])
    const shot = (await ctx.upload('big.png', 'image/png', big)).body
    await ctx.send(DM, { text: 'look', attachments: [{ id: shot.id }] })
    await ctx.idle()
    const line = ctx.userLines(ctx.sent[0]!)[1]!
    expect(line.content).toContain('It is too large to show to your model.')
    expect(line).not.toHaveProperty('images')
  })

  it('says the file is not on the computer when there is no computer', async () => {
    const ctx = setup({ computers: false })
    const notes = (await ctx.upload('notes.md', 'text/markdown', Buffer.from('# plan'))).body
    await ctx.send(DM, { text: 'read this', attachments: [{ id: notes.id }] })
    await ctx.idle()
    expect(ctx.userLines(ctx.sent[0]!)[1]!.content).toContain('It is not on your computer.')
  })

  it('carries on when the file cannot be put on the computer, and tries again next turn', async () => {
    let fail = true
    const placed: string[] = []
    const ctx = setup({ putFile: async (path) => { if (fail) throw new Error('disk full'); placed.push(path) } })
    const notes = (await ctx.upload('notes.md', 'text/markdown', Buffer.from('# plan'))).body
    await ctx.send(DM, { text: 'read this', attachments: [{ id: notes.id }] })
    await ctx.idle()
    expect(ctx.userLines(ctx.sent[0]!)[1]!.content).toContain('It is not on your computer.')
    fail = false
    await ctx.send(DM, { text: 'try again' })
    await ctx.idle()
    expect(placed).toEqual([`uploads/${notes.id.slice(0, 8)}-notes.md`])
    expect(ctx.userLines(ctx.sent[1]!)[1]!.content).toContain('It is in your folder as uploads/')
  })
})

describe('attachments in a group', () => {
  it('reach the teammate who was named; another teammate asked later sees the image on its own first turn', async () => {
    const ctx = setup()
    const shot = (await ctx.upload('chart.png', 'image/png', png())).body
    const res = await ctx.send(GROUP, { text: 'what does this chart say?', mentions: [scout.id], attachments: [{ id: shot.id }] })
    expect(await res.json()).toEqual({ ok: true, mentions: [scout.id], attachments: [shot.id] })
    await ctx.idle()
    expect(ctx.sent.map((s) => s.bot)).toEqual([scout.id])
    expect(ctx.userLines(ctx.sent[0]!).some((m) => m.images?.length === 1 && m.keepImages)).toBe(true)
    expect([...ctx.computerOf(scout.id).files.keys()]).toEqual([`uploads/${shot.id.slice(0, 8)}-chart.png`])

    await ctx.send(GROUP, { text: 'do you agree?', mentions: [ticker.id] })
    await ctx.idle()
    expect(ctx.sent.map((s) => s.bot)).toEqual([scout.id, ticker.id])
    const seen = ctx.userLines(ctx.sent[1]!).find((m) => m.content?.startsWith('[image from your operator]'))!
    expect(seen.content).toContain('shown with this message')
    expect(seen.images).toHaveLength(1)
    expect([...ctx.computerOf(ticker.id).files.keys()]).toEqual([`uploads/${shot.id.slice(0, 8)}-chart.png`])
  })

  it('tells the group about files that came without words', async () => {
    const ctx = setup()
    const notes = (await ctx.upload('notes.md', 'text/markdown', Buffer.from('# plan'))).body
    expect((await ctx.send(GROUP, { mentions: [scout.id], attachments: [{ id: notes.id }] })).status).toBe(202)
    await ctx.idle()
    const seed = ctx.userLines(ctx.sent[0]!).at(-1)!.content!
    expect(seed).toContain('notes.md')
    expect(seed).not.toContain('""')
  })
})

describe('removing an upload', () => {
  it('marks the message in the thread as removed and tells the teammate so', async () => {
    const ctx = setup()
    const events: unknown[] = []
    ctx.gateway.hub.add({ send: (data) => events.push(JSON.parse(data)) })
    const notes = (await ctx.upload('notes.md', 'text/markdown', Buffer.from('# plan'))).body
    await ctx.send(DM, { text: 'read this', attachments: [{ id: notes.id }] })
    await ctx.idle()
    events.length = 0
    expect((await ctx.app.request(notes.url, { method: 'DELETE' })).status).toBe(204)
    const row = listMessages(ctx.db, DM).find((m) => m.kind === 'attachment')!
    expect(row.payload).toMatchObject({ id: notes.id, name: 'notes.md', deleted: true })
    expect(events).toContainEqual({ type: 'message', threadId: DM, message: row })
    await ctx.send(DM, { text: 'still there?' })
    await ctx.idle()
    expect(ctx.userLines(ctx.sent[1]!)[1]!.content).toBe('[file from your operator] notes.md. Your operator has removed it.')
  })
})

describe('cleaning up', () => {
  it('is something the gateway can be asked to do', async () => {
    const ctx = setup()
    expect(await ctx.gateway.sweepUploads()).toEqual({ orphans: 0, strays: 0, missing: 0 })
  })
})
