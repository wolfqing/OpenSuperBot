# OpenSuperBot desktop app

The Electron shell. It starts the gateway in a utility process, waits for it to say it is ready, signs the window
in with the gateway's token (a cookie, so there is no sign-in link) and shows the UI. If the gateway crashes it
is restarted (at most 3 times in 5 minutes); if it cannot start, the window shows an error page with the last log
lines, a button to copy diagnostics and one to open the log folder. Only one copy runs at a time.

There is no download yet (release builds and update notices are still in progress). To run it from a checkout:

```bash
pnpm install
pnpm --filter @opensuperbot/desktop install-electron   # once: fetches the Electron binary
pnpm desktop                                          # builds web, gateway and desktop, then opens the app
```

In China, fetch Electron through the mirror:
`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ pnpm --filter @opensuperbot/desktop install-electron`.

Everything the app keeps is in one folder, named `OpenSuperBot` whatever the app is called later:

| | |
|---|---|
| macOS | `~/Library/Application Support/OpenSuperBot` |
| Linux | `$XDG_DATA_HOME/OpenSuperBot` (default `~/.local/share/OpenSuperBot`) |

The gateway listens on 127.0.0.1, port 4747. If something else already uses it (a gateway run from source, say),
the app takes the next free port and keeps using that one from then on, so webhook addresses and tunnels stay
put; Settings → About shows it. `OPENSUPERBOT_PORT` pins a port instead.

Inside it: `data/` (the gateway's data: database, token, model key, teammates' folders, the downloaded browser),
`session/` (the window's own cookies and cache), `logs/gateway.log` and `desktop.json` (the port it settled on). `OPENSUPERBOT_DESKTOP_ROOT` moves the
whole folder, for development and tests. Deleting the folder removes everything.

Closing the window does not quit: teammates keep working and routines keep firing. The menu bar icon (the tray on
Linux) opens the window again and says how many teammates are working and how much waits on you; the Dock badge
counts what waits on you. While the window is away, approvals, questions and sign-in requests arrive as system
notifications, and clicking one opens that thread. Quitting from the menu bar icon or with ⌘Q asks first when a
teammate is working or a routine is on, because nothing runs once the app is closed. A quit the app did not start
(logging out, shutting down, a signal) never asks, so it cannot hold up a shutdown. On Linux desktops without a
tray (GNOME without the AppIndicator extension), open the app again to bring the window back.

The window shows only the gateway's UI. Links to other sites open in your browser; the gateway's own pages
(a teammate's screen, an attachment) open in an app window, signed in; other kinds of links are blocked.
Attachments download into your Downloads folder without overwriting a file of the same name. Pages may show
notifications and write to the clipboard (the Copy buttons), nothing else: no camera, microphone, location or
clipboard reading.

The app can open when you log in. It is off until you tick it, on the setup wizard's last step or in Settings →
Desktop app. On macOS it is a login item; if the system will not register it (an unsigned build, say) the app
writes `~/Library/LaunchAgents/io.github.wolfqing.opensuperbot.plist` instead, which opens the app at login. If
you turned it off in System Settings → General → Login Items, the app says so rather than going around you. On
Linux it writes `~/.config/autostart/opensuperbot.desktop` (`$XDG_CONFIG_HOME` if set; the AppImage's own path
for an AppImage). Run from source it is not offered, because the login item would open a bare Electron.

Pages get no Node and no Electron. The main window's page sees one frozen object, `window.opensuperbot`, with
`info()` (app version, platform, Electron version) and `loginItem.get()` / `loginItem.set(on)`; every call is
checked in the main process to come from the gateway's own page, not a frame inside it or the error page.

For smoke tests: `OPENSUPERBOT_DESKTOP_NO_EXTERNAL=1` logs links instead of opening the browser,
`OPENSUPERBOT_DESKTOP_DOWNLOADS` points downloads at another folder, and with `OPENSUPERBOT_DESKTOP_TEST=1` the app
reads `close` and `quit` from standard input, while `OPENSUPERBOT_DESKTOP_QUIT_ANSWERS=cancel,quit` answers the quit
question in order, and `OPENSUPERBOT_DESKTOP_LOGIN_HOME` makes start at login act as in an installed app but write
under that folder instead of your home, never touching the real login items. The tray icons and the app icon come
from `node desktop/scripts/icons.mjs`.

## Building the installers

```bash
pnpm desktop:package                                   # this OS: two dmgs on macOS (arm64, x64), AppImage + deb on Linux
pnpm --filter @opensuperbot/desktop package:linux      # Linux packages (x64, arm64), also from a Mac
```

The output is in `desktop/release/`. `desktop:package` builds web, gateway and desktop, then
`desktop/scripts/stage.mjs` lays out what the app carries in `desktop/stage/`: the gateway (`dist` and its
production dependencies from `pnpm deploy --prod`, flat, no links, without type declarations and source maps), the
built UI and the preset teammates. They go into the app's resources outside the asar, because the gateway runs
as a plain file and its dependencies read their own files. `desktop/scripts/after-pack.cjs` then keeps only the
target's better-sqlite3 prebuild (they are N-API, nothing is rebuilt for Electron) and drops Electron's
`default_app.asar`. Settings are in `desktop/electron-builder.config.cjs`.

- macOS: ad-hoc signed and not notarized (there is no developer account yet), so the first open needs
  "Open Anyway" in System Settings → Privacy & Security. The dmg window shows the app next to an Applications
  shortcut, to drag it there.
- Linux: the AppImage uses the static AppImage runtime, which needs neither FUSE 2 nor any other system library;
  the gateway strips the AppImage's `LD_LIBRARY_PATH`, `GSETTINGS_SCHEMA_DIR` and `APPDIR` before launching Chrome or
  sandboxed commands. The deb installs to `/opt/OpenSuperBot`, with a menu entry and an `opensuperbot` command,
  depends on `bubblewrap` and ALSA as well as the usual GTK and NSS libraries, and on Ubuntu 24.04+ installs AppArmor
  `userns` profiles for the app, its downloaded browser and `/usr/bin/bwrap` (when no profile covers `bwrap` yet). On
  Ubuntu 24.04+, prefer the deb: an AppImage cannot install AppArmor profiles, so commands stay off and say why
  rather than running without a sandbox.

In China, fetch through the mirrors: `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` and
`ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`.
