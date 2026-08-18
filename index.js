const { addonBuilder, getRouter } = require('stremio-addon-sdk')
const fetch = require('node-fetch')
const express = require('express')

const ADDON_NAME = 'MyFilms'
const PORT = process.env.PORT || 7000
const RENDER_URL = 'https://film-rbkk.onrender.com'

const VIDEOS = [
  {
    id: 'phim-1',
    name: 'Phim 1',
    fileId: '1S91xehn-0zqRxW99FZ1b8be6JEo1TQ2L',
    poster: 'https://drive.google.com/file/d/1gH5GztZbGPzpsMBYyKKKAQlPNzTbfz0Z/view?usp=drive_link',
    description: ''
  },
]

const builder = new addonBuilder({
  id: 'com.myfilms.gdrive',
  version: '1.0.0',
  name: ADDON_NAME,
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie'],
  catalogs: [
    { type: 'movie', id: 'myfilms-catalog', name: ADDON_NAME, extra: [{ name: 'skip' }] }
  ]
})

builder.defineCatalogHandler(async ({ extra }) => {
  const skip = extra.skip ? parseInt(extra.skip) : 0
  const metas = VIDEOS.slice(skip, skip + 20).map(v => ({
    id: `myfilm:${v.id}`,
    type: 'movie',
    name: v.name,
    poster: v.poster || `https://via.placeholder.com/300x450?text=${encodeURIComponent(v.name)}`
  }))
  return { metas }
})

builder.defineMetaHandler(async ({ id }) => {
  const key = id.replace('myfilm:', '')
  const v = VIDEOS.find(x => x.id === key)
  if (!v) return { meta: {} }
  return {
    meta: {
      id,
      type: 'movie',
      name: v.name,
      poster: v.poster || `https://via.placeholder.com/300x450?text=${encodeURIComponent(v.name)}`,
      description: v.description || ''
    }
  }
})

builder.defineStreamHandler(async ({ id }) => {
  const key = id.replace('myfilm:', '')
  const v = VIDEOS.find(x => x.id === key)
  if (!v) return { streams: [] }
  const streamUrl = `${RENDER_URL}/gdrive?id=${v.fileId}`
  return {
    streams: [{ url: streamUrl, name: 'HD', title: v.name }]
  }
})

const app = express()

app.get('/ping', (req, res) => {
  res.set('Cache-Control', 'no-cache')
  res.send('ok')
})
function keepAlive() {
  fetch(`${RENDER_URL}/ping`)
    .then(() => console.log('[KEEP-ALIVE] ok'))
    .catch(e => console.error('[KEEP-ALIVE]', e.message))
}
setTimeout(keepAlive, 5000)
setInterval(keepAlive, 13 * 60 * 1000)

// Proxy thật sự với range request support
// Google Drive usercontent hỗ trợ range nếu ta tự pipe đúng cách
app.get('/gdrive', async (req, res) => {
  const fileId = req.query.id
  if (!fileId) return res.status(400).send('No file ID')

  try {
    const driveUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t&authuser=0`
    console.log('[GDRIVE] Fetching:', fileId)

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      'Cookie': 'NID=; CONSENT=YES+;'
    }

    // Tambahkan range header jika ada
    if (req.headers['range']) {
      headers['Range'] = req.headers['range']
      console.log('[GDRIVE] Range:', req.headers['range'])
    }

    const r = await fetch(driveUrl, { headers })
    console.log('[GDRIVE] Status:', r.status, '| Content-Type:', r.headers.get('content-type'))

    // Set response headers
    res.status(r.status)
    res.set('Content-Type', r.headers.get('content-type') || 'video/mp4')
    res.set('Access-Control-Allow-Origin', '*')
    res.set('Accept-Ranges', 'bytes')

    const cl = r.headers.get('content-length')
    if (cl) res.set('Content-Length', cl)

    const cr = r.headers.get('content-range')
    if (cr) res.set('Content-Range', cr)

    r.body.pipe(res)

    req.on('close', () => {
      r.body.destroy()
    })

  } catch (e) {
    console.error('[GDRIVE ERROR]', e.message)
    if (!res.headersSent) res.status(500).send('error: ' + e.message)
  }
})

app.use('/', getRouter(builder.getInterface()))

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Addon: http://localhost:${PORT}/manifest.json`)
})
