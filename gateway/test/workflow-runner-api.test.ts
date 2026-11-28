import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PageLike } from '../src/browser-page.js'
import { createFakeComputer } from '../src/computer.js'
import { createRule, getApproval } from '../src/approvals.js'
import { ensureDmThread, openDb, upsertBot } from '../src/db.js'
import type { GatewayEvent, Hub } from '../src/hub.js'
import type { ChatMsg, LLM } from '../src/llm.js'
import { createPool } from '../src/pool.js'
import { createApp } from '../src/server.js'
import { saveWorkflowTrace } from '../src/workflows.js'
import { createVaultItem, setBotVaultItems } from '../src/vault/store.js'

const bot = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }

function setup(options: {
  click?: (label: string) => Promise<void>
  navigateAfterClick?: string
  missingTarget?: string
  pageUrl?: string
  pageText?: string
  otherPageText?: string
  switchWorkflowPage?: boolean
  closePageOnMissingTarget?: boolean
  closePageOnDispose?: boolean
  closePageAfterClick?: boolean
  pageError?: string
  onPing?: (page: PageLike) => void | Promise<void>
  db?: ReturnType<typeof openDb>
  chat?: LLM['chat']
  hub?: Hub
} = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'osb-workflow-runner-'))
  const db = options.db ?? openDb(':memory:')
  upsertBot(db, bot)
  const threadId = ensureDmThread(db, bot.id)
  const calls: string[] = []
  const pageCalls = { pinned: [] as string[], other: [] as string[] }
  let pinnedClosed = false
  const makePage = (name: 'pinned' | 'other', initialUrl: string, text: string) => {
    let pageUrl = initialUrl
    return {
      async goto(url: string) { pageUrl = url; calls.push(`goto:${url}`) },
      url: () => pageUrl,
      async title() { return `${name} page` },
      async innerText() {
        if (options.pageError) throw new Error(options.pageError)
        return text
      },
      async screenshot() { return Buffer.alloc(0) },
      async click(target: string) {
        calls.push(`click:${target}`)
        pageCalls[name].push(`click:${target}`)
        await options.click?.(target)
        if (options.navigateAfterClick) pageUrl = options.navigateAfterClick
        if (name === 'pinned' && options.closePageAfterClick) pinnedClosed = true
      },
      isClosed: () => name === 'pinned' && pinnedClosed,
      viewportSize: () => ({ width: 800, height: 600 }),
      getByLabel(label: string) {
        return { first: () => ({
          async waitFor() {
            calls.push(`visible:${label}`)
            if (label === options.missingTarget) {
              if (name === 'pinned' && options.closePageOnMissingTarget) pinnedClosed = true
              const timeout = new Error('target is not visible')
              timeout.name = 'TimeoutError'
              throw timeout
            }
          },
          async fill(value: string) { calls.push(`fill:${label}:${value}`); pageCalls[name].push(`fill:${label}:${value}`) },
          async click() {
            calls.push(`click:${label}`)
            pageCalls[name].push(`click:${label}`)
            await options.click?.(label)
            if (options.navigateAfterClick) pageUrl = options.navigateAfterClick
            if (name === 'pinned' && options.closePageAfterClick) pinnedClosed = true
          },
          async selectOption(value: string) { calls.push(`select:${label}:${value}`) },
          async check() { calls.push(`check:${label}`) },
          async uncheck() { calls.push(`uncheck:${label}`) },
          async press(key: string) { calls.push(`press:${label}:${key}`) },
        }) }
      },
      on() {},
      off() { if (name === 'pinned' && options.closePageOnDispose) pinnedClosed = true },
    } as unknown as PageLike
  }
  const pinnedPage = makePage('pinned', options.pageUrl ?? 'https://example.test/', options.pageText ?? 'pinned page body')
  const otherPage = makePage('other', options.pageUrl ?? 'https://example.test/', options.otherPageText ?? 'other tab body')
  let workflowPageCalls = 0
  const computer = createFakeComputer({
    ping: async () => { await options.onPing?.(pinnedPage); return true },
    workflowPage: async () => {
      workflowPageCalls++
      return options.switchWorkflowPage && workflowPageCalls > 1 ? otherPage : pinnedPage
    },
    pageText: 'regular tab body',
  })
  const pool = createPool({ dataDir, makeComputer: async () => computer })
  const chat = vi.fn(options.chat ?? (async () => ({ content: 'ok', toolCalls: [], raw: { role: 'assistant' as const, content: 'ok' } })))
  const llm: LLM = { chat }
  const app = createApp({ db, llm, pool, ...(options.hub ? { hub: options.hub } : {}) })
  return { dataDir, db, pool, app, calls, pageCalls, chat, llm, threadId }
}

function collectingHub(events: GatewayEvent[]): Hub {
  return { add: () => {}, remove: () => {}, broadcast: (event) => events.push(event), size: () => 0 }
}

function statusStates(events: GatewayEvent[]): string[] {
  return events.flatMap((event) => event.type === 'status' && event.botId === bot.id ? [event.state] : [])
}

