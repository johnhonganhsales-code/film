const { addonBuilder, getRouter } = require('stremio-addon-sdk')
const fetch = require('node-fetch')
const express = require('express')

const ADDON_NAME = 'MyFilms'
const PORT = process.env.PORT || 7000
const RENDER_URL = 'https://film-rbkk.onrender.com'

// =============================================
// THÊM PHIM VÀO ĐÂY
// id: tự đặt (không dấu, không space)
// name: tên hiển thị
// fileId: lấy từ link Google Drive
// poster: link ảnh bìa (tùy chọn)
// =============================================
const VIDEOS = [
  {
    id: 'phim-1',
    name: 'Phim 1',
    fileId: '1S91xehn-0zqRxW99FZ1b8be6JEo1TQ2L',
    poster: '',
    description: ''
  },
  // Thêm phim khác vào đây:
  // {
  //   id: 'phim-2',
  //   name: 'Tên phim 2',
  //   fileId: 'FILE_ID_TỪ_DRIVE',
  //   poster: 'https://link-anh-bia.jpg',
  //   description: 'Mô tả phim'
  // },
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

// Keep-alive
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

// Google Drive proxy — bypass redirect và stream thẳng
app.get('/gdrive', async (req, res) => {
  const fileId = req.query.id
  if (!fileId) return res.status(400).send('No file ID')

  try {
    // Bước 1: lấy redirect URL thật từ Drive
    const driveUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`
    console.log('[GDRIVE] Fetching:', driveUrl)

    const r1 = await fetch(driveUrl, {
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
      }
    })

    // Drive redirect sang URL thật
    let finalUrl = r1.headers.get('location')

    // Nếu không redirect, dùng luôn URL gốc
    if (!finalUrl) {
      finalUrl = driveUrl
    }

    console.log('[GDRIVE] Final URL:', finalUrl)

    // Bước 2: stream file về client
    const rangeHeader = req.headers['range']
    const r2 = await fetch(finalUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        ...(rangeHeader ? { 'Range': rangeHeader } : {})
      }
    })

    res.status(r2.status)
    res.set('Content-Type', r2.headers.get('content-type') || 'video/mp4')
    res.set('Access-Control-Allow-Origin', '*')

    const cl = r2.headers.get('content-length')
    if (cl) res.set('Content-Length', cl)

    const cr = r2.headers.get('content-range')
    if (cr) res.set('Content-Range', cr)

    if (r2.status === 206) res.set('Accept-Ranges', 'bytes')

    r2.body.pipe(res)
  } catch (e) {
    console.error('[GDRIVE ERROR]', e.message)
    if (!res.headersSent) res.status(500).send('error')
  }
})

app.use('/', getRouter(builder.getInterface()))

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Addon: http://localhost:${PORT}/manifest.json`)
})
