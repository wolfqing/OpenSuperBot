import { describe, expect, it, vi } from 'vitest'
import { createBrowserSession, type BrowserLike, type ContextLike, type PageLike, type WorkflowElementLike, type WorkflowLocatorLike } from '../src/browser-page.js'
import { assertWorkflowReplayable, parseWorkflowBindings, runWorkflow } from '../src/workflow-runner.js'
import { parseWorkflowTrace } from '../src/workflows.js'

const trace = (steps: unknown[], extra: Record<string, unknown> = {}) => parseWorkflowTrace({
  format: 'opensuperbot.workflow', version: 1, title: 'Example', steps, ...extra,
})

function fakePage(options: {
  visible?: Record<string, boolean>
  actions?: Record<string, Partial<WorkflowElementLike>>
  initialUrl?: string
  navigationPopup?: boolean
  popupOnWait?: string
  onNavigate?: () => void
  filterVisible?: boolean
  waitForever?: string[]
} = {}) {
  let currentUrl = options.initialUrl ?? 'https://example.test/start'
  let closed = false
  const calls: string[] = []
  const popupListeners: ((popup?: unknown) => void)[] = []
  const contextListeners: ((page: PageLike) => void)[] = []
  const contextPages: PageLike[] = []
  const context: ContextLike = {
    pages: () => contextPages,
    on: (_event, listener) => contextListeners.push(listener),
    off: (_event, listener) => { const at = contextListeners.indexOf(listener); if (at >= 0) contextListeners.splice(at, 1) },
    newPage: async () => openPopup(),
  }
  const locator = (key: string): WorkflowLocatorLike => ({
    ...(options.filterVisible ? { filter: ({ visible }: { visible: true }) => {
      calls.push(`filter:${visible}:${key}`)
      return locator(key)
    } } : {}),
    first: () => ({
      async waitFor() {
        calls.push(`visible:${key}`)
        if (options.waitForever?.includes(key)) return new Promise<void>(() => {})
        if (options.popupOnWait === key) openPopup()
        if (options.visible?.[key] === false) {
          const timeout = new Error('not visible')
          timeout.name = 'TimeoutError'
          throw timeout
        }
      },
      async click() { calls.push(`click:${key}`); await options.actions?.[key]?.click?.() },
      async fill(value) { calls.push(`fill:${key}:${value}`); await options.actions?.[key]?.fill?.(value) },
      async selectOption(value) { calls.push(`select:${key}:${value}`); await options.actions?.[key]?.selectOption?.(value) },
      async check() { calls.push(`check:${key}`); await options.actions?.[key]?.check?.() },
      async uncheck() { calls.push(`uncheck:${key}`); await options.actions?.[key]?.uncheck?.() },
      async press(keyValue) { calls.push(`press:${key}:${keyValue}`); await options.actions?.[key]?.press?.(keyValue) },
    }),
  })
  const page = {
    async goto(url: string) {
      calls.push(`goto:${url}`)
      currentUrl = url
      options.onNavigate?.()
      if (options.navigationPopup) openPopup()
    },
    url: () => currentUrl,
    async title() { return 'Example' },
    async innerText() { return '' },
    async screenshot() { return Buffer.alloc(0) },
    async click() {},
    getByRole: (role: string, opts?: { name?: string }) => locator(`role:${role}:${opts?.name ?? ''}`),
    getByLabel: (label: string) => locator(`label:${label}`),
    getByPlaceholder: (placeholder: string) => locator(`placeholder:${placeholder}`),
    getByText: (text: string) => locator(`text:${text}`),
    getByTestId: (id: string) => locator(`testId:${id}`),
    locator: (selector: string) => locator(`css:${selector}`),
    viewportSize: () => ({ width: 800, height: 600 }),
    context: () => context,
    isClosed: () => closed,
    async close() { closed = true; calls.push('close:page') },
    on: (event: string, listener: (value?: unknown) => void) => { if (event === 'popup') popupListeners.push(listener) },
    off: (_event: string, listener: (value?: unknown) => void) => { const at = popupListeners.indexOf(listener); if (at >= 0) popupListeners.splice(at, 1) },
  } as unknown as PageLike
  contextPages.push(page)
  function openPopup() {
    let popupClosed = false
    const popup = {
      context: () => context,
      isClosed: () => popupClosed,
      async close() {
        if (popupClosed) return
        popupClosed = true
        calls.push('close:popup')
        const at = contextPages.indexOf(popup as unknown as PageLike)
        if (at >= 0) contextPages.splice(at, 1)
      },
      url: () => 'https://example.test/popup',
      viewportSize: () => ({ width: 800, height: 600 }),
    } as unknown as PageLike
    contextPages.push(popup)
    contextListeners.forEach((listener) => listener(popup))
    popupListeners.forEach((listener) => listener(popup))
    return popup
  }
  return {
    page, context, calls, setUrl: (url: string) => { currentUrl = url }, popup: openPopup,
    isClosed: () => closed, closeCurrent: () => { closed = true },
  }
}

