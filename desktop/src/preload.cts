/**
 * 窄 preload：页面里只多一个 window.opensuperbot，冻住的、只有下面这几个函数。
 * 不暴露 ipcRenderer、不暴露 Node；主进程那边还会逐个验发送方是不是网关自己的顶层页（ipc.ts）。
 * 窗口开着 sandbox，所以这里是 CommonJS，只能用 contextBridge 和 ipcRenderer。
 * 频道名和 ipc.ts 的 CHANNELS 一致（这里不能 import ESM 模块，测试盯着两边对得上）。
 */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('opensuperbot', Object.freeze({
  /** App 版本、平台、Electron 版本 */
  info: () => ipcRenderer.invoke('desktop:info'),
  loginItem: Object.freeze({
    /** { supported, enabled } */
    get: () => ipcRenderer.invoke('desktop:login-item:get'),
    set: (enabled: boolean) => ipcRenderer.invoke('desktop:login-item:set', enabled === true),
  }),
}))
