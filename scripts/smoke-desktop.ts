// 打包产物端到端冒烟：Playwright 的 _electron 拉起真安装包 → 首次启动向导进演示模式 →
// 发带网址的消息（触发本机 Chrome 导航 + 截图）→ 收到回复 → 退出后确认网关收摊且不残留任何 Chrome 进程。
//
// 跑法：
//   pnpm run smoke:desktop [可执行文件或 .app 路径] [--real-data-dir]
import { execFileSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function resolvePackagedExecutable(opts: {
  explicit?: string
  cwd?: string
  repoDir?: string
  platform?: NodeJS.Platform
  arch?: string
} = {}): string {
  const repoDir = opts.repoDir ?? REPO_DIR
  const cwd = opts.cwd ?? process.env.INIT_CWD ?? process.cwd()
  const platform = opts.platform ?? process.platform
  const arch = opts.arch ?? process.arch

  if (opts.explicit) {
    const toBin = (p: string) =>
      platform === 'darwin' && p.endsWith('.app') ? join(p, 'Contents', 'MacOS', 'OpenSuperBot') : p
    const fromCwd = toBin(resolve(cwd, opts.explicit))
    if (existsSync(fromCwd) && !statSync(fromCwd).isDirectory()) return fromCwd
    const fromRepo = toBin(resolve(repoDir, opts.explicit))
    if (existsSync(fromRepo) && !statSync(fromRepo).isDirectory()) return fromRepo
    throw new Error(`Packaged executable not found at ${fromCwd}`)
  }

  const candidates = platform === 'darwin'
    ? [
        join(repoDir, 'desktop', 'release', arch === 'arm64' ? 'mac-arm64' : 'mac', 'OpenSuperBot.app', 'Contents', 'MacOS', 'OpenSuperBot'),
      ]
    : platform === 'linux'
      ? [
          join(repoDir, 'desktop', 'release', arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked', 'opensuperbot'),
          '/opt/OpenSuperBot/opensuperbot',
        ]
      : []

  for (const c of candidates) {
    if (existsSync(c) && !statSync(c).isDirectory()) return c
  }
  throw new Error(
    `No packaged OpenSuperBot binary found (${candidates.join(', ') || platform}). Build the app first (pnpm desktop:package) or pass its path.`,
  )
}

/** 和 desktop/src/paths.ts 一致的默认数据根目录（CI 新机器上用 --real-data-dir 测真实路径与 AppArmor 规则） */
export function defaultRealDataRoot(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: Record<string, string | undefined> = process.env,
): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'OpenSuperBot')
  if (platform === 'linux') {
    const xdg = env.XDG_DATA_HOME?.trim()
    const base = xdg && xdg.startsWith('/') ? xdg : join(home, '.local', 'share')
    return join(base, 'OpenSuperBot')
  }
  throw new Error(`Unsupported platform for --real-data-dir: ${platform}`)
}

export function prepareSmokeRoot(opts: {
  realDataDir: boolean
  platform?: NodeJS.Platform
  home?: string
  env?: Record<string, string | undefined>
}): { rootDir: string; useEnvOverride: boolean } {
  if (!opts.realDataDir) {
    return { rootDir: mkdtempSync(join(tmpdir(), 'osb-smoke-desktop-')), useEnvOverride: true }
  }
  const rootDir = defaultRealDataRoot(opts.platform, opts.home, opts.env)
  if (existsSync(rootDir)) {
    throw new Error(`Refusing --real-data-dir because ${rootDir} already exists`)
  }
  return { rootDir, useEnvOverride: false }
}

export type ProcessEntry = { pid: number; command: string }

/** 从 `ps -ax -o pid=,command=` 输出里筛出命令行含 needle 的进程（排除冒烟脚本自己） */
export function findProcessesInPs(psOutput: string, needle: string, selfPid: number = process.pid): ProcessEntry[] {
  const out: ProcessEntry[] = []
  for (const raw of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(raw)
    if (!m) continue
    const pid = Number(m[1])
    const command = m[2]!.trim()
    if (pid === selfPid) continue
    if (command.includes(needle)) out.push({ pid, command })
  }
  return out
}

function listProcessesUsing(needle: string): ProcessEntry[] {
  const ps = execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' })
  return findProcessesInPs(ps, needle, process.pid)
}

interface LocatorLike {
  first(): LocatorLike
  waitFor(opts?: { state?: 'visible' | 'attached'; timeout?: number }): Promise<void>
  click(): Promise<void>
  check(): Promise<void>
  fill(value: string): Promise<void>
  press(key: string): Promise<void>
}

interface PageLike {
  url(): string
  waitForURL(url: RegExp, opts?: { timeout?: number }): Promise<void>
  locator(selector: string): LocatorLike
  getByLabel(text: string | RegExp): LocatorLike
  getByRole(role: string, opts?: { name?: string | RegExp }): LocatorLike
  getByText(text: string | RegExp): LocatorLike
  evaluate<R>(fn: () => R | Promise<R>): Promise<R>
}

interface ElectronApplicationLike {
  firstWindow(): Promise<PageLike>
  process(): ChildProcess
  close(): Promise<void>
}

interface PlaywrightElectron {
  launch(opts: {
    executablePath: string
    chromiumSandbox?: boolean
    env?: Record<string, string>
  }): Promise<ElectronApplicationLike>
}

