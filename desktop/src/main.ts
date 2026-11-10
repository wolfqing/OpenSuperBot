import { existsSync, readFileSync } from 'node:fs'
import { homedir, release } from 'node:os'
import { join, sep } from 'node:path'
import { BrowserWindow, app, session, shell, utilityProcess } from 'electron'
import { diagnosticsText } from './diagnostics.js'
import { openLog } from './logfile.js'
import { dataUrl, errorPage, pageLang, startingPage } from './pages.js'
import { appLayout, resources } from './paths.js'
import { DEFAULT_PORT, choosePort, portInUse, probePort, readState, writeState } from './port.js'
import { SAFE_WEB_PREFERENCES, downloadPath, permissionAllowed, secureContents } from './security.js'
import { createSupervisor, type FailReason } from './supervisor.js'

/**
 * 桌面壳：拉起网关（utilityProcess）→ 等它说 ready → 种上会话 cookie → 窗口打开网关的界面。
 * 网关崩了按退避重启；起不来就停在错误页（重试、复制诊断信息、打开日志文件夹）。只允许开一个。
 * 窗口里只有网关的界面：导航、新窗口、权限、下载的规则见 security.ts。关窗常驻和托盘在 C5，端口被占换端口在 C4。
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
  let quitting = false
  let lastFailure: FailReason = 'exited'

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
      webPreferences: { ...SAFE_WEB_PREFERENCES },
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

  app.on('second-instance', () => {
    if (!win) return createWindow()
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })

  // 退出前先请网关收摊（停调度、关同事的电脑和本机 Chrome），收完再真退
  app.on('before-quit', (e) => {
    if (quitting) return
    e.preventDefault()
    quitting = true
    say('quitting: asking the gateway to stop')
    void supervisor.stop().finally(() => {
      say('gateway stopped; bye')
      // 在这次 before-quit 里直接再 quit 会被 Electron 当成同一次退出、什么都不做（网关早就不在时 stop 立刻就完）：
      // 挪到下一轮再 quit；万一还不退，3 秒后强退——该收的都收完了
      setImmediate(() => app.quit())
      setTimeout(() => app.exit(0), 3_000).unref()
    })
  })

  // 关窗常驻（C5）之前：关掉最后一个窗口就退出；macOS 照惯例留着，点 Dock 图标再开
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('activate', () => { if (!win) createWindow() })

  void app.whenReady().then(() => {
    say(`starting ${app.getVersion()} (Electron ${process.versions.electron}); data in ${layout.data}`)
    secureSession()
    createWindow()
    void pickPort().finally(() => {
      say(`gateway port ${port}`)
      supervisor.start()
    })
  })
}
