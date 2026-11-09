import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import type { BrowserStatus, ConnectionsState, ProviderPreset, SetupInfo } from '../types'
import { SetupWizard } from './SetupWizard'

const providers: ProviderPreset[] = [
  { id: 'deepseek', name: 'DeepSeek', region: 'cn', api: 'chat', baseURL: 'https://api.deepseek.com', needsKey: true, keyUrl: 'https://platform.deepseek.com/api_keys', defaultModel: 'deepseek-flash', vision: true, docsUrl: '' },
  { id: 'anthropic', name: 'Claude', region: 'global', api: 'anthropic', baseURL: 'https://api.anthropic.com', needsKey: true, keyUrl: 'https://platform.claude.com/settings/keys', defaultModel: 'claude-opus-5-5', vision: true, docsUrl: '' },
  { id: 'minimax-plan', name: 'MiniMax M Plan', region: 'global', api: 'chat', plan: true, baseURL: 'https://api.minimax.io/v1', needsKey: true, keyUrl: 'https://platform.minimax.io/x', defaultModel: 'MiniMax-M3.1-Flash', vision: true, docsUrl: '' },
  { id: 'ollama', name: 'Ollama', region: 'local', api: 'chat', baseURL: 'http://localhost:11434/v1', needsKey: false, keyUrl: '', defaultModel: 'qwen3', vision: false, docsUrl: '' },
  { id: 'custom', name: 'OpenAI-compatible', region: 'custom', api: 'chat', baseURL: '', needsKey: true, keyUrl: '', defaultModel: '', vision: false, docsUrl: '' },
]

const setup = (over: Partial<SetupInfo['computers']> = {}): SetupInfo => ({
  needsSetup: true, chiefId: 'chief', demo: false,
  computers: {
    kind: 'local', choice: 'auto', why: 'docker_not_running', docker: { reachable: false, imageReady: null },
    browser: { state: 'missing' }, download: { approxMB: 190, onDiskMB: 370 },
    browserMirror: { current: '', suggested: { url: 'https://cdn.npmmirror.com/binaries/playwright', owner: 'npmmirror.com' } },
    sandbox: { available: false, why: 'Install bubblewrap…', whyCode: 'install_bwrap' },
    ...over,
  },
})

const saved: ConnectionsState = { connections: [], bots: {} }

/** 装成网关：按「方法 路径」回预先写好的 JSON，记下请求体 */
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

