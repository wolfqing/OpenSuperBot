import { existsSync, readFileSync } from 'node:fs'
import { homedir, release } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, Menu, Notification, Tray, app, dialog, ipcMain, nativeImage, session, shell, utilityProcess, type MenuItemConstructorOptions } from 'electron'
import { fetchNames, fetchSummary, notificationFor, quitQuestion, texts, trayStatus, watchGateway, type GatewayMessageEvent, type Summary } from './activity.js'
import { diagnosticsText } from './diagnostics.js'
import { registerDesktopApi } from './ipc.js'
import { openLog } from './logfile.js'
import { loginItem } from './loginitem.js'
import { dataUrl, errorPage, pageLang, startingPage } from './pages.js'
import { appLayout, resources } from './paths.js'
import { DEFAULT_PORT, choosePort, portInUse, probePort, readState, writeState } from './port.js'
import { SAFE_WEB_PREFERENCES, downloadPath, permissionAllowed, secureContents } from './security.js'
import { createSupervisor, type FailReason } from './supervisor.js'

/**
 * 桌面壳：拉起网关（utilityProcess）→ 等它说 ready → 种上会话 cookie → 窗口打开网关的界面。
 * 网关崩了按退避重启；起不来就停在错误页（重试、复制诊断信息、打开日志文件夹）。只允许开一个。
 * 窗口里只有网关的界面：导航、新窗口、权限、下载的规则见 security.ts。端口被占就换一个并记住（port.ts）。
 * 关窗不退：托盘（菜单栏图标）和 Dock 角标说着谁在干活、几件事等你；窗口不在前台时，等你的事发系统通知（activity.ts）。
 */

const layout = appLayout({ platform: process.platform, home: homedir(), appData: app.getPath('appData'), env: process.env })
// Electron 自己的 cookie、缓存放进同一个根目录，卸载时删一个目录就干净；必须在 ready 之前设
app.setPath('userData', layout.session)

/** 网关的会话 cookie（gateway/src/auth.ts 的 SESSION_COOKIE） */
const SESSION_COOKIE = 'osb_session'
/** OPENSUPERBOT_PORT 指定了就只用它（开发时和源码版网关错开）；否则默认 4747，被占就换一个并记住（port.ts） */
const ENV_PORT = Number(process.env.OPENSUPERBOT_PORT) || null
const base = (port: number) => `http://127.0.0.1:${port}`

if (!app.requestSingleInstanceLock()) {
  // 已经开着一个：那边会把窗口叫到前面，这边直接退
  app.quit()
} else {
  run()
}

