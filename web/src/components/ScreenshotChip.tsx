import type { ScreenshotPayload } from '../types'
import { useT } from '../i18n'
import type { LightboxImage } from './Lightbox'

export function ScreenshotChip({ payload, onPreview }: {
  payload: ScreenshotPayload
  onPreview?: (image: LightboxImage) => void
}) {
  const t = useT()
  const alt = payload.caption ?? t('screenshot.alt')
  const img = (
    <img
      className="shot-img"
      src={payload.url}
      width={payload.width}
      height={payload.height}
      alt={alt}
      loading="lazy"
    />
  )
  return (
    <figure className="shot-chip">
      {onPreview ? (
        <button
          type="button"
          className="shot-zoom"
          aria-label={t('lightbox.preview', { name: alt })}
          onClick={() => onPreview({ url: payload.url, alt, ...(payload.caption ? { caption: payload.caption } : {}) })}
        >
          {img}
        </button>
      ) : img}
      {payload.caption ? <figcaption className="shot-caption">{payload.caption}</figcaption> : null}
    </figure>
  )
}
