import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function resolveAppIcon(): string | undefined {
  const candidates = [
    join(process.resourcesPath, 'icon.png'),
    join(__dirname, '../../../resources/icon.png'),
    join(process.cwd(), 'resources', 'icon.png'),
    join(app.getAppPath(), 'resources', 'icon.png')
  ]
  return candidates.find((path) => existsSync(path))
}
