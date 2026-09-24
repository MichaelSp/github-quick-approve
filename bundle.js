import fs from 'node:fs'
import path from 'node:path'
import archiver from 'archiver'

const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const userscript = fs.readFileSync('GithubQuickApprove.user.js', 'utf8')
const header = userscript.match(/^[\s\S]*?\/\/ ==\/UserScript==\n/)?.[0]
if (!header) throw new Error('userscript metadata header not found')

const core = fs.readFileSync('core.js', 'utf8').replace(/^export /gm, '')
const runtime = `${core}\n\nif (document.readyState === 'loading') {\n  document.addEventListener('DOMContentLoaded', observeUrlChange, { once: true })\n} else {\n  observeUrlChange()\n}\n`
fs.writeFileSync('GithubQuickApprove.user.js', `${header}\n${runtime}`)

const writeDist = (browser, fileName, content) => {
  const dir = path.join('dist', browser)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, fileName), content)
}

const matches = ['https://github.com/*', 'https://github.tools.sap/*']
const commonManifest = {
  name: 'Github Quick Approve',
  version,
  description: 'Quick approve on your pull request',
  content_scripts: [{ matches, js: ['index.js'], run_at: 'document_end' }],
  permissions: ['storage'],
  icons: { 16: 'icon_16.png', 48: 'icon_48.png', 128: 'icon_128.png', 256: 'icon_256.png' },
  host_permissions: ['https://github.com/*', 'https://api.github.com/*', 'https://github.tools.sap/*'],
}

writeDist('chrome', 'manifest.json', JSON.stringify({ manifest_version: 3, ...commonManifest }, null, 2))
const { host_permissions, ...firefoxManifest } = { manifest_version: 2, ...commonManifest, permissions: [...commonManifest.host_permissions, ...commonManifest.permissions] }
writeDist('firefox', 'manifest.json', JSON.stringify(firefoxManifest, null, 2))

for (const iconFile of fs.readdirSync(path.join('assets', 'icons'))) {
  const icon = fs.readFileSync(path.join('assets', 'icons', iconFile))
  writeDist('chrome', iconFile, icon)
  writeDist('firefox', iconFile, icon)
}

for (const browser of ['chrome', 'firefox']) {
  writeDist(browser, 'index.js', runtime)
  if (process.argv.includes('zip')) {
    const archive = archiver('zip', { zlib: { level: 9 } })
    archive.pipe(fs.createWriteStream(`${browser}_${version}.zip`))
    archive.directory(path.join('dist', browser), false)
    archive.finalize()
  }
}

console.info('Generated userscript and extension builds from core.js')
