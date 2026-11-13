// electron-builder 的 afterPack：每个平台/架构打好、签名之前跑一次。
//   - better-sqlite3 只留这个包的那一个预编译（stage 里留着 darwin/linux 的 arm64 和 x64）
//   - 去掉 Electron 自带的 default_app.asar（直接跑 Electron 时的欢迎页，App 用不上）
// 找不到对应的预编译就让打包失败：不然装上以后一启动网关就挂。
const { copyFileSync, existsSync, readdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')

/** builder-util 的 Arch 枚举 */
const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName
  const arch = ARCH[context.arch]
  const resources = platform === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  const prebuilds = join(resources, 'gateway', 'node_modules', 'better-sqlite3', 'prebuilds')
  const keep = `${platform}-${arch}.node`
  if (!existsSync(join(prebuilds, keep))) throw new Error(`no better-sqlite3 prebuild for ${platform}-${arch} in ${prebuilds}`)
  for (const f of readdirSync(prebuilds)) if (f !== keep) rmSync(join(prebuilds, f))
  rmSync(join(resources, 'default_app.asar'), { force: true })
  // Ubuntu 24.04+ 的 deb 安装脚本要给 /usr/bin/bwrap 也装一份 userns 规则（若系统里还没有）
  if (platform === 'linux') {
    copyFileSync(join(__dirname, '..', 'resources', 'apparmor-bwrap'), join(resources, 'apparmor-bwrap'))
  }
  console.log(`  • after-pack: ${platform}-${arch}: kept ${keep}, no default_app.asar`)
}
