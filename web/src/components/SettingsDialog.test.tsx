import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import type { AboutInfo, ConnectionsState, ModelConnection, ProviderPreset, SettingsView, SetupInfo } from '../types'
import { SettingsDialog } from './SettingsDialog'

const providers: ProviderPreset[] = [
  { id: 'deepseek', name: 'DeepSeek', region: 'cn', api: 'chat', baseURL: 'https://api.deepseek.com', needsKey: true, keyUrl: '', defaultModel: 'deepseek-flash', vision: true, docsUrl: '' },
]
const main: ModelConnection = {
  id: 'main', name: '', provider: 'deepseek', api: 'chat', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash', vision: true,
  builtIn: true, key: { set: true, masked: 'sk-…1234', source: 'file' }, locked: [],
}
const other: ModelConnection = { ...main, id: 'c-12345678', name: 'Claude', provider: 'anthropic', builtIn: false }
const llms: ConnectionsState = { connections: [main, other], bots: {} }

const view = (over: Partial<SettingsView['values']> = {}, sources: Record<string, 'env' | 'saved' | 'default'> = {}, needsRestart: string[] = []): SettingsView => ({
  values: {
    provider: 'deepseek', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash', vision: true, language: '',
    computers: 'auto', browserMirror: '', checkUpdates: true, ...over,
  },
  sources: { computers: 'default', browserMirror: 'default', ...sources },
  apiKey: { set: true, masked: 'sk-…1234', source: 'file' },
  needsRestart,
})
const setup: SetupInfo = {
  needsSetup: false, chiefId: 'chief', demo: false,
  computers: {
    kind: 'local', choice: 'auto', why: 'docker_image_missing', docker: { reachable: true, imageReady: false },
    browser: { state: 'missing' }, download: { approxMB: 190, onDiskMB: 370 },
    browserMirror: { current: '', suggested: { url: 'https://cdn.npmmirror.com/binaries/playwright', owner: 'npmmirror.com' } },
    sandbox: { available: true },
  },
}
const about: AboutInfo = {
  version: null, dataDir: '/home/me/.opensuperbot', port: 4748, logs: 'stdout', runtime: { node: '24.14.0', platform: 'darwin', arch: 'arm64' }, computers: 'local',
}

function mockFetch(routes: Record<string, (body: Record<string, unknown>) => { status?: number; body: unknown }>) {
  const calls: { method: string; path: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    const method = init?.method ?? 'GET'
    calls.push({ method, path, body })
    const route = routes[`${method} ${path}`]
    const reply = route ? route(body) : { status: 404, body: {} }
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } })
  }))
  return calls
}

function gateway(settings: SettingsView, extra: Record<string, (body: Record<string, unknown>) => { status?: number; body: unknown }> = {}) {
  return mockFetch({
    'GET /api/settings': () => ({ body: settings }),
    'GET /api/setup': () => ({ body: setup }),
    'GET /api/about': () => ({ body: about }),
    ...extra,
  })
}

function show(opts: { lang?: 'en' | 'zh-CN' } = {}) {
  const props = { onLanguage: vi.fn(), onBrowser: vi.fn(), onModels: vi.fn(), onWizard: vi.fn(), onSignedOut: vi.fn(), onClose: vi.fn() }
  render(
    <I18nProvider lang={opts.lang ?? 'en'}>
      <SettingsDialog llms={llms} providers={providers} browser={null} language="" {...props} />
    </I18nProvider>,
  )
  return props
}

afterEach(() => { vi.unstubAllGlobals() })

