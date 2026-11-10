import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  SAFE_WEB_PREFERENCES, downloadPath, isGateway, navigationDecision, permissionAllowed, secureContents, toGatewayUrl, windowOpenDecision,
  type ContentsLike,
} from '../src/security.js'

const GW = 'http://127.0.0.1:4747'

describe('what counts as the gateway', () => {
  it('this port on a loopback name, over http', () => {
    expect(isGateway('http://127.0.0.1:4747/api/uploads/3', GW)).toBe(true)
    expect(isGateway('http://localhost:4747/', GW)).toBe(true)
    expect(isGateway('http://[::1]:4747/', GW)).toBe(true)
    expect(isGateway('http://127.0.0.1:4748/', GW)).toBe(false) // 另一个本机服务
    expect(isGateway('https://127.0.0.1:4747/', GW)).toBe(false)
    expect(isGateway('http://evil.example:4747/', GW)).toBe(false)
    expect(isGateway('http://127.0.0.1.evil.example:4747/', GW)).toBe(false)
    expect(isGateway('not a url', GW)).toBe(false)
  })

  it('pages opened in the app use the signed-in address', () => {
    expect(toGatewayUrl('http://localhost:4747/vnc/chief/?x=1#y', GW)).toBe('http://127.0.0.1:4747/vnc/chief/?x=1#y')
  })
})

describe('navigation in the window', () => {
  it('stays on the gateway, sends other sites to the browser, and blocks the rest', () => {
    expect(navigationDecision('http://127.0.0.1:4747/', GW)).toBe('allow')
    expect(navigationDecision('https://platform.deepseek.com/api_keys', GW)).toBe('external')
    expect(navigationDecision('osb:retry', GW)).toBe('action')
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'chrome://settings', 'smb://share', 'http://127.0.0.1:9222/json']) {
      expect([url, navigationDecision(url, GW)]).toEqual([url, url.startsWith('http://127.0.0.1:9222') ? 'external' : 'deny'])
    }
  })
})

describe('new windows', () => {
  it('opens the gateway’s own pages in the app, other sites in the browser, nothing else', () => {
    expect(windowOpenDecision('http://127.0.0.1:4747/api/uploads/7', GW)).toBe('in-app')
    expect(windowOpenDecision('https://example.com/', GW)).toBe('external')
    expect(windowOpenDecision('file:///Users/op/.ssh/id_ed25519', GW)).toBe('deny')
    expect(windowOpenDecision('vscode://file/x', GW)).toBe('deny')
  })
})

describe('permissions', () => {
  it('only notifications and writing the clipboard, only for the gateway', () => {
    expect(permissionAllowed('notifications', 'http://127.0.0.1:4747/', GW)).toBe(true)
    expect(permissionAllowed('clipboard-sanitized-write', GW, GW)).toBe(true)
    expect(permissionAllowed('notifications', 'https://example.com/', GW)).toBe(false)
    for (const p of ['media', 'geolocation', 'clipboard-read', 'openExternal', 'pointerLock', 'fullscreen', 'midi', 'hid', 'serial', 'usb']) {
      expect([p, permissionAllowed(p, GW, GW)]).toEqual([p, false])
    }
  })
})

describe('downloads', () => {
  it('never overwrite, and never escape the folder', () => {
    const taken = new Set(['/dl/report.pdf', '/dl/report (1).pdf'])
    expect(downloadPath('/dl', 'report.pdf', (p) => taken.has(p))).toBe('/dl/report (2).pdf')
    expect(downloadPath('/dl', '../../.ssh/authorized_keys', () => false)).toBe('/dl/_.._.ssh_authorized_keys')
    expect(downloadPath('/dl', '..\\..\\x.exe', () => false)).toBe('/dl/_.._x.exe')
    expect(downloadPath('/dl', '', () => false)).toBe('/dl/download')
    expect(downloadPath('/dl', '.bashrc', () => false)).toBe('/dl/bashrc')
    expect(downloadPath('C:\\dl', 'a.txt', () => false, '\\')).toBe('C:\\dl\\a.txt')
  })
})

describe('wiring the rules onto a page', () => {
  function fakeContents() {
    const bus = new EventEmitter()
    let handler: ((d: { url: string }) => unknown) | undefined
    const contents: ContentsLike = {
      on: ((event: string, l: (...a: unknown[]) => void) => bus.on(event, l)) as ContentsLike['on'],
      setWindowOpenHandler: (h) => { handler = h },
    }
    const navigate = (url: string) => { const e = { preventDefault: vi.fn() }; bus.emit('will-navigate', e, url); return e.preventDefault }
    return { contents, navigate, open: (url: string) => handler!({ url }), webview: () => { const e = { preventDefault: vi.fn() }; bus.emit('will-attach-webview', e); return e.preventDefault } }
  }

  it('lets the gateway through, hands sites to the browser, runs actions, and refuses webviews', () => {
    const f = fakeContents()
    const opts = { gatewayOrigin: () => GW, openExternal: vi.fn(), openInApp: vi.fn(), onAction: vi.fn(), log: vi.fn() }
    secureContents(f.contents, opts)
    expect(f.navigate('http://127.0.0.1:4747/')).not.toHaveBeenCalled()
    expect(f.navigate('https://example.com/a')).toHaveBeenCalled()
    expect(opts.openExternal).toHaveBeenCalledWith('https://example.com/a')
    expect(f.navigate('osb:logs')).toHaveBeenCalled()
    expect(opts.onAction).toHaveBeenCalledWith('osb:logs')
    expect(f.navigate('file:///etc/hosts')).toHaveBeenCalled()
    expect(opts.log).toHaveBeenCalledWith('blocked navigation to file:///etc/hosts')
    expect(f.webview()).toHaveBeenCalled()

    expect(f.open('http://localhost:4747/api/uploads/3')).toEqual({ action: 'deny' })
    expect(opts.openInApp).toHaveBeenCalledWith('http://127.0.0.1:4747/api/uploads/3')
    expect(f.open('https://example.com/b')).toEqual({ action: 'deny' })
    expect(opts.openExternal).toHaveBeenLastCalledWith('https://example.com/b')
    expect(f.open('file:///etc/passwd')).toEqual({ action: 'deny' })
    expect(opts.openExternal).toHaveBeenCalledTimes(2)
  })

  it('follows the gateway when its port changes', () => {
    let origin = GW
    const f = fakeContents()
    const opts = { gatewayOrigin: () => origin, openExternal: vi.fn(), openInApp: vi.fn(), onAction: vi.fn() }
    secureContents(f.contents, opts)
    origin = 'http://127.0.0.1:4748'
    expect(f.navigate('http://127.0.0.1:4748/')).not.toHaveBeenCalled()
    expect(f.navigate('http://127.0.0.1:4747/')).toHaveBeenCalled()
  })

  it('the safe settings keep pages away from Node', () => {
    expect(SAFE_WEB_PREFERENCES).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false })
  })
})
