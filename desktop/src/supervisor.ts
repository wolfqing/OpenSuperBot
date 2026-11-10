/**
 * 看着网关这个子进程：拉起来、等它说 ready、崩了按退避重启、实在不行就停下等人看错误页、退出时让它按顺序收摊。
 * 不碰 Electron：子进程怎么起（utilityProcess.fork）、计时器、时钟都从外面传进来，测试里换成假的。
 */

/** utilityProcess 子进程里用得到的那几样 */
export type GatewayChild = {
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  postMessage(message: unknown): void
  kill(): boolean
  stdout?: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null
  stderr?: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null
}

/** 停下来的原因：没在时限内起来、起的时候就退了、跑着跑着反复崩 */
export type FailReason = 'timeout' | 'exited' | 'crashed'

export type SupervisorEvents = {
  /** 起来了（每次重启后起来也算）；port 是网关实际在听的 */
  ready(port: number): void
  /** 崩了，attempt 秒后再拉（第几次重启） */
  restarting(attempt: number, delayMs: number): void
  /** 放弃了：停在错误页，等人点「重试」 */
  failed(reason: FailReason, detail: string): void
  /** 网关的每一行输出（写日志文件用） */
  line?(text: string): void
}

export type SupervisorOptions = {
  fork: () => GatewayChild
  readyTimeoutMs?: number
  /** 时间窗内最多重启几次；第几次崩超过它就放弃 */
  maxRestarts?: number
  windowMs?: number
  /** 第 n 次重启前等多久 */
  backoffMs?: (attempt: number) => number
  stopTimeoutMs?: number
  /** 错误页上显示多少行日志 */
  tailLines?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => () => void
}

type State = 'idle' | 'starting' | 'running' | 'waiting' | 'failed' | 'stopping' | 'stopped'

export type Supervisor = {
  start(): void
  /** 错误页上的「重试」：清掉崩溃记录，从头来 */
  retry(): void
  /** 退出 App 时：请网关收摊，等它退（超时就强杀） */
  stop(): Promise<void>
  tail(): string[]
  /** 最近这一次拉起以来的输出（判断这次为什么没起来，不被上一次的报错干扰） */
  lastRun(): string[]
  state(): State
}

const defaultTimer = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}

export function createSupervisor(opts: SupervisorOptions, events: SupervisorEvents): Supervisor {
  const readyTimeoutMs = opts.readyTimeoutMs ?? 30_000
  const maxRestarts = opts.maxRestarts ?? 3
  const windowMs = opts.windowMs ?? 5 * 60_000
  const backoffMs = opts.backoffMs ?? ((n: number) => 1_000 * 2 ** (n - 1))
  const stopTimeoutMs = opts.stopTimeoutMs ?? 15_000
  const tailLines = opts.tailLines ?? 80
  const now = opts.now ?? Date.now
  const setTimer = opts.setTimer ?? defaultTimer

  let state: State = 'idle'
  let child: GatewayChild | null = null
  let everReady = false
  let crashes: number[] = []
  let cancelTimer: (() => void) | null = null
  let exited: Promise<number> | null = null
  const tail: string[] = []
  let thisRun: string[] = []

  const clearTimer = () => { cancelTimer?.(); cancelTimer = null }
  const record = (text: string) => {
    thisRun.push(text)
    if (thisRun.length > tailLines) thisRun.splice(0, thisRun.length - tailLines)
    tail.push(text)
    if (tail.length > tailLines) tail.splice(0, tail.length - tailLines)
    events.line?.(text)
  }
  const fail = (reason: FailReason, detail: string) => {
    clearTimer()
    state = 'failed'
    record(`[desktop] gave up: ${reason} (${detail})`)
    events.failed(reason, detail)
  }

  const launch = () => {
    clearTimer()
    state = 'starting'
    thisRun = []
    const c = opts.fork()
    child = c
    // stdout 和 stderr 各自攒半行：两路交错着来，也不会拼成一行
    const partial = { out: '', err: '' }
    const split = (from: 'out' | 'err') => (chunk: unknown) => {
      const lines = (partial[from] + String(chunk)).split(/\r?\n/)
      partial[from] = lines.pop() ?? ''
      for (const l of lines) if (l.trim()) record(l)
    }
    c.stdout?.on('data', split('out'))
    c.stderr?.on('data', split('err'))
    exited = new Promise((resolve) => c.on('exit', (code) => {
      for (const from of ['out', 'err'] as const) {
        if (partial[from].trim()) record(partial[from])
        partial[from] = ''
      }
      resolve(code)
      if (child === c) onExit(code)
    }))
    c.on('message', (m) => {
      const msg = m as { type?: unknown; port?: unknown } | null
      if (child !== c || msg?.type !== 'ready' || typeof msg.port !== 'number') return
      clearTimer()
      state = 'running'
      everReady = true
      events.ready(msg.port)
    })
    cancelTimer = setTimer(() => {
      if (child !== c || state !== 'starting') return
      child = null
      c.kill()
      fail('timeout', `no ready signal within ${readyTimeoutMs / 1000}s`)
    }, readyTimeoutMs)
  }

  const onExit = (code: number) => {
    child = null
    if (state === 'stopping' || state === 'stopped' || state === 'failed') return
    record(`[desktop] gateway exited with code ${code}`)
    // 一次都没起来过：多半是配置或端口的问题，重启也一样，直接给人看
    if (!everReady) return fail('exited', `exit code ${code} before it was ready`)
    const t = now()
    crashes = [...crashes.filter((at) => t - at < windowMs), t]
    if (crashes.length > maxRestarts) return fail('crashed', `${crashes.length} crashes within ${Math.round(windowMs / 60_000)} minutes`)
    const delay = backoffMs(crashes.length)
    state = 'waiting'
    events.restarting(crashes.length, delay)
    cancelTimer = setTimer(launch, delay)
  }

  return {
    start() {
      if (state === 'idle') launch()
    },
    retry() {
      if (state !== 'failed') return
      crashes = []
      everReady = false
      launch()
    },
    async stop() {
      if (state === 'stopped') return
      clearTimer()
      const c = child
      state = 'stopping'
      if (c && exited) {
        c.postMessage({ type: 'stop' })
        let cancel: () => void = () => {}
        const late = new Promise<'late'>((resolve) => { cancel = setTimer(() => resolve('late'), stopTimeoutMs) })
        const outcome = await Promise.race([exited, late])
        cancel()
        if (outcome === 'late') {
          record(`[desktop] gateway did not stop within ${stopTimeoutMs / 1000}s; killing it`)
          c.kill()
        }
      }
      child = null
      state = 'stopped'
    },
    tail: () => [...tail],
    lastRun: () => [...thisRun],
    state: () => state,
  }
}
