import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { LoginItemState } from './ipc.js'

/**
 * 开机自启，默认关，向导最后一步和设置页里开。
 *   macOS：先用系统的登录项（app.setLoginItemSettings，13 以上是 SMAppService）；登记不上（未签名、not-found、抛错）
 *          就退到 ~/Library/LaunchAgents/<id>.plist，登录时 `open` 一下 App。用户在系统设置里把它关了（requires-approval）
 *          就照实说，不拿 LaunchAgent 绕过去。
 *   Linux：写 $XDG_CONFIG_HOME/autostart/opensuperbot.desktop（默认 ~/.config），AppImage 用 $APPIMAGE（execPath 是临时挂载点）。
 *   Windows：系统的登录项（注册表 Run 键）。
 * 源码跑的（没打包）一律 supported: false——那时登记的是 node_modules 里的 Electron，登录时打开的是空壳。
 */
export const AGENT_LABEL = 'io.github.wolfqing.opensuperbot'
export const DESKTOP_FILE = 'opensuperbot.desktop'

export type LoginItemApi = {
  getLoginItemSettings(): { openAtLogin: boolean; status?: string }
  setLoginItemSettings(settings: { openAtLogin: boolean }): void
}

export type LoginItem = { get(): LoginItemState; set(enabled: boolean): LoginItemState }

export function loginItem(opts: {
  platform: string
  packaged: boolean
  execPath: string
  home: string
  env: Record<string, string | undefined>
  api: LoginItemApi
  log?: (line: string) => void
}): LoginItem {
  const fixed = (state: LoginItemState): LoginItem => ({ get: () => state, set: () => state })
  if (!['darwin', 'linux', 'win32'].includes(opts.platform)) return fixed({ supported: false, enabled: false, why: 'platform' })
  if (!opts.packaged) return fixed({ supported: false, enabled: false, why: 'unpackaged' })
  if (opts.platform === 'linux') return linux(opts)
  if (opts.platform === 'darwin') return mac(opts)
  return system(opts.api)
}

function system(api: LoginItemApi): LoginItem {
  const get = (): LoginItemState => ({ supported: true, enabled: api.getLoginItemSettings().openAtLogin })
  return { get, set(enabled) { api.setLoginItemSettings({ openAtLogin: enabled }); return get() } }
}

/** /Applications/OpenSuperBot.app/Contents/MacOS/OpenSuperBot → /Applications/OpenSuperBot.app */
export function macBundle(execPath: string): string | null {
  return /^(.+?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)?.[1] ?? null
}

const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)

export function launchAgent(execPath: string): string {
  const bundle = macBundle(execPath)
  const program = bundle ? ['/usr/bin/open', bundle] : [execPath]
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${AGENT_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...program.map((p) => `    <string>${xml(p)}</string>`),
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>LimitLoadToSessionType</key><string>Aqua</string>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

function mac(opts: { execPath: string; home: string; api: LoginItemApi; log?: (line: string) => void }): LoginItem {
  const dir = join(opts.home, 'Library', 'LaunchAgents')
  const agent = join(dir, `${AGENT_LABEL}.plist`)
  const sys = () => {
    try { return opts.api.getLoginItemSettings() } catch (err) {
      opts.log?.(`login item: reading the system setting failed: ${String(err)}`)
      return { openAtLogin: false, status: 'not-found' }
    }
  }
  const get = (): LoginItemState => {
    const s = sys()
    const enabled = s.openAtLogin || existsSync(agent)
    return enabled || s.status !== 'requires-approval' ? { supported: true, enabled } : { supported: true, enabled: false, why: 'needs_approval' }
  }
  return {
    get,
    set(enabled) {
      if (!enabled) {
        try { opts.api.setLoginItemSettings({ openAtLogin: false }) } catch (err) { opts.log?.(`login item: unregistering failed: ${String(err)}`) }
        rmSync(agent, { force: true })
        return get()
      }
      try { opts.api.setLoginItemSettings({ openAtLogin: true }) } catch (err) { opts.log?.(`login item: registering failed: ${String(err)}`) }
      const s = sys()
      if (s.openAtLogin) {
        rmSync(agent, { force: true }) // 系统的登上了，就别再留一份，免得登录时开两次
        return get()
      }
      if (s.status === 'requires-approval') return get() // 用户在系统设置里关的，尊重它
      opts.log?.(`login item: the system did not take it (${s.status ?? 'unknown'}); writing ${agent}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(agent, launchAgent(opts.execPath))
      return get()
    },
  }
}

/**
 * Desktop Entry 的 Exec：参数加双引号，引号里的 " ` $ \ 前面加反斜杠；整个值又是字符串，反斜杠再翻一倍；% 写成 %%。
 */
export function execLine(path: string): string {
  if (/[\n\r]/.test(path)) throw new Error('the app path has a line break in it')
  const quoted = `"${path.replace(/[\\"`$]/g, '\\$&')}"`
  return quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%')
}

export function desktopEntry(path: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=OpenSuperBot',
    'Comment=Your AI teammates, working on this computer',
    `Exec=${execLine(path)}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n')
}

function linux(opts: { execPath: string; home: string; env: Record<string, string | undefined> }): LoginItem {
  const xdg = opts.env.XDG_CONFIG_HOME
  const dir = join(xdg && isAbsolute(xdg) ? xdg : join(opts.home, '.config'), 'autostart')
  const file = join(dir, DESKTOP_FILE)
  const get = (): LoginItemState => {
    if (!existsSync(file)) return { supported: true, enabled: false }
    const text = readFileSync(file, 'utf8')
    return { supported: true, enabled: !/^Hidden\s*=\s*true\s*$/m.test(text) && !/^X-GNOME-Autostart-enabled\s*=\s*false\s*$/m.test(text) }
  }
  return {
    get,
    set(enabled) {
      if (enabled) {
        mkdirSync(dir, { recursive: true })
        writeFileSync(file, desktopEntry(opts.env.APPIMAGE || opts.execPath))
      } else {
        rmSync(file, { force: true })
      }
      return get()
    },
  }
}
