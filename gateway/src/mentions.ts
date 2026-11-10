/**
 * 群里点名：只叫被 @ 的同事作答。
 *
 * 两个来源合在一起：请求里显式的 `mentions`（同事 id），和操作者正文里写的 `@id`。
 * 正文只认 id 原样（小写字母、数字、连字符），不猜显示名——名字可以是任何语言、可以带空格，`@名字` 在正文里是歧义的。
 * 显式列出的 id 必须是这个群的成员，否则整条请求作废；正文里的 `@xxx` 不是成员就当普通文字。
 */

/** 前面不能紧挨字母数字（排除邮箱 a@b），后面不能再接 id 字符（`@chiefX` 不是 `@chief`） */
const MENTION = /(?<![\p{L}\p{N}_@.-])@([a-z0-9]+(?:-[a-z0-9]+)*)(?![\p{L}\p{N}_-])/gu

/** 一条消息最多点这么多名；再多就是写错了，不是在点名 */
export const MAX_MENTIONS = 50

export function mentionedInText(text: string): string[] {
  return [...text.matchAll(MENTION)].map((m) => m[1]!)
}

export type MentionResult = { ok: true; ids: string[] } | { ok: false; error: string; code: string; params?: Record<string, string> }

/**
 * 算出这一轮该叫谁。返回的 id 按成员在群里的顺序排、去重；空数组 = 没点名，整群照旧作答。
 * `members` 是这个群的成员 id（单聊传空数组：单聊里点名没有意义）。
 */
export function resolveMentions(explicit: unknown, text: string, members: string[]): MentionResult {
  if (explicit !== undefined && explicit !== null) {
    if (!Array.isArray(explicit) || !explicit.every((id) => typeof id === 'string')) {
      return { ok: false, error: 'mentions must be a list of teammate ids', code: 'mentions_invalid' }
    }
    if (explicit.length > MAX_MENTIONS) {
      return { ok: false, error: `mentions can name at most ${MAX_MENTIONS} teammates`, code: 'mentions_invalid' }
    }
    const stranger = explicit.find((id) => !members.includes(id))
    if (stranger !== undefined) {
      return members.length
        ? { ok: false, error: `${stranger} is not a member of this thread`, code: 'mention_not_member', params: { id: stranger } }
        : { ok: false, error: 'mentions only apply to group threads', code: 'mentions_not_group' }
    }
  }
  const named = new Set<string>([...((explicit as string[] | undefined | null) ?? []), ...mentionedInText(text)])
  return { ok: true, ids: members.filter((id) => named.has(id)) }
}
