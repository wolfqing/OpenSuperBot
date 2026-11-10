import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { dirname, join } from 'node:path'

/**
 * 网关听哪个端口。默认 4747；被占了（比如源码版网关正开着）就往后找一个空的，**记住它**，下次还用它——
 * webhook 地址和隧道都认端口，不能每次随机。记住的端口后来被别人占了，才再换（并记住新的）。
 * OPENSUPERBOT_PORT 指定了就只用它，不换（开发时自己说了算）。
 */
export const DEFAULT_PORT = 4747
/** 从默认端口往后找多少个 */
const SPAN = 20

/** true = 这个端口能用 */
export type Probe = (port: number) => Promise<boolean>

/**
 * 能用 = 本机没有谁在这个端口上应答，而且我们绑得上 127.0.0.1。只试绑不够：别人绑在 0.0.0.0 或 :: 上时，
 * macOS 照样让你绑 127.0.0.1，结果本机的请求被我们截走、那边的服务无声无息地失灵。
 */
export const probePort: Probe = async (port) => !(await answers(port)) && (await canBind(port))

function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    const done = (v: boolean) => { clearTimeout(timer); socket.destroy(); resolve(v) }
    const timer = setTimeout(() => done(false), 500)
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(true)))
  })
}

/** 先试想要的那个，再从默认端口往后找；都不行回 null */
export async function choosePort(opts: { preferred: number; probe: Probe; avoid?: number[] }): Promise<number | null> {
  const avoid = new Set(opts.avoid ?? [])
  const candidates = [opts.preferred, ...Array.from({ length: SPAN }, (_, i) => DEFAULT_PORT + i)]
  const tried = new Set<number>()
  for (const port of candidates) {
    if (tried.has(port) || avoid.has(port)) continue
    tried.add(port)
    if (await opts.probe(port)) return port
  }
  return null
}

/** 网关起不来是因为端口被占（探测时还空着，刚好被别人抢了） */
export const portInUse = (tail: string[]) => tail.some((line) => /EADDRINUSE/.test(line))

/** 桌面壳自己记的小事（眼下只有端口），放在根目录的 desktop.json */
export type DesktopState = { port?: number }

const stateFile = (root: string) => join(root, 'desktop.json')

export function readState(root: string): DesktopState {
  try {
    const raw = JSON.parse(readFileSync(stateFile(root), 'utf8')) as { port?: unknown }
    const port = Number(raw.port)
    return Number.isInteger(port) && port > 0 && port < 65536 ? { port } : {}
  } catch {
    return {} // 没有、或者坏了：当没记过
  }
}

export function writeState(root: string, state: DesktopState): void {
  const file = stateFile(root)
  mkdirSync(dirname(file), { recursive: true })
  // 先写临时文件再改名：写到一半断电也不会留下半个 JSON
  writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(`${file}.tmp`, file)
}
