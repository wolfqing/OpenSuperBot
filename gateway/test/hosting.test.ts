import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBrowser, type SpawnLike } from '../src/browsers.js'
import { appBundle, nodeScriptEnv, onShutdown, outsideAppEnv, reportReady, sandboxNode, type ParentPort, type Runtime } from '../src/hosting.js'
import { bubblewrapArgs, runSandboxed, sandboxEnv, sandboxSelfCheck, seatbeltProfile } from '../src/sandbox.js'

/** 装成 utilityProcess 的 parentPort：记下网关说的话，能替壳说话 */
function fakePort() {
  const sent: unknown[] = []
  const bus = new EventEmitter()
  const port: ParentPort = { postMessage: (m) => sent.push(m), on: (_e, l) => { bus.on('message', l) } }
  return { port, sent, say: (data: unknown) => bus.emit('message', { data }) }
}

const source: Runtime = { execPath: '/Users/op/.nvm/versions/node/v24.14.0/bin/node' }
const APP_EXEC = '/Applications/OpenSuperBot.app/Contents/Frameworks/OpenSuperBot Helper.app/Contents/MacOS/OpenSuperBot Helper'

describe('telling the desktop shell what is going on', () => {
  it('says ready with the port it really got, and says nothing when run from source', () => {
    const { port, sent } = fakePort()
    reportReady({ ...source, parentPort: port, electron: '44.9.0' }, 4748)
    expect(sent).toEqual([{ type: 'ready', port: 4748 }])
    expect(() => reportReady(source, 4747)).not.toThrow()
  })

  it('shuts down once, on a signal or the shell asking, then says stopped and exits', async () => {
    const { port, sent, say } = fakePort()
    const signals = new EventEmitter()
    const exit = vi.fn()
    let stops = 0
    const shutdown = onShutdown({ ...source, parentPort: port, electron: '44.9.0' }, async () => { stops++ }, {
      exit, signals: { on: (s, l) => signals.on(s, l) },
    })
    say({ type: 'stop' })
    signals.emit('SIGTERM')
    signals.emit('SIGINT')
    await shutdown()
    expect(stops).toBe(1)
    expect(sent).toEqual([{ type: 'stopped' }])
    expect(exit).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('exits anyway when cleaning up hangs, and ignores messages it does not know', async () => {
    const { port, say } = fakePort()
    const exit = vi.fn()
    const log = vi.fn()
    const shutdown = onShutdown({ ...source, parentPort: port }, () => new Promise(() => {}), {
      exit, log, timeoutMs: 20, signals: { on: () => {} },
    })
    say({ type: 'something-newer' })
    expect(exit).not.toHaveBeenCalled()
    await shutdown()
    expect(exit).toHaveBeenCalledWith(0)
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/longer than/))
  })

  it('from source, a signal still stops everything the way it always did', async () => {
    const signals = new EventEmitter()
    const exit = vi.fn()
    const stop = vi.fn(async () => {})
    onShutdown(source, stop, { exit, signals: { on: (s, l) => signals.on(s, l) } })
    signals.emit('SIGINT')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(stop).toHaveBeenCalledTimes(1)
  })
})

