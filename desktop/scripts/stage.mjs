// 打包前把 App 要带的东西摆进 desktop/stage/，electron-builder 再原样放进 Resources（asar 外面）：
//   stage/gateway/    网关：dist + 只含生产依赖的 node_modules（pnpm deploy --prod，hoisted，没有符号链接）
//   stage/web/dist/   内置界面
//   stage/teammates/  预置同事
// better-sqlite3 自带各平台的 N-API 预编译（不用对 Electron 重编），这里先删掉 SQLite 源码；
// 只留目标平台那一个 .node 是 after-pack.cjs 按架构做的（一份 stage 能出 arm64 和 x64 两个包）。
//
// 跑法（仓库根目录）：node desktop/scripts/stage.mjs [--no-build]
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = join(DESKTOP, '..')
const STAGE = join(DESKTOP, 'stage')
const say = (line) => console.log(`[stage] ${line}`)
const pnpm = (...args) => execFileSync('pnpm', args, { cwd: REPO, stdio: 'inherit' })

if (!process.argv.includes('--no-build')) {
  say('building web, gateway and desktop')
  pnpm('build')
  pnpm('--filter', '@opensuperbot/desktop', 'build')
}
for (const need of ['gateway/dist/main.js', 'web/dist/index.html', 'desktop/dist/main.js', 'desktop/dist/preload.cjs']) {
  if (!existsSync(join(REPO, need))) throw new Error(`${need} is missing; build first (or drop --no-build)`)
}

rmSync(STAGE, { recursive: true, force: true })
say('deploying the gateway with its production dependencies')
// 网关不依赖工作区里别的包，用 legacy deploy 就够（pnpm 10 的新 deploy 要开 inject-workspace-packages）
pnpm('--filter', '@opensuperbot/gateway', 'deploy', '--prod', '--legacy', '--config.node-linker=hoisted', join(STAGE, 'gateway'))
cpSync(join(REPO, 'web', 'dist'), join(STAGE, 'web', 'dist'), { recursive: true })
cpSync(join(REPO, 'teammates'), join(STAGE, 'teammates'), { recursive: true })

// 运行时用不到的：类型声明和 source map（@anthropic-ai/sdk 一家就占二十多 MB）；
// @types/node 是 protobufjs（dockerode → @grpc）写在 dependencies 里带进来的
const modules = join(STAGE, 'gateway', 'node_modules')
rmSync(join(modules, '@types'), { recursive: true, force: true })
// pnpm 的记账文件和 .bin 里的符号链接（网关不靠它们跑，符号链接还会给签名添乱）
for (const meta of ['.pnpm', '.modules.yaml']) rmSync(join(modules, meta), { recursive: true, force: true })
const dropBins = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const p = join(dir, entry.name)
    if (entry.name === '.bin') rmSync(p, { recursive: true, force: true })
    else dropBins(p)
  }
}
dropBins(modules)
const strip = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) strip(p)
    else if (/\.(d\.ts|d\.mts|d\.cts|map)$/.test(entry.name)) rmSync(p)
  }
}
strip(modules)

const sqlite = join(modules, 'better-sqlite3')
for (const junk of ['deps', 'src', 'build', 'binding.gyp']) rmSync(join(sqlite, junk), { recursive: true, force: true })
for (const f of readdirSync(join(sqlite, 'prebuilds'))) if (f.startsWith('linuxmusl-') || f.startsWith('win32-')) rmSync(join(sqlite, 'prebuilds', f))

// 网关运行时要找的几样：缺一样就别往下打包了
for (const need of [
  'gateway/dist/main.js', 'gateway/package.json',
  'gateway/node_modules/better-sqlite3/lib/index.js', 'gateway/node_modules/playwright-core/cli.js',
  'gateway/node_modules/unpdf/package.json', 'gateway/node_modules/@novnc/novnc/package.json', 'gateway/node_modules/hono/package.json',
  'web/dist/index.html', 'teammates/chief',
]) {
  if (!existsSync(join(STAGE, need))) throw new Error(`stage is missing ${need}`)
}
const links = []
const findLinks = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isSymbolicLink()) links.push(p); else if (e.isDirectory()) findLinks(p) } }
findLinks(STAGE)
if (links.length) throw new Error(`symbolic links left in stage: ${links.slice(0, 5).join(', ')}`)
for (const dev of ['typescript', 'vitest', 'tsx']) {
  if (existsSync(join(STAGE, 'gateway', 'node_modules', dev))) throw new Error(`a dev dependency slipped in: ${dev}`)
}
for (const notShipped of ['src', 'test', 'scripts']) {
  if (existsSync(join(STAGE, 'gateway', notShipped))) throw new Error(`gateway/${notShipped} should not ship (package.json "files")`)
}

const size = (dir) => readdirSync(dir).reduce((n, f) => {
  const p = join(dir, f)
  const s = statSync(p)
  return n + (s.isDirectory() ? size(p) : s.size)
}, 0)
for (const part of ['gateway', 'web', 'teammates']) say(`${relative(REPO, join(STAGE, part))}: ${(size(join(STAGE, part)) / 1048576).toFixed(1)} MB`)
say('done')
