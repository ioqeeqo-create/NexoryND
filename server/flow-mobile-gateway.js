/**
 * Flow Mobile Gateway — HTTP API для React Native: поиск и выдача URL для воспроизведения
 * (логика совместима с десктопным main.js: Spotify / SoundCloud / Audius / Яндекс / VK / YouTube).
 * YouTube: Invidious + Piped (без yt-dlp / Selenium на VPS — стабильнее для слабого сервера).
 *
 * Запуск на VPS или домашнем ПК (рядом с Electron не обязательно):
 *   FLOW_MOBILE_GATEWAY_SECRET="длинная-случайная-строка" node server/flow-mobile-gateway.js
 *
 * SoundCloud без токена в приложении: client_id вытаскивается с soundcloud.com (несколько страниц + бандлы sndcdn),
 * проверяется запросом к api-v2. Если скрейп ломается после обновления SC — задай на VPS:
 *   SC_CLIENT_ID=<32-символьный id из DevTools>
 *   SC_CLIENT_ID_FALLBACKS=id1,id2   (запасные, через запятую)
 *   SC_OAUTH_TOKEN=...                (опционально, если нужен OAuth)
 *
 * Порт: FLOW_MOBILE_GATEWAY_PORT (по умолчанию 3950)
 *
 * В приложении: база URL + заголовок Authorization: Bearer <секрет>
 */

const express = require('express')
const cors = require('cors')
const axios = require('axios')
const flowVk = require('../packages/flow-core/providers/vk')
const flowYandex = require('../packages/flow-core/providers/yandex')
const { VK_KATE_MOBILE_UA, vkInvokeKateMethod, searchVkTracks } = flowVk

const PORT = Number(process.env.FLOW_MOBILE_GATEWAY_PORT || 3950)
const SECRET = String(process.env.FLOW_MOBILE_GATEWAY_SECRET || '').trim()
if (!SECRET) {
  console.error('[flow-mobile-gateway] Задайте FLOW_MOBILE_GATEWAY_SECRET')
  process.exit(1)
}

const INVIDIOUS_INSTANCES = [
  'inv.nadeko.net',
  'yewtu.be',
  'invidious.nerdvpn.de',
  'inv.thepixora.com',
  'yt.chocolatemoo53.com',
]

const SC_CLIENT_ID_ENV = String(process.env.SC_CLIENT_ID || '').trim()
const SC_OAUTH_TOKEN = String(process.env.SC_OAUTH_TOKEN || '').trim()
/** Через запятую: запасные client_id, если скрейп HTML/бандлов дал мёртвый id (SoundCloud часто меняет фронт). */
const SC_CLIENT_ID_FALLBACKS = String(process.env.SC_CLIENT_ID_FALLBACKS || '')
  .split(/[,\s]+/)
  .map((s) => s.trim())
  .filter((s) => /^[a-zA-Z0-9]{32}$/.test(s))

const SC_PATTERNS = [
  /client_id["']?\s*[:=]\s*["']([a-zA-Z0-9]{32})["']/,
  /client_id\s*:\s*"([a-zA-Z0-9]{32})"/,
  /client_id="([a-zA-Z0-9]{32})"/,
  /"client_id","([a-zA-Z0-9]{32})"/,
  /,client_id:"([a-zA-Z0-9]{32})"/,
  /\?client_id=([a-zA-Z0-9]{32})/,
  /client_id\s*=\s*"([a-zA-Z0-9]{32})"/,
  /["']client_id["']\s*:\s*["']([a-zA-Z0-9]{32})["']/,
  /clientId["']?\s*:\s*["']([a-zA-Z0-9]{32})["']/i,
  /client_id%22%3A%22([a-zA-Z0-9]{32})%22/,
]

const SC_UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const SC_UA_MOBILE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1'

/** Страницы, с которых SoundCloud тянет разные чанки webpack (client_id не всегда в главном бандле). */
const SC_HTML_PAGES = [
  'https://soundcloud.com/',
  'https://soundcloud.com/discover',
  'https://soundcloud.com/search?q=test',
  'https://m.soundcloud.com/',
]

let _scClientIdCache = null
let _scClientIdExpiry = 0
let _audiusHostCache = { host: null, ts: 0 }
let _invidiousWorking = null
let _scWarmupStarted = false

function invalidateScClientIdCache() {
  _scClientIdCache = null
  _scClientIdExpiry = 0
}

/** Все URL .js с sndcdn (SoundCloud кладёт client_id в разные чанки, не только a-v2). */
function extractSndcdnScriptUrls(html) {
  const raw = String(html || '')
  const out = []
  const reList = [
    /src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g,
    /src='(https:\/\/a-v2\.sndcdn\.com\/assets\/[^']+\.js)'/g,
    /"(https:\/\/[a-z0-9.-]*sndcdn\.com\/[^"]+\.js)"/gi,
    /'(https:\/\/[a-z0-9.-]*sndcdn\.com\/[^']+\.js)'/gi,
    /(https:\/\/a-v2\.sndcdn\.com\/assets\/[a-zA-Z0-9._-]+\.js)/g,
  ]
  for (const re of reList) {
    let m
    const r = new RegExp(re.source, re.flags)
    while ((m = r.exec(raw)) !== null) {
      if (m[1]) out.push(m[1])
    }
  }
  return [...new Set(out)].filter((u) => /\.js(\?|$)/i.test(u))
}

