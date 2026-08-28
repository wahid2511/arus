# Arus Browser Extension

Manifest V3 companion for Chrome and Firefox. The extension is kept as a
separate browser companion while the desktop application is migrated to
Flutter. Its browser-to-desktop handoff uses **Native Messaging** (stdio
length-prefixed JSON → authenticated loopback bridge).

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

## Install

1. Build the extension using the commands above.
2. Chrome / Edge / Brave → `chrome://extensions` → Developer mode → **Load unpacked**
   → select `extension/dist/chrome`.
3. Firefox → `about:debugging` → This Firefox → **Load Temporary Add-on**
   → select `extension/dist/firefox/manifest.json`.

The Flutter desktop runner exposes the authenticated loopback bridge and can
also act as the Native Messaging host. Open Arus → Pengaturan → Pasang ulang
native host once per installation, then reload the extension.

Stable Chrome unpacked ID (from manifest `key`): `pnmkpgoolmmekpecphmakboegpajanmc`  
Firefox ID: `arus@arus.app`

## Behavior

- Auto-intercepts eligible downloads via `downloads.onCreated`
- Context menu: **Download with Arus**
- Popup: connection status, auto-intercept toggle, min size (MB)
- If Arus / native host is unavailable, the browser download continues unchanged

## Dependencies

- `webextension-polyfill`
- `vite` (dev)
- `web-ext` (dev, packaging)
