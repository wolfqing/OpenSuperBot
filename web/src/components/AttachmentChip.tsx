import { humanSize, isImageType } from '../attachments'
import { useT, type T } from '../i18n'
import type { AttachmentPayload } from '../types'
import { FileTextIcon, XIcon } from './Icons'
import type { LightboxImage } from './Lightbox'

const KIND: Record<string, string> = {
  'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP', 'image/gif': 'GIF',
  'application/pdf': 'PDF', 'text/markdown': 'Markdown',
}

/** 「PDF · 12 页 · 1.2 MB」，PDF 没有可读的文字时把原因接在后面：同事读不了，操作者得知道 */
function describe(file: AttachmentPayload, t: T): string {
  const parts = [KIND[file.mime] ?? (file.mime === 'text/plain' ? t('file.kind.text') : file.mime)]
  if (file.pages) parts.push(file.pages === 1 ? t('file.page') : t('file.pages', { count: file.pages }))
  parts.push(humanSize(file.size))
  if (file.text === 'none' || file.text === 'failed' || file.text === 'truncated') parts.push(t(`file.text.${file.text}`))
  return parts.join(' · ')
}

/**
 * 你发给同事的一个文件。图片是缩略图，点开看原图；别的是一条，点了下载。
 * 移除只删网关上的那份（线程里留个名字），所以先问一句——同事电脑上的副本不会跟着没。
 */
export function AttachmentChip({ payload, onRemove, onRequestRemove, onPreview }: {
  payload: AttachmentPayload
  onRemove?: (id: string) => void
  onRequestRemove?: (payload: AttachmentPayload) => void
  onPreview?: (image: LightboxImage) => void
}) {
  const t = useT()
  const { name } = payload
  if (payload.deleted) {
    return (
      <div className="file-chip file-gone">
        <span className="file-name">{name}</span>
        <span className="file-meta">{t('file.removed')}</span>
      </div>
    )
  }
  const remove = onRemove ? (
    <button
      type="button"
      className="file-remove"
      aria-label={t('file.remove', { name })}
      title={t('file.remove', { name })}
      onClick={() => {
        if (onRequestRemove) onRequestRemove(payload)
        else if (window.confirm(t('file.removeConfirm', { name }))) onRemove(payload.id)
      }}
    >
      <XIcon size={13} />
    </button>
  ) : null
  if (isImageType(payload.mime)) {
    return (
      <figure className="file-figure">
        <a
          href={payload.url}
          target="_blank"
          rel="noreferrer"
          aria-label={t('file.open', { name })}
          onClick={(e) => {
            if (onPreview && !e.metaKey && !e.ctrlKey && e.button === 0) {
              e.preventDefault()
              onPreview({ url: payload.url, alt: name, caption: name })
            }
          }}
        >
          <img className="file-img" src={payload.url} width={payload.width} height={payload.height} alt={name} loading="lazy" />
        </a>
        <figcaption className="file-caption">
          <span className="file-name">{name}</span>
          <span className="file-meta">{describe(payload, t)}</span>
          {remove}
        </figcaption>
      </figure>
    )
  }
  return (
    <div className="file-chip">
      <a className="file-link" href={payload.url} download={name} aria-label={t('file.download', { name })}>
        <span className="file-icon" aria-hidden="true"><FileTextIcon size={15} /></span>
        <span className="file-name">{name}</span>
      </a>
      <span className="file-meta">{describe(payload, t)}</span>
      {remove}
    </div>
  )
}