function collectCandidateClientIds(jsText) {
  const text = String(jsText || '')
  const found = new Set()
  for (const pattern of SC_PATTERNS) {
    const g = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
    let m
    while ((m = g.exec(text)) !== null) {
      const id = m[1]
      if (id && /^[a-zA-Z0-9]{32}$/.test(id)) found.add(id)
    }
  }
  return [...found]
}

function scApiBrowserHeaders(extra = {}) {
  return {
    'User-Agent': SC_UA_DESKTOP,
    Accept: 'application/json; charset=utf-8',
    'Accept-Language': 'en-US,en;q=0.9',
    Origin: 'https://soundcloud.com',
    Referer: 'https://soundcloud.com/',
    ...extra,
  }
}

/** Проверяем, что client_id реально принимает api-v2 (часто в бандле лежит старый/битый id). */
async function verifyScClientIdWorks(clientId) {
  const cid = String(clientId || '').trim()
  if (!/^[a-zA-Z0-9]{32}$/.test(cid)) return false
  const auth = SC_OAUTH_TOKEN ? { Authorization: `OAuth ${SC_OAUTH_TOKEN}` } : {}
  try {
    const r = await axios.get(
      `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent('a')}&client_id=${cid}&limit=1&linked_partitioning=1`,
      {
        headers: { ...scApiBrowserHeaders(), ...auth },
        timeout: 12000,
        validateStatus: () => true,
      },
    )
    if (r.status === 401 || r.status === 403) return false
    if (r.status !== 200 || r.data == null) return false
    if (Array.isArray(r.data)) return true
    if (Array.isArray(r.data.collection)) return true
    if (Array.isArray(r.data.tracks)) return true
    return false
  } catch {
    return false
  }
}

