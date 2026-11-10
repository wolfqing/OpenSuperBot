import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDockerComputer } from '../src/computer-docker.js'
import { createFakeComputer } from '../src/computer.js'
import { createLocalComputer } from '../src/computer-local.js'
import { tarFile } from '../src/tar.js'

/** 按 ustar 的格子把归档读回来：只认这里会写出的三种条目（目录、文件、PAX 扩展头） */
function readTar(tar: Buffer): { name: string; type: string; mode: number; body: Buffer }[] {
  const entries: { name: string; type: string; mode: number; body: Buffer }[] = []
  let longName: string | null = null
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512)
    if (header.every((b) => b === 0)) break
    const field = (from: number, len: number) => header.toString('utf8', from, from + len).replace(/\0.*$/s, '')
    const size = parseInt(field(124, 12).trim() || '0', 8)
    const body = tar.subarray(at + 512, at + 512 + size)
    const type = String.fromCharCode(header[156]!)
    // 校验和：把自己那 8 个字节当空格算
    const sum = header.reduce((acc, b, i) => acc + (i >= 148 && i < 156 ? 32 : b), 0)
    expect(parseInt(field(148, 8).trim(), 8)).toBe(sum)
    expect(field(257, 5)).toBe('ustar')
    if (type === 'x') {
      longName = /^\d+ path=(.*)\n$/s.exec(body.toString('utf8'))?.[1] ?? null
    } else {
      entries.push({ name: longName ?? field(0, 100), type, mode: parseInt(field(100, 8).trim(), 8), body: Buffer.from(body) })
      longName = null
    }
    at += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

describe('the archive a container computer receives', () => {
  it('holds the folder and the file, world-readable, and ends with two empty blocks', () => {
    const tar = tarFile('uploads/a1b2c3d4-notes.md', Buffer.from('# hi\n'), 1_700_000_000_000)
    expect(tar.length % 512).toBe(0)
    expect(tar.subarray(-1024).every((b) => b === 0)).toBe(true)
    expect(readTar(tar)).toEqual([
      { name: 'uploads/', type: '5', mode: 0o755, body: Buffer.alloc(0) },
      { name: 'uploads/a1b2c3d4-notes.md', type: '0', mode: 0o644, body: Buffer.from('# hi\n') },
    ])
  })

  it('carries a long non-ASCII name in an extended header', () => {
    const name = `uploads/a1b2c3d4-${'报'.repeat(60)}.md`
    expect(Buffer.byteLength(name)).toBeGreaterThan(100)
    const entries = readTar(tarFile(name, Buffer.from('x'), 0))
    expect(entries.map((e) => e.name)).toEqual(['uploads/', name])
  })

  it.skipIf(process.platform === 'win32')('is an archive the system tar unpacks, long names included', () => {
    const dir = mkdtempSync(join(tmpdir(), 'osb-tar-'))
    const long = `uploads/a1b2c3d4-${'报'.repeat(60)}.md`
    for (const [path, body] of [['uploads/a1b2c3d4-shot.png', Buffer.from([0, 1, 2, 255])], [long, Buffer.from('# 你好\n')]] as const) {
      const archive = join(dir, 'one.tar')
      writeFileSync(archive, tarFile(path, body))
      execFileSync('tar', ['-xf', archive, '-C', dir])
      expect(readFileSync(join(dir, path))).toEqual(body)
    }
  })

  it('refuses a path that is absolute or climbs out', () => {
    expect(() => tarFile('/etc/passwd', Buffer.from('x'), 0)).toThrow(/path/)
    expect(() => tarFile('uploads/../../x', Buffer.from('x'), 0)).toThrow(/path/)
    expect(() => tarFile('uploads/', Buffer.from('x'), 0)).toThrow(/path/)
  })
})

