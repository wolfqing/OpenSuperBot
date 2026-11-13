import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api'
import { MAX_FILE_BYTES } from '../attachments'
import { I18nProvider } from '../i18n'
import type { AttachmentPayload, Conversation, Message } from '../types'
import type { FilesIO } from './ComposerFiles'
import { Thread } from './Thread'

const dm: Conversation = {
  id: 'dm:researcher', kind: 'dm', title: 'Scout', emoji: '🔎', subtitle: 'research',
  members: ['researcher'], last_message: null, pending: 0,
}
const other: Conversation = { ...dm, id: 'dm:market-watch', title: 'Ticker', members: ['market-watch'] }
const group: Conversation = {
  id: 'group:offsite-crew', kind: 'group', title: 'Offsite crew', emoji: '👥', subtitle: 'Scout, Ticker',
  members: ['researcher', 'market-watch'], last_message: null, pending: 0,
}
const roster = { researcher: { name: 'Scout', emoji: '🔎' }, 'market-watch': { name: 'Ticker', emoji: '📈' } }

const png = (name = 'chart.png', size = 20) => new File([new Uint8Array(size)], name, { type: 'image/png' })
const md = (name = 'notes.md') => new File(['# hi'], name, { type: '' })
const uploaded = (file: File, n: number): AttachmentPayload =>
  ({ id: String(n).repeat(32).slice(0, 32), url: `/api/uploads/${n}`, name: file.name, mime: file.type || 'text/markdown', size: file.size })

/** 一套可以由测试决定何时传完、是否失败的上传 */
function io(over: Partial<FilesIO> = {}) {
  const calls: { file: File; mime: string; signal: AbortSignal; resolve: (p: AttachmentPayload) => void; reject: (e: unknown) => void }[] = []
  const files: FilesIO = {
    upload: vi.fn((file: File, mime: string, signal: AbortSignal) => new Promise<AttachmentPayload>((resolve, reject) => {
      calls.push({ file, mime, signal, resolve, reject })
    })),
    discard: vi.fn(),
    ...over,
  }
  const finish = async (index: number) => { await act(async () => { calls[index]!.resolve(uploaded(calls[index]!.file, index + 1)) }) }
  const fail = async (index: number, err: unknown) => { await act(async () => { calls[index]!.reject(err) }) }
  return { files, calls, finish, fail }
}

type OnSend = (text: string, mentions?: string[], attachments?: string[]) => void | Promise<void>

function setup(opts: { files?: FilesIO; conversation?: Conversation; onSend?: ReturnType<typeof vi.fn<OnSend>>; messages?: Message[] } = {}) {
  const onSend = opts.onSend ?? vi.fn<OnSend>()
  const props = { roster, messages: opts.messages ?? [], thinking: false, onSend, onDecide: () => {} }
  const view = render(<Thread conversation={opts.conversation ?? dm} {...props} {...(opts.files ? { files: opts.files } : {})} />)
  const picker = () => view.container.querySelector('input[type=file]') as HTMLInputElement
  const choose = (...chosen: File[]) => userEvent.upload(picker(), chosen, { applyAccept: false })
  const box = () => screen.getByRole('textbox')
  const send = () => screen.getByRole('button', { name: 'Send' })
  const rerender = (conversation: Conversation) => view.rerender(<Thread conversation={conversation} {...props} {...(opts.files ? { files: opts.files } : {})} />)
  return { ...view, onSend, picker, choose, box, send, rerender }
}

afterEach(() => vi.restoreAllMocks())