async function pickFirstWorkingScClientId(candidates) {
  const list = [...new Set((candidates || []).filter(Boolean))]
  for (const id of list) {
    if (await verifyScClientIdWorks(id)) return id
  }
  return null
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeAccessToken(rawToken) {
  const raw = String(rawToken || '').trim()
  if (!raw) return ''
  const m = raw.match(/access_token=([^&#]+)/)
  return m ? decodeURIComponent(m[1]) : raw
}

function isTimeoutError(err) {
  const msg = String(err?.message || '')
  return err?.code === 'ECONNABORTED' || msg.includes('timeout')
}

async function withRetries(task, retries = 1, baseDelayMs = 350) {
  let lastErr = null
  for (let i = 0; i <= retries; i++) {
    try {
      return await task(i)
    } catch (err) {
      lastErr = err
      if (i >= retries) break
      await delay(baseDelayMs * (i + 1))
    }
  }
  throw lastErr
}

async function resolveScClientId(manualId = '') {
  const direct = String(manualId || '').trim()
  if (direct) {
    if (await verifyScClientIdWorks(direct)) return direct
    throw new Error('SC: указанный client_id не проходит проверку api-v2')
  }
  if (SC_CLIENT_ID_ENV) {
    if (await verifyScClientIdWorks(SC_CLIENT_ID_ENV)) return SC_CLIENT_ID_ENV
    throw new Error('SC: SC_CLIENT_ID из env не проходит проверку api-v2')
  }
  const now = Date.now()
  if (_scClientIdCache && now < _scClientIdExpiry) return _scClientIdCache

  const htmlHeadersVariants = [
    {
      'User-Agent': SC_UA_DESKTOP,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    {
      'User-Agent': SC_UA_MOBILE_SAFARI,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  ]

  const tryIds = async (ids) => {
    const ok = await pickFirstWorkingScClientId(ids)
    if (ok) {
      _scClientIdCache = ok
      _scClientIdExpiry = now + 3 * 60 * 60 * 1000
      return ok
    }
    return null
  }

  const seenScript = new Set()
  for (const pageUrl of SC_HTML_PAGES) {
    for (const h of htmlHeadersVariants) {
      const page = await axios
        .get(pageUrl, {
          headers: h,
          timeout: 18000,
          validateStatus: () => true,
        })
        .catch(() => null)
      const raw = String(page?.data || '')
      if (!raw) continue
      const scriptUrls = extractSndcdnScriptUrls(raw)
      if (!scriptUrls.length) continue
      const candidates = [...new Set(scriptUrls)].reverse().slice(0, 48)
      for (const scriptUrl of candidates) {
        if (seenScript.has(scriptUrl)) continue
        seenScript.add(scriptUrl)
        try {
          const js = await axios.get(scriptUrl, {
            headers: { 'User-Agent': SC_UA_DESKTOP, Accept: '*/*' },
            timeout: 22000,
            validateStatus: () => true,
          })
          if (js.status !== 200 || !js.data) continue
          const idsInChunk = collectCandidateClientIds(String(js.data))
          const ok = await tryIds(idsInChunk)
          if (ok) return ok
        } catch {}
      }
    }
  }

  const lastChance = await tryIds(SC_CLIENT_ID_FALLBACKS)
  if (lastChance) return lastChance
  throw new Error('SC: рабочий client_id не найден (скрейп + SC_CLIENT_ID_FALLBACKS). Задай SC_CLIENT_ID или SC_CLIENT_ID_FALLBACKS на VPS.')
}

async function getAudiusHost(force = false) {
  const now = Date.now()
  if (!force && _audiusHostCache.host && now - _audiusHostCache.ts < 10 * 60 * 1000) {
    return _audiusHostCache.host
  }
  const r = await axios.get('https://api.audius.co/', { timeout: 12000, validateStatus: () => true })
  const hosts = Array.isArray(r.data?.data) ? r.data.data.filter(Boolean) : []
  if (!hosts.length) throw new Error('Audius discovery unavailable')
  const host = String(hosts[Math.floor(Math.random() * hosts.length)]).replace(/\/+$/, '')
  _audiusHostCache = { host, ts: now }
  return host
}

async function getWorkingInvidious() {
  if (_invidiousWorking) {
    try {
      const r = await axios.get(`https://${_invidiousWorking}/api/v1/search?q=test&type=video&page=1`, {
        timeout: 6000,
        validateStatus: () => true,
      })
      if (r.status === 200 && Array.isArray(r.data)) return _invidiousWorking
    } catch {}
    _invidiousWorking = null
  }
  for (const inst of INVIDIOUS_INSTANCES) {
    try {
      const r = await axios.get(`https://${inst}/api/v1/search?q=test&type=video&page=1`, {
        timeout: 8000,
        validateStatus: () => true,
      })
      if (r.status === 200 && Array.isArray(r.data)) {
        _invidiousWorking = inst
        return inst
      }
    } catch {}
  }
  return null
}

async function searchSpotify(query, spotifyToken) {
  const r = await axios.get(
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=20`,
    { headers: { Authorization: `Bearer ${spotifyToken}` }, timeout: 9000, validateStatus: () => true },
  )
  if (r.status !== 200 || !Array.isArray(r.data?.tracks?.items)) return []
  return r.data.tracks.items.map((t) => ({
    title: t?.name || 'Без названия',
    artist: Array.isArray(t?.artists) ? t.artists.map((a) => a?.name).filter(Boolean).join(', ') : '—',
    url: t?.preview_url || null,
    cover: t?.album?.images?.[0]?.url || null,
    bg: 'linear-gradient(135deg,#1db954,#1ed760)',
    source: 'spotify',
    id: String(t?.id || `${t?.name || ''}:${t?.artists?.[0]?.name || ''}`),
  }))
}

async function searchSoundCloud(query, manualScId) {
  const runOnce = async (scClientId) => {
    const authHeader = SC_OAUTH_TOKEN ? { Authorization: `OAuth ${SC_OAUTH_TOKEN}` } : {}
    const commonHeaders = {
      ...scApiBrowserHeaders(),
      ...authHeader,
    }
    const q = encodeURIComponent(query)
    const endpoints = [
      {
        h: 'https://api-v2.soundcloud.com',
        p: `/search/tracks?q=${q}&client_id=${scClientId}&limit=20&linked_partitioning=1`,
      },
      {
        h: 'https://api-v2.soundcloud.com',
        p: `/search/tracks?q=${q}&client_id=${scClientId}&limit=20&offset=0&linked_partitioning=true`,
      },
      {
        h: 'https://api.soundcloud.com',
        p: `/tracks?q=${q}&client_id=${scClientId}&limit=20&linked_partitioning=1`,
      },
    ]
    for (const ep of endpoints) {
      const r = await withRetries(
        async (attempt) =>
          axios.get(ep.h + ep.p, {
            headers: commonHeaders,
            timeout: attempt === 0 ? 14000 : 20000,
            validateStatus: () => true,
          }),
        2,
        500,
      )
      if (r.status === 401 || r.status === 403) return { tracks: [], unauthorized: true }
      if (r.status !== 200 || !r.data) continue
      const rows = Array.isArray(r.data) ? r.data : r.data.collection || r.data.tracks || []
      const tracks = rows
        .map((t) => {
          let transcodingUrl = null
          if (Array.isArray(t?.media?.transcodings) && t.media.transcodings.length > 0) {
            const prog = t.media.transcodings.find((tr) => tr?.format?.protocol === 'progressive')
            const hls = t.media.transcodings.find((tr) => tr?.format?.protocol === 'hls')
            transcodingUrl = (prog || hls || t.media.transcodings[0])?.url || null
          }
          return {
            title: t?.title || 'Без названия',
            artist: t?.user?.username || '—',
            url: t?.stream_url ? `${t.stream_url}?client_id=${scClientId}` : null,
            scTranscoding: transcodingUrl,
            scClientId,
            cover: t?.artwork_url ? String(t.artwork_url).replace('large', 't300x300') : null,
            bg: 'linear-gradient(135deg,#f26f23,#ff5500)',
            source: 'soundcloud',
            id: String(t?.id || `${t?.title || ''}:${t?.user?.username || ''}`),
          }
        })
        .filter((t) => t.scTranscoding || t.url)
      if (tracks.length) return { tracks, unauthorized: false }
    }
    return { tracks: [], unauthorized: false }
  }

  let scClientId = await resolveScClientId(manualScId)
  let { tracks, unauthorized } = await runOnce(scClientId)
  if (tracks.length) return tracks
  if (unauthorized) {
    invalidateScClientIdCache()
    try {
      scClientId = await resolveScClientId(manualScId)
      ;({ tracks } = await runOnce(scClientId))
    } catch {
      return []
    }
  }
  return tracks
}

async function searchAudius(query) {
  let host = await getAudiusHost(false)
  const trySearch = async (h) => {
    const p = `/v1/tracks/search?query=${encodeURIComponent(query)}&limit=20&app_name=flow`
    const r = await axios.get(h + p, { timeout: 12000, validateStatus: () => true })
    const items = Array.isArray(r.data?.data) ? r.data.data : []
    return items.map((t) => {
      const id = String(t?.id || '')
      return {
        title: t?.title || 'Без названия',
        artist: t?.user?.name || '—',
        url: id ? `${h}/v1/tracks/${encodeURIComponent(id)}/stream?app_name=flow` : null,
        cover: t?.artwork?.['480x480'] || t?.artwork?.['1000x1000'] || t?.artwork?.['150x150'] || null,
        bg: 'linear-gradient(135deg,#2dd4bf,#0ea5e9)',
        source: 'audius',
        id: id || `${t?.title || ''}:${t?.user?.name || ''}`,
      }
    }).filter((t) => t.url)
  }
  try {
    const tracks = await trySearch(host)
    if (tracks.length) return tracks
  } catch {}
  host = await getAudiusHost(true)
  return trySearch(host)
}

function searchYandex(query, token) {
  return flowYandex.searchYandexTracks(query, token)
}

function searchVk(query, token) {
  return searchVkTracks(query, token)
}

async function searchYoutube(query) {
  const inst = await getWorkingInvidious()
  if (!inst) throw new Error('YouTube: нет доступных Invidious-инстансов')
  const r = await axios.get(
    `https://${inst}/api/v1/search?q=${encodeURIComponent(query)}&type=video&fields=videoId,title,author,lengthSeconds,videoThumbnails&page=1`,
    { timeout: 12000, validateStatus: () => true },
  )
  if (r.status !== 200 || !Array.isArray(r.data)) throw new Error('YouTube: ошибка поиска')
  return r.data.slice(0, 20).map((v) => {
    const thumbs = v.videoThumbnails || []
    const thumb = thumbs.find((t) => t.quality === 'medium') || thumbs[0]
    return {
      title: v.title,
      artist: v.author,
      url: null,
      ytId: v.videoId,
      cover: thumb?.url || null,
      bg: 'linear-gradient(135deg,#ff0000,#cc0000)',
      source: 'youtube',
      id: String(v.videoId),
      duration: v.lengthSeconds,
      ytInstance: inst,
    }
  })
}

async function hybridSearch(query, tokens) {
  const spotifyToken = String(tokens?.spotifyToken || '').trim()
  const manualSc = String(tokens?.soundcloudClientId || '').trim()

  if (spotifyToken) {
    try {
      const tracks = await searchSpotify(query, spotifyToken)
      if (tracks.length) return { ok: true, mode: 'spotify', tracks }
    } catch (_) {}
  }
  try {
    const tracks = await searchSoundCloud(query, manualSc)
    if (tracks.length) return { ok: true, mode: 'soundcloud', tracks }
  } catch (_) {}
  try {
    const tracks = await searchAudius(query)
    if (tracks.length) return { ok: true, mode: 'audius', tracks }
  } catch (_) {}
  return { ok: false, error: 'Ничего не найдено (как hybrid десктопа: Spotify→SC→Audius)', mode: 'none', tracks: [] }
}

function resolveYandexStream(trackId, token) {
  return flowYandex.resolveYandexStream(trackId, token)
}

async function resolveScStream(transcodingUrl, clientId) {
  const u = new URL(transcodingUrl + (transcodingUrl.includes('?') ? '&' : '?') + `client_id=${clientId}`)
  const r = await withRetries(
    async (attempt) =>
      axios.get(`https://${u.hostname}${u.pathname}${u.search}`, {
        headers: {
          ...scApiBrowserHeaders(),
          ...(SC_OAUTH_TOKEN ? { Authorization: `OAuth ${SC_OAUTH_TOKEN}` } : {}),
        },
        timeout: attempt === 0 ? 12000 : 16000,
        validateStatus: () => true,
      }),
    2,
    400,
  )
  if (r.status === 401 || r.status === 403) {
    invalidateScClientIdCache()
    return { ok: false, error: 'SoundCloud: client_id отклонён при стриме — повтори resolve' }
  }
  if (r.data?.url) return { ok: true, url: r.data.url }
  return { ok: false, error: 'SoundCloud: пустой ответ при получении стрима' }
}

async function probeUrl(url) {
  try {
    const r = await axios.get(url, {
      headers: { Range: 'bytes=0-0' },
      timeout: 8000,
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400,
    })
    return Boolean(r.status >= 200 && r.status < 400)
  } catch {
    return false
  }
}

async function resolveYoutubeStream(videoId, preferredInstance) {
  const id = String(videoId || '')
  if (!id) return { ok: false, error: 'bad video id' }
  const instances = preferredInstance
    ? [preferredInstance, ...INVIDIOUS_INSTANCES.filter((i) => i !== preferredInstance)]
    : [...(await getWorkingInvidious() ? [_invidiousWorking] : []), ...INVIDIOUS_INSTANCES]
  const uniq = [...new Set(instances.filter(Boolean))]
  for (const inst of uniq) {
    try {
      const r = await axios.get(`https://${inst}/api/v1/videos/${id}?fields=adaptiveFormats,formatStreams`, {
        timeout: 14000,
        validateStatus: () => true,
      })
      if (r.status !== 200 || !r.data) continue
      const audioOnly = (r.data.adaptiveFormats || [])
        .filter(
          (f) =>
            f.url &&
            (f.type?.includes('audio/webm') || f.type?.includes('audio/mp4') || f.type?.startsWith('audio/')),
        )
        .sort((a, b) => {
          const aW = a.type?.includes('audio/webm') ? 1 : 0
          const bW = b.type?.includes('audio/webm') ? 1 : 0
          if (bW !== aW) return bW - aW
          return (b.bitrate || 0) - (a.bitrate || 0)
        })
      const streamUrl = audioOnly[0]?.url || (r.data.formatStreams || []).find((f) => f.url)?.url
      if (!streamUrl) continue
      if (await probeUrl(streamUrl)) return { ok: true, url: streamUrl, inst }
    } catch {}
  }
  const PIPED = ['pipedapi.kavin.rocks', 'pipedapi.moomoo.me', 'pipedapi.adminforge.de']
  for (const piped of PIPED) {
    try {
      const r = await axios.get(`https://${piped}/streams/${id}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 12000,
        validateStatus: () => true,
      })
      if (r.status !== 200 || !r.data?.audioStreams) continue
      const best = r.data.audioStreams.filter((s) => s.url).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]
      if (best?.url && (await probeUrl(best.url))) return { ok: true, url: best.url, inst: piped }
    } catch {}
  }
  return { ok: false, error: 'YouTube: не удалось получить поток (Invidious/Piped)' }
}

async function resolveTrack(track, tokens) {
  const source = String(track?.source || '').toLowerCase()
  if (track?.url && (source === 'vk' || source === 'audius' || (source === 'spotify' && track.url))) {
    return { ok: true, url: track.url }
  }
  if (source === 'spotify' && track?.url) return { ok: true, url: track.url }
  if (source === 'yandex') {
    const tok = String(tokens?.yandexToken || '').trim()
    if (!tok) return { ok: false, error: 'Нет Яндекс-токена' }
    return resolveYandexStream(String(track.id), tok)
  }
  if (source === 'vk') {
    const tok = normalizeAccessToken(tokens?.vkToken || '')
    if (!tok) return { ok: false, error: 'Нет VK-токена' }
    if (track?.url) return { ok: true, url: track.url }
    return { ok: false, error: 'VK: у трека нет URL' }
  }
  if (source === 'soundcloud') {
    const cid = track.scClientId || (await resolveScClientId(tokens?.soundcloudClientId || ''))
    if (track.scTranscoding) return resolveScStream(track.scTranscoding, cid)
    if (track.url) return { ok: true, url: track.url }
    return { ok: false, error: 'SoundCloud: нет transcoding' }
  }
  if (source === 'youtube') {
    const vid = track.ytId || track.id
    return resolveYoutubeStream(vid, track.ytInstance || null)
  }
  if (source === 'audius' && track.url) return { ok: true, url: track.url }
  return { ok: false, error: `Источник не поддержан: ${source || '?'}` }
}

/** Bearer обязателен до любой логики /mobile/v1 (не публичный прокси). */
function auth(req, res, next) {
  const h = req.headers.authorization || ''
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : ''
  if (tok !== SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' })
  next()
}

const app = express()
app.use(cors({ origin: true }))
app.use(express.json({ limit: '4mb' }))

app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    service: 'flow-mobile-gateway',
    scClientIdEnv: Boolean(SC_CLIENT_ID_ENV),
    scClientIdFallbacks: SC_CLIENT_ID_FALLBACKS.length,
    scOauthEnv: Boolean(SC_OAUTH_TOKEN),
  }),
)

/** Все платные по сети маршруты только после проверки секрета. */
const mobileV1 = express.Router()
mobileV1.use(auth)

mobileV1.post('/search', async (req, res) => {
  try {
    const q = String(req.body?.q || '').trim()
    const source = String(req.body?.source || 'hybrid').toLowerCase()
    const tokens = req.body?.tokens || {}
    if (!q) return res.json({ ok: true, mode: 'empty', tracks: [] })

    if (source === 'hybrid') {
      const out = await hybridSearch(q, tokens)
      return res.json(out)
    }
    if (source === 'spotify') {
      const t = String(tokens.spotifyToken || '').trim()
      if (!t) return res.status(400).json({ ok: false, error: 'Нужен spotifyToken' })
      const tracks = await searchSpotify(q, t)
      return res.json({ ok: true, mode: 'spotify', tracks })
    }
    if (source === 'soundcloud') {
      const tracks = await searchSoundCloud(q, tokens.soundcloudClientId || '')
      return res.json({ ok: tracks.length > 0, mode: 'soundcloud', tracks, error: tracks.length ? undefined : 'Пусто' })
    }
    if (source === 'audius') {
      const tracks = await searchAudius(q)
      return res.json({ ok: tracks.length > 0, mode: 'audius', tracks })
    }
    if (source === 'yandex') {
      const t = String(tokens.yandexToken || '').trim()
      if (!t) return res.status(400).json({ ok: false, error: 'Нужен yandexToken' })
      const tracks = await searchYandex(q, t)
      return res.json({ ok: true, mode: 'yandex', tracks })
    }
    if (source === 'vk') {
      const t = normalizeAccessToken(tokens.vkToken || '')
      if (!t) return res.status(400).json({ ok: false, error: 'Нужен vkToken' })
      const tracks = await searchVk(q, t)
      return res.json({ ok: true, mode: 'vk', tracks })
    }
    if (source === 'youtube') {
      const tracks = await searchYoutube(q)
      return res.json({ ok: true, mode: 'youtube', tracks })
    }
    return res.status(400).json({ ok: false, error: 'Неизвестный source' })
  } catch (e) {
    const source = String(req.body?.source || 'hybrid').toLowerCase()
    if (source === 'soundcloud' && isTimeoutError(e)) {
      return res.json({
        ok: false,
        mode: 'soundcloud',
        tracks: [],
        retryable: true,
        error: 'SoundCloud временно не ответил, повторите поиск',
      })
    }
    return res.status(500).json({ ok: false, error: e.message || String(e) })
  }
})

mobileV1.post('/resolve', async (req, res) => {
  try {
    const track = req.body?.track
    const tokens = req.body?.tokens || {}
    if (!track) return res.status(400).json({ ok: false, error: 'Нет track' })
    const out = await resolveTrack(track, tokens)
    return res.json(out)
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) })
  }
})

mobileV1.post('/validate/vk', async (req, res) => {
  try {
    const t = normalizeAccessToken(req.body?.token || '')
    if (!t) return res.json({ ok: false, error: 'Пустой токен' })
    const ru = await vkInvokeKateMethod(
      'users.get',
      { access_token: t, fields: 'photo_100' },
      14000,
      [
        ['post', VK_KATE_MOBILE_UA, '5.131'],
        ['get', VK_KATE_MOBILE_UA, '5.131'],
      ],
    )
    if (ru.body?.error) {
      return res.json({
        ok: false,
        error: ru.body.error.error_msg || 'VK API',
        code: ru.body.error.error_code,
      })
    }
    const u = ru.body?.response?.[0]
    if (!u) return res.json({ ok: false, error: 'Пустой ответ users.get' })
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ')
    return res.json({ ok: true, userId: u.id, name })
  } catch (e) {
    return res.json({ ok: false, error: e.message })
  }
})

mobileV1.post('/validate/yandex', async (req, res) => {
  try {
    const t = String(req.body?.token || '').trim()
    const out = await flowYandex.validateYandexToken(t)
    if (!out.ok) return res.json({ ok: false, error: out.error || 'Ошибка' })
    return res.json({ ok: true, login: out.login || '' })
  } catch (e) {
    return res.json({ ok: false, error: e.message })
  }
})

app.use('/mobile/v1', mobileV1)

app.listen(PORT, () => {
  console.log(`[flow-mobile-gateway] http://0.0.0.0:${PORT}  (Bearer ${SECRET.slice(0, 4)}…)`)
  if (!_scWarmupStarted) {
    _scWarmupStarted = true
    // Неблокирующий прогрев SC client_id, чтобы первый реальный запрос реже ловил timeout.
    resolveScClientId('').catch(() => {})
  }
})
