import type { FailReason } from './supervisor.js'

/**
 * 网关还没起来时窗口里显示的两页：「正在启动」和「出错了」。都是 data: URL，不经网关、不带脚本以外的东西。
 * 错误页上的两个按钮是链接：`osb:retry`、`osb:logs`，主进程在 will-navigate 里接住，不用 preload。
 * 「复制诊断信息」只在页面里选中文字再复制（data: 页不是安全上下文，用不了 navigator.clipboard）。
 */
export type PageLang = 'en' | 'zh-CN'

const TEXT = {
  en: {
    starting: 'Starting OpenSuperBot…',
    startingHint: 'Your teammates’ gateway is coming up. This usually takes a second or two.',
    title: 'OpenSuperBot could not start',
    timeout: 'The gateway did not say it was ready within 30 seconds.',
    exited: 'The gateway stopped while it was starting.',
    crashed: 'The gateway stopped unexpectedly several times in a row, so it is no longer being restarted.',
    next: 'Try again. If it keeps happening, copy the diagnostics and open an issue on GitHub with them.',
    retry: 'Try again',
    copy: 'Copy diagnostics',
    copied: 'Copied',
    logs: 'Open the log folder',
    lastLines: 'Last lines of the log',
  },
  'zh-CN': {
    starting: '正在启动 OpenSuperBot…',
    startingHint: '同事们的网关正在起来，一般一两秒。',
    title: 'OpenSuperBot 没能启动',
    timeout: '网关 30 秒内没有说它准备好了。',
    exited: '网关在启动过程中退出了。',
    crashed: '网关接连意外退出了好几次，已经不再自动重启。',
    next: '先点「重试」。还不行的话，复制诊断信息，到 GitHub 上开一个 issue 贴上。',
    retry: '重试',
    copy: '复制诊断信息',
    copied: '已复制',
    logs: '打开日志所在文件夹',
    lastLines: '日志最后几行',
  },
} as const

export const pageLang = (locale: string): PageLang => (locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en')

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

const STYLE = `
:root { color-scheme: dark light; --bg: #0d0d0d; --card: #1a1a1a; --text: #ededed; --dim: #8f8f8f; --border: #2c2c2c; --red: #e5534b; }
@media (prefers-color-scheme: light) { :root { --bg: #f6f6f6; --card: #fff; --text: #161616; --dim: #5f5f5f; --border: #ddd; --red: #c93a33; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
  background: var(--bg); color: var(--text); font: 14px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif; }
.card { width: min(620px, 100%); background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 22px 24px; }
h1 { font-size: 17px; margin: 0 0 8px; }
p { margin: 0 0 10px; color: var(--dim); }
.why { color: var(--red); }
.buttons { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0; }
a.button, button { font: inherit; font-size: 13px; padding: 7px 12px; border-radius: 6px; border: 1px solid var(--border);
  background: transparent; color: var(--text); text-decoration: none; cursor: pointer; }
a.primary { background: var(--text); color: var(--bg); border-color: var(--text); }
textarea { width: 100%; height: 220px; font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text);
  background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px; resize: vertical; }
label { display: block; font-size: 12px; color: var(--dim); margin-bottom: 4px; }
.spin { width: 18px; height: 18px; border: 2px solid var(--border); border-top-color: var(--text); border-radius: 50%;
  animation: s 0.9s linear infinite; margin-bottom: 12px; }
@keyframes s { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
`

function page(lang: PageLang, title: string, body: string, script = ''): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">`
    + `<title>${esc(title)}</title><style>${STYLE}</style></head><body><main class="card">${body}</main>${script}</body></html>`
}

export function startingPage(lang: PageLang): string {
  const t = TEXT[lang]
  return page(lang, 'OpenSuperBot', `<div class="spin" aria-hidden="true"></div><h1>${esc(t.starting)}</h1><p>${esc(t.startingHint)}</p>`)
}

export function errorPage(lang: PageLang, reason: FailReason, diagnostics: string, tail: string[]): string {
  const t = TEXT[lang]
  const body = `<h1>${esc(t.title)}</h1>`
    + `<p class="why">${esc(t[reason])}</p><p>${esc(t.next)}</p>`
    + `<div class="buttons"><a class="button primary" href="osb:retry">${esc(t.retry)}</a>`
    + `<button id="copy" type="button">${esc(t.copy)}</button>`
    + `<a class="button" href="osb:logs">${esc(t.logs)}</a></div>`
    + `<label for="diag">${esc(t.lastLines)} (${tail.length})</label>`
    + `<textarea id="diag" readonly spellcheck="false">${esc(diagnostics)}</textarea>`
  const script = `<script>
document.getElementById('copy').addEventListener('click', function () {
  var box = document.getElementById('diag'); box.focus(); box.select();
  try { document.execCommand('copy'); this.textContent = ${JSON.stringify(t.copied)}; } catch (e) {}
});
</script>`
  return page(lang, t.title, body, script)
}

/** 给 loadURL 用 */
export const dataUrl = (html: string) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
