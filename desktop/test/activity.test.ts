import { describe, expect, it, vi } from 'vitest'
import { fetchSummary, notificationFor, quitQuestion, texts, trayStatus, watchGateway, type GatewayMessageEvent, type SocketFactory } from '../src/activity.js'

const msg = (kind: string, payload: unknown, over: Partial<GatewayMessageEvent['message']> = {}): GatewayMessageEvent => ({
  type: 'message', threadId: 'dm:researcher', message: { id: 7, sender: 'researcher', kind, content: 'x', payload, ...over },
})
const names = { researcher: 'Scout' }

describe('the tray', () => {
  it('says who is working and what waits on you', () => {
    expect(trayStatus({ working: 2, waiting: 3, routines: 1 }, 'en')).toEqual(['2 teammates working', '3 waiting on you'])
    expect(trayStatus({ working: 1, waiting: 0, routines: 0 }, 'en')).toEqual(['1 teammate working'])
    expect(trayStatus({ working: 0, waiting: 0, routines: 4 }, 'zh-CN')).toEqual(['没有同事在干活'])
    expect(trayStatus({ working: 0, waiting: 1, routines: 0 }, 'zh-CN')).toEqual(['没有同事在干活', '1 件事等你'])
    expect(trayStatus(null, 'en')).toEqual(['Gateway not running'])
    expect(texts('en').update('0.7.0')).toBe('Version 0.7.0 is available — Download…')
    expect(texts('zh-CN').update('0.7.0')).toBe('有新版本 0.7.0 — 去下载…')
  })
})

describe('asking before quitting', () => {
  it('only when work is running or routines are on, and says they stop', () => {
    expect(quitQuestion({ working: 0, waiting: 5, routines: 0 }, 'en')).toBeNull()
    expect(quitQuestion(null, 'en')).toBeNull()
    expect(quitQuestion({ working: 1, waiting: 0, routines: 2 }, 'en')).toEqual({
      title: 'Quit while work is running?',
      detail: '1 teammate is working and 2 routines are on. Once you quit, nothing runs until you open OpenSuperBot again — routines included.',
      quit: 'Quit', cancel: 'Cancel',
    })
    expect(quitQuestion({ working: 0, waiting: 0, routines: 1 }, 'zh-CN')!.detail)
      .toBe('1 条例行任务开着。退出以后它们都不会再跑，例行任务也一样，直到你再打开 OpenSuperBot。')
  })
})

describe('notifications', () => {
  it('for a pending approval, an open question and a sign-in request, by name', () => {
    expect(notificationFor(msg('approval_request', { status: 'pending', action: 'send the 4 drafts' }), names, 'en'))
      .toEqual({ title: 'Scout needs your approval', body: 'send the 4 drafts', threadId: 'dm:researcher', key: 'approval_request:7' })
    expect(notificationFor(msg('question', { status: 'open', question: 'Which one first?' }), names, 'zh-CN'))
      .toMatchObject({ title: 'Scout 有个问题问你', body: 'Which one first?' })
    expect(notificationFor(msg('login_request', { site: 'Zendesk' }), names, 'en')).toMatchObject({ title: 'Scout needs you to sign in', body: 'Zendesk' })
  })

  it('not for settled ones, reports, or anything else', () => {
    expect(notificationFor(msg('approval_request', { status: 'approved', action: 'x' }), names, 'en')).toBeNull()
    expect(notificationFor(msg('question', { status: 'answered', question: 'x' }), names, 'en')).toBeNull()
    for (const kind of ['text', 'report', 'screenshot', 'activity', 'approval_resolved']) expect(notificationFor(msg(kind, {}), names, 'en')).toBeNull()
  })

  it('falls back to the id for an unknown teammate, and keeps the body short', () => {
    const n = notificationFor(msg('approval_request', { status: 'pending', action: 'a'.repeat(400) }, { sender: 'new-bot' }), {}, 'en')!
    expect(n.title).toBe('new-bot needs your approval')
    expect(n.body.length).toBe(180)
  })
})

describe('listening to the gateway', () => {
  it('connects with the token, passes events on, and reconnects when dropped', async () => {
    const sockets: { url: string; headers: Record<string, string>; emit: (t: string, d?: unknown) => void; closed: boolean }[] = []
    const socket: SocketFactory = (url, headers) => {
      const listeners: Record<string, ((e: { data: unknown }) => void)[]> = {}
      const s = {
        url, headers, closed: false,
        emit: (t: string, d?: unknown) => (listeners[t] ?? []).forEach((l) => l({ data: d })),
        addEventListener: (t: string, l: (e: { data: unknown }) => void) => { (listeners[t] ??= []).push(l) },
        close() { s.closed = true },
      }
      sockets.push(s)
      return s
    }
    const events: unknown[] = []
    let port = 4747
    const stop = watchGateway({ url: () => `ws://127.0.0.1:${port}/ws`, token: () => 'tok', onEvent: (e) => events.push(e), socket, retryMs: 5 })
    expect(sockets[0]).toMatchObject({ url: 'ws://127.0.0.1:4747/ws', headers: { authorization: 'Bearer tok' } })
    sockets[0]!.emit('message', JSON.stringify({ type: 'status', botId: 'chief', state: 'thinking' }))
    sockets[0]!.emit('message', 'not json')
    expect(events).toEqual([{ type: 'status', botId: 'chief', state: 'thinking' }])
    port = 4748
    sockets[0]!.emit('close')
    await vi.waitFor(() => expect(sockets).toHaveLength(2))
    expect(sockets[1]!.url).toBe('ws://127.0.0.1:4748/ws')
    stop()
    expect(sockets[1]!.closed).toBe(true)
    sockets[1]!.emit('close')
    await new Promise((r) => setTimeout(r, 20))
    expect(sockets).toHaveLength(2)
  })

  it('reads the summary, or nothing when the gateway does not answer', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ working: 1, waiting: 2, routines: 3 })))
    expect(await fetchSummary('http://127.0.0.1:4747', 'tok', ok as unknown as typeof fetch)).toEqual({ working: 1, waiting: 2, routines: 3 })
    expect(ok).toHaveBeenCalledWith('http://127.0.0.1:4747/api/summary', expect.objectContaining({ headers: { authorization: 'Bearer tok' } }))
    const down = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    expect(await fetchSummary('http://127.0.0.1:4747', 'tok', down as unknown as typeof fetch)).toBeNull()
  })
})
