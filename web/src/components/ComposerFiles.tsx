import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../api'
import { MAX_FILES, checkFile, declaredType, humanSize, isImageType } from '../attachments'
import { useT } from '../i18n'
import { errorText } from '../i18n/describe'
import type { AttachmentPayload } from '../types'

/** 输入框发文件要用到的几件事，由 App 给：没给就没有回形针 */
export type FilesIO = {
  /** 传一个文件到网关；signal 中止时应当停下 */
  upload: (file: File, mime: string, signal: AbortSignal) => Promise<AttachmentPayload>
  /** 传上去了却没发出去（拿掉了、换了对话）：让网关删掉，别等它一天后自己清 */
  discard: (id: string) => void
  /** 移除一个已经发出去的文件 */
  remove?: (id: string) => void
  /** 单聊里这位同事的模型看不看得了图；false 才提醒，不知道就别传 */
  seesImages?: boolean
}

export type PendingFile = {
  key: string
  file: File
  mime: string | null
  status: 'uploading' | 'ready' | 'error'
  upload?: AttachmentPayload
  /** 出了什么事，已经是操作者的语言 */
  problem?: string
  /** 网络或网关那头的失败可以再试；文件本身不行（太大、类型不对）再试也没用 */
  retry?: boolean
  /** 图片的本地预览地址 */
  preview?: string
}

