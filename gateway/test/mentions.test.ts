import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseA2AAllow } from '../src/a2a.js'
import { ensureDmThread, ensureGroupThread, listMessages, openDb, upsertBot } from '../src/db.js'
import type { AssistantTurn, ChatMsg, LLM } from '../src/llm.js'
import { mentionedInText, resolveMentions } from '../src/mentions.js'
import { createApp } from '../src/server.js'

describe('mentionedInText', () => {
  it('finds @id tokens', () => {
    expect(mentionedInText('@researcher and @market-watch, please look')).toEqual(['researcher', 'market-watch'])
    expect(mentionedInText('(@chief) @researcher: @inbox-keeper.')).toEqual(['chief', 'researcher', 'inbox-keeper'])
    expect(mentionedInText('请 @researcher 看一下')).toEqual(['researcher'])
  })

  it('does not read display names, e-mail addresses or longer words as ids', () => {
    expect(mentionedInText('@Scout please')).toEqual([])
    expect(mentionedInText('mail ops@researcher.dev')).toEqual([])
    expect(mentionedInText('@chiefX @chief_2 @@chief')).toEqual([])
  })
})

describe('resolveMentions', () => {
  const members = ['researcher', 'market-watch', 'chief']

  it('merges explicit ids with @id in the text, in member order, without duplicates', () => {
    expect(resolveMentions(['chief'], 'hey @researcher and @chief', members)).toEqual({ ok: true, ids: ['researcher', 'chief'] })
  })

  it('treats no mentions as the whole group', () => {
    expect(resolveMentions(undefined, 'where are we?', members)).toEqual({ ok: true, ids: [] })
    expect(resolveMentions([], 'where are we?', members)).toEqual({ ok: true, ids: [] })
  })

  it('ignores @words in the text that are not members', () => {
    expect(resolveMentions(undefined, 'ask @nobody', members)).toEqual({ ok: true, ids: [] })
  })

  it('rejects an explicit id that is not a member', () => {
    expect(resolveMentions(['nobody'], 'hi', members)).toMatchObject({ ok: false, code: 'mention_not_member', params: { id: 'nobody' } })
  })

  it('rejects anything but a list of strings', () => {
    expect(resolveMentions('researcher', 'hi', members)).toMatchObject({ ok: false, code: 'mentions_invalid' })
    expect(resolveMentions([1], 'hi', members)).toMatchObject({ ok: false, code: 'mentions_invalid' })
    expect(resolveMentions(Array(51).fill('chief'), 'hi', members)).toMatchObject({ ok: false, code: 'mentions_invalid' })
  })

  it('has no members to name in a direct thread', () => {
    expect(resolveMentions(['chief'], 'hi', [])).toMatchObject({ ok: false, code: 'mentions_not_group' })
    expect(resolveMentions(undefined, 'hi @chief', [])).toEqual({ ok: true, ids: [] })
  })
})

const scout = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }
const ticker = { id: 'market-watch', name: 'Ticker', role: 'markets', emoji: '📈', soul_path: '' }
const chief = { id: 'chief', name: 'Chief', role: 'staff', emoji: '🎖️', soul_path: '' }
const outsider = { id: 'inbox-keeper', name: 'Inbox', role: 'mail', emoji: '📬', soul_path: '' }
const GROUP = 'group:offsite-crew'