describe('SettingsDialog', () => {
  it('sums up the model, the computer and where things live', async () => {
    gateway(view())
    const user = userEvent.setup()
    const p = show()
    expect(await screen.findByText(/Default: DeepSeek · deepseek-flash/)).toBeInTheDocument()
    expect(screen.getByText(/1 more connection/)).toBeInTheDocument()
    expect(screen.getByText('Teammates are using: This computer.')).toBeInTheDocument()
    expect(screen.getByText(/image is not built yet, so teammates use this computer for now/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Automatic/)).toBeChecked()
    expect(screen.getByText('Run from source (no version number)')).toBeInTheDocument()
    expect(screen.getByText('/home/me/.opensuperbot')).toBeInTheDocument()
    expect(screen.getByText('4748')).toBeInTheDocument()
    expect(screen.getByText('Printed in the terminal that runs the gateway')).toBeInTheDocument()
    expect(screen.getByText('Node 24.14.0 · darwin/arm64')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Manage AI models…' }))
    expect(p.onModels).toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Run the setup again' }))
    expect(p.onWizard).toHaveBeenCalled()
  })

  it('switching computers saves it and says a restart is needed when the gateway says so', async () => {
    const calls = gateway(view(), { 'PUT /api/settings': (b) => ({ body: view({ computers: b.computers as 'docker' }, { computers: 'saved' }, ['computers']) }) })
    const user = userEvent.setup()
    show()
    await user.click(await screen.findByLabelText(/^Docker/))
    expect(await screen.findByText('Restart the gateway for this to take effect.')).toBeInTheDocument()
    expect(calls.at(-1)).toEqual({ method: 'PUT', path: '/api/settings', body: { computers: 'docker' } })
  })

  it('a choice pinned by an environment variable is read-only and says where to change it', async () => {
    gateway(view({ computers: 'local', browserMirror: 'https://mirror.example' }, { computers: 'env', browserMirror: 'env' }))
    show()
    expect(await screen.findByText(/OPENSUPERBOT_COMPUTERS; change it there/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Docker/)).toBeDisabled()
    expect(screen.getByLabelText('Where the browser downloads from')).toBeDisabled()
    expect(screen.getByText(/OPENSUPERBOT_BROWSER_MIRROR; change it there/)).toBeInTheDocument()
  })

  it('in demo mode, offers to connect a real model through the wizard', async () => {
    gateway(view({ model: 'stub', provider: '' }))
    const user = userEvent.setup()
    const p = show()
    expect(await screen.findByText(/Demo mode: replies are scripted/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Connect a real model' }))
    expect(p.onWizard).toHaveBeenCalled()
  })

  it('sets the browser mirror, with the suggestion one click away, and shows a refusal', async () => {
    let reject = false
    const calls = gateway(view(), {
      'PUT /api/settings': (b) => (reject
        ? { status: 400, body: { error: 'invalid_settings', errors: [{ key: 'browserMirror', code: 'invalid' }] } }
        : { body: view({ browserMirror: b.browserMirror as string }) }),
    })
    const user = userEvent.setup()
    show()
    await user.click(await screen.findByRole('button', { name: 'Use npmmirror.com' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls.at(-1)!.body).toEqual({ browserMirror: 'https://cdn.npmmirror.com/binaries/playwright' }))
    reject = true
    const input = screen.getByLabelText('Where the browser downloads from')
    await user.clear(input)
    await user.type(input, 'not a url')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('This value is not valid.')).toBeInTheDocument()
  })

  it('downloads the browser when there is none', async () => {
    gateway(view(), { 'POST /api/setup/browser': () => ({ status: 202, body: { browser: { state: 'downloading', item: null, percent: null, totalMiB: null } } }) })
    const user = userEvent.setup()
    const p = show()
    expect(await screen.findByText(/about 190 MB/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(p.onBrowser).toHaveBeenCalledWith({ state: 'downloading', item: null, percent: null, totalMiB: null }))
  })

  it('speaks Chinese', async () => {
    gateway(view())
    show({ lang: 'zh-CN' })
    expect(await screen.findByText('同事现在用的是：这台电脑。')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: '设置' })).toBeInTheDocument()
    expect(screen.getByText('源码版（没有版本号）')).toBeInTheDocument()
  })
})
