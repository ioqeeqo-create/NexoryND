const { app, BrowserWindow, ipcMain, shell } = require('electron')
const { execFile } = require('child_process')
const path = require('path')
const fs = require('fs')
const https = require('https')
const http = require('http')
const crypto = require('crypto')
const axios = require('axios')
const { pathToFileURL } = require('url')
const {
  parseSpotifyPlaylistId,
  parseYandexPlaylistRef,
  parseVkPlaylistRef,
} = require('./src/modules/utils/parsers')

const SAFE_GPU_FLAG = '--flow-safe-gpu'
const _isSafeGpuMode = process.argv.includes(SAFE_GPU_FLAG)
let _safeGpuRestartRequested = false

// Reduce noisy Chromium cache/GPU logs in terminal.
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
app.commandLine.appendSwitch('disable-logging')
app.commandLine.appendSwitch('log-level', '3')
if (_isSafeGpuMode) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('in-process-gpu')
  console.log('[safe-gpu] enabled')
}

function relaunchInSafeGpuMode(reason = 'unknown') {
  if (_isSafeGpuMode || _safeGpuRestartRequested) return
  _safeGpuRestartRequested = true
  try {
    console.warn('[safe-gpu] relaunch requested:', reason)
    const args = process.argv.filter((a) => a !== SAFE_GPU_FLAG)
    args.push(SAFE_GPU_FLAG)
    app.relaunch({ args })
  } catch (e) {
    console.warn('[safe-gpu] relaunch failed:', e?.message || e)
  }
  setTimeout(() => app.exit(0), 120)
}

// в”Ђв”Ђв”Ђ Р›РћРљРђР›Р¬РќР«Р™ РџР РћРљРЎР Р”Р›РЇ РђРЈР”РРћ в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
// Electron РЅРµ РјРѕР¶РµС‚ РІРѕСЃРїСЂРѕРёР·РІРµСЃС‚Рё СЃС‚СЂРёРјС‹ РЅР°РїСЂСЏРјСѓСЋ СЃ Invidious/Piped
// РёР·-Р·Р° Р·Р°РіРѕР»РѕРІРєРѕРІ CORS Рё Range. РџСЂРѕРєСЃРёСЂСѓРµРј С‡РµСЂРµР· localhost.
let _proxyServer = null
let _proxyPort = 19875
let _proxyCurrentUrl = null
const _proxyUrlMap = new Map()
const PROXY_TOKEN_TTL_MS = 10 * 60 * 1000

// --- yt-dlp managed binary (auto-update in userData) ---
const YTDLP_MANAGED_DIR = 'yt-dlp'
const YTDLP_MANAGED_EXE = 'yt-dlp.exe'
const YTDLP_VERSION_FILE = 'version.txt'
const YTDLP_UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000
let _lastYtDlpUpdateCheckAt = 0
let _resolvedYtDlpBinary = null
let _lastYtDlpResolveAt = 0
let _ytDlpResolveInFlight = null
const YTDLP_RESOLVE_CACHE_MS = 10 * 60 * 1000

function getManagedYtDlpPaths() {
  try {
    const userData = app.getPath('userData')
    const dir = path.join(userData, YTDLP_MANAGED_DIR)
    const exePath = path.join(dir, YTDLP_MANAGED_EXE)
    const verPath = path.join(dir, YTDLP_VERSION_FILE)
    return { dir, exePath, verPath }
  } catch {
    return { dir: null, exePath: null, verPath: null }
  }
}

function readTextSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null
    return String(fs.readFileSync(filePath, 'utf8') || '').trim() || null
  } catch {
    return null
  }
}

function writeTextSafe(filePath, text) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, String(text || ''), 'utf8')
  } catch {}
}

function getCustomMediaDir() {
  const dir = path.join(app.getPath('userData'), 'custom-media')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function getSafeMediaExt(name = '', mime = '') {
  const fromName = String(path.extname(String(name || '')).replace(/[^.\w-]/g, '').toLowerCase() || '')
  if (fromName && fromName.length <= 8) return fromName
  const m = String(mime || '').toLowerCase()
  if (m.includes('gif')) return '.gif'
  if (m.includes('png')) return '.png'
  if (m.includes('webp')) return '.webp'
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg'
  return '.bin'
}

ipcMain.handle('save-custom-media', async (event, payload = {}) => {
  const bytes = payload?.bytes
  const size = Number(bytes?.byteLength || bytes?.length || 0)
  if (!bytes || !size) return { ok: false, error: 'empty media' }
  if (size > 80 * 1024 * 1024) return { ok: false, error: 'media too large' }
  const ext = getSafeMediaExt(payload?.name, payload?.mime)
  const purpose = String(payload?.purpose || 'media').replace(/[^\w-]+/g, '-').slice(0, 32) || 'media'
  const hash = crypto.createHash('sha1').update(Buffer.from(bytes)).digest('hex').slice(0, 16)
  const fileName = `${purpose}-${Date.now()}-${hash}${ext}`
  const filePath = path.join(getCustomMediaDir(), fileName)
  fs.writeFileSync(filePath, Buffer.from(bytes))
  return { ok: true, url: pathToFileURL(filePath).toString(), path: filePath, name: fileName }
})

function httpsGetJsonUrl(url, headers = {}, timeout = 12000) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url)
      const req = https.request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Flow/0.2 (Electron)',
          'Accept': 'application/json',
          ...headers
        }
      }, (res) => {
        let raw = ''
        res.on('data', (d) => { raw += d })
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, body: JSON.parse(raw || '{}') })
          } catch {
            resolve({ status: res.statusCode || 0, body: null, raw })
          }
        })
      })
      req.on('error', reject)
      req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')) })
      req.end()
    } catch (e) {
      reject(e)
    }
  })
}

function httpGetTextUrl(url, headers = {}, timeout = 15000, depth = 0) {
  return new Promise((resolve, reject) => {
    try {
      if (depth > 5) return reject(new Error('too many redirects'))
      const u = new URL(url)
      const isHttps = u.protocol === 'https:'
      const lib = isHttps ? https : http
      const req = lib.request({
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
          ...headers
        }
      }, (res) => {
        const status = Number(res.statusCode || 0)
        if (status >= 300 && status < 400 && res.headers.location) {
          const next = new URL(String(res.headers.location), u).toString()
          res.resume()
          return resolve(httpGetTextUrl(next, headers, timeout, depth + 1))
        }
        let raw = ''
        res.on('data', (d) => { raw += String(d || '') })
        res.on('end', () => resolve({ status, text: raw }))
      })
      req.on('error', reject)
      req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')) })
      req.end()
    } catch (e) {
      reject(e)
    }
  })
}

function decodeHtmlEntities(input) {
  const str = String(input || '')
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n) || 0))
}

function decodeJsEscapes(input) {
  const str = String(input || '')
  return str
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

function extractVkPlaylistMetaFromHtml(html) {
  const raw = decodeJsEscapes(decodeHtmlEntities(html))
  const text = cleanupVkText(raw)
  const out = []
  const seen = new Set()
  const pushTrack = (artist, title) => {
    const a = cleanupVkText(artist)
    const t = cleanupVkText(title)
    if (!a || !t) return
    const key = `${a.toLowerCase()}::${t.toLowerCase()}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ title: t, artist: a })
  }
  const re1 = /"artist"\s*:\s*"([^"]{1,220})"\s*,\s*"title"\s*:\s*"([^"]{1,260})"/g
  const re2 = /"title"\s*:\s*"([^"]{1,260})"\s*,\s*"artist"\s*:\s*"([^"]{1,220})"/g
  const re3 = /"performer"\s*:\s*"([^"]{1,220})"\s*,\s*"title"\s*:\s*"([^"]{1,260})"/g
  const re4 = /audio_row__performers[^>]*>([^<]{1,220})<[\s\S]{0,300}?audio_row__title_inner[^>]*>([^<]{1,260})</g
  const re5 = /"subtitle"\s*:\s*"([^"]{1,220})"\s*,\s*"title"\s*:\s*"([^"]{1,260})"/g
  const re6 = /"performer"\s*:\s*"([^"]{1,220})"[\s\S]{0,140}?"name"\s*:\s*"([^"]{1,260})"/g
  let m
  while ((m = re1.exec(text))) pushTrack(m[1], m[2])
  while ((m = re2.exec(text))) pushTrack(m[2], m[1])
  while ((m = re3.exec(text))) pushTrack(m[1], m[2])
  while ((m = re4.exec(raw))) pushTrack(m[1], m[2])
  while ((m = re5.exec(text))) pushTrack(m[1], m[2])
  while ((m = re6.exec(text))) pushTrack(m[1], m[2])

  // Mobile VK often stores rows in data-audio arrays where [3]=title, [4]=artist.
  const dataAudioRx = /data-audio=(?:"([^"]+)"|'([^']+)')/g
  while ((m = dataAudioRx.exec(raw))) {
    const packed = cleanupVkText(m[1] || m[2] || '')
    if (!packed || packed[0] !== '[') continue
    try {
      const arr = JSON.parse(packed)
      if (!Array.isArray(arr)) continue
      const title = cleanupVkText(arr[3] || arr[5] || '')
      const artist = cleanupVkText(arr[4] || arr[6] || '')
      pushTrack(artist, title)
    } catch {}
  }
  const titleMatch = raw.match(/<title[^>]*>([^<]{1,200})<\/title>/i) || raw.match(/"title"\s*:\s*"([^"]{1,200}playlist[^"]*)"/i)
  const name = cleanupVkText(titleMatch?.[1] || 'VK Playlist')
  return { name, tracks: out }
}

function extractVkSimplePairsFromHtml(html, max = 140) {
  const raw = decodeJsEscapes(decodeHtmlEntities(html))
  const out = []
  const seen = new Set()
  const artistRx = /"artist"\s*:\s*"([^"]{1,220})"/g
  const titleRx = /"title"\s*:\s*"([^"]{1,260})"/g
  const artists = []
  const titles = []
  let m
  while ((m = artistRx.exec(raw))) artists.push(cleanupVkText(m[1]))
  while ((m = titleRx.exec(raw))) titles.push(cleanupVkText(m[1]))
  const n = Math.min(artists.length, titles.length, Math.max(1, Number(max) || 140))
  for (let i = 0; i < n; i++) {
    const artist = artists[i]
    const title = titles[i]
    if (!artist || !title) continue
    if (title.length < 2 || artist.length < 1) continue
    const key = `${artist.toLowerCase()}::${title.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ title, artist })
  }
  return out
}

function extractVkRowsFromDataAudio(html, max = 220) {
  const raw = decodeJsEscapes(decodeHtmlEntities(html))
  const out = []
  const seen = new Set()
  const rx = /data-audio=(?:"([^"]+)"|'([^']+)')/g
  let m
  while ((m = rx.exec(raw)) && out.length < max) {
    const packed = cleanupVkText(m[1] || m[2] || '')
    if (!packed || packed[0] !== '[') continue
    try {
      const arr = JSON.parse(packed)
      if (!Array.isArray(arr)) continue
      const title = cleanupVkText(arr[3] || arr[5] || '')
      const artist = cleanupVkText(arr[4] || arr[6] || '')
      if (!title || !artist) continue
      const key = `${artist.toLowerCase()}::${title.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ title, artist })
    } catch {}
  }
  return out
}

async function fetchVkPlaylistMetaWithoutToken(link, vkRef = null) {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  const headers = {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': 'https://vk.com/',
  }
  const candidates = [String(link || '').trim()]
  if (vkRef?.ownerId && vkRef?.albumId) candidates.push(`https://m.vk.com/audio?act=audio_playlist${vkRef.ownerId}_${vkRef.albumId}`)
  let merged = []
  const pushAll = (items) => {
    for (const it of items || []) {
      if (!it?.title || !it?.artist) continue
      const key = `${String(it.artist).toLowerCase()}::${String(it.title).toLowerCase()}`
      if (merged.some((x) => `${String(x.artist).toLowerCase()}::${String(x.title).toLowerCase()}` === key)) continue
      merged.push({ title: cleanupVkText(it.title), artist: cleanupVkText(it.artist) })
      if (merged.length >= 220) break
    }
  }
  for (const url of candidates) {
    if (!url) continue
    try {
      const r = await axios.get(url, {
        headers,
        timeout: 17000,
        maxRedirects: 6,
        validateStatus: () => true,
      })
      const html = String(r?.data || '')
      if (!html) continue
      pushAll(extractVkRowsFromDataAudio(html, 220))
      if (merged.length < 40) pushAll(extractVkPlaylistMetaFromHtml(html).tracks || [])
      if (merged.length < 40) pushAll(extractVkSimplePairsFromHtml(html, 220))
      if (merged.length >= 8) break
    } catch {}
  }
  return merged
}

function httpsDownloadToFile(url, filePath, headers = {}, timeout = 30000) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      const tmp = filePath + '.tmp'
      const out = fs.createWriteStream(tmp)
      const req = https.request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Flow/0.2 (Electron)',
          'Accept': '*/*',
          ...headers
        }
      }, (res) => {
        const status = res.statusCode || 0
        if (status < 200 || status >= 300) {
          res.resume()
          try { out.close() } catch {}
          try { fs.unlinkSync(tmp) } catch {}
          reject(new Error(`download failed (${status})`))
          return
        }
        res.pipe(out)
        out.on('finish', () => {
          try { out.close() } catch {}
          try {
            fs.renameSync(tmp, filePath)
          } catch (e) {
            try { fs.copyFileSync(tmp, filePath) } catch {}
            try { fs.unlinkSync(tmp) } catch {}
          }
          resolve(true)
        })
      })
      req.on('error', (e) => {
        try { out.close() } catch {}
        try { fs.unlinkSync(tmp) } catch {}
        reject(e)
      })
      req.setTimeout(timeout, () => { req.destroy(new Error('timeout')) })
      req.end()
    } catch (e) {
      reject(e)
    }
  })
}

