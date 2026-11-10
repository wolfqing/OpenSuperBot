# OpenSuperBot desktop app

The Electron shell. It starts the gateway in a utility process, waits for it to say it is ready, signs the window
in with the gateway's token (a cookie, so there is no sign-in link) and shows the UI. If the gateway crashes it
is restarted (at most 3 times in 5 minutes); if it cannot start, the window shows an error page with the last log
lines, a button to copy diagnostics and one to open the log folder. Only one copy runs at a time.

Packaging, the tray, start at login and the rest of the desktop work are still in progress; there is no download
yet. To run it from a checkout:

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

Inside it: `data/` (the gateway's data: database, token, model key, teammates' folders, the downloaded browser),
`session/` (the window's own cookies and cache) and `logs/gateway.log`. `OPENSUPERBOT_DESKTOP_ROOT` moves the
whole folder, for development and tests. Deleting the folder removes everything.
