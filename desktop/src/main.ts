import { readFileSync } from 'node:fs'
import { homedir, release } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, app, session, shell, utilityProcess } from 'electron'
import { diagnosticsText } from './diagnostics.js'
import { openLog } from './logfile.js'
import { dataUrl, errorPage, pageLang, startingPage } from './pages.js'
import { appLayout, resources } from './paths.js'
import { createSupervisor, type FailReason } from './supervisor.js'

/**
 * 桌面壳：拉起网关（utilityProcess）→ 等它说 ready → 种上会话 cookie → 窗口打开网关的界面。
 * 网关崩了按退避重启；起不来就停在错误页（重试、复制诊断信息、打开日志文件夹）。只允许开一个。
 * 窗口安全的细则（导航、新窗口、权限）在 C3，关窗常驻和托盘在 C5，端口被占换端口在 C4。
 */

const layout = appLayout({ platform: process.platform, home: homedir(), appData: app.getPath('appData'), env: process.env })
// Electron 自己的 cookie、缓存放进同一个根目录，卸载时删一个目录就干净；必须在 ready 之前设
app.setPath('userData', layout.session)

/** 网关的会话 cookie（gateway/src/auth.ts 的 SESSION_COOKIE） */
const SESSION_COOKIE = 'osb_session'
const PORT = 4747
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
  let port = PORT
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
        OPENSUPERBOT_PORT: String(PORT),
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
      say(`gateway ready on ${base(p)}`)
      void openGateway()
    },
    restarting: (attempt, delayMs) => say(`gateway crashed; restart #${attempt} in ${delayMs / 1000}s`),
    failed: (reason) => showError(reason),
  })

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
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    })
    // 错误页上的按钮：osb:retry、osb:logs。别的导航规则在 C3 收紧
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith('osb:')) return
      e.preventDefault()
      if (url === 'osb:retry') {
        showing = 'starting'
        void win?.loadURL(dataUrl(startingPage(lang())))
        supervisor.retry()
      } else if (url === 'osb:logs') {
        void shell.openPath(layout.logs)
      }
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
    createWindow()
    supervisor.start()
  })
}
