/**
 * 窗口里只该有网关的界面。规则（判断是纯函数，接线在 secureContents）：
 * - 导航：只放行网关自己（同端口的 127.0.0.1 / localhost / [::1]）；别的 http(s) 交给系统浏览器，其余一律拦下。
 *   错误页上的 `osb:` 动作单独交给主进程。
 * - 新窗口：网关自己的页（屏幕、附件的图片）在 App 里开一个同样安全设置的窗口——它要带登录 cookie，
 *   交给系统浏览器会 401；外部 http(s) 交给系统浏览器；别的协议（file:、javascript:、自定义协议）一律不开。
 * - 下载：网关回 attachment 的（附件）在 App 里接住，存进「下载」文件夹（文件名不覆盖已有的）。
 * - 权限：只给网关的页通知和写剪贴板（「复制」按钮），别的一律拒——麦克风、摄像头、定位、读剪贴板……
 * - 不许 <webview>。
 */

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

const parse = (url: string): URL | null => {
  try { return new URL(url) } catch { return null }
}

/** 是不是网关自己：http、同端口、本机回环地址 */
export function isGateway(url: string, gatewayOrigin: string): boolean {
  const u = parse(url)
  const g = parse(gatewayOrigin)
  return Boolean(u && g && u.protocol === 'http:' && u.port === g.port && LOOPBACK.has(u.hostname))
}

/** 换成窗口登录用的那个地址（cookie 种在 127.0.0.1 上；localhost 那边没有登录） */
export function toGatewayUrl(url: string, gatewayOrigin: string): string {
  const u = new URL(url)
  const g = new URL(gatewayOrigin)
  return `${g.origin}${u.pathname}${u.search}${u.hash}`
}

const isWeb = (url: string) => {
  const u = parse(url)
  return u?.protocol === 'http:' || u?.protocol === 'https:'
}

export type NavigationDecision = 'allow' | 'external' | 'action' | 'deny'

/** 窗口里点了链接、页面自己跳转（不含主进程的 loadURL） */
export function navigationDecision(url: string, gatewayOrigin: string): NavigationDecision {
  if (url.startsWith('osb:')) return 'action'
  if (isGateway(url, gatewayOrigin)) return 'allow'
  if (isWeb(url)) return 'external'
  return 'deny'
}

export type WindowDecision = 'in-app' | 'external' | 'deny'

/** window.open、target=_blank */
export function windowOpenDecision(url: string, gatewayOrigin: string): WindowDecision {
  if (isGateway(url, gatewayOrigin)) return 'in-app'
  if (isWeb(url)) return 'external'
  return 'deny'
}

const GRANTED = new Set(['notifications', 'clipboard-sanitized-write'])

/** 网页要权限：只有网关的页、只有这两样 */
export function permissionAllowed(permission: string, requestingUrl: string, gatewayOrigin: string): boolean {
  return GRANTED.has(permission) && isGateway(requestingUrl, gatewayOrigin)
}

/** 下载存到哪：同名就加 (1)、(2)……不覆盖已有的文件；名字里的路径分隔符一律去掉 */
export function downloadPath(dir: string, suggested: string, exists: (p: string) => boolean, sep = '/'): string {
  const clean = suggested.replace(/[/\\:\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim() || 'download'
  const dot = clean.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, '']
  for (let n = 0; ; n++) {
    const candidate = `${dir}${sep}${n ? `${stem} (${n})${ext}` : clean}`
    if (!exists(candidate)) return candidate
  }
}

/** 安全设置：主窗口和 App 里开的新窗口都用这一份 */
export const SAFE_WEB_PREFERENCES = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webviewTag: false,
  safeDialogs: true,
} as const

/** 接线用到的那几样 Electron 的东西（测试里换成假的） */
export type ContentsLike = {
  on(event: 'will-navigate', listener: (e: { preventDefault(): void }, url: string) => void): unknown
  on(event: 'will-attach-webview', listener: (e: { preventDefault(): void }) => void): unknown
  setWindowOpenHandler(handler: (details: { url: string }) => unknown): void
}

export function secureContents(contents: ContentsLike, opts: {
  gatewayOrigin: () => string
  openExternal: (url: string) => void
  /** 网关自己的页：主进程用同样的安全设置开一个窗口（地址已换成登录过的那个） */
  openInApp: (url: string) => void
  onAction: (url: string) => void
  log?: (line: string) => void
}): void {
  contents.on('will-navigate', (e, url) => {
    const decision = navigationDecision(url, opts.gatewayOrigin())
    if (decision === 'allow') return
    e.preventDefault()
    if (decision === 'action') opts.onAction(url)
    else if (decision === 'external') opts.openExternal(url)
    else opts.log?.(`blocked navigation to ${url.slice(0, 200)}`)
  })
  contents.on('will-attach-webview', (e) => e.preventDefault())
  contents.setWindowOpenHandler(({ url }) => {
    const decision = windowOpenDecision(url, opts.gatewayOrigin())
    if (decision === 'in-app') opts.openInApp(toGatewayUrl(url, opts.gatewayOrigin()))
    else if (decision === 'external') opts.openExternal(url)
    else opts.log?.(`blocked a new window for ${url.slice(0, 200)}`)
    return { action: 'deny' }
  })
}
