import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { CHANNELS, registerDesktopApi, trustedSender, type InvokeEvent } from '../src/ipc.js'
import { loginItem } from '../src/loginitem.js'

const GW = 'http://127.0.0.1:4747'
const top = (url: string): InvokeEvent => ({ senderFrame: { url, parent: null } })

describe('who may call the app', () => {
  it('only the gateway’s own page, at the top, not a frame inside it', () => {
    expect(trustedSender(top('http://127.0.0.1:4747/'), GW)).toBe(true)
    expect(trustedSender(top('http://localhost:4747/#thread=dm%3Achief'), GW)).toBe(true)
    expect(trustedSender({ senderFrame: { url: 'http://127.0.0.1:4747/vnc/chief/', parent: {} } }, GW)).toBe(false)
    expect(trustedSender(top('data:text/html,<p>starting</p>'), GW)).toBe(false)
    expect(trustedSender(top('http://127.0.0.1:4748/'), GW)).toBe(false)
    expect(trustedSender(top('https://example.com/'), GW)).toBe(false)
    expect(trustedSender({ senderFrame: null }, GW)).toBe(false)
  })
})

describe('the calls', () => {
  function setup() {
    const handlers = new Map<string, (e: InvokeEvent, ...args: unknown[]) => unknown>()
    const login = { get: vi.fn(() => ({ supported: true, enabled: false })), set: vi.fn((on: boolean) => ({ supported: true, enabled: on })) }
    const log = vi.fn()
    registerDesktopApi({ handle: (c, l) => { handlers.set(c, l) } }, {
      gatewayOrigin: () => GW, info: () => ({ version: '0.6.0', platform: 'darwin', electron: '44.9.3' }), loginItem: login, log,
    })
    const call = (c: string, e: InvokeEvent, ...args: unknown[]) => handlers.get(c)!(e, ...args)
    return { handlers, login, log, call }
  }

  it('answers the gateway page', () => {
    const s = setup()
    expect([...s.handlers.keys()].sort()).toEqual(Object.values(CHANNELS).sort())
    expect(s.call(CHANNELS.info, top(`${GW}/`))).toEqual({ version: '0.6.0', platform: 'darwin', electron: '44.9.3' })
    expect(s.call(CHANNELS.loginItemSet, top(`${GW}/`), true)).toEqual({ supported: true, enabled: true })
    expect(s.login.set).toHaveBeenCalledWith(true)
  })

  it('refuses anyone else, and says so in the log', () => {
    const s = setup()
    expect(() => s.call(CHANNELS.loginItemSet, top('data:text/html,x'), true)).toThrow('not allowed')
    expect(s.login.set).not.toHaveBeenCalled()
    expect(s.log).toHaveBeenCalledWith('refused desktop:login-item:set from data:text/html,x')
  })

  it('turns start-at-login on only for a real true, and off only for a real false', () => {
    const s = setup()
    for (const odd of ['true', 1, 'yes', null, undefined, {}]) {
      expect(() => s.call(CHANNELS.loginItemSet, top(`${GW}/`), odd)).toThrow('expected true or false')
    }
    expect(s.login.set).not.toHaveBeenCalled()
  })

  it('the preload asks for exactly these channels and exposes nothing else', () => {
    const preload = readFileSync(new URL('../src/preload.cts', import.meta.url), 'utf8')
    for (const channel of Object.values(CHANNELS)) expect(preload).toContain(`'${channel}'`)
    expect(preload.match(/ipcRenderer\.(\w+)/g)).toEqual(['ipcRenderer.invoke', 'ipcRenderer.invoke', 'ipcRenderer.invoke'])
    expect(preload).toContain("exposeInMainWorld('opensuperbot'")
    // 除了 import 那一行，ipcRenderer 只出现在 .invoke 前：不把它整个交给页面，也不用 send / on
    const code = preload.replace(/^import .*$/m, '')
    expect(code).not.toMatch(/ipcRenderer\s*[,)}]|\.send\(|\.on\(/)
  })
})

describe('start at login', () => {
  it('uses the system login items on macOS', () => {
    let on = false
    const api = { getLoginItemSettings: () => ({ openAtLogin: on }), setLoginItemSettings: (s: { openAtLogin: boolean }) => { on = s.openAtLogin } }
    const item = loginItem('darwin', api)
    expect(item.get()).toEqual({ supported: true, enabled: false })
    expect(item.set(true)).toEqual({ supported: true, enabled: true })
  })

  it('says it is not supported elsewhere for now, and changes nothing', () => {
    const api = { getLoginItemSettings: vi.fn(() => ({ openAtLogin: true })), setLoginItemSettings: vi.fn() }
    const item = loginItem('linux', api)
    expect(item.set(true)).toEqual({ supported: false, enabled: false })
    expect(api.setLoginItemSettings).not.toHaveBeenCalled()
  })
})
