import type {
  ActivityPayload, ApprovalPayload, ApprovalResolvedPayload, AttachmentPayload, BotRefPayload, BotStatus, Conversation, LoginPayload,
  MemoryPayload, QuestionPayload, ReportPayload, RoutinePayload, ScreenshotPayload, WebhookPayload,
} from '../types'
import { useT, type MessageKey, type T } from '../i18n'
import { isNotice, noticeText } from '../i18n/describe'
import { BotAvatar, conversationSeed } from './BotAvatar'
import { useEscape } from './ConfirmDialog'
import { CpuSparkleIcon, PlusIcon, SettingsIcon } from './Icons'

/**
 * 单聊就是那位同事的状态。群只说「有人在干活」：等你、卡住、刚干完说的是某一位同事，
 * 该在它自己那一行出现，挂在群上会让人点进群里找一件不在群里的事。
 */
export function conversationState(c: Conversation, statuses: Record<string, BotStatus>): BotStatus {
  if (c.kind === 'dm') return statuses[c.members[0] ?? ''] ?? 'idle'
  return c.members.some((id) => statuses[id] === 'thinking') ? 'thinking' : 'idle'
}

const STATE_TEXT: Partial<Record<BotStatus, MessageKey>> = {
  thinking: 'sidebar.state.thinking', waiting: 'sidebar.state.waiting', blocked: 'sidebar.state.blocked', done: 'sidebar.state.done',
}

function sidebarTime(ts: number | undefined, locale: string | undefined, now = new Date()): string | null {
  // 测试里的假时间戳（1、3、9…）不是真实钟点，不标时间
  if (!ts || ts < 86_400_000) return null
  const at = new Date(ts)
  if (at.toDateString() === now.toDateString()) {
    return at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  }
  return at.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}

function preview(c: Conversation, t: T): string {
  const m = c.last_message
  if (!m) return t(c.kind === 'group' ? 'sidebar.empty.group' : 'sidebar.empty.dm')
  switch (m.kind) {
    case 'screenshot': {
      const caption = (m.payload as ScreenshotPayload | null)?.caption
      return `📷 ${caption || t('sidebar.preview.screenshot')}`
    }
    case 'approval_request': {
      const p = m.payload as ApprovalPayload | null
      return p?.rule
        ? `✓ ${t('sidebar.preview.byRule', { action: p.action })}`
        : `⏸ ${t('sidebar.preview.needsYou', { action: p?.action ?? t('sidebar.preview.anAction') })}`
    }
    case 'question': {
      const p = m.payload as QuestionPayload | null
      return p?.status === 'open' ? `❓ ${p.question}` : `✓ ${p?.answer?.join(', ') ?? p?.question ?? t('sidebar.preview.answered')}`
    }
    case 'approval_resolved': {
      const p = m.payload as ApprovalResolvedPayload | null
      return `${p?.decision === 'approve' ? '✓' : '✕'} ${p?.action ?? t('sidebar.preview.decided')}`
    }
    case 'memory_updated': {
      const p = m.payload as MemoryPayload | null
      if (!p?.rule) return `🧠 ${t('sidebar.preview.memoryUpdated')}`
      return `🧠 ${p.removed ? t('sidebar.preview.forgot', { rule: p.rule }) : p.rule}`
    }
    case 'attachment':
      return `📎 ${(m.payload as AttachmentPayload | null)?.name ?? t('sidebar.preview.file')}`
    case 'routine_created':
      return `🕐 ${(m.payload as RoutinePayload | null)?.name ?? t('sidebar.preview.routineCreated')}`
    case 'bot_ref':
      return `↪ ${t('sidebar.preview.from', { name: (m.payload as BotRefPayload | null)?.fromName ?? t('sidebar.preview.aTeammate') })}`
    case 'webhook':
      return `⇣ ${t('sidebar.preview.webhook', { name: (m.payload as WebhookPayload | null)?.name ?? t('sidebar.preview.aRoutine') })}`
    case 'login_request':
      return `🔑 ${t('sidebar.preview.signIn', { site: (m.payload as LoginPayload | null)?.site ?? t('sidebar.preview.aSite') })}`
    case 'activity': {
      const steps = (m.payload as ActivityPayload | null)?.steps ?? []
      const last = steps[steps.length - 1]
      return last ? `⚙ ${last.tool} ${last.summary}` : `⚙ ${t('sidebar.preview.working')}`
    }
    case 'report': {
      const payload = m.payload as ReportPayload | null
      const first = payload?.lines[0]
      return payload?.closing ?? (first ? `✓ ${first.system} → ${first.result}` : t('sidebar.preview.reportFiled'))
    }
    default:
      if (m.kind === 'text' && isNotice(m.payload)) {
        const n = m.payload
        return n.notice === 'paused' && n.lead ? n.lead : noticeText(t, n)
      }
      return m.content
  }
}

