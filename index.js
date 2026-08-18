const { addonBuilder, getRouter } = require('stremio-addon-sdk')
const fetch = require('node-fetch')
const cheerio = require('cheerio')
const express = require('express')

const BASE_URL = 'https://javhdz.city'
const ADDON_NAME = 'JAVHD'
const PORT = 7000

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Referer': BASE_URL + '/',
  'Origin': BASE_URL
}

const builder = new addonBuilder({
  id: 'com.myaddon.javhd',
  version: '1.0.0',
  name: ADDON_NAME,
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie'],
  catalogs: [
    { type: 'movie', id: 'javhd-movie', name: ADDON_NAME, extra: [{ name: 'skip' }] },
  ]
})

builder.defineCatalogHandler(async ({ extra }) => {
  const page = extra.skip ? Math.floor(extra.skip / 20) + 1 : 1
  const url  = `${BASE_URL}/video/page/${page}/`
  try {
    const res  = await fetch(url, { headers: HEADERS })
    const html = await res.text()
    const $    = cheerio.load(html)
    const metas = []
    const seen  = new Set()
    $('a.movie-item.m-block').each((i, el) => {
      const href  = $(el).attr('href') || ''
      const title = $(el).attr('title') || ''
      const img   = $(el).find('img').attr('src') || $(el).find('img').attr('data-src') || ''
      const slug  = href.replace(/^\//, '').replace(/\/$/, '')
      if (!slug || !title || seen.has(slug)) return
      seen.add(slug)
      const poster = img.startsWith('http') ? img : `${BASE_URL}${img}`
      metas.push({ id: `custom:${slug}`, type: 'movie', name: title, poster })
    })
    return { metas }
  } catch(e) {
    return { metas: [] }
  }
})

builder.defineMetaHandler(async ({ type, id }) => {
  const slug = id.replace('custom:', '')
  const url  = `${BASE_URL}/${slug}`
  try {
    const res  = await fetch(url, { headers: HEADERS })
    const html = await res.text()
    const $    = cheerio.load(html)
    const name   = $('h1').first().text().trim()
    const desc   = $('p.hidden').first().text().trim()
    const rawImg = $('img.public-film-item-thumb').first().attr('src') || $('img').first().attr('src') || ''
    const poster = rawImg.startsWith('http') ? rawImg : `${BASE_URL}${rawImg}`
    return { meta: { id, type, name: name || slug, description: desc, poster } }
  } catch(e) {
    return { meta: { id, type, name: slug } }
  }
})

builder.defineStreamHandler(async ({ id }) => {
  const slug = id.replace('custom:', '').split(':')[0]
  const url  = `${BASE_URL}/${slug}`
  console.log('[STREAM]', url)
  try {
    const res  = await fetch(url, { headers: HEADERS })
    const html = await res.text()
    const $    = cheerio.load(html)
    const scripts = $('script').map((i, el) => $(el).html() || '').get().join('\n')
    const streams = []

    const b64match = scripts.match(/window\.atob\(["']([A-Za-z0-9+/=]+)["']\)/)
    if (b64match) {
      const masterUrl = Buffer.from(b64match[1], 'base64').toString('utf8')
      if (masterUrl.includes('.m3u8')) {
        console.log('[STREAM] Master:', masterUrl)
        try {
          const mRes  = await fetch(masterUrl, { headers: HEADERS })
          const mText = await mRes.text()
          const baseUrl = masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1)
          const lines = mText.split('\n').map(l => l.trim()).filter(Boolean)

          for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
              const resMatch = lines[i].match(/RESOLUTION=(\d+x\d+)/)
              const label = resMatch ? resMatch[1].split('x')[1] + 'p' : 'HD'
              const subLine = lines[i+1]
              if (subLine && !subLine.startsWith('#')) {
                const subUrl = subLine.startsWith('http') ? subLine : baseUrl + subLine
                // Proxy chỉ m3u8, segment .ts trả trực tiếp
                streams.push({ url: subUrl, name: label, title: label })
                console.log('[STREAM]', label, subUrl)
              }
            }
          }
        } catch(e) {
          console.error('[STREAM] parse error:', e.message)
          streams.push({ url: masterUrl, name: 'HD', title: 'HD' })
        }
      }
    }

    if (!streams.length) {
      streams.push({ externalUrl: url, name: 'Web', title: 'Mở trình duyệt' })
    }

    return { streams }
  } catch(e) {
    console.error('[STREAM ERROR]', e.message)
    return { streams: [] }
  }
})

// ── EXPRESS ───────────────────────────────
const app = express()

// Proxy chỉ cho file .m3u8 — rewrite segment URLs thành URL tuyệt đối trực tiếp (không qua proxy)
app.get('/m3u8', async (req, res) => {
  const target = req.query.url
  if (!target) return res.status(400).send('No URL')
  try {
    console.log('[M3U8 PROXY]', target)
    const r = await fetch(target, { headers: HEADERS })
    res.set('Content-Type', 'application/vnd.apple.mpegurl')
    res.set('Access-Control-Allow-Origin', '*')

    const text = await r.text()
    const base = target.substring(0, target.lastIndexOf('/') + 1)

    // Rewrite segment thành URL tuyệt đối — Stremio fetch trực tiếp
    const rewritten = text.split('\n').map(line => {
      const l = line.trim()
      if (!l || l.startsWith('#')) return l
      // Nếu là m3u8 con, cũng proxy
      if (l.endsWith('.m3u8')) {
        const abs = l.startsWith('http') ? l : base + l
        return `https://film-rbkk.onrender.com/m3u8?url=${encodeURIComponent(abs)}`
      }
      // Segment .ts — trả URL tuyệt đối thẳng
      return l.startsWith('http') ? l : base + l
    }).join('\n')

    return res.send(rewritten)
  } catch(e) {
    console.error('[M3U8 ERROR]', e.message)
    res.status(500).send('error')
  }
})

app.use('/', getRouter(builder.getInterface()))

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Addon chạy tại: https://film-rbkk.onrender.com/manifest.json`)
})
