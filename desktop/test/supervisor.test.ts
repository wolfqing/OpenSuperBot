import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createSupervisor, type GatewayChild, type SupervisorEvents } from '../src/supervisor.js'

/** 假网关：能替它说 ready、退出、打日志；记下壳对它说的话 */
class FakeGateway extends EventEmitter implements GatewayChild {
  told: unknown[] = []
  killed = false
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  postMessage(m: unknown) { this.told.push(m) }
  kill() { this.killed = true; queueMicrotask(() => this.emit('exit', 9)); return true }
  ready(port = 4747) { this.emit('message', { type: 'ready', port }) }
  exit(code = 1) { this.emit('exit', code) }
}

/** 手摇的时钟和计时器：测试里决定什么时候「过了 30 秒」 */
function clock() {
  let t = 0
  const timers: { at: number; fn: () => void; off: boolean }[] = []
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const timer = { at: t + ms, fn, off: false }
      timers.push(timer)
      return () => { timer.off = true }
    },
    advance(ms: number) {
      t += ms
      for (const timer of timers.filter((x) => !x.off && x.at <= t)) { timer.off = true; timer.fn() }
    },
  }
}

function setup(opts: { readyTimeoutMs?: number } = {}) {
  const children: FakeGateway[] = []
  const c = clock()
  const events = { ready: vi.fn(), restarting: vi.fn(), failed: vi.fn(), line: vi.fn() } satisfies SupervisorEvents
  const sup = createSupervisor({
    fork: () => { const g = new FakeGateway(); children.push(g); return g },
    now: c.now, setTimer: c.setTimer, ...opts,
  }, events)
  return { sup, children, clock: c, events, last: () => children.at(-1)! }
}

describe('the gateway supervisor', () => {
  it('starts the gateway, waits for ready, and passes the port on', () => {
    const s = setup()
    s.sup.start()
    expect(s.sup.state()).toBe('starting')
    s.last().ready(4750)
    expect(s.events.ready).toHaveBeenCalledWith(4750)
    expect(s.sup.state()).toBe('running')
  })

  it('gives up after 30 seconds without ready, and kills what it started', () => {
    const s = setup()
    s.sup.start()
    s.clock.advance(29_999)
    expect(s.events.failed).not.toHaveBeenCalled()
    s.clock.advance(1)
    expect(s.events.failed).toHaveBeenCalledWith('timeout', 'no ready signal within 30s')
    expect(s.last().killed).toBe(true)
    expect(s.sup.state()).toBe('failed')
  })

  it('does not restart a gateway that never came up (a port in use, a broken install)', () => {
    const s = setup()
    s.sup.start()
    s.last().exit(1)
    expect(s.events.failed).toHaveBeenCalledWith('exited', 'exit code 1 before it was ready')
    expect(s.children).toHaveLength(1)
  })

  it('restarts a crash with growing waits, up to 3 times in 5 minutes, then stops on the error page', () => {
    const s = setup()
    s.sup.start()
    s.last().ready()
    for (const [attempt, wait] of [[1, 1_000], [2, 2_000], [3, 4_000]] as const) {
      s.last().exit(1)
      expect(s.events.restarting).toHaveBeenLastCalledWith(attempt, wait)
      s.clock.advance(wait)
      s.last().ready()
    }
    expect(s.children).toHaveLength(4)
    s.last().exit(1)
    expect(s.events.failed).toHaveBeenCalledWith('crashed', '4 crashes within 5 minutes')
    expect(s.children).toHaveLength(4)
  })

  it('forgets crashes older than 5 minutes', () => {
    const s = setup()
    s.sup.start()
    s.last().ready()
    for (let i = 0; i < 3; i++) {
      s.last().exit(1)
      s.clock.advance(4_000)
      s.last().ready()
    }
    s.clock.advance(5 * 60_000)
    s.last().exit(1)
    expect(s.events.failed).not.toHaveBeenCalled()
    expect(s.events.restarting).toHaveBeenLastCalledWith(1, 1_000)
  })

  it('retry from the error page starts over with a clean slate', () => {
    const s = setup()
    s.sup.start()
    s.last().exit(1)
    expect(s.sup.state()).toBe('failed')
    s.sup.retry()
    expect(s.children).toHaveLength(2)
    s.last().ready()
    expect(s.sup.state()).toBe('running')
  })

  it('asks the gateway to stop and waits for it; kills it if it hangs', async () => {
    const s = setup()
    s.sup.start()
    s.last().ready()
    const gw = s.last()
    const stopping = s.sup.stop()
    expect(gw.told).toEqual([{ type: 'stop' }])
    gw.exit(0)
    await stopping
    expect(gw.killed).toBe(false)
    expect(s.events.restarting).not.toHaveBeenCalled() // 收摊时退出不算崩

    const h = setup()
    h.sup.start()
    h.last().ready()
    const hanging = h.sup.stop()
    h.clock.advance(15_000)
    await hanging
    expect(h.last().killed).toBe(true)
    expect(h.sup.state()).toBe('stopped')
  })

  it('stopping while a restart is pending cancels it', async () => {
    const s = setup()
    s.sup.start()
    s.last().ready()
    s.last().exit(1)
    await s.sup.stop()
    s.clock.advance(10_000)
    expect(s.children).toHaveLength(1)
  })

  it('keeps the last lines of output for the error page, whole lines only', () => {
    const s = setup()
    s.sup.start()
    s.last().stdout.emit('data', '[gateway] database schema v0 → v7\n[gateway] liste')
    s.last().stderr.emit('data', 'Error: listen EADDRINUSE\n')
    s.last().stdout.emit('data', 'ning\n')
    expect(s.sup.tail()).toEqual(['[gateway] database schema v0 → v7', 'Error: listen EADDRINUSE', '[gateway] listening'])
    expect(s.events.line).toHaveBeenCalledWith('Error: listen EADDRINUSE')
  })

  it('tells this run’s output apart from earlier ones', () => {
    const s = setup()
    s.sup.start()
    s.last().stderr.emit('data', 'Error: listen EADDRINUSE\n')
    s.last().exit(1)
    s.sup.retry()
    s.last().stdout.emit('data', '[gateway] database schema v7\n')
    expect(s.sup.lastRun()).toEqual(['[gateway] database schema v7'])
    expect(s.sup.tail()).toContain('Error: listen EADDRINUSE')
  })

  it('ignores a late ready from a gateway it already gave up on', () => {
    const s = setup()
    s.sup.start()
    const slow = s.last()
    s.clock.advance(30_000)
    slow.ready()
    expect(s.events.ready).not.toHaveBeenCalled()
  })
})