async function checkAndDownloadYtDlp() {
  // Throttle checks (avoids hammering GitHub API during dev reloads).
  const now = Date.now()
  if (_lastYtDlpUpdateCheckAt && (now - _lastYtDlpUpdateCheckAt) < YTDLP_UPDATE_CHECK_TTL_MS) return { ok: true, skipped: true }
  _lastYtDlpUpdateCheckAt = now

  const { dir, exePath, verPath } = getManagedYtDlpPaths()
  if (!dir || !exePath || !verPath) return { ok: false, error: 'userData unavailable' }

  const currentVersion = readTextSafe(verPath)
  let latestTag = null
  let assetUrl = null

  try {
    const r = await httpsGetJsonUrl('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', {
      'User-Agent': 'Flow/0.2 (Electron)',
      'Accept': 'application/vnd.github+json'
    }, 15000)
    if (r.status !== 200 || !r.body) return { ok: false, error: `GitHub API status ${r.status}` }
    latestTag = r.body.tag_name || r.body.name || null
    const assets = Array.isArray(r.body.assets) ? r.body.assets : []
    const exeAsset = assets.find((a) => String(a?.name || '').toLowerCase() === 'yt-dlp.exe')
    assetUrl = exeAsset?.browser_download_url || null
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }

  if (!latestTag || !assetUrl) return { ok: false, error: 'yt-dlp release asset not found' }
  if (currentVersion && currentVersion === latestTag && fs.existsSync(exePath)) return { ok: true, upToDate: true, version: currentVersion, path: exePath }

  try {
    await httpsDownloadToFile(assetUrl, exePath, {}, 60000)
    try { fs.chmodSync(exePath, 0o755) } catch {}
    writeTextSafe(verPath, latestTag)
    return { ok: true, updated: true, version: latestTag, path: exePath }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

async function getYtDlpInfo() {
  const managed = getManagedYtDlpPaths()
  const managedVersion = managed?.verPath ? readTextSafe(managed.verPath) : null
  const managedExists = Boolean(managed?.exePath && fs.existsSync(managed.exePath))
  const resolved = await resolveYtDlpBinary()
  let resolvedVersion = null
  if (resolved) {
    try {
      resolvedVersion = await new Promise((resolve) => {
        execFile(resolved, ['--version'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
          if (err) return resolve(null)
          resolve(String(stdout || '').trim() || null)
        })
      })
    } catch {}
  }
  return {
    ok: true,
    managed: {
      exists: managedExists,
      path: managed?.exePath || null,
      version: managedVersion,
    },
    resolved: {
      path: resolved || null,
      version: resolvedVersion,
    },
  }
}

function cleanupProxyTokens() {
  const now = Date.now()
  for (const [token, entry] of _proxyUrlMap.entries()) {
    if (!entry || entry.expiresAt <= now) _proxyUrlMap.delete(token)
  }
}

function getProxyTokenUrl(token) {
  const entry = _proxyUrlMap.get(token)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    _proxyUrlMap.delete(token)
    return null
  }
  return entry.url
}

function pipeProxyStream(targetUrl, req, res, depth = 0) {
  if (depth > 5) {
    res.writeHead(508)
    res.end()
    return
  }
  try {
    const target = new URL(targetUrl)
    const isHttps = target.protocol === 'https:'
    const lib = isHttps ? https : http
    const options = {
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      method: req.method || 'GET',
      headers: buildProxyHeaders(target, req.headers['range'])
    }
    const proxyReq = lib.request(options, (proxyRes) => {
      const status = Number(proxyRes.statusCode || 0)
      try {
        console.log('[proxy]', req.method || 'GET', target.hostname, status, proxyRes.headers['content-type'] || '')
      } catch {}
      if (status >= 300 && status < 400 && proxyRes.headers.location) {
        const nextUrl = new URL(proxyRes.headers.location, target).toString()
        proxyRes.resume()
        return pipeProxyStream(nextUrl, req, res, depth + 1)
      }

      const headers = {
        'Content-Type': proxyRes.headers['content-type'] || 'audio/mpeg',
        'Accept-Ranges': proxyRes.headers['accept-ranges'] || 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      }
      if (proxyRes.headers['content-length']) headers['Content-Length'] = proxyRes.headers['content-length']
      if (proxyRes.headers['content-range']) headers['Content-Range'] = proxyRes.headers['content-range']
      res.writeHead(status || 200, headers)
      proxyRes.pipe(res)
    })
    proxyReq.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    proxyReq.end()
  } catch {
    if (!res.headersSent) res.writeHead(500)
    res.end()
  }
}

function startProxyServer() {
  _proxyServer = http.createServer((req, res) => {
    cleanupProxyTokens()
    let targetUrl = _proxyCurrentUrl
    try {
      const parsed = new URL(req.url || '/', `http://127.0.0.1:${_proxyPort}`)
      const token = parsed.searchParams.get('t')
      if (token) targetUrl = getProxyTokenUrl(token) || targetUrl
    } catch {}
    if (!targetUrl) { res.writeHead(404); res.end(); return }
    pipeProxyStream(targetUrl, req, res, 0)
  })
  _proxyServer.listen(_proxyPort, '127.0.0.1', () => {
    console.log(`Audio proxy started on port ${_proxyPort}`)
  })
  _proxyServer.on('error', () => {
    _proxyPort++
    startProxyServer()
  })
}

function buildProxyHeaders(targetUrl, rangeHeader) {
  const host = String(targetUrl.hostname || '').toLowerCase()
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Encoding': 'identity',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.7,en;q=0.6',
    'DNT': '1',
    'Connection': 'keep-alive',
  }
  if (rangeHeader) headers.Range = rangeHeader

  if (host.includes('googlevideo.com') || host.includes('youtube.com') || host.includes('ytimg.com')) {
    headers.Origin = 'https://www.youtube.com'
    headers.Referer = 'https://www.youtube.com/'
  } else if (host.includes('soundcloud.com') || host.includes('sndcdn.com')) {
    headers.Origin = 'https://soundcloud.com'
    headers.Referer = 'https://soundcloud.com/'
  } else if (host.includes('vk.com') || host.includes('vk-cdn.net')) {
    headers.Origin = 'https://vk.com'
    headers.Referer = 'https://vk.com/'
  } else {
    // Some mirrors reject anonymous/file:// clients without an origin/referrer.
    const origin = `${String(targetUrl.protocol || 'https:')}//${String(targetUrl.host || host)}`
    headers.Origin = origin
    headers.Referer = origin + '/'
  }

  return headers
}

function headOrRangeProbe(targetUrl, rangeHeader = 'bytes=0-0') {
  return new Promise((resolve) => {
    try {
      const target = new URL(targetUrl)
      const isHttps = target.protocol === 'https:'
      const lib = isHttps ? https : http
      const headers = buildProxyHeaders(target, rangeHeader)
      const options = {
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: target.pathname + target.search,
        method: 'GET',
        headers
      }
      const r = lib.request(options, (resp) => {
        resp.resume()
        resolve({
          ok: true,
          status: resp.statusCode || 0,
          headers: {
            'content-type': resp.headers['content-type'] || null,
            'content-length': resp.headers['content-length'] || null,
            'content-range': resp.headers['content-range'] || null,
            'accept-ranges': resp.headers['accept-ranges'] || null,
          }
        })
      })
      r.on('error', (e) => resolve({ ok: false, error: e?.message || String(e) }))
      r.setTimeout(10000, () => { r.destroy(new Error('timeout')) })
      r.end()
    } catch (e) {
      resolve({ ok: false, error: e?.message || String(e) })
    }
  })
}

function probeStreamWithRedirects(targetUrl, rangeHeader = 'bytes=0-0', depth = 0) {
  return new Promise((resolve) => {
    if (depth > 5) return resolve({ ok: false, status: 508, error: 'too many redirects' })
    try {
      const target = new URL(targetUrl)
      const isHttps = target.protocol === 'https:'
      const lib = isHttps ? https : http
      const options = {
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: target.pathname + target.search,
        method: 'GET',
        headers: buildProxyHeaders(target, rangeHeader),
      }
      const r = lib.request(options, (resp) => {
        const status = Number(resp.statusCode || 0)
        const location = resp.headers.location
        const contentType = String(resp.headers['content-type'] || '')
        resp.resume()

        if (status >= 300 && status < 400 && location) {
          try {
            const next = new URL(location, target).toString()
            return resolve(probeStreamWithRedirects(next, rangeHeader, depth + 1))
          } catch {
            return resolve({ ok: false, status, error: 'bad redirect location', contentType })
          }
        }
        const itagRaw = target.searchParams.get('itag')
        const itag = Number(itagRaw || 0)
        // YouTube sometimes serves pure audio tracks with video/* content-type.
        const audioItags = new Set([139, 140, 141, 171, 172, 249, 250, 251, 599, 600])
        const isAudioByType = /^audio\//i.test(contentType) || contentType.includes('octet-stream')
        const isAudioByItag = audioItags.has(itag)
        const isVideoContainerForAudio = /^video\/(mp4|webm)/i.test(contentType)
        const isAudio = Boolean(isAudioByType || (isAudioByItag && (isVideoContainerForAudio || !contentType)))
        const goodStatus = status === 200 || status === 206
        resolve({
          ok: Boolean(goodStatus && isAudio),
          status,
          contentType,
          isAudio,
          goodStatus,
        })
      })
      r.on('error', (e) => resolve({ ok: false, status: 0, error: e?.message || String(e) }))
      r.setTimeout(10000, () => { r.destroy(new Error('timeout')) })
      r.end()
    } catch (e) {
      resolve({ ok: false, status: 0, error: e?.message || String(e) })
    }
  })
}

ipcMain.handle('proxy-set-url', (e, url) => {
  try { console.log('[proxy-set-url]', String(url || '').slice(0, 180)) } catch {}
  _proxyCurrentUrl = url
  cleanupProxyTokens()
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  _proxyUrlMap.set(token, { url, expiresAt: Date.now() + PROXY_TOKEN_TTL_MS })
  return `http://127.0.0.1:${_proxyPort}/stream?t=${encodeURIComponent(token)}`
})

