import type { BotComputer, PageLink, Shot } from './computer.js'

/**
 * 浏览器那一半的电脑：页面操作只认 playwright 的 Page，不关心它是容器里经 CDP 连来的，
 * 还是本机直接拉起来的。两种后端（computer-docker、computer-local）都拼这一套。
 */

export type WorkflowLocatorLike = {
  first(): WorkflowElementLike
  /** Playwright 1.51+ can select only visible matches before choosing the first one. */
  filter?(opts: { visible: true }): WorkflowLocatorLike
}

export type WorkflowElementLike = {
  waitFor?(opts: { state: 'visible'; timeout: number }): Promise<void>
  click?(opts?: unknown): Promise<void>
  fill?(text: string, opts?: unknown): Promise<void>
  selectOption?(value: string, opts?: unknown): Promise<unknown>
  check?(opts?: unknown): Promise<void>
  uncheck?(opts?: unknown): Promise<void>
  press?(key: string, opts?: unknown): Promise<void>
  getAttribute?(name: string, opts?: unknown): Promise<string | null>
  evaluate?<R>(fn: (el: unknown) => R, opts?: unknown): Promise<R>
}

export class VaultFillError extends Error {
  constructor(
    readonly code: 'origin_mismatch' | 'not_password_input' | 'unsupported_browser' | 'fill_failed',
    message: string,
  ) {
    super(message)
  }
}

export function normalizePageOrigin(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl)
    const proto = parsed.protocol.toLowerCase()
    if (proto !== 'http:' && proto !== 'https:') return null
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
    return `${proto}//${host}${parsed.port ? `:${parsed.port}` : ''}`
  } catch {
    return null
  }
}

export async function assertPasswordInputElement(el: WorkflowElementLike): Promise<void> {
  if (el.evaluate) {
    const info = await el.evaluate((node) => {
      const e = node as { tagName?: string; type?: string; getAttribute?: (k: string) => string | null }
      const tag = String(e.tagName ?? '').toLowerCase()
      const type = String(e.getAttribute?.('type') ?? e.type ?? '').toLowerCase()
      const ac = String(e.getAttribute?.('autocomplete') ?? '').toLowerCase()
      return { tag, type, ac }
    })
    const ok = info.tag === 'input' && (info.type === 'password' || info.ac.includes('password'))
    if (!ok) {
      throw new VaultFillError(
        'not_password_input',
        'Refused to fill a secret field into a non-password input element.',
      )
    }
    return
  }
  if (el.getAttribute) {
    const type = ((await el.getAttribute('type')) ?? '').toLowerCase()
    const ac = ((await el.getAttribute('autocomplete')) ?? '').toLowerCase()
    if (type !== 'password' && !ac.includes('password')) {
      throw new VaultFillError(
        'not_password_input',
        'Refused to fill a secret field into a non-password input element.',
      )
    }
    return
  }
  throw new VaultFillError(
    'unsupported_browser',
    'Refused to fill a secret field because the browser cannot verify the target input type.',
  )
}

type Clickable = WorkflowLocatorLike & { first(): WorkflowElementLike & { click(opts?: unknown): Promise<void> } }
type Fillable = WorkflowLocatorLike & { first(): WorkflowElementLike & { fill(text: string, opts?: unknown): Promise<void> } }

export type PageLike = {
  goto(url: string, opts?: unknown): Promise<unknown>
  title(): Promise<string>
  url(): string
  innerText(selector: string): Promise<string>
  screenshot(opts?: unknown): Promise<Buffer>
  click(selector: string, opts?: unknown): Promise<void>
  getByText?(text: string, opts?: { exact?: boolean }): Clickable
  fill?(selector: string, text: string, opts?: unknown): Promise<void>
  getByRole?(role: string, opts?: { name?: string; exact?: boolean }): WorkflowLocatorLike
  getByLabel?(text: string, opts?: { exact?: boolean }): Fillable
  getByPlaceholder?(text: string, opts?: { exact?: boolean }): Fillable
  getByTestId?(text: string): WorkflowLocatorLike
  locator?(selector: string): WorkflowLocatorLike
  keyboard?: { press(key: string): Promise<void> }
  mouse?: { wheel(dx: number, dy: number): Promise<void> }
  goBack?(opts?: unknown): Promise<unknown>
  waitForLoadState?(state?: string, opts?: unknown): Promise<void>
  evaluate?(script: string): Promise<unknown>
  context?(): PageContextLike
  mainFrame?(): unknown
  close?(): Promise<void>
  isClosed?(): boolean
  on?(event: 'framenavigated' | 'close' | 'popup', listener: (value?: unknown) => void): void
  off?(event: 'framenavigated' | 'close' | 'popup', listener: (value?: unknown) => void): void
  viewportSize(): { width: number; height: number } | null
}

