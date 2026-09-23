import fs from 'node:fs'
import path from 'node:path'
import archiver from 'archiver'

const { version } = JSON.parse(fs.readFileSync('./package.json', 'utf-8'))

console.info('Start bundling...')

function writeDist(browser, fileName, content) {
  const dir = path.join('dist', browser)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(path.join(dir, fileName), content)
}

// MANIFESTS
const commonManifest = {
  name: 'Github Quick Approve',
  version,
  description: 'Quick approve on your pull request',
  content_scripts: [
    {
      matches: ['*://*.github.com/*'],
      js: ['index.js'],
      run_at: 'document_end',
    },
  ],
  permissions: ['storage'],
  icons: {
    16: 'icon_16.png',
    48: 'icon_48.png',
    128: 'icon_128.png',
    256: 'icon_256.png',
  },
  host_permissions: ['https://www.github.com/', 'http://www.github.com/', 'https://api.github.com/'],
}

// CHROME
const chromeManifest = {
  manifest_version: 3,
  ...commonManifest,
}
writeDist('chrome', 'manifest.json', JSON.stringify(chromeManifest, null, 2))

// FIREFOX
const { host_permissions, ...firefoxManifest } = {
  manifest_version: 2,
  ...commonManifest,
  permissions: [
    ...commonManifest.host_permissions,
    ...commonManifest.permissions,
  ],
  /* browser_specific_settings: {
    gecko: {
      id: '',
      strict_min_version: '57.0a1',
    },
  }, */
}
writeDist('firefox', 'manifest.json', JSON.stringify(firefoxManifest, null, 2))

// ICONS
const iconFiles = fs.readdirSync(path.join('assets', 'icons'))
for (const iconFile of iconFiles) {
  const iconData = fs.readFileSync(path.join('assets', 'icons', iconFile))
  writeDist('chrome', iconFile, iconData)
  writeDist('firefox', iconFile, iconData)
}

function archiveBuild(browser) {
  fs.copyFileSync('index.js', path.join('dist', browser, 'index.js'))
  if (process.argv.includes('zip')) {
    const archive = archiver('zip', {
      zlib: { level: 9 },
    })
    const output = fs.createWriteStream(path.join(`${browser}_${version}.zip`))
    archive.pipe(output)
    archive.directory(path.join('dist', browser), false)
    archive.finalize()
  }
}

// CONTENT SCRIPT
archiveBuild('chrome')
archiveBuild('firefox')

console.log('✨ Done')
