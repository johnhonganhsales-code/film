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
  id: 'com.myfilms.gdrive3',
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

async function resolveGDriveUrl(fileId) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
  let cookies = ''

  // Bước 1: request đầu, lấy cookie + redirect
  const url1 = `https://drive.google.com/uc?id=${fileId}&export=download`
  const r1 = await fetch(url1, {
    redirect: 'manual',
    headers: { 'User-Agent': UA }
  })

  // Thu cookie
  const sc1 = r1.headers.get('set-cookie')
  if (sc1) cookies = sc1.split(',').map(c => c.split(';')[0].trim()).join('; ')

  const loc1 = r1.headers.get('location')
  console.log('[GDRIVE] Step1 status:', r1.status, 'loc:', loc1 ? loc1.substring(0, 80) : 'none')

  let url2 = loc1 || url1

  // Bước 2: follow redirect, đọc HTML để lấy confirm + uuid
  const r2 = await fetch(url2, {
    redirect: 'follow',
    headers: { 'User-Agent': UA, ...(cookies ? { Cookie: cookies } : {}) }
  })

  const sc2 = r2.headers.get('set-cookie')
  if (sc2) {
    const c2 = sc2.split(',').map(c => c.split(';')[0].trim()).join('; ')
    cookies = cookies ? cookies + '; ' + c2 : c2
  }

  const ct2 = r2.headers.get('content-type') || ''
  console.log('[GDRIVE] Step2 status:', r2.status, 'ct:', ct2)

  // Nếu không phải HTML → đây là file thật rồi
  if (!ct2.includes('html')) {
    return { url: url2, cookies }
  }

  // Parse HTML lấy confirm token và uuid
  const html = await r2.text()

  // Tìm confirm token trong form hoặc link
  const confirmMatch = html.match(/[?&]confirm=([0-9A-Za-z_\-]+)/)
  const uuidMatch = html.match(/[?&]uuid=([0-9A-Za-z_\-]+)/)

  if (!confirmMatch) {
    // Log 200 ký tự HTML để debug
    console.error('[GDRIVE] Không tìm thấy confirm token. HTML snippet:', html.substring(0, 300))
    throw new Error('Không tìm thấy confirm token trong HTML')
  }

  const confirm = confirmMatch[1]
  const uuid = uuidMatch ? uuidMatch[1] : ''
  console.log('[GDRIVE] confirm:', confirm, 'uuid:', uuid)

  const finalUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=${confirm}${uuid ? '&uuid=' + uuid : ''}`
  console.log('[GDRIVE] Final URL:', finalUrl)

  return { url: finalUrl, cookies }
}

app.get('/gdrive', async (req, res) => {
  const fileId = req.query.id
  if (!fileId) return res.status(400).send('No file ID')

  try {
    const { url: directUrl, cookies } = await resolveGDriveUrl(fileId)

    const rangeHeader = req.headers['range']
    const r = await fetch(directUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        ...(cookies ? { Cookie: cookies } : {}),
        ...(rangeHeader ? { Range: rangeHeader } : {})
      }
    })

    const ct = r.headers.get('content-type') || ''
    console.log('[GDRIVE] Stream status:', r.status, '| CT:', ct)

    if (ct.includes('html')) {
      const snippet = await r.text()
      console.error('[GDRIVE] Vẫn HTML:', snippet.substring(0, 200))
      return res.status(502).send('Drive vẫn trả HTML')
    }

    res.status(r.status)
    res.set('Content-Type', ct || 'video/mp4')
    res.set('Access-Control-Allow-Origin', '*')
    res.set('Accept-Ranges', 'bytes')

    const cl = r.headers.get('content-length')
    if (cl) res.set('Content-Length', cl)
    const cr = r.headers.get('content-range')
    if (cr) res.set('Content-Range', cr)

    r.body.pipe(res)
    req.on('close', () => r.body.destroy())

  } catch (e) {
    console.error('[GDRIVE ERROR]', e.message)
    if (!res.headersSent) res.status(500).send('error: ' + e.message)
  }
})

app.use('/', getRouter(builder.getInterface()))

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Addon: http://localhost:${PORT}/manifest.json`)
})
