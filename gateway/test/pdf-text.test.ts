import { describe, expect, it } from 'vitest'
import { createPdfReader, tidyPdfText } from '../src/pdf-text.js'
import { makePdf } from './fixtures/pdf-samples.js'

describe('reading the text of a PDF', () => {
  it('returns every page under its own heading', async () => {
    const read = createPdfReader()
    const got = await read(makePdf(['Quarterly plan\nShip attachments (both halves)', 'Risks: none worth a page']))
    expect(got).toEqual({
      state: 'ok', pages: 2,
      text: '--- page 1 ---\nQuarterly plan\nShip attachments (both halves)\n\n--- page 2 ---\nRisks: none worth a page\n',
    })
  })

  it('says so when there is no text at all, as in a scan', async () => {
    expect(await createPdfReader()(makePdf([null, null]))).toEqual({ state: 'none', pages: 2, text: '' })
  })

  it('stops at the page limit and writes where it stopped at the top', async () => {
    const got = await createPdfReader({ maxPages: 2 })(makePdf(['one', 'two', 'three', 'four', 'five']))
    expect(got.state).toBe('truncated')
    expect(got.pages).toBe(5)
    expect(got.text).toBe('[Only the first 2 of 5 pages are in this file.]\n\n--- page 1 ---\none\n\n--- page 2 ---\ntwo\n')
  })

  it('stops at the size limit in the middle of a long document', async () => {
    const got = await createPdfReader({ maxChars: 60 })(makePdf(['X'.repeat(40), 'Y'.repeat(40), 'Z'.repeat(40)]))
    expect(got.state).toBe('truncated')
    expect(got.pages).toBe(3)
    expect(got.text).toBe(`[This file holds only the beginning of the text: it was cut off on page 2 of 3.]\n\n--- page 1 ---\n${'X'.repeat(40)}\n\n--- page 2 ---\n${'Y'.repeat(20)}\n`)
  })

  it('reports a file it cannot parse as failed instead of throwing', async () => {
    expect(await createPdfReader()(Buffer.from('%PDF-1.7\nnot really a pdf'))).toEqual({ state: 'failed', pages: null, text: '' })
    expect(await createPdfReader()(Buffer.alloc(0))).toEqual({ state: 'failed', pages: null, text: '' })
  })

  it('gives up on a document that takes too long', async () => {
    const started = Date.now()
    const got = await createPdfReader({ timeoutMs: 1 })(makePdf(Array.from({ length: 300 }, (_, i) => `page ${i}`)))
    expect(got).toEqual({ state: 'failed', pages: null, text: '' })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('reads several documents at once without mixing them up', async () => {
    const read = createPdfReader()
    const all = await Promise.all(['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((word) => read(makePdf([word]))))
    expect(all.map((r) => r.text)).toEqual(['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((w) => `--- page 1 ---\n${w}\n`))
  })
})

describe('tidying extracted text', () => {
  const cp = (...points: number[]) => String.fromCodePoint(...points)

  it('turns radical look-alikes back into the real characters, so the text can be searched', () => {
    // 有些字体的 PDF 把「目」「人」「文」「大」记成康熙部首区的同形字符
    const radicals = cp(0x2f6c, 0x2f08, 0x2f42, 0x2f24)
    expect(tidyPdfText(`${radicals}Q3`)).toBe('目人文大Q3')
    expect([...tidyPdfText(radicals)].map((c) => c.codePointAt(0))).toEqual([0x76ee, 0x4eba, 0x6587, 0x5927])
  })

  it('does the same for the simplified characters that live in the radicals supplement', () => {
    // 风 长 见 门 马：Chrome 在 macOS 上打印出的 PDF 里常见
    const supplement = cp(0x2edb, 0x2ed3, 0x2ec5, 0x2ed4, 0x2ee2)
    expect([...tidyPdfText(supplement)].map((c) => c.codePointAt(0))).toEqual([0x98ce, 0x957f, 0x89c1, 0x95e8, 0x9a6c])
    // 这个区里没有对应本字的字符原样留着
    expect(tidyPdfText(cp(0x2e80))).toBe(cp(0x2e80))
  })

  it('spells out Latin ligatures', () => {
    expect(tidyPdfText(`of${cp(0xfb01)}ce e${cp(0xfb00)}ect ${cp(0xfb02)}ow`)).toBe('office effect flow')
  })

  it('leaves everything else as it was, full-width punctuation included', () => {
    const text = `目标：做完，包括 PDF。${cp(0xff01)} ① x² ½`
    expect(tidyPdfText(text)).toBe(text)
  })
})
