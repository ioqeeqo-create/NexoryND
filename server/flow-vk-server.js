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
const DEFAULT_VK_COOKIE = String(process.env.VK_COOKIE || '').trim()
const DEFAULT_YANDEX_TOKEN = String(process.env.YANDEX_TOKEN || process.env.YM_TOKEN || '').trim()
const DEFAULT_YANDEX_COOKIE = String(process.env.YANDEX_COOKIE || process.env.YANDEX_MUSIC_COOKIE || '').trim()
const VK_UA = 'VKAndroidApp/5.52-4543 (Android 5.1.1; SDK 22; x86_64; unknown Android SDK built for x86_64; en; 320x480)'
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const VK_CLIENTS = [
  { id: '2274003', secret: 'hHbZxrka2uZ6jB1inYsH' },
  { id: '3140623', secret: 'Y8Jc6Q3Vqf4M6w5rjW8h' },
]

function resolveEnvPath() {
  const existing = [path.join(process.cwd(), '.env'), path.join(__dirname, '..', '.env')]
    .find((candidate) => fs.existsSync(candidate))
  return existing || path.join(__dirname, '..', '.env')
}

function upsertEnv(entries = {}) {
  const envPath = resolveEnvPath()
  const src = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
  const lines = src.split(/\r?\n/)
  const map = new Map()
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/)
    if (!m) continue
    map.set(m[1], m[2])
  }
  Object.entries(entries).forEach(([k, v]) => {
    if (!k) return
    const value = String(v == null ? '' : v).replace(/\r?\n/g, ' ').trim()
    map.set(k, value)
    process.env[k] = value
  })
  const out = Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
  fs.writeFileSync(envPath, out, 'utf8')
  return envPath
}

