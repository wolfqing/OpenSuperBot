import { useEffect, useId, useRef } from 'react'

/** 栈式 Esc 处理：最后挂上的弹层先接住 Esc，关掉自己，不把底下的窗口一并关了 */
const escapeStack: (() => void)[] = []
let listening = false

function onWindowKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented || !escapeStack.length) return
  const top = escapeStack[escapeStack.length - 1]
  if (!top) return
  e.preventDefault()
  top()
}

export function useEscape(onEscape: (() => void) | undefined) {
  const ref = useRef(onEscape)
  ref.current = onEscape
  const active = Boolean(onEscape)
  useEffect(() => {
    if (!active) return
    const handler = () => ref.current?.()
    if (!listening) {
      window.addEventListener('keydown', onWindowKeyDown)
      listening = true
    }
    escapeStack.push(handler)
    return () => {
      const idx = escapeStack.lastIndexOf(handler)
      if (idx !== -1) escapeStack.splice(idx, 1)
      if (!escapeStack.length && listening) {
        window.removeEventListener('keydown', onWindowKeyDown)
        listening = false
      }
    }
  }, [active])
}

export function ConfirmDialog({ message, confirmLabel, cancelLabel, danger = true, onConfirm, onCancel }: {
  message: string
  confirmLabel: string
  cancelLabel: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const descId = useId()
  useEscape(onCancel)
  return (
    <div className="modal-scrim modal-scrim-top" onClick={onCancel}>
      <div
        className="modal confirm-modal"
        role="alertdialog"
        aria-modal="true"
        aria-describedby={descId}
        onClick={(e) => e.stopPropagation()}
      >
        <p id={descId} className="confirm-message">{message}</p>
        <div className="confirm-buttons">
          <button type="button" onClick={onCancel} autoFocus>{cancelLabel}</button>
          <button
            type="button"
            className={danger ? 'danger-solid' : 'primary'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
