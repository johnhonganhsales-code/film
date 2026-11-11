// MyFilms addon v2.1.1 — TỰ ĐỘNG HÓA (sửa 2 lỗi của 2.1.0)
//  v2.1.1a: /tgthumb dùng iterDownload thay cho downloadFile (lỗi
//           "fileSize.lesser is not a function").
//  v2.1.1b: id phim tự quét đổi thành "phim-msg<messageId>" để không trùng
//           id Sheet "phim N" (msg 3 trùng phim 3 = msg 6).
// MyFilms addon v2.1.0 — TỰ ĐỘNG HÓA
// Thay đổi so với bản 2.0.0 (film-main.zip):
//  1. Poster tự động: không cần up Drive, không cần dán link poster nữa.
//     Poster lấy từ thumb sẵn có của video trên Telegram, qua endpoint /tgthumb
//     (nhỏ ~10-50KB, đúng tỉ lệ, không redirect — sửa luôn lỗi Stremio hiện icon).
//     Link Drive uc?id=... cũ trong Sheet sẽ tự bị thay bằng /tgthumb.
//  2. Phim tự động: server tự quét kênh Telegram, phim mới up lên kênh là
//     tự xuất hiện trong Stremio sau tối đa 5 phút, không cần thêm dòng Sheet.
//     Sheet chỉ còn là bảng GHI ĐÈ (đổi tên / mô tả / poster riêng nếu muốn).
//  3. Không có secret nào hard-code trong file này. TG_API_ID / TG_API_HASH /
//     TG_SESSION / TG_CHANNEL đặt trong Environment Variables của Render.
//     KHÔNG commit file .env lên git, KHÔNG gửi file .env cho ai.
//
// Quy trình up phim mới sau bản này:
//   - Up video lên kênh Telegram là xong. (Tên = caption dòng đầu, nếu không có
//     caption thì lấy tên file, nếu không có nữa thì "Phim <messageId>".)
//   - Muốn đổi tên đẹp hơn: thêm 1 dòng vào Sheet (id, name, chatId, messageId).
//   - Không cần: up Drive, copy link poster, làm thumbnail.

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
const TG_API_ID   = parseInt(process.env.TG_API_ID   || '0')
const TG_API_HASH = process.env.TG_API_HASH           || ''
const TG_SESSION  = process.env.TG_SESSION            || ''
const TG_CHANNEL  = process.env.TG_CHANNEL            || ''
const SHEET_CSV   = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRnqJip9m6pEIdp5jxw-Xqhj75g9Rz8Akdcpv5qJjU4q4hHAd1b6cwyMX5na-CBbUBE3-MzvRh7pqcC/pub?gid=0&single=true&output=csv'
const URLS_CSV    = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRnqJip9m6pEIdp5jxw-Xqhj75g9Rz8Akdcpv5qJjU4q4hHAd1b6cwyMX5na-CBbUBE3-MzvRh7pqcC/pub?gid=1842191953&single=true&output=csv'

// Danh sách URL render, tự động load từ sheet
let renderUrls = []
let currentUrlIndex = 0
let RENDER_URL = process.env.RENDER_URL || ''

