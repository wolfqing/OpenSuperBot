import type { PageContextLike, PageLike, WorkflowElementLike } from './browser-page.js'
import type { ApprovalKind } from './approvals.js'
import { sanitizeWorkflowUrl, type WorkflowApproval, type WorkflowStep, type WorkflowTarget, type WorkflowTrace } from './workflows.js'

export const MAX_WORKFLOW_BINDINGS_BYTES = 1_000_000
export const MAX_WORKFLOW_RUN_REQUEST_BYTES = 6_500_000
const MAX_WORKFLOW_BINDINGS = 1_000
const MAX_WORKFLOW_BINDING_CHARS = 2_000
const LOCATOR_TIMEOUT_MS = 3_000
const ACTION_TIMEOUT_MS = 10_000
// Keep this aligned with workflow-recorder's navigation expectation window.
const EXPECTED_URL_TIMEOUT_MS = 5_000
const URL_POLL_INTERVAL_MS = 25
const POPUP_SETTLE_WINDOW_MS = 350

export type WorkflowBindings = ReadonlyMap<string, string>

export type WorkflowApprovalRequest = {
  step: number
  steps: number
  action: string
  kind: ApprovalKind
  target: string
  rulesAllowed: boolean
}

export type WorkflowApprovalDecision =
  | { status: 'approved' }
  | { status: 'waiting'; approvalId: number }

export type WorkflowStepEvent = { index: number; type: WorkflowStep['type']; ok: boolean; durationMs: number }

export type WorkflowFailureCode =
  | 'cancelled'
  | 'browser_unavailable'
  | 'unsupported_browser'
  | 'target_not_found'
  | 'action_failed'
  | 'url_mismatch'
  | 'popup_opened'
  | 'vault_denied'
  | 'vault_domain_mismatch'

export class WorkflowVaultError extends Error {
  constructor(readonly code: 'vault_denied' | 'vault_domain_mismatch', message: string) {
    super(message)
  }
}

export type WorkflowVaultResolver = (ref: {
  itemId: string
  field: string
  pageUrl: string
  target: WorkflowElementLike
}) => Promise<string>

export type WorkflowRunResult =
  | { status: 'completed'; stepsCompleted: number }
  | { status: 'waiting'; approvalId: number; step: number; stepsCompleted: number }
  | { status: 'failed'; step: number; code: WorkflowFailureCode; stepsCompleted: number }

