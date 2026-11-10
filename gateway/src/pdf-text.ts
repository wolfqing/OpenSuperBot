import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { CJK_RADICAL_SUPPLEMENT } from './cjk-radicals.js'

/**
 * 把 PDF 里的字抽出来，好让同事用 read_file 读。PDF 是操作者转来的不可信文件，解析器又大又复杂，所以：
 * 在单独的线程里跑，限内存、限时间、限页数和字数；出任何岔子都只是「没抽出来」，不影响上传本身，更不拖垮网关。
 * 只取文字，不渲染页面（不需要 canvas，也就没有原生依赖）。扫描件没有文字层，如实说没有。
 */
export type PdfText = {
  /** ok 全文都在；truncated 只有开头一部分（文字版第一行写明停在哪）；none 没有文字层；failed 解析不了或超时 */
  state: 'ok' | 'truncated' | 'none' | 'failed'
  /** 文档总页数；解析不了就不知道 */
  pages: number | null
  text: string
}

export type PdfReader = (bytes: Buffer) => Promise<PdfText>

export const PDF_MAX_PAGES = 200
export const PDF_MAX_CHARS = 2_000_000
export const PDF_TIMEOUT_MS = 20_000

const FAILED: PdfText = { state: 'failed', pages: null, text: '' }

/**
 * 线程里跑的那段。写成字符串、用 eval 起线程：这样在 tsx、vitest、编译后的 dist 和打包进桌面 App 里都是同一条路，
 * 不依赖「线程入口文件在哪、是 .ts 还是 .js」。库的位置由主线程解析好传进来。
 */
const WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
;(async () => {
  const mod = await import(workerData.lib)
  const api = mod.getDocumentProxy ? mod : mod.default
  const pdf = await api.getDocumentProxy(new Uint8Array(workerData.bytes), { isEvalSupported: false })
  const total = pdf.numPages
  const bodies = []
  let left = workerData.maxChars
  let cutPage = 0
  for (let n = 1; n <= Math.min(total, workerData.maxPages); n++) {
    const page = await pdf.getPage(n)
    const content = await page.getTextContent()
    let body = ''
    for (const item of content.items) {
      if (typeof item.str === 'string') body += item.str + (item.hasEOL ? '\n' : '')
    }
    body = body.trim()
    page.cleanup()
    if (body.length > left) {
      bodies.push(body.slice(0, left))
      cutPage = n
      break
    }
    left -= body.length
    bodies.push(body)
  }
  parentPort.postMessage({ ok: true, total, bodies, cutPage })
})().catch(() => parentPort.postMessage({ ok: false }))
`

type WorkerReply = { ok: true; total: number; bodies: string[]; cutPage: number } | { ok: false }

let libUrl: string | undefined
const lib = () => (libUrl ??= pathToFileURL(createRequire(import.meta.url).resolve('unpdf')).href)

/**
 * 抽出来的字里几类「看着对、其实不是那个字」的字符，换回本字，不然搜不到、对不上：
 * 两个部首区的同形字符（有些字体的 PDF 把「目」「人」「风」「长」记成它们），和拉丁连字（fi、fl 连写的那类）。
 * 只动这几段，别的一概不碰——整段做 NFKC 会把全角标点、上标、圈码也改掉。
 */
export function tidyPdfText(text: string): string {
  return text
    .replace(/[\u{2F00}-\u{2FDF}\u{FB00}-\u{FB06}]/gu, (c) => c.normalize('NFKC'))
    .replace(/[\u{2E80}-\u{2EFF}]/gu, (c) => CJK_RADICAL_SUPPLEMENT.get(c) ?? c)
}

function assemble(reply: Extract<WorkerReply, { ok: true }>): PdfText {
  const { total, cutPage } = reply
  const bodies = reply.bodies.map(tidyPdfText)
  if (!bodies.some((body) => body.length > 0)) return { state: 'none', pages: total, text: '' }
  const text = bodies.map((body, i) => `--- page ${i + 1} ---\n${body}\n`).join('\n')
  if (cutPage) {
    return { state: 'truncated', pages: total, text: `[This file holds only the beginning of the text: it was cut off on page ${cutPage} of ${total}.]\n\n${text}` }
  }
  if (bodies.length < total) {
    return { state: 'truncated', pages: total, text: `[Only the first ${bodies.length} of ${total} pages are in this file.]\n\n${text}` }
  }
  return { state: 'ok', pages: total, text }
}

export function createPdfReader(opts: { maxPages?: number; maxChars?: number; timeoutMs?: number; concurrency?: number } = {}): PdfReader {
  const maxPages = opts.maxPages ?? PDF_MAX_PAGES
  const maxChars = opts.maxChars ?? PDF_MAX_CHARS
  const timeoutMs = opts.timeoutMs ?? PDF_TIMEOUT_MS
  const concurrency = Math.max(1, opts.concurrency ?? 2)
  let running = 0
  const queue: (() => void)[] = []
  const acquire = () => new Promise<void>((resolve) => {
    if (running < concurrency) { running++; resolve() } else queue.push(() => { running++; resolve() })
  })
  const release = () => { running--; queue.shift()?.() }

  const extract = (bytes: Buffer) => new Promise<PdfText>((resolve) => {
    let worker: Worker
    try {
      worker = new Worker(WORKER, {
        eval: true,
        workerData: { lib: lib(), bytes, maxPages, maxChars },
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
        // 解析器的告警别写进网关的日志
        stdout: true,
        stderr: true,
      })
    } catch {
      resolve(FAILED)
      return
    }
    worker.stdout.resume()
    worker.stderr.resume()
    let settled = false
    const finish = (result: PdfText) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      resolve(result)
    }
    const timer = setTimeout(() => finish(FAILED), timeoutMs)
    worker.once('message', (reply: WorkerReply) => {
      try {
        finish(reply.ok ? assemble(reply) : FAILED)
      } catch {
        finish(FAILED)
      }
    })
    worker.once('error', () => finish(FAILED)) // 包括撑爆内存上限
    worker.once('exit', () => finish(FAILED))
  })

  return async (bytes) => {
    await acquire()
    try {
      return await extract(bytes)
    } finally {
      release()
    }
  }
}
