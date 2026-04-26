const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const PORT = Number(process.env.PORT || 8787)
const HOST = String(process.env.HOST || '0.0.0.0')
const COVER_TTL_MS = Number(process.env.COVER_TTL_MS || 7 * 24 * 60 * 60 * 1000)
const PRESENCE_TTL_MS = Number(process.env.PRESENCE_TTL_MS || 65 * 1000)
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 6 * 60 * 60 * 1000)
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 5 * 1024 * 1024)
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || './cache/covers')

fs.mkdirSync(CACHE_DIR, { recursive: true })

const roomState = new Map()
const presenceState = new Map()

function now() {
  return Date.now()
}

function writeJson(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
  })
  res.end(JSON.stringify(data))
}

function safeUrl(input) {
  try {
    const u = new URL(String(input || '').trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

function mimeExt(contentType) {
  const v = String(contentType || '').toLowerCase()
  if (v.includes('image/png')) return '.png'
  if (v.includes('image/webp')) return '.webp'
  if (v.includes('image/gif')) return '.gif'
  if (v.includes('image/jpeg') || v.includes('image/jpg')) return '.jpg'
  if (v.includes('image/avif')) return '.avif'
  return '.img'
}

function coverKey(url) {
  return crypto.createHash('sha1').update(String(url || '')).digest('hex')
}

function readBody(req, max = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (buf) => {
      total += buf.length
      if (total > max) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function cleanupPresence() {
  const ts = now()
  for (const [user, st] of presenceState.entries()) {
    if (!st || ts - Number(st.updatedAt || 0) > PRESENCE_TTL_MS) presenceState.delete(user)
  }
}

function cleanupRooms() {
  const ts = now()
  for (const [id, st] of roomState.entries()) {
    if (!st || ts - Number(st.updatedAt || 0) > ROOM_TTL_MS) roomState.delete(id)
  }
}

setInterval(() => {
  cleanupPresence()
  cleanupRooms()
}, 10 * 1000).unref()

async function serveCover(req, res, sourceUrl) {
  const key = coverKey(sourceUrl)
  const metaPath = path.join(CACHE_DIR, `${key}.json`)
  let cachedMeta = null
  try {
    cachedMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  } catch {}

  if (cachedMeta?.file) {
    const filePath = path.join(CACHE_DIR, cachedMeta.file)
    if (fs.existsSync(filePath)) {
      const age = now() - Number(cachedMeta.updatedAt || 0)
      if (age <= COVER_TTL_MS) {
        res.writeHead(200, {
          'Content-Type': cachedMeta.contentType || 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*',
          'X-Flow-Cover-Cache': 'HIT',
        })
        fs.createReadStream(filePath).pipe(res)
        return
      }
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 9000)
  try {
    const rsp = await fetch(sourceUrl, { signal: controller.signal })
    if (!rsp.ok) return writeJson(res, 502, { ok: false, error: 'upstream failed' })
    const contentType = String(rsp.headers.get('content-type') || '').toLowerCase()
    if (!contentType.includes('image/')) return writeJson(res, 415, { ok: false, error: 'not image' })
    const buf = Buffer.from(await rsp.arrayBuffer())
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) return writeJson(res, 413, { ok: false, error: 'image too large' })
    const fileName = `${key}${mimeExt(contentType)}`
    const filePath = path.join(CACHE_DIR, fileName)
    fs.writeFileSync(filePath, buf)
    fs.writeFileSync(metaPath, JSON.stringify({ file: fileName, contentType, updatedAt: now() }))
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
      'X-Flow-Cover-Cache': 'MISS',
    })
    res.end(buf)
  } catch {
    writeJson(res, 504, { ok: false, error: 'fetch timeout' })
  } finally {
    clearTimeout(timer)
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return writeJson(res, 200, { ok: true })
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  if (req.method === 'GET' && url.pathname === '/health') {
    return writeJson(res, 200, { ok: true, ts: now(), uptimeSec: Math.round(process.uptime()) })
  }

  if (req.method === 'GET' && url.pathname === '/cover') {
    const sourceUrl = safeUrl(url.searchParams.get('u'))
    if (!sourceUrl) return writeJson(res, 400, { ok: false, error: 'bad url' })
    return serveCover(req, res, sourceUrl)
  }

  if (req.method === 'POST' && url.pathname === '/presence/heartbeat') {
    try {
      const body = await readBody(req)
      const user = String(body?.user || '').trim().toLowerCase()
      if (!user) return writeJson(res, 400, { ok: false, error: 'user required' })
      presenceState.set(user, {
        user,
        roomId: body?.roomId ? String(body.roomId) : null,
        track: body?.track || null,
        updatedAt: now(),
      })
      return writeJson(res, 200, { ok: true })
    } catch {
      return writeJson(res, 400, { ok: false, error: 'bad body' })
    }
  }

  if (req.method === 'GET' && url.pathname === '/presence') {
    cleanupPresence()
    const users = String(url.searchParams.get('users') || '')
      .split(',')
      .map((u) => String(u || '').trim().toLowerCase())
      .filter(Boolean)
    const out = {}
    users.forEach((u) => {
      const st = presenceState.get(u)
      out[u] = st ? { online: true, roomId: st.roomId || null, track: st.track || null, updatedAt: st.updatedAt } : { online: false }
    })
    return writeJson(res, 200, { ok: true, presence: out })
  }

  if (req.method === 'POST' && url.pathname.startsWith('/rooms/') && url.pathname.endsWith('/state')) {
    try {
      const roomId = decodeURIComponent(url.pathname.split('/')[2] || '').trim()
      if (!roomId) return writeJson(res, 400, { ok: false, error: 'room required' })
      const body = await readBody(req)
      roomState.set(roomId, {
        roomId,
        state: body?.state || {},
        updatedAt: now(),
      })
      return writeJson(res, 200, { ok: true })
    } catch {
      return writeJson(res, 400, { ok: false, error: 'bad body' })
    }
  }

  if (req.method === 'GET' && url.pathname.startsWith('/rooms/') && url.pathname.endsWith('/state')) {
    cleanupRooms()
    const roomId = decodeURIComponent(url.pathname.split('/')[2] || '').trim()
    if (!roomId) return writeJson(res, 400, { ok: false, error: 'room required' })
    const row = roomState.get(roomId)
    return writeJson(res, 200, { ok: true, roomId, state: row?.state || null, updatedAt: row?.updatedAt || null })
  }

  writeJson(res, 404, { ok: false, error: 'not found' })
})

server.listen(PORT, HOST, () => {
  console.log(`Flow edge server running on http://${HOST}:${PORT}`)
  console.log(`Cover cache directory: ${CACHE_DIR}`)
})