ipcMain.handle('probe-stream-url', async (e, { url }) => {
  try {
    if (!url || !/^https?:\/\//i.test(String(url))) return { ok: false, error: 'bad url' }
    const r = await headOrRangeProbe(String(url), 'bytes=0-0')
    try { console.log('[probe-stream-url]', r?.status || 0, String(url).slice(0, 140)) } catch {}
    return r
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
})

ipcMain.handle('app-version', async () => {
  try {
    return { ok: true, version: app.getVersion() }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
})

let _discordRpcClient = null
let _discordRpcReady = false
let _discordRpcClientId = null
let _mainWindow = null

function getDiscordRpcLib() {
  try {
    return require('discord-rpc')
  } catch {
    return null
  }
}

ipcMain.handle('discord-rpc-connect', async (e, { clientId }) => {
  const rpc = getDiscordRpcLib()
  if (!rpc) return { ok: false, error: 'discord-rpc dependency is not installed' }
  const safeClientId = String(clientId || '').trim()
  if (!safeClientId) return { ok: false, error: 'clientId required' }
  try {
    rpc.register(safeClientId)
    if (_discordRpcClient) {
      try { _discordRpcClient.clearActivity() } catch {}
      try { _discordRpcClient.destroy() } catch {}
    }
    _discordRpcClient = new rpc.Client({ transport: 'ipc' })
    _discordRpcReady = false
    _discordRpcClientId = safeClientId
    _discordRpcClient.on('ready', () => { _discordRpcReady = true })
    _discordRpcClient.on('ACTIVITY_JOIN', (secret) => {
      const safeSecret = String(secret || '').trim()
      if (!safeSecret) return
      try { _mainWindow?.webContents?.send('discord-join-secret', safeSecret) } catch {}
    })
    await _discordRpcClient.login({ clientId: safeClientId })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
})

ipcMain.handle('discord-rpc-update', async (e, payload = {}) => {
  if (!_discordRpcClient || !_discordRpcReady) return { ok: false, error: 'Discord RPC is not connected' }
  try {
    await _discordRpcClient.setActivity({
      details: String(payload?.details || 'Listening in Flow').slice(0, 128),
      state: String(payload?.state || '').slice(0, 128),
      largeImageKey: String(payload?.largeImageKey || 'flow'),
      largeImageText: String(payload?.largeImageText || 'Flow'),
      smallImageKey: String(payload?.smallImageKey || 'music'),
      smallImageText: String(payload?.smallImageText || 'Flow'),
      buttons: Array.isArray(payload?.buttons) ? payload.buttons.slice(0, 2) : undefined,
      partySize: Number(payload?.partySize) || undefined,
      partyMax: Number(payload?.partyMax) || undefined,
      joinSecret: payload?.joinSecret ? String(payload.joinSecret).slice(0, 128) : undefined,
      startTimestamp: payload?.startTimestamp || undefined,
      instance: false,
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
})

ipcMain.handle('discord-rpc-clear', async () => {
  if (!_discordRpcClient) return { ok: true }
  try {
    await _discordRpcClient.clearActivity()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
})

function buildLastFmSignature(params = {}, sharedSecret = '') {
  const keys = Object.keys(params).sort()
  const base = keys.map((k) => `${k}${params[k]}`).join('') + String(sharedSecret || '')
  return crypto.createHash('md5').update(base).digest('hex')
}

ipcMain.handle('lastfm-now-playing', async (e, payload = {}) => {
  try {
    const apiKey = String(payload?.apiKey || '').trim()
    const sharedSecret = String(payload?.sharedSecret || '').trim()
    const sessionKey = String(payload?.sessionKey || '').trim()
    if (!apiKey || !sharedSecret || !sessionKey) return { ok: false, error: 'last.fm credentials are required' }
    const artist = String(payload?.artist || '').trim()
    const track = String(payload?.track || '').trim()
    if (!artist || !track) return { ok: false, error: 'artist and track are required' }
    const params = {
      method: 'track.updateNowPlaying',
      api_key: apiKey,
      sk: sessionKey,
      artist,
      track,
      format: 'json',
    }
    const album = String(payload?.album || '').trim()
    if (album) params.album = album
    params.api_sig = buildLastFmSignature(params, sharedSecret)
    const r = await httpsPostFormJson('ws.audioscrobbler.com', '/2.0/', params, {}, 12000)
    if (r.status !== 200) return { ok: false, error: `last.fm status ${r.status}` }
    return { ok: true, body: r.body || null }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
})

ipcMain.handle('lastfm-scrobble', async (e, payload = {}) => {
  try {
    const apiKey = String(payload?.apiKey || '').trim()
    const sharedSecret = String(payload?.sharedSecret || '').trim()
    const sessionKey = String(payload?.sessionKey || '').trim()
    if (!apiKey || !sharedSecret || !sessionKey) return { ok: false, error: 'last.fm credentials are required' }
    const artist = String(payload?.artist || '').trim()
    const track = String(payload?.track || '').trim()
    const timestamp = Number(payload?.timestamp || Math.floor(Date.now() / 1000))
    if (!artist || !track || !timestamp) return { ok: false, error: 'artist, track and timestamp are required' }
    const params = {
      method: 'track.scrobble',
      api_key: apiKey,
      sk: sessionKey,
      'artist[0]': artist,
      'track[0]': track,
      'timestamp[0]': String(timestamp),
      format: 'json',
    }
    const album = String(payload?.album || '').trim()
    if (album) params['album[0]'] = album
    params.api_sig = buildLastFmSignature(params, sharedSecret)
    const r = await httpsPostFormJson('ws.audioscrobbler.com', '/2.0/', params, {}, 12000)
    if (r.status !== 200) return { ok: false, error: `last.fm status ${r.status}` }
    return { ok: true, body: r.body || null }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
})


function createWindow() {
  const win = new BrowserWindow({
    width: 1200, height: 800, minWidth: 900, minHeight: 600,
    frame: false, backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true
    },
    icon: path.join(__dirname, 'assets/icon.ico')
  })
  win.loadFile('index.html')
  _mainWindow = win
  win.webContents.once('did-finish-load', () => { _safeGpuRestartRequested = false })
  win.on('unresponsive', () => relaunchInSafeGpuMode('window-unresponsive'))
  win.webContents.on('render-process-gone', (event, details) => {
    const reason = String(details?.reason || 'render-process-gone')
    if (reason !== 'clean-exit') relaunchInSafeGpuMode(reason)
  })
  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    if (Number(errorCode) === -3) return // aborted navigation
    relaunchInSafeGpuMode(`did-fail-load:${errorCode}:${errorDescription || validatedURL || ''}`)
  })
  win.on('closed', () => {
    if (_mainWindow === win) _mainWindow = null
  })
}

app.whenReady().then(() => {
  startProxyServer()
  checkAndDownloadYtDlp()
    .then((r) => {
      if (r?.ok && r?.updated) console.log('yt-dlp updated:', r.version)
    })
    .catch(() => {})
  // Warm yt-dlp path cache once at startup to avoid first-play delay.
  resolveYtDlpBinary().catch(() => {})

  // Р Р°Р·СЂРµС€Р°РµРј РІРѕСЃРїСЂРѕРёР·РІРµРґРµРЅРёРµ СЃ localhost (РЅР°С€ РїСЂРѕРєСЃРё)
  const { session } = require('electron')
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Access-Control-Allow-Origin': ['*'],
        'Access-Control-Allow-Headers': ['*'],
      }
    })
  })

  createWindow()
})

app.on('before-quit', () => {
  if (_proxyServer) _proxyServer.close()
  if (_discordRpcClient) {
    try { _discordRpcClient.clearActivity() } catch {}
    try { _discordRpcClient.destroy() } catch {}
  }
})
ipcMain.on('window-minimize', (e) => BrowserWindow.fromWebContents(e.sender).minimize())
ipcMain.on('window-close', (e) => BrowserWindow.fromWebContents(e.sender).close())
ipcMain.on('open-external', (e, url) => shell.openExternal(url))

// в”Ђв”Ђв”Ђ HELPERS в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

function httpsGetRaw(hostname, urlPath, headers = {}, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path: urlPath, method: 'GET', headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try {
          const loc = new URL(res.headers.location)
          return httpsGetRaw(loc.hostname, loc.pathname + loc.search, headers, timeout).then(resolve).catch(reject)
        } catch {}
      }
      let data = ''
      res.on('data', d => data += d)
      res.on('end', () => resolve({ status: res.statusCode, raw: data }))
    })
    req.on('error', reject)
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')) })
    req.end()
  })
}

async function httpsGetJson(hostname, urlPath, headers = {}, timeout = 10000) {
  const r = await httpsGetRaw(hostname, urlPath, headers, timeout)
  try { return { status: r.status, body: JSON.parse(r.raw) } }
  catch { return { status: r.status, body: null } }
}

function httpsPostFormJson(hostname, urlPath, form, headers = {}, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(form).toString()
    const req = https.request({
      hostname,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        ...headers
      }
    }, (res) => {
      let raw = ''
      res.on('data', (d) => { raw += d })
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 0, body: JSON.parse(raw || '{}') })
        } catch {
          resolve({ status: res.statusCode || 0, body: null, raw })
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')) })
    req.write(body)
    req.end()
  })
}

function getYtDlpCandidates() {
  const local = process.env.LOCALAPPDATA || ''
  const managed = (() => {
    try {
      const p = getManagedYtDlpPaths()
      return p?.exePath && fs.existsSync(p.exePath) ? p.exePath : null
    } catch { return null }
  })()
  return [
    managed,
    'yt-dlp',
    'yt-dlp.exe',
    path.join(__dirname, 'tools', 'yt-dlp.exe'),
    local ? path.join(local, 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe') : null,
    local ? path.join(local, 'Programs', 'Parabolic', 'yt-dlp.exe') : null,
  ].filter(Boolean)
}

function resolveYtDlpBinary(forceRefresh = false) {
  if (!forceRefresh && _resolvedYtDlpBinary) {
    if (!_resolvedYtDlpBinary.includes('\\') || fs.existsSync(_resolvedYtDlpBinary)) {
      return Promise.resolve(_resolvedYtDlpBinary)
    }
    _resolvedYtDlpBinary = null
  }

  const now = Date.now()
  if (!forceRefresh && now - _lastYtDlpResolveAt < YTDLP_RESOLVE_CACHE_MS) {
    return Promise.resolve(_resolvedYtDlpBinary || null)
  }

  if (_ytDlpResolveInFlight) return _ytDlpResolveInFlight

  _ytDlpResolveInFlight = new Promise(async (resolve) => {
    const candidates = getYtDlpCandidates()
    for (const bin of candidates) {
      try {
        if (bin.includes('\\') && !fs.existsSync(bin)) continue
        await new Promise((res, rej) => {
          execFile(bin, ['--version'], { timeout: 4500, windowsHide: true }, (err, stdout) => {
            if (err) return rej(err)
            if (!String(stdout || '').trim()) return rej(new Error('empty version'))
            res()
          })
        })
        _resolvedYtDlpBinary = bin
        _lastYtDlpResolveAt = Date.now()
        _ytDlpResolveInFlight = null
        return resolve(bin)
      } catch {}
    }
    _resolvedYtDlpBinary = null
    _lastYtDlpResolveAt = Date.now()
    _ytDlpResolveInFlight = null
    resolve(null)
  })

  return _ytDlpResolveInFlight
}

function tryYtDlpStream(videoId, opts = {}) {
  return new Promise(async (resolve) => {
    const allowCookies = Boolean(opts.allowCookies)
    const quickOnly = Boolean(opts.quickOnly)
    const cmdTimeout = Number(opts.timeoutMs || 12000)
    const includePython = quickOnly ? false : (opts.includePython !== false)
    const maxBinCandidates = Number(opts.maxBinCandidates || (quickOnly ? 1 : 4))
    const returnMeta = Boolean(opts.returnMeta)
    let lastErrText = ''
    const targetUrl = `https://www.youtube.com/watch?v=${videoId}`
    const baseArgs = [
      '-f', 'bestaudio/best',
      '--no-warnings',
      '--no-playlist',
      '--skip-download',
      '--force-ipv4',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      '--referer', 'https://www.youtube.com/',
      '--extractor-args', 'youtube:player_client=web,android',
      '--js-runtimes', 'node,deno,bun,quickjs',
      '--socket-timeout', '8',
      '-g',
      targetUrl
    ]

    const preferred = await resolveYtDlpBinary()
    const candidates = (preferred ? [preferred, ...getYtDlpCandidates().filter(x => x !== preferred)] : getYtDlpCandidates())
      .slice(0, Math.max(1, maxBinCandidates))
    const pythonCandidates = includePython ? getPythonCandidates().slice(0, 2) : []

    const cookieProfiles = allowCookies
      ? (quickOnly ? [null] : [null, 'firefox', 'edge', 'chrome'])
      : [null]
    const withCookieArgs = (profile) => {
      if (!profile) return [...baseArgs]
      return ['--cookies-from-browser', profile, ...baseArgs]
    }

    const runOne = (bin, args) => new Promise((res) => {
      execFile(bin, args, { timeout: cmdTimeout, windowsHide: true }, (err, stdout, stderr) => {
        if (err || !stdout) {
          const text = String(stderr || err?.message || '').trim()
          if (text) lastErrText = text
          return res(null)
        }
        const url = String(stdout)
          .split(/\r?\n/)
          .map(s => s.trim())
          .find(s => s.startsWith('http'))
        res(url || null)
      })
    })

    const runPythonModule = (pyBin, args) => new Promise((res) => {
      const pyArgs = (pyBin === 'py' || pyBin.toLowerCase().endsWith('\\py.exe'))
        ? ['-3', '-m', 'yt_dlp', ...args]
        : ['-m', 'yt_dlp', ...args]
      execFile(pyBin, pyArgs, { timeout: cmdTimeout, windowsHide: true }, (err, stdout, stderr) => {
        if (err || !stdout) {
          const text = String(stderr || err?.message || '').trim()
          if (text) lastErrText = text
          return res(null)
        }
        const url = String(stdout)
          .split(/\r?\n/)
          .map(s => s.trim())
          .find(s => s.startsWith('http'))
        res(url || null)
      })
    })

    for (const profile of cookieProfiles) {
      const args = withCookieArgs(profile)
      for (const bin of candidates) {
        try {
          if (bin.includes('\\') && !fs.existsSync(bin)) continue
          const url = await runOne(bin, args)
          if (url) return resolve(url)
        } catch {}
      }

      for (const pyBin of pythonCandidates) {
        try {
          if (pyBin.includes('\\') && !fs.existsSync(pyBin)) continue
          const url = await runPythonModule(pyBin, args)
          if (url) return resolve(url)
        } catch {}
      }
    }
    if (returnMeta) {
      const t = String(lastErrText || '').toLowerCase()
      const ageRestricted = t.includes('sign in to confirm your age') || t.includes('age-restricted')
      const botCheck = t.includes('sign in to confirm you’re not a bot') || t.includes("sign in to confirm you're not a bot")
      return resolve({ url: null, ageRestricted, botCheck, errorText: lastErrText || null })
    }
    resolve(null)
  })
}

function searchYouTubeViaYtDlp(query, limit = 20) {
  return new Promise(async (resolve) => {
    try {
      const q = String(query || '').trim()
      if (!q) return resolve([])
      const bin = await resolveYtDlpBinary()
      if (!bin) return resolve([])
      const count = Math.max(1, Math.min(30, Number(limit || 20)))
      const args = [
        '--no-warnings',
        '--skip-download',
        '--flat-playlist',
        '--dump-single-json',
        '--default-search', 'ytsearch',
        `ytsearch${count}:${q}`
      ]
      execFile(bin, args, { timeout: 22000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err || !stdout) return resolve([])
        try {
          const json = JSON.parse(String(stdout))
          const entries = Array.isArray(json?.entries) ? json.entries : []
          const tracks = entries.map((v) => {
            const id = String(v?.id || '')
            const thumbs = Array.isArray(v?.thumbnails) ? v.thumbnails : []
            const cover = thumbs.length ? (thumbs[thumbs.length - 1]?.url || thumbs[0]?.url || null) : null
            return {
              title: v?.title || 'Без названия',
              artist: v?.uploader || v?.channel || 'YouTube',
              url: null,
              ytId: id,
              cover,
              bg: 'linear-gradient(135deg,#ff0000,#cc0000)',
              source: 'youtube',
              id,
              duration: Number(v?.duration || 0) || null
            }
          }).filter((t) => t.ytId)
          resolve(tracks)
        } catch {
          resolve([])
        }
      })
    } catch {
      resolve([])
    }
  })
}

