import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 网关的输出落到 logs/gateway.log。超过上限就把它挪成 gateway.log.1（只留一份旧的），日志不会无限长。
 * 每行带时间。写失败（磁盘满、目录被删）不影响 App 运行。
 */
export function openLog(file: string, opts: { maxBytes?: number; now?: () => Date } = {}): { write(line: string): void } {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024
  const now = opts.now ?? (() => new Date())
  let size = 0
  try {
    mkdirSync(dirname(file), { recursive: true })
    size = statSync(file).size
  } catch { /* 第一次，还没有文件 */ }
  const rotate = () => {
    try { renameSync(file, `${file}.1`) } catch { /* 没有可挪的 */ }
    size = 0
  }
  if (size > maxBytes) rotate()
  return {
    write(line) {
      const text = `${now().toISOString()} ${line}\n`
      try {
        if (size + text.length > maxBytes) rotate()
        appendFileSync(file, text)
        size += Buffer.byteLength(text)
      } catch { /* 写不进去就算了 */ }
    },
  }
}