/** 够用就好的 CDP 会话：本机模式用它拿浏览器画面 */
export type CdpSessionLike = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(event: string, listener: (params: unknown) => void): unknown
  off?(event: string, listener: (params: unknown) => void): unknown
  detach(): Promise<void>
}

export type PageContextLike = {
  newCDPSession?(page: unknown): Promise<CdpSessionLike>
  pages?(): PageLike[]
  on?(event: 'page', listener: (page: PageLike) => void): void
  off?(event: 'page', listener: (page: PageLike) => void): void
}

export type ContextLike = PageContextLike & {
  pages(): PageLike[]
  newPage(): Promise<PageLike>
}

export type BrowserLike = {
  contexts(): ContextLike[]
  close(): Promise<void>
  /** Chromium 重启或崩溃后旧连接就废了；playwright 的 Browser 有这个方法。 */
  isConnected?(): boolean
}

/** 在页面里跑：收集可见网页链接（只留 http/https、去重），给 bot 一张「能去哪」的清单。 */
const LINKS_SCRIPT = `(() => {
  const seen = new Set(); const out = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href;
    if (!href || !/^https?:\\/\\//i.test(href) || seen.has(href)) continue;
    const box = a.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    const text = (a.innerText || a.getAttribute('aria-label') || a.title || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    seen.add(href); out.push({ text, href });
    if (out.length >= 60) break;
  }
  return out;
})()`

/**
 * 浏览器只许开真正的网页（http / https；测试与内部自检可显式允许无源的 data:）。
 * 绝不放行 file:、chrome:、view-source:、javascript:：本机模式下 Chromium 跑在沙箱外，
 * 放开 file: 等于让没开命令行、甚至只读 watch 的同事直接读宿主机上的密钥和网关令牌。
 */
export function checkBrowserUrl(raw: string, opts: { allowData?: boolean } = {}): string {
  const trimmed = raw.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`Invalid URL: ${trimmed.slice(0, 120) || '(empty)'}. Use a full http:// or https:// URL.`)
  }
  const proto = parsed.protocol.toLowerCase()
  if (proto === 'http:' || proto === 'https:' || (opts.allowData && proto === 'data:')) return trimmed
  throw new Error(`Blocked URL scheme "${proto}" — only http:// and https:// pages are allowed.`)
}

