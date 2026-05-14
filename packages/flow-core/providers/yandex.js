'use strict'

const crypto = require('crypto')
const axios = require('axios')

const YM_BASE = 'https://api.music.yandex.net'

function extractYandexOAuthToken(raw) {
  const t = String(raw || '').trim()
  const extracted = t.match(/access_token=([^&#]+)/)
  const decoded = extracted ? decodeURIComponent(extracted[1]) : t
  return decoded.trim()
}

function yandexApiHeaders(oauth) {
  return {
    Authorization: `OAuth ${oauth}`,
    'X-Yandex-Music-Client': 'WindowsPhone/3.20',
    'User-Agent': 'Windows 10',
  }
}

/**
 * @param {string} token сырой или с access_token= в URL
 * @returns {Promise<{ ok: boolean, login?: string, error?: string }>}
 */
async function validateYandexToken(token) {
  const oauth = extractYandexOAuthToken(token)
  if (!oauth) return { ok: false, error: 'Пустой токен' }
  const headers = yandexApiHeaders(oauth)
  const r = await axios.get(`${YM_BASE}/account/settings`, {
    headers,
    timeout: 12000,
    validateStatus: () => true,
  })
  if (r.status === 401 || r.status === 403) return { ok: false, error: 'Токен недействителен' }
  if (!r.data) return { ok: false, error: 'Пустой ответ' }
  if (r.data.error) {
    return { ok: false, error: String(r.data.error?.message || r.data.error?.name || 'Ошибка API') }
  }
  const res = r.data.result
  if (!res || typeof res !== 'object') return { ok: false, error: 'Не удалось проверить токен' }
  const login =
    typeof res.login === 'string' && res.login
      ? res.login
      : res.uid !== undefined && res.uid !== null
        ? String(res.uid)
        : ''
  return { ok: true, login }
}

/**
 * @param {string} q
 * @param {string} oauth уже OAuth-строка (без префикса OAuth в заголовке — передаётся как Bearer-тело)
 */
async function searchYandexTracks(q, oauth) {
  const r = await axios.get(`${YM_BASE}/search`, {
    params: { text: q, type: 'track', page: 0 },
    headers: yandexApiHeaders(oauth),
    timeout: 12000,
    validateStatus: () => true,
  })
  if (!r.data) throw new Error('Яндекс: пустой ответ')
  return (r.data.result?.tracks?.results || []).map((t) => ({
    title: t.title || 'Без названия',
    artist: t.artists?.map((a) => a.name).join(', ') || '—',
    url: null,
    cover: t.coverUri ? 'https://' + String(t.coverUri).replace('%%', '300x300') : null,
    bg: 'linear-gradient(135deg,#fc3f1d,#ff6534)',
    source: 'yandex',
    id: String(t.id),
  }))
}

function decodeYandexXmlField(value) {
  if (value == null) return ''
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/**
 * @param {string} trackId
 * @param {string} oauth
 * @param {{ probe?: (url: string) => Promise<{ ok: boolean, finalUrl?: string }> }} [opts] probe — как headOrRangeProbe в Electron main
 * @returns {Promise<{ ok: boolean, url?: string, error?: string }>}
 */
async function resolveYandexStream(trackId, oauth, opts = {}) {
  const probe = opts.probe
  try {
    const infoR = await axios.get(`${YM_BASE}/tracks/${encodeURIComponent(trackId)}/download-info`, {
      headers: yandexApiHeaders(oauth),
      timeout: 10000,
      validateStatus: () => true,
    })
    if (!infoR.data?.result?.length) {
      return { ok: false, error: 'Яндекс: нет источников для трека — нужна подписка Плюс' }
    }
    const rows = Array.isArray(infoR.data.result) ? infoR.data.result : []
    const byBr = (a, b) => Number(b.bitrateInKbps || 0) - Number(a.bitrateInKbps || 0)
    const mp3 = rows.filter((s) => String(s.codec || '').toLowerCase() === 'mp3').sort(byBr)
    const aac = rows.filter((s) => {
      const c = String(s.codec || '').toLowerCase()
      return c === 'aac' || c === 'eac-aac' || c === 'he-aac' || c === 'aac-mp4'
    }).sort(byBr)
    let sources = mp3.length ? mp3 : aac.length ? aac : [...rows].sort(byBr)
    if (!sources.length) {
      return { ok: false, error: 'Яндекс: нет доступных потоков (mp3/aac)' }
    }
    const src = sources[0]
    const xmlR = await axios.get(src.downloadInfoUrl, {
      headers: { Authorization: `OAuth ${oauth}` },
      timeout: 10000,
      validateStatus: () => true,
      responseType: 'text',
    })
    const raw = String(xmlR.data || '')
    if (!raw) return { ok: false, error: 'Яндекс: не удалось получить URL стрима' }

    const host = decodeYandexXmlField(raw.match(/<host>([^<]+)<\/host>/)?.[1])
    const path = decodeYandexXmlField(raw.match(/<path>([^<]+)<\/path>/)?.[1])
    const ts = decodeYandexXmlField(raw.match(/<ts>([^<]+)<\/ts>/)?.[1])
    const s = decodeYandexXmlField(raw.match(/<s>([^<]+)<\/s>/)?.[1])
    if (!host || !path || !ts || !s) {
      return { ok: false, error: 'Яндекс: не удалось распарсить URL стрима' }
    }
    const sign = crypto.createHash('md5').update('XGRlBW9FXlekgbPrRHuSiA' + path.slice(1) + s).digest('hex')
    const streamUrl = `https://${host}/get-mp3/${sign}/${ts}${path}`
    if (typeof probe === 'function') {
      const pr = await probe(streamUrl).catch(() => null)
      const urlOut = pr && pr.ok && pr.finalUrl ? pr.finalUrl : streamUrl
      return { ok: true, url: urlOut }
    }
    return { ok: true, url: streamUrl }
  } catch (err) {
    return { ok: false, error: 'Яндекс: ' + (err?.message || String(err)) }
  }
}

module.exports = {
  extractYandexOAuthToken,
  yandexApiHeaders,
  validateYandexToken,
  searchYandexTracks,
  decodeYandexXmlField,
  resolveYandexStream,
}
