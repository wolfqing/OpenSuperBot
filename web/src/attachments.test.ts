import { describe, expect, it } from 'vitest'
import { ACCEPT, MAX_FILE_BYTES, checkFile, declaredType, fileToBase64, humanSize, isImageType } from './attachments'

const file = (name: string, type: string, size = 10) => new File([new Uint8Array(size)], name, { type })

describe('what kind of file this is', () => {
  it('trusts a type the browser reports when it is one we send', () => {
    expect(declaredType(file('a.png', 'image/png'))).toBe('image/png')
    expect(declaredType(file('photo', 'image/jpeg'))).toBe('image/jpeg')
    expect(declaredType(file('a.pdf', 'application/pdf'))).toBe('application/pdf')
    expect(declaredType(file('a.txt', 'text/plain'))).toBe('text/plain')
  })

  it('goes by the extension when the browser reports nothing useful, as it does for Markdown', () => {
    expect(declaredType(file('notes.md', ''))).toBe('text/markdown')
    expect(declaredType(file('NOTES.MARKDOWN', 'application/octet-stream'))).toBe('text/markdown')
    expect(declaredType(file('notes.md', 'text/x-markdown'))).toBe('text/markdown')
    expect(declaredType(file('a.JPG', ''))).toBe('image/jpeg')
    expect(declaredType(file('a.jpg', 'image/jpg'))).toBe('image/jpeg')
  })

  it('has no type for a file we do not send', () => {
    expect(declaredType(file('a.zip', 'application/zip'))).toBeNull()
    expect(declaredType(file('a.svg', 'image/svg+xml'))).toBeNull()
    expect(declaredType(file('data.csv', 'text/csv'))).toBeNull()
    expect(declaredType(file('noext', ''))).toBeNull()
  })

  it('knows which types are pictures', () => {
    expect(isImageType('image/webp')).toBe(true)
    expect(isImageType('application/pdf')).toBe(false)
  })

  it('offers the same kinds in the file picker', () => {
    for (const kind of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', '.md', '.txt']) expect(ACCEPT).toContain(kind)
  })
})

describe('checking a file before it is uploaded', () => {
  it('passes a file we can send and names the reason for one we cannot', () => {
    expect(checkFile(file('a.png', 'image/png'))).toBeNull()
    expect(checkFile(file('a.zip', 'application/zip'))).toBe('type_not_allowed')
    expect(checkFile(file('a.txt', 'text/plain', 0))).toBe('empty_file')
    expect(checkFile(file('a.txt', 'text/plain', MAX_FILE_BYTES))).toBeNull()
    expect(checkFile({ name: 'big.pdf', type: 'application/pdf', size: MAX_FILE_BYTES + 1 })).toBe('too_large')
  })
})

describe('reading a file as base64', () => {
  it('gives the bare base64, without the data: prefix', async () => {
    expect(await fileToBase64(new File(['hello'], 'a.txt', { type: 'text/plain' }))).toBe('aGVsbG8=')
    expect(await fileToBase64(new File([new Uint8Array([0, 1, 2, 255])], 'a.bin'))).toBe('AAEC/w==')
  })
})

describe('sizes', () => {
  it('are short', () => {
    expect(humanSize(900)).toBe('900 B')
    expect(humanSize(12_345)).toBe('12 KB')
    expect(humanSize(2_500_000)).toBe('2.4 MB')
  })
})
