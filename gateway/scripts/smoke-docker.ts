// 真 Docker 冒烟：拉起两台 bot 电脑，走通 shell / 文件 / 浏览器 / 截图，并验收隔离与自愈。
// 不进 pnpm test（需要 Docker 且慢）。跑法：
//   pnpm --filter @opensuperbot/gateway run smoke:docker
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Docker from 'dockerode'
import { createDockerComputer } from '../src/computer-docker.js'
import { BOT_NETWORK, containerName, ensureContainer, waitForCdp } from '../src/containers.js'
import { saveScreenshot } from '../src/screenshots.js'

const BOT = process.env.SMOKE_BOT || 'smoke'
const PEER = `${BOT}-peer`
const docker = new Docker()
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone

const dataDir = await mkdtemp(join(tmpdir(), 'osb-smoke-'))
const workspace = async (id: string) => {
  const dir = join(dataDir, 'workspaces', id)
  await mkdir(dir, { recursive: true })
  return dir
}

const checks: { name: string; ok: boolean }[] = []
const check = (name: string, ok: boolean, detail?: string) => {
  checks.push({ name, ok })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

console.log('· starting two computers…')
const endpoints = await ensureContainer(docker, BOT, await workspace(BOT), { memoryMb: 2048, cpus: 2, timeZone })
await ensureContainer(docker, PEER, await workspace(PEER), { timeZone })
console.log('  endpoints:', { ...endpoints, shimToken: '…', vncPassword: '…' })
const computer = createDockerComputer(endpoints, {
  putArchive: (tar, path) => docker.getContainer(containerName(BOT)).putArchive(tar, { path }),
})

const shell = await computer.shell('echo hi && pwd')
check('shell', shell.exitCode === 0 && shell.stdout.includes('/workspace'), shell.stdout.trim().replace(/\n/g, ' '))

const anonymous = await fetch(`${endpoints.shim}/shell`, { method: 'POST', body: JSON.stringify({ cmd: 'id' }) })
check('shim refuses calls without the container token', anonymous.status === 401, `HTTP ${anonymous.status}`)

await computer.writeFile('notes/todo.md', '# from smoke\n')
check('write+read file', (await computer.readFile('notes/todo.md')).includes('from smoke'))

// 操作者发来的文件：经 Docker 的归档接口进容器（不直接写宿主上挂进去的目录），二进制一个字节不差
const picture = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255])
await computer.putFile!('uploads/1a2b3c4d-会议_notes.md', Buffer.from('# from the operator\n'))
await computer.putFile!('uploads/5e6f7a8b-shot.png', picture)
const sent = await computer.shell('wc -c < /workspace/uploads/5e6f7a8b-shot.png; od -An -tx1 /workspace/uploads/5e6f7a8b-shot.png | tr -d " \\n"')
check('a file from the operator lands in /workspace/uploads', sent.stdout.includes('8') && sent.stdout.includes('89504e47000102ff')
  && (await computer.readFile('uploads/1a2b3c4d-会议_notes.md')).includes('from the operator'), sent.stdout.trim().replace(/\n/g, ' '))
// 同事把 uploads 换成指向别处的链接：路径是在容器里解析的，文件落不到宿主的同名位置
const planted = `osb-smoke-${Date.now()}`
await computer.shell(`rm -rf /workspace/uploads && mkdir -p /tmp/${planted} && ln -s /tmp/${planted} /workspace/uploads`)
await computer.putFile!('uploads/9c0d1e2f-late.txt', Buffer.from('late')).catch(() => {})
const inside = await computer.shell(`ls /tmp/${planted}; rm -f /workspace/uploads; mkdir -p /workspace/uploads`)
check('a link planted at uploads/ never leads to the host', !existsSync(`/tmp/${planted}`),
  inside.stdout.trim() ? `followed inside the container: ${inside.stdout.trim()}` : 'Docker refused to write through it')

const nav = await computer.goto('https://example.com')
check('browser_goto', /example/i.test(nav.title), `${nav.title} @ ${nav.url}`)
const text = await computer.extract()
check('browser_extract', text.toLowerCase().includes('example'), text.slice(0, 60).replace(/\n/g, ' '))
const links = await computer.links()
check('links on the page', links.some((l) => l.href.startsWith('http')), links.slice(0, 2).map((l) => l.href).join(', '))

await computer.goto('data:text/html,<label>Search <input id=q></label><p id=echo></p>'
  + '<script>q.oninput=()=>echo.textContent=q.value</script>')