describe('child processes that run a Node script', () => {
  it('get ELECTRON_RUN_AS_NODE=1 inside Electron only', () => {
    expect(nodeScriptEnv({ ...source, electron: '44.9.0' }, { PATH: '/bin' })).toEqual({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' })
    expect(nodeScriptEnv(source, { PATH: '/bin' })).toEqual({ PATH: '/bin' })
  })

  it('the browser download uses the app itself as Node in Electron, and plain node from source', async () => {
    const calls: { file: string; env: NodeJS.ProcessEnv }[] = []
    const spawnImpl: SpawnLike = (file, _args, opts) => {
      calls.push({ file, env: opts.env })
      const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null })
      setTimeout(() => child.emit('exit', 1), 0)
      return child as unknown as ReturnType<SpawnLike>
    }
    const opts = { spawnImpl, cliPath: '/x/cli.js', exists: () => false, readdir: () => [] }
    await expect(installBrowser('/data/browsers', { ...opts, runtime: { execPath: APP_EXEC, electron: '44.9.0' } })).rejects.toThrow(/exit 1/)
    await expect(installBrowser('/data/browsers', { ...opts, runtime: source })).rejects.toThrow(/exit 1/)
    expect(calls[0]).toMatchObject({ file: APP_EXEC, env: { ELECTRON_RUN_AS_NODE: '1', PLAYWRIGHT_BROWSERS_PATH: '/data/browsers' } })
    expect(calls[1]!.file).toBe(source.execPath)
    expect(calls[1]!.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })
})

describe('programs the gateway opens outside the AppImage', () => {
  it('leaves the environment alone when not running from an AppImage', () => {
    const env = { PATH: '/usr/local/bin:/usr/bin', LD_LIBRARY_PATH: '/opt/cuda/lib', HOME: '/home/op' }
    expect(outsideAppEnv(env)).toEqual(env)
  })

  it('strips what AppRun put in, keeps what the operator already had, and never leaves an empty LD_LIBRARY_PATH', () => {
    const mount = '/tmp/.mount_OpenSuAbCd12'
    const appRun: NodeJS.ProcessEnv = {
      APPIMAGE: '/home/op/Apps/OpenSuperBot.AppImage',
      APPDIR: mount,
      ARGV0: './OpenSuperBot.AppImage',
      OWD: '/home/op/Downloads',
      PATH: `${mount}:${mount}/usr/sbin:/usr/local/bin:/usr/bin`,
      LD_LIBRARY_PATH: `${mount}/usr/lib`,
      GSETTINGS_SCHEMA_DIR: `${mount}/usr/share/glib-2.0/schemas`,
      XDG_DATA_DIRS: `${mount}/usr/share/:/usr/share/gnome:/usr/local/share/:/usr/share/`,
      PYTHONHOME: `${mount}/usr`,
      HOME: '/home/op',
      DISPLAY: ':0',
    }
    const clean = outsideAppEnv(appRun)
    expect(clean).toEqual({
      PATH: '/usr/local/bin:/usr/bin',
      XDG_DATA_DIRS: '/usr/share/gnome:/usr/local/share/:/usr/share/',
      HOME: '/home/op',
      DISPLAY: ':0',
    })
    expect('LD_LIBRARY_PATH' in clean).toBe(false)
    expect('GSETTINGS_SCHEMA_DIR' in clean).toBe(false)
    expect('APPDIR' in clean).toBe(false)
    expect('APPIMAGE' in clean).toBe(false)

    // 操作者自己本来就设了 LD_LIBRARY_PATH 的，只去掉挂载点那一段，原有的留着
    const withOwn = outsideAppEnv({ ...appRun, LD_LIBRARY_PATH: `${mount}/usr/lib:/opt/cuda/lib64` })
    expect(withOwn.LD_LIBRARY_PATH).toBe('/opt/cuda/lib64')
  })
})

describe('node for commands in the sandbox', () => {
  let dataDir: string
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'osb-host-')) })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  it('from source is the gateway’s own node, with nothing extra to open up', () => {
    expect(sandboxNode(source, dataDir)).toEqual({ nodeDir: dirname(source.execPath), readable: [] })
    expect(existsSync(join(dataDir, 'runtime'))).toBe(false)
  })

  it('in the app is a small `node` script in the data folder that runs the app as Node', () => {
    const got = sandboxNode({ execPath: APP_EXEC, electron: '44.9.0' }, dataDir)
    const shim = join(dataDir, 'runtime', 'bin', 'node')
    expect(got).toEqual({ nodeDir: join(dataDir, 'runtime', 'bin'), readable: [join(dataDir, 'runtime', 'bin'), '/Applications/OpenSuperBot.app'] })
    expect(readFileSync(shim, 'utf8')).toContain(`ELECTRON_RUN_AS_NODE=1 exec '${APP_EXEC}' "$@"`)
    // Windows 没有执行位（那里也没有命令行沙箱，不会用到这个小脚本）
    if (process.platform !== 'win32') expect(statSync(shim).mode & 0o111).toBe(0o111)
  })

  it('finds the app bundle, or the folder of the executable off macOS', () => {
    expect(appBundle(APP_EXEC)).toBe('/Applications/OpenSuperBot.app')
    expect(appBundle('/opt/OpenSuperBot/opensuperbot')).toBe('/opt/OpenSuperBot')
  })

  it.skipIf(process.platform === 'win32')('the script really runs Node with the flag set (stand-in: this node)', () => {
    sandboxNode({ execPath: process.execPath, electron: 'test' }, dataDir)
    const out = execFileSync(join(dataDir, 'runtime', 'bin', 'node'), ['-e', 'console.log(process.env.ELECTRON_RUN_AS_NODE, 6*7)']).toString()
    expect(out.trim()).toBe('1 42')
  })

  it('goes first on the sandbox PATH, and both sandboxes let commands read it', () => {
    const c = { workspace: '/data/workspaces/bob', tmp: '/data/bots/bob/tmp', dataDir: '/data', home: '/Users/op', exists: () => false }
    const node = { nodeDir: '/data/runtime/bin', readable: ['/data/runtime/bin', '/Users/op/Applications/OpenSuperBot.app'] }
    expect(sandboxEnv({ ...c, ...node }, {}).PATH).toMatch(/^\/data\/runtime\/bin:/)
    expect(sandboxEnv(c, {}, '/usr/local/bin').PATH).toMatch(/^\/usr\/local\/bin:/)
    const profile = seatbeltProfile({ ...c, ...node })
    expect(profile).toContain('(subpath "/data/runtime/bin")')
    expect(profile).toContain('(subpath "/Users/op/Applications/OpenSuperBot.app")')
    // 放行写在遮住家目录和数据目录之后，后写的赢
    expect(profile.indexOf('/data/runtime/bin')).toBeGreaterThan(profile.indexOf('(deny file-read*'))
    const args = bubblewrapArgs({ ...c, ...node })
    expect(args.join(' ')).toContain('--ro-bind /data/runtime/bin /data/runtime/bin')
    expect(args.indexOf('/data/runtime/bin')).toBeGreaterThan(args.indexOf('--tmpfs'))
  })
})

const realSeatbelt = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')
describe.skipIf(!realSeatbelt)('the app’s node inside a real Seatbelt sandbox (macOS only)', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'osb-host-sb-')) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('runs from the hidden data folder, while the token next to it stays unreadable', async () => {
    const dataDir = join(root, 'data')
    const node = sandboxNode({ execPath: process.execPath, electron: 'test' }, dataDir)
    const c = { workspace: join(dataDir, 'workspaces/bob'), tmp: join(dataDir, 'bots/bob/tmp'), dataDir, ...node }
    await sandboxSelfCheck({ kind: 'seatbelt', executable: '/usr/bin/sandbox-exec' }, c)
    const out = await runSandboxed('node -e "console.log(process.env.ELECTRON_RUN_AS_NODE, 6*7)"; command -v node', {
      sandbox: { kind: 'seatbelt', executable: '/usr/bin/sandbox-exec' }, confinement: c,
    })
    expect(out.stdout).toContain('1 42')
    expect(out.stdout).toContain(join('runtime', 'bin', 'node'))
    expect(await sandboxSelfCheck({ kind: 'seatbelt', executable: '/usr/bin/sandbox-exec' }, c)).toEqual({ ok: true })
  }, 60_000)
})
