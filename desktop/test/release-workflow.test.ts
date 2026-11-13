import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoDir = resolve(desktopDir, '..')
const desktopPkg = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8')) as {
  productName: string
  version: string
  scripts: Record<string, string>
}
const builderConfig = require('../electron-builder.config.cjs') as {
  productName: string
  artifactName: string
  mac: Record<string, unknown>
  linux: Record<string, unknown>
}

const reqEb = createRequire(require.resolve('electron-builder'))
const reqAbl = createRequire(reqEb.resolve('app-builder-lib'))
const yaml = reqAbl('js-yaml') as { load: (src: string) => unknown }
const eb = reqEb('./builder') as {
  createYargs: () => { parseSync: (args: string[]) => Record<string, unknown> }
  configureBuildCommand: (yargs: unknown) => unknown
  normalizeOptions: (args: Record<string, unknown>) => { targets: Map<unknown, Map<number, string[]>> }
}
const abl = reqAbl('./index') as { Platform: { MAC: unknown; LINUX: unknown } }
const targetFactory = reqAbl('./targets/targetFactory') as {
  computeArchToTargetNamesMap: (
    raw: Map<number, string[]>,
    packager: { platformSpecificBuildOptions: Record<string, unknown>; defaultTarget: string[] },
    platform: unknown,
  ) => Map<number, string[]>
}
const builderUtil = reqAbl('builder-util') as {
  Arch: { x64: number; arm64: number }
  getArtifactArchName: (arch: number, ext: string) => string
}

function parseBuilderCli(scriptCmd: string) {
  const tokens = scriptCmd.trim().split(/\s+/)
  expect(tokens[0]).toBe('electron-builder')
  const yargs = eb.createYargs()
  eb.configureBuildCommand(yargs)
  const parsed = yargs.parseSync(tokens.slice(1))
  return eb.normalizeOptions(parsed).targets
}

function renderArtifactName(os: 'mac' | 'linux', arch: number, ext: 'dmg' | 'AppImage' | 'deb', version = '0.6.0') {
  return builderConfig.artifactName
    .replace('${productName}', builderConfig.productName)
    .replace('${version}', version)
    .replace('${os}', os)
    .replace('${arch}', builderUtil.getArtifactArchName(arch, ext))
    .replace('${ext}', ext)
}

interface WorkflowJob {
  if?: string
  needs?: string | string[]
  permissions?: Record<string, string>
  strategy?: {
    'fail-fast'?: boolean
    matrix?: { include?: Array<Record<string, string>> }
  }
  steps: Array<{ name?: string; if?: string; uses?: string; run?: string; with?: Record<string, unknown> }>
}

interface ReleaseWorkflow {
  name: string
  on: { push?: { tags?: string[] }; workflow_dispatch?: unknown }
  permissions?: Record<string, string>
  jobs: Record<string, WorkflowJob>
}