async function runSmoke() {
  const args = process.argv.slice(2)
  const realDataDir = args.includes('--real-data-dir')
  const positional = args.find((a) => !a.startsWith('--')) ?? process.env.OPENSUPERBOT_APP?.trim()
  const executablePath = resolvePackagedExecutable({ explicit: positional })
  const { rootDir, useEnvOverride } = prepareSmokeRoot({ realDataDir })

  const checks: { name: string; ok: boolean }[] = []
  const check = (name: string, ok: boolean, detail?: string) => {
    checks.push({ name, ok })
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  }

  // 本机 HTTP 小页：让演示模式的 stub 真正拉起 Chrome 跑完 browser_goto + browser_screenshot，不靠外网
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>Smoke Target</title><p>Packaged desktop smoke target.</p>')
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const targetPort = (server.address() as AddressInfo).port

  const reqGateway = createRequire(join(REPO_DIR, 'gateway', 'package.json'))
  const { _electron } = reqGateway('playwright-core') as { _electron: PlaywrightElectron }

  console.log(`· binary: ${executablePath}`)
  console.log(`· data root: ${rootDir}${realDataDir ? ' (real default path)' : ' (isolated temp)'}`)

  const cleanEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) cleanEnv[k] = v
  }
  if (useEnvOverride) cleanEnv.OPENSUPERBOT_DESKTOP_ROOT = rootDir
  else delete cleanEnv.OPENSUPERBOT_DESKTOP_ROOT
  cleanEnv.OPENSUPERBOT_DESKTOP_NO_EXTERNAL = '1'
  cleanEnv.OPENSUPERBOT_DESKTOP_DOWNLOADS = join(rootDir, 'downloads')
  cleanEnv.OPENSUPERBOT_COMPUTERS = 'local'

  let electronApp: ElectronApplicationLike | null = null
  try {
    // 显式开 chromiumSandbox: true——Playwright 在 Linux 上默认会偷偷塞 --no-sandbox，这会掩盖沙箱/AppArmor 问题
    electronApp = await _electron.launch({
      executablePath,
      chromiumSandbox: true,
      env: cleanEnv,
    })
    const proc = electronApp.process()

    const page = await electronApp.firstWindow()
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 45_000 })
    check('gateway ready and UI loaded in window', page.url().startsWith('http://127.0.0.1:'), page.url())

    const info = await page.evaluate(() =>
      (window as unknown as { opensuperbot?: { info(): Promise<{ version: string; platform: string; electron: string }> } })
        .opensuperbot?.info(),
    )
    check('preload exposes app version and Electron runtime', Boolean(info?.version && info?.electron), info ? `${info.version} (Electron ${info.electron})` : 'missing')

    await page.locator('.setup-card').waitFor({ state: 'visible', timeout: 15_000 })
    await page.getByLabel('English').check()
    await page.locator('button.setup-demo').click()

    await page.getByRole('heading', { name: /teammates. computer/i }).waitFor({ state: 'visible', timeout: 15_000 })
    if (process.env.SMOKE_EXPECT_SANDBOX === '1') {
      await page.getByText(/Available: teammates can run commands in a sandbox/).waitFor({ state: 'visible', timeout: 10_000 })
      check('command sandbox self-check passed', true)
    }
    await page.getByRole('button', { name: 'Continue' }).click()

    await page.getByRole('heading', { name: 'Demo mode is ready' }).waitFor({ state: 'visible', timeout: 15_000 })
    await page.getByRole('button', { name: 'Write my own' }).click()
    check('first-run wizard entered demo mode', true)

    const composer = page.locator('.composer-box textarea')
    await composer.waitFor({ state: 'visible', timeout: 15_000 })
    await composer.fill(`Open http://127.0.0.1:${targetPort}/ and check it.`)
    await composer.press('Enter')

    // 若机器上没装 Chrome（如 Linux arm64 CI），首次上网会自动下载 Chrome for Testing，留足超时；
    // 同一句话会同时出现在对话正文和侧栏预览里，取 .first() 免触发 Playwright strict mode
    await page.getByText('All filed. Ping me when you want the next pass.').first().waitFor({ state: 'visible', timeout: 180_000 })
    check('sent a message and received Chief’s reply after browsing', true)

    const browserProfile = join(rootDir, 'data', 'bots', 'chief', 'browser')
    const runningChrome = listProcessesUsing(browserProfile)
    check('Chief launched a real Chrome process for its profile', runningChrome.length > 0, `${runningChrome.length} process(es)`)

    await electronApp.close()
    electronApp = null
    check('app exited cleanly', proc.exitCode === 0, `exit=${proc.exitCode}`)

    let leftover = listProcessesUsing(rootDir)
    const deadline = Date.now() + 3_000
    while (leftover.length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150))
      leftover = listProcessesUsing(rootDir)
    }
    check(
      'no Chrome or gateway processes left behind after quit',
      leftover.length === 0,
      leftover.length ? leftover.map((p) => `${p.pid}:${p.command.slice(0, 80)}`).join('; ') : 'clean',
    )

    const logPath = join(rootDir, 'logs', 'gateway.log')
    const logText = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
    check('gateway.log recorded clean gateway shutdown', logText.includes('gateway stopped; bye'))

    if (checks.some((c) => !c.ok)) {
      if (logText) console.error('\n--- gateway.log tail ---\n' + logText.slice(-3_000))
      process.exitCode = 1
    }
  } catch (err) {
    const logPath = join(rootDir, 'logs', 'gateway.log')
    if (existsSync(logPath)) {
      console.error('\n--- gateway.log tail ---\n' + readFileSync(logPath, 'utf8').slice(-4_000))
    }
    throw err
  } finally {
    if (electronApp) await electronApp.close().catch(() => {})
    server.close()
    rmSync(rootDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runSmoke()
}
