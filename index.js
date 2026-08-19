const { addonBuilder, getRouter } = require('stremio-addon-sdk')
const express = require('express')
const { TelegramClient } = require('telegram')
const { StringSession } = require('telegram/sessions')
const { Api } = require('telegram/tl')

// ─── CẤU HÌNH ────────────────────────────────────────────────────────────────
const ADDON_NAME  = 'MyFilms'
const PORT        = process.env.PORT        || 7000
const RENDER_URL  = process.env.RENDER_URL  || 'https://film-rbkk.onrender.com'

// Lấy tại https://my.telegram.org → App configuration
const TG_API_ID   = parseInt(process.env.TG_API_ID   || '0')
const TG_API_HASH = process.env.TG_API_HASH           || ''
// Session string — chạy auth.js một lần để sinh ra chuỗi này
const TG_SESSION  = process.env.TG_SESSION            || ''

// Danh sách phim
// chatId: username (@channel) hoặc số âm (-100xxx) của group/channel
// messageId: ID của message chứa video/document
const VIDEOS = [
  {
    id: 'phim-1',
    name: 'Phim 1',
    chatId: '-1004309743217',
    messageId: 18,
    poster: '',
    description: ''
  },
  {
    id: 'phim-2',
    name: 'Phim 2',
    chatId: '-1004309743217',
    messageId: 15,
    poster: '',
    description: ''
  },
  {
    id: 'phim-3',
    name: 'Phim 3',
    chatId: '-1004309743217',
    messageId: 16,
    poster: '',
    description: ''
  },
  
]
// ─────────────────────────────────────────────────────────────────────────────

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

// Cache: cacheKey -> { inputLocation, dcId, size, accessHash }
const locationCache = new Map()

async function getFileLocation(chatId, messageId) {
  const cacheKey = `${chatId}:${messageId}`
  if (locationCache.has(cacheKey)) return locationCache.get(cacheKey)

  const client = await getTgClient()

  // Resolve entity (channel/group/user)
  const entity = await client.getEntity(chatId)

  // Lấy message
  const messages = await client.getMessages(entity, { ids: [messageId] })
  if (!messages || messages.length === 0) throw new Error('Không tìm thấy message')

  const msg = messages[0]
  const media = msg.media

  if (!media) throw new Error('Message không có media')

  let inputLocation, size, mimeType

  // Xử lý video (MessageMediaDocument với mime video/*)
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

// ─── STREMIO ADDON ────────────────────────────────────────────────────────────

const builder = new addonBuilder({
  id: 'com.myfilms.telegram',
  version: '2.0.0',
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
      id, type: 'movie',
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

  return {
    streams: [{
      url: `${RENDER_URL}/tgstream?chat=${encodeURIComponent(v.chatId)}&msg=${v.messageId}`,
      name: 'HD',
      title: `${v.name} [Telegram]`
    }]
  }
})

// ─── EXPRESS + STREAM PROXY ───────────────────────────────────────────────────

const app = express()

app.get('/ping', (req, res) => {
  res.set('Cache-Control', 'no-cache')
  res.send('ok')
})

// Keep-alive
function keepAlive() {
  const http = require('http')
  const url = new URL(RENDER_URL + '/ping')
  http.get({ host: url.hostname, path: url.pathname, headers: { 'User-Agent': 'keepalive' } }, r => {
    console.log('[KEEP-ALIVE] ok', r.statusCode)
  }).on('error', e => console.error('[KEEP-ALIVE]', e.message))
}
setTimeout(keepAlive, 5000)
setInterval(keepAlive, 13 * 60 * 1000)

/**
 * /tgstream?chat=@channel&msg=123
 *
 * Hỗ trợ HTTP Range (seek) bằng cách dùng gramjs iterDownload
 * để stream thẳng từ Telegram DC về client mà không lưu disk.
 */
app.get('/tgstream', async (req, res) => {
  const { chat, msg } = req.query
  if (!chat || !msg) return res.status(400).send('Thiếu chat hoặc msg')

  try {
    const { inputLocation, size, mimeType } = await getFileLocation(chat, parseInt(msg))
    const client = await getTgClient()

    const rangeHeader = req.headers['range']
    let start = 0
    let end = size - 1

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/)
      if (match) {
        start = parseInt(match[1])
        end = match[2] ? parseInt(match[2]) : size - 1
      }
    }

    const chunkSize = end - start + 1

    res.status(rangeHeader ? 206 : 200)
    res.set('Content-Type', mimeType)
    res.set('Accept-Ranges', 'bytes')
    res.set('Access-Control-Allow-Origin', '*')
    res.set('Content-Length', String(chunkSize))
    if (rangeHeader) {
      res.set('Content-Range', `bytes ${start}-${end}/${size}`)
    }

    console.log(`[TGSTREAM] ${chat}:${msg} | ${(start/1024/1024).toFixed(1)}MB - ${(end/1024/1024).toFixed(1)}MB`)

    // gramjs iterDownload: stream theo chunk 512KB, bắt đầu từ offset đúng
    const PART_SIZE = 512 * 1024  // 512KB mỗi chunk (phải là bội số của 4KB)

    const alignedOffset = start - (start % PART_SIZE)
        const iter = client.iterDownload({
          file: inputLocation,
          offset: alignedOffset,
          limit: end - alignedOffset + PART_SIZE,
          requestSize: PART_SIZE,
    })

    let bytesSent = 0
    let bytesToSkip = start % PART_SIZE  // phần thừa do align

    for await (const chunk of iter) {
      if (res.destroyed) break

      let slice = chunk
      if (bytesToSkip > 0) {
        slice = chunk.slice(bytesToSkip)
        bytesToSkip = 0
      }

      const remaining = chunkSize - bytesSent
      if (slice.length > remaining) {
        slice = slice.slice(0, remaining)
      }

      res.write(slice)
      bytesSent += slice.length

      if (bytesSent >= chunkSize) break
    }

    res.end()

  } catch (e) {
    console.error('[TGSTREAM ERROR]', e.message)
    if (!res.headersSent) res.status(500).send('Lỗi: ' + e.message)
  }
})

app.use('/', getRouter(builder.getInterface()))

// Khởi động: kết nối TG trước rồi mới listen
;(async () => {
  try {
    await getTgClient()
  } catch (e) {
    console.error('[TG] Lỗi kết nối ban đầu:', e.message)
    console.error('     → Chạy auth.js để tạo TG_SESSION trước')
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Addon: http://localhost:${PORT}/manifest.json`)
  })
})()
