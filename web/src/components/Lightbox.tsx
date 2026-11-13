import { useT } from '../i18n'
import { useEscape } from './ConfirmDialog'
import { ExternalLinkIcon, XIcon } from './Icons'

export type LightboxImage = { url: string; alt: string; caption?: string }

export function Lightbox({ image, onClose }: { image: LightboxImage; onClose: () => void }) {
  const t = useT()
  useEscape(onClose)
  const label = image.caption || image.alt
  return (
    <div className="lightbox-scrim" onClick={onClose}>
      <div
        className="lightbox-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('lightbox.preview', { name: label })}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="lightbox-bar">
          <span className="lightbox-caption">{label}</span>
          <a className="lightbox-action" href={image.url} target="_blank" rel="noreferrer">
            <span>{t('lightbox.openOriginal')}</span>
            <ExternalLinkIcon />
          </a>
          <button type="button" className="lightbox-close" onClick={onClose} aria-label={t('lightbox.close')} title={t('lightbox.close')}>
            <XIcon size={16} />
          </button>
        </header>
        <div className="lightbox-stage" onClick={onClose}>
          <img className="lightbox-img" src={image.url} alt={image.alt} onClick={(e) => e.stopPropagation()} />
        </div>
      </div>
    </div>
  )
}