const send = (app: ReturnType<typeof createApp>['app'], method: string, path: string, body?: unknown) => app.request(path, {
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

const rawToolCall = (id: string, name: string, args: Record<string, unknown>, native?: ChatMsg['native']) => ({
  role: 'assistant' as const,
  content: '',
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  ...(native ? { native } : {}),
})

describe('workflow replay API', () => {
  const cleanups: (() => Promise<void>)[] = []
  afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())) })

  it('hands target drift to the agent without exposing bindings or bypassing the run rule limit', async () => {
    let chatCount = 0
    let fallbackTools: string[] = []
    const state = setup({
      missingTarget: 'Save',
      chat: async (_messages, tools) => {
        chatCount += 1
        fallbackTools = (tools ?? []).map((tool) => tool.function.name)
        return chatCount === 1
          ? {
              content: '',
              toolCalls: [{
                id: 'approval-1',
                name: 'hold_for_approval',
                args: { action: 'Send the order', detail: 'Send the prepared order.', kind: 'email', target: 'recipient@example.test' },
              }],
              raw: { role: 'assistant' as const, content: '' },
            }
          : { content: 'I held the action for approval.', toolCalls: [], raw: { role: 'assistant' as const, content: 'I held the action for approval.' } }
      },
    })
    cleanups.push(async () => {
      state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    createRule(state.db, { botId: bot.id, kind: 'email', target: 'recipient@example.test', duration: 'always', now: Date.now() })
    const runtimeValue = 'runtime-private@example.test'
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Submit order', intent: 'Submit the operator-approved order', steps: [
        { type: 'fill', target: { candidates: [{ label: 'Recipient' }] }, value: { kind: 'placeholder', key: 'recipient' } },
        { type: 'click', intent: 'Click Save after reviewing the order', target: { candidates: [{ label: 'Save' }] } },
      ],
    })

    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`, {
      bindings: { recipient: runtimeValue },
    })
    expect(started.status).toBe(202)
    await vi.waitFor(() => expect(state.app.isBusy(bot.id)).toBe(false), { timeout: 9_000 })

    const modelInput = JSON.stringify(state.chat.mock.calls.map(([messages]) => messages))
    expect(state.chat).toHaveBeenCalled()
    expect(modelInput).toContain('Submit the operator-approved order')
    expect(modelInput).toContain('Click Save after reviewing the order')
    expect(modelInput).toContain('target_not_found')
    expect(modelInput).toContain('Save')
    expect(modelInput).not.toContain(runtimeValue)
    expect(fallbackTools).not.toContain('hold_for_approval')
    expect(modelInput).toContain('unavailable during workflow browser handoff')
    expect(state.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get()).toMatchObject({ n: 0 })
    expect(state.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'approved'").get()).toMatchObject({ n: 0 })
  })

  it('keeps fallback browser tools on the pinned workflow page and preserves action guardrails', async () => {
    let chatCount = 0
    const state = setup({
      pageUrl: 'https://pinned.example.test/checkout?token=private-query-value#private-fragment',
      pageText: 'Pinned workflow page content',
      switchWorkflowPage: true,
      chat: async () => {
        chatCount += 1
        if (chatCount === 1) {
          return { content: '', toolCalls: [{ id: 'read-1', name: 'browser_extract', args: {} }], raw: { role: 'assistant' as const, content: '' } }
        }
        if (chatCount === 2) {
          return { content: '', toolCalls: [{ id: 'click-1', name: 'browser_click', args: { target: 'Pay now' } }], raw: { role: 'assistant' as const, content: '' } }
        }
        return { content: 'I stopped for operator approval.', toolCalls: [], raw: { role: 'assistant' as const, content: 'I stopped for operator approval.' } }
      },
    })
    cleanups.push(async () => {
      state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Continue checkout', intent: 'Continue the checkout', steps: [
        {
          type: 'click', intent: 'Continue after checking the page',
          target: { candidates: [{ label: 'Continue' }] },
          expect: { url: 'https://pinned.example.test/next?session=expected-secret#expected-fragment' },
        },
      ],
    })

    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`)
    expect(started.status).toBe(202)
    await vi.waitFor(
      () => expect(state.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get()).toMatchObject({ n: 1 }),
      { timeout: 7_000, interval: 25 },
    )

    const sentMessages = state.chat.mock.calls.map(([messages]) => JSON.stringify(messages))
    expect(sentMessages[0]).toContain('url_mismatch')
    expect(sentMessages[0]).toContain('https://pinned.example.test/checkout?token=')
    expect(sentMessages[0]).not.toContain('private-query-value')
    expect(sentMessages[0]).not.toContain('private-fragment')
    expect(sentMessages[0]).not.toContain('expected-secret')
    expect(sentMessages[1]).toContain('Pinned workflow page content')
    expect(sentMessages[1]).not.toContain('regular tab body')
    const approval = state.db.prepare("SELECT id, execution_json FROM approvals WHERE status = 'pending'").get() as { id: number; execution_json: string }
    expect(JSON.parse(approval.execution_json)).toMatchObject({ expectedOrigin: 'https://pinned.example.test' })
    const approvalPayload = state.db.prepare("SELECT payload FROM messages WHERE kind = 'approval_request' ORDER BY id DESC LIMIT 1").get() as { payload: string }
    expect(JSON.parse(approvalPayload.payload)).not.toHaveProperty('editable')

    const approved = await send(state.app.app, 'POST', `/api/approvals/${approval.id}`, { decision: 'approve' })
    expect(approved.status).toBe(202)
    await vi.waitFor(() => expect(state.pageCalls.pinned).toContain('click:Pay now'))
    await vi.waitFor(() => expect(state.app.isBusy(bot.id)).toBe(false))
    expect(state.pageCalls.other).not.toContain('click:Pay now')
  }, 10_000)

  it('redacts workflow bindings from fallback URLs and page text', async () => {
    const runtimeValue = 'private person 80317@example.test'
    let fallbackCalls = 0
    const state = setup({
      pageUrl: `https://example.test/account/${encodeURIComponent(runtimeValue)}?${encodeURIComponent(runtimeValue)}=private-query-value`,
      pageText: `The signed-in account is ${runtimeValue}.`,
      missingTarget: 'Continue',
      chat: async () => ++fallbackCalls === 1
        ? { content: '', toolCalls: [{ id: 'read-private-page', name: 'browser_extract', args: {} }], raw: { role: 'assistant' as const, content: '' } }
        : { content: 'I finished reading the page.', toolCalls: [], raw: { role: 'assistant' as const, content: 'I finished reading the page.' } },
    })
    cleanups.push(async () => {
      state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Check account', intent: 'Check the account page', steps: [
        { type: 'fill', target: { candidates: [{ label: 'Email' }] }, value: { kind: 'placeholder', key: 'email' } },
        { type: 'click', target: { candidates: [{ label: 'Continue' }] } },
      ],
    })

    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`, {
      bindings: { email: runtimeValue },
    })
    expect(started.status).toBe(202)
    await vi.waitFor(() => expect(state.app.isBusy(bot.id)).toBe(false), { timeout: 10_000 })

    const sentMessages = JSON.stringify(state.chat.mock.calls.map(([messages]) => messages))
    expect(sentMessages).not.toContain(runtimeValue)
    expect(sentMessages).not.toContain(encodeURIComponent(runtimeValue))
    expect(sentMessages).not.toContain('private+person+80317')
    expect(sentMessages).not.toContain('private%20person')
    expect(sentMessages).not.toContain('private-query-value')
    expect(sentMessages).toContain('[private workflow value]')
  }, 12_000)

  it('redacts browser errors, raw tool calls, activity output, and final replies during handoff', async () => {
    const runtimeValue = 'private-error-91824@example.test'
    let fallbackCalls = 0
    let toolNames: string[] = []
    const state = setup({
      pageError: `browser failed near ${runtimeValue}`,
      missingTarget: 'Continue',
      chat: async (_messages, tools) => {
        toolNames = (tools ?? []).map((tool) => tool.function.name)
        fallbackCalls++
        if (fallbackCalls === 1) {
          return { content: '', toolCalls: [{ id: 'extract-private', name: 'browser_extract', args: {} }], raw: rawToolCall('extract-private', 'browser_extract', {}) }
        }
        if (fallbackCalls === 2) {
          const args = { target: runtimeValue, text: runtimeValue }
          return {
            content: '',
            toolCalls: [{ id: 'type-private', name: 'browser_type', args }],
            raw: rawToolCall('type-private', 'browser_type', args, {
              api: 'anthropic',
              route: 'test-model',
              items: [{
                type: 'tool_use',
                id: 'native-type-private',
                name: 'browser_type',
                input: { name: runtimeValue, text: runtimeValue },
              }],
            }),
          }
        }
        if (fallbackCalls === 3) {
          const args = { question: `Should I continue as ${runtimeValue}?`, options: ['Yes', `No, keep ${runtimeValue}`] }
          return {
            content: '',
            toolCalls: [{ id: 'ask-private', name: 'ask_operator', args }],
            raw: rawToolCall('ask-private', 'ask_operator', args),
          }
        }
        const reply = `I found ${runtimeValue} but will stop and wait for you.`
        return { content: reply, toolCalls: [], raw: { role: 'assistant' as const, content: reply } }
      },
    })
    cleanups.push(async () => {
      state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Check account', steps: [
        { type: 'fill', target: { candidates: [{ label: 'Email' }] }, value: { kind: 'placeholder', key: 'email' } },
        { type: 'click', target: { candidates: [{ label: 'Continue' }] } },
      ],
    })
    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`, {
      bindings: { email: runtimeValue },
    })
    expect(started.status).toBe(202)
    await vi.waitFor(() => expect(state.app.isBusy(bot.id)).toBe(false), { timeout: 10_000 })

    const modelInput = JSON.stringify(state.chat.mock.calls.map(([messages]) => messages))
    const persisted = JSON.stringify({
      messages: state.db.prepare('SELECT * FROM messages').all(),
      actions: state.db.prepare('SELECT * FROM actions').all(),
    })
    expect(modelInput).not.toContain(runtimeValue)
    expect(modelInput).toContain('[private workflow value]')
    const inputMessages = (JSON.parse(modelInput) as Array<Array<{
      role?: string
      tool_call_id?: string
      native?: unknown
      tool_calls?: Array<{ id?: string; function?: { arguments?: string } }>
    }>>).flat()
    const typeCallMessage = inputMessages.find((message) =>
      message.role === 'assistant' && message.tool_calls?.some((call) => call.id === 'type-private'),
    )
    const typeCall = typeCallMessage?.tool_calls?.find((call) => call.id === 'type-private')
    const typeReply = inputMessages.find((message) => message.role === 'tool' && message.tool_call_id === 'type-private')
    expect(typeCall?.id).toBe('type-private')
    expect(typeCallMessage).not.toHaveProperty('native')
    expect(typeReply?.tool_call_id).toBe(typeCall?.id)
    expect(JSON.parse(typeCall?.function?.arguments ?? '{}')).toMatchObject({
      target: '[private workflow value]',
      text: '[private workflow value]',
    })
    expect(toolNames).not.toContain('ask_operator')
    expect(persisted).not.toContain(runtimeValue)
    expect(persisted).toContain('[private workflow value]')
    expect(state.db.prepare("SELECT count(*) AS n FROM messages WHERE kind = 'question'").get()).toMatchObject({ n: 0 })
  }, 12_000)

  it('does not use a standing approval rule during fallback without bindings', async () => {
    let fallbackCalls = 0
    const state = setup({
      pageUrl: 'https://example.test/current',
      chat: async () => ++fallbackCalls === 1
        ? {
            content: '',
            toolCalls: [{
              id: 'hold-action',
              name: 'hold_for_approval',
              args: { action: 'Send the message', detail: 'Send the drafted message.', kind: 'email', target: 'recipient@example.test' },
            }],
            raw: { role: 'assistant' as const, content: '' },
          }
        : { content: 'I stopped for approval.', toolCalls: [], raw: { role: 'assistant' as const, content: 'I stopped for approval.' } },
    })
    cleanups.push(async () => {
      state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    createRule(state.db, { botId: bot.id, kind: 'email', target: 'recipient@example.test', duration: 'always', now: Date.now() })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Continue message', steps: [
        {
          type: 'click', target: { candidates: [{ label: 'Continue' }] },
          expect: { url: 'https://example.test/next' },
        },
      ],
    })

    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`)
    expect(started.status).toBe(202)
    await vi.waitFor(() => expect(state.app.isBusy(bot.id)).toBe(false), { timeout: 9_000 })
    expect(state.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get()).toMatchObject({ n: 0 })
    expect(state.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'approved'").get()).toMatchObject({ n: 0 })
  }, 12_000)

  it('rechecks the approved page origin after the browser computer reconnects', async () => {
    let pingCount = 0
    const state = setup({
      pageUrl: 'https://pinned.example.test/checkout',
      missingTarget: 'Continue',
      onPing: async (page) => {
        pingCount++
        if (pingCount === 2) await page.goto('https://elsewhere.example.test/checkout')
      },
      chat: async () => ({
        content: '',
        toolCalls: [{ id: 'guarded-click', name: 'browser_click', args: { target: 'Pay now' } }],
        raw: { role: 'assistant' as const, content: '' },
      }),
    })
    cleanups.push(async () => {
      state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Continue checkout', steps: [
        { type: 'click', target: { candidates: [{ label: 'Continue' }] } },
      ],
    })
    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`)
    expect(started.status).toBe(202)
    await vi.waitFor(() => expect(state.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get()).toMatchObject({ n: 1 }), { timeout: 9_000 })
    const approval = state.db.prepare("SELECT id FROM approvals WHERE status = 'pending'").get() as { id: number }
    await send(state.app.app, 'POST', `/api/approvals/${approval.id}`, { decision: 'approve' })
    await vi.waitFor(() => expect(state.app.isBusy(bot.id)).toBe(false), { timeout: 9_000 })
    expect(state.pageCalls.pinned).not.toContain('click:Pay now')
  }, 12_000)

  it('reports an approved click that redirects as successful', async () => {
    let fallbackCalls = 0
    const state = setup({
      pageUrl: 'https://pinned.example.test/checkout',
      missingTarget: 'Continue',
      navigateAfterClick: 'https://payments.example.test/complete',
      chat: async () => {
        fallbackCalls++
        return fallbackCalls === 1
          ? {
              content: '',
              toolCalls: [{ id: 'redirect-click', name: 'browser_click', args: { target: 'Pay now' } }],
              raw: rawToolCall('redirect-click', 'browser_click', { target: 'Pay now' }),
            }
          : { content: 'The approved action completed on the payment page.', toolCalls: [], raw: { role: 'assistant' as const, content: 'The approved action completed on the payment page.' } }
      },
    })
    cleanups.push(async () => {
      state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Continue checkout', steps: [
        { type: 'click', target: { candidates: [{ label: 'Continue' }] } },
      ],
    })
    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`)
    expect(started.status).toBe(202)
    await vi.waitFor(() => expect(state.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get()).toMatchObject({ n: 1 }))
    const approval = state.db.prepare("SELECT id FROM approvals WHERE status = 'pending'").get() as { id: number }
    await send(state.app.app, 'POST', `/api/approvals/${approval.id}`, { decision: 'approve' })
    await vi.waitFor(() => expect(state.app.isBusy(bot.id)).toBe(false), { timeout: 9_000 })
    expect(state.pageCalls.pinned).toContain('click:Pay now')
    expect(getApproval(state.db, approval.id)).toMatchObject({ status: 'approved', execution_status: 'succeeded' })
    expect(state.chat).toHaveBeenCalledTimes(2)
  }, 12_000)

  it('does not persist a quoted or escaped workflow value in a guardrail approval', async () => {
    const runtimeValue = 'private-"line"\\\nvalue@example.test'
    let fallbackCalls = 0
    const args = { target: `Pay now ${runtimeValue}` }
    const state = setup({
      pageUrl: 'https://example.test/checkout',
      missingTarget: 'Continue',
      chat: async () => {
        fallbackCalls++
        return fallbackCalls === 1
          ? {
              content: '',
              toolCalls: [{ id: 'private-click', name: 'browser_click', args }],
              raw: rawToolCall('private-click', 'browser_click', args),
            }
          : { content: 'I could not safely approve that action.', toolCalls: [], raw: { role: 'assistant' as const, content: 'I could not safely approve that action.' } }
      },
    })
    cleanups.push(async () => {
      state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Continue checkout', steps: [
        { type: 'fill', target: { candidates: [{ label: 'Email' }] }, value: { kind: 'placeholder', key: 'email' } },
        { type: 'click', target: { candidates: [{ label: 'Continue' }] } },
      ],
    })
    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`, {
      bindings: { email: runtimeValue },
    })
    expect(started.status).toBe(202)
    await vi.waitFor(() => expect(state.app.isBusy(bot.id)).toBe(false), { timeout: 10_000 })
    const stored = JSON.stringify({
      approvals: state.db.prepare('SELECT * FROM approvals').all(),
      messages: state.db.prepare('SELECT * FROM messages').all(),
      actions: state.db.prepare('SELECT * FROM actions').all(),
    })
    expect(stored).not.toContain(runtimeValue)
    expect(stored).toContain('[private workflow value]')
    expect(state.db.prepare('SELECT count(*) AS n FROM approvals').get()).toMatchObject({ n: 0 })
  }, 12_000)

  it('rejects a numeric private value before freezing a browser approval', async () => {
    const runtimeValue = '123456789'
    let fallbackCalls = 0
    const args = { target: 'Continue', text: Number(runtimeValue), submit: true }
    const state = setup({
      pageUrl: 'https://example.test/checkout',
      missingTarget: 'Continue',
      chat: async () => {
        fallbackCalls++
        return fallbackCalls === 1
          ? {
              content: '',
              toolCalls: [{ id: 'numeric-private-type', name: 'browser_type', args }],
              raw: rawToolCall('numeric-private-type', 'browser_type', args),
            }
          : { content: 'I stopped because the action could not be safely approved.', toolCalls: [], raw: { role: 'assistant' as const, content: 'I stopped because the action could not be safely approved.' } }
      },
    })
    cleanups.push(async () => {
      state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Submit checkout', steps: [
        { type: 'fill', target: { candidates: [{ label: 'Email' }] }, value: { kind: 'placeholder', key: 'email' } },
        { type: 'click', target: { candidates: [{ label: 'Continue' }] } },
      ],
    })
    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`, {
      bindings: { email: runtimeValue },
    })
    expect(started.status).toBe(202)
    await vi.waitFor(() => expect(state.app.isBusy(bot.id)).toBe(false), { timeout: 10_000 })

    const stored = JSON.stringify({
      approvals: state.db.prepare('SELECT * FROM approvals').all(),
      messages: state.db.prepare('SELECT * FROM messages').all(),
      actions: state.db.prepare('SELECT * FROM actions').all(),
    })
    expect(stored).not.toContain(runtimeValue)
    expect(state.db.prepare('SELECT count(*) AS n FROM approvals').get()).toMatchObject({ n: 0 })
    expect(fallbackCalls).toBe(2)
  }, 12_000)

  it('does not reject an unrelated approval because a short binding appears in static text', async () => {
    let fallbackCalls = 0
    const state = setup({
      pageUrl: 'https://example.test/checkout',
      missingTarget: 'Continue',
      chat: async () => {
        fallbackCalls++
        return {
          content: '',
          toolCalls: [{ id: 'short-binding-click', name: 'browser_click', args: { target: 'Submit' } }],
          raw: rawToolCall('short-binding-click', 'browser_click', { target: 'Submit' }),
        }
      },
    })
    cleanups.push(async () => {
      await state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Continue checkout', steps: [
        { type: 'fill', target: { candidates: [{ label: 'Email' }] }, value: { kind: 'placeholder', key: 'email' } },
        { type: 'click', target: { candidates: [{ label: 'Continue' }] } },
      ],
    })
    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`, {
      bindings: { email: 'a' },
    })
    expect(started.status).toBe(202)
    await vi.waitFor(() => expect(state.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get()).toMatchObject({ n: 1 }))
    const approval = state.db.prepare("SELECT id, execution_json FROM approvals WHERE status = 'pending'").get() as { id: number; execution_json: string }
    expect(JSON.parse(approval.execution_json)).toMatchObject({ kind: 'computer_guardrail', tool: 'browser_click' })
    expect(state.db.prepare("SELECT action FROM approvals WHERE id = ?").get(approval.id)).toMatchObject({ action: expect.stringContaining('Submit') })

    expect((await send(state.app.app, 'POST', `/api/approvals/${approval.id}`, { decision: 'discard' })).status).toBe(202)
    await vi.waitFor(() => expect(state.app.isBusy(bot.id)).toBe(false))
    expect(fallbackCalls).toBe(1)
  }, 12_000)

  it('classifies guardrail actions using the real pinned URL while redacting it from prompts', async () => {
    const runtimeValue = 'checkout'
    const state = setup({
      pageUrl: `https://example.test/${runtimeValue}`,
      missingTarget: 'Continue',
      chat: async () => ({
        content: '',
        toolCalls: [{ id: 'guardrail-enter', name: 'browser_press', args: { key: 'Enter' } }],
        raw: rawToolCall('guardrail-enter', 'browser_press', { key: 'Enter' }),
      }),
    })
    cleanups.push(async () => {
      await state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Continue checkout', steps: [
        { type: 'fill', target: { candidates: [{ label: 'Email' }] }, value: { kind: 'placeholder', key: 'email' } },
        { type: 'click', target: { candidates: [{ label: 'Continue' }] } },
      ],
    })
    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`, {
      bindings: { email: runtimeValue },
    })
    expect(started.status).toBe(202)
    await vi.waitFor(() => expect(state.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get()).toMatchObject({ n: 1 }))

    const approval = state.db.prepare("SELECT id, execution_json FROM approvals WHERE status = 'pending'").get() as { id: number; execution_json: string }
    expect(JSON.parse(approval.execution_json)).toMatchObject({ tool: 'browser_press', args: { key: 'Enter' } })
    const promptContext = JSON.stringify(state.chat.mock.calls.map(([messages]) =>
      (messages ?? []).filter((message) => message.role !== 'system'),
    ))
    const firstUserPrompt = (state.chat.mock.calls[0]?.[0] ?? []).find((message) => message.role === 'user')?.content ?? ''
    expect(firstUserPrompt).toContain('"workflowTitle":"Continue [private workflow value]"')
    expect(promptContext).toContain('https://example.test/:redacted')
    expect(promptContext).not.toContain('https://example.test/checkout')
    expect(promptContext).not.toContain(runtimeValue)

    expect((await send(state.app.app, 'POST', `/api/approvals/${approval.id}`, { decision: 'discard' })).status).toBe(202)
    await vi.waitFor(() => expect(state.app.isBusy(bot.id)).toBe(false))
    expect(state.pageCalls.pinned).not.toContain('press:Enter')
  }, 12_000)

  it('keeps a private browser port only in the active guardrail continuation', async () => {
    const runtimeValue = '41337'
    let fallbackCalls = 0
    const state = setup({
      pageUrl: `https://example.test:${runtimeValue}/checkout`,
      missingTarget: 'Continue',
      chat: async () => {
        fallbackCalls++
        return fallbackCalls === 1
          ? {
              content: '',
              toolCalls: [{ id: 'private-origin-click', name: 'browser_click', args: { target: 'Pay now' } }],
              raw: rawToolCall('private-origin-click', 'browser_click', { target: 'Pay now' }),
            }
          : { content: 'The approved action completed.', toolCalls: [], raw: { role: 'assistant' as const, content: 'The approved action completed.' } }
      },
    })
    cleanups.push(async () => {
      await state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Continue checkout', steps: [
        { type: 'fill', target: { candidates: [{ label: 'Email' }] }, value: { kind: 'placeholder', key: 'email' } },
        { type: 'click', target: { candidates: [{ label: 'Continue' }] } },
      ],
    })
    expect((await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`, {
      bindings: { email: runtimeValue },
    })).status).toBe(202)
    await vi.waitFor(() => expect(state.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get()).toMatchObject({ n: 1 }))

    const approval = state.db.prepare("SELECT id, execution_json FROM approvals WHERE status = 'pending'").get() as { id: number; execution_json: string }
    const persistedExecution = JSON.parse(approval.execution_json) as { expectedOrigin: string }
    expect(persistedExecution.expectedOrigin).toBe('https://example.test:[private workflow value]')
    expect(approval.execution_json).not.toContain(runtimeValue)

    expect((await send(state.app.app, 'POST', `/api/approvals/${approval.id}`, { decision: 'approve' })).status).toBe(202)
    await vi.waitFor(() => expect(state.db.prepare('SELECT execution_status FROM approvals WHERE id = ?').get(approval.id)).toMatchObject({ execution_status: 'succeeded' }))
    await vi.waitFor(() => expect(state.app.isBusy(bot.id)).toBe(false))
    expect(state.pageCalls.pinned).toContain('click:Pay now')
    expect(fallbackCalls).toBe(2)
    const persisted = JSON.stringify({
      approvals: state.db.prepare('SELECT * FROM approvals').all(),
      messages: state.db.prepare('SELECT * FROM messages').all(),
      actions: state.db.prepare('SELECT * FROM actions').all(),
    })
    expect(persisted).not.toContain(runtimeValue)
  }, 12_000)

  it('redacts multiple short bindings in one pass without rewriting the placeholder', async () => {
    let fallbackCalls = 0
    const state = setup({
      pageText: 'x',
      missingTarget: 'Continue',
      chat: async () => {
        fallbackCalls++
        return fallbackCalls === 1
          ? {
              content: '',
              toolCalls: [{ id: 'extract-short-values', name: 'browser_extract', args: {} }],
              raw: rawToolCall('extract-short-values', 'browser_extract', {}),
            }
          : { content: 'I have finished reading.', toolCalls: [], raw: { role: 'assistant' as const, content: 'I have finished reading.' } }
      },
    })
    cleanups.push(async () => {
      await state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Read the page', steps: [
        { type: 'fill', target: { candidates: [{ label: 'Email' }] }, value: { kind: 'placeholder', key: 'email' } },
        { type: 'fill', target: { candidates: [{ label: 'Code' }] }, value: { kind: 'placeholder', key: 'code' } },
        { type: 'click', target: { candidates: [{ label: 'Continue' }] } },
      ],
    })
    expect((await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`, {
      bindings: { email: 'x', code: 'a' },
    })).status).toBe(202)
    await vi.waitFor(() => expect(state.app.isBusy(bot.id)).toBe(false), { timeout: 10_000 })

    const modelMessages = state.chat.mock.calls[1]?.[0] ?? []
    const extractedText = modelMessages.find((message) => message.role === 'tool' && message.tool_call_id === 'extract-short-values')
    expect(extractedText?.content).toBe('[private workflow value]')
    expect(fallbackCalls).toBe(2)
  }, 12_000)

  it('records an approved click as successful when the click closes its page', async () => {
    const state = setup({
      missingTarget: 'Continue',
      closePageAfterClick: true,
      chat: async () => ({
        content: '',
        toolCalls: [{ id: 'close-after-click', name: 'browser_click', args: { target: 'Pay now' } }],
        raw: rawToolCall('close-after-click', 'browser_click', { target: 'Pay now' }),
      }),
    })
    cleanups.push(async () => {
      await state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Finish payment', steps: [
        { type: 'click', target: { candidates: [{ label: 'Continue' }] } },
      ],
    })
    expect((await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`)).status).toBe(202)
    await vi.waitFor(() => expect(state.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get()).toMatchObject({ n: 1 }))
    const approval = state.db.prepare("SELECT id FROM approvals WHERE status = 'pending'").get() as { id: number }

    expect((await send(state.app.app, 'POST', `/api/approvals/${approval.id}`, { decision: 'approve' })).status).toBe(202)
    await vi.waitFor(() => expect(state.db.prepare('SELECT execution_status FROM approvals WHERE id = ?').get(approval.id)).toMatchObject({ execution_status: 'succeeded' }))
    await vi.waitFor(() => expect(state.app.isBusy(bot.id)).toBe(false))

    expect(state.pageCalls.pinned).toContain('click:Pay now')
    expect(state.chat).toHaveBeenCalledTimes(1)
    const messages = JSON.stringify(state.db.prepare('SELECT content, payload FROM messages').all())
    expect(messages).toContain('browser page closed')
    expect(messages).toContain('No later actions were run.')
  }, 12_000)

  it('does not expose Vault items or screenshots during browser handoff', async () => {
    let toolNames: string[] = []
    let modelMessages = ''
    const state = setup({
      missingTarget: 'Continue',
      chat: async (messages, tools) => {
        toolNames = (tools ?? []).map((tool) => tool.function.name)
        modelMessages = JSON.stringify(messages)
        return { content: 'I cannot use stored credentials here.', toolCalls: [], raw: { role: 'assistant' as const, content: 'I cannot use stored credentials here.' } }
      },
    })
    cleanups.push(async () => {
      state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const item = createVaultItem(state.db, {
      name: 'Private account entry',
      kind: 'login',
      allowedDomains: ['example.test'],
      fields: [{ key: 'username', kind: 'text' }],
    })
    setBotVaultItems(state.db, bot.id, [item.id])
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Open account page', steps: [
        { type: 'click', target: { candidates: [{ label: 'Continue' }] } },
      ],
    })

    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`)
    expect(started.status).toBe(202)
    await vi.waitFor(() => expect(state.app.isBusy(bot.id)).toBe(false), { timeout: 10_000 })

    expect(toolNames).toContain('browser_extract')
    expect(toolNames).not.toContain('browser_fill_secret')
    expect(toolNames).not.toContain('browser_screenshot')
    expect(modelMessages).not.toContain('Private account entry')
  }, 12_000)

  it('does not hand a closed browser page to the agent fallback', async () => {
    const state = setup({ missingTarget: 'Continue', closePageOnMissingTarget: true })
    cleanups.push(async () => {
      state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Continue form', steps: [
        { type: 'click', target: { candidates: [{ label: 'Continue' }] } },
      ],
    })

    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`)
    expect(started.status).toBe(202)
    await vi.waitFor(() => expect(state.app.isBusy(bot.id)).toBe(false))
    expect(state.chat).not.toHaveBeenCalled()
  })

  it('does not hand off when the pinned page closes after runner drift detection', async () => {
    const state = setup({ missingTarget: 'Continue', closePageOnDispose: true })
    cleanups.push(async () => {
      state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Continue form', steps: [
        { type: 'click', target: { candidates: [{ label: 'Continue' }] } },
      ],
    })

    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`)
    expect(started.status).toBe(202)
    await vi.waitFor(() => expect(state.app.isBusy(bot.id)).toBe(false))
    expect(state.chat).not.toHaveBeenCalled()
  })

  it('stops after an approved browser action already in progress', async () => {
    let clickStarted!: () => void
    let finishClick!: () => void
    const clickStartedPromise = new Promise<void>((resolve) => { clickStarted = resolve })
    const clickFinishedPromise = new Promise<void>((resolve) => { finishClick = resolve })
    const events: GatewayEvent[] = []
    const state = setup({
      hub: collectingHub(events),
      missingTarget: 'Continue',
      click: async () => { clickStarted(); await clickFinishedPromise },
      chat: async () => ({
        content: '',
        toolCalls: [{ id: 'guarded-click', name: 'browser_click', args: { target: 'Pay now' } }],
        raw: { role: 'assistant' as const, content: '' },
      }),
    })
    cleanups.push(async () => {
      finishClick()
      state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Continue checkout', steps: [
        { type: 'click', target: { candidates: [{ label: 'Continue' }] } },
      ],
    })
    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`)
    expect(started.status).toBe(202)
    await vi.waitFor(() => expect(state.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get()).toMatchObject({ n: 1 }))
    const approval = state.db.prepare("SELECT id FROM approvals WHERE status = 'pending'").get() as { id: number }
    const approvalRequest = send(state.app.app, 'POST', `/api/approvals/${approval.id}`, { decision: 'approve' })
    await clickStartedPromise
    expect(state.app.hello()).toEqual({ type: 'hello', statuses: { [bot.id]: 'thinking' } })
    expect(statusStates(events)).toEqual(['thinking', 'waiting', 'thinking'])

    const stopped = await send(state.app.app, 'POST', `/api/threads/${state.threadId}/stop`)
    expect(stopped.status).toBe(200)
    finishClick()
    expect((await approvalRequest).status).toBe(202)
    await vi.waitFor(() => expect(state.app.isBusy(bot.id)).toBe(false))
    expect(state.chat).toHaveBeenCalledTimes(1)
    expect(state.db.prepare("SELECT status FROM approvals WHERE id = ?").get(approval.id)).toMatchObject({ status: 'approved' })
    const messages = JSON.stringify(state.db.prepare('SELECT content, payload FROM messages').all())
    expect(messages).toContain('No later actions were run.')
  }, 12_000)

  it('keeps redaction values until an approved action settles during shutdown', async () => {
    const runtimeValue = 'private-shutdown-507@example.test'
    let clickStarted!: () => void
    let finishClick!: () => void
    let fallbackCalls = 0
    const clickStartedPromise = new Promise<void>((resolve) => { clickStarted = resolve })
    const clickFinishedPromise = new Promise<void>((resolve) => { finishClick = resolve })
    const state = setup({
      pageUrl: `https://example.test/checkout/${encodeURIComponent(runtimeValue)}`,
      navigateAfterClick: `https://example.test/complete/${encodeURIComponent(runtimeValue)}`,
      missingTarget: 'Continue',
      click: async () => { clickStarted(); await clickFinishedPromise },
      chat: async () => {
        fallbackCalls++
        return fallbackCalls === 1
          ? {
              content: '',
              toolCalls: [{ id: 'shutdown-click', name: 'browser_click', args: { target: 'Pay now' } }],
              raw: rawToolCall('shutdown-click', 'browser_click', { target: 'Pay now' }),
            }
          : { content: 'The approved action completed.', toolCalls: [], raw: { role: 'assistant' as const, content: 'The approved action completed.' } }
      },
    })
    cleanups.push(async () => {
      finishClick()
      await state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Complete checkout', steps: [
        { type: 'fill', target: { candidates: [{ label: 'Email' }] }, value: { kind: 'placeholder', key: 'email' } },
        { type: 'click', target: { candidates: [{ label: 'Continue' }] } },
      ],
    })
    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`, {
      bindings: { email: runtimeValue },
    })
    expect(started.status).toBe(202)
    await vi.waitFor(() => expect(state.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get()).toMatchObject({ n: 1 }))
    const approval = state.db.prepare("SELECT id FROM approvals WHERE status = 'pending'").get() as { id: number }
    const approvalRequest = send(state.app.app, 'POST', `/api/approvals/${approval.id}`, { decision: 'approve' })
    await clickStartedPromise

    let stopCompleted = false
    const stopping = state.app.stopAll().then(() => { stopCompleted = true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(stopCompleted).toBe(false)
    finishClick()
    await stopping
    expect(stopCompleted).toBe(true)
    expect((await approvalRequest).status).toBe(202)
    await vi.waitFor(() => expect(state.app.isBusy(bot.id)).toBe(false))

    const stored = JSON.stringify({
      approvals: state.db.prepare('SELECT * FROM approvals').all(),
      messages: state.db.prepare('SELECT content, payload FROM messages').all(),
      actions: state.db.prepare('SELECT * FROM actions').all(),
    })
    expect(stored).not.toContain(runtimeValue)
    expect(stored).toContain(':redacted')
    expect(fallbackCalls).toBe(1)
  }, 12_000)

  it('releases the workflow when a binding contains an unpaired surrogate', async () => {
    const runtimeValue = '\uD800'
    let fallbackCalls = 0
    const state = setup({
      pageUrl: 'https://example.test/checkout',
      missingTarget: 'Continue',
      click: async () => { throw new Error(`browser failed near ${runtimeValue}`) },
      chat: async () => {
        fallbackCalls++
        return {
          content: '',
          toolCalls: [{ id: 'surrogate-click', name: 'browser_click', args: { target: '#pay-now' } }],
          raw: rawToolCall('surrogate-click', 'browser_click', { target: '#pay-now' }),
        }
      },
    })
    cleanups.push(async () => {
      await state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Check unusual binding', steps: [
        { type: 'fill', target: { candidates: [{ label: 'Email' }] }, value: { kind: 'placeholder', key: 'email' } },
        { type: 'click', target: { candidates: [{ label: 'Continue' }] } },
      ],
    })
    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`, {
      bindings: { email: runtimeValue },
    })
    expect(started.status).toBe(202)
    await vi.waitFor(() => expect(state.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get()).toMatchObject({ n: 1 }))
    const approval = state.db.prepare("SELECT id FROM approvals WHERE status = 'pending'").get() as { id: number }
    expect((await send(state.app.app, 'POST', `/api/approvals/${approval.id}`, { decision: 'approve' })).status).toBe(202)
    await vi.waitFor(() => expect(state.app.isBusy(bot.id)).toBe(false), { timeout: 10_000 })
    const persisted = JSON.stringify({
      messages: state.db.prepare('SELECT * FROM messages').all(),
      actions: state.db.prepare('SELECT * FROM actions').all(),
    })
    expect(persisted).not.toContain('\\ud800')
    expect(persisted).toContain('[private workflow value]')
    expect(fallbackCalls).toBeGreaterThan(0)
  }, 12_000)

  it('does not hand action failures to the agent', async () => {
    const state = setup({ click: async () => { throw new Error('browser action failed') } })
    cleanups.push(async () => {
      state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Fail closed', steps: [
        { type: 'click', target: { candidates: [{ label: 'Continue' }] } },
      ],
    })

    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`)
    expect(started.status).toBe(202)
    await vi.waitFor(() => expect(state.app.isBusy(bot.id)).toBe(false))
    expect(state.chat).not.toHaveBeenCalled()
  })

  it('resumes the approved action exactly once and keeps runtime values out of SQLite', async () => {
    const state = setup()
    cleanups.push(async () => {
      state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const runtimeValue = 'runtime-private@example.test'
    createRule(state.db, { botId: bot.id, kind: 'email', target: 'recipient@example.test', duration: 'always', now: Date.now() })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Send message', steps: [
        { type: 'fill', target: { candidates: [{ label: 'Recipient' }] }, value: { kind: 'placeholder', key: 'recipient' } },
        {
          type: 'click', target: { candidates: [{ label: 'Send' }] },
          approval: { kind: 'email', target: 'recipient@example.test', action: 'Send the message' },
        },
      ],
    })
    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`, {
      bindings: { recipient: runtimeValue },
    })
    expect(started.status).toBe(202)
    const startedBody = await started.json() as { runId: string; status: string }
    expect(startedBody.status).toBe('running')
    const computerStatus = await send(state.app.app, 'GET', `/api/bots/${bot.id}/computer`)
    const computerSnapshot = await computerStatus.json()
    expect(computerSnapshot).toMatchObject({ workflowRun: { runId: startedBody.runId, workflowId: saved.id } })
    expect(JSON.stringify(computerSnapshot)).not.toContain(runtimeValue)

    await vi.waitFor(() => expect(state.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get()).toMatchObject({ n: 1 }))
    const approval = state.db.prepare("SELECT id FROM approvals WHERE status = 'pending'").get() as { id: number }
    expect(state.calls).toContain(`fill:Recipient:${runtimeValue}`)
    expect(state.calls.some((call) => call.startsWith('click:'))).toBe(false)
    expect(state.chat).not.toHaveBeenCalled()
    const queuedTurn = await send(state.app.app, 'POST', `/api/threads/dm:${bot.id}/messages`, { text: 'wait until the workflow ends' })
    expect(queuedTurn.status).toBe(202)
    expect(state.chat).not.toHaveBeenCalled()

    // Even with a standing rule for the reviewed destination, a dynamic recipient is never auto-approved.
    expect(getApproval(state.db, approval.id)?.status).toBe('pending')
    const decision = await send(state.app.app, 'POST', `/api/approvals/${approval.id}`, { decision: 'approve' })
    expect(decision.status).toBe(202)
    await vi.waitFor(() => expect(state.calls.filter((call) => call === 'click:Send')).toHaveLength(1))
    await vi.waitFor(() => expect(state.chat).toHaveBeenCalledTimes(1)) // The queued operator turn runs only after replay releases the lane.

    const persisted = JSON.stringify({
      approvals: state.db.prepare('SELECT * FROM approvals').all(),
      messages: state.db.prepare('SELECT * FROM messages').all(),
      actions: state.db.prepare('SELECT * FROM actions').all(),
      traces: state.db.prepare('SELECT * FROM workflows').all(),
    })
    expect(persisted).not.toContain(runtimeValue)
  })

  it('stops on discard, releases the lane, and does not start an LLM turn', async () => {
    const state = setup()
    cleanups.push(async () => {
      state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Fill form', steps: [
        {
          type: 'fill', target: { candidates: [{ label: 'Password' }] }, value: { kind: 'placeholder', key: 'password' },
          approval: { kind: 'other', target: 'Password field', action: 'Fill the password field' },
        },
      ],
    })
    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`, { bindings: { password: 'memory-only' } })
    expect(started.status).toBe(202)
    await vi.waitFor(() => expect(state.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get()).toMatchObject({ n: 1 }))
    const approval = state.db.prepare("SELECT id FROM approvals WHERE status = 'pending'").get() as { id: number }
    expect(state.app.isBusy(bot.id)).toBe(true)

    const discarded = await send(state.app.app, 'POST', `/api/approvals/${approval.id}`, { decision: 'discard' })
    expect(discarded.status).toBe(202)
    expect(state.app.isBusy(bot.id)).toBe(false)
    expect(state.calls.some((call) => call.startsWith('fill:'))).toBe(false)
    expect(state.chat).not.toHaveBeenCalled()

    const secondStart = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`, { bindings: { password: 'another-memory-only' } })
    const { runId } = await secondStart.json() as { runId: string }
    await vi.waitFor(() => expect(state.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get()).toMatchObject({ n: 1 }))
    const pending = state.db.prepare("SELECT id FROM approvals WHERE status = 'pending'").get() as { id: number }
    const stopped = await send(state.app.app, 'DELETE', `/api/bots/${bot.id}/workflows/runs/${runId}`)
    expect(stopped.status).toBe(204)
    expect(getApproval(state.db, pending.id)?.status).toBe('discarded')
    expect(state.app.isBusy(bot.id)).toBe(false)
    expect(state.chat).not.toHaveBeenCalled()
  })

  it('broadcasts workflow presence while running, waiting for approval, resuming, and finishing', async () => {
    const events: GatewayEvent[] = []
    const state = setup({ hub: collectingHub(events) })
    cleanups.push(async () => {
      state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Submit form', steps: [
        {
          type: 'click', target: { candidates: [{ label: 'Submit' }] },
          approval: { kind: 'email', target: 'recipient@example.test', action: 'Submit the form' },
        },
      ],
    })

    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`)
    expect(started.status).toBe(202)
    expect(state.app.hello()).toEqual({ type: 'hello', statuses: { [bot.id]: 'thinking' } })
    await vi.waitFor(() => expect(state.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get()).toMatchObject({ n: 1 }))
    expect(statusStates(events)).toEqual(['thinking', 'waiting'])
    expect(state.app.hello()).toEqual({ type: 'hello', statuses: { [bot.id]: 'waiting' } })

    const approval = state.db.prepare("SELECT id FROM approvals WHERE status = 'pending'").get() as { id: number }
    const approved = await send(state.app.app, 'POST', `/api/approvals/${approval.id}`, { decision: 'approve' })
    expect(approved.status).toBe(202)
    await vi.waitFor(() => expect(state.app.isBusy(bot.id)).toBe(false))

    expect(statusStates(events)).toEqual(['thinking', 'waiting', 'thinking', 'idle'])
    expect(state.app.hello()).toEqual({ type: 'hello', statuses: {} })
  })

  it('Thread Stop discards a pending workflow approval and releases its lane', async () => {
    const events: GatewayEvent[] = []
    const state = setup({ hub: collectingHub(events) })
    cleanups.push(async () => {
      state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Submit form', steps: [
        {
          type: 'click', target: { candidates: [{ label: 'Submit' }] },
          approval: { kind: 'email', target: 'recipient@example.test', action: 'Submit the form' },
        },
      ],
    })
    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`)
    expect(started.status).toBe(202)
    await vi.waitFor(() => expect(state.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get()).toMatchObject({ n: 1 }))
    const approval = state.db.prepare("SELECT id FROM approvals WHERE status = 'pending'").get() as { id: number }

    const stopped = await send(state.app.app, 'POST', `/api/threads/dm:${bot.id}/stop`)
    expect(stopped.status).toBe(200)
    expect(await stopped.json()).toEqual({ stopped: 1 })
    expect(getApproval(state.db, approval.id)?.status).toBe('discarded')
    expect(state.app.isBusy(bot.id)).toBe(false)
    expect(state.calls).not.toContain('click:Submit')
    expect(statusStates(events)).toEqual(['thinking', 'waiting', 'idle'])
    expect(state.chat).not.toHaveBeenCalled()
  })

  it('Thread Stop aborts a running workflow and keeps presence until the current action unwinds', async () => {
    let actionStarted!: () => void
    let finishAction!: () => void
    const startedAction = new Promise<void>((resolve) => { actionStarted = resolve })
    const pendingAction = new Promise<void>((resolve) => { finishAction = resolve })
    const events: GatewayEvent[] = []
    const state = setup({
      hub: collectingHub(events),
      click: async (label) => { if (label === 'Continue') { actionStarted(); await pendingAction } },
    })
    cleanups.push(async () => {
      finishAction()
      state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    createRule(state.db, { botId: bot.id, kind: 'email', target: 'recipient@example.test', duration: 'always', now: Date.now() })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Continue form', steps: [
        {
          type: 'click', target: { candidates: [{ label: 'Continue' }] },
          approval: { kind: 'email', target: 'recipient@example.test', action: 'Continue the form' },
        },
      ],
    })
    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`)
    expect(started.status).toBe(202)
    await startedAction
    expect(state.app.isBusy(bot.id)).toBe(true)
    expect(state.app.hello()).toEqual({ type: 'hello', statuses: { [bot.id]: 'thinking' } })
    const summary = await send(state.app.app, 'GET', '/api/summary')
    expect(await summary.json()).toMatchObject({ working: 1 })

    const stopped = await send(state.app.app, 'POST', `/api/threads/dm:${bot.id}/stop`)
    expect(await stopped.json()).toEqual({ stopped: 1 })
    expect(state.app.isBusy(bot.id)).toBe(true)
    finishAction()
    await vi.waitFor(() => expect(state.app.isBusy(bot.id)).toBe(false))
    expect(statusStates(events)).toEqual(['thinking', 'idle'])
    expect(state.chat).not.toHaveBeenCalled()
  })

  it('cancels an in-flight browser operation before starting another step', async () => {
    let actionStarted!: () => void
    let finishAction!: () => void
    const started = new Promise<void>((resolve) => { actionStarted = resolve })
    const pendingAction = new Promise<void>((resolve) => { finishAction = resolve })
    const state = setup({ click: async (label) => { if (label === 'Continue') { actionStarted(); await pendingAction } } })
    cleanups.push(async () => {
      finishAction()
      state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    createRule(state.db, { botId: bot.id, kind: 'email', target: 'recipient@example.test', duration: 'always', now: Date.now() })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Cancelable run', steps: [
        {
          type: 'click', target: { candidates: [{ label: 'Continue' }] },
          approval: { kind: 'email', target: 'recipient@example.test', action: 'Continue the approved operation' },
        },
        { type: 'click', target: { candidates: [{ label: 'Delete' }] } },
      ],
    })
    const response = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`)
    expect(response.status).toBe(202)
    const { runId } = await response.json() as { runId: string }
    await started
    expect(state.app.isBusy(bot.id)).toBe(true)

    const stopping = await send(state.app.app, 'DELETE', `/api/bots/${bot.id}/workflows/runs/${runId}`)
    expect(stopping.status).toBe(202)
    expect(await stopping.json()).toMatchObject({ status: 'stopping_after_current_step' })
    expect(state.app.isBusy(bot.id)).toBe(true)
    finishAction()
    await vi.waitFor(() => expect(state.app.isBusy(bot.id)).toBe(false))
    expect(state.calls.filter((call) => call === 'click:Continue')).toHaveLength(1)
    expect(state.calls).not.toContain('click:Delete')
    expect(state.chat).not.toHaveBeenCalled()
  })

  it('rejects approval after restart but lets the operator discard without an LLM fallback', async () => {
    const state = setup()
    let restarted: ReturnType<typeof createApp> | undefined
    cleanups.push(async () => {
      if (restarted) await restarted.stopAll()
      await state.app.stopAll()
      await state.pool.disposeAll()
      state.db.close()
      await rm(state.dataDir, { recursive: true, force: true })
    })
    const saved = saveWorkflowTrace(state.db, bot.id, {
      format: 'opensuperbot.workflow', version: 1, title: 'Send form', steps: [
        {
          type: 'click', target: { candidates: [{ label: 'Submit' }] },
          approval: { kind: 'other', target: 'Submit button', action: 'Submit the form' },
        },
      ],
    })
    const started = await send(state.app.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`)
    expect(started.status).toBe(202)
    await vi.waitFor(() => expect(state.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get()).toMatchObject({ n: 1 }))
    const approval = state.db.prepare("SELECT id FROM approvals WHERE status = 'pending'").get() as { id: number }
    await state.app.stopAll() // Simulate process shutdown: release the lane and forget runtime continuation.

    const restartedEvents: GatewayEvent[] = []
    restarted = createApp({ db: state.db, llm: state.llm, pool: state.pool, hub: collectingHub(restartedEvents) })
    expect(restarted.hello()).toEqual({ type: 'hello', statuses: { [bot.id]: 'waiting' } })
    const resumed = await send(restarted.app, 'POST', `/api/approvals/${approval.id}`, { decision: 'approve' })
    expect(resumed.status).toBe(409)
    const resumeError = await resumed.json()
    expect(resumeError).toMatchObject({ error: expect.stringContaining('gateway restart') })
    expect(getApproval(state.db, approval.id)?.status).toBe('pending')
    expect(state.calls.some((call) => call.startsWith('click:'))).toBe(false)
    expect(state.chat).not.toHaveBeenCalled()

    const thumbsUp = await send(restarted.app, 'POST', `/api/threads/dm:${bot.id}/messages`, { text: '👍' })
    expect(thumbsUp.status).toBe(409)
    expect(await thumbsUp.json()).toEqual(resumeError)
    expect(getApproval(state.db, approval.id)?.status).toBe('pending')
    expect(state.chat).not.toHaveBeenCalled()

    const replacementRun = await send(restarted.app, 'POST', `/api/bots/${bot.id}/workflows/${saved.id}/run`)
    expect(replacementRun.status).toBe(202)
    await vi.waitFor(() => expect(state.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get()).toMatchObject({ n: 2 }))
    const replacementApproval = state.db.prepare("SELECT id FROM approvals WHERE status = 'pending' AND id <> ? ORDER BY id DESC LIMIT 1").get(approval.id) as { id: number }
    expect(restarted.isBusy(bot.id)).toBe(true)

    const discarded = await send(restarted.app, 'POST', `/api/approvals/${approval.id}`, { decision: 'discard' })
    expect(discarded.status).toBe(202)
    expect(getApproval(state.db, approval.id)?.status).toBe('discarded')
    expect(getApproval(state.db, replacementApproval.id)?.status).toBe('pending')
    expect(restarted.isBusy(bot.id)).toBe(true)

    const discardReplacement = await send(restarted.app, 'POST', `/api/approvals/${replacementApproval.id}`, { decision: 'discard' })
    expect(discardReplacement.status).toBe(202)
    await vi.waitFor(() => expect(restarted.isBusy(bot.id)).toBe(false))
    expect(state.chat).not.toHaveBeenCalled()
  })
})
