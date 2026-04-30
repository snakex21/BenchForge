const fs = require('fs/promises')
const path = require('path')
const { app, BrowserWindow } = require('electron')

const root = path.join(__dirname, '..')
const indexHtml = path.join(root, 'frontend', 'dist', 'index.html')
const outDir = path.join(root, 'docs', 'screenshots')

const views = [
  ['arena', 'arena.png'],
  ['runner', 'runner.png'],
  ['models', 'models.png'],
  ['benchmarks', 'benchmarks.png'],
  ['results', 'results.png'],
  ['stats', 'stats.png'],
  ['settings', 'settings.png'],
]

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function capture(win, view, fileName) {
  await win.loadFile(indexHtml, { query: { view } })
  await wait(1800)
  await win.webContents.executeJavaScript('document.fonts?.ready ? document.fonts.ready.then(() => true) : true')
  await wait(300)
  const image = await win.webContents.capturePage()
  await fs.writeFile(path.join(outDir, fileName), image.toPNG())
  console.log(`captured ${fileName}`)
}

app.whenReady().then(async () => {
  await fs.mkdir(outDir, { recursive: true })
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'screenshot-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })

  try {
    for (const [view, fileName] of views) {
      await capture(win, view, fileName)
    }
  } finally {
    win.close()
    app.quit()
  }
})
