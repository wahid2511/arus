import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import {
  CHROME_EXTENSION_ID,
  FIREFOX_EXTENSION_ID,
  NATIVE_HOST_NAME,
  PIPE_NAME
} from './constants'

export interface NativeHostInstallResult {
  ok: boolean
  hostName: string
  launcherPath: string
  chromeManifestPath: string
  firefoxManifestPath: string
  chromeExtensionId: string
  firefoxExtensionId: string
  error?: string
}

/** Self-contained CommonJS host — no Electron GUI, stdio ↔ named pipe. */
function writeHostScript(dir: string): string {
  const scriptPath = join(dir, 'arus-native-host.js')
  const source = `'use strict';
const net = require('net');
const PIPE = ${JSON.stringify(PIPE_NAME)};

function readExact(stream, size) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    const onData = (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      received += buf.length;
      if (received >= size) {
        cleanup();
        const all = Buffer.concat(chunks);
        resolve(all.subarray(0, size));
        const rest = all.subarray(size);
        if (rest.length && typeof stream.unshift === 'function') stream.unshift(rest);
      }
    };
    const onEnd = () => { cleanup(); reject(new Error('Unexpected end of stream')); };
    const onError = (err) => { cleanup(); reject(err); };
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
    };
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

async function readMessage(stream) {
  const header = await readExact(stream, 4);
  const length = header.readUInt32LE(0);
  if (length <= 0 || length > 1024 * 1024) throw new Error('Invalid message length');
  const body = await readExact(stream, length);
  return JSON.parse(body.toString('utf8'));
}

function writeMessage(stream, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  stream.write(header);
  stream.write(body);
}

function askBridge(request) {
  return new Promise((resolve) => {
    const socket = net.createConnection(PIPE);
    const fail = (error) => {
      try { socket.destroy(); } catch (_) {}
      resolve({ type: 'error', ok: false, error });
    };
    socket.setTimeout(5000);
    socket.once('timeout', () => fail('Timed out connecting to Arus'));
    socket.once('error', (err) => {
      fail(/ENOENT|ECONNREFUSED/i.test(err.message) ? 'Arus is not running' : err.message);
    });
    socket.once('connect', () => {
      socket.write(JSON.stringify(request) + '\\n');
    });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const idx = buffer.indexOf('\\n');
      if (idx < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, idx));
        socket.end();
        resolve(response);
      } catch (_) {
        fail('Invalid response from Arus');
      }
    });
  });
}

(async () => {
  try {
    const request = await readMessage(process.stdin);
    const response = await askBridge(request);
    writeMessage(process.stdout, response);
  } catch (error) {
    writeMessage(process.stdout, {
      type: 'error',
      ok: false,
      error: error && error.message ? error.message : 'Native host failure'
    });
  } finally {
    try { process.stdout.end(); } catch (_) {}
    process.exit(0);
  }
})();
`
  writeFileSync(scriptPath, source, 'utf8')
  return scriptPath
}

function writeLauncher(dir: string, hostScriptPath: string): string {
  const electronPath = process.execPath
  if (process.platform === 'win32') {
    const launcherPath = join(dir, 'arus-native-host.cmd')
    // Use absolute paths; quote carefully for Chrome native messaging.
    writeFileSync(
      launcherPath,
      [
        '@echo off',
        'setlocal',
        'set ELECTRON_RUN_AS_NODE=1',
        `"${electronPath}" "${hostScriptPath}"`
      ].join('\r\n') + '\r\n',
      'utf8'
    )
    return launcherPath
  }

  const launcherPath = join(dir, 'arus-native-host.sh')
  writeFileSync(
    launcherPath,
    `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "${electronPath}" "${hostScriptPath}"\n`,
    'utf8'
  )
  try {
    chmodSync(launcherPath, 0o755)
  } catch {
    // ignore
  }
  return launcherPath
}

