import { describe, expect, it, vi } from 'vitest'
import { RELEASES_API_URL, checkForUpdate, newerVersion, parseReleasePayload } from '../src/updates.js'

describe('comparing release versions', () => {
  it('spots a newer stable version and ignores equal, older, or prerelease tags', () => {
    expect(newerVersion('0.6.0', 'v0.6.1')).toBe('0.6.1')
    expect(newerVersion('0.6.0', 'v0.7.0')).toBe('0.7.0')
    expect(newerVersion('0.6.0', '1.0.0')).toBe('1.0.0')
    expect(newerVersion('0.6.0', 'v0.6.0')).toBeNull()
    expect(newerVersion('0.6.0', 'v0.5.9')).toBeNull()
    // 0.6.0-dev 比已发布的 0.5.0 新，但比正式 0.6.0 旧
    expect(newerVersion('0.6.0-dev', 'v0.5.0')).toBeNull()
    expect(newerVersion('0.6.0-dev', 'v0.6.0')).toBe('0.6.0')
    // 预发布和怪名字一律不提示
    expect(newerVersion('0.6.0', 'v0.7.0-rc.1')).toBeNull()
    expect(newerVersion('0.6.0', 'nightly')).toBeNull()
    expect(newerVersion('0.6.0', 'v0.7.0\nmalicious')).toBeNull()
  })

  it('only accepts release pages under this repository on GitHub over HTTPS', () => {
    const good = {
      tag_name: 'v0.7.0',
      html_url: 'https://github.com/wolfqing/OpenSuperBot/releases/tag/v0.7.0',
      draft: false,
      prerelease: false,
    }
    expect(parseReleasePayload(good, '0.6.0')).toEqual({
      version: '0.7.0',
      url: 'https://github.com/wolfqing/OpenSuperBot/releases/tag/v0.7.0',
    })
    expect(parseReleasePayload({ ...good, draft: true }, '0.6.0')).toBeNull()
    expect(parseReleasePayload({ ...good, prerelease: true }, '0.6.0')).toBeNull()
    expect(parseReleasePayload({ ...good, html_url: 'http://github.com/wolfqing/OpenSuperBot/releases/tag/v0.7.0' }, '0.6.0')).toBeNull()
    expect(parseReleasePayload({ ...good, html_url: 'https://evil.example/wolfqing/OpenSuperBot/releases/tag/v0.7.0' }, '0.6.0')).toBeNull()
    expect(parseReleasePayload({ ...good, html_url: 'https://github.com/someone-else/OpenSuperBot/releases/tag/v0.7.0' }, '0.6.0')).toBeNull()
  })
})

describe('checking on startup', () => {
  it('makes zero external requests when checkUpdates is off in settings', async () => {
    const calls: string[] = []
    const fakeFetch = vi.fn(async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify({ values: { checkUpdates: false } }))
    })
    const res = await checkForUpdate({
      currentVersion: '0.6.0',
      gatewayBase: 'http://127.0.0.1:4747',
      token: 'secret',
      fetchImpl: fakeFetch as unknown as typeof fetch,
    })
    expect(res).toBeNull()
    expect(calls).toEqual(['http://127.0.0.1:4747/api/settings'])
  })

  it('makes zero external requests if the gateway settings could not be read', async () => {
    const calls: string[] = []
    const fakeFetch = vi.fn(async (url: string) => {
      calls.push(url)
      return new Response('unavailable', { status: 503 })
    })
    const res = await checkForUpdate({
      currentVersion: '0.6.0',
      gatewayBase: 'http://127.0.0.1:4747',
      token: 'secret',
      fetchImpl: fakeFetch as unknown as typeof fetch,
    })
    expect(res).toBeNull()
    expect(calls).toEqual(['http://127.0.0.1:4747/api/settings'])
  })

  it('fetches GitHub latest release once when enabled, and stays quiet on network or rate-limit errors', async () => {
    const calls: Array<{ url: string; headers?: Record<string, string> }> = []
    const fakeFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: init?.headers as Record<string, string> | undefined })
      if (url.endsWith('/api/settings')) {
        return new Response(JSON.stringify({ values: { checkUpdates: true } }))
      }
      return new Response(JSON.stringify({
        tag_name: 'v0.7.0',
        html_url: 'https://github.com/wolfqing/OpenSuperBot/releases/tag/v0.7.0',
        draft: false,
        prerelease: false,
      }))
    })
    const found = await checkForUpdate({
      currentVersion: '0.6.0',
      gatewayBase: 'http://127.0.0.1:4747',
      token: 'secret',
      fetchImpl: fakeFetch as unknown as typeof fetch,
    })
    expect(found).toEqual({
      version: '0.7.0',
      url: 'https://github.com/wolfqing/OpenSuperBot/releases/tag/v0.7.0',
    })
    expect(calls.map((c) => c.url)).toEqual(['http://127.0.0.1:4747/api/settings', RELEASES_API_URL])
    expect(calls[1]!.headers?.['user-agent']).toBe('OpenSuperBot/0.6.0')

    const rateLimited = vi.fn(async (url: string) =>
      url.endsWith('/api/settings')
        ? new Response(JSON.stringify({ values: { checkUpdates: true } }))
        : new Response('rate limit', { status: 403 }),
    )
    expect(await checkForUpdate({
      currentVersion: '0.6.0',
      gatewayBase: 'http://127.0.0.1:4747',
      token: 'secret',
      fetchImpl: rateLimited as unknown as typeof fetch,
    })).toBeNull()
  })
})
