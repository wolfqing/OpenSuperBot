import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'

/**
 * 网关被桌面壳（Electron 的 utilityProcess）托管时要多做的几件事。源码版（pnpm dev / pnpm start）一样都不碰：
 * 没有 parentPort、也不在 Electron 里，这里的函数要么什么都不做，要么原样返回。
 *
 * - 起来以后告诉壳「好了，端口是几」（端口可能是壳换过的）；
 * - 壳说「停」就按顺序收摊（停调度 → 收电脑和本机 Chrome → 关数据库），收完回一声再退；
 * - 用 process.execPath 跑脚本的子进程（下载浏览器）在 Electron 里要带 ELECTRON_RUN_AS_NODE=1，
 *   不然 Helper 直接 exit 64；
 * - 沙箱里的命令行没有 `node`：Electron 的可执行文件不叫 node，就在数据目录里放一个同名小脚本转过去。
 */

/** utilityProcess 里才有的那一个口子；只用到这两样 */
export type ParentPort = {
  postMessage(message: unknown): void
  on(event: 'message', listener: (e: { data: unknown }) => void): void
}

export type Runtime = {
  parentPort?: ParentPort | undefined
  /** process.versions.electron：在 Electron 里才有 */
  electron?: string | undefined
  execPath: string
}

export function currentRuntime(): Runtime {
  return {
    parentPort: (process as unknown as { parentPort?: ParentPort }).parentPort,
    electron: process.versions.electron,
    execPath: process.execPath,
  }
}

/** 壳和网关之间的话：网关说 ready / stopped，壳说 stop */
export type HostMessage = { type: 'ready'; port: number } | { type: 'stopped' }

/** 起来了：有壳就告诉壳实际端口；没壳什么都不做 */
export function reportReady(rt: Runtime, port: number): void {
  rt.parentPort?.postMessage({ type: 'ready', port } satisfies HostMessage)
}

/**
 * 收摊：信号（SIGINT、SIGTERM）和壳的 stop 消息都走这一个。只跑一次；收完（或超时）才退出，
 * 有壳就先回一声 stopped。超时是兜底：某台电脑卡着收不掉，也不能让 App 退不出去。
 */
export function onShutdown(rt: Runtime, stop: () => Promise<void>, opts: {
  timeoutMs?: number
  exit?: (code: number) => void
  log?: (line: string) => void
  signals?: { on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown }
} = {}): () => Promise<void> {
  const exit = opts.exit ?? ((code: number) => process.exit(code))
  const timeoutMs = opts.timeoutMs ?? 10_000
  let running: Promise<void> | null = null
  const shutdown = () => {
    running ??= (async () => {
      let timer: NodeJS.Timeout | undefined
      const late = new Promise<'late'>((r) => { timer = setTimeout(() => r('late'), timeoutMs); timer.unref?.() })
      const outcome = await Promise.race([stop().then(() => 'done' as const, (err: unknown) => {
        opts.log?.(`shutdown hit an error: ${err instanceof Error ? err.message : String(err)}`)
        return 'done' as const
      }), late])
      clearTimeout(timer)
      if (outcome === 'late') opts.log?.(`shutdown took longer than ${timeoutMs / 1000}s; exiting anyway`)
      rt.parentPort?.postMessage({ type: 'stopped' } satisfies HostMessage)
      exit(0)
    })()
    return running
  }
  const signals = opts.signals ?? process
  for (const signal of ['SIGINT', 'SIGTERM'] as const) signals.on(signal, () => { void shutdown() })
  rt.parentPort?.on('message', (e) => {
    if ((e.data as { type?: unknown } | null)?.type === 'stop') void shutdown()
  })
  return shutdown
}

/** 用 execPath 跑 Node 脚本的子进程环境：在 Electron 里加 ELECTRON_RUN_AS_NODE=1，其余原样 */
export function nodeScriptEnv(rt: Runtime, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return rt.electron ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env
}

