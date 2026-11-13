import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import type {
  ActivityPayload, ApprovalPayload, ApprovalResolvedPayload, AttachmentPayload, BotRefPayload, Conversation, LoginPayload, MemoryPayload,
  Message, QuestionPayload, ReportPayload, RoutinePayload, RuleDuration, ScreenshotPayload, WebhookPayload,
} from '../types'
import { ApiError } from '../api'
import { ACCEPT, isImageType } from '../attachments'
import { useT, type T } from '../i18n'
import { errorText, isNotice, noticeText } from '../i18n/describe'
import { ActivityChip } from './ActivityChip'
import { ApprovalChip } from './ApprovalChip'
import { AttachmentChip } from './AttachmentChip'
import { BotAvatar, conversationSeed } from './BotAvatar'
import { BotRefChip } from './BotRefChip'
import { PendingFiles, usePendingFiles, type FilesIO } from './ComposerFiles'
import { ConfirmDialog } from './ConfirmDialog'
import { ArrowDownIcon, ArrowUpIcon, AtSignIcon, MonitorIcon, PaperclipIcon, SidebarIcon, StopSquareIcon } from './Icons'
import { Lightbox, type LightboxImage } from './Lightbox'
import { LoginChip } from './LoginChip'
import { Markdown } from './Markdown'
import { MemoryChip } from './MemoryChip'
import { QuestionChip } from './QuestionChip'
import { ReportChip } from './ReportChip'
import { RoutineChip } from './RoutineChip'
import { ScreenshotChip } from './ScreenshotChip'
import { WebhookChip } from './WebhookChip'

/** 停顿超过这么久，下一条消息前再标一次时间；连珠炮式的往来只在开头标一次。 */
const TIME_GAP_MS = 5 * 60_000
const dayKey = (ts: number) => new Date(ts).toDateString()

function dayLabel(ts: number, now: Date, t: T): string {
  const key = dayKey(ts)
  if (key === now.toDateString()) return t('thread.today')
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (key === yesterday.toDateString()) return t('thread.yesterday')
  const day = new Date(ts)
  return day.toLocaleDateString(t.locale, {
    weekday: 'short', month: 'short', day: 'numeric',
    ...(day.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  })
}

const timeLabel = (ts: number, locale: string | undefined) =>
  new Date(ts).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })

type Mention = { id: string; name: string; emoji: string }

