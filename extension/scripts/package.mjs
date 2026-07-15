import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const artifacts = join(root, 'artifacts')

async function zipDir(sourceDir, zipPath) {
  rmSync(zipPath, { force: true })
  if (process.platform === 'win32') {
    const ps = `Compress-Archive -Path '${join(sourceDir, '*')}' -DestinationPath '${zipPath}' -Force`
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], {
      stdio: 'inherit'
    })
    if (result.status !== 0) {
      throw new Error(`Failed to zip ${sourceDir}`)
    }
    return
  }

  const result = spawnSync('zip', ['-r', zipPath, '.'], { cwd: sourceDir, stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`Failed to zip ${sourceDir}`)
  }
}

async function main() {
  const build = spawnSync(process.execPath, [join(root, 'scripts/build.mjs')], {
    cwd: root,
    stdio: 'inherit'
  })
  if (build.status !== 0) {
    process.exit(build.status || 1)
  }

  mkdirSync(artifacts, { recursive: true })

  const chromeDist = join(root, 'dist/chrome')
  const firefoxDist = join(root, 'dist/firefox')
  if (!existsSync(chromeDist) || !existsSync(firefoxDist)) {
    throw new Error('Missing dist/chrome or dist/firefox — run build first')
  }

  await zipDir(chromeDist, join(artifacts, 'arus-extension-chrome.zip'))

  const webExt = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    [
      'web-ext',
      'build',
      `--source-dir=${firefoxDist}`,
      `--artifacts-dir=${artifacts}`,
      '--filename=arus-extension-firefox.zip',
      '--overwrite-dest'
    ],
    { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' }
  )
  if (webExt.status !== 0) {
    console.warn('web-ext build failed; falling back to zip')
    await zipDir(firefoxDist, join(artifacts, 'arus-extension-firefox.zip'))
  }

  const unpacked = join(artifacts, 'unpacked')
  rmSync(unpacked, { recursive: true, force: true })
  mkdirSync(unpacked, { recursive: true })
  cpSync(chromeDist, join(unpacked, 'chrome'), { recursive: true })
  cpSync(firefoxDist, join(unpacked, 'firefox'), { recursive: true })

  console.log('Packaged extension artifacts in extension/artifacts')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
