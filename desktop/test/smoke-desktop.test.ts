import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultRealDataRoot, findProcessesInPs, prepareSmokeRoot, resolvePackagedExecutable } from '../../scripts/smoke-desktop.js'

describe('smoke-desktop helpers (D5)', () => {
  it('resolves .app bundles on macOS and unpacked / installed binaries per platform and arch', () => {
    const repo = mkdtempSync(join(tmpdir(), 'osb-smoke-resolve-'))
    try {
      expect(() => resolvePackagedExecutable({ repoDir: repo, platform: 'darwin', arch: 'arm64' }))
        .toThrow(/desktop:package/)

      const macBin = join(repo, 'desktop', 'release', 'mac-arm64', 'OpenSuperBot.app', 'Contents', 'MacOS', 'OpenSuperBot')
      mkdirSync(join(macBin, '..'), { recursive: true })
      writeFileSync(macBin, '')
      expect(resolvePackagedExecutable({ repoDir: repo, platform: 'darwin', arch: 'arm64' })).toBe(macBin)
      // 传 .app 目录也能自动找到里面的可执行文件
      expect(resolvePackagedExecutable({
        explicit: join(repo, 'desktop', 'release', 'mac-arm64', 'OpenSuperBot.app'),
        repoDir: repo,
        platform: 'darwin',
        arch: 'arm64',
      })).toBe(macBin)

      const linuxArmBin = join(repo, 'desktop', 'release', 'linux-arm64-unpacked', 'opensuperbot')
      mkdirSync(join(linuxArmBin, '..'), { recursive: true })
      writeFileSync(linuxArmBin, '')
      expect(resolvePackagedExecutable({ repoDir: repo, platform: 'linux', arch: 'arm64' })).toBe(linuxArmBin)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('parses ps output to spot Chrome processes for this smoke run without flagging the user’s own Chrome', () => {
    const root = '/tmp/osb-smoke-desktop-abc123'
    const ps = [
      '  101 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --profile-directory=Default',
      `  555 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${root}/data/bots/chief/browser --headless`,
      `  556 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper.app --user-data-dir=${root}/data/bots/chief/browser`,
      `  999 node scripts/smoke-desktop.ts ${root}`,
    ].join('\n')
    expect(findProcessesInPs(ps, root, 999)).toEqual([
      { pid: 555, command: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${root}/data/bots/chief/browser --headless` },
      { pid: 556, command: `/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper.app --user-data-dir=${root}/data/bots/chief/browser` },
    ])
  })

  it('refuses --real-data-dir if the user already has data there', () => {
    const home = mkdtempSync(join(tmpdir(), 'osb-smoke-home-'))
    try {
      expect(defaultRealDataRoot('linux', home, {})).toBe(join(home, '.local', 'share', 'OpenSuperBot'))
      expect(defaultRealDataRoot('darwin', home, {})).toBe(join(home, 'Library', 'Application Support', 'OpenSuperBot'))

      const existing = defaultRealDataRoot('linux', home, {})
      mkdirSync(existing, { recursive: true })
      expect(() => prepareSmokeRoot({ realDataDir: true, platform: 'linux', home, env: {} }))
        .toThrow(/already exists/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