/** 光标前正在打的 `@查询`：行首、空白或左括号后面的 @，一直到光标，中间没有空白 */
const MENTION_QUERY = /(?:^|[\s(（])@([^\s@]*)$/u

function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = MENTION_QUERY.exec(text.slice(0, caret))
  return m ? { start: caret - m[1]!.length - 1, query: m[1]! } : null
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 选过的人名还在正文里（没被删掉、也不是更长名字的一截），才算点了名 */
const stillMentioned = (text: string, name: string) =>
  new RegExp(`(?:^|[\\s(（])@${escapeRe(name)}(?![\\p{L}\\p{N}])`, 'u').test(text)

/** 拖进来的是不是文件（拖一段选中的文字、一个链接不算） */
const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')

export function Thread({
  conversation, messages, thinking, onSend, onDecide, onAnswer, roster,
  onOpenScreen, onToggleScreen, panelOpen, onStop, headerExtra, banner, files, onToggleSidebar,
}: {
  conversation: Conversation
  messages: Message[]
  thinking: boolean
  /**
   * mentions：群里点了名的同事 id，没点名就是整个群；attachments：一起发的文件（上传得到的 id）。
   * 回一个 Promise 的话，它失败了就把字和文件放回输入框，并说明没发出去。
   */
  onSend: (text: string, mentions?: string[], attachments?: string[]) => void | Promise<void>
  onDecide: (approvalId: number, decision: 'approve' | 'discard', remember?: RuleDuration, items?: number[]) => void | Promise<void>
  /** 问题卡片上点了选项 */
  onAnswer?: (messageId: number, choices: string[]) => void | Promise<void>
  roster: Record<string, { name: string; emoji: string }>
  onOpenScreen?: () => void
  onToggleScreen?: () => void
  panelOpen?: boolean
  onStop?: () => void
  /** 标题栏右侧多放的东西（比如这位同事用哪个 AI） */
  headerExtra?: ReactNode
  /** 标题栏下面一条横幅（比如演示模式） */
  banner?: ReactNode
  /** 发文件：给了才有回形针、粘贴和拖放 */
  files?: FilesIO
  /** 窄窗口下展开侧栏抽屉 */
  onToggleSidebar?: () => void
}) {
  const t = useT()
  const [draft, setDraft] = useState('')
  const pending = usePendingFiles(conversation.id, files)
  const pickerRef = useRef<HTMLInputElement>(null)
  const [dropping, setDropping] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<LightboxImage | null>(null)
  const [confirmFile, setConfirmFile] = useState<AttachmentPayload | null>(null)
  const [unpinned, setUnpinned] = useState(false)
  const [hasNewBelow, setHasNewBelow] = useState(false)
  const prevMsgCount = useRef(messages.length)

  useEffect(() => {
    setSendError(null)
    setDropping(false)
    setLightbox(null)
    setConfirmFile(null)
    setUnpinned(false)
    setHasNewBelow(false)
    prevMsgCount.current = 0
  }, [conversation.id])

  const scrollRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)
  // 群里打 @ 点名：光标位置决定在补全哪一段；Esc 关掉的那一个 @ 不再弹，换一个 @ 才弹
  const [caret, setCaret] = useState(0)
  const [picked, setPicked] = useState<Mention[]>([])
  const [active, setActive] = useState(0)
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const menuId = useId()
  useEffect(() => { setPicked([]) }, [conversation.id])
  // 选中一位后把光标放回名字后面：要在 React 换掉文本之后、下一次按键之前，所以用 layout effect 而不是下一帧
  const caretAfterPick = useRef<number | null>(null)
  useLayoutEffect(() => {
    const at = caretAfterPick.current
    if (at === null) return
    caretAfterPick.current = null
    boxRef.current?.setSelectionRange(at, at)
  }, [draft])

  const members: Mention[] = conversation.kind === 'group'
    ? conversation.members.map((id) => ({ id, name: roster[id]?.name ?? id, emoji: roster[id]?.emoji ?? '' }))
    : []
  const query = members.length ? mentionQuery(draft, caret) : null
  const candidates = query && query.start !== dismissedAt
    ? members.filter((m) => {
      const q = query.query.toLowerCase()
      return m.name.toLowerCase().includes(q) || m.id.startsWith(q)
    }).slice(0, 8)
    : []
  const menuOpen = candidates.length > 0
  // Esc 只关掉那一个 @：删掉它以后再打的 @ 照样弹
  const queryStart = query?.start ?? null
  useEffect(() => { if (queryStart === null) setDismissedAt(null) }, [queryStart])
  const current = Math.min(active, Math.max(candidates.length - 1, 0))
  // 往上翻着看历史时，新消息不该把人拽回底部；换了线程就重新贴底
  const pinned = useRef(true)
  useEffect(() => { pinned.current = true }, [conversation.id])

  useEffect(() => {
    const el = scrollRef.current
    if (el && pinned.current) {
      el.scrollTop = el.scrollHeight
    } else if (!pinned.current && messages.length > prevMsgCount.current) {
      setHasNewBelow(true)
    }
    prevMsgCount.current = messages.length
  }, [messages, thinking])

  const jumpToBottom = () => {
    const el = scrollRef.current
    pinned.current = true
    setUnpinned(false)
    setHasNewBelow(false)
    if (!el) return
    if (typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    else el.scrollTop = el.scrollHeight
  }

  // 输入框随内容长高，最多八行左右
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    box.style.height = 'auto'
    // border-box：高度要把上下边框也算进去，否则会凭空冒出滚动条
    const wanted = box.scrollHeight + box.offsetHeight - box.clientHeight
    box.style.height = `${Math.min(wanted, 180)}px`
    box.style.overflowY = wanted > 180 ? 'auto' : 'hidden'
  }, [draft])

  // 有字或者有传好的文件就能发；还有文件在传就等它，免得一半走了一半没走
  const canSend = !pending.uploading && (draft.trim() !== '' || pending.ready.length > 0)

  const submit = () => {
    if (!canSend) return
    const text = draft.trim()
    const named = picked
    const mentions = named.filter((m) => stillMentioned(text, m.name)).map((m) => m.id)
    const taken = pending.take()
    const ids = taken.flatMap((f) => (f.upload ? [f.upload.id] : []))
    setDraft('')
    setPicked([])
    setDismissedAt(null)
    setSendError(null)
    pinned.current = true
    setUnpinned(false)
    setHasNewBelow(false)
    const result = ids.length ? onSend(text, mentions.length ? mentions : undefined, ids)
      : mentions.length ? onSend(text, mentions) : onSend(text)
    // 没发出去：把字、点过的名和文件放回来，说清原因，别让人以为发了
    void Promise.resolve(result).catch((err: unknown) => {
      setDraft((now) => now || text)
      setPicked((now) => (now.length ? now : named))
      pending.restore(taken)
      const reason = err instanceof ApiError ? errorText(t, err) : err instanceof Error ? err.message : String(err)
      setSendError(t('thread.notSent', { reason }))
    })
  }

  const triggerMention = () => {
    const box = boxRef.current
    const pos = box?.selectionStart ?? draft.length
    const before = draft.slice(0, pos)
    const after = draft.slice(pos)
    const prefix = before.length > 0 && !/[\s(（]$/.test(before) ? ' @' : '@'
    const nextPos = before.length + prefix.length
    setDismissedAt(null)
    setDraft(before + prefix + after)
    setCaret(nextPos)
    caretAfterPick.current = nextPos
    box?.focus()
  }

  const onDrag = (e: DragEvent<HTMLElement>) => {
    if (!files || !carriesFiles(e)) return
    e.preventDefault()
    if (e.type === 'dragleave') {
      // 只有真离开这块区域才收起提示；在里面的子元素之间移动也会冒 dragleave
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
      return
    }
    setDropping(true)
  }
  const onDrop = (e: DragEvent<HTMLElement>) => {
    if (!files || !carriesFiles(e)) return
    e.preventDefault()
    setDropping(false)
    pending.add(Array.from(e.dataTransfer.files))
  }
  const notes = [
    ...(pending.notice ? [pending.notice] : []),
    // 单聊里才知道是哪位同事的模型：它看不了图也照样收得到文件，只是得让人心里有数
    ...(files?.seesImages === false && pending.items.some((f) => f.status !== 'error' && f.mime && isImageType(f.mime))
      ? [t('files.blind', { name: conversation.title })] : []),
  ]

  const pick = (m: Mention) => {
    if (!query) return
    const before = draft.slice(0, query.start)
    const insert = `@${m.name} `
    const after = draft.slice(caret).replace(/^ /, '')
    const at = before.length + insert.length
    setDraft(before + insert + after)
    setPicked((p) => (p.some((x) => x.id === m.id) ? p : [...p, m]))
    setActive(0)
    setCaret(at)
    caretAfterPick.current = at
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法正在选字时的回车是「上屏」，不是「发送」；Safari 在 compositionend 之后才补发 keyCode 229
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (menuOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const step = e.key === 'ArrowDown' ? 1 : -1
        setActive((current + step + candidates.length) % candidates.length)
        return
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault()
        pick(candidates[current]!)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissedAt(query!.start)
        return
      }
    }
    if (e.key !== 'Enter' || e.shiftKey) return
    e.preventDefault()
    submit()
  }

  const renderBody = (m: Message) => {
    // 网关替同事说的固定话：按界面语言重说；收尾时同事自己交代的几行照原样（markdown）放在前面
    if (m.kind === 'text' && isNotice(m.payload)) {
      const n = m.payload
      return (
        <div className="bubble markdown">
          {n.notice === 'paused' && n.lead ? <Markdown text={n.lead} /> : null}
          <p>{noticeText(t, n)}</p>
        </div>
      )
    }
    // 同事的话按 markdown 显示（模型天然写 markdown）；你自己打的字照原样显示，星号就是星号
    if (!m.payload) {
      return m.sender === 'user'
        ? <div className="bubble">{m.content}</div>
        : <div className="bubble markdown"><Markdown text={m.content} /></div>
    }
    switch (m.kind) {
      case 'report': return <ReportChip payload={m.payload as ReportPayload} />
      case 'screenshot': return <ScreenshotChip payload={m.payload as ScreenshotPayload} onPreview={setLightbox} />
      case 'approval_request': return <ApprovalChip payload={m.payload as ApprovalPayload} onDecide={onDecide} />
      case 'memory_updated': return <MemoryChip payload={m.payload as MemoryPayload} />
      case 'routine_created': return <RoutineChip payload={m.payload as RoutinePayload} />
      case 'bot_ref': return <BotRefChip payload={m.payload as BotRefPayload} />
      case 'login_request':
        return <LoginChip payload={m.payload as LoginPayload} onOpenScreen={() => onOpenScreen?.()} />
      case 'activity': return <ActivityChip payload={m.payload as ActivityPayload} />
      case 'webhook': return <WebhookChip payload={m.payload as WebhookPayload} />
      case 'attachment':
        return (
          <AttachmentChip
            payload={m.payload as AttachmentPayload}
            onPreview={setLightbox}
            {...(files?.remove ? { onRemove: files.remove, onRequestRemove: setConfirmFile } : {})}
          />
        )
      case 'question':
        return <QuestionChip payload={m.payload as QuestionPayload} onAnswer={(choices) => onAnswer?.(m.id, choices)} />
      case 'approval_resolved': {
        const p = m.payload as ApprovalResolvedPayload
        return (
          <div className="decision">
            {p.decision === 'approve' ? `✓ ${t('thread.approved')}` : `✕ ${t('thread.discarded')}`} · {p.action}
            {p.count ? ` · ${t('thread.itemsOf', { approved: p.count.approved, of: p.count.of })}` : ''}
            {p.remembered ? ` · ${t('thread.ruleSaved', { scope: `${p.remembered.kind} → ${p.remembered.target}` })}` : ''}
          </div>
        )
      }
      default: return <div className="bubble">{m.content}</div>
    }
  }

  const rowClass = (m: Message) =>
    m.kind === 'approval_resolved' ? 'centered' : m.sender === 'user' ? 'from-user' : 'from-bot'

  // 群里必须看得出谁在说话；单聊只有一个对象，加名字反而是噪音
  const speakerOf = (m: Message) =>
    conversation.kind === 'group' && m.sender !== 'user' && m.kind !== 'approval_resolved'
      ? roster[m.sender]
      : undefined

  const now = new Date()
  const starters = conversation.kind === 'group'
    ? [t('thread.starter.group1'), t('thread.starter.group2')]
    : [t('thread.starter.dm1'), t('thread.starter.dm2')]

  return (
    <main
      className={dropping ? 'thread thread-dropping' : 'thread'}
      onDragEnter={onDrag}
      onDragOver={onDrag}
      onDragLeave={onDrag}
      onDrop={onDrop}
    >
      {dropping ? <div className="drop-hint" role="status">{t('thread.dropHere', { name: conversation.title })}</div> : null}
      <header className="thread-header">
        {onToggleSidebar ? (
          <button
            type="button"
            className="mobile-menu-btn"
            onClick={onToggleSidebar}
            aria-label={t('sidebar.toggle')}
            title={t('sidebar.toggle')}
          >
            <SidebarIcon size={15} />
          </button>
        ) : null}
        <BotAvatar seed={conversationSeed(conversation)} emoji={conversation.emoji} />
        <div className="thread-heading">
          <span className="thread-name">{conversation.title}</span>
          {conversation.subtitle ? <span className="thread-role">{conversation.subtitle}</span> : null}
        </div>
        <span className="thread-header-spacer" />
        {headerExtra}
        {conversation.kind === 'dm' && (onToggleScreen ?? onOpenScreen) ? (
          <button
            type="button"
            className={`screen-button${panelOpen ? ' active' : ''}`}
            onClick={onToggleScreen ?? onOpenScreen}
            aria-label={t('thread.openComputer')}
            aria-pressed={Boolean(panelOpen)}
            title={panelOpen ? t('thread.closeComputer') : t('thread.openComputer')}
          >
            <MonitorIcon size={15} />
          </button>
        ) : null}
      </header>
      {banner}
      <div
        className="thread-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          pinned.current = nearBottom
          setUnpinned(!nearBottom)
          if (nearBottom) setHasNewBelow(false)
        }}
      >
        {messages.length === 0 && !thinking ? (
          <div className="thread-welcome">
            <div className="thread-welcome-avatar">
              <BotAvatar seed={conversationSeed(conversation)} emoji={conversation.emoji} size="xl" />
            </div>
            <div className="thread-welcome-hint">
              {t(conversation.kind === 'group' ? 'thread.empty.groupHint' : 'thread.empty.dmHint')}
            </div>
            <div className="thread-starters">
              {starters.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="starter-chip"
                  onClick={() => void onSend(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {messages.map((m, i) => {
          const prev = messages[i - 1]
          const next = messages[i + 1]
          const newDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at)
          const showTime = newDay || m.created_at - prev.created_at > TIME_GAP_MS
          const speaker = speakerOf(m)
          const sameSpeakerNext = Boolean(
            next && next.sender === m.sender && m.sender !== 'user' && m.kind !== 'approval_resolved'
            && next.kind !== 'approval_resolved' && dayKey(next.created_at) === dayKey(m.created_at)
            && next.created_at - m.created_at <= TIME_GAP_MS,
          )
          const at = new Date(m.created_at)
          return (
            <Fragment key={m.id}>
              {newDay ? <div className="day-divider" role="separator">{dayLabel(m.created_at, now, t)}</div> : null}
              <div className={`row ${rowClass(m)}${sameSpeakerNext ? ' row-grouped' : ''}`}>
                <div className="row-inner">
                  {speaker || showTime ? (
                    <div className="row-meta">
                      {speaker ? (
                        <span className="speaker">
                          <BotAvatar seed={m.sender} emoji={speaker.emoji} size="xs" />
                          <span className="speaker-name">{speaker.name}</span>
                        </span>
                      ) : null}
                      {showTime ? (
                        <time className="row-time" dateTime={at.toISOString()} title={at.toLocaleString(t.locale)}>
                          {timeLabel(m.created_at, t.locale)}
                        </time>
                      ) : null}
                    </div>
                  ) : null}
                  {renderBody(m)}
                </div>
              </div>
            </Fragment>
          )
        })}
        {thinking ? <div className="row from-bot"><div className="bubble typing">•••</div></div> : null}
      </div>

      <footer className="composer">
        {unpinned && messages.length > 0 ? (
          <button
            type="button"
            className={`jump-latest${hasNewBelow ? ' unread' : ''}`}
            onClick={jumpToBottom}
          >
            <ArrowDownIcon size={13} />
            <span>{t(hasNewBelow ? 'thread.newBelow' : 'thread.jumpLatest')}</span>
          </button>
        ) : null}
        {menuOpen ? (
          <ul className="mention-menu" id={menuId} role="listbox" aria-label={t('thread.mentionList')}>
            {candidates.map((m, i) => (
              <li
                key={m.id}
                id={`${menuId}-${i}`}
                role="option"
                aria-selected={i === current}
                className={i === current ? 'active' : undefined}
                // mousedown 而不是 click：不让输入框先失焦
                onMouseDown={(e) => { e.preventDefault(); pick(m) }}
                onMouseEnter={() => setActive(i)}
              >
                <BotAvatar seed={m.id} emoji={m.emoji} size="sm" />
                <span className="mention-name">{m.name}</span>
                <span className="mention-id">@{m.id}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="composer-box">
          <PendingFiles items={pending.items} notes={notes} alert={sendError} onRemove={pending.remove} onRetry={pending.retry} />
          <textarea
            ref={boxRef}
            rows={1}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              setCaret(e.target.selectionStart ?? e.target.value.length)
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              // 粘贴的是文件（截图、从访达复制的图）就当附件；粘贴文字照常
              const pasted = files ? Array.from(e.clipboardData?.files ?? []) : []
              if (!pasted.length) return
              e.preventDefault()
              pending.add(pasted)
            }}
            aria-autocomplete={members.length ? 'list' : undefined}
            aria-controls={menuOpen ? menuId : undefined}
            aria-activedescendant={menuOpen ? `${menuId}-${current}` : undefined}
            placeholder={members.length
              ? t('thread.placeholderGroup', { name: conversation.title })
              : t('thread.placeholder', { name: conversation.title })}
          />
          <div className="composer-toolbar">
            <div className="composer-tools-left">
              {files ? (
                <>
                  <input
                    ref={pickerRef}
                    type="file"
                    multiple
                    hidden
                    accept={ACCEPT}
                    onChange={(e) => {
                      pending.add(Array.from(e.target.files ?? []))
                      e.target.value = '' // 同一个文件拿掉以后还能再选一次
                    }}
                  />
                  <button
                    type="button"
                    className="composer-attach"
                    onClick={() => pickerRef.current?.click()}
                    aria-label={t('thread.attach')}
                    title={t('thread.attachTitle')}
                  >
                    <PaperclipIcon size={15} />
                  </button>
                </>
              ) : null}
              {members.length > 0 ? (
                <button
                  type="button"
                  className="composer-mention-btn"
                  onClick={triggerMention}
                  aria-label={t('thread.mentionButton')}
                  title={t('thread.mentionButton')}
                >
                  <AtSignIcon size={15} />
                </button>
              ) : null}
            </div>
            <div className="composer-tools-right">
              <span className="composer-shortcut" title={t('thread.sendHint')} aria-hidden="true">↵</span>
              {thinking && onStop ? (
                <button
                  type="button"
                  className="composer-stop"
                  onClick={onStop}
                  aria-label={t('thread.stop')}
                  title={t('thread.stopTitle')}
                >
                  <StopSquareIcon size={12} />
                </button>
              ) : null}
              <button
                type="button"
                className="composer-send"
                onClick={submit}
                disabled={!canSend}
                aria-label={t('thread.send')}
                title={pending.uploading ? t('thread.sendWaiting') : t('thread.send')}
              >
                <ArrowUpIcon size={15} />
              </button>
            </div>
          </div>
        </div>
      </footer>

      {lightbox ? <Lightbox image={lightbox} onClose={() => setLightbox(null)} /> : null}
      {confirmFile && files?.remove ? (
        <ConfirmDialog
          message={t('file.removeConfirm', { name: confirmFile.name })}
          confirmLabel={t('confirm.remove')}
          cancelLabel={t('confirm.cancel')}
          onConfirm={() => {
            const id = confirmFile.id
            setConfirmFile(null)
            files.remove?.(id)
          }}
          onCancel={() => setConfirmFile(null)}
        />
      ) : null}
    </main>
  )
}