/** 像 CSS selector 的先按 selector 找；像一句话的先按文字/标签找，免得白等 selector 超时。 */
function looksLikeSelector(target: string): boolean {
  return /[#.[\]=:>]/.test(target) || /^[a-z][a-z0-9-]*$/.test(target)
}

async function firstThatWorks(attempts: (() => Promise<void>)[]): Promise<void> {
  let firstError: unknown
  for (const attempt of attempts) {
    try {
      await attempt()
      return
    } catch (err) {
      firstError ??= err
    }
  }
  throw firstError
}

function missing(what: string): never {
  throw new Error(`the bot browser has no ${what} control`)
}

/**
 * 一个浏览器连接的缓存：失败不留在缓存里（否则一次冷启动抖动会让这台电脑的浏览器永久报废），
 * 浏览器没了就下次重开。`open` 由后端给：容器是 connectOverCDP，本机是 launch。
 */
export type BrowserSession = {
  page(): Promise<PageLike>
  /** Replay uses the same selected page as ordinary computer calls; a popup cannot silently replace it. */
  workflowPage(): Promise<PageLike>
  context(): Promise<ContextLike>
  /** idle = 还没开过；open = 连着；gone = 开过但浏览器没了（下次 page() 会重开）。不会去开新的。 */
  state(): 'idle' | 'open' | 'gone'
  dispose(): Promise<void>
}

export function createBrowserSession(open: () => Promise<BrowserLike>): BrowserSession {
  let browser: BrowserLike | null = null
  let pending: Promise<BrowserLike> | null = null
  let everOpened = false
  let generation = 0
  let selectedPage: PageLike | null = null

  function dropIfGone(): void {
    if (browser?.isConnected && !browser.isConnected()) {
      browser = null
      pending = null
      selectedPage = null
    }
  }

  async function context(): Promise<ContextLike> {
    dropIfGone()
    if (!browser) {
      const gen = generation
      const opening = (pending ??= open().catch((err: unknown) => {
        if (pending === opening) pending = null
        throw err
      }))
      const opened = await opening
      // 启动途中被 dispose() 了：刚拉起来的这台立刻关掉，绝不留下孤儿浏览器占着配置锁
      if (gen !== generation) {
        await opened.close().catch(() => {})
        throw new Error('bot browser session was closed while starting')
      }
      browser = opened
      everOpened = true
    }
    const ctx = browser.contexts()[0]
    if (!ctx) throw new Error('bot browser has no context')
    return ctx
  }

  return {
    context,
    async page() {
      const ctx = await context()
      const pages = ctx.pages()
      // Ordinary browser actions follow the most recently opened tab, preserving normal browsing.
      selectedPage = [...pages].reverse().find((candidate) => !candidate.isClosed?.()) ?? await ctx.newPage()
      return selectedPage
    },
    async workflowPage() {
      const ctx = await context()
      const pages = ctx.pages()
      // A replay pins the page selected when it starts. Replace it only after it closes, such as
      // when the local browser is relaunched; newly opened tabs are handled by the replay guard.
      if (selectedPage && !selectedPage.isClosed?.() && pages.includes(selectedPage)) return selectedPage
      selectedPage = [...pages].reverse().find((candidate) => !candidate.isClosed?.()) ?? await ctx.newPage()
      return selectedPage
    },
    state() {
      dropIfGone()
      return browser ? 'open' : everOpened ? 'gone' : 'idle'
    },
    async dispose() {
      generation += 1
      const b = browser
      const p = pending
      browser = null
      pending = null
      everOpened = false
      selectedPage = null
      if (b) await b.close().catch(() => {}) // 断开失败不该拖垮调用方
      else if (p) await p.then((opened) => opened.close()).catch(() => {})
    },
  }
}

export type PageOperations = Pick<
  BotComputer,
  'goto' | 'currentUrl' | 'extract' | 'links' | 'click' | 'type' | 'fillSecret' | 'press' | 'scroll' | 'back' | 'screenshot'
>

function sanitizeSecretError(err: unknown, secret: string): string {
  const raw = err instanceof Error ? err.message : String(err)
  return secret.length >= 2 ? raw.split(secret).join('[REDACTED]') : raw
}

/** BotComputer 里和浏览器有关的那些方法，全部建立在「给我当前页面」之上。 */
export function pageOperations(
  page: () => Promise<PageLike>,
  beforeAction?: (page: PageLike) => void | Promise<void>,
): PageOperations {
  return {
    async goto(url) {
      const safe = checkBrowserUrl(url, { allowData: true })
      const p = await page()
      await p.goto(safe, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      return { url: p.url(), title: await p.title() }
    },
    async currentUrl() {
      return (await page()).url()
    },
    async extract(maxChars) {
      const text = (await (await page()).innerText('body')).replace(/\n{3,}/g, '\n\n').trim()
      return maxChars ? text.slice(0, maxChars) : text
    },
    async links() {
      const p = await page()
      if (!p.evaluate) return []
      const found = await p.evaluate(LINKS_SCRIPT)
      return Array.isArray(found) ? (found as PageLink[]) : []
    },
    async click(target) {
      const p = await page()
      // bot 更常说「点 Sign in」而不是 CSS：两种都试，顺序按目标长得像什么来定
      const bySelector = async () => {
        await beforeAction?.(p)
        await p.click(target, { timeout: 5_000 })
      }
      const byText = async () => {
        if (!p.getByText) throw new Error(`no element matches ${target}`)
        const first = p.getByText(target).first()
        if (!first.click) throw new Error(`no element matches ${target}`)
        await beforeAction?.(p)
        await first.click({ timeout: 5_000 })
      }
      await firstThatWorks(looksLikeSelector(target) ? [bySelector, byText] : [byText, bySelector])
      await p.waitForLoadState?.('domcontentloaded', { timeout: 5_000 }).catch(() => {})
      let now: PageLike | null = null
      try { now = await page() } catch { /* The click may close its page; action completion is still useful. */ }
      let url: string | undefined
      let title: string | undefined
      if (now) {
        try { url = now.url() } catch { /* Post-click metadata is best-effort. */ }
        try { title = await now.title() } catch { /* Post-click metadata is best-effort. */ }
      }
      return { clicked: target, ...(url ? { url } : {}), ...(title ? { title } : {}) }
    },
    async type(target, text, submit) {
      const p = await page()
      const bySelector = async () => {
        if (!p.fill) throw new Error('this browser cannot fill fields')
        await beforeAction?.(p)
        await p.fill(target, text, { timeout: 3_000 })
      }
      const byLabel = async () => {
        if (!p.getByLabel) throw new Error(`no field labelled ${target}`)
        const first = p.getByLabel(target).first()
        if (!first.fill) throw new Error(`no field labelled ${target}`)
        await beforeAction?.(p)
        await first.fill(text, { timeout: 3_000 })
      }
      const byPlaceholder = async () => {
        if (!p.getByPlaceholder) throw new Error(`no field with placeholder ${target}`)
        const first = p.getByPlaceholder(target).first()
        if (!first.fill) throw new Error(`no field with placeholder ${target}`)
        await beforeAction?.(p)
        await first.fill(text, { timeout: 3_000 })
      }
      await firstThatWorks(looksLikeSelector(target)
        ? [bySelector, byLabel, byPlaceholder]
        : [byLabel, byPlaceholder, bySelector])
      if (submit) {
        await beforeAction?.(p)
        await (p.keyboard ?? missing('keyboard')).press('Enter')
      }
    },
    async fillSecret(target, secretValue, opts) {
      const p = await page()
      const actualOrigin = normalizePageOrigin(p.url())
      if (!actualOrigin || actualOrigin !== opts.expectedOrigin) {
        throw new VaultFillError(
          'origin_mismatch',
          `Page origin changed to "${actualOrigin ?? '(unknown)'}" (expected "${opts.expectedOrigin}"); nothing was filled.`,
        )
      }

      const tryFillElement = async (el: WorkflowElementLike | null | undefined, label: string): Promise<void> => {
        if (!el || !el.fill) throw new Error(label)
        if (el.waitFor) await el.waitFor({ state: 'visible', timeout: 3_000 })
        if (opts.requirePasswordInput) await assertPasswordInputElement(el)
        await el.fill(secretValue, { timeout: 3_000 })
      }

      const bySelector = async () => {
        if (p.locator) {
          await tryFillElement(p.locator(target).first(), `no selector matching ${target}`)
          return
        }
        if (opts.requirePasswordInput) {
          throw new VaultFillError(
            'unsupported_browser',
            'Refused to fill a secret field because the browser cannot inspect the target element.',
          )
        }
        if (!p.fill) throw new Error('this browser cannot fill fields')
        await p.fill(target, secretValue, { timeout: 3_000 })
      }
      const byLabel = async () => {
        if (!p.getByLabel) throw new Error(`no field labelled ${target}`)
        await tryFillElement(p.getByLabel(target).first(), `no field labelled ${target}`)
      }
      const byPlaceholder = async () => {
        if (!p.getByPlaceholder) throw new Error(`no field with placeholder ${target}`)
        await tryFillElement(p.getByPlaceholder(target).first(), `no field with placeholder ${target}`)
      }

      const attempts = looksLikeSelector(target)
        ? [bySelector, byLabel, byPlaceholder]
        : [byLabel, byPlaceholder, bySelector]

      let firstErr: unknown
      let filled = false
      for (const attempt of attempts) {
        try {
          await attempt()
          filled = true
          break
        } catch (err) {
          // 明确命中了非密码输入框就立刻停止，不再退回别的选择器碰运气
          if (err instanceof VaultFillError && err.code === 'not_password_input') throw err
          firstErr ??= err
        }
      }
      if (!filled) {
        if (firstErr instanceof VaultFillError) throw firstErr
        throw new VaultFillError('fill_failed', sanitizeSecretError(firstErr, secretValue))
      }

      if (opts.submit) {
        try {
          await (p.keyboard ?? missing('keyboard')).press('Enter')
        } catch (err) {
          throw new VaultFillError('fill_failed', sanitizeSecretError(err, secretValue))
        }
      }
      return { origin: actualOrigin }
    },
    async press(key) {
      const p = await page()
      await beforeAction?.(p)
      await (p.keyboard ?? missing('keyboard')).press(key)
    },
    async scroll(direction) {
      await ((await page()).mouse ?? missing('mouse')).wheel(0, direction === 'down' ? 700 : -700)
    },
    async back() {
      const p = await page()
      if (!p.goBack) missing('history')
      await p.goBack!({ waitUntil: 'domcontentloaded', timeout: 45_000 })
      return { url: p.url(), title: await p.title() }
    },
    async screenshot(): Promise<Shot> {
      const p = await page()
      const buffer = await p.screenshot({ type: 'png' })
      const size = p.viewportSize() ?? { width: 1280, height: 800 }
      return { buffer, width: size.width, height: size.height }
    },
  }
}