ipcMain.handle('youtube-engine-status', async () => {
  const bin = await resolveYtDlpBinary()
  return {
    ok: true,
    ytdlp: Boolean(bin),
    ytdlpPath: bin || null,
    path: process.env.PATH || ''
  }
})

ipcMain.handle('ytdlp-info', async () => {
  try {
    return await getYtDlpInfo()
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
})

ipcMain.handle('ytdlp-update', async () => {
  try {
    const r = await checkAndDownloadYtDlp()
    const info = await getYtDlpInfo().catch(() => null)
    return { ok: true, result: r, info }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
})

// в”Ђв”Ђв”Ђ VK: РїРѕР»СѓС‡РёС‚СЊ С‚РѕРєРµРЅ в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
// Kate Mobile Рё РґСЂСѓРіРёРµ РєР»РёРµРЅС‚С‹ вЂ” РµРґРёРЅСЃС‚РІРµРЅРЅС‹Р№ СЂР°Р±РѕС‡РёР№ СЃРїРѕСЃРѕР± РІ 2026
const VK_CLIENTS = [
  { id: '2685278', secret: 'lxhD8OD7dMsqtXIm5IUY' },  // Kate Mobile
  { id: '3140623', secret: 'VeWdmVclDCtn6ihuP1nt' },  // VK Admin
  { id: '6287487', secret: 'Ms2CD44oBLij0TDbxKhu' },  // VK iPhone
]

function normalizeVkItems(items = []) {
  return (items || []).filter(t => t?.url).map(t => ({
    title: t.title || 'Без названия',
    artist: t.artist || '—',
    url: t.url,
    cover: t.album?.thumb?.photo_300 || null,
    bg: 'linear-gradient(135deg,#4680c2,#5b9bd5)',
    source: 'vk',
    id: String(t.id || '')
  }))
}

function getPythonCandidates() {
  const local = process.env.LOCALAPPDATA || ''
  const candidates = [
    'python',
    'python3',
    'py',
    'C:\\Program Files\\Python312\\python.exe',
    'C:\\Program Files\\Python311\\python.exe',
    'C:\\Program Files\\Python310\\python.exe',
    local ? path.join(local, 'Programs', 'Python', 'Python312', 'python.exe') : null,
    local ? path.join(local, 'Programs', 'Python', 'Python311', 'python.exe') : null,
    local ? path.join(local, 'Programs', 'Python', 'Python310', 'python.exe') : null,
  ].filter(Boolean)
  return [...new Set(candidates)]
}

function probePython(bin) {
  return new Promise((resolve) => {
    const versionArgs = bin.toLowerCase().endsWith('\\py.exe') || bin === 'py' ? ['-3', '-V'] : ['-V']
    execFile(bin, versionArgs, { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: (stderr || err.message || '').trim() || String(err) })
        return
      }
      const text = String(stdout || stderr || '').trim()
      if (/python\\s+\\d+\\.\\d+/i.test(text)) resolve({ ok: true, bin })
      else resolve({ ok: false, error: text || 'version probe failed' })
    })
  })
}

function tryVkSeleniumBridge(query, limit = 20) {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, 'tools', 'vk_cli_search.py')
    if (!fs.existsSync(scriptPath)) {
      resolve({ ok: false, error: 'VK bridge script not found' })
      return
    }

    ;(async () => {
      const candidates = getPythonCandidates()
      let pythonBin = null
      let lastProbeError = ''
      for (const bin of candidates) {
        if (bin.includes('\\') && !fs.existsSync(bin)) continue
        const probe = await probePython(bin)
        if (probe.ok) {
          pythonBin = probe.bin
          break
        }
        lastProbeError = probe.error || lastProbeError
      }

      if (!pythonBin) {
        resolve({ ok: false, error: `python runtime unavailable: ${lastProbeError || 'not found in PATH'}` })
        return
      }

      const args = [scriptPath, '--query', String(query || ''), '--limit', String(limit || 20)]
      execFile(pythonBin, args, { timeout: 300000, windowsHide: false, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const details = [stderr?.trim(), err.message].filter(Boolean).join(' | ')
          resolve({ ok: false, error: details || 'python execution failed' })
          return
        }
        const rawOut = String(stdout || '').trim()
        if (!rawOut) {
          resolve({ ok: false, error: 'empty bridge response' })
          return
        }
        try {
          const parsed = JSON.parse(rawOut)
          if (parsed?.ok && Array.isArray(parsed.tracks)) {
            resolve({ ok: true, tracks: parsed.tracks })
            return
          }
          resolve({ ok: false, error: parsed?.error || 'bridge returned no tracks' })
        } catch {
          resolve({ ok: false, error: rawOut.slice(-500) })
        }
      })
    })().catch((e) => resolve({ ok: false, error: e?.message || String(e) }))
  })
}

function tryVkPlaylistBridge(playlistUrl, limit = 260) {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, 'tools', 'vk_cli_search.py')
    if (!fs.existsSync(scriptPath)) {
      resolve({ ok: false, error: 'VK bridge script not found' })
      return
    }
    ;(async () => {
      const candidates = getPythonCandidates()
      let pythonBin = null
      let lastProbeError = ''
      for (const bin of candidates) {
        if (bin.includes('\\') && !fs.existsSync(bin)) continue
        const probe = await probePython(bin)
        if (probe.ok) {
          pythonBin = probe.bin
          break
        }
        lastProbeError = probe.error || lastProbeError
      }
      if (!pythonBin) {
        resolve({ ok: false, error: `python runtime unavailable: ${lastProbeError || 'not found in PATH'}` })
        return
      }
      const args = ['tools/vk_cli_search.py', '--playlist-url', String(playlistUrl || ''), '--limit', String(limit || 260)]
      execFile(pythonBin, args, { cwd: __dirname, timeout: 300000, windowsHide: false, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const details = [stderr?.trim(), err.message].filter(Boolean).join(' | ')
          resolve({ ok: false, error: details || 'python execution failed' })
          return
        }
        const rawOut = String(stdout || '').trim()
        if (!rawOut) {
          resolve({ ok: false, error: 'empty bridge response' })
          return
        }
        try {
          const parsed = JSON.parse(rawOut)
          if (parsed?.ok && Array.isArray(parsed.tracks)) {
            resolve({ ok: true, tracks: parsed.tracks })
            return
          }
          resolve({ ok: false, error: parsed?.error || 'bridge returned no tracks' })
        } catch {
          resolve({ ok: false, error: rawOut.slice(-500) })
        }
      })
    })().catch((e) => resolve({ ok: false, error: e?.message || String(e) }))
  })
}

function extractVkTokenFromUrl(rawUrl) {
  const url = String(rawUrl || '')
  const hash = url.includes('#') ? url.slice(url.indexOf('#') + 1) : ''
  if (!hash) return null
  const params = new URLSearchParams(hash)
  const token = String(params.get('access_token') || '').trim()
  if (!token) return null
  const expiresIn = Number(params.get('expires_in') || 0) || 0
  return { token, expiresIn }
}