describe('Release workflow and per-arch packaging commands (D3)', () => {
  it('desktop package scripts select exact targets and architectures in electron-builder', () => {
    // macOS：单次构建在 arm64 runner 上交叉打出 arm64 + x64 两个 dmg
    const macRaw = parseBuilderCli(desktopPkg.scripts['package:mac']!).get(abl.Platform.MAC)!
    const macMap = targetFactory.computeArchToTargetNamesMap(
      macRaw,
      { platformSpecificBuildOptions: builderConfig.mac, defaultTarget: ['dmg'] },
      abl.Platform.MAC,
    )
    expect([...macMap.entries()]).toEqual([
      [builderUtil.Arch.arm64, ['dmg']],
      [builderUtil.Arch.x64, ['dmg']],
    ])

    // Linux：注意 electron-builder 只有在 --linux 后面显式写出 AppImage deb 时才会按 --x64/--arm64 过滤架构
    const linuxX64Raw = parseBuilderCli(desktopPkg.scripts['package:linux:x64']!).get(abl.Platform.LINUX)!
    const linuxX64Map = targetFactory.computeArchToTargetNamesMap(
      linuxX64Raw,
      { platformSpecificBuildOptions: builderConfig.linux, defaultTarget: ['AppImage'] },
      abl.Platform.LINUX,
    )
    expect([...linuxX64Map.entries()]).toEqual([[builderUtil.Arch.x64, ['AppImage', 'deb']]])

    const linuxArmRaw = parseBuilderCli(desktopPkg.scripts['package:linux:arm64']!).get(abl.Platform.LINUX)!
    const linuxArmMap = targetFactory.computeArchToTargetNamesMap(
      linuxArmRaw,
      { platformSpecificBuildOptions: builderConfig.linux, defaultTarget: ['AppImage'] },
      abl.Platform.LINUX,
    )
    expect([...linuxArmMap.entries()]).toEqual([[builderUtil.Arch.arm64, ['AppImage', 'deb']]])
  })

  it('electron-builder artifactName expands to the exact six filenames verified in release.yml', () => {
    expect([
      renderArtifactName('mac', builderUtil.Arch.arm64, 'dmg'),
      renderArtifactName('mac', builderUtil.Arch.x64, 'dmg'),
      renderArtifactName('linux', builderUtil.Arch.x64, 'AppImage'),
      renderArtifactName('linux', builderUtil.Arch.arm64, 'AppImage'),
      renderArtifactName('linux', builderUtil.Arch.x64, 'deb'),
      renderArtifactName('linux', builderUtil.Arch.arm64, 'deb'),
    ]).toEqual([
      'OpenSuperBot-0.6.0-mac-arm64.dmg',
      'OpenSuperBot-0.6.0-mac-x64.dmg',
      'OpenSuperBot-0.6.0-linux-x86_64.AppImage',
      'OpenSuperBot-0.6.0-linux-arm64.AppImage',
      'OpenSuperBot-0.6.0-linux-amd64.deb',
      'OpenSuperBot-0.6.0-linux-arm64.deb',
    ])
  })

  it('release.yml builds macOS (arm64+x64) and Linux (x64, arm64), hashes all six assets, and drafts a release', () => {
    const wfPath = join(repoDir, '.github', 'workflows', 'release.yml')
    expect(existsSync(wfPath)).toBe(true)
    const raw = readFileSync(wfPath, 'utf8')
    const wf = yaml.load(raw) as ReleaseWorkflow

    expect(wf.on.push?.tags).toContain('v*')
    expect(wf.on).toHaveProperty('workflow_dispatch')
    expect(wf.permissions).toEqual({ contents: 'read' })

    const pkgJob = wf.jobs.package!
    expect(pkgJob).toBeDefined()
    const matrix = pkgJob.strategy?.matrix?.include ?? []
    expect(matrix.map((m) => m.os)).toEqual(['macos-latest', 'ubuntu-24.04', 'ubuntu-24.04-arm'])
    for (const m of matrix) {
      const scriptName = m.package!.replace(/^pnpm --filter @opensuperbot\/desktop run /, '')
      expect(desktopPkg.scripts[scriptName], `missing desktop script ${scriptName}`).toBeDefined()
    }

    // 推 tag 时必须核对 desktop/package.json 的版本号，防止带着 -dev 打出正式 tag
    const tagStep = pkgJob.steps.find((s) => s.run?.includes('desktop/package.json'))
    expect(tagStep?.if).toContain("github.ref_type == 'tag'")

    // 打包完必须在 macOS 和 Linux（装上 .deb + xvfb）上各跑一遍打包产物冒烟测试
    const pkgRuns = pkgJob.steps.map((s) => s.run ?? '').join('\n')
    expect(pkgRuns).toContain('smoke:desktop')
    expect(pkgRuns).toContain('xvfb-run')

    const relJob = wf.jobs.release!
    expect(relJob).toBeDefined()
    expect(relJob.needs).toBe('package')
    expect(relJob.if).toContain("refs/tags/v")
    expect(relJob.permissions).toEqual({ contents: 'write' })

    const relRuns = relJob.steps.map((s) => s.run ?? '').join('\n')
    expect(relRuns).toContain('SHA256SUMS.txt')
    expect(relRuns).toContain('sha256sum')
    expect(relRuns).toContain('gh release create')
    expect(relRuns).toContain('--draft')
    for (const suffix of [
      'mac-arm64.dmg',
      'mac-x64.dmg',
      'linux-x86_64.AppImage',
      'linux-arm64.AppImage',
      'linux-amd64.deb',
      'linux-arm64.deb',
    ]) {
      expect(relRuns).toContain(suffix)
    }

    // 所有内嵌 shell 脚本去掉 ${{ ... }} 表达式后都要过 bash -n
    if (process.platform !== 'win32') {
      for (const [jobName, job] of Object.entries(wf.jobs)) {
        for (const step of job.steps) {
          if (!step.run) continue
          const scrubbed = step.run.replace(/\$\{\{[^}]+\}\}/g, 'placeholder')
          execFileSync('bash', ['-n'], { input: scrubbed, stdio: 'pipe' })
          expect(jobName).toBeTruthy()
        }
      }
    }
  })
})
