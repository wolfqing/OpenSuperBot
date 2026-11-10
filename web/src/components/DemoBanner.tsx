import { useT } from '../i18n'

/**
 * 演示模式横幅：这里的回复是脚本写好的，不花钱也不联网；一键接真模型（重开设置向导）。
 * names 给了 = 群里只有这几位在演示模式，点名说；不给 = 这个对话里的同事都在演示模式。
 */
export function DemoBanner({ names, onConnect }: { names?: string[]; onConnect: () => void }) {
  const t = useT()
  const text = names?.length
    ? t('demo.bannerSome', { names: names.join(t.lang === 'zh-CN' ? '、' : ', ') })
    : t('demo.banner')
  return (
    <div className="demo-banner" role="note">
      <span className="demo-banner-tag">{t('demo.tag')}</span>
      <span className="demo-banner-text">{text}</span>
      <button type="button" onClick={onConnect}>{t('demo.connect')}</button>
    </div>
  )
}
