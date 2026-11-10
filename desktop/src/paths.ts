import { dirname, join } from 'node:path'

/**
 * App 的文件放哪。一个根目录，名字固定是 OpenSuperBot，不跟显示名走（以后换显示名，数据不搬）：
 *   data/     网关的数据（数据库、令牌、key、同事的文件夹、下载的浏览器）
 *   session/  窗口自己的东西（Electron 的 cookie、缓存）
 *   logs/     网关的输出
 * 卸载干净 = 删掉这一个目录。OPENSUPERBOT_DESKTOP_ROOT 可以整个换掉它（开发、测试用）。
 */
export const APP_DIR_NAME = 'OpenSuperBot'

export type Layout = { root: string; data: string; session: string; logs: string; logFile: string }

/**
 * macOS：~/Library/Application Support/OpenSuperBot（appData 就是 ~/Library/Application Support）。
 * Linux：$XDG_DATA_HOME/OpenSuperBot，默认 ~/.local/share——不放 ~/.config：那里该放设置，不该放几百 MB 的浏览器。
 * 其他平台（以后的 Windows）：appData 下。
 */
export function appLayout(opts: { platform: string; home: string; appData: string; env: Record<string, string | undefined> }): Layout {
  const base = opts.platform === 'linux'
    ? (opts.env.XDG_DATA_HOME?.trim() || join(opts.home, '.local', 'share'))
    : opts.appData
  // 开发和冒烟测试用：整个换到别处，不碰这台机器上真在用的那份
  const root = opts.env.OPENSUPERBOT_DESKTOP_ROOT?.trim() || join(base, APP_DIR_NAME)
  const logs = join(root, 'logs')
  return { root, data: join(root, 'data'), session: join(root, 'session'), logs, logFile: join(logs, 'gateway.log') }
}

export type Resources = { gatewayMain: string; webDist: string; teammates: string }

/**
 * 网关、前端、预置同事在哪。打包后在 Resources 里（网关放在 asar 外，原生模块和 playwright 要直接读文件）；
 * 开发时（`pnpm --filter @opensuperbot/desktop start`）就是仓库里构建好的那几个目录。
 */
export function resources(opts: { packaged: boolean; resourcesPath: string; appPath: string }): Resources {
  const root = opts.packaged ? opts.resourcesPath : dirname(opts.appPath)
  return {
    gatewayMain: join(root, 'gateway', 'dist', 'main.js'),
    webDist: join(root, 'web', 'dist'),
    teammates: join(root, 'teammates'),
  }
}
