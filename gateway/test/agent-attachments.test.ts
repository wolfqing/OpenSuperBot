import { describe, expect, it } from 'vitest'
import { runTurn, type AgentEvents, type AttachmentBrief } from '../src/agent.js'
import { ensureDmThread, insertMessage, openDb, upsertBot, type MessageRow } from '../src/db.js'
import type { AssistantTurn, ChatMsg, LLM } from '../src/llm.js'

const bot = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }
const textTurn = (content = 'Done.'): AssistantTurn => ({ content, toolCalls: [], raw: { role: 'assistant', content } })
const toolTurn = (name: string, args: unknown, id = 'c1'): AssistantTurn =>
  ({ content: null, toolCalls: [{ id, name, args }], raw: { role: 'assistant', content: null, tool_calls: [] } })

function setup() {
  const db = openDb(':memory:')
  upsertBot(db, bot)
  const threadId = ensureDmThread(db, bot.id)
  const events: AgentEvents = { onMessage: () => {}, onStatus: () => {} }
  const calls: ChatMsg[][] = []
  const llmOf = (script: (AssistantTurn | Error)[]): LLM => ({
    async chat(messages) {
      calls.push(messages.map((m) => ({ ...m })))
      const next = script.shift() ?? textTurn()
      if (next instanceof Error) throw next
      return next
    },
  })
  const say = (content: string) => insertMessage(db, { threadId, sender: 'user', kind: 'text', content })
  const attach = (name: string) => insertMessage(db, {
    threadId, sender: 'user', kind: 'attachment', payload: { id: 'f'.repeat(32), url: '/api/uploads/x', name, mime: 'image/png', size: 10 },
  })
  return { db, threadId, events, calls, llmOf, say, attach }
}

/** 一份照着剧本回话的附件说明：记下被问到了哪些消息、shown 被叫了几次 */
function brief(lines: Record<number, string>, images: Record<number, string> = {}) {
  const state = { asked: [] as number[], shown: 0 }
  const make = async (rows: MessageRow[]): Promise<AttachmentBrief> => {
    state.asked = rows.map((r) => r.id)
    return { line: (id) => lines[id], image: (id) => images[id], shown: () => { state.shown += 1 } }
  }
  return { make, state }
}

describe('attachments in a turn', () => {
  it('shows each attached file as its own line, with the image on the turn it arrives', async () => {
    const ctx = setup()
    const text = ctx.say('what is in this picture?')
    const shot = ctx.attach('shot.png')
    const b = brief({ [shot.id]: '[image from your operator] shot.png, shown with this message.' }, { [shot.id]: 'data:image/png;base64,MINE' })
    await runTurn({ db: ctx.db, llm: ctx.llmOf([textTurn()]), bot, soul: '', threadId: ctx.threadId, attachments: b.make },
      'what is in this picture?', ctx.events, { alreadyStored: true, pendingIds: [text.id, shot.id] })
    expect(b.state.asked).toEqual([shot.id])
    const sent = ctx.calls[0]!.filter((m) => m.role === 'user')
    expect(sent.map((m) => m.content?.split('\n')[0])).toEqual(['what is in this picture?', '[image from your operator] shot.png, shown with this message.'])
    expect(sent[1]).toMatchObject({ images: ['data:image/png;base64,MINE'], keepImages: true })
    expect(sent[0]).not.toHaveProperty('images')
    expect(b.state.shown).toBe(1)
  })

  it('counts the image as seen once, however many times the model is called in the turn', async () => {
    const ctx = setup()
    ctx.say('look')
    const shot = ctx.attach('shot.png')
    const b = brief({ [shot.id]: 'line' }, { [shot.id]: 'data:image/png;base64,MINE' })
    const report = { kind: 'report', payload: { lines: [{ system: 'Web', result: 'ok' }] } }
    await runTurn({ db: ctx.db, llm: ctx.llmOf([toolTurn('message_user', report), textTurn()]), bot, soul: '', threadId: ctx.threadId, attachments: b.make },
      'look', ctx.events, { alreadyStored: true })
    expect(ctx.calls).toHaveLength(2)
    expect(b.state.shown).toBe(1)
    // 同一回合里后面的调用还带着这张图
    expect(ctx.calls[1]!.some((m) => m.images?.[0] === 'data:image/png;base64,MINE')).toBe(true)
  })

  it('does not count the image as seen when the model call failed, so the next turn shows it again', async () => {
    const ctx = setup()
    ctx.say('look')
    const shot = ctx.attach('shot.png')
    const b = brief({ [shot.id]: 'line' }, { [shot.id]: 'data:image/png;base64,MINE' })
    await runTurn({ db: ctx.db, llm: ctx.llmOf([new Error('LLM API 500: boom')]), bot, soul: '', threadId: ctx.threadId, attachments: b.make },
      'look', ctx.events, { alreadyStored: true })
    expect(b.state.shown).toBe(0)
  })

  it('carries a line without an image on later turns', async () => {
    const ctx = setup()
    ctx.say('look')
    const shot = ctx.attach('shot.png')
    const b = brief({ [shot.id]: '[image from your operator] shot.png, shown to you earlier and not repeated here.' })
    await runTurn({ db: ctx.db, llm: ctx.llmOf([textTurn()]), bot, soul: '', threadId: ctx.threadId, attachments: b.make }, 'and now?', ctx.events)
    const line = ctx.calls[0]!.find((m) => m.content?.startsWith('[image from your operator]'))!
    expect(line.role).toBe('user')
    expect(line).not.toHaveProperty('images')
    expect(line).not.toHaveProperty('keepImages')
  })

  it('still names the file when nothing can describe it (no uploads folder, or the lookup failed)', async () => {
    const ctx = setup()
    ctx.say('look')
    ctx.attach('shot.png')
    await runTurn({ db: ctx.db, llm: ctx.llmOf([textTurn()]), bot, soul: '', threadId: ctx.threadId }, 'x', ctx.events, { alreadyStored: true })
    await runTurn({
      db: ctx.db, llm: ctx.llmOf([textTurn()]), bot, soul: '', threadId: ctx.threadId,
      attachments: async () => { throw new Error('disk gone') },
    }, 'x', ctx.events, { alreadyStored: true })
    for (const call of ctx.calls) {
      expect(call.some((m) => m.role === 'user' && m.content?.startsWith('[file from your operator] shot.png. It is not available to you right now.'))).toBe(true)
    }
  })

  it('reads an attachment a teammate sees in a group the same way: it came from the operator', async () => {
    const ctx = setup()
    const shot = ctx.attach('shot.png')
    insertMessage(ctx.db, { threadId: ctx.threadId, sender: 'chief', kind: 'text', content: 'On it.' })
    const b = brief({ [shot.id]: '[image from your operator] shot.png' })
    await runTurn({ db: ctx.db, llm: ctx.llmOf([textTurn()]), bot, soul: '', threadId: ctx.threadId, attachments: b.make }, 'go', ctx.events)
    const users = ctx.calls[0]!.filter((m) => m.role === 'user').map((m) => m.content)
    expect(users[0]).toBe('[image from your operator] shot.png')
    expect(users[1]).toBe('@chief: On it.')
  })
})
