/**
 * 桌面版的 preload 在页面上放了一个 window.opensuperbot（desktop/src/preload.cts）；浏览器里打开就没有。
 * 只有这几样，主进程还会验调用方是不是网关自己的页。
 */
export type DesktopInfo = { version: string; platform: string; electron: string }
/** why：不支持的原因（platform / unpackaged），或 macOS 上被用户在系统设置里关了（needs_approval） */
export type LoginItemState = { supported: boolean; enabled: boolean; why?: 'platform' | 'unpackaged' | 'needs_approval' }
export type DesktopApi = {
  info(): Promise<DesktopInfo>
  loginItem: { get(): Promise<LoginItemState>; set(enabled: boolean): Promise<LoginItemState> }
}

export const desktopApi = (): DesktopApi | null => (window as unknown as { opensuperbot?: DesktopApi }).opensuperbot ?? null
