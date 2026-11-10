/**
 * 手写的最小 PDF：每页一段 Helvetica 文字（或只有一个色块，装成扫描件）。对象偏移和 xref 都是真的，
 * 所以解析器走的是正常路径，不靠它的容错。只用 ASCII——中文要嵌字体，这里测的是抽取流程，不是字体。
 */
const escape = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`)

export function makePdf(pages: (string | null)[]): Buffer {
  const objects: string[] = []
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')
  objects.push('<< /Type /Catalog /Pages 2 0 R >>')
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`)
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  pages.forEach((text, i) => {
    const stream = text === null
      ? '0.5 g 72 72 468 648 re f'
      : `BT /F1 12 Tf 72 720 Td 14 TL ${text.split('\n').map((line) => `(${escape(line)}) Tj T*`).join(' ')} ET`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`)
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  })
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
