/**
 * 循环卫生守卫（借鉴 DeepSeek Harness repeat-tool-reminder）：
 * 检测同一回合内模型连续发起完全相同的工具调用（含失败/被拒调用），
 * 在达到阈值时注入温和→强提醒，及时打断原地打转的 token 消耗。
 */

export const DEFAULT_REPEAT_THRESHOLDS = [3, 5, 8] as const
export const DEFAULT_ARGUMENTS_PREVIEW_CHARS = 500

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      const entry = record[key]
      if (entry !== undefined) sorted[key] = sortJsonValue(entry)
    }
    return sorted
  }
  return value
}

/** 深度键排序规范化：属性顺序不同的等价参数对象产出完全相同的 key。 */
export function canonicalizeArgs(args: unknown): string {
  try {
    return JSON.stringify(sortJsonValue(args ?? null))
  } catch {
    return String(args)
  }
}

function previewArguments(canonical: string, cap: number): string {
  if (canonical.length <= cap) return canonical
  return `${canonical.slice(0, cap)}… (+${canonical.length - cap} more chars)`
}

const GENTLE_REMINDER =
  '[gateway] You are repeating the exact same tool call with identical arguments. '
  + 'Carefully review the previous result before calling again: if the task is not done, '
  + 'try a different approach or different arguments, ask your operator if blocked, or report what happened.'

function detailedReminder(toolName: string, count: number, preview: string): string {
  return `[gateway] Repeated tool call detected:\n`
    + `- tool: ${toolName}\n`
    + `- consecutive_calls: ${count}\n`
    + `- arguments: ${preview}\n`
    + 'Repeating this exact call is not making progress. Do not call this tool with these exact arguments again. '
    + 'Try a different action/arguments, call ask_operator if you need input, or report the blocker honestly.'
}

export type RepeatGuard = {
  /** 记录一次工具调用；达到提醒阈值时返回给模型的提醒文本，否则返回 null。 */
  observe(toolName: string, args: unknown, previewArgs?: unknown): string | null
  /** 重置连续计数（例如外部上下文变化时）。 */
  reset(): void
}

export function createRepeatGuard(opts: {
  thresholds?: readonly number[]
  previewChars?: number
} = {}): RepeatGuard {
  const raw = opts.thresholds ?? DEFAULT_REPEAT_THRESHOLDS
  const thresholds = [...new Set(raw.filter((n) => Number.isInteger(n) && n >= 2))].sort((a, b) => a - b)
  const thresholdSet = new Set(thresholds)
  const previewChars = Math.max(1, Math.floor(opts.previewChars ?? DEFAULT_ARGUMENTS_PREVIEW_CHARS))
  let lastKey: string | null = null
  let count = 0

  return {
    observe(toolName, args, previewArgs) {
      if (!thresholds.length) return null
      const canonical = canonicalizeArgs(args)
      const key = JSON.stringify([toolName, canonical])
      if (key === lastKey) {
        count++
      } else {
        lastKey = key
        count = 1
      }
      if (!thresholdSet.has(count)) return null
      return count === thresholds[0]
        ? GENTLE_REMINDER
        : detailedReminder(toolName, count, previewArguments(canonicalizeArgs(previewArgs === undefined ? args : previewArgs), previewChars))
    },
    reset() {
      lastKey = null
      count = 0
    },
  }
}
