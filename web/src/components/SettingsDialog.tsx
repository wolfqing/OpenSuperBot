import { useEffect, useState, type ReactNode } from 'react'
import { FieldErrors, SignedOut, downloadBrowser, fetchAbout, fetchSettings, fetchSetup, saveSettings } from '../api'
import { desktopApi, type DesktopInfo } from '../desktop'
import { useT, type MessageKey } from '../i18n'
import type { AboutInfo, BrowserStatus, ConnectionsState, FieldError, ProviderPreset, SettingsView, SetupInfo } from '../types'
import { connectionLabel, fieldText } from './ModelsDialog'
import { BrowserLine, type LanguageSetting } from './SetupWizard'
import { StartAtLogin } from './StartAtLogin'
import { useEscape } from './ConfirmDialog'
import { XIcon } from './Icons'

type Computers = SettingsView['values']['computers']
const COMPUTERS: Computers[] = ['auto', 'local', 'docker']

/** 一块设置：标题 + 内容 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h2 className="settings-heading">{title}</h2>
      {children}
    </section>
  )
}

/**
 * 设置页：AI 模型（总表在「AI 模型」窗口里，这里给摘要、入口和重开向导）、语言、同事的电脑（种类、浏览器、镜像）、关于。
 * 被环境变量定死的项只读，说清楚去哪改；改了要重启才生效的，写明。
 * 桌面版多一块「桌面版」：开机自启（浏览器里打开没有这块）。
 */
