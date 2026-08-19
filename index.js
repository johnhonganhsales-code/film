const { addonBuilder, getRouter } = require('stremio-addon-sdk')
const express = require('express')
const { TelegramClient } = require('telegram')
const { StringSession } = require('telegram/sessions')
const { Api } = require('telegram/tl')

const ADDON_NAME  = 'MyFilms'
const PORT        = process.env.PORT        || 7000
const RENDER_URL  = process.env.RENDER_URL  || 'https://film-rbkk.onrender.com'
const TG_API_ID   = parseInt(process.env.TG_API_ID   || '0')
const TG_API_HASH = process.env.TG_API_HASH           || ''
const TG_SESSION  = process.env.TG_SESSION            || ''

const VIDEOS = [
  { id: 'phim-1', name: 'Phim 1', chatId: '-1004309743217', messageId: 18, poster: '', description: '' },
  { id: 'phim-2', name: 'Phim 2', chatId: '-1004309743217', messageId: 15, poster: '', description: '' },
  { id: 'phim-3', name: 'Phim 3', chatId: '-1004309743217', messageId: 16, poster: '', description: '' },
]

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

const app = express()

app.get('/ping', (req, res) => {
  res.set('Cache-Control', 'no-cache')
  res.send('ok')
})

function keepAlive() {
  const http = require('http')
  const url = new URL(RENDER_URL + '/ping')
  http.get({ host: url.hostname, path: url.pathname, headers: { 'User-Agent': 'keepalive' } }, r => {
    console.log('[KEEP-ALIVE] ok', r.statusCode)
  }).on('error', e => console.error('[KEEP-ALIVE]', e.message))
}
setTimeout(keepAlive, 5000)
setInterval(keepAlive, 13 * 60 * 1000)

app.get('/tgstream', async (req, res) => {
  const { chat, msg } = req.query
  console.log('[TGSTREAM] Request:', chat, msg)
  res.json({ ok: true, chat, msg })
})

app.use('/', getRouter(builder.getInterface()))

;(async () => {
  try {
    await getTgClient()
  } catch (e) {
    console.error('[TG] Lỗi kết nối ban đầu:', e.message)
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Addon: http://localhost:${PORT}/manifest.json`)
  })
})()
