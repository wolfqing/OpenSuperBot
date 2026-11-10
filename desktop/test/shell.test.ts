import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { diagnosticsText, redact } from '../src/diagnostics.js'
import { openLog } from '../src/logfile.js'
import { dataUrl, errorPage, pageLang, startingPage } from '../src/pages.js'
import { appLayout, resources } from '../src/paths.js'

describe('where the app keeps its files', () => {
  it('one folder per machine, with a fixed name, split into data, session and logs', () => {
    const mac = appLayout({ platform: 'darwin', home: '/Users/op', appData: '/Users/op/Library/Application Support', env: {} })
    expect(mac).toEqual({
      root: join('/Users/op/Library/Application Support', 'OpenSuperBot'),
      data: join('/Users/op/Library/Application Support', 'OpenSuperBot', 'data'),
      session: join('/Users/op/Library/Application Support', 'OpenSuperBot', 'session'),
      logs: join('/Users/op/Library/Application Support', 'OpenSuperBot', 'logs'),
      logFile: join('/Users/op/Library/Application Support', 'OpenSuperBot', 'logs', 'gateway.log'),
    })
  })

  it('can be moved wholesale for development and tests', () => {
    expect(appLayout({ platform: 'darwin', home: '/Users/op', appData: '/x', env: { OPENSUPERBOT_DESKTOP_ROOT: '/tmp/osb' } }).data).toBe(join('/tmp/osb', 'data'))
  })

  it('on Linux under XDG_DATA_HOME, or ~/.local/share, never ~/.config', () => {
    expect(appLayout({ platform: 'linux', home: '/home/op', appData: '/home/op/.config', env: {} }).root).toBe(join('/home/op/.local/share', 'OpenSuperBot'))
    expect(appLayout({ platform: 'linux', home: '/home/op', appData: '/home/op/.config', env: { XDG_DATA_HOME: '/data/xdg' } }).root).toBe(join('/data/xdg', 'OpenSuperBot'))
  })

  it('finds the gateway, the UI and the teammates in the app, or in the repo while developing', () => {
    expect(resources({ packaged: true, resourcesPath: '/A.app/Contents/Resources', appPath: '/A.app/Contents/Resources/app.asar' })).toEqual({
      gatewayMain: join('/A.app/Contents/Resources', 'gateway', 'dist', 'main.js'),
      webDist: join('/A.app/Contents/Resources', 'web', 'dist'),
      teammates: join('/A.app/Contents/Resources', 'teammates'),
    })
    expect(resources({ packaged: false, resourcesPath: '/x', appPath: '/repo/desktop' }).gatewayMain).toBe(join('/repo', 'gateway', 'dist', 'main.js'))
  })
})

describe('diagnostics', () => {
  it('say what happened and on what, with the last log lines', () => {
    const text = diagnosticsText({
      appVersion: '0.6.0', electron: '44.9.3', platform: 'darwin', arch: 'arm64', osVersion: '25.5.0',
      dataDir: '/d', logFile: '/d/logs/gateway.log', port: 4747, reason: 'exited', tail: ['[gateway] boom', 'Error: listen EADDRINUSE'],
    })
    expect(text).toContain('OpenSuperBot 0.6.0 (Electron 44.9.3, darwin arm64, 25.5.0)')
    expect(text).toContain('What happened: exited')
    expect(text).toContain('Last 2 log lines:\n[gateway] boom\nError: listen EADDRINUSE')
  })

  it('never carry a token or a key, even if one slipped into the log', () => {
    expect(redact('sign in → http://localhost:4747/auth?token=QUjeMVcy57TpC5D4Zwl7gh')).toBe('sign in → http://localhost:4747/auth?token=<hidden>')
    expect(redact('Authorization: Bearer abcdefghijklmnop')).toBe('Authorization: Bearer <hidden>')
    expect(redact('key sk-live-abcdef123456 rejected')).toBe('key sk-live…<hidden> rejected')
    expect(redact('key xai-abcdefghijklmnop')).toBe('key xai-abcd…<hidden>')
  })
})

describe('the pages shown before the UI is up', () => {
  it('speak the system language', () => {
    expect(pageLang('zh-CN')).toBe('zh-CN')
    expect(pageLang('zh-TW')).toBe('zh-CN')
    expect(pageLang('en-GB')).toBe('en')
    expect(startingPage('zh-CN')).toContain('正在启动 OpenSuperBot')
  })

  it('the error page says why, offers retry, copy and the logs, and escapes the log', () => {
    const html = errorPage('en', 'crashed', 'diag <script>alert(1)</script>', ['a', 'b'])
    expect(html).toContain('stopped unexpectedly several times')
    expect(html).toContain('href="osb:retry"')
    expect(html).toContain('href="osb:logs"')
    expect(html).toContain('Copy diagnostics')
    expect(html).toContain('diag &lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert(1)')
    expect(html).toContain("default-src 'none'")
    expect(dataUrl('<p>x</p>')).toBe('data:text/html;charset=utf-8,%3Cp%3Ex%3C%2Fp%3E')
  })
})

describe('the log file', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'osb-log-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('appends timestamped lines and keeps one old file when it gets too big', () => {
    const file = join(dir, 'logs', 'gateway.log')
    const log = openLog(file, { maxBytes: 100, now: () => new Date('2026-11-09T12:00:00Z') })
    log.write('[gateway] one')
    expect(readFileSync(file, 'utf8')).toBe('2026-11-09T12:00:00.000Z [gateway] one\n')
    log.write('x'.repeat(80))
    expect(readFileSync(`${file}.1`, 'utf8')).toContain('[gateway] one')
    expect(readFileSync(file, 'utf8')).toContain('xxxx')
  })

  it('rotates an old oversized file on start', () => {
    const file = join(dir, 'gateway.log')
    writeFileSync(file, 'y'.repeat(200))
    openLog(file, { maxBytes: 100 }).write('fresh')
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('y'.repeat(200))
    expect(readFileSync(file, 'utf8')).toMatch(/fresh\n$/)
  })
})