const label = (name: string) => ({ label: name })
const click = (name: string, extra: Record<string, unknown> = {}) => ({
  type: 'click', target: { candidates: [label(name)] }, ...extra,
})

describe('workflow replay runner', () => {
  it('binds placeholders and redacted fields in memory and rejects missing or extra values without echoing them', () => {
    const workflow = trace([
      { type: 'fill', target: { candidates: [label('Email')] }, value: { kind: 'placeholder', key: 'customerEmail' } },
      { type: 'fill', target: { candidates: [label('Password')] }, value: { kind: 'redacted', reason: 'sensitive-input' } },
    ])
    const secret = 'runtime-private-value'
    const parsed = parseWorkflowBindings(workflow, { customerEmail: 'customer@example.test', 'step:2': secret })
    expect([...parsed.bindings]).toEqual([['customerEmail', 'customer@example.test'], ['step:2', secret]])
    expect(parsed.hasDynamicValues).toBe(true)
    expect(() => parseWorkflowBindings(workflow, { customerEmail: 'customer@example.test' })).toThrow('missing_bindings')
    expect(() => parseWorkflowBindings(workflow, { customerEmail: secret, 'step:2': secret, extra: secret }))
      .toThrow('unexpected_bindings')
  })

  it('rejects truncated, popup, and referenced-page traces before replay', () => {
    expect(() => assertWorkflowReplayable(trace([click('Save')], { truncated: true }))).toThrow('trace_truncated')
    expect(() => assertWorkflowReplayable(trace([{ type: 'unrecorded-popup' }]))).toThrow('unrecorded_popup')
    expect(() => assertWorkflowReplayable(trace([{ ...click('Save'), frame: 'billing' }]))).toThrow('unsupported_reference')
  })

  it('tries ordered candidates only while checking visibility', async () => {
    const browser = fakePage({ visible: { 'label:Save': false } })
    const result = await runWorkflow(trace([{
      type: 'click', target: { candidates: [label('Save'), { testId: 'save-button' }] },
    }]), {
      getPage: async () => browser.page, bindings: new Map(), rulesAllowed: false,
      authorize: async () => ({ status: 'approved' }),
    })
    expect(result).toEqual({ status: 'completed', stepsCompleted: 1 })
    expect(browser.calls).toEqual(['visible:label:Save', 'visible:testId:save-button', 'click:testId:save-button'])
  })

  it('filters to visible locator matches when the browser supports it', async () => {
    const browser = fakePage({ filterVisible: true })
    const result = await runWorkflow(trace([click('Save')]), {
      getPage: async () => browser.page, bindings: new Map(), rulesAllowed: false,
      authorize: async () => ({ status: 'approved' }),
    })
    expect(result).toEqual({ status: 'completed', stepsCompleted: 1 })
    expect(browser.calls).toContain('filter:true:label:Save')
  })

  it('requires approval only when a step has explicit approval metadata', async () => {
    const browser = fakePage()
    const authorize = vi.fn(async () => ({ status: 'approved' as const }))
    const result = await runWorkflow(trace([
      click('Open'),
      click('Send', { approval: { kind: 'email', target: 'team@example.test', action: 'Send the message' } }),
    ]), {
      getPage: async () => browser.page, bindings: new Map(), rulesAllowed: false, authorize,
    })
    expect(result).toEqual({ status: 'completed', stepsCompleted: 2 })
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ step: 2, action: 'Send the message', rulesAllowed: false }))
  })

  it('executes every recorded action type and binds a runtime select value', async () => {
    const browser = fakePage()
    const workflow = trace([
      { type: 'navigate', url: 'https://example.test/form' },
      click('Open'),
      { type: 'check', target: { candidates: [label('Subscribe')] } },
      { type: 'uncheck', target: { candidates: [label('Terms')] } },
      { type: 'press', key: 'Enter', target: { candidates: [label('Search')] } },
      { type: 'fill', target: { candidates: [label('Search')] }, value: { kind: 'literal', text: 'invoices' } },
      { type: 'select', target: { candidates: [label('Country')] }, value: { kind: 'placeholder', key: 'country' } },
    ])
    const { bindings } = parseWorkflowBindings(workflow, { country: 'United Kingdom' })
    const result = await runWorkflow(workflow, {
      getPage: async () => browser.page, bindings, rulesAllowed: false,
      authorize: async () => ({ status: 'approved' }),
    })
    expect(result).toEqual({ status: 'completed', stepsCompleted: 7 })
    expect(browser.calls).toContain('goto:https://example.test/form')
    expect(browser.calls).toContain('click:label:Open')
    expect(browser.calls).toContain('check:label:Subscribe')
    expect(browser.calls).toContain('uncheck:label:Terms')
    expect(browser.calls).toContain('press:label:Search:Enter')
    expect(browser.calls).toContain('fill:label:Search:invoices')
    expect(browser.calls).toContain('select:label:Country:United Kingdom')
  })

  it('fails closed if the pinned page closes during a browser relaunch', async () => {
    let closeOldPage = () => {}
    const beforeRelaunch = fakePage({ onNavigate: () => closeOldPage() })
    closeOldPage = beforeRelaunch.closeCurrent
    const afterRelaunch = fakePage()
    const getPage = vi.fn(async () => beforeRelaunch.isClosed() ? afterRelaunch.page : beforeRelaunch.page)
    const result = await runWorkflow(trace([{ type: 'navigate', url: 'https://example.test/next' }, click('Continue')]), {
      getPage, bindings: new Map(), rulesAllowed: false, authorize: async () => ({ status: 'approved' }),
    })
    expect(result).toEqual({ status: 'failed', step: 2, code: 'browser_unavailable', stepsCompleted: 1 })
    expect(beforeRelaunch.calls).toEqual(['goto:https://example.test/next'])
    expect(afterRelaunch.calls).toEqual([])
  })

  it('does not retry another locator after an action may have taken effect', async () => {
    const effect = vi.fn(async () => { throw new Error('lost connection after click') })
    const browser = fakePage({ actions: { 'label:Send': { click: effect } } })
    const result = await runWorkflow(trace([{
      type: 'click', target: { candidates: [label('Send'), { testId: 'send' }] },
    }]), {
      getPage: async () => browser.page, bindings: new Map(), rulesAllowed: false,
      authorize: async () => ({ status: 'approved' }),
    })
    expect(result).toMatchObject({ status: 'failed', code: 'action_failed', step: 1 })
    expect(effect).toHaveBeenCalledTimes(1)
    expect(browser.calls).not.toContain('visible:testId:send')
  })

  it('waits for approval, then resumes the exact step once without re-authorizing it', async () => {
    const browser = fakePage()
    const authorize = vi.fn(async () => ({ status: 'waiting' as const, approvalId: 9 }))
    const workflow = trace([click('Send', {
      approval: { kind: 'email', target: 'team@example.test', action: 'Send the message' },
    })])
    const first = await runWorkflow(workflow, {
      getPage: async () => browser.page, bindings: new Map(), rulesAllowed: false, authorize,
    })
    expect(first).toEqual({ status: 'waiting', approvalId: 9, step: 1, stepsCompleted: 0 })
    expect(browser.calls).toEqual([])

    const resumed = await runWorkflow(workflow, {
      getPage: async () => browser.page, bindings: new Map(), rulesAllowed: false, authorize,
      startIndex: 0, approvedStepIndex: 0,
    })
    expect(resumed).toEqual({ status: 'completed', stepsCompleted: 1 })
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(browser.calls).toEqual(['visible:label:Send', 'click:label:Send'])
  })

  it('stops on expected URL drift and never runs later steps', async () => {
    const browser = fakePage()
    const result = await runWorkflow(trace([
      { ...click('Continue'), expect: { url: 'https://example.test/expected' } },
      click('Delete'),
    ]), {
      getPage: async () => browser.page, bindings: new Map(), rulesAllowed: false,
      authorize: async () => ({ status: 'approved' }),
    })
    expect(result).toMatchObject({ status: 'failed', code: 'url_mismatch', step: 1, stepsCompleted: 0 })
    expect(browser.calls).not.toContain('visible:label:Delete')
  }, 10_000)

  it('polls for a delayed URL change within the recorded expectation window', async () => {
    const browser = fakePage()
    setTimeout(() => browser.setUrl('https://example.test/expected'), 350)
    const result = await runWorkflow(trace([{
      ...click('Continue'), expect: { url: 'https://example.test/expected' },
    }]), {
      getPage: async () => browser.page, bindings: new Map(), rulesAllowed: false,
      authorize: async () => ({ status: 'approved' }),
    })
    expect(result).toEqual({ status: 'completed', stepsCompleted: 1 })
  })

  it('aborts a pending expected URL poll promptly', async () => {
    const browser = fakePage()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    const result = await runWorkflow(trace([{
      ...click('Continue'), expect: { url: 'https://example.test/expected' },
    }]), {
      getPage: async () => browser.page, bindings: new Map(), rulesAllowed: false,
      authorize: async () => ({ status: 'approved' }), signal: controller.signal,
    })
    expect(result).toMatchObject({ status: 'failed', code: 'cancelled', step: 1 })
  })

  it('aborts a pending expected URL poll when an unrecorded popup opens and closes it', async () => {
    const browser = fakePage({ actions: { 'label:Continue': { click: async () => { setTimeout(browser.popup, 300) } } } })
    const result = await runWorkflow(trace([{
      ...click('Continue'), expect: { url: 'https://example.test/expected' },
    }]), {
      getPage: async () => browser.page, bindings: new Map(), rulesAllowed: false,
      authorize: async () => ({ status: 'approved' }),
    })
    expect(result).toMatchObject({ status: 'failed', code: 'popup_opened', step: 1 })
    expect(browser.calls).toContain('close:popup')
    expect(browser.calls).not.toContain('visible:label:Delete')
  })

  it('stops trying locator candidates immediately when cancellation arrives', async () => {
    const browser = fakePage({ waitForever: ['label:Save'] })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    const result = await runWorkflow(trace([{
      type: 'click', target: { candidates: [label('Save'), { testId: 'save-button' }] },
    }]), {
      getPage: async () => browser.page, bindings: new Map(), rulesAllowed: false,
      authorize: async () => ({ status: 'approved' }), signal: controller.signal,
    })
    expect(result).toMatchObject({ status: 'failed', code: 'cancelled', step: 1 })
    expect(browser.calls).toEqual(['visible:label:Save'])
  })

  it('stops when an action opens an unrecorded popup', async () => {
    const browser = fakePage({ actions: { 'label:Open': { click: async () => { browser.popup() } } } })
    const result = await runWorkflow(trace([click('Open'), click('Continue')]), {
      getPage: async () => browser.page, bindings: new Map(), rulesAllowed: false,
      authorize: async () => ({ status: 'approved' }),
    })
    expect(result).toMatchObject({ status: 'failed', code: 'popup_opened', step: 1 })
    expect(browser.calls).not.toContain('visible:label:Continue')
    expect(browser.calls).toContain('close:popup')
  })

  it('reports a popup opened during locator resolution instead of handing off as target drift', async () => {
    const browser = fakePage({ popupOnWait: 'label:Continue', visible: { 'label:Continue': false } })
    const result = await runWorkflow(trace([click('Continue')]), {
      getPage: async () => browser.page, bindings: new Map(), rulesAllowed: false,
      authorize: async () => ({ status: 'approved' }),
    })
    expect(result).toMatchObject({ status: 'failed', code: 'popup_opened', step: 1 })
    expect(browser.calls).toContain('close:popup')
  })

  it('closes an unrecorded popup and keeps the selected page for the next turn and screenshot', async () => {
    const browser = fakePage({ actions: { 'label:Open': { click: async () => { setTimeout(browser.popup, 100) } } } })
    const browserLike: BrowserLike = {
      contexts: () => [browser.context],
      async close() {},
      isConnected: () => true,
    }
    const session = createBrowserSession(async () => browserLike)
    const result = await runWorkflow(trace([click('Open')]), {
      getPage: () => session.workflowPage(), bindings: new Map(), rulesAllowed: false,
      authorize: async () => ({ status: 'approved' }),
    })
    expect(result).toMatchObject({ status: 'failed', code: 'popup_opened' })
    expect(browser.calls).toContain('close:popup')
    expect(await session.page()).toBe(browser.page)
    expect(await session.workflowPage()).toBe(browser.page)
    await session.dispose()
  })

  it('stops when navigation opens an unrecorded popup', async () => {
    const browser = fakePage({ navigationPopup: true })
    const result = await runWorkflow(trace([
      { type: 'navigate', url: 'https://example.test/redirect' },
      click('Continue'),
    ]), {
      getPage: async () => browser.page, bindings: new Map(), rulesAllowed: false,
      authorize: async () => ({ status: 'approved' }),
    })
    expect(result).toMatchObject({ status: 'failed', code: 'popup_opened', step: 1 })
    expect(browser.calls).not.toContain('visible:label:Continue')
  })
})
