import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PORT, choosePort, portInUse, probePort, readState, writeState } from '../src/port.js'

const freeExcept = (...busy: number[]) => async (port: number) => !busy.includes(port)

describe('choosing the gateway port', () => {
  it('keeps the remembered port while it is free', async () => {
    expect(await choosePort({ preferred: 4751, probe: freeExcept() })).toBe(4751)
    expect(await choosePort({ preferred: DEFAULT_PORT, probe: freeExcept() })).toBe(4747)
  })

  it('moves to the next free one from 4747 when it is taken', async () => {
    expect(await choosePort({ preferred: 4747, probe: freeExcept(4747) })).toBe(4748)
    expect(await choosePort({ preferred: 4751, probe: freeExcept(4751, 4747, 4748) })).toBe(4749)
  })

  it('skips a port that just proved unusable, and gives up after twenty', async () => {
    expect(await choosePort({ preferred: 4747, probe: freeExcept(), avoid: [4747] })).toBe(4748)
    expect(await choosePort({ preferred: 4747, probe: async () => false })).toBeNull()
  })

  it('knows a start that failed on a taken port', () => {
    expect(portInUse(['[gateway] bot computers: local', 'Error: listen EADDRINUSE: address already in use 127.0.0.1:4747'])).toBe(true)
    expect(portInUse(['Error: Cannot find module better-sqlite3'])).toBe(false)
  })
})

describe('probing a port for real', () => {
  const servers: net.Server[] = []
  afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r)))) })
  const occupy = (host: string) => new Promise<number>((resolve) => {
    const s = net.createServer().listen({ port: 0, host }, () => resolve((s.address() as net.AddressInfo).port))
    servers.push(s)
  })

  it('calls a port taken whether the other side listens on 127.0.0.1 or on every address', async () => {
    expect(await probePort(await occupy('127.0.0.1'))).toBe(false)
    expect(await probePort(await occupy('0.0.0.0'))).toBe(false)
  })

  it('calls a port free when nothing is there', async () => {
    const port = await occupy('127.0.0.1')
    await new Promise((r) => servers.pop()!.close(r))
    expect(await probePort(port)).toBe(true)
  })
})

describe('remembering the port', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'osb-state-')) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('reads back what it wrote, and treats a missing or broken file as nothing remembered', () => {
    expect(readState(root)).toEqual({})
    writeState(root, { port: 4748 })
    expect(readState(root)).toEqual({ port: 4748 })
    writeFileSync(join(root, 'desktop.json'), '{"port": 47')
    expect(readState(root)).toEqual({})
    writeFileSync(join(root, 'desktop.json'), '{"port": "http://evil"}')
    expect(readState(root)).toEqual({})
    writeFileSync(join(root, 'desktop.json'), '{"port": 70000}')
    expect(readState(root)).toEqual({})
  })
})
