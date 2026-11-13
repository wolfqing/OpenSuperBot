/**
 * 启动时查一次有没有新版本（不自动下载、不自动安装——首版没公证，用户自己去 GitHub 下）。
 * 先问本地网关 /api/settings：checkUpdates 关着或者没读到，就一个外部请求都不发。
 */

export const RELEASES_API_URL = 'https://api.github.com/repos/wolfqing/OpenSuperBot/releases/latest'
export const RELEASES_PAGE_PREFIX = 'https://github.com/wolfqing/OpenSuperBot/releases/'

export type AvailableUpdate = { version: string; url: string }

const STABLE_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const CURRENT_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * latestTag 是更新的正式版就返回去掉 v 的版本号（如 "0.7.0"），否则 null。
 * 预发布（-rc、-beta）和奇怪的名字一律跳过：版本号会直接进托盘菜单和界面。
 */
export function newerVersion(current: string, latestTag: string): string | null {
  const cleanLatest = latestTag.replace(/^[vV]/, '')
  const lm = STABLE_RE.exec(cleanLatest)
  const cm = CURRENT_RE.exec(current.replace(/^[vV]/, ''))
  if (!lm || !cm) return null
  const l = [Number(lm[1]), Number(lm[2]), Number(lm[3])] as const
  const c = [Number(cm[1]), Number(cm[2]), Number(cm[3])] as const
  for (let i = 0; i < 3; i++) {
    if (l[i]! > c[i]!) return cleanLatest
    if (l[i]! < c[i]!) return null
  }
  // 数字一样时，只有当前带 -dev 等预发布后缀才算正式版更新
  return cm[4] ? cleanLatest : null
}

/** 校验 GitHub releases/latest 的返回体；下载页地址必须是本仓库 HTTPS 的 releases 页 */
export function parseReleasePayload(data: unknown, currentVersion: string): AvailableUpdate | null {
  if (!data || typeof data !== 'object') return null
  const r = data as Record<string, unknown>
  if (r.draft === true || r.prerelease === true) return null
  if (typeof r.tag_name !== 'string' || typeof r.html_url !== 'string' || r.html_url.length > 512) return null
  const version = newerVersion(currentVersion, r.tag_name)
  if (!version) return null
  try {
    const u = new URL(r.html_url)
    if (u.protocol !== 'https:' || u.origin !== 'https://github.com' || !r.html_url.startsWith(RELEASES_PAGE_PREFIX)) return null
  } catch {
    return null
  }
  return { version, url: r.html_url }
}

export async function checkForUpdate(opts: {
  currentVersion: string
  gatewayBase: string
  token: string
  releasesUrl?: string
  fetchImpl?: typeof fetch
  log?: (line: string) => void
}): Promise<AvailableUpdate | null> {
  const fetchFn = opts.fetchImpl ?? fetch
  try {
    const settingsRes = await fetchFn(`${opts.gatewayBase}/api/settings`, {
      headers: { authorization: `Bearer ${opts.token}` },
      signal: AbortSignal.timeout(2_000),
    })
    if (!settingsRes.ok) return null
    const settings = (await settingsRes.json()) as { values?: { checkUpdates?: unknown } }
    if (typeof settings?.values?.checkUpdates !== 'boolean') return null
    if (!settings.values.checkUpdates) {
      opts.log?.('update check is turned off in settings')
      return null
    }
  } catch {
    return null
  }

  try {
    const res = await fetchFn(opts.releasesUrl ?? RELEASES_API_URL, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `OpenSuperBot/${opts.currentVersion}`,
      },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) {
      opts.log?.(`update check skipped (HTTP ${res.status})`)
      return null
    }
    const found = parseReleasePayload(await res.json(), opts.currentVersion)
    if (found) opts.log?.(`update available: ${found.version}`)
    return found
  } catch (err) {
    opts.log?.(`update check skipped (${err instanceof Error ? err.message : String(err)})`)
    return null
  }
}