function chromeHostManifest(launcherPath: string, extensionId: string): string {
  return JSON.stringify(
    {
      name: NATIVE_HOST_NAME,
      description: 'Arus native messaging host',
      path: launcherPath,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${extensionId}/`]
    },
    null,
    2
  )
}

function firefoxHostManifest(launcherPath: string, extensionId: string): string {
  return JSON.stringify(
    {
      name: NATIVE_HOST_NAME,
      description: 'Arus native messaging host',
      path: launcherPath,
      type: 'stdio',
      allowed_extensions: [extensionId]
    },
    null,
    2
  )
}

function hostDir(): string {
  return join(app.getPath('userData'), 'native-messaging')
}

function linuxOrMacManifestDirs(): { chrome: string[]; firefox: string[] } {
  const home = app.getPath('home')
  if (process.platform === 'darwin') {
    return {
      chrome: [
        join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
        join(home, 'Library/Application Support/Chromium/NativeMessagingHosts'),
        join(home, 'Library/Application Support/Microsoft Edge/NativeMessagingHosts'),
        join(home, 'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts')
      ],
      firefox: [join(home, 'Library/Application Support/Mozilla/NativeMessagingHosts')]
    }
  }

  return {
    chrome: [
      join(home, '.config/google-chrome/NativeMessagingHosts'),
      join(home, '.config/chromium/NativeMessagingHosts'),
      join(home, '.config/microsoft-edge/NativeMessagingHosts'),
      join(home, '.config/BraveSoftware/Brave-Browser/NativeMessagingHosts')
    ],
    firefox: [join(home, '.mozilla/native-messaging-hosts')]
  }
}

function registerWindowsRegistry(manifestPath: string, browser: 'chrome' | 'firefox' | 'edge' | 'brave'): void {
  const keys: Record<string, string> = {
    chrome: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
    edge: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
    brave: `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
    firefox: `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
  }
  execFileSync('reg', ['add', keys[browser], '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], {
    stdio: 'ignore'
  })
}

export function installNativeMessagingHost(options?: {
  chromeExtensionId?: string
}): NativeHostInstallResult {
  const chromeExtensionId = options?.chromeExtensionId || CHROME_EXTENSION_ID
  const dir = hostDir()
  const chromeManifestPath = join(dir, `${NATIVE_HOST_NAME}.chrome.json`)
  const firefoxManifestPath = join(dir, `${NATIVE_HOST_NAME}.firefox.json`)

  try {
    mkdirSync(dir, { recursive: true })
    const hostScriptPath = writeHostScript(dir)
    const launcherPath = writeLauncher(dir, hostScriptPath)
    // Clean up legacy typo filenames (aras → arus) from earlier builds.
    for (const name of ['aras-native-host.js', 'aras-native-host.cmd', 'aras-native-host.sh']) {
      try {
        const legacy = join(dir, name)
        if (existsSync(legacy)) {
          unlinkSync(legacy)
        }
      } catch {
        // ignore
      }
    }
    writeFileSync(chromeManifestPath, chromeHostManifest(launcherPath, chromeExtensionId), 'utf8')
    writeFileSync(
      firefoxManifestPath,
      firefoxHostManifest(launcherPath, FIREFOX_EXTENSION_ID),
      'utf8'
    )

    if (process.platform === 'win32') {
      registerWindowsRegistry(chromeManifestPath, 'chrome')
      registerWindowsRegistry(chromeManifestPath, 'edge')
      registerWindowsRegistry(chromeManifestPath, 'brave')
      registerWindowsRegistry(firefoxManifestPath, 'firefox')
    } else {
      const dirs = linuxOrMacManifestDirs()
      for (const path of dirs.chrome) {
        mkdirSync(path, { recursive: true })
        writeFileSync(
          join(path, `${NATIVE_HOST_NAME}.json`),
          chromeHostManifest(launcherPath, chromeExtensionId),
          'utf8'
        )
      }
      for (const path of dirs.firefox) {
        mkdirSync(path, { recursive: true })
        writeFileSync(
          join(path, `${NATIVE_HOST_NAME}.json`),
          firefoxHostManifest(launcherPath, FIREFOX_EXTENSION_ID),
          'utf8'
        )
      }
    }

    return {
      ok: true,
      hostName: NATIVE_HOST_NAME,
      launcherPath,
      chromeManifestPath,
      firefoxManifestPath,
      chromeExtensionId,
      firefoxExtensionId: FIREFOX_EXTENSION_ID
    }
  } catch (error) {
    return {
      ok: false,
      hostName: NATIVE_HOST_NAME,
      launcherPath: join(dir, process.platform === 'win32' ? 'arus-native-host.cmd' : 'arus-native-host.sh'),
      chromeManifestPath,
      firefoxManifestPath,
      chromeExtensionId,
      firefoxExtensionId: FIREFOX_EXTENSION_ID,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function resolveExtensionDistPath(): string | null {
  const candidates = [
    join(process.resourcesPath, 'extension', 'chrome'),
    join(__dirname, '../../../extension/dist/chrome'),
    join(process.cwd(), 'extension/dist/chrome'),
    join(app.getAppPath(), 'extension/dist/chrome')
  ]
  return candidates.find((path) => existsSync(path)) ?? null
}
