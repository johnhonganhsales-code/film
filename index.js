const { addonBuilder, getRouter } = require('stremio-addon-sdk')
const express = require('express')
const { TelegramClient } = require('telegram')
const { StringSession } = require('telegram/sessions')
const { Api } = require('telegram/tl')
const bigInt = require('big-integer')
const https = require('https')
const http = require('http')

const ADDON_NAME  = 'MyFilms'
const PORT        = process.env.PORT        || 7000
const RENDER_URL  = process.env.RENDER_URL  || 'https://film-rbkk.onrender.com'
const TG_API_ID   = parseInt(process.env.TG_API_ID   || '0')
const TG_API_HASH = process.env.TG_API_HASH           || ''
const TG_SESSION  = process.env.TG_SESSION            || ''
const SHEET_CSV   = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRnqJip9m6pEIdp5jxw-Xqhj75g9Rz8Akdcpv5qJjU4q4hHAd1b6cwyMX5na-CBbUBE3-MzvRh7pqcC/pub?gid=0&single=true&output=csv'

// Cache videos từ sheet
let videosCache = []
let lastFetch = 0
const CACHE_TTL = 5 * 60 * 1000 // 5 phút

function fetchCSV(url, redirectCount = 0) {
  if (redirectCount > 5) return Promise.reject(new Error('Quá nhiều redirect'))
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/csv,text/plain,*/*'
      }
    }
    lib.get(url, options, (res) => {
      console.log(`[SHEET] HTTP status: ${res.statusCode} | URL: ${url.substring(0, 80)}...`)
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const location = res.headers.location
        console.log('[SHEET] Redirect ->', location)
        res.resume()
        return fetchCSV(location, redirectCount + 1).then(resolve).catch(reject)
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP status: ${res.statusCode}`))
      }
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        console.log('[SHEET] CSV nhận được, độ dài:', data.length)
        resolve(data)
      })
    }).on('error', (err) => {
      console.error('[SHEET] Fetch error:', err.message)
      reject(err)
    })
  })
}

function parseCSV(text) {
  const lines = text.trim().split('\n')
  console.log('[SHEET] Tổng số dòng CSV:', lines.length)
  if (lines.length < 2) return []
  return lines.slice(1).map((line, idx) => {
    const cols = []
    let current = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        inQuotes = !inQuotes
      } else if (ch === ',' && !inQuotes) {
        cols.push(current.trim())
        current = ''
      } else {
        current += ch
      }
    }
    cols.push(current.trim())

    const entry = {
      id: (cols[0] || '').trim(),
      name: (cols[1] || '').trim(),
      chatId: (cols[2] || '').trim(),
      messageId: parseInt((cols[3] || '0').trim()),
      poster: (cols[4] || '').trim(),
      description: (cols[5] || '').trim(),
      background: (cols[6] || '').trim(),
    }
    if (idx < 3) console.log(`[SHEET] Row ${idx + 1}:`, JSON.stringify(entry))
    return entry
  }).filter(v => v.id && v.chatId && v.messageId)
}

async function getVideos() {
  const now = Date.now()
  if (videosCache.length > 0 && now - lastFetch < CACHE_TTL) {
    return videosCache
  }
  try {
    console.log('[SHEET] Fetching videos từ Google Sheet...')
    const csv = await fetchCSV(SHEET_CSV)
    videosCache = parseCSV(csv)
    lastFetch = now
    console.log(`[SHEET] Loaded ${videosCache.length} videos`)
  } catch (e) {
    console.error('[SHEET ERROR]', e.message)
  }
  return videosCache
}

let tgClient = null

async function getTgClient() {
  if (tgClient && tgClient.connected) return tgClient
  console.log('[TG] Đang kết nối MTProto...')
  const session = new StringSession(TG_SESSION)
  tgClient = new TelegramClient(session, TG_API_ID, TG_API_HASH, {
    connectionRetries: 10,
    autoReconnect: true,
    retryDelay: 1000,
  })
  await tgClient.connect()
  console.log('[TG] Đã kết nối MTProto ✅')
  return tgClient
}

const locationCache = new Map()

async function fetchFileLocation(chatId, messageId) {
  const client = await getTgClient()
  const entity = await client.getEntity(chatId)
  const messages = await client.getMessages(entity, { ids: [messageId] })
  if (!messages || messages.length === 0) throw new Error('Không tìm thấy message')
  const msg = messages[0]
  const media = msg.media
  if (!media) throw new Error('Message không có media')
  if (!media.document) throw new Error('Media không phải document/video: ' + media.className)
  const doc = media.document
  const mimeType = doc.mimeType
  const size = Number(doc.size)
  const inputLocation = new Api.InputDocumentFileLocation({
    id: doc.id,
    accessHash: doc.accessHash,
    fileReference: doc.fileReference,
    thumbSize: ''
  })
  console.log(`[TG] Document: ${mimeType} | ${(size / 1024 / 1024).toFixed(1)} MB`)
  return { inputLocation, size, mimeType: mimeType || 'video/mp4' }
}

async function getFileLocation(chatId, messageId, forceRefresh = false) {
  const cacheKey = `${chatId}:${messageId}`
  if (!forceRefresh && locationCache.has(cacheKey)) return locationCache.get(cacheKey)
  const info = await fetchFileLocation(chatId, messageId)
  locationCache.set(cacheKey, info)
  return info
}

const builder = new addonBuilder({
  id: 'com.myfilms.telegram',
  version: '2.0.0',
  name: ADDON_NAME,
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie'],
  catalogs: [{ type: 'movie', id: 'myfilms-catalog', name: ADDON_NAME, extra: [{ name: 'skip' }] }]
})

builder.defineCatalogHandler(async ({ extra }) => {
  const videos = await getVideos()
  const skip = extra.skip ? parseInt(extra.skip) : 0
  const metas = videos.slice(skip, skip + 20).map(v => ({
    id: `myfilm:${v.id}`,
    type: 'movie',
    name: v.name,
    poster: v.poster || `https://via.placeholder.com/300x450?text=${encodeURIComponent(v.name)}`
  }))
  return { metas }
})

builder.defineMetaHandler(async ({ id }) => {
  const videos = await getVideos()
  const key = id.replace('myfilm:', '')
  const v = videos.find(x => x.id === key)
  if (!v) return { meta: {} }
  return {
    meta: {
      id, type: 'movie',
      name: v.name,
      poster: v.poster || `https://via.placeholder.com/300x450?text=${encodeURIComponent(v.name)}`,
      background: v.background || v.poster || '',
      description: v.description || ''
    }
  }
})

builder.defineStreamHandler(async ({ id }) => {
  const videos = await getVideos()
  const key = id.replace('myfilm:', '')
  const v = videos.find(x => x.id === key)
  if (!v) return { streams: [] }
  return {
    streams: [{
      url: `${RENDER_URL}/tgstream?chat=${encodeURIComponent(v.chatId)}&msg=${v.messageId}`,
      name: 'HD',
      title: `${v.name} [Telegram]`,
      behaviorHints: {
        notWebReady: true
      }
    }]
  }
})

const app = express()

app.get('/ping', (req, res) => {
  res.set('Cache-Control', 'no-cache')
  res.send('ok')
})

app.get('/debug/videos', async (req, res) => {
  const videos = await getVideos()
  res.json({ count: videos.length, videos })
})

function keepAlive() {
  const url = new URL(RENDER_URL + '/ping')
  const lib = RENDER_URL.startsWith('https') ? https : http
  lib.get({ hostname: url.hostname, path: url.pathname, headers: { 'User-Agent': 'keepalive' } }, r => {
    console.log('[KEEP-ALIVE] ok', r.statusCode)
  }).on('error', e => console.error('[KEEP-ALIVE]', e.message))
}
setTimeout(keepAlive, 5000)
setInterval(keepAlive, 8 * 60 * 1000) // 8 phút

// Xóa locationCache mỗi 6 giờ để fileReference không expire
setInterval(() => {
  locationCache.clear()
  console.log('[TG] Đã xóa locationCache, fileReference sẽ được fetch lại khi cần')
}, 6 * 60 * 60 * 1000)

// Kiểm tra TG session mỗi 30 phút
setInterval(async () => {
  try {
    const client = await getTgClient()
    await client.getMe()
    console.log('[TG] Session còn sống ✅')
  } catch (e) {
    console.error('[TG] Session chết, reconnect...', e.message)
    tgClient = null
    try {
      await getTgClient()
      console.log('[TG] Reconnect thành công ✅')
    } catch (e2) {
      console.error('[TG] Reconnect thất bại:', e2.message)
    }
  }
}, 30 * 60 * 1000) // 30 phút

app.get('/tgstream', async (req, res) => {
  const { chat, msg } = req.query
  if (!chat || !msg) return res.status(400).send('Thiếu chat hoặc msg')

  try {
    const { inputLocation, size, mimeType } = await getFileLocation(chat, parseInt(msg))
    const client = await getTgClient()

    const CHUNK_SIZE = 512 * 1024
    const MAX_RANGE  = 10 * 1024 * 1024 // 10MB mỗi request

    const rangeHeader = req.headers['range']
    let start = 0
    let end   = Math.min(size - 1, MAX_RANGE - 1)

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/)
      if (match) {
        start = parseInt(match[1])
        end   = match[2] ? parseInt(match[2]) : Math.min(size - 1, start + MAX_RANGE - 1)
      }
    }
    end = Math.min(end, size - 1)
    const chunkSize = end - start + 1

    console.log(`[TGSTREAM] ${chat}:${msg} | ${(start/1024/1024).toFixed(1)}MB-${(end/1024/1024).toFixed(1)}MB / ${(size/1024/1024).toFixed(1)}MB`)

    res.writeHead(206, {
      'Content-Type':   mimeType,
      'Content-Length': chunkSize,
      'Content-Range':  `bytes ${start}-${end}/${size}`,
      'Accept-Ranges':  'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':  'no-cache',
    })

    const alignedStart = Math.floor(start / CHUNK_SIZE) * CHUNK_SIZE
    const bytesToSkip  = start - alignedStart
    const numChunks    = Math.ceil((chunkSize + bytesToSkip) / CHUNK_SIZE)

    let bytesSent = 0

    const iter = client.iterDownload({
      file:        inputLocation,
      offset:      bigInt(alignedStart),
      limit:       numChunks,
      requestSize: CHUNK_SIZE,
    })

    for await (const chunk of iter) {
      if (res.destroyed) break
      let slice = Buffer.from(chunk)
      if (bytesSent === 0 && bytesToSkip > 0) slice = slice.slice(bytesToSkip)
      const remaining = chunkSize - bytesSent
      if (slice.length > remaining) slice = slice.slice(0, remaining)
      res.write(slice)
      bytesSent += slice.length
      if (bytesSent >= chunkSize) break
    }

    res.end()
    console.log(`[TGSTREAM] Done ${bytesSent}/${chunkSize} bytes`)

  } catch (e) {
    console.error('[TGSTREAM ERROR]', e.message)
    // Nếu lỗi fileReference hết hạn → xóa cache, client sẽ fetch lại lần sau
    if (e.message && (e.message.includes('FILE_REFERENCE') || e.message.includes('fileReference') || e.message.includes('file reference'))) {
      const cacheKey = `${req.query.chat}:${req.query.msg}`
      locationCache.delete(cacheKey)
      console.log('[TG] Đã xóa cache fileReference, sẽ fetch lại lần sau')
    }
    tgClient = null // force reconnect lần sau
    if (!res.headersSent) res.status(500).send('Lỗi: ' + e.message)
  }
})

app.get('/debug/stream', async (req, res) => {
  const { chat, msg } = req.query
  if (!chat || !msg) return res.json({ error: 'Thiếu chat hoặc msg' })
  try {
    const info = await getFileLocation(chat, parseInt(msg))
    res.json({
      ok: true,
      mimeType: info.mimeType,
      sizeMB: (info.size / 1024 / 1024).toFixed(1)
    })
  } catch (e) {
    res.json({ ok: false, error: e.message })
  }
})

app.use('/', getRouter(builder.getInterface()))

;(async () => {
  try {
    await getTgClient()
    await getVideos()
  } catch (e) {
    console.error('[TG] Lỗi kết nối ban đầu:', e.message)
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Addon: http://localhost:${PORT}/manifest.json`)
    console.log(`🔍 Debug: http://localhost:${PORT}/debug/videos`)
  })
})()