export function Sidebar({ conversations, selectedId, statuses, onSelect, onNewBot, onModels, onSettings, open, onClose }: {
  conversations: Conversation[]
  selectedId: string | null
  statuses: Record<string, BotStatus>
  onSelect: (id: string) => void
  onNewBot: () => void
  /** 打开「AI 模型」；老网关没有这块就不传，按钮也不出现 */
  onModels?: () => void
  /** 打开设置页；老网关没有设置路由就不传 */
  onSettings?: () => void
  /** 窄窗口下侧栏抽屉是否展开 */
  open?: boolean
  onClose?: () => void
}) {
  const t = useT()
  useEscape(open ? onClose : undefined)
  const stateText = (state: BotStatus) => { const key = STATE_TEXT[state]; return key ? t(key) : undefined }
  const now = new Date()
  const dms = conversations.filter((c) => c.kind === 'dm')
  const groups = conversations.filter((c) => c.kind === 'group')

  const renderRow = (c: Conversation) => {
    const state = conversationState(c, statuses)
    // 有角标（待批、待答）就已经在说「等你」了；没有角标的等待（比如请你登录）才单独标一句
    const note = state === 'blocked' || state === 'done' || (state === 'waiting' && c.pending === 0)
      ? stateText(state)
      : undefined
    const stamp = sidebarTime(c.last_message?.created_at, t.locale, now)
    return (
      <button
        key={c.id}
        type="button"
        className={`sidebar-item${c.id === selectedId ? ' selected' : ''}`}
        onClick={() => { onSelect(c.id); onClose?.() }}
      >
        <BotAvatar seed={conversationSeed(c)} emoji={c.emoji} size="lg" state={state} title={stateText(state)} />
        <span className="sidebar-text">
          <span className="sidebar-head">
            <span className="sidebar-name">
              <span className="sidebar-name-label">{c.title}{state === 'thinking' ? ' …' : ''}</span>
              {note ? <span className={`sidebar-state ${state}`}>{note}</span> : null}
            </span>
            {c.pending === 0 && stamp ? <span className="sidebar-time">{stamp}</span> : null}
          </span>
          <span className="sidebar-preview">{preview(c, t)}</span>
        </span>
        {c.pending > 0 ? (
          <span className="sidebar-badge" aria-label={t('sidebar.waitingOnYou', { count: c.pending })}>{c.pending}</span>
        ) : null}
      </button>
    )
  }

  return (
    <>
      {open ? <div className="sidebar-scrim" onClick={onClose} aria-hidden="true" /> : null}
      <aside className={`sidebar${open ? ' open' : ''}`}>
        <div className="sidebar-title">
          <span className="sidebar-brand">
            <span className="sidebar-brand-mark" aria-hidden="true" />
            <span>OpenSuperBot</span>
          </span>
        </div>

        <div className="sidebar-list">
          <div className="sidebar-section">
            <div className="sidebar-section-head">
              <span className="sidebar-section-label">{t('sidebar.section.teammates')}</span>
              <button
                type="button"
                className="sidebar-new"
                onClick={() => { onClose?.(); onNewBot() }}
                aria-label={t('sidebar.hire')}
                title={t('sidebar.hire')}
              >
                <PlusIcon size={13} />
              </button>
            </div>
            {dms.map(renderRow)}
          </div>

          {groups.length > 0 ? (
            <div className="sidebar-section">
              <div className="sidebar-section-head">
                <span className="sidebar-section-label">{t('sidebar.section.rooms')}</span>
              </div>
              {groups.map(renderRow)}
            </div>
          ) : null}
        </div>

        {onModels || onSettings ? (
          <div className="sidebar-footer">
            {onModels ? (
              <button
                type="button"
                className="sidebar-foot-btn sidebar-models"
                onClick={() => { onClose?.(); onModels() }}
                aria-label={t('sidebar.models')}
                title={t('sidebar.models')}
              >
                <CpuSparkleIcon size={14} />
                <span>{t('sidebar.models')}</span>
              </button>
            ) : <span className="spacer" />}
            {onSettings ? (
              <button
                type="button"
                className="sidebar-foot-icon"
                onClick={() => { onClose?.(); onSettings() }}
                aria-label={t('sidebar.settings')}
                title={t('sidebar.settings')}
              >
                <SettingsIcon size={15} />
              </button>
            ) : null}
          </div>
        ) : null}
      </aside>
    </>
  )
}
