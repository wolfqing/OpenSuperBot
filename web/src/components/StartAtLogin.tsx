import { useEffect, useState } from 'react'
import { desktopApi, type LoginItemState } from '../desktop'
import { useT } from '../i18n'

/**
 * 「登录电脑时打开 OpenSuperBot」：只有桌面版有（preload 给的 window.opensuperbot），默认关。
 * 向导最后一步和设置页都用它；勾了马上改，显示主进程回来的真实状态（不先假定改成了）。
 * 源码跑的桌面版不支持：设置页说一句为什么，向导里干脆不出现。
 */
export function StartAtLogin({ where }: { where: 'wizard' | 'settings' }) {
  const t = useT()
  const [api] = useState(desktopApi)
  const [state, setState] = useState<LoginItemState | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    api?.loginItem.get().then((s) => { if (live) setState(s) }).catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [api])

  if (!api) return null
  if (!state) return failed ? <div className="form-error" role="alert">{t('startAtLogin.failed')}</div> : null
  if (!state.supported) return where === 'settings' && state.why === 'unpackaged' ? <p className="settings-dim">{t('startAtLogin.unpackaged')}</p> : null

  const change = async (enabled: boolean) => {
    setBusy(true)
    setFailed(false)
    try {
      setState(await api.loginItem.set(enabled))
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="start-at-login">
      <label className="conn-check-row">
        <input type="checkbox" checked={state.enabled} disabled={busy} onChange={(e) => void change(e.target.checked)} />
        {t('startAtLogin.label')}
      </label>
      <p className="setup-hint">{t(where === 'wizard' ? 'startAtLogin.hintWizard' : 'startAtLogin.hint')}</p>
      {state.why === 'needs_approval' ? <p className="settings-restart" role="status">{t('startAtLogin.needsApproval')}</p> : null}
      {failed ? <div className="form-error" role="alert">{t('startAtLogin.failed')}</div> : null}
    </div>
  )
}
