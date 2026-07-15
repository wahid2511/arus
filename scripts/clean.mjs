import { rmSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = (process.argv[2] || 'all').toLowerCase()

const APP_PATHS = ['out', 'release', 'dist']
const EXTENSION_PATHS = ['extension/dist', 'extension/artifacts']

function removePath(relativePath) {
  const absolute = join(root, relativePath)
  if (!existsSync(absolute)) {
    console.log(`skip  ${relativePath} (missing)`)
    return
  }
  rmSync(absolute, { recursive: true, force: true })
  console.log(`removed  ${relativePath}`)
}

const paths = []
if (target === 'all' || target === 'app') {
  paths.push(...APP_PATHS)
}
if (target === 'all' || target === 'extension') {
  paths.push(...EXTENSION_PATHS)
}

if (!paths.length) {
  console.error('Usage: node scripts/clean.mjs [all|app|extension]')
  process.exit(1)
}

console.log(`Cleaning (${target})…`)
for (const path of paths) {
  removePath(path)
}
console.log('Done.')
