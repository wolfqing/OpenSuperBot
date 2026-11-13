import { useState } from 'react'
import { FieldErrors, downloadBrowser, saveSettings, testConnection, updateConnection, type ConnectionFields } from '../api'
import { useT, type MessageKey, type T } from '../i18n'
import { sandboxMissingText } from '../i18n/describe'
import type { BrowserStatus, CheckResult, ConnectionsState, FieldError, ModelConnection, ProviderPreset, SetupInfo } from '../types'
import { CheckLine, NOTES, checkText, fieldText } from './ModelsDialog'
import { StartAtLogin } from './StartAtLogin'
import { useEscape } from './ConfirmDialog'
import { XIcon } from './Icons'

/** 设置里的界面语言：空 = 跟系统 */
export type LanguageSetting = '' | 'en' | 'zh-CN'

type Step = 'welcome' | 'provider' | 'key' | 'model' | 'computer' | 'ready'
const STEPS: Step[] = ['welcome', 'provider', 'key', 'model', 'computer', 'ready']

/** 默认连接的 id：向导配的就是它 */
const MAIN = 'main'

/** 三个示例任务：演示模式下也各走一条完整的路（开网页截图、建例行任务、扣住等批准），gateway 的 stub 测试盯着这几句 */
export const EXAMPLES: MessageKey[] = ['setup.example.browse', 'setup.example.routine', 'setup.example.approval']

const regionOrder = (t: T): ProviderPreset['region'][] =>
  t.lang === 'zh-CN' ? ['cn', 'global', 'local', 'custom'] : ['global', 'cn', 'local', 'custom']

const host = (url: string) => {
  try { return new URL(url).host } catch { return url }
}

/**
 * 首次启动向导：欢迎/语言 → 选服务商 → 粘 key、测试 → 选模型 → 电脑检查 → 进 Chief 的对话（桌面版在这一步问开机自启）。
 * 前四步都能「先看看」进演示模式（stub 模型，不花钱也不联网），之后照样检查电脑。
 */