async function loadRenderUrls() {
  try {
    const csv = await fetchCSV(URLS_CSV)
    const lines = csv.trim().split('\n').slice(1) // bỏ header
    const urls = lines
      .map(line => {
        const cols = line.split(',')
        return (cols[1] || '').trim().replace(/"/g, '')
      })
      .filter(u => u.startsWith('http'))
    if (urls.length > 0) {
      renderUrls = urls
      if (!RENDER_URL) RENDER_URL = renderUrls[0]
      console.log(`[URL] Loaded ${renderUrls.length} URLs:`, renderUrls)
    }
  } catch (e) {
    console.error('[URL ERROR]', e.message)
  }
}

function nextRenderUrl() {
  if (renderUrls.length === 0) return
  currentUrlIndex = (currentUrlIndex + 1) % renderUrls.length
  RENDER_URL = renderUrls[currentUrlIndex]
  console.log(`[URL] Chuyển sang URL mới: ${RENDER_URL}`)
}

// Cache videos từ sheet + Telegram
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

// --- Tên phim tự động: "Ten Phim.mp4" -> "Ten Phim" ---
function cleanFileName(fileName) {
  return fileName
    .replace(/\.(mp4|mkv|avi|mov|webm|m4v)$/i, '')
    .replace(/[_\.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// --- Quét kênh Telegram: mỗi video = 1 phim, không cần Sheet ---
async function getTelegramVideos(channelId) {
  const client = await getTgClient()
  const entity = await client.getEntity(channelId)
  const out = []
  for await (const msg of client.iterMessages(entity, { limit: 200 })) {
    if (!msg.media || !msg.media.document) continue
    const doc = msg.media.document
    if (!doc.mimeType || !doc.mimeType.startsWith('video/')) continue

    const caption = (msg.message || '').trim()
    const lines = caption.split('\n').map(s => s.trim()).filter(Boolean)
    let name = lines[0] || ''
    if (!name) {
      const fnAttr = (doc.attributes || []).find(a => a.className === 'DocumentAttributeFilename')
      if (fnAttr && fnAttr.fileName) name = cleanFileName(fnAttr.fileName)
    }
    if (!name) name = `Phim ${msg.id}`

    out.push({
      // id riêng "phim-msg<messageId>" để KHÔNG bao giờ trùng với id Sheet
      // "phim 1", "phim 2"... (v2.1.0 dùng "phim <msg.id>" nên msg 3 trùng
      // với phim 3 trong Sheet là msg 6, bấm vào là mở nhầm phim).
      id: `phim-msg${msg.id}`,
      name,
      chatId: String(channelId),
      messageId: msg.id,
      poster: '',
      description: lines.slice(1).join('\n'),
      background: '',
      source: 'telegram',
    })
  }
  out.sort((a, b) => a.messageId - b.messageId)
  console.log(`[TG] Quét kênh ${channelId}: ${out.length} video`)
  return out
}

function mostCommonChat(videos) {
  const count = {}
  for (const v of videos) count[v.chatId] = (count[v.chatId] || 0) + 1
  let best = '', bestN = 0
  for (const [chat, n] of Object.entries(count)) if (n > bestN) { best = chat; bestN = n }
  return best || ''
}

// --- Poster tự động: thumb Telegram, qua /tgthumb ---
// Link Drive uc?id=... cũ (3-4MB, redirect, Stremio không hiện) bị thay bằng
// /tgthumb. Link poster khác (lh3, ảnh trực tiếp...) thì giữ nguyên.
function posterUrl(v) {
  const p = (v.poster || '').trim()
  if (p && !p.includes('drive.google.com/uc')) return p
  if (RENDER_URL) return `${RENDER_URL}/tgthumb?chat=${encodeURIComponent(v.chatId)}&msg=${v.messageId}`
  return p || `https://via.placeholder.com/300x450?text=${encodeURIComponent(v.name)}`
}

async function getVideos() {
  const now = Date.now()
  if (videosCache.length > 0 && now - lastFetch < CACHE_TTL) {
    return videosCache
  }
  // 1. Sheet (nếu còn): chỉ để ghi đè tên/mô tả/poster
  let sheet = []
  try {
    console.log('[SHEET] Fetching videos từ Google Sheet...')
    const csv = await fetchCSV(SHEET_CSV)
    sheet = parseCSV(csv)
    console.log(`[SHEET] Loaded ${sheet.length} videos`)
  } catch (e) {
    console.error('[SHEET ERROR]', e.message)
  }
  // 2. Quét kênh Telegram: nguồn chính, phim mới tự vào
  const channelId = TG_CHANNEL || mostCommonChat(sheet) || '-1004309743217'
  let auto = []
  try {
    auto = await getTelegramVideos(channelId)
  } catch (e) {
    console.error('[TG SCAN ERROR]', e.message)
  }
  // 3. Gộp: key = chatId:messageId, Sheet thắng (giữ nguyên id cũ "phim 1"...)
  const byKey = new Map()
  for (const v of auto) byKey.set(`${v.chatId}:${v.messageId}`, { ...v })
  for (const s of sheet) {
    const key = `${s.chatId}:${s.messageId}`
    const cur = byKey.get(key)
    if (cur) {
      cur.id = s.id // giữ id cũ để Stremio không đổi phim
      if (s.name) cur.name = s.name
      if (s.description) cur.description = s.description
      if (s.poster) cur.poster = s.poster
      if (s.background) cur.background = s.background
      cur.source = 'sheet+telegram'
    } else {
      byKey.set(key, { ...s, source: 'sheet' })
    }
  }
  videosCache = [...byKey.values()].sort((a, b) => a.messageId - b.messageId)
  lastFetch = now
  console.log(`[VIDEOS] Tổng ${videosCache.length} phim (${auto.length} từ Telegram, ${sheet.length} dòng Sheet)`)
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

// --- Thumb của video: chỉ tải thumb (thumbSize), không tải cả video ---
const thumbCache = new Map() // key -> { buf, mime, time }, tối đa 100 cái
async function getThumbBuffer(chatId, messageId) {
  const cacheKey = `${chatId}:${messageId}`
  const cached = thumbCache.get(cacheKey)
  if (cached && Date.now() - cached.time < 24 * 60 * 60 * 1000) return cached

  const client = await getTgClient()
  const entity = await client.getEntity(chatId)
  const messages = await client.getMessages(entity, { ids: [messageId] })
  if (!messages || messages.length === 0) throw new Error('Không tìm thấy message')
  const doc = messages[0].media && messages[0].media.document
  if (!doc) throw new Error('Message không có document')
  const thumbs = (doc.thumbs || []).filter(t => t.className === 'PhotoSize' && t.w && t.h)
  if (thumbs.length === 0) throw new Error('Video không có thumb')
  thumbs.sort((a, b) => (a.w * a.h) - (b.w * b.h))
  const thumb = thumbs[thumbs.length - 1] // thumb lớn nhất (thường 320px)
  console.log(`[TGTHUMB] ${chatId}:${messageId} thumb ${thumb.w}x${thumb.h} type=${thumb.type} size=${String(thumb.size)}`)

  const loc = new Api.InputDocumentFileLocation({
    id: doc.id,
    accessHash: doc.accessHash,
    fileReference: doc.fileReference,
    thumbSize: thumb.type,
  })
  // v2.1.0 dùng client.downloadFile(loc, { fileSize: thumb.size }) -> lỗi
  // "fileSize.lesser is not a function" vì thumb.size không phải kiểu
  // big-integer mà downloadFile đòi. Dùng iterDownload như /tgstream
  // (đã chạy được), chỉ lấy 1 chunk 512KB là đủ cho thumb.
  const chunks = []
  const iter = client.iterDownload({
    file: loc,
    offset: bigInt(0),
    limit: 1,
    requestSize: 512 * 1024,
  })
  for await (const chunk of iter) chunks.push(Buffer.from(chunk))
  const buf = Buffer.concat(chunks)
  if (!buf || buf.length === 0) throw new Error('Thumb rỗng')
  if (buf.length > 1024 * 1024) throw new Error('Thumb quá lớn, bỏ qua để tránh tải nhầm full video')
  const mime = buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png' : 'image/jpeg'
  const entry = { buf, mime, time: Date.now() }
  thumbCache.set(cacheKey, entry)
  if (thumbCache.size > 100) thumbCache.delete(thumbCache.keys().next().value)
  return entry
}

const builder = new addonBuilder({
  id: 'com.myfilms.telegram',
  version: '2.1.1',
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
    poster: posterUrl(v)
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
      poster: posterUrl(v),
      background: (v.background && !v.background.includes('drive.google.com/uc')) ? v.background : posterUrl(v),
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

app.get('/debug/urls', (req, res) => {
  res.json({ current: RENDER_URL, index: currentUrlIndex, all: renderUrls })
})

// Poster tự động từ thumb Telegram (dùng cho catalog + meta)
app.get('/tgthumb', async (req, res) => {
  const { chat, msg } = req.query
  if (!chat || !msg) return res.status(400).send('Thiếu chat hoặc msg')
  try {
    const { buf, mime } = await getThumbBuffer(chat, parseInt(msg))
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    })
    res.end(buf)
  } catch (e) {
    console.error('[TGTHUMB ERROR]', e.message)
    if (!res.headersSent) res.status(404).send('Không có thumb: ' + e.message)
  }
})

function keepAlive() {
  if (!RENDER_URL) return
  try {
    const url = new URL(RENDER_URL + '/ping')
    const lib = RENDER_URL.startsWith('https') ? https : http
    lib.get({ hostname: url.hostname, path: url.pathname, headers: { 'User-Agent': 'keepalive' } }, r => {
      console.log('[KEEP-ALIVE] ok', r.statusCode)
      // Nếu bị suspend (503) → chuyển sang URL tiếp theo
      if (r.statusCode === 503 || r.statusCode === 502) {
        console.log('[KEEP-ALIVE] Service bị suspend, chuyển URL...')
        nextRenderUrl()
      }
    }).on('error', e => {
      console.error('[KEEP-ALIVE]', e.message)
      nextRenderUrl()
    })
  } catch (e) {
    console.error('[KEEP-ALIVE URL ERROR]', e.message)
  }
}
setTimeout(keepAlive, 5000)
setInterval(keepAlive, 8 * 60 * 1000) // 8 phút

// Reload danh sách URL mỗi 1 giờ
setInterval(loadRenderUrls, 60 * 60 * 1000)

// Xóa locationCache mỗi 6 giờ
setInterval(() => {
  locationCache.clear()
  console.log('[TG] Đã xóa locationCache')
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
}, 30 * 60 * 1000)

app.get('/tgstream', async (req, res) => {
  const { chat, msg } = req.query
  if (!chat || !msg) return res.status(400).send('Thiếu chat hoặc msg')

  try {
    const { inputLocation, size, mimeType } = await getFileLocation(chat, parseInt(msg))
    const client = await getTgClient()

    const CHUNK_SIZE = 512 * 1024
    const MAX_RANGE  = 1 * 1024 * 1024 // 1MB mỗi request

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
    if (e.message && (e.message.includes('FILE_REFERENCE') || e.message.includes('fileReference') || e.message.includes('file reference'))) {
      const cacheKey = `${req.query.chat}:${req.query.msg}`
      locationCache.delete(cacheKey)
      console.log('[TG] Đã xóa cache fileReference')
    }
    tgClient = null
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
    await loadRenderUrls() // Load danh sách URL trước
    await getTgClient()
    await getVideos()
  } catch (e) {
    console.error('[INIT ERROR]', e.message)
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Addon: http://localhost:${PORT}/manifest.json`)
    console.log(`🔍 Debug: http://localhost:${PORT}/debug/videos`)
    console.log(`🌐 URL hiện tại: ${RENDER_URL}`)
  })
})()
