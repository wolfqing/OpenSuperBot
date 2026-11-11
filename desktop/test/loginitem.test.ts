import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_LABEL, desktopEntry, execLine, launchAgent, loginItem, macBundle, type LoginItemApi } from '../src/loginitem.js'

const homes: string[] = []
const home = () => { const h = mkdtempSync(join(tmpdir(), 'osb-login-')); homes.push(h); return h }
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }) })

const APP = '/Applications/OpenSuperBot.app/Contents/MacOS/OpenSuperBot'

/** 系统登录项：takes = 登记得上；否则停在 status 上 */
function systemApi(takes: boolean, status = 'not-found') {
  let on = false
  const set = vi.fn((s: { openAtLogin: boolean }) => { if (takes) on = s.openAtLogin })
  const api = { set, getLoginItemSettings: () => ({ openAtLogin: on, status: on ? 'enabled' : status }), setLoginItemSettings: set }
  return api
}

describe('start at login on macOS', () => {
  it('uses the system login items when they take it, and is off to begin with', () => {
    const h = home()
    const api = systemApi(true)
    const item = loginItem({ platform: 'darwin', packaged: true, execPath: APP, home: h, env: {}, api })
    expect(item.get()).toEqual({ supported: true, enabled: false })
    expect(item.set(true)).toEqual({ supported: true, enabled: true })
    expect(existsSync(join(h, 'Library/LaunchAgents', `${AGENT_LABEL}.plist`))).toBe(false)
    expect(item.set(false)).toEqual({ supported: true, enabled: false })
  })

  it('falls back to a LaunchAgent when the system does not take it, and removes it when turned off', () => {
    const h = home()
    const log = vi.fn()
    const item = loginItem({ platform: 'darwin', packaged: true, execPath: APP, home: h, env: {}, api: systemApi(false), log })
    expect(item.set(true)).toEqual({ supported: true, enabled: true })
    const agent = join(h, 'Library/LaunchAgents', `${AGENT_LABEL}.plist`)
    expect(readFileSync(agent, 'utf8')).toContain('<string>/Applications/OpenSuperBot.app</string>')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not-found'))
    expect(item.set(false)).toEqual({ supported: true, enabled: false })
    expect(existsSync(agent)).toBe(false)
  })

  it('a system that throws is the same as one that does not take it', () => {
    const api: LoginItemApi = { getLoginItemSettings: () => { throw new Error('boom') }, setLoginItemSettings: () => { throw new Error('boom') } }
    const item = loginItem({ platform: 'darwin', packaged: true, execPath: APP, home: home(), env: {}, api })
    expect(item.set(true)).toEqual({ supported: true, enabled: true })
  })

  it('when the user turned it off in System Settings, says so and does not go around them', () => {
    const h = home()
    const item = loginItem({ platform: 'darwin', packaged: true, execPath: APP, home: h, env: {}, api: systemApi(false, 'requires-approval') })
    expect(item.set(true)).toEqual({ supported: true, enabled: false, why: 'needs_approval' })
    expect(existsSync(join(h, 'Library/LaunchAgents'))).toBe(false)
  })

  it('once the system takes it, a LaunchAgent left from before goes, so it does not open twice', () => {
    const h = home()
    const dir = join(h, 'Library/LaunchAgents')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${AGENT_LABEL}.plist`), launchAgent(APP))
    const item = loginItem({ platform: 'darwin', packaged: true, execPath: APP, home: h, env: {}, api: systemApi(true) })
    expect(item.get()).toEqual({ supported: true, enabled: true })
    expect(item.set(true)).toEqual({ supported: true, enabled: true })
    expect(existsSync(join(dir, `${AGENT_LABEL}.plist`))).toBe(false)
  })

  it('the LaunchAgent opens the bundle, escaped', () => {
    expect(macBundle(APP)).toBe('/Applications/OpenSuperBot.app')
    expect(macBundle('/usr/local/bin/opensuperbot')).toBeNull()
    const plist = launchAgent('/Users/a&b/Apps/OpenSuperBot.app/Contents/MacOS/OpenSuperBot')
    expect(plist).toContain('<string>/usr/bin/open</string>')
    expect(plist).toContain('<string>/Users/a&amp;b/Apps/OpenSuperBot.app</string>')
    expect(plist).toContain('<key>RunAtLoad</key><true/>')
    expect(plist).not.toContain('KeepAlive')
  })
})

describe('start at login on Linux', () => {
  it('writes an autostart entry under XDG_CONFIG_HOME, using the AppImage path', () => {
    const h = home()
    const config = join(h, 'cfg')
    const api = systemApi(true)
    const item = loginItem({ platform: 'linux', packaged: true, execPath: '/tmp/.mount_x/opensuperbot', home: h, env: { XDG_CONFIG_HOME: config, APPIMAGE: '/home/me/Apps/OpenSuperBot.AppImage' }, api })
    expect(item.get()).toEqual({ supported: true, enabled: false })
    expect(item.set(true)).toEqual({ supported: true, enabled: true })
    const text = readFileSync(join(config, 'autostart/opensuperbot.desktop'), 'utf8')
    expect(text).toContain('Exec="/home/me/Apps/OpenSuperBot.AppImage"')
    expect(text).toMatch(/^\[Desktop Entry\]\nType=Application\n/)
    expect(api.set).not.toHaveBeenCalled()
    expect(item.set(false)).toEqual({ supported: true, enabled: false })
    expect(existsSync(join(config, 'autostart/opensuperbot.desktop'))).toBe(false)
  })

  it('without XDG_CONFIG_HOME, ~/.config; an entry the desktop turned off counts as off', () => {
    const h = home()
    const item = loginItem({ platform: 'linux', packaged: true, execPath: '/opt/OpenSuperBot/opensuperbot', home: h, env: { XDG_CONFIG_HOME: 'relative/is/ignored' }, api: systemApi(true) })
    item.set(true)
    const file = join(h, '.config/autostart/opensuperbot.desktop')
    expect(readFileSync(file, 'utf8')).toContain('Exec="/opt/OpenSuperBot/opensuperbot"')
    writeFileSync(file, desktopEntry('/opt/OpenSuperBot/opensuperbot').replace('X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-enabled=false'))
    expect(item.get()).toEqual({ supported: true, enabled: false })
    writeFileSync(file, `${desktopEntry('/opt/x')}Hidden=true\n`)
    expect(item.get()).toEqual({ supported: true, enabled: false })
  })

  it('quotes the path the way the Desktop Entry spec wants', () => {
    expect(execLine('/opt/My Apps/osb')).toBe('"/opt/My Apps/osb"')
    expect(execLine('/opt/a$b"c`d\\e')).toBe('"/opt/a\\\\$b\\\\"c\\\\`d\\\\\\\\e"')
    expect(execLine('/opt/100%/osb')).toBe('"/opt/100%%/osb"')
    expect(() => execLine('/opt/a\nb')).toThrow()
  })
})

describe('where it is not offered', () => {
  it('run from source, or on a system we do not know, changes nothing', () => {
    for (const [platform, packaged, why] of [['darwin', false, 'unpackaged'], ['linux', false, 'unpackaged'], ['freebsd', true, 'platform']] as const) {
      const api = systemApi(true)
      const h = home()
      const item = loginItem({ platform, packaged, execPath: APP, home: h, env: {}, api })
      expect(item.set(true)).toEqual({ supported: false, enabled: false, why })
      expect(api.set).not.toHaveBeenCalled()
      expect(existsSync(join(h, 'Library'))).toBe(false)
      expect(existsSync(join(h, '.config'))).toBe(false)
    }
  })

  it('on Windows, the system login items', () => {
    const api = systemApi(true)
    const item = loginItem({ platform: 'win32', packaged: true, execPath: 'C:\\x\\OpenSuperBot.exe', home: home(), env: {}, api })
    expect(item.set(true)).toEqual({ supported: true, enabled: true })
    expect(api.set).toHaveBeenCalledWith({ openAtLogin: true })
  })
})
