import type { LoginItemState } from './ipc.js'

/**
 * 开机自启。macOS 用系统的登录项（app.setLoginItemSettings）；Linux 写 ~/.config/autostart 的那一步在 C7，
 * 到时候在这里接上。暂不支持的平台照实说 supported: false，界面上就不出那个开关。
 */
export type LoginItemApi = {
  getLoginItemSettings(): { openAtLogin: boolean }
  setLoginItemSettings(settings: { openAtLogin: boolean }): void
}

export function loginItem(platform: string, api: LoginItemApi): { get(): LoginItemState; set(enabled: boolean): LoginItemState } {
  if (platform !== 'darwin') {
    const none: LoginItemState = { supported: false, enabled: false }
    return { get: () => none, set: () => none }
  }
  const get = (): LoginItemState => ({ supported: true, enabled: api.getLoginItemSettings().openAtLogin })
  return {
    get,
    set(enabled) {
      api.setLoginItemSettings({ openAtLogin: enabled })
      return get()
    },
  }
}
