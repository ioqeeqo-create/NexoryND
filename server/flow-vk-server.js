const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const axios = require('axios')

function loadDotEnv() {
  const file = [path.join(process.cwd(), '.env'), path.join(__dirname, '..', '.env')]
    .find((candidate) => fs.existsSync(candidate))
  if (!file) return
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0) continue
    const key = trimmed.slice(0, idx).trim()
    let value = trimmed.slice(idx + 1).trim()
    value = value.replace(/^['"]|['"]$/g, '')
    if (key && process.env[key] == null) process.env[key] = value
  }
}

loadDotEnv()

const PORT = Number(process.env.PORT || 8787)
const HOST = String(process.env.HOST || '0.0.0.0')
const DEFAULT_VK_TOKEN = String(process.env.VK_ACCESS_TOKEN || '').trim()
const VK_UA = 'VKAndroidApp/5.52-4543 (Android 5.1.1; SDK 22; x86_64; unknown Android SDK built for x86_64; en; 320x480)'
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

function writeJson(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
  })
  res.end(JSON.stringify(data))
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
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function decodeHtmlEntities(input) {
  return String(input || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n) || 0))
}

function decodeJsEscapes(input) {
  return String(input || '')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

function cleanupVkText(input) {
  return decodeJsEscapes(decodeHtmlEntities(input))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeToken(token) {
  const raw = String(token || '').trim()
  const m = raw.match(/access_token=([^&]+)/)
  return m ? decodeURIComponent(m[1]) : raw
}

function getVkToken(token) {
  return normalizeToken(token) || normalizeToken(DEFAULT_VK_TOKEN)
}

function parseVkPlaylistRef(link) {
  const raw = String(link || '').trim()
  if (!raw) return null
  let text = raw
  let searchParams = null
  try {
    const url = new URL(raw)
    text = `${url.pathname}${url.search}${url.hash}`
    searchParams = url.searchParams
  } catch {}
  const decoded = decodeURIComponent(text)
  const section = searchParams?.get('section') || ''
  const patterns = [
    /audio_playlist(-?\d+)_(\d+)(?:[_?&]access_key=([a-zA-Z0-9_-]+))?/i,
    /playlist\/(-?\d+)_(\d+)(?:[_?&]access_key=([a-zA-Z0-9_-]+))?/i,
    /music\/playlist\/(-?\d+)_(\d+)(?:[_/?#&]([a-zA-Z0-9_-]+))?/i,
    /audios(-?\d+).*?[?&]section=playlist_(-?\d+)_(\d+)(?:_([a-zA-Z0-9_-]+))?/i,
    /z=audio_playlist(-?\d+)_(\d+)(?:\/([a-zA-Z0-9_-]+))?/i,
    /playlist_(-?\d+)_(\d+)(?:_([a-zA-Z0-9_-]+))?/i,
  ]
  for (const rx of patterns) {
    const m = decoded.match(rx)
    if (!m) continue
    if (rx.source.startsWith('audios')) return { ownerId: m[2], albumId: m[3], accessKey: m[4] || '' }
    return { ownerId: m[1], albumId: m[2], accessKey: m[3] || '' }
  }
  const sm = String(section || '').match(/^playlist_(-?\d+)_(\d+)(?:_([a-zA-Z0-9_-]+))?$/i)
  if (sm) {
    return { ownerId: sm[1], albumId: sm[2], accessKey: sm[3] || '' }
  }
  return null
}

function uniqueTracks(rows, limit = 260) {
  const out = []
  const seen = new Set()
  for (const row of rows || []) {
    const title = cleanupVkText(row?.title || '')
    const artist = cleanupVkText(row?.artist || '')
    if (!title || !artist) continue
    const key = `${artist.toLowerCase()}::${title.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    const item = { title, artist }
    const duration = Number(row?.duration || row?.durationSec || 0)
    if (Number.isFinite(duration) && duration > 0) item.duration = duration
    const originalId = row?.original_id || row?.originalId || row?.id || row?.audioId || ''
    if (originalId) item.original_id = String(originalId)
    if (out.length >= limit) break
    out.push(item)
  }
  return out
}

async function vkApi(method, params, timeout = 15000) {
  const url = `https://api.vk.com/method/${method}?${new URLSearchParams(params).toString()}`
  const rsp = await axios.get(url, {
    headers: { 'User-Agent': VK_UA, 'Accept': 'application/json' },
    timeout,
    validateStatus: () => true,
  })
  if (rsp?.data?.error) throw new Error(rsp.data.error.error_msg || 'VK API error')
  return rsp?.data?.response
}

async function fetchViaVkApi(ref, token) {
  if (!ref || !token) return null
  const base = {
    owner_id: String(ref.ownerId),
    access_token: String(token),
    v: '5.131',
  }
  if (ref.accessKey) base.access_key = String(ref.accessKey)

  try {
    const playlist = await vkApi('audio.getPlaylistById', Object.assign({}, base, {
      playlist_id: String(ref.albumId),
    }))
    const row = Array.isArray(playlist) ? playlist[0] : playlist
    const rawRows = Array.isArray(row?.audios) ? row.audios
      : (Array.isArray(row?.list) ? row.list : (Array.isArray(row?.items) ? row.items : []))
    const tracks = uniqueTracks(rawRows.map((t) => ({
      title: t?.title,
      artist: t?.artist || (Array.isArray(t?.main_artists) ? t.main_artists.map((a) => a?.name).filter(Boolean).join(', ') : ''),
      duration: t?.duration,
      original_id: t?.owner_id && t?.id ? `${t.owner_id}_${t.id}` : (t?.id || ''),
    })))
    if (tracks.length) return { name: String(row?.title || 'VK Playlist'), tracks }
  } catch {}

  const list = await vkApi('audio.get', Object.assign({}, base, {
    album_id: String(ref.albumId),
    count: '600',
  }))
  const items = Array.isArray(list?.items) ? list.items : []
  const tracks = uniqueTracks(items.map((t) => ({
    title: t?.title,
    artist: t?.artist,
    duration: t?.duration,
    original_id: t?.owner_id && t?.id ? `${t.owner_id}_${t.id}` : (t?.id || ''),
  })))
  return tracks.length ? { name: 'VK Playlist', tracks } : null
}

function extractRowsFromHtml(html, max = 260) {
  const raw = decodeJsEscapes(decodeHtmlEntities(html))
  const clean = cleanupVkText(raw)
  const rows = []
  let m
  const push = (artist, title) => rows.push({ artist, title })

  const dataAudioRx = /data-audio=(?:"([^"]+)"|'([^']+)')/g
  while ((m = dataAudioRx.exec(raw)) && rows.length < max) {
    const packed = decodeJsEscapes(decodeHtmlEntities(m[1] || m[2] || '')).trim()
    if (!packed || packed[0] !== '[') continue
    try {
      const arr = JSON.parse(packed)
      if (Array.isArray(arr)) push(arr[4] || arr[6] || '', arr[3] || arr[5] || '')
    } catch {}
  }

  const audioArrayRx = /\[\s*-?\d+\s*,\s*-?\d+\s*,\s*(?:"[^"]*"|false|null)\s*,\s*"([^"]{1,260})"\s*,\s*"([^"]{1,220})"/g
  while ((m = audioArrayRx.exec(raw)) && rows.length < max) {
    push(m[2], m[1])
  }

  const pairs = [
    /"artist"\s*:\s*"([^"]{1,220})"\s*,\s*"title"\s*:\s*"([^"]{1,260})"/g,
    /"title"\s*:\s*"([^"]{1,260})"\s*,\s*"artist"\s*:\s*"([^"]{1,220})"/g,
    /"performer"\s*:\s*"([^"]{1,220})"\s*,\s*"title"\s*:\s*"([^"]{1,260})"/g,
    /"subtitle"\s*:\s*"([^"]{1,220})"\s*,\s*"title"\s*:\s*"([^"]{1,260})"/g,
  ]
  pairs.forEach((rx, idx) => {
    while ((m = rx.exec(clean)) && rows.length < max) {
      if (idx === 1) push(m[2], m[1])
      else push(m[1], m[2])
    }
  })

  const titleMatch = raw.match(/<title[^>]*>([^<]{1,200})<\/title>/i)
  return {
    name: cleanupVkText(titleMatch?.[1] || 'VK Playlist'),
    tracks: uniqueTracks(rows, max),
  }
}

async function fetchViaHtml(link, ref) {
  const candidates = [String(link || '').trim()]
  if (ref?.ownerId && ref?.albumId) {
    candidates.push(`https://vk.com/music/playlist/${ref.ownerId}_${ref.albumId}${ref.accessKey ? `_${ref.accessKey}` : ''}`)
    candidates.push(`https://vk.com/audios${ref.ownerId}?section=playlist_${ref.ownerId}_${ref.albumId}${ref.accessKey ? `_${ref.accessKey}` : ''}`)
    candidates.push(`https://m.vk.com/audio?act=audio_playlist${ref.ownerId}_${ref.albumId}${ref.accessKey ? `&access_key=${encodeURIComponent(ref.accessKey)}` : ''}`)
  }
  let name = 'VK Playlist'
  let tracks = []
  const errors = []
  for (const url of candidates) {
    if (!url) continue
    try {
      const rsp = await axios.get(url, {
        headers: {
          'User-Agent': BROWSER_UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
          'Referer': 'https://vk.com/',
        },
        timeout: 17000,
        maxRedirects: 6,
        validateStatus: () => true,
      })
      if (rsp.status >= 400) errors.push(`${rsp.status} ${url}`)
      const parsed = extractRowsFromHtml(String(rsp?.data || ''))
      if (parsed.name) name = parsed.name
      tracks = uniqueTracks([...tracks, ...(parsed.tracks || [])])
      if (tracks.length >= 8) break
    } catch (err) {
      errors.push(`${err?.message || err} ${url}`)
    }
  }
  return tracks.length ? { name, tracks } : { name, tracks: [], error: errors.slice(0, 3).join(' | ') }
}

async function resolveVkPlaylist(link, token = '') {
  const safeLink = String(link || '').trim()
  if (!/^https?:\/\/(m\.)?vk\.com\//i.test(safeLink)) throw new Error('bad VK url')
  const ref = parseVkPlaylistRef(safeLink)
  if (!ref) throw new Error('cannot parse VK playlist id')
  const vkToken = getVkToken(token)
  const hasToken = Boolean(vkToken)

  const api = await fetchViaVkApi(ref, vkToken).catch(() => null)
  if (api?.tracks?.length) return api

  const html = await fetchViaHtml(safeLink, ref).catch((err) => ({ error: err?.message || String(err), tracks: [] }))
  if (html?.tracks?.length) return html

  if (!hasToken) throw new Error('auth_required')
  throw new Error(`playlist parse failed${html?.error ? `: ${html.error}` : ''}`)
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return writeJson(res, 200, { ok: true })
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  if (req.method === 'GET' && url.pathname === '/health') {
    return writeJson(res, 200, {
      ok: true,
      service: 'flow-vk-server',
      uptimeSec: Math.round(process.uptime()),
      vkServerToken: Boolean(DEFAULT_VK_TOKEN),
    })
  }

  if (req.method === 'GET' && url.pathname === '/vk/playlist') {
    try {
      const data = await resolveVkPlaylist(url.searchParams.get('url'), url.searchParams.get('token') || '')
      return writeJson(res, 200, { ok: true, service: 'vk', name: data.name || 'VK Playlist', tracks: data.tracks || [] })
    } catch (err) {
      return writeJson(res, 400, { ok: false, error: err?.message || String(err) })
    }
  }

  if (req.method === 'POST' && url.pathname === '/vk/playlist') {
    try {
      const body = await readBody(req)
      const data = await resolveVkPlaylist(body?.url, body?.token || '')
      return writeJson(res, 200, { ok: true, service: 'vk', name: data.name || 'VK Playlist', tracks: data.tracks || [] })
    } catch (err) {
      return writeJson(res, 400, { ok: false, error: err?.message || String(err) })
    }
  }

  writeJson(res, 404, { ok: false, error: 'not found' })
})

server.listen(PORT, HOST, () => {
  console.log(`Flow VK server running on http://${HOST}:${PORT}`)
})