ipcMain.handle('vk-browser-auth', async () => {
  return await new Promise((resolve) => {
    const clientId = VK_CLIENTS?.[0]?.id || '2685278'
    const authUrl = `https://oauth.vk.com/authorize?client_id=${encodeURIComponent(clientId)}&display=page&redirect_uri=${encodeURIComponent('https://oauth.vk.com/blank.html')}&scope=${encodeURIComponent('audio,offline')}&response_type=token&v=5.131`
    const win = new BrowserWindow({
      width: 520,
      height: 760,
      parent: _mainWindow || undefined,
      modal: Boolean(_mainWindow),
      autoHideMenuBar: true,
      title: 'VK Авторизация',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    let done = false
    const timeoutId = setTimeout(() => finish({ ok: false, error: 'VK browser auth timeout' }), 180000)
    function finish(payload) {
      if (done) return
      done = true
      clearTimeout(timeoutId)
      try { win.destroy() } catch {}
      resolve(payload)
    }
    const onUrl = (nextUrl) => {
      const parsed = extractVkTokenFromUrl(nextUrl)
      if (parsed?.token) finish({ ok: true, token: parsed.token, expiresIn: parsed.expiresIn })
      if (/oauth\.vk\.com\/blank\.html/i.test(String(nextUrl || ''))) {
        try {
          win.webContents.executeJavaScript('location.href').then((href) => {
            const p2 = extractVkTokenFromUrl(href)
            if (p2?.token) finish({ ok: true, token: p2.token, expiresIn: p2.expiresIn })
          }).catch(() => {})
        } catch {}
      }
    }
    win.webContents.on('will-redirect', (event, nextUrl) => onUrl(nextUrl))
    win.webContents.on('will-navigate', (event, nextUrl) => onUrl(nextUrl))
    win.webContents.on('did-navigate', (event, nextUrl) => onUrl(nextUrl))
    win.on('closed', () => finish({ ok: false, error: 'Авторизация отменена' }))
    win.loadURL(authUrl).catch((e) => finish({ ok: false, error: e?.message || String(e) }))
  })
})

ipcMain.handle('vk-get-token', async (e, { login, password }) => {
  for (const client of VK_CLIENTS) {
    try {
      const params = new URLSearchParams({
        grant_type: 'password', client_id: client.id, client_secret: client.secret,
        username: login, password, scope: 'audio,offline', v: '5.131', '2fa_supported': '1'
      })
      const r = await httpsGetJson('oauth.vk.com', '/token?' + params.toString(), {
        'User-Agent': 'VKAndroidApp/5.52-4543 (Android 5.1.1; SDK 22; x86_64; unknown Android SDK built for x86_64; en; 320x480)'
      })
      if (r.body?.access_token) return { ok: true, token: r.body.access_token }
      if (r.body?.error === 'need_validation') return { ok: false, error: 'РќСѓР¶РЅР° 2FA вЂ” РІСЃС‚Р°РІСЊ С‚РѕРєРµРЅ РІСЂСѓС‡РЅСѓСЋ СЃ vkhost.github.io' }
      if (r.body?.error === 'client_id is incorrect') continue
      if (r.body?.error === 'invalid_client') continue
    } catch { continue }
  }
  return { ok: false, error: 'РќРµ СѓРґР°Р»РѕСЃСЊ РІРѕР№С‚Рё. РџРѕР»СѓС‡Рё С‚РѕРєРµРЅ РІСЂСѓС‡РЅСѓСЋ РЅР° vkhost.github.io Рё РІСЃС‚Р°РІСЊ РІ РїРѕР»Рµ РЅРёР¶Рµ' }
})

// в”Ђв”Ђв”Ђ VK: РїРѕРёСЃРє Р°СѓРґРёРѕ в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
ipcMain.handle('vk-search', async (e, { q, token }) => {
  if (token) {
    const params = new URLSearchParams({ q, access_token: token, v: '5.131', count: '20', auto_complete: '1' })
    const r = await httpsGetJson('api.vk.com', '/method/audio.search?' + params.toString(), {
      'User-Agent': 'VKAndroidApp/5.52-4543 (Android 5.1.1; SDK 22; x86_64; unknown Android SDK built for x86_64; en; 320x480)'
    })
    if (r.body && !r.body.error) return normalizeVkItems(r.body.response?.items || [])
    if (r.body?.error) {
      const c = r.body.error.error_code
      if (c !== 5 && c !== 15) throw new Error('VK: ' + (r.body.error.error_msg || 'unknown error'))
    }
  }

  const bridge = await tryVkSeleniumBridge(q, 20)
  if (bridge.ok) return normalizeVkItems(bridge.tracks)

  throw new Error('VK: ' + (bridge.error || 'browser fallback failed'))
})

ipcMain.handle('yandex-search', async (e, { q, token }) => {
  const r = await httpsGetJson('api.music.yandex.net', `/search?text=${encodeURIComponent(q)}&type=track&page=0`, {
    'Authorization': `OAuth ${token}`, 'X-Yandex-Music-Client': 'WindowsPhone/3.20', 'User-Agent': 'Windows 10'
  })
  if (!r.body) throw new Error('РЇРЅРґРµРєСЃ: РїСѓСЃС‚РѕР№ РѕС‚РІРµС‚')
  return (r.body.result?.tracks?.results || []).map(t => ({
    title: t.title || 'Р‘РµР· РЅР°Р·РІР°РЅРёСЏ',
    artist: t.artists?.map(a => a.name).join(', ') || 'вЂ”',
    url: null,
    cover: t.coverUri ? 'https://' + t.coverUri.replace('%%', '300x300') : null,
    bg: 'linear-gradient(135deg,#fc3f1d,#ff6534)', source: 'yandex', id: String(t.id)
  }))
})

async function fetchVkPlaylistFromFlowServer(serverBaseUrl, link, token = '') {
  let base = String(serverBaseUrl || '').trim()
  if (!base) return null
  if (!/^https?:\/\//i.test(base)) base = `http://${base}`
  base = base.replace(/\/+$/, '').replace(/\/health$/i, '')
  if (/^https:\/\/85\.239\.34\.229(?::8787)?$/i.test(base)) base = base.replace(/^https:/i, 'http:')
  const rsp = await axios.post(`${base}/vk/playlist`, {
    url: String(link || '').trim(),
    token: String(token || '').trim(),
  }, {
    timeout: 30000,
    maxBodyLength: 256 * 1024,
    validateStatus: () => true,
    headers: { 'Content-Type': 'application/json' },
  })
  const body = rsp?.data || {}
  if (!body?.ok) throw new Error(body?.error || `server status ${rsp?.status || 0}`)
  const tracks = Array.isArray(body.tracks)
    ? body.tracks.map((t) => ({
      title: t?.title || null,
      artist: t?.artist || '—',
      duration: Number(t?.duration || 0) || null,
      original_id: t?.original_id || t?.originalId || null,
    })).filter((t) => t.title)
    : []
  if (!tracks.length) throw new Error('server returned empty VK playlist')
  return {
    ok: true,
    service: 'vk',
    name: String(body.name || 'VK Playlist'),
    tracks,
    via: 'flow-vk-server',
  }
}

ipcMain.handle('import-playlist-link', async (e, { url, tokens = {} }) => {
  const link = String(url || '').trim()
  if (!link) return { ok: false, error: 'empty url' }

  const vkRef = parseVkPlaylistRef(link)
  if (vkRef) {
    const vkToken = String(tokens?.vk || '').trim()
    const serverBaseUrl = String(tokens?.serverBaseUrl || '').trim()
    let apiErr = null
    let serverErr = null
    let bridgeErr = null
    if (serverBaseUrl) {
      try {
        const fromServer = await fetchVkPlaylistFromFlowServer(serverBaseUrl, link, vkToken)
        if (fromServer?.tracks?.length) return fromServer
      } catch (err) {
        serverErr = err
      }
      return { ok: false, error: 'VK import server: ' + (serverErr?.message || 'server returned empty VK playlist') }
    }
    try {
      if (vkToken) {
        // Primary modern method for VK playlists.
        const pById = new URLSearchParams({
          owner_id: String(vkRef.ownerId),
          playlist_id: String(vkRef.albumId),
          access_token: vkToken,
          v: '5.131',
        })
        if (vkRef.accessKey) pById.set('access_key', String(vkRef.accessKey))
        const byId = await httpsGetJson('api.vk.com', '/method/audio.getPlaylistById?' + pById.toString(), {
          'User-Agent': 'VKAndroidApp/5.52-4543 (Android 5.1.1; SDK 22; x86_64; unknown Android SDK built for x86_64; en; 320x480)'
        }, 15000)
        if (!byId?.body?.error) {
          const r0 = Array.isArray(byId?.body?.response) ? byId.body.response[0] : (byId?.body?.response || {})
          const rawRows = Array.isArray(r0?.audios) ? r0.audios
            : (Array.isArray(r0?.list) ? r0.list : (Array.isArray(r0?.items) ? r0.items : []))
          const outById = rawRows.map((t) => ({
            title: t?.title || null,
            artist: t?.artist || (Array.isArray(t?.main_artists) ? t.main_artists.map((a) => a?.name).filter(Boolean).join(', ') : '—'),
            duration: Number(t?.duration || 0) || null,
            original_id: t?.owner_id && t?.id ? `${t.owner_id}_${t.id}` : (t?.id || null),
          })).filter((t) => t.title)
          if (outById.length) {
            const plName = String(r0?.title || 'VK Playlist')
            return { ok: true, service: 'vk', name: plName, tracks: outById }
          }
        }
        const params = new URLSearchParams({
          owner_id: String(vkRef.ownerId),
          album_id: String(vkRef.albumId),
          access_token: vkToken,
          v: '5.131',
          count: '600'
        })
        if (vkRef.accessKey) params.set('access_key', String(vkRef.accessKey))
        const r = await httpsGetJson('api.vk.com', '/method/audio.get?' + params.toString(), {
          'User-Agent': 'VKAndroidApp/5.52-4543 (Android 5.1.1; SDK 22; x86_64; unknown Android SDK built for x86_64; en; 320x480)'
        }, 15000)
        if (r?.body?.error) throw new Error(r.body.error.error_msg || 'VK API error')
        const items = Array.isArray(r?.body?.response?.items) ? r.body.response.items : []
        const out = items.map((t) => ({
          title: t?.title || null,
          artist: t?.artist || '—',
          duration: Number(t?.duration || 0) || null,
          original_id: t?.owner_id && t?.id ? `${t.owner_id}_${t.id}` : (t?.id || null),
        })).filter((t) => t.title)
        if (out.length) return { ok: true, service: 'vk', name: 'VK Playlist', tracks: out }
      }
    } catch (err) {
      apiErr = err
    }
    try {
      const openTracks = await fetchVkPlaylistMetaWithoutToken(link, vkRef)
      if (Array.isArray(openTracks) && openTracks.length) {
        return { ok: true, service: 'vk', name: 'VK Playlist', tracks: openTracks }
      }
    } catch {}
    try {
      const page = await httpGetTextUrl(link, { Referer: 'https://vk.com/' }, 17000)
      const parsed = extractVkPlaylistMetaFromHtml(page?.text || '')
      if (Array.isArray(parsed.tracks) && parsed.tracks.length) {
        return { ok: true, service: 'vk', name: parsed.name || 'VK Playlist', tracks: parsed.tracks }
      }
      const simple = extractVkSimplePairsFromHtml(page?.text || '', 120)
      if (simple.length) return { ok: true, service: 'vk', name: parsed.name || 'VK Playlist', tracks: simple }
    } catch {}
    try {
      const mobileUrl = `https://m.vk.com/audio?act=audio_playlist${vkRef.ownerId}_${vkRef.albumId}`
      const page = await httpGetTextUrl(mobileUrl, { Referer: 'https://vk.com/' }, 17000)
      const parsed = extractVkPlaylistMetaFromHtml(page?.text || '')
      if (Array.isArray(parsed.tracks) && parsed.tracks.length) {
        return { ok: true, service: 'vk', name: parsed.name || 'VK Playlist', tracks: parsed.tracks }
      }
      const simple = extractVkSimplePairsFromHtml(page?.text || '', 120)
      if (simple.length) return { ok: true, service: 'vk', name: parsed.name || 'VK Playlist', tracks: simple }
    } catch {}
    try {
      const bridge = await tryVkPlaylistBridge(link, 260)
      const out = Array.isArray(bridge?.tracks) ? bridge.tracks.map((t) => ({
        title: t?.title || null,
        artist: t?.artist || '—'
      })).filter((t) => t.title) : []
      if (out.length) return { ok: true, service: 'vk', name: 'VK Playlist', tracks: out }
      bridgeErr = bridge?.error || null
    } catch {}
    if (bridgeErr) return { ok: false, error: 'VK import: ' + String(bridgeErr) }
    if (serverErr && apiErr) return { ok: false, error: 'VK import server: ' + (serverErr?.message || String(serverErr)) + ' | local: ' + (apiErr?.message || String(apiErr)) }
    if (apiErr) return { ok: false, error: 'VK import: ' + (apiErr?.message || String(apiErr)) + ' (html fallback failed)' }
    if (serverErr) return { ok: false, error: 'VK import server: ' + (serverErr?.message || String(serverErr)) }
    return { ok: false, error: 'VK import: playlist parse failed (try public playlist or valid VK token)' }
  }

  const spotifyId = parseSpotifyPlaylistId(link)
  if (spotifyId) {
    const spToken = String(tokens?.spotify || '').trim()
    if (!spToken) return { ok: false, error: 'Spotify token required' }
    const headers = { Authorization: `Bearer ${spToken}` }
    try {
      const meta = await httpsGetJsonUrl(`https://api.spotify.com/v1/playlists/${spotifyId}?fields=name`, headers, 12000)
      let next = `https://api.spotify.com/v1/playlists/${spotifyId}/tracks?limit=100`
      const out = []
      while (next && out.length < 600) {
        const r = await httpsGetJsonUrl(next, headers, 16000)
        const items = Array.isArray(r?.body?.items) ? r.body.items : []
        items.forEach((it) => {
          const t = it?.track
          if (!t?.name) return
          out.push({
            title: t.name,
            artist: Array.isArray(t.artists) ? t.artists.map((a) => a?.name).filter(Boolean).join(', ') : '—'
          })
        })
        next = String(r?.body?.next || '') || null
      }
      return { ok: true, service: 'spotify', name: String(meta?.body?.name || 'Spotify Playlist'), tracks: out }
    } catch (err) {
      return { ok: false, error: 'Spotify import: ' + (err?.message || String(err)) }
    }
  }

  const yRef = parseYandexPlaylistRef(link)
  if (yRef) {
    const ymToken = String(tokens?.yandex || '').trim()
    if (!ymToken) return { ok: false, error: 'Yandex token required' }
    try {
      const r = await httpsGetJson(
        'api.music.yandex.net',
        `/users/${encodeURIComponent(yRef.user)}/playlists/${encodeURIComponent(yRef.kind)}`,
        { Authorization: `OAuth ${ymToken}`, 'X-Yandex-Music-Client': 'WindowsPhone/3.20', 'User-Agent': 'Windows 10' },
        15000
      )
      const pl = r?.body?.result || {}
      const tracks = Array.isArray(pl?.tracks) ? pl.tracks : []
      const out = tracks.map((row) => {
        const t = row?.track || row
        return {
          title: t?.title || null,
          artist: Array.isArray(t?.artists) ? t.artists.map((a) => a?.name).filter(Boolean).join(', ') : '—'
        }
      }).filter((t) => t.title)
      return { ok: true, service: 'yandex', name: String(pl?.title || 'Yandex Playlist'), tracks: out }
    } catch (err) {
      return { ok: false, error: 'Yandex import: ' + (err?.message || String(err)) }
    }
  }

  return { ok: false, error: 'Unsupported playlist URL' }
})

let _audiusHostCache = { host: null, ts: 0 }
async function getAudiusHost(force = false) {
  const now = Date.now()
  if (!force && _audiusHostCache.host && now - _audiusHostCache.ts < 10 * 60 * 1000) {
    return _audiusHostCache.host
  }
  const r = await httpsGetJsonUrl('https://api.audius.co/')
  const hosts = Array.isArray(r?.body?.data) ? r.body.data.filter(Boolean) : []
  if (!hosts.length) throw new Error('Audius discovery unavailable')
  const host = String(hosts[Math.floor(Math.random() * hosts.length)]).replace(/\/+$/, '')
  _audiusHostCache = { host, ts: now }
  return host
}

ipcMain.handle('audius-search', async (e, { q }) => {
  const query = String(q || '').trim()
  if (!query) return []
  let host = null
  try {
    host = await getAudiusHost(false)
    const p = `/v1/tracks/search?query=${encodeURIComponent(query)}&limit=20&app_name=flow`
    const r = await httpsGetJsonUrl(`${host}${p}`, {}, 12000)
    const items = Array.isArray(r?.body?.data) ? r.body.data : []
    return items.map((t) => {
      const id = String(t?.id || '')
      const cover = t?.artwork?.['480x480'] || t?.artwork?.['1000x1000'] || t?.artwork?.['150x150'] || null
      const stream = id ? `${host}/v1/tracks/${encodeURIComponent(id)}/stream?app_name=flow` : null
      return {
        title: t?.title || 'Без названия',
        artist: t?.user?.name || '—',
        url: stream,
        cover,
        bg: 'linear-gradient(135deg,#2dd4bf,#0ea5e9)',
        source: 'audius',
        id: id || `${t?.title || ''}:${t?.user?.name || ''}`
      }
    }).filter((t) => t.url)
  } catch (err) {
    // Retry once with refreshed discovery host.
    try {
      host = await getAudiusHost(true)
      const p = `/v1/tracks/search?query=${encodeURIComponent(query)}&limit=20&app_name=flow`
      const r = await httpsGetJsonUrl(`${host}${p}`, {}, 12000)
      const items = Array.isArray(r?.body?.data) ? r.body.data : []
      return items.map((t) => {
        const id = String(t?.id || '')
        const cover = t?.artwork?.['480x480'] || t?.artwork?.['1000x1000'] || t?.artwork?.['150x150'] || null
        const stream = id ? `${host}/v1/tracks/${encodeURIComponent(id)}/stream?app_name=flow` : null
        return {
          title: t?.title || 'Без названия',
          artist: t?.user?.name || '—',
          url: stream,
          cover,
          bg: 'linear-gradient(135deg,#2dd4bf,#0ea5e9)',
          source: 'audius',
          id: id || `${t?.title || ''}:${t?.user?.name || ''}`
        }
      }).filter((t) => t.url)
    } catch (e2) {
      throw new Error('Audius: ' + (e2?.message || err?.message || String(err)))
    }
  }
})

// в”Ђв”Ђв”Ђ YOUTUBE (Invidious) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
// РђРєС‚СѓР°Р»СЊРЅС‹Р№ СЃРїРёСЃРѕРє РїРѕ РґР°РЅРЅС‹Рј docs.invidious.io РЅР° Р°РїСЂРµР»СЊ 2026
// РћС„РёС†РёР°Р»СЊРЅРѕ Р¶РёРІС‹С… РёРЅСЃС‚Р°РЅСЃРѕРІ СЃС‚Р°Р»Рѕ РјРµРЅСЊС€Рµ РёР·-Р·Р° РїСЂРѕР±Р»РµРј СЃ YouTube
const INVIDIOUS_INSTANCES = [
  'inv.nadeko.net',          // рџ‡Ёрџ‡± вЂ” РѕСЃРЅРѕРІРЅРѕР№, СЃС‚Р°Р±РёР»СЊРЅС‹Р№
  'yewtu.be',                // рџ‡©рџ‡Є вЂ” СЃС‚Р°Р±РёР»СЊРЅС‹Р№
  'invidious.nerdvpn.de',   // рџ‡єрџ‡¦ вЂ” СЃС‚Р°Р±РёР»СЊРЅС‹Р№
  'inv.thepixora.com',       // рџ‡Ёрџ‡¦
  'yt.chocolatemoo53.com',   // рџ‡єрџ‡ё
]
const YT_PLAYBACK_YTDLP_ONLY = false

let _workingInstance = null
const _ytStreamCache = new Map()
const YT_STREAM_TTL_MS = 12 * 60 * 1000
const YT_FAST_CACHE_TRUST_MS = 2 * 60 * 1000
const _ytStreamInFlight = new Map()

function getCachedYtStream(videoId) {
  const entry = _ytStreamCache.get(String(videoId || ''))
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    _ytStreamCache.delete(String(videoId || ''))
    return null
  }
  return entry
}

function setCachedYtStream(videoId, url, inst) {
  if (!videoId || !url) return
  _ytStreamCache.set(String(videoId), {
    url,
    inst: inst || null,
    createdAt: Date.now(),
    expiresAt: Date.now() + YT_STREAM_TTL_MS
  })
}

function withTimeoutValue(promise, ms, fallback) {
  return new Promise((resolve) => {
    let done = false
    const t = setTimeout(() => {
      if (done) return
      done = true
      resolve(fallback)
    }, Math.max(1000, Number(ms || 0)))
    Promise.resolve(promise)
      .then((v) => {
        if (done) return
        done = true
        clearTimeout(t)
        resolve(v)
      })
      .catch(() => {
        if (done) return
        done = true
        clearTimeout(t)
        resolve(fallback)
      })
  })
}

async function getWorkingInstance() {
  if (_workingInstance) {
    try {
      const r = await httpsGetJson(_workingInstance, '/api/v1/search?q=test&type=video&page=1', {}, 6000)
      if (r.status === 200 && Array.isArray(r.body)) return _workingInstance
    } catch {}
    _workingInstance = null
  }
  for (const inst of INVIDIOUS_INSTANCES) {
    try {
      const r = await httpsGetJson(inst, '/api/v1/search?q=test&type=video&page=1', {}, 8000)
      if (r.status === 200 && Array.isArray(r.body)) { _workingInstance = inst; return inst }
    } catch { continue }
  }
  return null
}

ipcMain.handle('youtube-search', async (e, { q }) => {
  const ytdlpTracks = await searchYouTubeViaYtDlp(q, 20)
  if (Array.isArray(ytdlpTracks) && ytdlpTracks.length) {
    return { ok: true, tracks: ytdlpTracks, instance: 'yt-dlp' }
  }

  const instance = await getWorkingInstance()
  if (!instance) return { ok: false, error: 'Р’СЃРµ YouTube СЃРµСЂРІРµСЂС‹ РЅРµРґРѕСЃС‚СѓРїРЅС‹ вЂ” Invidious СЃРµР№С‡Р°СЃ РЅРµСЃС‚Р°Р±РёР»РµРЅ РёР·-Р·Р° Р±Р»РѕРєРёСЂРѕРІРѕРє YT' }
  try {
    const r = await httpsGetJson(instance,
      `/api/v1/search?q=${encodeURIComponent(q)}&type=video&fields=videoId,title,author,lengthSeconds,videoThumbnails&page=1`,
      {}, 12000
    )
    if (r.status !== 200 || !Array.isArray(r.body)) { _workingInstance = null; return { ok: false, error: 'YouTube: РѕС€РёР±РєР° РїРѕРёСЃРєР°, РїРѕРїСЂРѕР±СѓР№ РµС‰С‘ СЂР°Р·' } }
    const tracks = r.body.slice(0, 20).map(v => {
      const thumbs = v.videoThumbnails || []
      const thumb = thumbs.find(t => t.quality === 'medium') || thumbs[0]
      return {
        title: v.title, artist: v.author, url: null, ytId: v.videoId,
        cover: thumb?.url || null,
        bg: 'linear-gradient(135deg,#ff0000,#cc0000)',
        source: 'youtube', id: v.videoId, duration: v.lengthSeconds
      }
    })
    return { ok: true, tracks, instance }
  } catch (err) { _workingInstance = null; return { ok: false, error: 'YouTube: ' + err.message } }
})

ipcMain.handle('youtube-stream', async (e, { videoId, instance, forceFresh = false }) => {
  try {
    console.log('[youtube-stream]', { videoId, instance: instance || null, forceFresh: Boolean(forceFresh) })
  } catch {}
  const key = String(videoId || '')
  if (!key) return { ok: false, error: 'bad video id' }
  const inflightKey = key

  const existing = _ytStreamInFlight.get(inflightKey)
  if (existing) {
    try { console.log('[youtube-stream] join in-flight', key) } catch {}
    if (!forceFresh) return existing
    // If forceFresh was requested while an older resolve is stuck, don't block forever on join.
    const joined = await withTimeoutValue(existing, 8000, null)
    if (joined?.ok) return joined
    try { console.log('[youtube-stream] forceFresh bypass join timeout', key) } catch {}
  }

  const task = withTimeoutValue((async () => {
    if (!forceFresh) {
      const cached = getCachedYtStream(videoId)
      if (cached?.url) {
        const ageMs = Date.now() - Number(cached.createdAt || 0)
        if (cached.inst === 'yt-dlp' && ageMs >= 0 && ageMs <= YT_FAST_CACHE_TRUST_MS) {
          try { console.log('[youtube-stream] fast cache hit', Math.round(ageMs / 1000) + 's') } catch {}
          return { ok: true, url: cached.url, inst: cached.inst || instance || null, cached: true, fastCache: true }
        }
        const cachedProbe = await probeStreamWithRedirects(cached.url, 'bytes=0-0', 0)
        try { console.log('[youtube-stream] cache probe', cachedProbe?.status, cachedProbe?.contentType || '', cachedProbe?.ok) } catch {}
        if (cachedProbe?.ok) {
          return { ok: true, url: cached.url, inst: cached.inst || instance || null, cached: true }
        }
        _ytStreamCache.delete(String(videoId || ''))
      }
    }

    // Primary strategy for reliability: yt-dlp first (same approach used by downloader clients).
    try {
      const maxYtdlpAttempts = forceFresh ? 5 : 4
      for (let attempt = 1; attempt <= maxYtdlpAttempts; attempt++) {
        try { console.log('[youtube-stream] yt-dlp resolve start', attempt, forceFresh ? 'fresh' : 'normal') } catch {}
        const ytdlpRes = await withTimeoutValue(tryYtDlpStream(videoId, {
          allowCookies: false,
          quickOnly: true,
          includePython: false,
          maxBinCandidates: 1,
          timeoutMs: 7000,
          returnMeta: true
        }), 8500, null)
        const ytdlpUrl = ytdlpRes?.url || null
        if (ytdlpRes?.ageRestricted || ytdlpRes?.botCheck) {
          const reason = ytdlpRes.ageRestricted ? 'age-restricted' : 'bot-check'
          try { console.log('[youtube-stream] yt-dlp blocked', reason) } catch {}
          return {
            ok: false,
            error: ytdlpRes.ageRestricted
              ? 'YouTube: видео с возрастным ограничением (нужны cookies).'
              : 'YouTube: требуется подтверждение аккаунта (нужны cookies).',
            code: ytdlpRes.ageRestricted ? 'AGE_RESTRICTED' : 'BOT_CHECK'
          }
        }
        try { console.log('[youtube-stream] yt-dlp resolve done', attempt, Boolean(ytdlpUrl)) } catch {}
        if (!ytdlpUrl) continue
        const probe = await probeStreamWithRedirects(ytdlpUrl, 'bytes=0-0', 0)
        try { console.log('[youtube-stream] yt-dlp probe', attempt, probe?.status, probe?.contentType || '', probe?.ok) } catch {}
        if (!probe?.ok) continue
        setCachedYtStream(videoId, ytdlpUrl, 'yt-dlp')
        try { console.log('[youtube-stream] resolved via yt-dlp') } catch {}
        return { ok: true, url: ytdlpUrl, inst: 'yt-dlp' }
      }
      // One wider pass after quick attempts (still bounded).
      const ytdlpSlow = await withTimeoutValue(tryYtDlpStream(videoId, {
        allowCookies: false,
        quickOnly: false,
        includePython: true,
        maxBinCandidates: 4,
        timeoutMs: 9000
      }), 14000, null)
      if (ytdlpSlow) {
        const slowProbe = await probeStreamWithRedirects(ytdlpSlow, 'bytes=0-0', 0)
        try { console.log('[youtube-stream] yt-dlp slow probe', slowProbe?.status, slowProbe?.contentType || '', slowProbe?.ok) } catch {}
        if (slowProbe?.ok) {
          setCachedYtStream(videoId, ytdlpSlow, 'yt-dlp')
          try { console.log('[youtube-stream] resolved via yt-dlp slow') } catch {}
          return { ok: true, url: ytdlpSlow, inst: 'yt-dlp' }
        }
      }
      // Slow but useful last-chance pass with browser cookies only for force-fresh retries.
      if (forceFresh) {
        const ytdlpWithCookies = await withTimeoutValue(tryYtDlpStream(videoId, {
          allowCookies: true,
          quickOnly: false,
          includePython: true,
          maxBinCandidates: 3,
          timeoutMs: 10000
        }), 16000, null)
        if (ytdlpWithCookies) {
          const probe = await probeStreamWithRedirects(ytdlpWithCookies, 'bytes=0-0', 0)
          try { console.log('[youtube-stream] yt-dlp cookies probe', probe?.status, probe?.contentType || '', probe?.ok) } catch {}
          if (probe?.ok) {
            setCachedYtStream(videoId, ytdlpWithCookies, 'yt-dlp')
            try { console.log('[youtube-stream] resolved via yt-dlp cookies') } catch {}
            return { ok: true, url: ytdlpWithCookies, inst: 'yt-dlp' }
          }
        }
      }
    } catch {}

    if (YT_PLAYBACK_YTDLP_ONLY) {
      const ytdlpBin = await resolveYtDlpBinary()
      const hint = ytdlpBin
        ? 'YouTube: поток не получен через yt-dlp. Нажми "Обновить yt-dlp" в настройках и повтори.'
        : 'YouTube: не найден yt-dlp. Установи yt-dlp (winget install yt-dlp) и перезапусти Flow.'
      return { ok: false, error: hint }
    }
    const instances = instance ? [instance, ...INVIDIOUS_INSTANCES.filter(i => i !== instance)] : INVIDIOUS_INSTANCES
    for (const inst of instances) {
      try {
        const r = await httpsGetJson(inst, `/api/v1/videos/${videoId}?fields=adaptiveFormats,formatStreams`, {}, 14000)
        if (r.status !== 200 || !r.body) continue

        const audioOnly = (r.body.adaptiveFormats || [])
          .filter(f => f.url && (f.type?.includes('audio/webm') || f.type?.includes('audio/mp4') || f.type?.startsWith('audio/')))
          .sort((a, b) => {
            const aW = a.type?.includes('audio/webm') ? 1 : 0
            const bW = b.type?.includes('audio/webm') ? 1 : 0
            if (bW !== aW) return bW - aW
            return (b.bitrate || 0) - (a.bitrate || 0)
          })

        const streamUrl = audioOnly[0]?.url || (r.body.formatStreams || []).find(f => f.url)?.url
        if (!streamUrl) continue
        const probe = await probeStreamWithRedirects(streamUrl, 'bytes=0-0', 0)
        try { console.log('[youtube-stream] invidious candidate probe', inst, probe?.status, probe?.contentType || '', probe?.ok) } catch {}
        if (!probe?.ok) continue

        _workingInstance = inst
        setCachedYtStream(videoId, streamUrl, inst)
        try { console.log('[youtube-stream] resolved via invidious', inst) } catch {}
        return { ok: true, url: streamUrl, inst }
      } catch { continue }
    }

    const PIPED_INSTANCES = ['pipedapi.kavin.rocks', 'pipedapi.moomoo.me', 'pipedapi.adminforge.de']
    for (const piped of PIPED_INSTANCES) {
      try {
        const r = await httpsGetJson(piped, `/streams/${videoId}`, {
          'User-Agent': 'Mozilla/5.0'
        }, 12000)
        if (r.status !== 200 || !r.body?.audioStreams) continue
        const best = r.body.audioStreams
          .filter(s => s.url)
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]
        if (best?.url) {
          const probe = await probeStreamWithRedirects(best.url, 'bytes=0-0', 0)
          try { console.log('[youtube-stream] piped candidate probe', piped, probe?.status, probe?.contentType || '', probe?.ok) } catch {}
          if (!probe?.ok) continue
          setCachedYtStream(videoId, best.url, piped)
          return { ok: true, url: best.url }
        }
      } catch { continue }
    }

    for (const inst of instances) {
      try {
        const p = `/latest_version?id=${encodeURIComponent(videoId)}&itag=140&local=true`
        const r = await httpsGetRaw(inst, p, { 'User-Agent': 'Mozilla/5.0' }, 10000)
        if (r.status >= 200 && r.status < 400 && r.raw) {
          const url = String(r.raw).trim()
          if (url.startsWith('http')) {
            setCachedYtStream(videoId, url, inst)
            return { ok: true, url, inst }
          }
        }
      } catch { continue }
    }

    const ytdlpBin = await resolveYtDlpBinary()
    const hint = ytdlpBin
      ? 'YouTube: не удалось получить поток. Попробуй другой трек или обнови yt-dlp.'
      : 'YouTube: нет стабильного движка потока. Установи yt-dlp (winget install yt-dlp) и перезапусти Flow.'
    return { ok: false, error: hint }
  })(), forceFresh ? 45000 : 35000, { ok: false, error: 'YouTube: timeout получения потока, попробуй ещё раз' })
    .finally(() => {
      _ytStreamInFlight.delete(inflightKey)
    })

  _ytStreamInFlight.set(inflightKey, task)
  return task
})

ipcMain.handle('youtube-prefetch-streams', async (e, { ids = [], instance }) => {
  const out = {}
  const unique = [...new Set((ids || []).filter(Boolean).map(String))].slice(0, 8)
  for (const id of unique) {
    const cached = getCachedYtStream(id)
    if (cached?.url) {
      out[id] = { ok: true, cached: true, inst: cached.inst || null }
      continue
    }
  }
  // Inline resolution without recursion to keep handler deterministic
  for (const id of unique) {
    if (out[id]?.ok) continue
    const res = await (async () => {
      const instances = instance ? [instance, ...INVIDIOUS_INSTANCES.filter(i => i !== instance)] : INVIDIOUS_INSTANCES
      for (const inst of instances) {
        try {
          const r = await httpsGetJson(inst, `/api/v1/videos/${id}?fields=adaptiveFormats,formatStreams`, {}, 12000)
          if (r.status !== 200 || !r.body) continue
          const audioOnly = (r.body.adaptiveFormats || [])
            .filter(f => f.url && (f.type?.includes('audio/webm') || f.type?.includes('audio/mp4') || f.type?.startsWith('audio/')))
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))
          const streamUrl = audioOnly[0]?.url || (r.body.formatStreams || []).find(f => f.url)?.url
          if (!streamUrl) continue
          _workingInstance = inst
          setCachedYtStream(id, streamUrl, inst)
          return { ok: true, inst }
        } catch { continue }
      }
      return { ok: false }
    })()
    out[id] = res
  }
  return { ok: true, results: out }
})