function run() {
  const res = resources({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() })
  const log = openLog(layout.logFile)
  let win: BrowserWindow | null = null
  let port = ENV_PORT ?? readState(layout.root).port ?? DEFAULT_PORT
  /** 起不来是因为端口刚被抢：自动换端口重来，最多这么多次，再不行就出错误页 */
  let portRetries = 0
  let showing: 'starting' | 'gateway' | 'error' = 'starting'
  /** 退出走到哪一步：running → asking（在问要不要退）→ stopping（在收摊，窗口可以关了） */
  let quitPhase: 'running' | 'asking' | 'stopping' = 'running'
  let lastFailure: FailReason = 'exited'
  let tray: Tray | null = null
  let summary: Summary | null = null
  let names: Record<string, string> = {}
  let stopWatching: (() => void) | null = null
  let refreshTimer: NodeJS.Timeout | undefined
  /** 发过通知的事（审批卡片就地更新时 id 不变，不重复打扰） */
  const notified = new Set<string>()
  let lastTray = ''

  const lang = () => pageLang(app.getLocale())
  const say = (line: string) => log.write(`[desktop] ${line}`)

  const supervisor = createSupervisor({
    fork: () => utilityProcess.fork(res.gatewayMain, [], {
      stdio: 'pipe',
      serviceName: 'OpenSuperBot gateway',
      env: {
        ...process.env,
        OPENSUPERBOT_DATA: layout.data,
        OPENSUPERBOT_PORT: String(port),
        OPENSUPERBOT_WEB_DIST: res.webDist,
        OPENSUPERBOT_TEAMMATES: res.teammates,
        OPENSUPERBOT_VERSION: app.getVersion(),
        OPENSUPERBOT_LOG_FILE: layout.logFile,
        // 日志文件会被贴到 issue 里：令牌别写进去
        OPENSUPERBOT_QUIET_TOKEN: '1',
      },
    }),
  }, {
    line: (text) => log.write(text),
    ready: (p) => {
      port = p
      portRetries = 0
      say(`gateway ready on ${base(p)}`)
      void openGateway()
      watch()
    },
    restarting: (attempt, delayMs) => say(`gateway crashed; restart #${attempt} in ${delayMs / 1000}s`),
    failed: (reason) => {
      // 探测时空着、拉起时被抢了：换下一个端口自己重来，不劳人点
      if (reason === 'exited' && !ENV_PORT && portInUse(supervisor.lastRun()) && portRetries < 3) {
        portRetries++
        void pickPort([port]).then((ok) => (ok ? supervisor.retry() : showError(reason)))
        return
      }
      showError(reason)
    },
  })

  /**
   * 选端口：记住的那个（第一次是 4747）还空着就用它；被占了就往后找一个、记住新的。
   * avoid：刚刚证明用不了的端口。OPENSUPERBOT_PORT 指定了就不选
   */
  async function pickPort(avoid: number[] = []): Promise<boolean> {
    if (ENV_PORT) return true
    const state = readState(layout.root)
    const remembered = state.port ?? DEFAULT_PORT
    const chosen = await choosePort({ preferred: remembered, probe: probePort, avoid })
    if (chosen === null) {
      say(`no free port from ${DEFAULT_PORT} on; leaving it at ${remembered}`)
      return false
    }
    if (chosen !== remembered) say(`port ${remembered} is in use; using ${chosen} from now on`)
    if (chosen !== state.port) writeState(layout.root, { ...state, port: chosen })
    port = chosen
    return true
  }

  /** 种上会话 cookie 再打开界面：不用登录链接。令牌每次现读（网关第一次启动时才生成） */
  async function openGateway() {
    if (!win) return
    const token = readFileSync(join(layout.data, 'auth-token'), 'utf8').trim()
    await session.defaultSession.cookies.set({
      url: base(port), name: SESSION_COOKIE, value: token, httpOnly: true, sameSite: 'strict',
    })
    // 重启后网关还在原来的端口：界面自己会重连，不用重新加载
    if (showing === 'gateway' && win.webContents.getURL().startsWith(base(port))) return
    showing = 'gateway'
    await win.loadURL(`${base(port)}/`)
  }

  const token = () => readFileSync(join(layout.data, 'auth-token'), 'utf8').trim()

  /** 主进程自己听网关的 /ws：状态变了刷新托盘和角标；等你的事、窗口又不在前台，就发通知 */
  function watch() {
    stopWatching?.()
    stopWatching = watchGateway({
      url: () => `ws://127.0.0.1:${port}/ws`,
      token,
      onEvent: (e) => {
        if (e.type === 'message') {
          const m = e as unknown as GatewayMessageEvent
          if (!(m.message.sender in names)) void fetchNames(base(port), token()).then((n) => { names = n; maybeNotify(m) })
          else maybeNotify(m)
        }
        if (e.type === 'hello' || e.type === 'status' || e.type === 'message') scheduleRefresh()
      },
    })
    void fetchNames(base(port), token()).then((n) => { names = n })
    scheduleRefresh()
  }

  function maybeNotify(e: GatewayMessageEvent) {
    const n = notificationFor(e, names, lang())
    if (!n || notified.has(n.key)) return
    notified.add(n.key)
    // 正看着窗口就不打扰：消息就在眼前
    if (win?.isVisible() && win.isFocused()) return
    if (!Notification.isSupported()) return
    say(`notify ${n.key} in ${n.threadId}`)
    const note = new Notification({ title: n.title, body: n.body })
    note.on('click', () => showThread(n.threadId))
    note.show()
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      void fetchSummary(base(port), token()).then((s) => {
        summary = s
        updateTray()
      })
    }, 300)
  }

  /** 托盘菜单：打开、谁在干活、几件事等你、退出；Dock 角标和 macOS 菜单栏上的数字 = 等你的件数 */
  function updateTray() {
    const t = texts(lang())
    const lines = trayStatus(summary, lang())
    const waiting = summary?.waiting ?? 0
    app.setBadgeCount(waiting)
    if (!tray) return
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: t.open, click: showWindow },
      { type: 'separator' },
      ...lines.map((label) => ({ label, enabled: false })),
      { type: 'separator' },
      { label: t.quit, click: () => void userQuit() },
    ]))
    if (process.platform === 'darwin') tray.setTitle(waiting ? String(waiting) : '')
    const now = `${lines.join(' · ')} · badge ${waiting}`
    if (now !== lastTray) say(`tray: ${now}`)
    lastTray = now
  }

  function createTray() {
    // macOS 用模板图（系统按菜单栏深浅自己上色）；别的平台用彩色的
    const file = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'
    const image = nativeImage.createFromPath(join(app.getAppPath(), 'assets', file))
    if (process.platform === 'darwin') image.setTemplateImage(true)
    tray = new Tray(image)
    tray.setToolTip('OpenSuperBot')
    if (process.platform !== 'darwin') tray.on('click', showWindow)
    updateTray()
  }

  function showWindow() {
    if (!win) createWindow()
    if (win?.isMinimized()) win.restore()
    win?.show()
    win?.focus()
  }

  /** 点了通知：把窗口叫出来，打开那条对话（界面认 #thread=…） */
  function showThread(threadId: string) {
    showWindow()
    if (showing === 'gateway') void win?.loadURL(`${base(port)}/#thread=${encodeURIComponent(threadId)}`)
  }

  /**
   * 托盘和菜单里的「退出」：有同事在干活或有开着的例行任务，先说清楚退出后它们不会跑，再问。
   * 只有这两个入口问——关机、注销、信号、Dock 菜单里的退出在 before-quit 里分不出是谁发起的，一律不问，免得挡住关机。
   * OPENSUPERBOT_DESKTOP_QUIT_ANSWERS=cancel,quit（冒烟测试用）按顺序替人回答
   */
  const scripted = (process.env.OPENSUPERBOT_DESKTOP_QUIT_ANSWERS ?? '').split(',').map((a) => a.trim()).filter(Boolean)
  async function userQuit() {
    if (quitPhase !== 'running') return
    quitPhase = 'asking'
    const ok = await confirmQuit()
    if (quitPhase !== 'asking') return // 问的时候系统先发起了退出，已经在收摊了
    if (ok) return stopAndExit()
    quitPhase = 'running'
    say('quit cancelled; still running')
  }

  async function confirmQuit(): Promise<boolean> {
    if (supervisor.state() !== 'running') return true
    const s = await fetchSummary(base(port), token())
    const q = quitQuestion(s, lang())
    if (!q) return true
    say(`asking before quitting: ${s?.working} working, ${s?.routines} routines on`)
    if (scripted.length) return scripted.shift() === 'quit'
    const options = { type: 'question' as const, message: q.title, detail: q.detail, buttons: [q.quit, q.cancel], defaultId: 0, cancelId: 1 }
    const { response } = win?.isVisible() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
    return response === 0
  }

  function showError(reason: FailReason) {
    showing = 'error'
    lastFailure = reason
    const tail = supervisor.tail()
    const text = diagnosticsText({
      appVersion: app.getVersion(), electron: process.versions.electron ?? '', platform: process.platform, arch: process.arch,
      osVersion: release(), dataDir: layout.data, logFile: layout.logFile, port, reason, tail,
    })
    void win?.loadURL(dataUrl(errorPage(lang(), reason, text, tail)))
  }

  function createWindow() {
    win = new BrowserWindow({
      width: 1200, height: 800, minWidth: 720, minHeight: 480, title: 'OpenSuperBot', backgroundColor: '#0d0d0d',
      // 只有主窗口带 preload（window.opensuperbot）；App 里另开的窗口（屏幕、附件）不需要
      webPreferences: { ...SAFE_WEB_PREFERENCES, preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)) },
    })
    // 关窗不退：同事和例行任务接着跑，托盘或 Dock 上再打开
    win.on('close', (e) => {
      if (quitPhase === 'stopping') return
      e.preventDefault()
      win?.hide()
      say('window hidden; still running')
    })
    win.on('closed', () => { win = null })
    if (supervisor.state() === 'running') {
      showing = 'starting'
      void openGateway()
    } else if (supervisor.state() === 'failed') {
      showError(lastFailure)
    } else {
      void win.loadURL(dataUrl(startingPage(lang())))
    }
  }

  /** 错误页上的按钮：osb:retry、osb:logs */
  function onAction(url: string) {
    if (url === 'osb:retry') {
      showing = 'starting'
      void win?.loadURL(dataUrl(startingPage(lang())))
      portRetries = 0
      void pickPort().finally(() => supervisor.retry())
    } else if (url === 'osb:logs') {
      void shell.openPath(layout.logs)
    }
  }

  /** 外部链接交给系统浏览器；日志只记域名。OPENSUPERBOT_DESKTOP_NO_EXTERNAL=1 时只记不开（冒烟测试用） */
  function openExternal(url: string) {
    say(`opening in the browser: ${new URL(url).host}`)
    if (process.env.OPENSUPERBOT_DESKTOP_NO_EXTERNAL !== '1') void shell.openExternal(url)
  }

  /** 网关自己的页（屏幕、附件）：App 里开一个窗口，同样的安全设置、同一个登录 */
  function openInApp(url: string) {
    const child = new BrowserWindow({ width: 1000, height: 760, title: 'OpenSuperBot', backgroundColor: '#0d0d0d', webPreferences: { ...SAFE_WEB_PREFERENCES } })
    void child.loadURL(url)
  }

  // 每一块网页内容（主窗口、App 里开的窗口）都套上同一套规则
  app.on('web-contents-created', (_e, contents) => {
    secureContents(contents, {
      gatewayOrigin: () => base(port),
      openExternal,
      openInApp,
      onAction,
      log: (line) => say(line),
    })
  })

  /** 权限只给网关的页、只给通知和写剪贴板；附件下载存进「下载」文件夹 */
  function secureSession() {
    const s = session.defaultSession
    s.setPermissionRequestHandler((wc, permission, callback, details) => {
      const ok = permissionAllowed(permission, details.requestingUrl || wc.getURL(), base(port))
      if (!ok) say(`denied permission ${permission} to ${(details.requestingUrl || wc.getURL()).slice(0, 120)}`)
      callback(ok)
    })
    s.setPermissionCheckHandler((_wc, permission, requestingOrigin) => permissionAllowed(permission, requestingOrigin, base(port)))
    s.on('will-download', (_e, item, wc) => {
      // OPENSUPERBOT_DESKTOP_DOWNLOADS 换个下载文件夹（冒烟测试用，不往真的「下载」里写）
      const dir = process.env.OPENSUPERBOT_DESKTOP_DOWNLOADS?.trim() || app.getPath('downloads')
      const path = downloadPath(dir, item.getFilename(), existsSync, sep)
      item.setSavePath(path)
      say(`downloading ${item.getFilename()} → ${path}`)
      // 为了下载才开的空窗口（附件链接在新窗口里打开）：下载开始了就关掉它
      const owner = BrowserWindow.fromWebContents(wc)
      if (owner && owner !== win && ['', 'about:blank'].includes(wc.getURL())) owner.close()
      item.once('done', (_done, state) => {
        say(`download ${state}: ${path}`)
        if (state === 'completed') app.dock?.downloadFinished(path)
      })
    })
  }

  app.on('second-instance', showWindow)

  /** 请网关收摊（停调度、关同事的电脑和本机 Chrome），收完再真退 */
  function stopAndExit() {
    if (quitPhase === 'stopping') return
    quitPhase = 'stopping'
    say('quitting: asking the gateway to stop')
    stopWatching?.()
    void supervisor.stop().finally(() => {
      say('gateway stopped; bye')
      // 在这次 before-quit 里直接再 quit 会被 Electron 当成同一次退出、什么都不做（网关早就不在时 stop 立刻就完）：
      // 挪到下一轮再 quit；万一还不退，3 秒后强退——该收的都收完了
      setImmediate(() => app.quit())
      setTimeout(() => app.exit(0), 3_000).unref()
    })
  }

  // 别处发起的退出（关机、注销、信号、Dock 菜单）：不问，直接收摊再退
  app.on('before-quit', (e) => {
    if (quitPhase === 'stopping') return
    e.preventDefault()
    stopAndExit()
  })

  /**
   * macOS 的应用菜单：照常的几项，只是「退出」（⌘Q）走会先问的那条路。别的平台不要菜单栏
   * （Electron 默认那份里的退出不问就退）。编辑菜单要留：没有它 ⌘C、⌘V 在输入框里不灵
   */
  function setMenu() {
    if (process.platform !== 'darwin') return Menu.setApplicationMenu(null)
    const t = texts(lang())
    const template: MenuItemConstructorOptions[] = [
      { label: app.name, submenu: [
        { role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
        { label: t.quit, accelerator: 'Command+Q', click: () => void userQuit() },
      ] },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  }

  // 窗口都关了也不退：托盘还在，同事接着干活
  app.on('window-all-closed', () => {})
  app.on('activate', showWindow)

  // 冒烟测试用：从标准输入读命令，close = 关窗，quit = 在托盘或菜单里点了「退出」。
  // 不用信号：Chromium 自己接管了 SIGHUP、SIGTERM、SIGINT，收到就退
  if (process.env.OPENSUPERBOT_DESKTOP_TEST === '1') {
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => {
      for (const command of chunk.split('\n').map((c) => c.trim())) {
        if (command === 'close') win?.close()
        else if (command === 'quit') void userQuit()
      }
    })
  }

  void app.whenReady().then(() => {
    say(`starting ${app.getVersion()} (Electron ${process.versions.electron}); data in ${layout.data}`)
    secureSession()
    registerDesktopApi(ipcMain, {
      gatewayOrigin: () => base(port),
      info: () => ({ version: app.getVersion(), platform: process.platform, electron: process.versions.electron ?? '' }),
      loginItem: loginItem(process.platform, app),
      log: (line) => say(line),
    })
    setMenu()
    createWindow()
    createTray()
    void pickPort().finally(() => {
      say(`gateway port ${port}`)
      supervisor.start()
    })
  })
}