const revoke = (item: PendingFile) => {
  if (item.preview && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(item.preview)
}

/**
 * 待发的文件：一选就传，传完才能发。scope 是对话的 id——换了对话，这边等着的就不要了：
 * 没传完的中止，传完的让网关删掉。
 */
export function usePendingFiles(scope: string, io: FilesIO | undefined) {
  const t = useT()
  const [items, setItems] = useState<PendingFile[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  // 同一拍里连加两批文件时，state 还没更新：数「还有几个位置」得看这份
  const itemsRef = useRef<PendingFile[]>([])
  // 还要着的文件 → 它正在进行的上传（没有在传就是 null）。不在这张表里 = 已经被拿掉了
  const wanted = useRef(new Map<string, AbortController | null>())
  const ioRef = useRef(io)
  ioRef.current = io
  const tRef = useRef(t)
  tRef.current = t
  const counter = useRef(0)

  const commit = useCallback((next: PendingFile[]) => {
    itemsRef.current = next
    setItems(next)
  }, [])
  const patch = useCallback((key: string, change: Partial<PendingFile>) => {
    commit(itemsRef.current.map((item) => (item.key === key ? { ...item, ...change } : item)))
  }, [commit])

  const begin = useCallback((key: string, file: File, mime: string) => {
    const use = ioRef.current
    if (!use) return
    const control = new AbortController()
    wanted.current.set(key, control)
    use.upload(file, mime, control.signal).then(
      (upload) => {
        // 传完之前就被拿掉了，而中止没赶上：网关已经存下了，让它删
        if (!wanted.current.has(key)) { use.discard(upload.id); return }
        wanted.current.set(key, null)
        patch(key, { status: 'ready', upload })
      },
      (err: unknown) => {
        if (!wanted.current.has(key)) return
        wanted.current.set(key, null)
        const problem = err instanceof ApiError ? errorText(tRef.current, err) : err instanceof Error ? err.message : String(err)
        patch(key, { status: 'error', problem, retry: true })
      },
    )
  }, [patch])

  const add = useCallback((incoming: File[]) => {
    if (!ioRef.current || !incoming.length) return
    const room = Math.max(MAX_FILES - itemsRef.current.length, 0)
    setNotice(incoming.length > room ? tRef.current('files.tooMany', { max: MAX_FILES }) : null)
    const fresh = incoming.slice(0, room).map((file): PendingFile => {
      const key = `file-${++counter.current}`
      const mime = declaredType(file)
      const problem = checkFile(file)
      if (problem || !mime) return { key, file, mime, status: 'error', problem: tRef.current(`error.${problem ?? 'type_not_allowed'}`), retry: false }
      const preview = isImageType(mime) && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : undefined
      return { key, file, mime, status: 'uploading', ...(preview ? { preview } : {}) }
    })
    commit([...itemsRef.current, ...fresh])
    for (const item of fresh) {
      wanted.current.set(item.key, null)
      if (item.status === 'uploading' && item.mime) begin(item.key, item.file, item.mime)
    }
  }, [begin, commit])

  const remove = useCallback((key: string) => {
    const item = itemsRef.current.find((x) => x.key === key)
    if (!item) return
    wanted.current.get(key)?.abort()
    wanted.current.delete(key)
    if (item.upload) ioRef.current?.discard(item.upload.id)
    revoke(item)
    commit(itemsRef.current.filter((x) => x.key !== key))
  }, [commit])

  const retry = useCallback((key: string) => {
    const item = itemsRef.current.find((x) => x.key === key)
    if (!item?.mime || !item.retry) return
    patch(key, { status: 'uploading', problem: undefined })
    begin(key, item.file, item.mime)
  }, [begin, patch])

  /** 把传好的拿去发：它们从这里消失，也不再归这里管（发出去了就不该被「没发就删」清掉）。没传成的留下，人看得见它没走 */
  const take = useCallback((): PendingFile[] => {
    const ready = itemsRef.current.filter((item) => item.status === 'ready' && item.upload)
    for (const item of ready) {
      wanted.current.delete(item.key)
      revoke(item)
    }
    commit(itemsRef.current.filter((item) => !ready.includes(item)))
    setNotice(null)
    return ready.map(({ preview: _preview, ...rest }) => rest)
  }, [commit])

  /** 没发出去：放回来 */
  const restore = useCallback((taken: PendingFile[]) => {
    for (const item of taken) wanted.current.set(item.key, null)
    commit([...taken, ...itemsRef.current])
  }, [commit])

  useEffect(() => () => {
    for (const item of itemsRef.current) {
      wanted.current.get(item.key)?.abort()
      if (item.upload) ioRef.current?.discard(item.upload.id)
      revoke(item)
    }
    wanted.current.clear()
    itemsRef.current = []
    setItems([])
    setNotice(null)
  }, [scope])

  return {
    items,
    notice,
    uploading: items.some((item) => item.status === 'uploading'),
    ready: items.filter((item) => item.status === 'ready'),
    add, remove, retry, take, restore,
  }
}

/** 输入框上方那一排待发的文件，加上要告诉人的话 */
export function PendingFiles({ items, notes, alert, onRemove, onRetry }: {
  items: PendingFile[]
  /** 平常的提醒（多出来的文件没加上、这位同事看不了图） */
  notes: string[]
  /** 出了岔子（没发出去） */
  alert: string | null
  onRemove: (key: string) => void
  onRetry: (key: string) => void
}) {
  const t = useT()
  if (!items.length && !notes.length && !alert) return null
  return (
    <div className="composer-files">
      {items.length ? (
        <ul className="pending-files">
          {items.map((item) => (
            <li key={item.key} className={`pending-file ${item.status}`}>
              {item.preview
                ? <img className="pending-thumb" src={item.preview} alt="" />
                : <span className="pending-icon" aria-hidden="true">📄</span>}
              <span className="pending-name">{item.file.name}</span>
              <span className="pending-meta" role={item.status === 'error' ? 'alert' : 'status'}>
                {item.status === 'uploading' ? t('files.uploading') : item.status === 'error' ? item.problem : humanSize(item.file.size)}
              </span>
              {item.status === 'error' && item.retry ? (
                <button type="button" className="pending-retry" onClick={() => onRetry(item.key)}>{t('files.retry')}</button>
              ) : null}
              <button
                type="button"
                className="pending-remove"
                aria-label={t('files.remove', { name: item.file.name })}
                title={t('files.remove', { name: item.file.name })}
                onClick={() => onRemove(item.key)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {notes.map((note) => <p key={note} className="composer-note" role="status">{note}</p>)}
      {alert ? <p className="composer-note composer-alert" role="alert">{alert}</p> : null}
    </div>
  )
}
