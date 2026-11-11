/**
 * 发文件前在浏览器里先看一眼：是不是我们发的那几种、有没有超大。网关会按内容再认一遍，这里只为早点给人话，
 * 别让人等一个 8 MB 的上传走完才被告知不行。
 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024
export const MAX_FILES = 8

const BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
}
const ALIASES: Record<string, string> = { 'image/jpg': 'image/jpeg', 'text/x-markdown': 'text/markdown' }
const SENDABLE = new Set(Object.values(BY_EXTENSION))

/** 文件选择框里能选的：类型和扩展名都列上（Markdown 在很多系统上没有类型，只能靠扩展名） */
export const ACCEPT = [...SENDABLE, ...Object.keys(BY_EXTENSION).map((ext) => `.${ext}`)].join(',')

export type FileProblem = 'too_large' | 'type_not_allowed' | 'empty_file'

/** 报给网关的类型：浏览器说的算数就用它，否则看扩展名；不是我们发的那几种就没有 */
export function declaredType(file: { name: string; type: string }): string | null {
  const reported = file.type.trim().toLowerCase()
  const type = ALIASES[reported] ?? reported
  if (SENDABLE.has(type)) return type
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase()
  return (ext && BY_EXTENSION[ext]) || null
}

export const isImageType = (mime: string): boolean => mime.startsWith('image/')

export function checkFile(file: { name: string; type: string; size: number }): FileProblem | null {
  if (!declaredType(file)) return 'type_not_allowed'
  if (file.size === 0) return 'empty_file'
  if (file.size > MAX_FILE_BYTES) return 'too_large'
  return null
}

/** 网关要的是不带 data: 前缀的 base64 */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('could not read the file'))
    reader.onload = () => {
      const url = String(reader.result)
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