await computer.type('Search', '你好 grok')
check('browser_type by label', (await computer.extract()).includes('你好 grok'))

const shot = await computer.screenshot()
const saved = await saveScreenshot(dataDir, BOT, shot, Date.now())
const onDisk = await stat(join(dataDir, 'bots', BOT, 'screenshots', saved.url.split('/').pop()!))
check('browser_screenshot', onDisk.size > 5000, `${onDisk.size} bytes, ${shot.width}x${shot.height}`)

const fonts = await computer.shell('fc-list | grep -ciE "wqy|noto color emoji"')
check('CJK and emoji fonts installed', Number(fonts.stdout.trim()) >= 2, `${fonts.stdout.trim()} font files`)

const tz = await computer.shell('echo $TZ; date +%z')
check('container runs in the gateway timezone', tz.stdout.includes(timeZone), tz.stdout.trim().replace(/\n/g, ' '))

const mem = await computer.shell('cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes')
check('memory limit applied', mem.stdout.trim() === String(2048 * 1024 * 1024), mem.stdout.trim())

const peerIp = (await docker.getContainer(containerName(PEER)).inspect()).NetworkSettings.Networks[BOT_NETWORK]?.IPAddress
const probe = await computer.shell(
  `node -e "fetch('http://${peerIp}:7717/health',{signal:AbortSignal.timeout(3000)}).then(r=>console.log('reached',r.status)).catch(e=>console.log('blocked',e.cause?.code??e.name))"`,
)
check('one bot cannot reach another bot\'s computer', probe.stdout.includes('blocked'), `${peerIp}: ${probe.stdout.trim()}`)

// Docker Desktop 上，别的容器能经 host.docker.internal 摸到宿主上发布的端口：CDP 和 shim 都必须要口令
const peer = (await docker.getContainer(containerName(PEER)).inspect()).NetworkSettings.Ports
const peerCdpPort = peer['9222/tcp']?.[0]?.HostPort
const peerShimPort = peer['7717/tcp']?.[0]?.HostPort
await computer.writeFile('probe-host.js', [
  "const net = require('net')",
  "const probe = (port) => new Promise((res) => {",
  "  const s = net.connect(port, 'host.docker.internal', () => s.write('GET /json/version HTTP/1.1\\r\\nHost: localhost\\r\\n\\r\\n'))",
  "  s.on('data', (d) => { res(String(d).split('\\r\\n')[0]); s.destroy() })",
  "  s.on('error', (e) => res('error ' + e.code)); setTimeout(() => res('timeout'), 4000)",
  "})",
  `Promise.all([probe(${peerCdpPort}), probe(${peerShimPort})]).then((r) => console.log(r.join(' | ')))`,
].join('\n'))
const viaHost = (await computer.shell('node probe-host.js')).stdout.trim()
check('another bot cannot drive this one\'s browser or shell via the host', !/ 200 /.test(viaHost), viaHost)

const started = Date.now()
const background = await computer.shell('(sleep 30 &); echo started')
check('a background job does not hold the call open', background.stdout.includes('started') && Date.now() - started < 5000,
  `${Date.now() - started} ms`)

const stop = new AbortController()
const long = computer.shell('sleep 45; echo done', 60_000, stop.signal).catch(() => 'stopped')
await new Promise((r) => setTimeout(r, 1500))
stop.abort()
await long
await new Promise((r) => setTimeout(r, 800))
const leftover = await computer.shell('pgrep -f "slee[p] 45" || echo none')
check('a stopped command is killed in the container, children included', leftover.stdout.trim() === 'none', leftover.stdout.trim())

await computer.shell('pkill -f "chromium.*remote-debugging-port" || true')
await new Promise((r) => setTimeout(r, 1500))
await waitForCdp(endpoints.cdp, 30_000, fetch, endpoints.shimToken)
const again = await computer.goto('https://example.com')
check('browser comes back after chromium is killed', /example/i.test(again.title), again.title)

await computer.dispose()
console.log(`\ncontainers left running: ${containerName(BOT)}, ${containerName(PEER)}`)
console.log(`clean up with: docker rm -f ${containerName(BOT)} ${containerName(PEER)}`)
const failed = checks.filter((c) => !c.ok)
if (failed.length) { console.error(`\n${failed.length} check(s) failed`); process.exit(1) }
console.log('\nall checks passed')