type App = { request: (path: string, init?: RequestInit) => Promise<Response> | Response }
const post = (app: App, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

const whoAmI = (messages: ChatMsg[]) => String(messages[0]?.content ?? '').match(/You are ([\w -]+),/)?.[1] ?? '?'

function namingLLM(): LLM & { seen: { who: string; prompt: string }[] } {
  const seen: { who: string; prompt: string }[] = []
  return {
    seen,
    async chat(messages: ChatMsg[]) {
      const who = whoAmI(messages)
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')
      seen.push({ who, prompt: String(lastUser?.content ?? '') })
      const content = `${who} reporting.`
      return { content, toolCalls: [], raw: { role: 'assistant', content } } as AssistantTurn
    },
  }
}

function setup(llm: LLM) {
  const db = openDb(':memory:')
  for (const b of [scout, ticker, chief, outsider]) upsertBot(db, b)
  for (const b of [scout, ticker, chief, outsider]) ensureDmThread(db, b.id)
  ensureGroupThread(db, GROUP, 'Offsite crew', ['researcher', 'market-watch', 'chief'])
  const dataDir = mkdtempSync(join(tmpdir(), 'osb-mentions-'))
  return { db, ...createApp({ db, llm, dataDir, chiefId: 'chief', a2aRules: parseA2AAllow('', 'chief') }) }
}

const botSenders = (db: ReturnType<typeof openDb>) => listMessages(db, GROUP).filter((m) => m.sender !== 'user').map((m) => m.sender)

/**
 * 同一个群的两轮排队进行：再发一条只点 Ticker 的消息，等它答完，前一轮就一定已经收尾了，
 * 这样才能断言「没被点到的人确实没开口」，而不是「还没来得及开口」。
 */
async function settle(app: App, db: ReturnType<typeof openDb>) {
  await post(app, `/api/threads/${GROUP}/messages`, { text: 'and you?', mentions: ['market-watch'] })
  await vi.waitFor(() => { expect(botSenders(db).at(-1)).toBe('market-watch') })
  const all = botSenders(db)
  expect(all.filter((id) => id === 'market-watch')).toHaveLength(1)
  return all.slice(0, -1)
}

describe('group mentions', () => {
  it('wakes only the named members, and the chief stays quiet unless named', async () => {
    const llm = namingLLM()
    const { app, db } = setup(llm)
    const res = await post(app, `/api/threads/${GROUP}/messages`, { text: 'can you dig into this?', mentions: ['researcher'] })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ ok: true, mentions: ['researcher'] })
    expect(await settle(app, db)).toEqual(['researcher'])
    expect(llm.seen[0]).toMatchObject({ who: 'Scout' })
    expect(llm.seen[0]!.prompt).toContain('asked you directly in the group: "can you dig into this?"')
    expect(llm.seen[0]!.prompt).not.toContain('two lines')
  })

  it('reads @id from the text the same way', async () => {
    const { app, db } = setup(namingLLM())
    const res = await post(app, `/api/threads/${GROUP}/messages`, { text: '@researcher can you dig into this?' })
    expect(await res.json()).toEqual({ ok: true, mentions: ['researcher'] })
    expect(await settle(app, db)).toEqual(['researcher'])
  })

  it('lets the chief close after the named members when it is named too', async () => {
    const llm = namingLLM()
    const { app, db } = setup(llm)
    await post(app, `/api/threads/${GROUP}/messages`, { text: 'plan the launch', mentions: ['chief', 'researcher'] })
    expect(await settle(app, db)).toEqual(['researcher', 'chief'])
    const chiefTurn = llm.seen.find((s) => s.who === 'Chief')!
    expect(chiefTurn.prompt).toContain('Your operator asked @researcher and you in the group')
    expect(chiefTurn.prompt).toContain('dispatch table')
    const scoutTurn = llm.seen.find((s) => s.who === 'Scout')!
    expect(scoutTurn.prompt).toContain('They also asked @chief; answer for your own part.')
  })

  it('asks the chief directly, without a dispatch table, when it is the only one named', async () => {
    const llm = namingLLM()
    const { app, db } = setup(llm)
    await post(app, `/api/threads/${GROUP}/messages`, { text: 'what is on today?', mentions: ['chief'] })
    expect(await settle(app, db)).toEqual(['chief'])
    expect(llm.seen[0]!.prompt).toContain('asked you directly in the group')
    expect(llm.seen[0]!.prompt).not.toContain('dispatch table')
  })

  it('keeps the full round when nobody is named, even if a display name follows @', async () => {
    const { app, db } = setup(namingLLM())
    const res = await post(app, `/api/threads/${GROUP}/messages`, { text: '@Scout where are we?' })
    expect(await res.json()).toEqual({ ok: true })
    await vi.waitFor(() => { expect(botSenders(db)).toHaveLength(3) })
    expect(botSenders(db).at(-1)).toBe('chief')
  })

  it('refuses a named teammate who is not in the group, and posts nothing', async () => {
    const { app, db } = setup(namingLLM())
    const res = await post(app, `/api/threads/${GROUP}/messages`, { text: 'hi', mentions: ['inbox-keeper'] })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'mention_not_member', params: { id: 'inbox-keeper' } })
    expect(listMessages(db, GROUP)).toHaveLength(0)
  })

  it('refuses mentions in a direct thread but accepts an empty list', async () => {
    const { app, db } = setup(namingLLM())
    const bad = await post(app, '/api/threads/dm:researcher/messages', { text: 'hi', mentions: ['chief'] })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ code: 'mentions_not_group' })
    expect(listMessages(db, 'dm:researcher')).toHaveLength(0)
    expect((await post(app, '/api/threads/dm:researcher/messages', { text: 'hi', mentions: [] })).status).toBe(202)
  })
})