export class WorkflowReplayValidationError extends TypeError {
  constructor(readonly code: 'invalid_bindings' | 'missing_bindings' | 'unexpected_bindings' | 'trace_truncated' | 'unsupported_reference' | 'unrecorded_popup') {
    super(code)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse call-time values into memory only; no caller-supplied value is returned in an error. */
export function parseWorkflowBindings(trace: WorkflowTrace, value: unknown): { bindings: Map<string, string>; hasDynamicValues: boolean } {
  const needed = new Set<string>()
  for (const [index, step] of trace.steps.entries()) {
    if (step.type !== 'fill' && step.type !== 'select') continue
    if (step.value.kind === 'placeholder') needed.add(step.value.key)
    if (step.value.kind === 'redacted') needed.add(`step:${index + 1}`)
  }
  if (needed.size > MAX_WORKFLOW_BINDINGS) throw new WorkflowReplayValidationError('invalid_bindings')

  const raw = value === undefined ? {} : value
  if (!isRecord(raw) || Object.keys(raw).length > MAX_WORKFLOW_BINDINGS) {
    throw new WorkflowReplayValidationError('invalid_bindings')
  }
  const keys = Object.keys(raw)
  if (keys.some((key) => !needed.has(key))) throw new WorkflowReplayValidationError('unexpected_bindings')
  if ([...needed].some((key) => !Object.hasOwn(raw, key))) throw new WorkflowReplayValidationError('missing_bindings')

  const bindings = new Map<string, string>()
  let bytes = 0
  for (const key of needed) {
    const input = raw[key]
    if (typeof input !== 'string' || input.length > MAX_WORKFLOW_BINDING_CHARS) {
      throw new WorkflowReplayValidationError('invalid_bindings')
    }
    bytes += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(input, 'utf8')
    if (bytes > MAX_WORKFLOW_BINDINGS_BYTES) throw new WorkflowReplayValidationError('invalid_bindings')
    bindings.set(key, input)
  }
  return { bindings, hasDynamicValues: needed.size > 0 }
}

/** Reject trace shapes whose effect cannot yet be replayed without guessing. */
export function assertWorkflowReplayable(trace: WorkflowTrace): void {
  if (trace.truncated) throw new WorkflowReplayValidationError('trace_truncated')
  for (const step of trace.steps) {
    if (step.type === 'unrecorded-popup') throw new WorkflowReplayValidationError('unrecorded_popup')
    if (step.page !== undefined || step.frame !== undefined) {
      throw new WorkflowReplayValidationError('unsupported_reference')
    }
  }
}

function targetLocator(page: PageLike, candidate: WorkflowTarget['candidates'][number]): WorkflowElementLike | null {
  let locator
  if ('role' in candidate) locator = page.getByRole?.(candidate.role.role, { name: candidate.role.name, exact: true })
  else if ('label' in candidate) locator = page.getByLabel?.(candidate.label, { exact: true })
  else if ('placeholder' in candidate) locator = page.getByPlaceholder?.(candidate.placeholder, { exact: true })
  else if ('text' in candidate) locator = page.getByText?.(candidate.text, { exact: true })
  else if ('testId' in candidate) locator = page.getByTestId?.(candidate.testId)
  else locator = page.locator?.(candidate.css)
  return locator ? (locator.filter?.({ visible: true }) ?? locator).first() : null
}

async function waitForVisible(locator: WorkflowElementLike, signal?: AbortSignal): Promise<void> {
  if (!locator.waitFor) throw new RunnerError('unsupported_browser')
  if (!signal) return locator.waitFor({ state: 'visible', timeout: LOCATOR_TIMEOUT_MS })

  let onAbort: (() => void) | undefined
  try {
    await Promise.race([
      locator.waitFor({ state: 'visible', timeout: LOCATOR_TIMEOUT_MS }),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new RunnerError('cancelled'))
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

async function firstVisibleTarget(page: PageLike, target: WorkflowTarget, signal?: AbortSignal): Promise<WorkflowElementLike> {
  let hasLocator = false
  for (const candidate of target.candidates) {
    if (signal?.aborted) throw new RunnerError('cancelled')
    const locator = targetLocator(page, candidate)
    if (!locator) continue
    hasLocator = true
    try {
      await waitForVisible(locator, signal)
      if (signal?.aborted) throw new RunnerError('cancelled')
      return locator
    } catch (error) {
      if (error instanceof RunnerError) throw error
      if (signal?.aborted) throw new RunnerError('cancelled')
      if (pageIsClosed(page)) throw new RunnerError('browser_unavailable')
      if (error instanceof Error && error.name === 'TimeoutError') {
        // A locator timeout means this recorded target is absent; trying the next strategy is safe.
        continue
      }
      throw new RunnerError('action_failed')
    }
  }
  throw new RunnerError(hasLocator ? 'target_not_found' : 'unsupported_browser')
}

class RunnerError extends Error {
  constructor(readonly code: WorkflowFailureCode) { super(code) }
}

function approvalFor(step: WorkflowStep, index: number, total: number, rulesAllowed: boolean): WorkflowApprovalRequest | null {
  if (step.type === 'navigate' || step.type === 'unrecorded-popup') return null
  const metadata: WorkflowApproval | undefined = step.approval
  if (!metadata) return null
  return {
    step: index + 1,
    steps: total,
    action: metadata.action ?? `run workflow step ${index + 1}: ${step.type}`,
    kind: metadata.kind,
    target: metadata.target,
    rulesAllowed,
  }
}

type WorkflowPageGuard = {
  getPage(): Promise<PageLike>
  popupOpened(): boolean
  dispose(): Promise<void>
}

function closePage(value: unknown): Promise<void> {
  if (typeof value !== 'object' || value === null || !('close' in value) || typeof value.close !== 'function') return Promise.resolve()
  return Promise.resolve(value.close.call(value)).then(() => {}, () => {})
}

function pageIsClosed(page: PageLike): boolean {
  if (page.isClosed) return page.isClosed()
  const pages = page.context?.().pages?.()
  return pages !== undefined && !pages.includes(page)
}

/** Pin one page for a replay and quarantine any page opened while it runs. */
function createWorkflowPageGuard(getPageFromSession: () => Promise<PageLike>): WorkflowPageGuard {
  let currentPage: PageLike | null = null
  let currentContext: PageContextLike | undefined
  let baselinePages = new Set<PageLike>()
  let popup = false
  const closingPopups: Promise<void>[] = []
  const closingPages = new Set<object>()
  let pagePopupListener: ((value?: unknown) => void) | undefined
  let contextPageListener: ((page: PageLike) => void) | undefined

  const detach = () => {
    if (currentPage && pagePopupListener) currentPage.off?.('popup', pagePopupListener)
    if (currentContext && contextPageListener) currentContext.off?.('page', contextPageListener)
    pagePopupListener = undefined
    contextPageListener = undefined
    currentContext = undefined
    baselinePages = new Set()
  }

  const rejectPopup = (openedPage?: unknown) => {
    popup = true
    if (typeof openedPage === 'object' && openedPage !== null && !closingPages.has(openedPage)) {
      closingPages.add(openedPage)
      closingPopups.push(closePage(openedPage))
    }
  }

  const attach = (page: PageLike) => {
    currentContext = page.context?.()
    baselinePages = new Set(currentContext?.pages?.() ?? [page])
    pagePopupListener = (openedPage) => rejectPopup(openedPage)
    contextPageListener = (openedPage) => {
      if (!baselinePages.has(openedPage) && (!currentPage || !pageIsClosed(currentPage))) rejectPopup(openedPage)
    }
    page.on?.('popup', pagePopupListener)
    currentContext?.on?.('page', contextPageListener)
  }

  return {
    async getPage() {
      if (popup) throw new RunnerError('popup_opened')
      if (currentPage && pageIsClosed(currentPage)) throw new RunnerError('browser_unavailable')
      const nextPage = await getPageFromSession().catch(() => { throw new RunnerError('browser_unavailable') })
      if (currentPage && nextPage !== currentPage) {
        rejectPopup(nextPage)
        throw new RunnerError('popup_opened')
      } else if (!currentPage) {
        currentPage = nextPage
        attach(nextPage)
      }

      if (currentPage && pageIsClosed(currentPage)) throw new RunnerError('browser_unavailable')
      if (popup) throw new RunnerError('popup_opened')
      const unexpectedPages = currentContext?.pages?.().filter((page) => !baselinePages.has(page) && !pageIsClosed(currentPage!)) ?? []
      if (unexpectedPages.length > 0) {
        for (const page of unexpectedPages) rejectPopup(page)
        throw new RunnerError('popup_opened')
      }
      return currentPage
    },
    popupOpened: () => popup,
    async dispose() {
      detach()
      await Promise.all(closingPopups)
    },
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

async function waitForExpectedUrl(
  expectedUrl: string,
  deadline: number,
  pageGuard: WorkflowPageGuard,
  signal?: AbortSignal,
): Promise<void> {
  for (;;) {
    if (signal?.aborted) throw new RunnerError('cancelled')
    if (pageGuard.popupOpened()) throw new RunnerError('popup_opened')
    const page = await pageGuard.getPage()
    if (Date.now() <= deadline && sanitizeWorkflowUrl(page.url()) === expectedUrl) return
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new RunnerError('url_mismatch')
    await delay(Math.min(URL_POLL_INTERVAL_MS, remaining), signal)
  }
}

async function executeStep(
  step: WorkflowStep,
  index: number,
  pageGuard: WorkflowPageGuard,
  bindings: WorkflowBindings,
  signal?: AbortSignal,
  resolveVault?: WorkflowVaultResolver,
): Promise<void> {
  if (signal?.aborted) throw new RunnerError('cancelled')
  let expectedUrlDeadline: number | undefined
  try {
    const page = await pageGuard.getPage()
    if (step.type === 'navigate') {
      await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    } else if (step.type !== 'unrecorded-popup') {
      const target = await firstVisibleTarget(page, step.target, signal)
      switch (step.type) {
        case 'click':
          if (!target.click) throw new RunnerError('unsupported_browser')
          await target.click({ timeout: ACTION_TIMEOUT_MS })
          break
        case 'check':
          if (!target.check) throw new RunnerError('unsupported_browser')
          await target.check({ timeout: ACTION_TIMEOUT_MS })
          break
        case 'uncheck':
          if (!target.uncheck) throw new RunnerError('unsupported_browser')
          await target.uncheck({ timeout: ACTION_TIMEOUT_MS })
          break
        case 'press':
          if (!target.press) throw new RunnerError('unsupported_browser')
          await target.press(step.key, { timeout: ACTION_TIMEOUT_MS })
          break
        case 'fill': {
          if (!target.fill) throw new RunnerError('unsupported_browser')
          let text: string | undefined
          if (step.value.kind === 'vault') {
            if (!resolveVault) throw new RunnerError('vault_denied')
            text = await resolveVault({
              itemId: step.value.itemId,
              field: step.value.field,
              pageUrl: page.url(),
              target,
            })
          } else {
            const key = step.value.kind === 'placeholder' ? step.value.key
              : step.value.kind === 'redacted' ? `step:${index + 1}` : null
            text = step.value.kind === 'literal' ? step.value.text : key === null ? '' : bindings.get(key)
          }
          if (text === undefined) throw new RunnerError('action_failed')
          await target.fill(text, { timeout: ACTION_TIMEOUT_MS })
          break
        }
        case 'select': {
          if (!target.selectOption) throw new RunnerError('unsupported_browser')
          let value: string | undefined
          if (step.value.kind === 'vault') {
            if (!resolveVault) throw new RunnerError('vault_denied')
            value = await resolveVault({
              itemId: step.value.itemId,
              field: step.value.field,
              pageUrl: page.url(),
              target,
            })
          } else {
            const key = step.value.kind === 'placeholder' ? step.value.key
              : step.value.kind === 'redacted' ? `step:${index + 1}` : null
            value = step.value.kind === 'literal' ? step.value.text : key === null ? '' : bindings.get(key)
          }
          if (value === undefined) throw new RunnerError('action_failed')
          await target.selectOption(value, { timeout: ACTION_TIMEOUT_MS })
          break
        }
      }
    }
    if (step.type !== 'navigate' && step.type !== 'unrecorded-popup' && step.expect) {
      expectedUrlDeadline = Date.now() + EXPECTED_URL_TIMEOUT_MS
    }
    if (signal?.aborted) throw new RunnerError('cancelled')
    // A click, key press, toggle, or navigation handler can schedule window.open after its
    // promise resolves. Keep listeners attached briefly, including after the final step.
    if (step.type === 'navigate' || step.type === 'click' || step.type === 'check'
      || step.type === 'uncheck' || step.type === 'press') {
      await delay(POPUP_SETTLE_WINDOW_MS, signal)
      if (signal?.aborted) throw new RunnerError('cancelled')
    }
    if (pageGuard.popupOpened()) throw new RunnerError('popup_opened')
    if (step.type !== 'navigate' && step.type !== 'unrecorded-popup' && step.expect) {
      await waitForExpectedUrl(step.expect.url, expectedUrlDeadline!, pageGuard, signal)
    }
    if (pageGuard.popupOpened()) throw new RunnerError('popup_opened')
  } catch (error) {
    // All runner errors preserve their typed failure; browser exceptions become action failures.
    if (error instanceof RunnerError) throw error
    if (error instanceof WorkflowVaultError) throw new RunnerError(error.code)
    if (signal?.aborted) throw new RunnerError('cancelled')
    throw new RunnerError('action_failed')
  }
}

export async function runWorkflow(trace: WorkflowTrace, options: {
  getPage: () => Promise<PageLike>
  bindings: WorkflowBindings
  rulesAllowed: boolean
  authorize: (request: WorkflowApprovalRequest) => Promise<WorkflowApprovalDecision>
  resolveVault?: WorkflowVaultResolver
  startIndex?: number
  approvedStepIndex?: number
  signal?: AbortSignal
  onStep?: (event: WorkflowStepEvent) => void | Promise<void>
}): Promise<WorkflowRunResult> {
  assertWorkflowReplayable(trace)
  const startIndex = options.startIndex ?? 0
  let stepsCompleted = startIndex
  const pageGuard = createWorkflowPageGuard(options.getPage)
  try {
    for (let index = startIndex; index < trace.steps.length; index++) {
      if (options.signal?.aborted) return { status: 'failed', step: index + 1, code: 'cancelled', stepsCompleted }
      const step = trace.steps[index]!
      const started = Date.now()
      try {
        // Attach popup tracking before asking for approval, and keep it until this run exits.
        await pageGuard.getPage()
      } catch (error) {
        const code = pageGuard.popupOpened() ? 'popup_opened' : error instanceof RunnerError ? error.code : 'action_failed'
        await reportStep(options.onStep, { index: index + 1, type: step.type, ok: false, durationMs: Date.now() - started })
        return { status: 'failed', step: index + 1, code, stepsCompleted }
      }

      const approval = approvalFor(step, index, trace.steps.length, options.rulesAllowed)
      if (approval && index !== options.approvedStepIndex) {
        const decision = await options.authorize(approval)
        if (pageGuard.popupOpened()) {
          await reportStep(options.onStep, { index: index + 1, type: step.type, ok: false, durationMs: Date.now() - started })
          return { status: 'failed', step: index + 1, code: 'popup_opened', stepsCompleted }
        }
        if (decision.status === 'waiting') {
          return { status: 'waiting', approvalId: decision.approvalId, step: index + 1, stepsCompleted }
        }
      }
      try {
        await executeStep(step, index, pageGuard, options.bindings, options.signal, options.resolveVault)
        await reportStep(options.onStep, { index: index + 1, type: step.type, ok: true, durationMs: Date.now() - started })
        stepsCompleted++
      } catch (error) {
        const code = pageGuard.popupOpened() ? 'popup_opened' : error instanceof RunnerError ? error.code : 'action_failed'
        await reportStep(options.onStep, { index: index + 1, type: step.type, ok: false, durationMs: Date.now() - started })
        return { status: 'failed', step: index + 1, code, stepsCompleted }
      }
    }
    return { status: 'completed', stepsCompleted }
  } finally {
    await pageGuard.dispose()
  }
}

async function reportStep(callback: ((event: WorkflowStepEvent) => void | Promise<void>) | undefined, event: WorkflowStepEvent): Promise<void> {
  try {
    await callback?.(event)
  } catch {
    // Observability must not change whether a browser action is considered complete.
  }
}
