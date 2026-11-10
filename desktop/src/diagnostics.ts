/**
 * 「复制诊断信息」复制的那段文字：发 issue 时贴上就够人看懂出了什么事。
 * 令牌、key 一类的东西就算混进了日志也抹掉——这段文字是要贴到网上的。
 */
export type DiagnosticsInput = {
  appVersion: string
  electron: string
  platform: string
  arch: string
  osVersion: string
  dataDir: string
  logFile: string
  port: number
  reason: string
  detail?: string | undefined
  tail: string[]
}

const SECRETS: [RegExp, string][] = [
  [/(token=)[\w-]{8,}/gi, '$1<hidden>'],
  [/(Bearer\s+)[\w.-]{8,}/gi, '$1<hidden>'],
  [/\b(sk-[\w-]{4})[\w-]{8,}/g, '$1…<hidden>'],
  [/\b(xai-[\w-]{4})[\w-]{8,}/g, '$1…<hidden>'],
]

export function redact(text: string): string {
  return SECRETS.reduce((s, [re, to]) => s.replace(re, to), text)
}

export function diagnosticsText(d: DiagnosticsInput): string {
  return redact([
    `OpenSuperBot ${d.appVersion} (Electron ${d.electron}, ${d.platform} ${d.arch}, ${d.osVersion})`,
    `What happened: ${d.reason}${d.detail ? ` — ${d.detail}` : ''}`,
    `Port: ${d.port}`,
    `Data folder: ${d.dataDir}`,
    `Log file: ${d.logFile}`,
    '',
    `Last ${d.tail.length} log lines:`,
    ...d.tail,
  ].join('\n'))
}