function show(opts: { lang?: 'en' | 'zh-CN'; info?: SetupInfo; browser?: BrowserStatus } = {}) {
  const props = {
    onLanguage: vi.fn(), onBrowser: vi.fn(), onConnections: vi.fn(), onDone: vi.fn(),
  }
  const info = opts.info ?? setup()
  const ui = (browser: BrowserStatus) => (
    <I18nProvider lang={opts.lang ?? 'en'}>
      <SetupWizard setup={info} providers={providers} browser={browser} language="" {...props} />
    </I18nProvider>
  )
  const view = render(ui(opts.browser ?? info.computers.browser))
  return { ...props, rerender: (b: BrowserStatus) => view.rerender(ui(b)) }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('SetupWizard', () => {
  it('takes a key from paste to a saved model: a failed test says what to do, a good one lists the models', async () => {
    let attempt = 0
    const calls = mockFetch({
      'POST /api/connections/test': () => (++attempt === 1
        ? { body: { ok: false, code: 'bad_key', status: 401, detail: 'invalid api key' } }
        : { body: { ok: true, models: ['deepseek-flash', 'deepseek-pro'], modelListed: true } }),
      'PATCH /api/connections/main': () => ({ body: saved }),
    })
    const user = userEvent.setup()
    const w = show()
    await user.click(screen.getByRole('button', { name: 'Get started' }))
    await user.click(screen.getByRole('button', { name: /DeepSeek/ }))

    expect(screen.getByRole('heading', { name: 'Paste your DeepSeek API key' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open platform\.deepseek\.com/ })).toHaveAttribute('href', 'https://platform.deepseek.com/api_keys')
    const test = screen.getByRole('button', { name: 'Test connection' })
    expect(test).toBeDisabled()
    await user.type(screen.getByLabelText('API key'), 'sk-wrong')
    await user.click(test)
    expect(await screen.findByText(/The key was not accepted/)).toBeInTheDocument()
    expect(screen.getByText(/pick another service, or look around in demo mode/)).toBeInTheDocument()
    expect(calls.at(-1)!.body).toEqual({ connectionId: 'main', provider: 'deepseek', apiKey: 'sk-wrong', model: 'deepseek-flash' })

    await user.clear(screen.getByLabelText('API key'))
    await user.type(screen.getByLabelText('API key'), 'sk-right')
    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    expect(await screen.findByRole('heading', { name: 'Pick a model' })).toBeInTheDocument()
    expect(screen.getByText(/deepseek-flash is available/)).toBeInTheDocument()
    expect(screen.getByText(/offers 2 models/)).toBeInTheDocument()

    // 换了模型：保存前再测一次这个模型，再存
    const model = screen.getByLabelText('Model')
    await user.clear(model)
    await user.type(model, 'deepseek-pro')
    await user.click(screen.getByRole('button', { name: 'Save and continue' }))
    expect(await screen.findByRole('heading', { name: 'Your teammates’ computer' })).toBeInTheDocument()
    const sent = calls.filter((c) => c.path !== '/api/connections/test' || c.body.model === 'deepseek-pro')
    expect(sent.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/connections/test', 'PATCH /api/connections/main'])
    expect(calls.at(-1)!.body).toEqual({ provider: 'deepseek', apiKey: 'sk-right', model: 'deepseek-pro' })
    expect(w.onConnections).toHaveBeenCalledWith(saved)
  })

  it('a plan key needs the warning acknowledged; a local service needs no key but shows its address', async () => {
    mockFetch({})
    const user = userEvent.setup()
    show()
    await user.click(screen.getByRole('button', { name: 'Get started' }))
    await user.click(screen.getByRole('button', { name: /MiniMax M Plan/ }))
    await user.type(screen.getByLabelText('API key'), 'sk-plan')
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled()
    await user.click(screen.getByLabelText('I understand, use it anyway'))
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Back' }))
    await user.click(screen.getByRole('button', { name: /Ollama/ }))
    expect(screen.getByRole('heading', { name: 'Connect to Ollama' })).toBeInTheDocument()
    expect(screen.queryByLabelText('API key')).toBeNull()
    expect(screen.getByLabelText('Address')).toHaveValue('http://localhost:11434/v1')
  })

  it('demo mode from the first screen: switches to the scripted model, still checks the computer, then hands over an example', async () => {
    const calls = mockFetch({ 'PUT /api/settings': () => ({ body: {} }) })
    const user = userEvent.setup()
    const w = show()
    await user.click(screen.getByRole('button', { name: 'Just look around (demo mode)' }))
    expect(await screen.findByRole('heading', { name: 'Your teammates’ computer' })).toBeInTheDocument()
    expect(calls).toEqual([{ method: 'PUT', path: '/api/settings', body: { model: 'stub' } }])
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByRole('heading', { name: 'Demo mode is ready' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /news\.ycombinator\.com/ }))
    expect(w.onDone).toHaveBeenCalledWith('Open https://news.ycombinator.com and tell me the top three stories.')
  })

  it('picking a language saves it and switches right away', async () => {
    const calls = mockFetch({ 'PUT /api/settings': () => ({ body: {} }) })
    const user = userEvent.setup()
    const w = show()
    await user.click(screen.getByLabelText('简体中文'))
    expect(w.onLanguage).toHaveBeenCalledWith('zh-CN')
    await waitFor(() => expect(calls).toEqual([{ method: 'PUT', path: '/api/settings', body: { language: 'zh-CN' } }]))
  })

  it('downloads the browser from the suggested mirror and shows the progress the gateway pushes', async () => {
    const calls = mockFetch({
      'PUT /api/settings': () => ({ body: {} }),
      'POST /api/setup/browser': () => ({ status: 202, body: { browser: { state: 'downloading', item: null, percent: null, totalMiB: null } } }),
    })
    const user = userEvent.setup()
    const w = show()
    await user.click(screen.getByRole('button', { name: 'Just look around (demo mode)' }))
    await screen.findByRole('heading', { name: 'Your teammates’ computer' })
    expect(screen.getByText(/about 190 MB, 370 MB once installed/)).toBeInTheDocument()
    expect(screen.getByText('Docker is not running, so teammates use this computer.')).toBeInTheDocument()
    expect(screen.getByText(/Not available\. Install bubblewrap/)).toBeInTheDocument()
    expect(screen.getByLabelText(/mirror in China \(npmmirror\.com\)/)).toBeChecked()

    await user.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(w.onBrowser).toHaveBeenCalledWith({ state: 'downloading', item: null, percent: null, totalMiB: null }))
    expect(calls.slice(1).map((c) => [c.method, c.path, c.body])).toEqual([
      ['PUT', '/api/settings', { browserMirror: 'https://cdn.npmmirror.com/binaries/playwright' }],
      ['POST', '/api/setup/browser', {}],
    ])
    w.rerender({ state: 'downloading', item: 'chromium', percent: 40, totalMiB: 186 })
    expect(screen.getByText('Downloading chromium… 40%')).toBeInTheDocument()
    w.rerender({ state: 'found', executablePath: '/data/browsers/chrome', source: 'downloaded' })
    expect(screen.getByText('/data/browsers/chrome')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull()
  })

  it('in Chinese, puts the services in China first and speaks Chinese throughout', async () => {
    mockFetch({})
    const user = userEvent.setup()
    show({ lang: 'zh-CN' })
    expect(screen.getByRole('heading', { name: '欢迎使用 OpenSuperBot' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '开始设置' }))
    const regions = [...document.querySelectorAll('.setup-region-title')].map((el) => el.textContent)
    expect(regions[0]).toBe('国内')
    await user.click(screen.getByRole('button', { name: /DeepSeek/ }))
    expect(screen.getByRole('heading', { name: '粘贴 DeepSeek 的 API key' })).toBeInTheDocument()
    expect(screen.getByText('key 只存在这台电脑上，只会发给 DeepSeek。')).toBeInTheDocument()
  })
})
