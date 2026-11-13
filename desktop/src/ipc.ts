import { isGateway } from './security.js'

/**
 * 页面能叫主进程做的事，只有这几样（preload.cts 里一一对应）：
 *   desktop:info            App 版本、平台、Electron 版本
 *   desktop:login-item:get  开机自启开着没有、这台机器支不支持
 *   desktop:login-item:set  开 / 关开机自启
 * 每次调用都验发送方：必须是网关自己的页（同端口、本机地址），而且是顶层页面——
 * 启动页、错误页（data:）、页里嵌的 iframe、别的网站一律拒。
 */
export const CHANNELS = {
  info: 'desktop:info',
  loginItemGet: 'desktop:login-item:get',
  loginItemSet: 'desktop:login-item:set',
} as const

export type DesktopInfo = { version: string; platform: string; electron: string }
/**
 * why：supported 为 false 时是 platform（这个系统不支持）或 unpackaged（源码跑的，没打包）；
 * needs_approval = macOS 上登记了，但被用户在「系统设置 → 通用 → 登录项」里关掉了，要去那里打开。
 */
export type LoginItemState = { supported: boolean; enabled: boolean; why?: 'platform' | 'unpackaged' | 'needs_approval' }

/** ipcMain.handle 的事件里用得到的那一点 */
export type InvokeEvent = { senderFrame: { url: string; parent: unknown } | null }
export type IpcMainLike = { handle(channel: string, listener: (e: InvokeEvent, ...args: unknown[]) => unknown): void }

export function trustedSender(e: InvokeEvent, gatewayOrigin: string): boolean {
  const frame = e.senderFrame
  return Boolean(frame && frame.parent === null && isGateway(frame.url, gatewayOrigin))
}

export function registerDesktopApi(ipc: IpcMainLike, opts: {
  gatewayOrigin: () => string
  info: () => DesktopInfo
  loginItem: { get(): LoginItemState; set(enabled: boolean): LoginItemState }
  log?: (line: string) => void
}): void {
  const guard = <A extends unknown[], R>(channel: string, run: (...args: A) => R) =>
    ipc.handle(channel, (e, ...args) => {
      if (!trustedSender(e, opts.gatewayOrigin())) {
        opts.log?.(`refused ${channel} from ${(e.senderFrame?.url ?? 'a closed frame').slice(0, 120)}`)
        throw new Error('not allowed')
      }
      return run(...(args as A))
    })
  guard(CHANNELS.info, () => opts.info())
  guard(CHANNELS.loginItemGet, () => opts.loginItem.get())
  guard(CHANNELS.loginItemSet, (enabled: unknown) => {
    // 只收真正的布尔：页面传什么怪东西都不当成「开」
    if (typeof enabled !== 'boolean') throw new Error('expected true or false')
    return opts.loginItem.set(enabled)
  })
}
