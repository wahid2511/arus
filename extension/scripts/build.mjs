import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const target = (process.argv[2] || 'all').toLowerCase()

async function bundleEntry(entry, fileName, outDir) {
  await build({
    configFile: false,
    root,
    build: {
      outDir,
      emptyOutDir: false,
      sourcemap: false,
      minify: false,
      lib: false,
      rollupOptions: {
        input: entry,
        output: {
          entryFileNames: fileName,
          format: 'es',
          inlineDynamicImports: true
        }
      }
    }
  })
}

async function buildTarget(browserName) {
  const outDir = join(root, 'dist', browserName)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(join(outDir, 'popup'), { recursive: true })
  mkdirSync(join(outDir, 'icons'), { recursive: true })

  const tempDir = join(outDir, '.bundle')
  mkdirSync(tempDir, { recursive: true })

  await bundleEntry(join(root, 'src/background/index.ts'), 'background.js', tempDir)
  await bundleEntry(join(root, 'src/popup/main.ts'), 'popup.js', tempDir)

  cpSync(join(tempDir, 'background.js'), join(outDir, 'background.js'))
  cpSync(join(tempDir, 'popup.js'), join(outDir, 'popup/popup.js'))

  const html = readFileSync(join(root, 'src/popup/index.html'), 'utf8')
    .replace('./main.ts', './popup.js')
    .replace('../icons/', '../icons/')

  writeFileSync(join(outDir, 'popup/index.html'), html)
  cpSync(join(root, 'src/popup/popup.css'), join(outDir, 'popup/popup.css'))
  cpSync(join(root, 'public/icons'), join(outDir, 'icons'), { recursive: true })

  const manifestName =
    browserName === 'firefox' ? 'manifest.firefox.json' : 'manifest.chrome.json'
  const manifest = JSON.parse(readFileSync(join(root, 'src', manifestName), 'utf8'))
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  rmSync(tempDir, { recursive: true, force: true })
  console.log(`Built extension/${browserName}`)
}

async function main() {
  if (target === 'chrome' || target === 'all') {
    await buildTarget('chrome')
  }
  if (target === 'firefox' || target === 'all') {
    await buildTarget('firefox')
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
