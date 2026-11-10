import type { PageLang } from './pages.js'

/**
 * 窗口关了 App 还在：托盘上说几位同事在干活、几件事等你；Dock 角标是等你的件数；
 * 窗口不在前台时，等你批准、问你问题、要你登录的事发系统通知；有活在跑时退出先问一句。
 * 这里只有文字和判断（纯函数）和一个连网关 /ws 的小客户端；Electron 的托盘、通知、对话框在 main.ts。
 */

/** /api/summary */
export type Summary = { working: number; waiting: number; routines: number }

const TEXT = {
  en: {
    open: 'Open OpenSuperBot',
    quit: 'Quit OpenSuperBot',
    idle: 'No teammate is working',
    working: (n: number) => (n === 1 ? '1 teammate working' : `${n} teammates working`),
    waiting: (n: number) => `${n} waiting on you`,
    offline: 'Gateway not running',
    quitTitle: 'Quit while work is running?',
    quitDetail: (s: Summary) => {
      const parts = [
        s.working ? (s.working === 1 ? '1 teammate is working' : `${s.working} teammates are working`) : '',
        s.routines ? (s.routines === 1 ? '1 routine is on' : `${s.routines} routines are on`) : '',
      ].filter(Boolean)
      return `${parts.join(' and ')}. Once you quit, nothing runs until you open OpenSuperBot again — routines included.`
    },
    quitButton: 'Quit',
    cancelButton: 'Cancel',
    approval: (name: string, action: string) => [`${name} needs your approval`, action] as const,
    question: (name: string, q: string) => [`${name} has a question`, q] as const,
    login: (name: string, site: string) => [`${name} needs you to sign in`, site] as const,
  },
  'zh-CN': {
    open: '打开 OpenSuperBot',
    quit: '退出 OpenSuperBot',
    idle: '没有同事在干活',
    working: (n: number) => `${n} 位同事在干活`,
    waiting: (n: number) => `${n} 件事等你`,
    offline: '网关没在运行',
    quitTitle: '还有活在跑，确定退出吗？',
    quitDetail: (s: Summary) => {
      const parts = [s.working ? `${s.working} 位同事正在干活` : '', s.routines ? `${s.routines} 条例行任务开着` : ''].filter(Boolean)
      return `${parts.join('，')}。退出以后它们都不会再跑，例行任务也一样，直到你再打开 OpenSuperBot。`
    },
    quitButton: '退出',
    cancelButton: '取消',
    approval: (name: string, action: string) => [`${name} 等你批准`, action] as const,
    question: (name: string, q: string) => [`${name} 有个问题问你`, q] as const,
    login: (name: string, site: string) => [`${name} 需要你登录`, site] as const,
  },
} as const

export const texts = (lang: PageLang) => TEXT[lang]

/** 托盘菜单里的两行状态；网关没起来时只有一行 */
export function trayStatus(summary: Summary | null, lang: PageLang): string[] {
  const t = TEXT[lang]
  if (!summary) return [t.offline]
  return [summary.working ? t.working(summary.working) : t.idle, ...(summary.waiting ? [t.waiting(summary.waiting)] : [])]
}

/** 退出前要不要问：有同事在干活，或者有开着的例行任务（退出后就不会按时跑了） */
export function quitQuestion(summary: Summary | null, lang: PageLang): { title: string; detail: string; quit: string; cancel: string } | null {
  if (!summary || (!summary.working && !summary.routines)) return null
  const t = TEXT[lang]
  return { title: t.quitTitle, detail: t.quitDetail(summary), quit: t.quitButton, cancel: t.cancelButton }
}

/** /ws 推来的一条消息（只用到这几样） */
export type GatewayMessageEvent = {
  type: 'message'
  threadId: string
  message: { id: number; sender: string; kind: string; content: string; payload: unknown }
}

const clip = (s: string, n = 180) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * 这条消息要不要发系统通知：等你批准（还没定）、问你问题（还开着）、要你登录。
 * 别的（汇报、截图、已经定了的审批更新）不打扰。同一件事就地更新时 id 不变，调用方按 id 去重
 */
export function notificationFor(e: GatewayMessageEvent, names: Record<string, string>, lang: PageLang): { title: string; body: string; threadId: string; key: string } | null {
  const t = TEXT[lang]
  const m = e.message
  const name = names[m.sender] ?? m.sender
  const p = (m.payload ?? {}) as Record<string, unknown>
  let pair: readonly [string, string] | null = null
  if (m.kind === 'approval_request' && p.status === 'pending') pair = t.approval(name, String(p.action ?? m.content))
  else if (m.kind === 'question' && p.status === 'open') pair = t.question(name, String(p.question ?? m.content))
  else if (m.kind === 'login_request') pair = t.login(name, String(p.site ?? m.content))
  return pair ? { title: pair[0], body: clip(pair[1]), threadId: e.threadId, key: `${m.kind}:${m.id}` } : null
}

/** 能连上网关 /ws 的 WebSocket（Node 自带的 undici 版支持在握手里带头） */
type SocketLike = {
  addEventListener(type: 'message', l: (e: { data: unknown }) => void): void
  addEventListener(type: 'close' | 'error' | 'open', l: () => void): void
  close(): void
}
export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike

const nodeSocket: SocketFactory = (url, headers) =>
  new (globalThis as unknown as { WebSocket: new (u: string, init: unknown) => SocketLike }).WebSocket(url, { headers })

/**
 * 主进程自己连网关的 /ws（带令牌；不带 Origin，网关只认令牌）。断了 2 秒后重连，网关重启也接得上。
 * 每次连上网关都会先发一份 hello 快照。
 */
export function watchGateway(opts: {
  url: () => string
  token: () => string
  onEvent: (e: { type: string } & Record<string, unknown>) => void
  socket?: SocketFactory
  retryMs?: number
}): () => void {
  const make = opts.socket ?? nodeSocket
  let closed = false
  let ws: SocketLike | null = null
  let timer: NodeJS.Timeout | undefined
  const open = () => {
    if (closed) return
    try {
      ws = make(opts.url(), { authorization: `Bearer ${opts.token()}` })
    } catch {
      timer = setTimeout(open, opts.retryMs ?? 2_000)
      return
    }
    ws.addEventListener('message', (e) => {
      try { opts.onEvent(JSON.parse(String(e.data))) } catch { /* 坏帧不管 */ }
    })
    ws.addEventListener('close', () => {
      ws = null
      if (!closed) timer = setTimeout(open, opts.retryMs ?? 2_000)
    })
  }
  open()
  return () => {
    closed = true
    clearTimeout(timer)
    ws?.close()
  }
}

/** 拉一次 /api/summary；网关没应答就是 null */
export async function fetchSummary(base: string, token: string, fetchImpl: typeof fetch = fetch): Promise<Summary | null> {
  try {
    const res = await fetchImpl(`${base}/api/summary`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1_500) })
    if (!res.ok) return null
    const s = (await res.json()) as Partial<Summary>
    return { working: Number(s.working) || 0, waiting: Number(s.waiting) || 0, routines: Number(s.routines) || 0 }
  } catch {
    return null
  }
}

/** 同事 id → 名字（通知里用名字） */
export async function fetchNames(base: string, token: string, fetchImpl: typeof fetch = fetch): Promise<Record<string, string>> {
  try {
    const res = await fetchImpl(`${base}/api/bots`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1_500) })
    if (!res.ok) return {}
    const bots = (await res.json()) as { id: string; name: string }[]
    return Object.fromEntries(bots.map((b) => [b.id, b.name]))
  } catch {
    return {}
  }
}