// в”Ђв”Ђв”Ђ LYRICS: LRCLIB в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
ipcMain.handle('get-lyrics', async (e, { title, artist, duration }) => {
  try {
    const normalizeLyricsPart = (value) => String(value || '')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\{[^}]*\}/g, ' ')
      .replace(/\b(feat|ft)\.?\s+[^\-–|,/]+/gi, ' ')
      .replace(/\b(official(\s+video)?|music\s*video|visualizer|audio|lyrics?|lyric\s*video|video)\b/gi, ' ')
      .replace(/\b(speed[\s_-]*up|sped[\s_-]*up|nightcore|slowed(\s*down)?|reverb|bass\s*boost(ed)?|8d|remix|edit|version)\b/gi, ' ')
      .replace(/[|/\\]+/g, ' ')
      .replace(/["'`]+/g, ' ')
      .replace(/[^\p{L}\p{N}\s\-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    const rawTitle = String(title || '').trim()
    const rawArtist = String(artist || '').trim()
    const cleanTitle = normalizeLyricsPart(rawTitle)
    const cleanArtist = normalizeLyricsPart(rawArtist)

    const titleCandidates = [...new Set([
      cleanTitle,
      cleanTitle.replace(/\b(speed[\s_-]*up|sped[\s_-]*up|nightcore|slowed(\s*down)?|reverb|bass\s*boost(ed)?|8d)\b/gi, ' ').replace(/\s+/g, ' ').trim(),
      cleanTitle.replace(/\s*[-–|,]\s*.*$/g, '').replace(/\s+/g, ' ').trim(),
      rawTitle.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim(),
    ].filter(Boolean))]

    const artistCandidates = [...new Set([
      cleanArtist,
      rawArtist.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim(),
      rawArtist.split(',')[0]?.trim() || '',
    ].filter(Boolean))]

    const tryGetByMeta = async (artistName, trackName) => {
      const r = await httpsGetJson('lrclib.net',
        `/api/get?track_name=${encodeURIComponent(trackName)}&artist_name=${encodeURIComponent(artistName)}${duration ? '&duration=' + Math.round(duration) : ''}`,
        { 'User-Agent': 'FlowPlayer/0.2 (github.com)' },
        10000
      )
      if (r.status === 200 && r.body) {
        return {
          ok: true,
          synced: r.body.syncedLyrics || null,
          plain: r.body.plainLyrics || null
        }
      }
      return null
    }

    const trySearch = async (artistName, trackName) => {
      const q = encodeURIComponent(`${artistName} ${trackName}`.trim())
      const r = await httpsGetJson('lrclib.net',
        `/api/search?q=${q}`,
        { 'User-Agent': 'FlowPlayer/0.2 (github.com)' },
        10000
      )
      if (r.status === 200 && Array.isArray(r.body) && r.body.length > 0) {
        const best = r.body[0]
        return {
          ok: true,
          synced: best.syncedLyrics || null,
          plain: best.plainLyrics || null
        }
      }
      return null
    }

    for (const a of artistCandidates) {
      for (const t of titleCandidates) {
        const byMeta = await tryGetByMeta(a, t)
        if (byMeta) return byMeta
      }
    }

    for (const a of artistCandidates) {
      for (const t of titleCandidates) {
        const bySearch = await trySearch(a, t)
        if (bySearch) return bySearch
      }
    }

    for (const a of artistCandidates) {
      for (const t of titleCandidates) {
        const lyo = await httpsGetJson(
          'api.lyrics.ovh',
          `/v1/${encodeURIComponent(a)}/${encodeURIComponent(t)}`,
          { 'User-Agent': 'FlowPlayer/0.2 (github.com)' },
          10000
        )
        if (lyo.status === 200 && lyo.body?.lyrics) {
          return {
            ok: true,
            synced: null,
            plain: String(lyo.body.lyrics || '').trim() || null
          }
        }
      }
    }

    return { ok: false, error: 'РўРµРєСЃС‚ РЅРµ РЅР°Р№РґРµРЅ' }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// в”Ђв”Ђв”Ђ SOUNDCLOUD: Client ID в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
let _scClientIdCache = null
let _scClientIdExpiry = 0

// РђРєС‚СѓР°Р»СЊРЅС‹Р№ РїР°С‚С‚РµСЂРЅ 2026 (РёСЃС‚РѕС‡РЅРёРє: roundproxies.com/blog/scrape-soundcloud, СЏРЅРІР°СЂСЊ 2026)
const SC_PATTERNS = [
  /client_id["']?\s*[:=]\s*["']([a-zA-Z0-9]{32})["']/,   // РѕСЃРЅРѕРІРЅРѕР№ Р°РєС‚СѓР°Р»СЊРЅС‹Р№ РїР°С‚С‚РµСЂРЅ 2026
  /client_id\s*:\s*"([a-zA-Z0-9]{32})"/,
  /client_id="([a-zA-Z0-9]{32})"/,
  /"client_id","([a-zA-Z0-9]{32})"/,
  /,client_id:"([a-zA-Z0-9]{32})"/,
  /\?client_id=([a-zA-Z0-9]{32})/,
  /client_id\s*=\s*"([a-zA-Z0-9]{32})"/,
]

async function resolveScClientIdForServerSearch(manualId = '') {
  const direct = String(manualId || '').trim()
  if (direct) return direct
  const now = Date.now()
  if (_scClientIdCache && now < _scClientIdExpiry) return _scClientIdCache

  const page = await httpsGetRaw('soundcloud.com', '/', {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9'
  }, 15000)
  if (!page.raw) throw new Error('SC: не удалось загрузить soundcloud.com')

  const scriptUrls = [...page.raw.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map((m) => m[1])
  if (!scriptUrls.length) throw new Error('SC: JS бандлы не найдены')
  const candidates = scriptUrls.slice(-8).reverse()

  for (const scriptUrl of candidates) {
    try {
      const parsed = new URL(scriptUrl)
      const js = await httpsGetRaw(parsed.hostname, parsed.pathname, {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }, 20000)
      if (!js.raw || js.status !== 200) continue
      for (const pattern of SC_PATTERNS) {
        const match = js.raw.match(pattern)
        if (match?.[1]?.length === 32) {
          _scClientIdCache = match[1]
          _scClientIdExpiry = now + 6 * 60 * 60 * 1000
          return _scClientIdCache
        }
      }
    } catch {}
  }
  throw new Error('SC: client_id не найден')
}

ipcMain.handle('server-search', async (e, { q, settings = {} }) => {
  const query = String(q || '').trim()
  if (!query) return { ok: true, mode: 'empty', tracks: [] }

  const spotifyToken = String(settings?.spotifyToken || '').trim()
  const manualScId = String(settings?.soundcloudClientId || '').trim()
  let spotifyErr = null
  let scErr = null
  let audiusErr = null

  if (spotifyToken) {
    try {
      const sp = await httpsGetJsonUrl(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=20`,
        { Authorization: `Bearer ${spotifyToken}` },
        9000
      )
      if (sp.status === 200 && Array.isArray(sp?.body?.tracks?.items)) {
        const tracks = sp.body.tracks.items.map((t) => ({
          title: t?.name || 'Без названия',
          artist: Array.isArray(t?.artists) ? t.artists.map((a) => a?.name).filter(Boolean).join(', ') : '—',
          url: t?.preview_url || null,
          cover: t?.album?.images?.[0]?.url || null,
          bg: 'linear-gradient(135deg,#1db954,#1ed760)',
          source: 'spotify',
          id: String(t?.id || `${t?.name || ''}:${t?.artists?.[0]?.name || ''}`)
        }))
        if (tracks.length) return { ok: true, mode: 'spotify', tracks }
      } else {
        spotifyErr = new Error(`Spotify: ${sp.status || 'bad response'}`)
      }
    } catch (err) {
      spotifyErr = err
    }
  }

  try {
    const scClientId = await resolveScClientIdForServerSearch(manualScId)
    const endpoints = [
      { h: 'api-v2.soundcloud.com', p: `/search/tracks?q=${encodeURIComponent(query)}&client_id=${scClientId}&limit=20&linked_partitioning=1` },
      { h: 'api.soundcloud.com', p: `/tracks?q=${encodeURIComponent(query)}&client_id=${scClientId}&limit=20&linked_partitioning=1` },
    ]
    for (const ep of endpoints) {
      const r = await httpsGetJson(ep.h, ep.p, {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://soundcloud.com',
        'Referer': 'https://soundcloud.com/'
      }, 10000)
      if (r.status !== 200 || !r.body) continue
      const rows = Array.isArray(r.body) ? r.body : (r.body.collection || r.body.tracks || [])
      const tracks = rows.map((t) => {
        let transcodingUrl = null
        if (Array.isArray(t?.media?.transcodings) && t.media.transcodings.length > 0) {
          const prog = t.media.transcodings.find((tr) => tr?.format?.protocol === 'progressive')
          transcodingUrl = (prog || t.media.transcodings[0])?.url || null
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
          id: String(t?.id || `${t?.title || ''}:${t?.user?.username || ''}`)
        }
      }).filter((t) => t.scTranscoding || t.url)
      if (tracks.length) return { ok: true, mode: 'soundcloud', tracks }
    }
    scErr = new Error('SoundCloud: не удалось получить результаты')
  } catch (err) {
    scErr = err
  }

  try {
    let host = await getAudiusHost(false)
    let r = await httpsGetJsonUrl(`${host}/v1/tracks/search?query=${encodeURIComponent(query)}&limit=20&app_name=flow`, {}, 10000)
    if (r.status !== 200 || !Array.isArray(r?.body?.data)) {
      host = await getAudiusHost(true)
      r = await httpsGetJsonUrl(`${host}/v1/tracks/search?query=${encodeURIComponent(query)}&limit=20&app_name=flow`, {}, 10000)
    }
    const items = Array.isArray(r?.body?.data) ? r.body.data : []
    const tracks = items.map((t) => {
      const id = String(t?.id || '')
      return {
        title: t?.title || 'Без названия',
        artist: t?.user?.name || '—',
        url: id ? `${host}/v1/tracks/${encodeURIComponent(id)}/stream?app_name=flow` : null,
        cover: t?.artwork?.['480x480'] || t?.artwork?.['1000x1000'] || t?.artwork?.['150x150'] || null,
        bg: 'linear-gradient(135deg,#2dd4bf,#0ea5e9)',
        source: 'audius',
        id: id || `${t?.title || ''}:${t?.user?.name || ''}`
      }
    }).filter((t) => t.url)
    if (tracks.length) return { ok: true, mode: 'audius', tracks }
    audiusErr = new Error('Audius: пустой результат')
  } catch (err) {
    audiusErr = err
  }

  const reasons = [
    spotifyErr ? `Spotify: ${spotifyErr.message || spotifyErr}` : '',
    scErr ? `SoundCloud: ${scErr.message || scErr}` : '',
    audiusErr ? `Audius: ${audiusErr.message || audiusErr}` : '',
  ].filter(Boolean)
  return { ok: false, error: reasons.join(' | ') || 'Ничего не найдено', mode: 'none', tracks: [] }
})

ipcMain.handle('sc-fetch-client-id', async () => {
  const now = Date.now()
  if (_scClientIdCache && now < _scClientIdExpiry) return { ok: true, clientId: _scClientIdCache }

  try {
    const page = await httpsGetRaw('soundcloud.com', '/', {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    }, 15000)

    if (!page.raw) return { ok: false, error: 'РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ soundcloud.com' }

    // РС‰РµРј РІСЃРµ JS Р±Р°РЅРґР»С‹ SC
    const scriptUrls = [...page.raw.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map(m => m[1])
    if (!scriptUrls.length) return { ok: false, error: 'JS Р±Р°РЅРґР»С‹ SC РЅРµ РЅР°Р№РґРµРЅС‹ вЂ” РІРѕР·РјРѕР¶РЅРѕ, SC РёР·РјРµРЅРёР» СЃС‚СЂСѓРєС‚СѓСЂСѓ' }

    // РџРµСЂРµР±РёСЂР°РµРј РїРѕСЃР»РµРґРЅРёРµ 10 Р±Р°РЅРґР»РѕРІ РІ РѕР±СЂР°С‚РЅРѕРј РїРѕСЂСЏРґРєРµ
    const candidates = scriptUrls.slice(-10).reverse()

    for (const scriptUrl of candidates) {
      try {
        const parsed = new URL(scriptUrl)
        const js = await httpsGetRaw(parsed.hostname, parsed.pathname, {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }, 20000)
        if (!js.raw || js.status !== 200) continue

        for (const pattern of SC_PATTERNS) {
          const match = js.raw.match(pattern)
          if (match?.[1]?.length === 32) {
            _scClientIdCache = match[1]
            _scClientIdExpiry = now + 6 * 60 * 60 * 1000  // РєСЌС€ 6 С‡Р°СЃРѕРІ
            return { ok: true, clientId: _scClientIdCache }
          }
        }
      } catch { continue }
    }
    return { ok: false, error: 'Client ID РЅРµ РЅР°Р№РґРµРЅ вЂ” SC РѕР±РЅРѕРІРёР» Р±Р°РЅРґР»С‹. Р’СЃС‚Р°РІСЊ ID РІСЂСѓС‡РЅСѓСЋ РІ РЅР°СЃС‚СЂРѕР№РєР°С… вљ™пёЏ' }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// в”Ђв”Ђв”Ђ SOUNDCLOUD: РїРѕРёСЃРє в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
ipcMain.handle('sc-search', async (e, { q, clientId }) => {
  // api-v2 вЂ” РѕСЃРЅРѕРІРЅРѕР№, api вЂ” fallback
  const endpoints = [
    { h: 'api-v2.soundcloud.com', p: `/search/tracks?q=${encodeURIComponent(q)}&client_id=${clientId}&limit=20&linked_partitioning=1` },
    { h: 'api.soundcloud.com',    p: `/tracks?q=${encodeURIComponent(q)}&client_id=${clientId}&limit=20&linked_partitioning=1` },
  ]
  for (const ep of endpoints) {
    try {
      const r = await httpsGetJson(ep.h, ep.p, {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://soundcloud.com', 'Referer': 'https://soundcloud.com/'
      }, 12000)
      if (r.status === 401 || r.status === 403) return { ok: false, error: `SC: С‚РѕРєРµРЅ РЅРµРґРµР№СЃС‚РІРёС‚РµР»РµРЅ (${r.status})`, expired: true }
      if (r.status !== 200 || !r.body) continue
      const tracks = Array.isArray(r.body) ? r.body : (r.body.collection || r.body.tracks || [])
      return { ok: true, tracks }
    } catch { continue }
  }
  return { ok: false, error: 'SC: РЅРµ СѓРґР°Р»РѕСЃСЊ РїРѕРґРєР»СЋС‡РёС‚СЊСЃСЏ' }
})

// в”Ђв”Ђв”Ђ РЇРќР”Р•РљРЎ: СЃС‚СЂРёРј в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
// РЇРЅРґРµРєСЃ РѕС‚РґР°С‘С‚ РїСЂСЏРјСѓСЋ СЃСЃС‹Р»РєСѓ С‡РµСЂРµР· download-info в†’ sign URL
ipcMain.handle('yandex-stream', async (e, { trackId, token }) => {
  try {
    // РЁР°Рі 1: РїРѕР»СѓС‡Р°РµРј download-info
    const infoR = await httpsGetJson(
      'api.music.yandex.net',
      `/tracks/${trackId}/download-info`,
      {
        'Authorization': `OAuth ${token}`,
        'X-Yandex-Music-Client': 'WindowsPhone/3.20',
        'User-Agent': 'Windows 10'
      },
      10000
    )
    if (!infoR.body?.result?.length) {
      return { ok: false, error: 'РЇРЅРґРµРєСЃ: РЅРµС‚ РёСЃС‚РѕС‡РЅРёРєРѕРІ РґР»СЏ С‚СЂРµРєР° вЂ” РЅСѓР¶РЅР° РїРѕРґРїРёСЃРєР° РџР»СЋСЃ' }
    }

    // Р‘РµСЂС‘Рј MP3 СЃ РЅР°РёР±РѕР»СЊС€РёРј Р±РёС‚СЂРµР№С‚РѕРј
    const sources = infoR.body.result
      .filter(s => s.codec === 'mp3')
      .sort((a, b) => (b.bitrateInKbps || 0) - (a.bitrateInKbps || 0))
    if (!sources.length) return { ok: false, error: 'РЇРЅРґРµРєСЃ: MP3 РЅРµРґРѕСЃС‚СѓРїРµРЅ' }

    // РЁР°Рі 2: РїРѕР»СѓС‡Р°РµРј XML СЃ СЂРµР°Р»СЊРЅС‹Рј URL
    const src = sources[0]
    const xmlR = await httpsGetRaw(
      new URL(src.downloadInfoUrl).hostname,
      new URL(src.downloadInfoUrl).pathname + new URL(src.downloadInfoUrl).search,
      { 'Authorization': `OAuth ${token}` },
      10000
    )
    if (!xmlR.raw) return { ok: false, error: 'РЇРЅРґРµРєСЃ: РЅРµ СѓРґР°Р»РѕСЃСЊ РїРѕР»СѓС‡РёС‚СЊ URL СЃС‚СЂРёРјР°' }

    // РџР°СЂСЃРёРј XML РІСЂСѓС‡РЅСѓСЋ (РЅРµС‚ xml2js РІ main process)
    const host  = xmlR.raw.match(/<host>([^<]+)<\/host>/)?.[1]
    const path  = xmlR.raw.match(/<path>([^<]+)<\/path>/)?.[1]
    const ts    = xmlR.raw.match(/<ts>([^<]+)<\/ts>/)?.[1]
    const s     = xmlR.raw.match(/<s>([^<]+)<\/s>/)?.[1]

    if (!host || !path || !ts || !s) {
      return { ok: false, error: 'РЇРЅРґРµРєСЃ: РЅРµ СѓРґР°Р»РѕСЃСЊ СЂР°СЃРїР°СЂСЃРёС‚СЊ URL СЃС‚СЂРёРјР°' }
    }

    // РџРѕРґРїРёСЃС‹РІР°РµРј URL (Р°Р»РіРѕСЂРёС‚Рј РЇРЅРґРµРєСЃ РњСѓР·С‹РєРё)
    const crypto = require('crypto')
    const sign = crypto.createHash('md5')
      .update('XGRlBW9FXlekgbPrRHuSiA' + path.slice(1) + s)
      .digest('hex')

    const streamUrl = `https://${host}/get-mp3/${sign}/${ts}${path}`
    return { ok: true, url: streamUrl }
  } catch (err) {
    return { ok: false, error: 'РЇРЅРґРµРєСЃ: ' + err.message }
  }
})

// в”Ђв”Ђв”Ђ SOUNDCLOUD: СЃС‚СЂРёРј в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
ipcMain.handle('sc-stream', async (e, { transcodingUrl, clientId }) => {
  try {
    const parsed = new URL(transcodingUrl + (transcodingUrl.includes('?') ? '&' : '?') + `client_id=${clientId}`)
    const r = await httpsGetJson(parsed.hostname, parsed.pathname + parsed.search, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Origin': 'https://soundcloud.com', 'Referer': 'https://soundcloud.com/'
    }, 10000)
    if (r.body?.url) return { ok: true, url: r.body.url }
    return { ok: false, error: 'SC: РїСѓСЃС‚РѕР№ РѕС‚РІРµС‚ РїСЂРё РїРѕР»СѓС‡РµРЅРёРё СЃС‚СЂРёРјР°' }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})





