# Arus Browser Extension

Manifest V3 companion for Chrome and Firefox. Hands downloads to the Arus desktop
app over **Native Messaging** (stdio length-prefixed JSON → local named pipe).

> **This is the only active companion.** Do not load `extension-legacy-http/`
> (old HTTP bridge) — that folder is historical only.

## Develop / build

```bash
cd extension
npm install
npm run build            # dist/chrome + dist/firefox
npm run build:chrome
npm run build:firefox
npm run package          # zips + web-ext Firefox artifact → artifacts/
```

From the repo root:

```bash
npm run build:extension:chrome
npm run build:extension:firefox
npm run package:extension
```

## Install

1. Start **Arus** (registers the native host `com.genghero.arus` automatically when
   Browser integration is enabled).
2. Chrome / Edge / Brave → `chrome://extensions` → Developer mode → **Load unpacked**
   → select `extension/dist/chrome`.
3. Firefox → `about:debugging` → This Firefox → **Load Temporary Add-on**
   → select `extension/dist/firefox/manifest.json`.

Stable Chrome unpacked ID (from manifest `key`): `pnmkpgoolmmekpecphmakboegpajanmc`  
Firefox ID: `arus@genghero.com`

## Behavior

- Auto-intercepts eligible downloads via `downloads.onCreated`
- Context menu: **Download with Arus**
- Popup: connection status, auto-intercept toggle, min size (MB)
- If Arus / native host is unavailable, the browser download continues unchanged

## Dependencies

- `webextension-polyfill`
- `vite` (dev)
- `web-ext` (dev, packaging)