export function SetupWizard({ setup, providers, main, browser, language, onLanguage, onBrowser, onConnections, onDone, onCancel }: {
  setup: SetupInfo
  providers: ProviderPreset[]
  /** 默认连接此刻的样子：从设置页重开向导、选回同一家时，存着的 key 可以留空沿用 */
  main?: ModelConnection | undefined
  /** 浏览器此刻的状态：经 /ws 实时更新，比 setup 里那份新 */
  browser: BrowserStatus
  language: LanguageSetting
  onLanguage: (next: LanguageSetting) => void
  /** 点了下载，网关回的那一刻的状态（之后的进度走 /ws） */
  onBrowser: (next: BrowserStatus) => void
  onConnections: (next: ConnectionsState) => void
  /** task：点了哪个示例任务（已翻好的原话）；不给 = 自己写 */
  onDone: (task?: string) => void
  /** 从设置页重开时给：可以中途关掉。首次启动不给，要么配好、要么进演示 */
  onCancel?: () => void
}) {
  const t = useT()
  useEscape(onCancel)
  const [step, setStep] = useState<Step>('welcome')
  const [demo, setDemo] = useState(false)
  const [providerId, setProviderId] = useState<string>('')
  const [apiKey, setApiKey] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [model, setModel] = useState('')
  const [planOk, setPlanOk] = useState(false)
  const [check, setCheck] = useState<CheckResult | 'testing' | undefined>()
  /** 测通时用的模型：选了别的，保存前再测一次 */
  const [testedModel, setTestedModel] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [errors, setErrors] = useState<FieldError[]>([])
  const [busy, setBusy] = useState(false)

  const preset = providers.find((p) => p.id === providerId)
  const isCustom = providerId === 'custom'
  /** 自定义和本机的（Ollama）地址要人自己确认；其余用预设的 */
  const showAddress = isCustom || preset?.region === 'local'
  const needsPlanOk = Boolean(preset?.plan) && !planOk
  /** 选的就是默认连接现在那一家、而且存了 key：不粘新的就沿用（网关只在地址没换时才用存着的 key） */
  const keyKept = Boolean(main && main.provider === providerId && main.key.set)

  const go = (next: Step) => { setErrors([]); setStep(next) }

  const startDemo = async () => {
    setBusy(true)
    try {
      await saveSettings({ model: 'stub' })
      setDemo(true)
      go('computer')
    } catch (err) {
      setErrors(err instanceof FieldErrors ? err.errors : [{ key: '', code: 'invalid' }])
    } finally {
      setBusy(false)
    }
  }

  const pickProvider = (p: ProviderPreset) => {
    // 换了服务商：刚粘的 key 一起清掉，一家的 key 绝不带去另一家
    setProviderId(p.id)
    setApiKey('')
    // 选回默认连接现在那一家：地址和模型照它现在的（演示模式的 stub 除外）
    const same = main && main.provider === p.id
    setBaseURL(same ? main.baseURL : p.baseURL)
    setModel(same && main.model !== 'stub' ? main.model : p.defaultModel)
    setPlanOk(false)
    setCheck(undefined)
    setModels([])
    go('key')
  }

  const fields = (m: string): ConnectionFields => ({
    provider: providerId,
    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    ...(showAddress ? { baseURL: baseURL.trim() } : {}),
    model: m.trim(),
  })

  /** 测一次；通了返回 true */
  const runTest = async (m: string): Promise<boolean> => {
    setCheck('testing')
    setErrors([])
    try {
      const r = await testConnection({ connectionId: MAIN, ...fields(m) })
      setCheck(r)
      if (r.ok) {
        setTestedModel(m.trim())
        if (r.models.length) setModels(r.models)
      } else if (r.models?.length) setModels(r.models)
      return r.ok
    } catch (err) {
      setCheck(undefined)
      setErrors(err instanceof FieldErrors ? err.errors : [{ key: '', code: 'invalid' }])
      return false
    }
  }

  const testKey = async () => {
    if (await runTest(model)) go('model')
  }

  const saveModel = async () => {
    if (model.trim() !== testedModel && !(await runTest(model))) return
    setBusy(true)
    try {
      onConnections(await updateConnection(MAIN, fields(model)))
      go('computer')
    } catch (err) {
      setErrors(err instanceof FieldErrors ? err.errors : [{ key: '', code: 'invalid' }])
    } finally {
      setBusy(false)
    }
  }

  const demoLink = step === 'welcome' || step === 'provider' || step === 'key' || step === 'model' ? (
    <button type="button" className="setup-demo" onClick={() => void startDemo()} disabled={busy}>{t('setup.demo')}</button>
  ) : null
  const back = (to: Step) => <button type="button" onClick={() => go(to)}>{t('setup.back')}</button>
  const errorLines = errors.length ? (
    <div className="form-error" role="alert">{errors.map((e) => fieldText(t, e)).join(' ')}</div>
  ) : null
  const at = STEPS.indexOf(step)

  return (
    <main className="setup">
      <div className="setup-card" role="dialog" aria-label={t('setup.title')}>
        <div className="setup-top">
          <div className="setup-steps" aria-label={t('setup.stepOf', { n: at + 1, total: STEPS.length })}>
            {STEPS.map((s, i) => <span key={s} className={`setup-dot${i <= at ? ' on' : ''}`} />)}
          </div>
          {onCancel ? (
            <button type="button" className="modal-close" onClick={onCancel} aria-label={t('setup.close')} title={t('setup.close')}>
              <XIcon size={15} />
            </button>
          ) : null}
        </div>

        {step === 'welcome' ? (
          <>
            <h1 className="setup-title">{t('setup.welcome.title')}</h1>
            <p className="setup-body">{t('setup.welcome.body')}</p>
            <fieldset className="setup-langs">
              <legend>{t('setup.welcome.language')}</legend>
              {(['', 'zh-CN', 'en'] as const).map((l) => (
                <label key={l || 'system'} className="setup-radio">
                  <input
                    type="radio" name="language" checked={language === l}
                    onChange={() => { void saveSettings({ language: l }).catch(() => {}); onLanguage(l) }}
                  />
                  {l === '' ? t('setup.welcome.languageSystem') : l === 'zh-CN' ? '简体中文' : 'English'}
                </label>
              ))}
            </fieldset>
            {errorLines}
            <div className="setup-buttons">
              {demoLink}
              <span className="spacer" />
              <button type="button" className="primary" onClick={() => go('provider')}>{t('setup.welcome.start')}</button>
            </div>
            <p className="setup-hint">{t('setup.demoHint')}</p>
          </>
        ) : null}

        {step === 'provider' ? (
          <>
            <h1 className="setup-title">{t('setup.provider.title')}</h1>
            <p className="setup-body">{t('setup.provider.body')}</p>
            {regionOrder(t).map((region) => {
              const inRegion = providers.filter((p) => p.region === region)
              if (!inRegion.length) return null
              return (
                <section key={region} className="setup-region">
                  <div className="setup-region-title">{t(`models.region.${region}` as MessageKey)}</div>
                  <div className="setup-providers">
                    {inRegion.map((p) => (
                      <button type="button" key={p.id} className="setup-provider" onClick={() => pickProvider(p)}>
                        <span className="setup-provider-name">
                          {p.id === 'custom' ? t('models.custom') : p.name}
                          {p.plan ? <span className="conn-badge">{t('setup.provider.plan')}</span> : null}
                        </span>
                        <span className="setup-provider-meta">
                          {p.id === 'custom' ? t('setup.provider.custom') : p.needsKey ? host(p.keyUrl || p.baseURL) : t('models.noKeyNeeded')}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              )
            })}
            {errorLines}
            <div className="setup-buttons">
              {back('welcome')}
              {demoLink}
            </div>
          </>
        ) : null}

        {step === 'key' && preset ? (
          <form className="conn-form" onSubmit={(e) => { e.preventDefault(); if (!needsPlanOk) void testKey() }}>
            <h1 className="setup-title">
              {preset.needsKey ? t('setup.key.title', { name: isCustom ? t('models.custom') : preset.name }) : t('setup.key.titleNoKey', { name: preset.name })}
            </h1>
            {NOTES[preset.id] ? <p className="conn-note">{t(NOTES[preset.id]!)}</p> : null}
            {preset.plan ? (
              <div className="conn-plan" role="note">
                <p>{t('models.planWarning')}</p>
                <label className="conn-check-row">
                  <input type="checkbox" checked={planOk} onChange={(e) => setPlanOk(e.target.checked)} />
                  {t('models.form.planAgree')}
                </label>
              </div>
            ) : null}
            {preset.needsKey ? (
              <>
                {preset.keyUrl ? (
                  <p className="setup-body">
                    {t('setup.key.where', { name: preset.name })}{' '}
                    <a className="setup-link" href={preset.keyUrl} target="_blank" rel="noreferrer">{t('setup.key.open', { host: host(preset.keyUrl) })} ↗</a>
                  </p>
                ) : null}
                <label>
                  <span className="conn-label">{t('models.form.apiKey')}</span>
                  <input
                    type="password" autoComplete="off" spellCheck={false} autoFocus value={apiKey}
                    placeholder={keyKept && main ? t('setup.key.kept', { masked: main.key.masked }) : ''}
                    onChange={(e) => { setApiKey(e.target.value); setCheck(undefined) }}
                  />
                </label>
                <p className="setup-hint">{t('setup.key.private', { name: isCustom ? host(baseURL) || t('models.custom') : preset.name })}</p>
              </>
            ) : (
              <p className="setup-body">{t('setup.key.noKeyBody', { name: preset.name })}</p>
            )}
            {showAddress ? (
              <label>
                <span className="conn-label">{t('models.form.baseURL')}</span>
                <input value={baseURL} spellCheck={false} onChange={(e) => { setBaseURL(e.target.value); setCheck(undefined) }} />
              </label>
            ) : null}
            {isCustom ? (
              <label>
                <span className="conn-label">{t('models.form.model')}</span>
                <input value={model} spellCheck={false} onChange={(e) => { setModel(e.target.value); setCheck(undefined) }} />
              </label>
            ) : null}
            {errorLines}
            <CheckLine result={check} model={model} />
            {check && check !== 'testing' && !check.ok ? <p className="setup-hint">{t('setup.key.stuck')}</p> : null}
            <div className="setup-buttons">
              {back('provider')}
              {demoLink}
              <span className="spacer" />
              <button
                type="submit" className="primary"
                disabled={check === 'testing' || needsPlanOk || (preset.needsKey && !apiKey.trim() && !keyKept) || (isCustom && (!baseURL.trim() || !model.trim()))}
              >
                {check === 'testing' ? t('models.form.testing') : t('setup.key.test')}
              </button>
            </div>
          </form>
        ) : null}

        {step === 'model' && preset ? (
          <form className="conn-form" onSubmit={(e) => { e.preventDefault(); void saveModel() }}>
            <h1 className="setup-title">{t('setup.model.title')}</h1>
            {check && check !== 'testing' && check.ok ? (
              <div className="conn-check ok" role="status">✓ {checkText(t, check, testedModel)}</div>
            ) : null}
            <p className="setup-body">
              {isCustom ? t('setup.model.bodyCustom') : t('setup.model.body', { model: preset.defaultModel })}
            </p>
            <label>
              <span className="conn-label">{t('models.form.model')}</span>
              <input value={model} list="setup-models" spellCheck={false} onChange={(e) => setModel(e.target.value)} />
              <datalist id="setup-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
            </label>
            {models.length ? <p className="setup-hint">{t('setup.model.listed', { count: models.length })}</p> : null}
            {errorLines}
            {check && check !== 'testing' && !check.ok ? <CheckLine result={check} model={model} /> : null}
            {check === 'testing' ? <CheckLine result="testing" model={model} /> : null}
            <div className="setup-buttons">
              {back('key')}
              {demoLink}
              <span className="spacer" />
              <button type="submit" className="primary" disabled={busy || check === 'testing' || !model.trim()}>{t('setup.model.save')}</button>
            </div>
          </form>
        ) : null}

        {step === 'computer' ? (
          <ComputerStep setup={setup} browser={browser} onBrowser={onBrowser} onNext={() => go('ready')} />
        ) : null}

        {step === 'ready' ? (
          <>
            <h1 className="setup-title">{demo ? t('setup.ready.titleDemo') : t('setup.ready.title')}</h1>
            <p className="setup-body">{t('setup.ready.body')}</p>
            {demo ? <p className="setup-hint">{t('setup.demoHint')}</p> : null}
            <StartAtLogin where="wizard" />
            <div className="setup-examples">
              {EXAMPLES.map((key) => (
                <button type="button" key={key} className="setup-example" onClick={() => onDone(t(key))}>{t(key)}</button>
              ))}
            </div>
            <div className="setup-buttons">
              <span className="spacer" />
              <button type="button" className="primary" onClick={() => onDone()}>{t('setup.ready.own')}</button>
            </div>
          </>
        ) : null}
      </div>
    </main>
  )
}

/** 同事的电脑有什么：浏览器（找到的 / 下载进度和镜像）、Docker、命令行沙箱。下载在后台接着跑，不用等 */
function ComputerStep({ setup, browser, onBrowser, onNext }: {
  setup: SetupInfo
  browser: BrowserStatus
  onBrowser: (next: BrowserStatus) => void
  onNext: () => void
}) {
  const t = useT()
  const c = setup.computers
  const suggested = c.browserMirror.suggested
  const [useMirror, setUseMirror] = useState(Boolean(suggested) && !c.browserMirror.current)
  const [error, setError] = useState<string | null>(null)
  /** 点了下载、网关还没回话：先显示「下载中」，免得按钮像没反应 */
  const [asked, setAsked] = useState(false)
  const local = c.kind === 'local'
  const shown: BrowserStatus = asked && (browser.state === 'missing' || browser.state === 'failed') ? { state: 'downloading', item: null, percent: null, totalMiB: null } : browser

  const download = async () => {
    setError(null)
    setAsked(true)
    try {
      if (suggested && useMirror && c.browserMirror.current !== suggested.url) await saveSettings({ browserMirror: suggested.url })
      onBrowser(await downloadBrowser())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAsked(false)
    }
  }

  const why = c.choice === 'auto' && c.why && c.why !== 'chosen' ? t(`setup.computer.why.${c.why}` as MessageKey) : null

  return (
    <>
      <h1 className="setup-title">{t('setup.computer.title')}</h1>
      <p className="setup-body">{local ? t('setup.computer.local') : t('setup.computer.docker')}</p>
      {why ? <p className="setup-hint">{why}</p> : null}
      <ul className="setup-checks">
        {local ? (
          <li>
            <span className="setup-check-name">{t('setup.computer.browser')}</span>
            <BrowserLine browser={shown} download={c.download} />
            {shown.state === 'missing' || shown.state === 'failed' ? (
              <div className="setup-download">
                {suggested ? (
                  <label className="conn-check-row">
                    <input type="checkbox" checked={useMirror} onChange={(e) => setUseMirror(e.target.checked)} />
                    {t('setup.computer.mirror', { owner: suggested.owner })}
                  </label>
                ) : null}
                <button type="button" onClick={() => void download()}>
                  {shown.state === 'failed' ? t('setup.computer.retry') : t('setup.computer.download')}
                </button>
                <span className="setup-hint">{t('setup.computer.later')}</span>
              </div>
            ) : null}
            {error ? <div className="form-error" role="alert">{error}</div> : null}
          </li>
        ) : null}
        <li>
          <span className="setup-check-name">Docker</span>
          <span>
            {!c.docker.reachable ? (local ? t('setup.computer.dockerOffFine') : t('setup.computer.dockerOff'))
              : c.docker.imageReady ? t('setup.computer.dockerReady') : t('setup.computer.dockerNoImage')}
          </span>
        </li>
        {local ? (
          <li>
            <span className="setup-check-name">{t('setup.computer.shell')}</span>
            <span>
              {c.sandbox.available ? t('setup.computer.shellOk')
                : t('setup.computer.shellNo', { why: sandboxMissingText(t, c.sandbox.whyCode, c.sandbox.why ?? '') })}
            </span>
          </li>
        ) : null}
      </ul>
      <div className="setup-buttons">
        <span className="spacer" />
        <button type="button" className="primary" onClick={onNext}>{t('setup.computer.next')}</button>
      </div>
    </>
  )
}

export function BrowserLine({ browser, download }: { browser: BrowserStatus; download: SetupInfo['computers']['download'] }) {
  const t = useT()
  switch (browser.state) {
    case 'found':
      return <span className="setup-ok">✓ {t(browser.source === 'downloaded' ? 'setup.computer.browserDownloaded' : 'setup.computer.browserFound')}<code>{browser.executablePath}</code></span>
    case 'missing':
      return <span>{t('setup.computer.browserMissing', { approxMB: download.approxMB, onDiskMB: download.onDiskMB })}</span>
    case 'downloading':
      return (
        <span className="setup-progress" role="status">
          {browser.percent === null
            ? t('setup.computer.downloadingStart')
            : t('setup.computer.downloading', { item: browser.item ?? '', percent: browser.percent })}
          <progress max={100} {...(browser.percent === null ? {} : { value: browser.percent })} />
        </span>
      )
    case 'failed':
      return <span className="setup-bad">✕ {t('setup.computer.failed', { error: browser.error })}</span>
  }
}