async function tryVkPasswordToken(login, password) {
  for (const client of VK_CLIENTS) {
    const params = new URLSearchParams({
      grant_type: 'password',
      client_id: String(client.id),
      client_secret: String(client.secret),
      username: String(login || '').trim(),
      password: String(password || ''),
      scope: 'audio,offline',
      v: '5.131',
      '2fa_supported': '1',
    })
    const rsp = await axios.get(`https://oauth.vk.com/token?${params.toString()}`, {
      headers: { 'User-Agent': VK_UA, 'Accept': 'application/json' },
      timeout: 18000,
      validateStatus: () => true,
    })
    const body = rsp?.data || {}
    if (body?.access_token) return { ok: true, token: String(body.access_token), via: 'password-grant' }
    if (body?.error === 'need_validation') {
      return {
        ok: false,
        need_validation: true,
        error: 'need_validation',
        details: body,
      }
    }
  }
  return { ok: false, error: 'vk login failed' }
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
  const widgetArgs = raw.match(/VK\.Widgets\.Playlist\(\s*["'][^"']+["']\s*,\s*(-?\d+)\s*,\s*(\d+)\s*,\s*["']([a-zA-Z0-9_-]+)["']/i)
  if (widgetArgs) {
    return { ownerId: widgetArgs[1], albumId: widgetArgs[2], accessKey: widgetArgs[3] || '' }
  }
  const widgetObject = raw.match(/VK\.Widgets\.Playlist\([^)]*owner_id\s*:\s*(-?\d+)[^)]*playlist_id\s*:\s*(\d+)[^)]*(?:hash|access_hash|access_key)\s*:\s*["']([a-zA-Z0-9_-]+)["']/is)
  if (widgetObject) {
    return { ownerId: widgetObject[1], albumId: widgetObject[2], accessKey: widgetObject[3] || '' }
  }
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
  if (rsp.status >= 400) {
    const err = new Error(`VK API ${method}: HTTP ${rsp.status}`)
    err.vkMethod = method
    throw err
  }
  if (rsp?.data?.error) {
    const apiError = rsp.data.error
    const err = new Error(`VK API ${method}: ${apiError.error_msg || 'VK API error'}${apiError.error_code ? ` (code ${apiError.error_code})` : ''}`)
    err.vkCode = apiError.error_code
    err.vkMethod = method
    throw err
  }
  return rsp?.data?.response
}

async function fetchViaVkApi(ref, token) {
  if (!ref || !token) return null
  const errors = []
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
  } catch (err) {
    errors.push(err)
  }

  try {
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
    if (tracks.length) return { name: 'VK Playlist', tracks }
  } catch (err) {
    errors.push(err)
  }

  if (errors.length) {
    const err = new Error(errors.map((item) => item?.message || String(item)).join(' | '))
    const authErr = errors.find((item) => Number(item?.vkCode) === 5)
    if (authErr) err.vkCode = authErr.vkCode
    throw err
  }
  return null
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

async function fetchViaWidget(ref, cookie = '') {
  if (!ref?.ownerId || !ref?.albumId || !ref?.accessKey) return null
  const baseParams = {
    owner_id: String(ref.ownerId),
    playlist_id: String(ref.albumId),
    hash: String(ref.accessKey),
  }
  const widgetVariants = [
    {
      oid: String(ref.ownerId),
      pid: String(ref.albumId),
      hash: String(ref.accessKey),
    },
    {
      oid: String(ref.ownerId),
      pid: String(ref.albumId),
      hash: String(ref.accessKey),
      app: '0',
      width: '100%',
      _ver: '169',
    },
    Object.assign({ rows: '260', limit: '260' }, baseParams),
    Object.assign({ rows: '100', limit: '100' }, baseParams),
    Object.assign({ app: '0', _ver: '1', width: '100%', rows: '260', limit: '260' }, baseParams),
    baseParams,
    {
      oid: String(ref.ownerId),
      pid: String(ref.albumId),
      hash: String(ref.accessKey),
      rows: '260',
      limit: '260',
    },
  ]
  const candidates = widgetVariants.map((params) => `https://vk.com/widget_playlist.php?${new URLSearchParams(params).toString()}`)
  const errors = []
  let best = null
  for (const url of candidates) {
    try {
      const rsp = await axios.get(url, {
        headers: {
          'User-Agent': BROWSER_UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
          'Referer': 'https://vk.com/',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        timeout: 20000,
        maxRedirects: 6,
        validateStatus: () => true,
      })
      if (rsp.status >= 400) {
        errors.push(`VK widget HTTP ${rsp.status}`)
        continue
      }
      const parsed = extractRowsFromHtml(String(rsp?.data || ''))
      if (parsed?.tracks?.length) {
        if (!best || parsed.tracks.length > best.tracks.length) {
          best = { name: parsed.name || 'VK Playlist', tracks: parsed.tracks, via: 'public-widget' }
        }
        if (parsed.tracks.length >= 100) break
        continue
      }
      errors.push(`VK widget empty response ${String(rsp?.data || '').slice(0, 80).replace(/\s+/g, ' ')}`)
    } catch (err) {
      errors.push(err?.message || String(err))
    }
  }
  if (best?.tracks?.length) return best
  return { name: 'VK Playlist', tracks: [], error: errors.slice(0, 3).join(' | ') }
}

async function fetchViaHtml(link, ref, cookie = '') {
  const safeLink = String(link || '').trim()
  const candidates = /^https?:\/\//i.test(safeLink) ? [safeLink] : []
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
          ...(cookie ? { Cookie: cookie } : {}),
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

async function resolveVkPlaylist(link, token = '', cookie = '') {
  const safeLink = String(link || '').trim()
  const ref = parseVkPlaylistRef(safeLink)
  if (!/^https?:\/\/(m\.)?vk\.com\//i.test(safeLink) && !ref?.accessKey) throw new Error('bad VK url')
  if (!ref) throw new Error('cannot parse VK playlist id')
  const vkToken = getVkToken(token)
  const vkCookie = String(cookie || '').trim() || DEFAULT_VK_COOKIE
  const hasToken = Boolean(vkToken)
  let apiError = ''

  const api = await fetchViaVkApi(ref, vkToken).catch((err) => {
    apiError = err?.message || String(err)
    if (Number(err?.vkCode) === 5) apiError = `server_vk_token_invalid: ${apiError}`
    return null
  })
  if (api?.tracks?.length) return api

  const widget = await fetchViaWidget(ref, vkCookie).catch((err) => ({ error: err?.message || String(err), tracks: [] }))
  if (widget?.tracks?.length) return widget

  const html = await fetchViaHtml(safeLink, ref, vkCookie).catch((err) => ({ error: err?.message || String(err), tracks: [] }))
  if (html?.tracks?.length) return html

  if (!hasToken) throw new Error('auth_required')
  const details = [apiError, widget?.error, html?.error].filter(Boolean).join(' | ')
  throw new Error(`playlist parse failed${details ? `: ${details}` : ''}`)
}

function parseYandexPlaylistRef(link) {
  const raw = String(link || '').trim()
  if (!raw) return null
  try {
    const u = new URL(raw)
    const full = u.pathname.match(/\/users\/([^/]+)\/playlists\/([^/?#]+)/i)
    if (full) return { user: decodeURIComponent(full[1]), kind: decodeURIComponent(full[2]) }
    const short = u.pathname.match(/\/playlists\/([^/?#]+)/i)
    if (short) return { user: null, kind: decodeURIComponent(short[1]) }
    return null
  } catch {
    return null
  }
}

async function resolveYandexRefFromPage(link, cookie = '') {
  const rsp = await axios.get(String(link || '').trim(), {
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': 'https://music.yandex.ru/',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    timeout: 25000,
    maxRedirects: 6,
    validateStatus: () => true,
  })
  const html = String(rsp?.data || '')
  if (rsp.status >= 400 || !html) throw new Error(`yandex page status ${rsp.status}`)
  const kind = html.match(/"kind"\s*:\s*"([^"]+)"/i)?.[1] || html.match(/"playlistId"\s*:\s*"([^"]+)"/i)?.[1]
  const uid = html.match(/"owner"\s*:\s*\{[^}]*"uid"\s*:\s*([0-9]+)/is)?.[1] || html.match(/"ownerUid"\s*:\s*([0-9]+)/i)?.[1]
  if (!kind || !uid) throw new Error('cannot resolve yandex owner/kind from page')
  return { user: String(uid), kind: String(kind) }
}

function mapYandexTrackRows(rows, limit = 1200) {
  const out = []
  const seen = new Set()
  for (const row of rows || []) {
    const t = row?.track || row || {}
    const title = cleanupVkText(t?.title || t?.name || '')
    const artist = cleanupVkText(Array.isArray(t?.artists) ? t.artists.map((a) => a?.name).filter(Boolean).join(', ') : (t?.artist || ''))
    if (!title || !artist) continue
    const key = `${artist.toLowerCase()}::${title.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    const item = { title, artist }
    const durationMs = Number(t?.durationMs || row?.durationMs || 0)
    if (Number.isFinite(durationMs) && durationMs > 0) item.duration = Math.round(durationMs / 1000)
    out.push(item)
    if (out.length >= limit) break
  }
  return out
}

async function fetchYandexPlaylistViaApi(ref, token) {
  if (!ref || !token) return null
  const r = await axios.get(`https://api.music.yandex.net/users/${encodeURIComponent(ref.user)}/playlists/${encodeURIComponent(ref.kind)}`, {
    headers: {
      'Authorization': `OAuth ${String(token).trim()}`,
      'X-Yandex-Music-Client': 'WindowsPhone/3.20',
      'User-Agent': 'Windows 10',
    },
    timeout: 20000,
    validateStatus: () => true,
  })
  if (r.status >= 400 || !r?.data?.result) throw new Error(`Yandex API status ${r.status}`)
  const pl = r.data.result || {}
  return {
    name: cleanupVkText(pl?.title || 'Yandex Playlist'),
    tracks: mapYandexTrackRows(pl?.tracks || []),
    via: 'yandex-api',
  }
}

async function fetchYandexPlaylistViaHandlers(ref, cookie = '') {
  if (!ref) return null
  const lightUrl = `https://music.yandex.ru/handlers/playlist.jsx?owner=${encodeURIComponent(ref.user)}&kinds=${encodeURIComponent(ref.kind)}&light=true&withLikesCount=true&lang=ru`
  const r = await axios.get(lightUrl, {
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept': 'application/json,text/plain,*/*',
      'Referer': 'https://music.yandex.ru/',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    timeout: 25000,
    validateStatus: () => true,
  })
  if (r.status >= 400) throw new Error(`Yandex handlers status ${r.status}`)
  const body = r?.data || {}
  const pl = body?.playlist || body?.result || body
  const tracks = mapYandexTrackRows(pl?.tracks || pl?.trackIds || [])
  return {
    name: cleanupVkText(pl?.title || body?.title || 'Yandex Playlist'),
    tracks,
    via: 'yandex-handlers',
  }
}

async function resolveYandexPlaylist(link, token = '', cookie = '') {
  const parsedRef = parseYandexPlaylistRef(link)
  if (!parsedRef) throw new Error('bad yandex playlist url')
  const errors = []
  const ymToken = String(token || '').trim() || DEFAULT_YANDEX_TOKEN
  const ymCookie = String(cookie || '').trim() || DEFAULT_YANDEX_COOKIE
  let ref = parsedRef
  if (!ref.user) {
    try {
      ref = await resolveYandexRefFromPage(link, ymCookie)
    } catch (err) {
      errors.push(err?.message || String(err))
    }
  }
  if (!ref?.user || !ref?.kind) throw new Error(errors.join(' | ') || 'cannot resolve yandex playlist reference')

  if (ymToken) {
    try {
      const api = await fetchYandexPlaylistViaApi(ref, ymToken)
      if (api?.tracks?.length) return api
      errors.push('yandex api empty')
    } catch (err) {
      errors.push(err?.message || String(err))
    }
  }

  try {
    const handlers = await fetchYandexPlaylistViaHandlers(ref, ymCookie)
    if (handlers?.tracks?.length) return handlers
    errors.push('yandex handlers empty')
  } catch (err) {
    errors.push(err?.message || String(err))
  }

  throw new Error(errors.join(' | ') || 'yandex playlist parse failed')
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
      vkCookie: Boolean(DEFAULT_VK_COOKIE),
      yandexToken: Boolean(DEFAULT_YANDEX_TOKEN),
      yandexCookie: Boolean(DEFAULT_YANDEX_COOKIE),
    })
  }

  if (req.method === 'GET' && url.pathname === '/auth/status') {
    return writeJson(res, 200, {
      ok: true,
      vkToken: Boolean(String(process.env.VK_ACCESS_TOKEN || '').trim()),
      vkCookie: Boolean(String(process.env.VK_COOKIE || '').trim()),
      yandexToken: Boolean(String(process.env.YANDEX_TOKEN || process.env.YM_TOKEN || '').trim()),
      yandexCookie: Boolean(String(process.env.YANDEX_COOKIE || process.env.YANDEX_MUSIC_COOKIE || '').trim()),
    })
  }

  if (req.method === 'POST' && url.pathname === '/auth/save') {
    try {
      const body = await readBody(req)
      const patch = {}
      if (body?.vkToken != null) patch.VK_ACCESS_TOKEN = String(body.vkToken || '').trim()
      if (body?.vkCookie != null) patch.VK_COOKIE = String(body.vkCookie || '').trim()
      if (body?.yandexToken != null) patch.YANDEX_TOKEN = String(body.yandexToken || '').trim()
      if (body?.yandexCookie != null) patch.YANDEX_COOKIE = String(body.yandexCookie || '').trim()
      const envPath = upsertEnv(patch)
      return writeJson(res, 200, { ok: true, saved: Object.keys(patch), envPath })
    } catch (err) {
      return writeJson(res, 400, { ok: false, error: err?.message || String(err) })
    }
  }

  if (req.method === 'POST' && url.pathname === '/auth/vk/login') {
    try {
      const body = await readBody(req)
      const login = String(body?.login || '').trim()
      const password = String(body?.password || '')
      if (!login || !password) return writeJson(res, 400, { ok: false, error: 'login/password required' })
      const result = await tryVkPasswordToken(login, password)
      if (result?.ok && result?.token) {
        const envPath = upsertEnv({ VK_ACCESS_TOKEN: result.token })
        return writeJson(res, 200, { ok: true, via: result.via, saved: ['VK_ACCESS_TOKEN'], envPath })
      }
      if (result?.need_validation) {
        return writeJson(res, 409, {
          ok: false,
          error: 'vk needs additional validation (sms/2fa). Use /auth/save with VK_COOKIE from browser session.',
          details: result.details || null,
        })
      }
      return writeJson(res, 401, { ok: false, error: result?.error || 'vk login failed' })
    } catch (err) {
      return writeJson(res, 400, { ok: false, error: err?.message || String(err) })
    }
  }

  if (req.method === 'GET' && url.pathname === '/vk/playlist') {
    try {
      const data = await resolveVkPlaylist(url.searchParams.get('url'), url.searchParams.get('token') || '', url.searchParams.get('cookie') || '')
      return writeJson(res, 200, { ok: true, service: 'vk', via: data.via || 'vk-server', name: data.name || 'VK Playlist', count: (data.tracks || []).length, tracks: data.tracks || [] })
    } catch (err) {
      return writeJson(res, 400, { ok: false, error: err?.message || String(err) })
    }
  }

  if (req.method === 'POST' && url.pathname === '/vk/playlist') {
    try {
      const body = await readBody(req)
      const data = await resolveVkPlaylist(body?.url, body?.token || '', body?.cookie || '')
      return writeJson(res, 200, { ok: true, service: 'vk', via: data.via || 'vk-server', name: data.name || 'VK Playlist', count: (data.tracks || []).length, tracks: data.tracks || [] })
    } catch (err) {
      return writeJson(res, 400, { ok: false, error: err?.message || String(err) })
    }
  }

  if (req.method === 'GET' && url.pathname === '/yandex/playlist') {
    try {
      const data = await resolveYandexPlaylist(
        url.searchParams.get('url'),
        url.searchParams.get('token') || '',
        url.searchParams.get('cookie') || ''
      )
      return writeJson(res, 200, {
        ok: true,
        service: 'yandex',
        via: data.via || 'yandex-server',
        name: data.name || 'Yandex Playlist',
        count: (data.tracks || []).length,
        tracks: data.tracks || [],
      })
    } catch (err) {
      return writeJson(res, 400, { ok: false, error: err?.message || String(err) })
    }
  }

  if (req.method === 'POST' && url.pathname === '/yandex/playlist') {
    try {
      const body = await readBody(req)
      const data = await resolveYandexPlaylist(body?.url, body?.token || '', body?.cookie || '')
      return writeJson(res, 200, {
        ok: true,
        service: 'yandex',
        via: data.via || 'yandex-server',
        name: data.name || 'Yandex Playlist',
        count: (data.tracks || []).length,
        tracks: data.tracks || [],
      })
    } catch (err) {
      return writeJson(res, 400, { ok: false, error: err?.message || String(err) })
    }
  }

  if (req.method === 'POST' && url.pathname === '/import/playlist') {
    try {
      const body = await readBody(req)
      const link = String(body?.url || '').trim()
      if (!link) return writeJson(res, 400, { ok: false, error: 'empty url' })
      if (/vk\.com/i.test(link)) {
        const data = await resolveVkPlaylist(link, body?.token || '', body?.cookie || '')
        return writeJson(res, 200, {
          ok: true,
          service: 'vk',
          via: data.via || 'vk-server',
          name: data.name || 'VK Playlist',
          count: (data.tracks || []).length,
          tracks: data.tracks || [],
        })
      }
      if (/music\.yandex\./i.test(link)) {
        const data = await resolveYandexPlaylist(link, body?.token || '', body?.cookie || '')
        return writeJson(res, 200, {
          ok: true,
          service: 'yandex',
          via: data.via || 'yandex-server',
          name: data.name || 'Yandex Playlist',
          count: (data.tracks || []).length,
          tracks: data.tracks || [],
        })
      }
      return writeJson(res, 400, { ok: false, error: 'unsupported url host' })
    } catch (err) {
      return writeJson(res, 400, { ok: false, error: err?.message || String(err) })
    }
  }

  writeJson(res, 404, { ok: false, error: 'not found' })
})

server.listen(PORT, HOST, () => {
  console.log(`Flow VK server running on http://${HOST}:${PORT}`)
})
