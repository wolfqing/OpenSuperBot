import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ensureDmThread, openDb, upsertBot, type BotRow } from '../src/db.js'
import type { AssistantTurn, ChatMsg, LLM } from '../src/llm.js'
import { createRoutine, setRoutineEnabled } from '../src/routines.js'
import { createApp } from '../src/server.js'

const scout: BotRow = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }
const chief: BotRow = { id: 'chief', name: 'Chief', role: 'staff', emoji: '🎖️', soul_path: '' }
const text = (content: string): AssistantTurn => ({ content, toolCalls: [], raw: { role: 'assistant', content } })
const tool = (name: string, args: unknown): AssistantTurn =>
  ({ content: null, toolCalls: [{ id: 't1', name, args }], raw: { role: 'assistant', content: null, tool_calls: [] } })

describe('/api/summary', () => {
  it('counts teammates working, things waiting on you, and routines that are on', async () => {
    const db = openDb(':memory:')
    for (const b of [scout, chief]) { upsertBot(db, b); ensureDmThread(db, b.id) }
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const llm: LLM = {
      async chat(messages: ChatMsg[]) {
        const last = messages.at(-1)!
        // Chief 一直在想（挡在 gate 上）；Scout 扣下一件等批准的事
        if (String(messages[0]!.content).includes('Chief')) { await gate; return text('done') }
        if (last.role === 'tool') return text('Holding.')
        return tool('hold_for_approval', { action: 'send the digest', detail: 'to Bob', kind: 'email', target: 'bob@acme.com' })
      },
    }
    const { app } = createApp({ db, llm, dataDir: mkdtempSync(join(tmpdir(), 'osb-summary-')), chiefId: 'chief' })
    const summary = async () => (await app.request('/api/summary')).json()
    const post = (thread: string) => app.request(`/api/threads/${thread}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'go' }),
    })
    expect(await summary()).toEqual({ working: 0, waiting: 0, routines: 0 })

    createRoutine(db, { botId: 'researcher', name: 'Digest', cron: '0 9 * * *', instructions: 'x' })
    const off = createRoutine(db, { botId: 'chief', name: 'Paused', cron: '0 9 * * *', instructions: 'x' })
    setRoutineEnabled(db, off.id, false)
    await post('dm:researcher')
    await post('dm:chief')
    await vi.waitFor(async () => expect(await summary()).toEqual({ working: 1, waiting: 1, routines: 1 }))
    release()
    await vi.waitFor(async () => expect(await summary()).toEqual({ working: 0, waiting: 1, routines: 1 }))
  })
})
