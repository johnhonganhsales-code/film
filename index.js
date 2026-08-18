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
    poster: '',
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

  // Trả thẳng /gdrive-redirect để server resolve URL rồi redirect cho Stremio tự fetch
  const streamUrl = `${RENDER_URL}/gdrive-redirect?id=${v.fileId}`
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

// Resolve Drive URL rồi redirect thẳng — Stremio tự fetch, hỗ trợ range request
app.get('/gdrive-redirect', async (req, res) => {
  const fileId = req.query.id
  if (!fileId) return res.status(400).send('No file ID')

  try {
    console.log('[GDRIVE] Resolving fileId:', fileId)

    // Dùng drive.usercontent.google.com — hỗ trợ range và redirect tốt hơn
    const url1 = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`

    // Follow redirect để lấy URL cuối cùng có token
    const r1 = await fetch(url1, {
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
      }
    })

    const location = r1.headers.get('location')
    console.log('[GDRIVE] Status:', r1.status, '| Location:', location)

    if (location) {
      // Redirect cho Stremio tự fetch URL thật
      console.log('[GDRIVE] Redirecting to:', location)
      return res.redirect(302, location)
    }

    // Không có redirect → dùng luôn url1
    console.log('[GDRIVE] No redirect, using direct URL')
    return res.redirect(302, url1)

  } catch (e) {
    console.error('[GDRIVE ERROR]', e.message)
    if (!res.headersSent) res.status(500).send('error: ' + e.message)
  }
})

app.use('/', getRouter(builder.getInterface()))

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Addon: http://localhost:${PORT}/manifest.json`)
})