/** AppImage 的启动器（AppRun）往进程环境里塞的变量和路径：只该留给 Electron 自己，不能带给宿主上的浏览器等程序 */
const APPIMAGE_ONLY_VARS = [
  'APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', 'APPIMAGE_UUID', 'APPIMAGE_SILENT_INSTALL', 'APPIMAGE_EXIT_AFTER_INSTALL',
] as const
const APPIMAGE_PATH_VARS = [
  'LD_LIBRARY_PATH', 'LD_PRELOAD', 'PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR',
  'QT_PLUGIN_PATH', 'PERLLIB', 'PYTHONPATH', 'GST_PLUGIN_SYSTEM_PATH', 'GST_PLUGIN_SYSTEM_PATH_1_0',
] as const

/**
 * 跑在 AppImage 里时，去掉 AppRun 注入的挂载点变量与库路径（特别是 LD_LIBRARY_PATH 和 GSETTINGS_SCHEMA_DIR——
 * 带给宿主上的 Chrome 会让它加载到包里的旧系统库或找不到 GSettings schema 而崩掉；清空的变量必须删键，留空串会让 glibc 搜当前目录）。
 * 不在 AppImage 里时原样拷贝返回。
 */
export function outsideAppEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const rawDir = env.APPDIR?.trim()
  if (!rawDir) return { ...env }
  const appDir = rawDir.replace(/\/+$/, '') || '/'
  const inMount = (entry: string) => {
    const clean = entry.replace(/\/+$/, '')
    return clean === appDir || clean.startsWith(`${appDir}/`)
  }
  const out: NodeJS.ProcessEnv = { ...env }
  for (const key of APPIMAGE_ONLY_VARS) delete out[key]
  for (const key of APPIMAGE_PATH_VARS) {
    const val = out[key]
    if (val === undefined) continue
    const kept = val.split(':').filter((seg) => seg !== '' && !inMount(seg))
    if (kept.length) out[key] = kept.join(':')
    else delete out[key]
  }
  if (out.PYTHONHOME && inMount(out.PYTHONHOME)) delete out.PYTHONHOME
  return out
}

/**
 * 沙箱里命令行的 `node` 从哪来，以及沙箱要额外放行读哪些目录。
 * 源码版：网关这个 node 所在的目录（nvm 装的也找得到），不用额外放行。
 * Electron：在 <data>/runtime/bin 写一个叫 node 的小脚本，带上 ELECTRON_RUN_AS_NODE=1 转给 App 自己；
 * 数据目录在沙箱里是遮住的，所以要放行这个小目录和 App 包本身（App 装在家目录下时也一样能跑）。
 */
export function sandboxNode(rt: Runtime, dataDir: string): { nodeDir: string; readable: string[] } {
  if (!rt.electron) return { nodeDir: dirname(rt.execPath), readable: [] }
  const bin = join(dataDir, 'runtime', 'bin')
  const shim = join(bin, 'node')
  const body = `#!/bin/sh\n# OpenSuperBot: lets commands in a teammate's sandbox run \`node\` with the app's own runtime.\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(rt.execPath)} "$@"\n`
  mkdirSync(bin, { recursive: true })
  let current = ''
  try { current = readFileSync(shim, 'utf8') } catch { /* 还没写过 */ }
  // App 挪了位置（换了 execPath）就重写；内容一样就不动
  if (current !== body) writeFileSync(shim, body)
  chmodSync(shim, 0o755)
  return { nodeDir: bin, readable: [bin, appBundle(rt.execPath)] }
}

/**
 * macOS 上是最外层的 .app；别的平台是可执行文件所在的目录。
 * 只在有命令行沙箱的地方用（macOS、Linux），路径一律按 POSIX 拆——在 Windows 上跑测试也一样算
 */
export function appBundle(execPath: string): string {
  const parts = execPath.split('/')
  const at = parts.findIndex((p) => p.endsWith('.app'))
  return at > 0 ? parts.slice(0, at + 1).join('/') : posix.dirname(execPath)
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
