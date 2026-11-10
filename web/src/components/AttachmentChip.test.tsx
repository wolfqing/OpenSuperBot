import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import type { AttachmentPayload } from '../types'
import { AttachmentChip } from './AttachmentChip'

const id = 'a'.repeat(32)
const base = { id, url: `/api/uploads/${id}` }
const picture: AttachmentPayload = { ...base, name: 'chart.png', mime: 'image/png', size: 48_213, width: 1280, height: 800 }
const notes: AttachmentPayload = { ...base, name: 'notes.md', mime: 'text/markdown', size: 900 }
const pdf: AttachmentPayload = { ...base, name: 'plan.pdf', mime: 'application/pdf', size: 1_300_000, pages: 12, text: 'ok' }

afterEach(() => vi.restoreAllMocks())

describe('AttachmentChip', () => {
  it('shows a picture as a thumbnail that opens the original, with its size reserved so the thread does not jump', () => {
    render(<AttachmentChip payload={picture} />)
    const link = screen.getByRole('link', { name: 'Open chart.png' })
    expect(link).toHaveAttribute('href', picture.url)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noreferrer')
    const img = screen.getByRole('img', { name: 'chart.png' })
    expect(img).toHaveAttribute('src', picture.url)
    expect(img).toHaveAttribute('width', '1280')
    expect(img).toHaveAttribute('height', '800')
    expect(img).toHaveAttribute('loading', 'lazy')
    expect(screen.getByText(/chart\.png/)).toBeInTheDocument()
    expect(screen.getByText(/47 KB/)).toBeInTheDocument()
  })

  it('shows any other file as a strip that downloads it', () => {
    render(<AttachmentChip payload={notes} />)
    const link = screen.getByRole('link', { name: 'Download notes.md' })
    expect(link).toHaveAttribute('href', notes.url)
    expect(link).toHaveAttribute('download', 'notes.md')
    expect(screen.getByText('Markdown · 900 B')).toBeInTheDocument()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('says how long a PDF is, and whether a teammate has anything to read in it', () => {
    const { rerender } = render(<AttachmentChip payload={pdf} />)
    expect(screen.getByText('PDF · 12 pages · 1.2 MB')).toBeInTheDocument()
    rerender(<AttachmentChip payload={{ ...pdf, pages: 1, text: 'none' }} />)
    expect(screen.getByText('PDF · 1 page · 1.2 MB · scan, no text to read')).toBeInTheDocument()
    rerender(<AttachmentChip payload={{ ...pdf, text: 'truncated' }} />)
    expect(screen.getByText('PDF · 12 pages · 1.2 MB · only the first part of the text')).toBeInTheDocument()
    const { pages: _pages, ...unparsed } = pdf
    rerender(<AttachmentChip payload={{ ...unparsed, text: 'failed' }} />)
    expect(screen.getByText('PDF · 1.2 MB · its text could not be read')).toBeInTheDocument()
  })

  it('keeps only the name once the file was removed', () => {
    render(<AttachmentChip payload={{ ...picture, deleted: true }} onRemove={() => {}} />)
    expect(screen.getByText('chart.png')).toBeInTheDocument()
    expect(screen.getByText('Removed')).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('removes the file after asking, and not when the answer is no', async () => {
    const onRemove = vi.fn()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(<AttachmentChip payload={notes} onRemove={onRemove} />)
    const button = screen.getByRole('button', { name: 'Remove notes.md' })
    await userEvent.click(button)
    expect(onRemove).not.toHaveBeenCalled()
    await userEvent.click(button)
    expect(onRemove).toHaveBeenCalledWith(id)
    expect(confirm.mock.calls[0]![0]).toContain('notes.md')
  })

  it('has no remove button when nothing can remove it', () => {
    render(<AttachmentChip payload={notes} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('speaks Chinese', () => {
    render(<I18nProvider lang="zh-CN"><AttachmentChip payload={{ ...pdf, text: 'none' }} onRemove={() => {}} /></I18nProvider>)
    expect(screen.getByRole('link', { name: '下载 plan.pdf' })).toBeInTheDocument()
    expect(screen.getByText('PDF · 12 页 · 1.2 MB · 扫描件，没有可读的文字')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '移除 plan.pdf' })).toBeInTheDocument()
  })
})
