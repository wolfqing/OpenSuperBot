import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const config = require('../electron-builder.config.cjs') as {
  deb: { depends: string[]; appArmorProfile: string; afterInstall: string; afterRemove: string }
}

/** electron-builder 往这三个文件里填模板变量时只认这几个名字；脚本里不小心写成 ${VAR} 就会在打包时炸掉 */
const ALLOWED_TEMPLATE_VARS = new Set(['executable', 'sanitizedProductName', 'productFilename'])
const templateVars = (text: string) => [...text.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]!)

describe('Linux .deb packaging for Ubuntu 24.04+', () => {
  it('pulls in bubblewrap and ALSA, and points electron-builder at the AppArmor profile and maintainer scripts', () => {
    expect(config.deb.depends).toContain('bubblewrap')
    expect(config.deb.depends).toContain('libasound2t64 | libasound2')
    for (const rel of [config.deb.appArmorProfile, config.deb.afterInstall, config.deb.afterRemove, 'resources/apparmor-bwrap']) {
      expect(existsSync(join(desktopDir, rel)), rel).toBe(true)
    }
  })

  it('the AppArmor profiles grant userns to the app, its downloaded browser, and bubblewrap under ABI 4.0', () => {
    const appProfile = readFileSync(join(desktopDir, config.deb.appArmorProfile), 'utf8')
    expect(appProfile).toContain('abi <abi/4.0>,')
    expect(appProfile).toContain('"/opt/${sanitizedProductName}/${executable}" flags=(unconfined)')
    expect(appProfile).toContain('@{HOME}/.local/share/OpenSuperBot/data/browsers/chromium-*/chrome-linux*/chrome flags=(unconfined)')
    expect(appProfile.match(/\buserns,/g)?.length).toBeGreaterThanOrEqual(2)
    expect(templateVars(appProfile).every((v) => ALLOWED_TEMPLATE_VARS.has(v))).toBe(true)

    const bwrapProfile = readFileSync(join(desktopDir, 'resources/apparmor-bwrap'), 'utf8')
    expect(bwrapProfile).toContain('abi <abi/4.0>,')
    expect(bwrapProfile).toContain('"/usr/bin/bwrap" flags=(unconfined)')
    expect(bwrapProfile).toContain('userns,')
  })

  it('after-install and after-remove only use electron-builder’s template variables and pass bash -n', () => {
    for (const rel of [config.deb.afterInstall, config.deb.afterRemove]) {
      const raw = readFileSync(join(desktopDir, rel), 'utf8')
      const bad = templateVars(raw).filter((v) => !ALLOWED_TEMPLATE_VARS.has(v))
      expect(bad, `${rel} has unknown \${...} vars: ${bad.join(', ')}`).toEqual([])
      expect(raw).toContain('opensuperbot-bwrap')
      if (process.platform !== 'win32') {
        const rendered = raw
          .replaceAll('${executable}', 'opensuperbot')
          .replaceAll('${sanitizedProductName}', 'OpenSuperBot')
          .replaceAll('${productFilename}', 'OpenSuperBot')
        execFileSync('bash', ['-n'], { input: rendered })
      }
    }
    const install = readFileSync(join(desktopDir, config.deb.afterInstall), 'utf8')
    // 用户或别的工具已经给 /usr/bin/bwrap 写了规则就不去撞它（同一个路径两份规则会让 AppArmor 报错）
    expect(install).toMatch(/grep.*\/usr\/bin\/bwrap/)
  })

  it('after-pack ships apparmor-bwrap into Linux resources alongside keeping one SQLite prebuild', async () => {
    const afterPack = require('../scripts/after-pack.cjs').default as (ctx: unknown) => Promise<void>
    const out = mkdtempSync(join(tmpdir(), 'osb-afterpack-'))
    try {
      const prebuilds = join(out, 'resources', 'gateway', 'node_modules', 'better-sqlite3', 'prebuilds')
      mkdirSync(prebuilds, { recursive: true })
      writeFileSync(join(prebuilds, 'linux-x64.node'), 'x')
      writeFileSync(join(prebuilds, 'darwin-arm64.node'), 'y')
      writeFileSync(join(out, 'resources', 'default_app.asar'), 'z')
      await afterPack({ electronPlatformName: 'linux', arch: 1, appOutDir: out, packager: { appInfo: { productFilename: 'OpenSuperBot' } } })
      expect(existsSync(join(out, 'resources', 'apparmor-bwrap'))).toBe(true)
      expect(existsSync(join(out, 'resources', 'default_app.asar'))).toBe(false)
      expect(existsSync(join(prebuilds, 'linux-x64.node'))).toBe(true)
      expect(existsSync(join(prebuilds, 'darwin-arm64.node'))).toBe(false)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })
})