describe('putting a file on a container computer', () => {
  it('sends the archive into /workspace through Docker, not through the host folder', async () => {
    const sent: { tar: Buffer; path: string }[] = []
    const computer = createDockerComputer(
      { shim: 'http://127.0.0.1:1', cdp: 'http://127.0.0.1:2', vnc: 'http://127.0.0.1:3' },
      { putArchive: async (tar, path) => { sent.push({ tar, path }) } },
    )
    await computer.putFile!('uploads/a1b2c3d4-shot.png', Buffer.from([1, 2, 3]))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.path).toBe('/workspace')
    expect(readTar(sent[0]!.tar).map((e) => [e.name, e.body.length])).toEqual([['uploads/', 0], ['uploads/a1b2c3d4-shot.png', 3]])
  })

  it('is absent when the computer was built without a way into the container', () => {
    const computer = createDockerComputer({ shim: 'http://127.0.0.1:1', cdp: 'http://127.0.0.1:2', vnc: 'http://127.0.0.1:3' })
    expect(computer.putFile).toBeUndefined()
  })
})

describe('putting a file on a local computer', () => {
  function local() {
    const root = mkdtempSync(join(tmpdir(), 'osb-put-'))
    const workspaceDir = join(root, 'workspace')
    mkdirSync(workspaceDir)
    const computer = createLocalComputer({ workspaceDir, profileDir: join(root, 'profile'), executablePath: '/nonexistent' })
    return { root, workspaceDir, computer }
  }

  it('writes the bytes under the teammate folder, creating uploads/ on the way', async () => {
    const { workspaceDir, computer } = local()
    await computer.putFile!('uploads/a1b2c3d4-shot.png', Buffer.from([0, 1, 2, 255]))
    expect(readFileSync(join(workspaceDir, 'uploads', 'a1b2c3d4-shot.png'))).toEqual(Buffer.from([0, 1, 2, 255]))
    expect(await computer.readFile('/workspace/uploads/a1b2c3d4-shot.png')).toBeTypeOf('string')
  })

  it('is content when the very same file is already there, and refuses to replace a different one', async () => {
    const { workspaceDir, computer } = local()
    await computer.putFile!('uploads/a.txt', Buffer.from('one'))
    await expect(computer.putFile!('uploads/a.txt', Buffer.from('one'))).resolves.toBeUndefined()
    await expect(computer.putFile!('uploads/a.txt', Buffer.from('two!'))).rejects.toThrow(/already/)
    expect(readFileSync(join(workspaceDir, 'uploads', 'a.txt'), 'utf8')).toBe('one')
  })

  it.skipIf(process.platform === 'win32')('does not follow an uploads folder the teammate turned into a link out of its folder', async () => {
    const { root, workspaceDir, computer } = local()
    const outside = join(root, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(workspaceDir, 'uploads'))
    await expect(computer.putFile!('uploads/a.txt', Buffer.from('x'))).rejects.toThrow(/escapes workspace/)
    expect(existsSync(join(outside, 'a.txt'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('does not write through a link planted at the file name itself', async () => {
    const { root, workspaceDir, computer } = local()
    const target = join(root, 'target.txt')
    writeFileSync(target, 'untouched')
    mkdirSync(join(workspaceDir, 'uploads'))
    symlinkSync(target, join(workspaceDir, 'uploads', 'a.txt'))
    await expect(computer.putFile!('uploads/a.txt', Buffer.from('x'))).rejects.toThrow()
    expect(readFileSync(target, 'utf8')).toBe('untouched')
  })

  it('refuses a path outside the folder', async () => {
    const { computer } = local()
    await expect(computer.putFile!('../x.txt', Buffer.from('x'))).rejects.toThrow(/escapes workspace/)
    await expect(computer.putFile!('/etc/x.txt', Buffer.from('x'))).rejects.toThrow(/escapes workspace/)
  })
})

describe('the fake computer used in tests', () => {
  it('records what was put on it', async () => {
    const computer = createFakeComputer()
    await computer.putFile!('uploads/a.txt', Buffer.from('abc'))
    expect(computer.calls).toContain('put:uploads/a.txt')
    expect(computer.files.get('uploads/a.txt')?.toString()).toBe('abc')
  })
})
