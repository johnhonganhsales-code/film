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

// Lấy direct download URL từ Drive bằng cách follow tất cả redirect
async function resolveGDriveUrl(fileId) {
  const urls = [
    // Thử nhiều format khác nhau
    `https://drive.google.com/uc?id=${fileId}&export=download&confirm=t`,
    `https://drive.usercontent.google.com/u/0/uc?id=${fileId}&export=download&confirm=t`,
  ]

  for (const startUrl of urls) {
    try {
      let currentUrl = startUrl
      let cookies = ''

      // Follow redirect tối đa 5 bước
      for (let i = 0; i < 5; i++) {
        const r = await fetch(currentUrl, {
          redirect: 'manual',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
            ...(cookies ? { 'Cookie': cookies } : {})
          }
        })

        // Thu thập cookie
        const setCookie = r.headers.get('set-cookie')
        if (setCookie) {
          const newCookies = setCookie.split(',').map(c => c.split(';')[0].trim()).join('; ')
          cookies = cookies ? cookies + '; ' + newCookies : newCookies
        }

        const loc = r.headers.get('location')
        console.log(`[GDRIVE] Step ${i+1}: status=${r.status} loc=${loc ? loc.substring(0,80) : 'none'}`)

        if (r.status === 200) {
          const ct = r.headers.get('content-type') || ''
          if (ct.includes('video') || ct.includes('octet-stream')) {
            // Đây là file thật!
            return { url: currentUrl, cookies }
          }
          // Là HTML → thử parse confirm token
          const html = await r.text()
          const confirmMatch = html.match(/confirm=([0-9A-Za-z_\-]+)/)
          const uuidMatch = html.match(/uuid=([0-9A-Za-z_\-]+)/)
          if (confirmMatch) {
            const confirm = confirmMatch[1]
            const uuid = uuidMatch ? uuidMatch[1] : ''
            currentUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=${confirm}${uuid ? '&uuid='+uuid : ''}`
            console.log('[GDRIVE] Found confirm token, new URL:', currentUrl.substring(0,100))
            continue
          }
          break
        }

        if (r.status === 301 || r.status === 302 || r.status === 303 || r.status === 307 || r.status === 308) {
          if (loc) {
            currentUrl = loc
            continue
          }
        }

        break
      }

      return { url: currentUrl, cookies }
    } catch(e) {
      console.error('[GDRIVE] URL failed:', startUrl, e.message)
    }
  }

  throw new Error('Không resolve được Drive URL')
}

app.get('/gdrive', async (req, res) => {
  const fileId = req.query.id
  if (!fileId) return res.status(400).send('No file ID')

  try {
    console.log('[GDRIVE] Resolving:', fileId)
    const { url: directUrl, cookies } = await resolveGDriveUrl(fileId)
    console.log('[GDRIVE] Direct URL:', directUrl.substring(0, 100))

    const rangeHeader = req.headers['range']
    const fetchHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      ...(cookies ? { 'Cookie': cookies } : {}),
      ...(rangeHeader ? { 'Range': rangeHeader } : {})
    }

    const r = await fetch(directUrl, { headers: fetchHeaders })
    const ct = r.headers.get('content-type') || ''
    console.log('[GDRIVE] Final status:', r.status, '| CT:', ct)

    if (ct.includes('html')) {
      console.error('[GDRIVE] Still getting HTML!')
      return res.status(502).send('Drive trả về HTML, không phải video')
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
