/** 最多读 limit 字节；多一个字节就停下并返回 null，不把超大的请求体整个搬进内存 */
export async function readBodyUpTo(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Buffer | null> {
  if (!body) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  } catch {
    return Buffer.alloc(0)
  }
  return Buffer.concat(chunks)
}
