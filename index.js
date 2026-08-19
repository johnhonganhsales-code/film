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
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 307 || res.statusCode === 308) {
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
        console.log('[SHEET] 3 dòng đầu:\n', data.split('\n').slice(0, 3).join('\n'))
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
  // Skip header row
  return lines.slice(1).map((line, idx) => {
    // Xử lý CSV có thể có dấu phẩy trong nội dung (quoted fields)
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
    console.log('[SHEET] URL:', SHEET_CSV)
    const csv = await fetchCSV(SHEET_CSV)
    videosCache = parseCSV(csv)
    lastFetch = now
    console.log(`[SHEET] Loaded ${videosCache.length} videos`)
  } catch (e) {
    console.error('[SHEET ERROR]', e.message)
    // Dùng cache cũ nếu fetch lỗi
  }
  return videosCache
}

let tgClient = null

async function getTgClient() {
  if (tgClient && tgClient.connected) return tgClient
  console.log('[TG] Đang kết nối MTProto...')
  const session = new StringSession(TG_SESSION)
  tgClient = new TelegramClient(session, TG_API_ID, TG_API_HASH, {
    connectionRetries: 5,
    autoReconnect: true,
  })
  await tgClient.connect()
  console.log('[TG] Đã kết nối MTProto ✅')
  return tgClient
}

const locationCache = new Map()

async function getFileLocation(chatId, messageId) {
  const cacheKey = `${chatId}:${messageId}`
  if (locationCache.has(cacheKey)) return locationCache.get(cacheKey)
  const client = await getTgClient()
  const entity = await client.getEntity(chatId)
  const messages = await client.getMessages(entity, { ids: [messageId] })
  if (!messages || messages.length === 0) throw new Error('Không tìm thấy message')
  const msg = messages[0]
  const media = msg.media
  if (!media) throw new Error('Message không có media')
  let inputLocation, size, mimeType
  if (media.document) {
    const doc = media.document
    mimeType = doc.mimeType
    size = Number(doc.size)
    inputLocation = new Api.InputDocumentFileLocation({
      id: doc.id,
      accessHash: doc.accessHash,
      fileReference: doc.fileReference,
      thumbSize: ''
    })
    console.log(`[TG] Document: ${mimeType} | ${(size / 1024 / 1024).toFixed(1)} MB`)
  } else {
    throw new Error('Media không phải document/video: ' + media.className)
  }
  const info = { inputLocation, size, mimeType: mimeType || 'video/mp4' }
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
      title: `${v.name} [Telegram]`
    }]
  }
})

const app = express()

app.get('/ping', (req, res) => {
  res.set('Cache-Control', 'no-cache')
  res.send('ok')
})

// Debug endpoint: xem danh sách video đang cache
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
setInterval(keepAlive, 13 * 60 * 1000)

app.get('/tgstream', async (req, res) => {
  const { chat, msg } = req.query
  if (!chat || !msg) return res.status(400).send('Thiếu chat hoặc msg')

  try {
    const { inputLocation, size, mimeType } = await getFileLocation(chat, parseInt(msg))
    const client = await getTgClient()

    const CHUNK_SIZE = 512 * 1024

    const rangeHeader = req.headers['range']
    let start = 0
    let end = Math.min(size - 1, start + 50 * 1024 * 1024 - 1)

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/)
      if (match) {
        start = parseInt(match[1])
        end = match[2] ? parseInt(match[2]) : Math.min(size - 1, start + 50 * 1024 * 1024 - 1)
      }
    }
    end = Math.min(end, size - 1)
    const chunkSize = end - start + 1

    console.log(`[TGSTREAM] ${chat}:${msg} | ${(start/1024/1024).toFixed(1)}MB-${(end/1024/1024).toFixed(1)}MB`)

    res.status(206)
    res.set('Content-Type', mimeType)
    res.set('Accept-Ranges', 'bytes')
    res.set('Access-Control-Allow-Origin', '*')
    res.set('Content-Range', `bytes ${start}-${end}/${size}`)

    const alignedStart = Math.floor(start / CHUNK_SIZE) * CHUNK_SIZE
    const bytesToSkip = start - alignedStart
    const numChunks = Math.ceil((chunkSize + bytesToSkip) / CHUNK_SIZE) + 1

    let bytesSent = 0

    const iter = client.iterDownload({
      file: inputLocation,
      offset: bigInt(alignedStart),
      limit: numChunks,
      requestSize: CHUNK_SIZE,
    })

    for await (const chunk of iter) {
      if (res.destroyed) break
      let slice = Buffer.from(chunk)
      if (bytesToSkip > 0 && bytesSent === 0) slice = slice.slice(bytesToSkip)
      const remaining = chunkSize - bytesSent
      if (slice.length > remaining) slice = slice.slice(0, remaining)
      res.write(slice)
      bytesSent += slice.length
      if (bytesSent >= chunkSize) break
    }

    res.end()
    console.log(`[TGSTREAM] Done ${bytesSent} bytes`)

  } catch (e) {
    console.error('[TGSTREAM ERROR]', e.message)
    if (!res.headersSent) res.status(500).send('Lỗi: ' + e.message)
  }
})

app.use('/', getRouter(builder.getInterface()))

;(async () => {
  try {
    await getTgClient()
    await getVideos() // Load videos lúc khởi động
  } catch (e) {
    console.error('[TG] Lỗi kết nối ban đầu:', e.message)
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Addon: http://localhost:${PORT}/manifest.json`)
    console.log(`🔍 Debug: http://localhost:${PORT}/debug/videos`)
  })
})()
