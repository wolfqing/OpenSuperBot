// electron-builder 配置。先 `node scripts/stage.mjs` 把网关、界面、预置同事摆进 stage/，再打包：
//   macOS：dmg（arm64、x64 各一个），ad-hoc 签名，没有公证（还没有开发者账号）
//   Linux：AppImage 和 deb（x64、arm64）
// 网关整个放在 asar 外面（Resources/gateway）：better-sqlite3 的 .node、playwright-core 的 cli.js、unpdf 都要直接读文件，
// 网关也是用 utilityProcess 当普通文件跑的。App 自己的代码（dist、托盘图标）在 asar 里。
/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'io.github.wolfqing.opensuperbot',
  productName: 'OpenSuperBot',
  copyright: 'Copyright © 2026 wolfqing and OpenSuperBot contributors',
  directories: { output: 'release', buildResources: 'resources' },
  files: ['dist/**/*', 'assets/**/*', 'package.json'],
  // stage/ 整个放进 Resources：gateway/、web/、teammates/。不能写成 from: 'stage/gateway'——
  // electron-builder 的过滤器一律丢掉 from 下面第一层的 node_modules（app-builder-lib util/filter.js），深一层的不管
  extraResources: [{ from: 'stage', to: '.', filter: ['**/*'] }],
  asar: true,
  // 没有要对 Electron 重编的原生模块（better-sqlite3 用的是 N-API 预编译，而且在 stage 里）
  npmRebuild: false,
  nodeGypRebuild: false,
  afterPack: './scripts/after-pack.cjs',
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  publish: null,
  mac: {
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    category: 'public.app-category.productivity',
    // '-' = ad-hoc 签名：Apple Silicon 上不签的 App 根本跑不起来；没有公证，第一次打开要「仍要打开」
    identity: '-',
    hardenedRuntime: false,
    gatekeeperAssess: false,
    minimumSystemVersion: '12.0',
  },
  dmg: {
    // 不做自动更新，用不上 blockmap
    writeUpdateInfo: false,
    // 窗口里一个 App、一个「应用程序」的快捷方式：引导拖进去（不拖就会被 App Translocation 从随机路径跑）
    contents: [
      { x: 140, y: 190, type: 'file' },
      { x: 400, y: 190, type: 'link', path: '/Applications' },
    ],
    window: { width: 540, height: 380 },
  },
  linux: {
    target: [{ target: 'AppImage', arch: ['x64', 'arm64'] }, { target: 'deb', arch: ['x64', 'arm64'] }],
    category: 'Utility',
    executableName: 'opensuperbot',
    // 窗口的 WM_CLASS 和 .desktop 对上，任务栏才认得是同一个 App（package.json 的 desktopName）
    syncDesktopName: true,
    synopsis: 'AI teammates that work on your computer',
    description: 'OpenSuperBot runs a small team of AI teammates on this computer: they use a browser, files and commands, and ask before anything that matters.',
    maintainer: 'wolfqing <wolfqing@users.noreply.github.com>',
  },
  // AppImage 用上游的静态 runtime（type2-runtime 20251108）：不链接任何系统库。默认的老 runtime 要 libfuse2
  // （Ubuntu 22.04 起默认没装，一打开就「AppImages require FUSE」），arm64 那份还链接了不带版本号的 libz.so
  // （只有装了 zlib1g-dev 才有），在普通桌面上根本起不来
  toolsets: { appimage: '1.0.3' },
  deb: {
    // electron-builder 默认的依赖表 + ALSA：Electron 链接了 libasound.so.2，精简系统（服务器装桌面、容器）没有就起不来。
    // Ubuntu 24.04 起它叫 libasound2t64（t64 过渡）
    depends: ['libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils', 'libatspi2.0-0', 'libuuid1', 'libsecret-1-0', 'libasound2t64 | libasound2'],
  },
}