export function SettingsDialog({ llms, providers, browser, language, onLanguage, onBrowser, onModels, onWizard, onSignedOut, onClose }: {
  llms: ConnectionsState | null
  providers: ProviderPreset[]
  /** 浏览器此刻的状态（经 /ws 实时更新）；null = 还没收到过，用拉回来的那份 */
  browser: BrowserStatus | null
  language: LanguageSetting
  onLanguage: (next: LanguageSetting) => void
  onBrowser: (next: BrowserStatus) => void
  onModels: () => void
  /** 重开设置向导：换服务商、从演示模式接真模型 */
  onWizard: () => void
  onSignedOut: () => void
  onClose: () => void
}) {
  const t = useT()
  useEscape(onClose)
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [setup, setSetup] = useState<SetupInfo | null>(null)
  const [about, setAbout] = useState<AboutInfo | null>(null)
  /** 桌面版才有（preload 给的）；浏览器里打开是 null */
  const [desktop, setDesktop] = useState<DesktopInfo | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [errors, setErrors] = useState<FieldError[]>([])
  const [mirror, setMirror] = useState('')
  const [saving, setSaving] = useState(false)
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    let live = true
    Promise.all([fetchSettings(), fetchSetup(), fetchAbout()])
      .then(([s, su, a]) => {
        if (!live) return
        setSettings(s)
        setMirror(s.values.browserMirror)
        setSetup(su)
        setAbout(a)
      })
      .catch((err: unknown) => {
        if (err instanceof SignedOut) onSignedOut()
        else if (live) setLoadError(true)
      })
    desktopApi()?.info().then((d) => { if (live) setDesktop(d) }).catch(() => {})
    return () => { live = false }
  }, [onSignedOut])

  const save = async (patch: Record<string, unknown>) => {
    setSaving(true)
    setErrors([])
    try {
      const next = await saveSettings(patch)
      setSettings(next)
      return next
    } catch (err) {
      if (err instanceof SignedOut) onSignedOut()
      setErrors(err instanceof FieldErrors ? err.errors : [{ key: '', code: 'invalid' }])
      return null
    } finally {
      setSaving(false)
    }
  }

  const download = async () => {
    setDownloading(true)
    try {
      onBrowser(await downloadBrowser())
    } catch (err) {
      setErrors([{ key: 'browser', code: err instanceof Error ? err.message : String(err) }])
    } finally {
      setDownloading(false)
    }
  }

  const errorFor = (key: string) => {
    const e = errors.find((x) => x.key === key)
    return e ? <div className="form-error" role="alert">{fieldText(t, e)}</div> : null
  }
  const locked = (key: string) => settings?.sources[key] === 'env'
  const lockedNote = (name: string) => <p className="settings-locked">{t('settings.lockedBy', { name })}</p>

  const main = llms?.connections.find((c) => c.builtIn)
  const demo = settings?.values.model === 'stub'
  const others = llms ? llms.connections.length - 1 : 0
  const running = about?.computers ?? setup?.computers.kind ?? null
  const live: BrowserStatus | null = browser ?? setup?.computers.browser ?? null
  const shownBrowser: BrowserStatus | null = downloading && (live?.state === 'missing' || live?.state === 'failed')
    ? { state: 'downloading', item: null, percent: null, totalMiB: null } : live
  const suggested = setup?.computers.browserMirror.suggested ?? null
  const why = setup && setup.computers.choice === 'auto' && setup.computers.why && setup.computers.why !== 'chosen'
    ? t(`setup.computer.why.${setup.computers.why}` as MessageKey) : null

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal modal-wide settings" role="dialog" aria-label={t('settings.title')} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">{t('settings.title')}</div>
          <button type="button" className="modal-close" onClick={onClose} aria-label={t('settings.close')} title={t('settings.close')}>
            <XIcon size={15} />
          </button>
        </div>
        {loadError ? <div className="form-error" role="alert">{t('settings.loadFailed')}</div> : null}
        {!settings && !loadError ? <p className="settings-dim">{t('settings.loading')}</p> : null}

        {settings ? (
          <>
            <Section title={t('settings.models')}>
              {demo ? (
                <p className="settings-line">{t('settings.demo')}</p>
              ) : main ? (
                <p className="settings-line">
                  {t('settings.defaultModel', { name: connectionLabel(main, providers, t), model: main.model })}
                  {others > 0 ? <span className="settings-dim"> · {t(others === 1 ? 'settings.moreOne' : 'settings.moreMany', { count: others })}</span> : null}
                </p>
              ) : null}
              <div className="settings-buttons">
                {demo ? <button type="button" className="primary" onClick={onWizard}>{t('settings.connectReal')}</button> : null}
                {llms ? <button type="button" onClick={onModels}>{t('settings.manageModels')}</button> : null}
                {demo ? null : <button type="button" onClick={onWizard}>{t('settings.rerunWizard')}</button>}
              </div>
            </Section>

            <Section title={t('setup.welcome.language')}>
              <div className="setup-langs">
                {(['', 'zh-CN', 'en'] as const).map((l) => (
                  <label key={l || 'system'} className="setup-radio">
                    <input
                      type="radio" name="settings-language" checked={language === l}
                      onChange={() => { void save({ language: l }); onLanguage(l) }}
                    />
                    {l === '' ? t('setup.welcome.languageSystem') : l === 'zh-CN' ? '简体中文' : 'English'}
                  </label>
                ))}
              </div>
              {errorFor('language')}
            </Section>

            <Section title={t('setup.computer.title')}>
              {running ? (
                <p className="settings-line">
                  {t('settings.computers.running', { kind: t(running === 'local' ? 'settings.computers.local' : 'settings.computers.docker') })}
                </p>
              ) : null}
              {why ? <p className="setup-hint">{why}</p> : null}
              <fieldset className="settings-choices" disabled={locked('computers') || saving}>
                <legend className="conn-label">{t('settings.computers.choice')}</legend>
                {COMPUTERS.map((k) => (
                  <label key={k} className="settings-choice">
                    <input type="radio" name="computers" checked={settings.values.computers === k} onChange={() => void save({ computers: k })} />
                    <span>
                      <span className="settings-choice-name">{t(`settings.computers.${k}` as MessageKey)}</span>
                      <span className="settings-dim">{t(`settings.computers.${k}Hint` as MessageKey)}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              {locked('computers') ? lockedNote('OPENSUPERBOT_COMPUTERS') : null}
              {settings.needsRestart.includes('computers') ? <p className="settings-restart" role="status">{t('settings.restart')}</p> : null}
              {errorFor('computers')}

              {running === 'local' && shownBrowser ? (
                <div className="settings-browser">
                  <span className="conn-label">{t('setup.computer.browser')}</span>
                  <BrowserLine browser={shownBrowser} download={setup?.computers.download ?? { approxMB: 190, onDiskMB: 370 }} />
                  {shownBrowser.state === 'missing' || shownBrowser.state === 'failed' ? (
                    <div className="settings-buttons">
                      <button type="button" onClick={() => void download()}>
                        {shownBrowser.state === 'failed' ? t('setup.computer.retry') : t('setup.computer.download')}
                      </button>
                    </div>
                  ) : null}
                  {errors.find((e) => e.key === 'browser') ? (
                    <div className="form-error" role="alert">{errors.find((e) => e.key === 'browser')!.code}</div>
                  ) : null}
                </div>
              ) : null}

              <form className="conn-form" onSubmit={(e) => { e.preventDefault(); void save({ browserMirror: mirror.trim() }) }}>
                <label>
                  <span className="conn-label">{t('settings.mirror')}</span>
                  <input
                    value={mirror} spellCheck={false} disabled={locked('browserMirror')} placeholder={t('settings.mirrorNone')}
                    onChange={(e) => setMirror(e.target.value)}
                  />
                </label>
                <p className="setup-hint">{t('settings.mirrorHint')}</p>
                {locked('browserMirror') ? lockedNote('OPENSUPERBOT_BROWSER_MIRROR') : (
                  <div className="settings-buttons">
                    {suggested && mirror !== suggested.url ? (
                      <button type="button" onClick={() => setMirror(suggested.url)}>{t('settings.mirrorUse', { owner: suggested.owner })}</button>
                    ) : null}
                    <span className="spacer" />
                    <button type="submit" disabled={saving || mirror.trim() === settings.values.browserMirror}>{t('settings.save')}</button>
                  </div>
                )}
                {errorFor('browserMirror')}
              </form>
            </Section>

            {desktop ? (
              <Section title={t('settings.app')}>
                <StartAtLogin where="settings" />
              </Section>
            ) : null}

            {about ? (
              <Section title={t('settings.about')}>
                <dl className="settings-about">
                  <dt>{t('settings.about.version')}</dt>
                  <dd>{about.version ?? t('settings.about.source')}</dd>
                  {desktop ? (
                    <>
                      <dt>{t('settings.about.app')}</dt>
                      <dd>{t('settings.about.desktop', { version: desktop.version, electron: desktop.electron })}</dd>
                    </>
                  ) : null}
                  {about.port ? (
                    <>
                      <dt>{t('settings.about.port')}</dt>
                      <dd>{about.port}</dd>
                    </>
                  ) : null}
                  <dt>{t('settings.about.data')}</dt>
                  <dd><code>{about.dataDir}</code></dd>
                  <dt>{t('settings.about.logs')}</dt>
                  <dd>{about.logs === 'stdout' ? t('settings.about.logsStdout') : <code>{about.logs}</code>}</dd>
                  <dt>{t('settings.about.runtime')}</dt>
                  <dd>{`Node ${about.runtime.node} · ${about.runtime.platform}/${about.runtime.arch}`}</dd>
                </dl>
              </Section>
            ) : null}
            {errorFor('')}
          </>
        ) : null}
      </div>
    </div>
  )
}