describe('sending files from the composer', () => {
  it('has no attach button when the app gives it no way to upload', () => {
    const { picker } = setup()
    expect(screen.queryByRole('button', { name: 'Attach files' })).toBeNull()
    expect(picker()).toBeNull()
  })

  it('uploads a chosen file at once, holds Send until it is up, then sends it with the text', async () => {
    const { files, calls, finish } = io()
    const { choose, box, send, onSend } = setup({ files })
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeInTheDocument()
    await choose(png())
    expect(calls).toHaveLength(1)
    expect(calls[0]!.mime).toBe('image/png')
    expect(screen.getByText('chart.png')).toBeInTheDocument()
    expect(screen.getByText('Uploading…')).toBeInTheDocument()
    await userEvent.type(box(), 'what is this?')
    expect(send()).toBeDisabled()
    await userEvent.type(box(), '{Enter}')
    expect(onSend).not.toHaveBeenCalled()
    await finish(0)
    expect(screen.queryByText('Uploading…')).toBeNull()
    expect(send()).toBeEnabled()
    await userEvent.click(send())
    expect(onSend).toHaveBeenCalledWith('what is this?', undefined, ['1'.repeat(32)])
    expect(screen.queryByText('chart.png')).toBeNull()
    expect(box()).toHaveValue('')
    expect(files.discard).not.toHaveBeenCalled()
  })

  it('sends files on their own, with no text', async () => {
    const { files, finish } = io()
    const { choose, send, onSend } = setup({ files })
    expect(send()).toBeDisabled()
    await choose(md())
    await finish(0)
    await userEvent.click(send())
    expect(onSend).toHaveBeenCalledWith('', undefined, ['1'.repeat(32)])
  })

  it('declares Markdown by its extension, since browsers report no type for it', async () => {
    const { files, calls } = io()
    const { choose } = setup({ files })
    await choose(md())
    expect(calls[0]!.mime).toBe('text/markdown')
  })

  it('turns away a file that is too big or of a kind we do not send, before uploading anything', async () => {
    const { files, calls } = io()
    const { choose, send } = setup({ files })
    const big = new File([new Uint8Array(1)], 'big.pdf', { type: 'application/pdf' })
    Object.defineProperty(big, 'size', { value: MAX_FILE_BYTES + 1 })
    await choose(big, new File(['x'], 'a.zip', { type: 'application/zip' }))
    expect(calls).toHaveLength(0)
    expect(screen.getByText('That file is over 8 MB.')).toBeInTheDocument()
    expect(screen.getByText(/That kind of file cannot be sent/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(send()).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Remove big.pdf' }))
    expect(screen.queryByText('big.pdf')).toBeNull()
  })

  it('says why an upload failed in plain words and lets you try again', async () => {
    const { files, calls, finish, fail } = io()
    const { choose, send, onSend } = setup({ files })
    await choose(png())
    await fail(0, new ApiError('the file is not what its type says it is', 415, 'type_mismatch'))
    expect(screen.getByText('That file is not what its name says it is.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(calls).toHaveLength(2)
    expect(screen.getByText('Uploading…')).toBeInTheDocument()
    await finish(1)
    await userEvent.click(send())
    expect(onSend).toHaveBeenCalledWith('', undefined, ['2'.repeat(32)])
  })

  it('leaves a failed file behind when the rest are sent, so you can see it did not go', async () => {
    const { files, finish, fail } = io()
    const { choose, send, onSend } = setup({ files })
    await choose(png('ok.png'), png('bad.png'))
    await finish(0)
    await fail(1, new Error('network down'))
    await userEvent.click(send())
    expect(onSend).toHaveBeenCalledWith('', undefined, ['1'.repeat(32)])
    expect(screen.queryByText('ok.png')).toBeNull()
    expect(screen.getByText('bad.png')).toBeInTheDocument()
    expect(screen.getByText('network down')).toBeInTheDocument()
  })

  it('deletes an uploaded file you take out again, and one whose upload finishes after you took it out', async () => {
    const { files, calls, finish } = io()
    const { choose } = setup({ files })
    await choose(png('first.png'), png('second.png'))
    await finish(0)
    await userEvent.click(screen.getByRole('button', { name: 'Remove first.png' }))
    expect(files.discard).toHaveBeenCalledWith('1'.repeat(32))
    await userEvent.click(screen.getByRole('button', { name: 'Remove second.png' }))
    expect(calls[1]!.signal.aborted).toBe(true)
    await finish(1) // 取消没赶上，网关那边其实已经存下了
    expect(files.discard).toHaveBeenCalledWith('2'.repeat(32))
    expect(screen.queryByText('second.png')).toBeNull()
  })

  it('takes an image pasted into the message box', async () => {
    const { files, calls } = io()
    const { box } = setup({ files })
    fireEvent.paste(box(), { clipboardData: { files: [png('image.png')] } })
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(screen.getByText('image.png')).toBeInTheDocument()
    // 粘贴文字不受影响
    expect(fireEvent.paste(box(), { clipboardData: { files: [], getData: () => 'plain words' } })).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('takes files dropped on the thread, and says so while they hover', async () => {
    const { files, calls } = io()
    const { container } = setup({ files })
    const main = container.querySelector('main')!
    fireEvent.dragEnter(main, { dataTransfer: { types: ['Files'] } })
    expect(screen.getByText('Drop files here to send them to Scout')).toBeInTheDocument()
    fireEvent.dragLeave(main, { dataTransfer: { types: ['Files'] } })
    expect(screen.queryByText('Drop files here to send them to Scout')).toBeNull()
    fireEvent.dragEnter(main, { dataTransfer: { types: ['Files'] } })
    fireEvent.drop(main, { dataTransfer: { types: ['Files'], files: [png(), md()] } })
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(screen.queryByText('Drop files here to send them to Scout')).toBeNull()
    // 拖的不是文件（比如一段选中的文字）就不管
    fireEvent.dragEnter(main, { dataTransfer: { types: ['text/plain'] } })
    expect(screen.queryByText('Drop files here to send them to Scout')).toBeNull()
  })

  it('takes eight files at most and says the rest were left out', async () => {
    const { files, calls } = io()
    const { choose } = setup({ files })
    await choose(...Array.from({ length: 10 }, (_, i) => png(`p${i}.png`)))
    expect(calls).toHaveLength(8)
    expect(screen.getByText('A message can carry 8 files. The rest were left out.')).toBeInTheDocument()
    expect(screen.queryByText('p8.png')).toBeNull()
  })

  it('warns when the teammate cannot see images, for an image only', async () => {
    const { files } = io({ seesImages: false })
    const { choose } = setup({ files })
    await choose(md())
    expect(screen.queryByText(/cannot see images/)).toBeNull()
    await choose(png())
    expect(screen.getByText('Scout cannot see images with the model it is on. The file still goes onto its computer.')).toBeInTheDocument()
  })

  it('sends files together with a mention in a group', async () => {
    const { files, finish } = io()
    const { choose, box, onSend } = setup({ files, conversation: group })
    await choose(png())
    await finish(0)
    await userEvent.type(box(), '@tick')
    await userEvent.keyboard('{Enter}')
    await userEvent.type(box(), 'look{Enter}')
    expect(onSend).toHaveBeenCalledWith('@Ticker look', ['market-watch'], ['1'.repeat(32)])
  })

  it('puts the words and the files back when the message could not be sent, and says why', async () => {
    const { files, finish } = io()
    const onSend = vi.fn<OnSend>().mockRejectedValueOnce(new ApiError('gone', 400, 'attachment_unknown')).mockResolvedValue(undefined)
    const { choose, box, send } = setup({ files, onSend })
    await choose(png())
    await finish(0)
    await userEvent.type(box(), 'look at this')
    await userEvent.click(send())
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Not sent. One of the files is no longer on the gateway. Attach it again.'))
    expect(box()).toHaveValue('look at this')
    expect(screen.getByText('chart.png')).toBeInTheDocument()
    expect(files.discard).not.toHaveBeenCalled()
    await userEvent.click(send())
    expect(onSend).toHaveBeenLastCalledWith('look at this', undefined, ['1'.repeat(32)])
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('drops what was waiting when you move to another conversation, and deletes what was already uploaded', async () => {
    const { files, calls, finish } = io()
    const { choose, rerender } = setup({ files })
    await choose(png('done.png'), png('flying.png'))
    await finish(0)
    rerender(other)
    expect(screen.queryByText('done.png')).toBeNull()
    expect(files.discard).toHaveBeenCalledWith('1'.repeat(32))
    expect(calls[1]!.signal.aborted).toBe(true)
  })

  it('shows a sent file in the thread and removes it when asked', async () => {
    const remove = vi.fn()
    const sent: Message = {
      id: 4, thread_id: dm.id, sender: 'user', kind: 'attachment', content: '', created_at: 4,
      payload: { id: 'a'.repeat(32), url: `/api/uploads/${'a'.repeat(32)}`, name: 'notes.md', mime: 'text/markdown', size: 6 },
    }
    setup({ files: { ...io().files, remove }, messages: [sent] })
    expect(screen.getByRole('link', { name: 'Download notes.md' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Remove notes.md' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('notes.md')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(remove).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Remove notes.md' }))
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(remove).toHaveBeenCalledWith('a'.repeat(32))
  })

  it('speaks Chinese', async () => {
    const { files } = io({ seesImages: false })
    const view = render(
      <I18nProvider lang="zh-CN">
        <Thread conversation={dm} roster={roster} messages={[]} thinking={false} onSend={() => {}} onDecide={() => {}} files={files} />
      </I18nProvider>,
    )
    expect(screen.getByRole('button', { name: '添加文件' })).toBeInTheDocument()
    await userEvent.upload(view.container.querySelector('input[type=file]') as HTMLInputElement, [png()], { applyAccept: false })
    expect(screen.getByText('正在上传…')).toBeInTheDocument()
    expect(screen.getByText('Scout 现在用的模型看不了图片。文件照样会放到它的电脑上。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '移除 chart.png' })).toBeInTheDocument()
  })
})
