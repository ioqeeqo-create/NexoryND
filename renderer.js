const { audioPlayer = {}, smartCleaning = {}, dragDrop = {}, peerSocial = {} } = window.FlowModules || {}
const audio = (audioPlayer.createPlayerAudio || ((onErr) => {
  const el = new Audio()
  el.volume = 0.8
  el.onerror = () => onErr(el)
  return el
}))(() => {
  console.error('AUDIO ERROR', {
    code: audio.error?.code,
    message: audio.error?.message || null,
    src: audio.currentSrc || audio.src || null
  })
  try {
    const code = audio.error?.code ? `код ${audio.error.code}` : 'код неизвестен'
    const src = audio.currentSrc || audio.src || ''
    showToast(`Ошибка аудио (${code})`, true)
    if (src) console.warn('AUDIO SRC:', src)
  } catch {}
})

let currentTrack = null
let queue = []
let queueIndex = 0
let queueScope = 'generic' // generic | search | liked | playlist
let openPlaylistIndex = null
let searchDebounceTimer = null
let currentSource = 'youtube'
let _playerModeActive = false
let _lastSearchMode = 'hybrid'
let _playRequestSeq = 0
const _ytPrewarmAt = new Map()
const _coverLoadState = new Map()

const defaultPlayback = { shuffle: false, repeat: 'off' } // repeat: off | all | one
let playbackMode = (() => {
  try { return Object.assign({}, defaultPlayback, JSON.parse(localStorage.getItem('flow_playback_mode') || '{}')) }
  catch { return { ...defaultPlayback } }
})()

const COVER_ICON = '<svg class="ui-icon lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'
let _audioCtx = null
let _analyser = null
let _freqData = null
let _customFontLoadedKey = ''
let _authMode = 'login'
let _profile = null
let _socialPeer = null
let _roomState = { roomId: null, host: false, hostPeerId: null }
let _lastRoomSyncAt = 0
let _currentTrackStartedAt = 0
let _roomServerChannel = null
let _roomServerHeartbeatTimer = null
let _lastAppliedServerPlaybackTs = 0
let _friendPresence = new Map()
let _friendsPollTimer = null
let _playlistDragIndex = -1
let _playlistEditContext = null
let _libraryActionMode = null
let _playlistPickerContext = null
let _listenTickAt = 0
let _peerProfiles = new Map()
let _roomMembers = new Map()
let sharedQueue = []
let _roomSearchDebounceTimer = null
let _roomSearchResults = []
let _sharedQueueDragIndex = -1
let _lastHostOnlyToastAt = 0
let _lastUiSyncAt = 0
let _roomHeartbeatTimer = null

function getPeerProfileCache() {
  try { return JSON.parse(localStorage.getItem('flow_peer_public_profiles') || '{}') || {} } catch { return {} }
}

function savePeerProfileCache(map) {
  try { localStorage.setItem('flow_peer_public_profiles', JSON.stringify(map || {})) } catch {}
}

function cachePeerProfile(profile, peerId = '') {
  if (!profile || typeof profile !== 'object') return
  const username = String(profile.username || '').trim().toLowerCase()
  if (!username) return
  const cache = getPeerProfileCache()
  cache[username] = {
    username,
    avatarData: profile.avatarData || null,
    bannerData: profile.bannerData || null,
    bio: profile.bio || '',
    peerId: String(peerId || profile.peerId || '').trim() || null,
    updatedAt: Date.now(),
  }
  savePeerProfileCache(cache)
}

function getCachedPeerProfile(username = '') {
  const safe = String(username || '').trim().toLowerCase()
  if (!safe) return null
  const cache = getPeerProfileCache()
  return cache[safe] || null
}

function isRoomClientRestricted() {
  return Boolean(_roomState?.roomId && !_roomState?.host)
}

function canControlQueue() {
  return !isRoomClientRestricted()
}

function showHostOnlyToast() {
  const now = Date.now()
  if (now - _lastHostOnlyToastAt < 1100) return
  _lastHostOnlyToastAt = now
  showToast('Только хост управляет плеером', true)
}

function updateHostLockUi() {
  const restricted = isRoomClientRestricted()
  const lockEls = [
    document.getElementById('host-lock-indicator-main'),
    document.getElementById('host-lock-indicator-home'),
    document.getElementById('host-lock-indicator-pm'),
  ]
  lockEls.forEach((el) => {
    if (!el) return
    el.style.display = restricted ? 'inline-flex' : 'none'
  })
  const controlButtons = document.querySelectorAll('button[onclick="prevTrack()"],button[onclick="nextTrack()"]')
  controlButtons.forEach((btn) => {
    btn.disabled = restricted
    btn.style.opacity = restricted ? '0.45' : ''
    btn.style.cursor = restricted ? 'not-allowed' : ''
  })
  const seekBars = [
    document.getElementById('progress'),
    document.getElementById('home-clone-progress'),
    document.getElementById('pm-progress'),
  ]
  seekBars.forEach((bar) => {
    if (!bar) return
    bar.disabled = restricted
    bar.style.opacity = restricted ? '0.55' : ''
    bar.style.cursor = restricted ? 'not-allowed' : ''
  })
}

function updateRoomUi() {
  const countEl = document.getElementById('room-members-count')
  const roleBadgeEl = document.getElementById('room-role-badge')
  if (countEl) {
    if (_roomState?.roomId && _socialPeer) {
      countEl.textContent = `Участники: ${_socialPeer.peersCount()}/3`
    } else {
      countEl.textContent = 'Участники: —/3'
    }
  }
  if (roleBadgeEl) {
    if (!_roomState?.roomId) {
      roleBadgeEl.textContent = 'SOLO'
      roleBadgeEl.className = 'room-role-badge room-role-solo'
    } else if (_roomState.host) {
      roleBadgeEl.textContent = 'HOST'
      roleBadgeEl.className = 'room-role-badge room-role-host'
    } else {
      roleBadgeEl.textContent = 'CLIENT'
      roleBadgeEl.className = 'room-role-badge room-role-client'
    }
  }
  updateHostLockUi()
  renderRoomMembers()
  renderRoomQueue()
}

function resolveInviteToRoomId(raw) {
  const value = String(raw || '').trim()
  if (!value) return ''
  const deepMatch = value.match(/^flow:\/\/join\/([a-z0-9_.-]+)$/i)
  if (deepMatch?.[1]) return `flow-${peerSocial.normalizeUsername ? peerSocial.normalizeUsername(deepMatch[1]) : deepMatch[1].toLowerCase()}`
  return value
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('read file failed'))
    reader.readAsDataURL(file)
  })
}

const ICONS = {
  play: '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5v14l11-7Z"/></svg>',
  pause: '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6v12"/><path d="M15 6v12"/></svg>',
  plus: '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
  close: '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'
}
const HEART_OUTLINE = '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-4.35-9.5-8A5.5 5.5 0 0 1 12 5.1 5.5 5.5 0 0 1 21.5 13c-2.5 3.65-9.5 8-9.5 8Z"/></svg>'
const HEART_FILLED = '<svg class="ui-icon" viewBox="0 0 24 24" fill="currentColor" fill-opacity="0.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-4.35-9.5-8A5.5 5.5 0 0 1 12 5.1 5.5 5.5 0 0 1 21.5 13c-2.5 3.65-9.5 8-9.5 8Z"/></svg>'

// в”Ђв”Ђв”Ђ VISUAL SETTINGS в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
const defaultVisual = {
  bgType: 'gradient',      // 'gradient' | 'cover' | 'custom'
  blur: 18, bright: 20, glass: 8, panelBlur: 24,
  accent: '#4b5563', accent2: '#9ca3af',
  orb1Color: '#4b5563',
  orb2Color: '#9ca3af',
  visualMode: 'minimal',   // 'minimal' | 'premium'
  fontMode: 'default',
  customFontName: null,
  customFontData: null,
  customFontApplyTitle: false,
  uiScale: 100,
  customBg: null,
  homeSliderStyle: 'line',
  homeWidget: { enabled: true, mode: 'bars', image: null },
  effects: { orbs: false, glow: true, dyncolor: false, accentFromCover: false },
  navActiveHighlight: false,
  sidebarPosition: 'left',
  gifMode: { bg: true, track: true, playlist: true },
  lyrics: { scrollMode: 'smooth', align: 'left', size: 16, blur: 4 }
}

function getVisual() {
  try { return Object.assign({}, defaultVisual, JSON.parse(localStorage.getItem('flow_visual') || '{}')) }
  catch { return { ...defaultVisual } }
}

function saveVisual(patch) {
  const v = getVisual()
  const updated = Object.assign(v, patch)
  localStorage.setItem('flow_visual', JSON.stringify(updated))
  return updated
}

function syncFontControls() {
  const v = getVisual()
  const mode = v.fontMode === 'custom' ? 'custom' : 'default'
  const bDefault = document.getElementById('font-mode-default')
  const bCustom = document.getElementById('font-mode-custom')
  if (bDefault) bDefault.classList.toggle('active', mode === 'default')
  if (bCustom) bCustom.classList.toggle('active', mode === 'custom')
  const toggle = document.getElementById('toggle-font-title')
  if (toggle) toggle.classList.toggle('active', Boolean(v.customFontApplyTitle))
  const status = document.getElementById('custom-font-status')
  if (status) {
    if (mode === 'custom' && v.customFontName) status.textContent = `Свой шрифт: ${v.customFontName}`
    else status.textContent = 'Используется системный шрифт'
  }
}

function applyFontSettings(silent = true) {
  const root = document.documentElement
  const v = getVisual()
  const setDefault = () => {
    root.style.setProperty('--font-ui', "'DM Sans', sans-serif")
    root.style.setProperty('--font-title', "'Syne', sans-serif")
  }
  const useCustom = v.fontMode === 'custom' && Boolean(v.customFontData)
  if (!useCustom) {
    setDefault()
    syncFontControls()
    return
  }
  const applyVars = () => {
    root.style.setProperty('--font-ui', "'FlowCustomFont', 'DM Sans', sans-serif")
    const titleFont = v.customFontApplyTitle ? "'FlowCustomFont', 'Syne', sans-serif" : "'Syne', sans-serif"
    root.style.setProperty('--font-title', titleFont)
  }
  if (_customFontLoadedKey === v.customFontData) {
    applyVars()
    syncFontControls()
    return
  }
  try {
    const ff = new FontFace('FlowCustomFont', `url("${v.customFontData}")`)
    ff.load().then((loaded) => {
      document.fonts.add(loaded)
      _customFontLoadedKey = v.customFontData
      applyVars()
      syncFontControls()
      if (!silent) showToast('Свой шрифт применён')
    }).catch(() => {
      setDefault()
      syncFontControls()
      if (!silent) showToast('Не удалось загрузить шрифт, оставлен стандартный', true)
    })
  } catch {
    setDefault()
    syncFontControls()
    if (!silent) showToast('Не удалось загрузить шрифт, оставлен стандартный', true)
  }
}

function setFontMode(mode) {
  const safe = mode === 'custom' ? 'custom' : 'default'
  saveVisual({ fontMode: safe })
  applyFontSettings(false)
}

function setCustomFont(input) {
  const file = input?.files?.[0]
  if (!file) return
  const okExt = /\.(ttf|otf|woff2?|TTF|OTF|WOFF2?)$/.test(file.name || '')
  if (!okExt) {
    showToast('Поддерживаются .ttf / .otf / .woff / .woff2', true)
    input.value = ''
    return
  }
  const reader = new FileReader()
  reader.onload = (e) => {
    const data = e.target?.result || null
    if (!data) return
    _customFontLoadedKey = ''
    saveVisual({ customFontData: data, customFontName: file.name, fontMode: 'custom' })
    applyFontSettings(false)
    input.value = ''
  }
  reader.readAsDataURL(file)
}

function clearCustomFont() {
  _customFontLoadedKey = ''
  saveVisual({ customFontData: null, customFontName: null, fontMode: 'default' })
  applyFontSettings(false)
}

function toggleCustomFontTitle() {
  const v = getVisual()
  saveVisual({ customFontApplyTitle: !Boolean(v.customFontApplyTitle) })
  applyFontSettings(false)
}

function applyVisualMode(mode) {
  const safe = mode === 'premium' ? 'premium' : 'minimal'
  document.body.classList.remove('visual-minimal', 'visual-premium')
  document.body.classList.add(`visual-${safe}`)
  const minimalBtn = document.getElementById('vm-minimal')
  const premiumBtn = document.getElementById('vm-premium')
  if (minimalBtn) minimalBtn.classList.toggle('active', safe === 'minimal')
  if (premiumBtn) premiumBtn.classList.toggle('active', safe === 'premium')
}

function setVisualMode(mode) {
  const safe = mode === 'premium' ? 'premium' : 'minimal'
  saveVisual({ visualMode: safe })
  applyVisualMode(safe)
  showToast(safe === 'premium' ? 'Режим: Премиум (старый)' : 'Режим: Минимализм')
}

function savePlaybackMode() {
  localStorage.setItem('flow_playback_mode', JSON.stringify(playbackMode))
}

function getTrackKey(track) {
  if (!track) return ''
  const src = String(track.source || 'unknown')
  if (track.id) return `${src}:${String(track.id)}`
  const title = String(track.title || '').trim().toLowerCase()
  const artist = String(track.artist || '').trim().toLowerCase()
  return `${src}:${title}::${artist}`
}

function getTrackCoverKeys(track) {
  if (!track) return []
  const src = String(track.source || 'unknown')
  const title = String(track.title || '').trim().toLowerCase()
  const artist = String(track.artist || '').trim().toLowerCase()
  const norm = (v) => String(v || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim()
  const normTitle = norm(title)
  const normArtist = norm(artist)
  const keys = []
  if (track.id) keys.push(`${src}:${String(track.id)}`)
  if (track.ytId) keys.push(`youtube:yt:${String(track.ytId)}`)
  if (track.spotifyId) keys.push(`spotify:sp:${String(track.spotifyId)}`)
  if (title || artist) {
    keys.push(`${src}:${title}::${artist}`)
    keys.push(`meta:${title}::${artist}`)
    keys.push(`title:${title}`)
    if (normTitle || normArtist) {
      keys.push(`norm:${normTitle}::${normArtist}`)
      keys.push(`norm-title:${normTitle}`)
    }
  }
  return [...new Set(keys.filter(Boolean))]
}

function normalizeTrackSignature(track) {
  const norm = (v) => String(v || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const t = norm(track?.title)
  const a = norm(track?.artist)
  return `${t}::${a}`
}

function isSameTrackLoose(a, b) {
  if (!a || !b) return false
  const aKeys = new Set(getTrackCoverKeys(a))
  const bKeys = getTrackCoverKeys(b)
  if (bKeys.some((k) => aKeys.has(k))) return true
  return normalizeTrackSignature(a) === normalizeTrackSignature(b)
}

function applyCustomCoverToCollections(baseTrack, coverUrl) {
  if (!baseTrack || !coverUrl) return
  const applyToArray = (arr) => {
    if (!Array.isArray(arr)) return
    arr.forEach((t) => {
      if (!t || typeof t !== 'object') return
      if (isSameTrackLoose(baseTrack, t)) t.cover = coverUrl
    })
  }
  applyToArray(queue)
  applyToArray(sharedQueue)
  if (currentTrack && isSameTrackLoose(baseTrack, currentTrack)) currentTrack.cover = coverUrl

  const liked = getLiked()
  applyToArray(liked)
  localStorage.setItem('flow_liked', JSON.stringify(liked))

  const playlists = getPlaylists().map(normalizePlaylist)
  playlists.forEach((pl) => applyToArray(pl.tracks))
  savePlaylists(playlists)
}

function getCustomCoverMap() {
  try { return JSON.parse(localStorage.getItem('flow_track_covers') || '{}') || {} }
  catch { return {} }
}

function saveCustomCoverMap(map) {
  localStorage.setItem('flow_track_covers', JSON.stringify(map || {}))
}

function getGlobalCustomCover(map = null) {
  const sourceMap = map || getCustomCoverMap()
  return String(sourceMap?.__global__ || '').trim()
}

function isGifUrl(url) {
  const v = String(url || '').toLowerCase()
  return v.startsWith('data:image/gif') || /\.gif($|\?)/i.test(v)
}

function sanitizeMediaByGifMode(url, category) {
  const v = getVisual()
  const mode = v.gifMode || {}
  if ((mode[category] ?? true) === false && isGifUrl(url)) return ''
  return url
}

function getEffectiveCoverUrl(track) {
  const map = getCustomCoverMap()
  const globalCustom = getGlobalCustomCover(map)
  // User-selected custom cover (especially GIF) should never be dropped by gifMode filter.
  if (globalCustom) return String(globalCustom).trim()
  const keys = getTrackCoverKeys(track)
  const custom = keys.map((k) => map[k]).find(Boolean)
  if (custom) return String(custom).trim()
  return sanitizeMediaByGifMode(track?.cover || '', 'track')
}

function getListCoverUrl(track) {
  // Lists/queues should display source artwork; custom cover is playback-only.
  const map = getCustomCoverMap()
  const globalCustom = getGlobalCustomCover(map)
  const sourceCover = String(track?._sourceCover || track?.sourceCover || track?.originalCover || '').trim()
  const rawCover = String(track?.cover || '').trim()
  let safeCover = sourceCover || rawCover
  const isDataImage = /^data:image\//i.test(safeCover)
  // Data URL in lists is usually injected custom cover; hide/replace it outside player.
  if (isDataImage && String(track?.source || '').toLowerCase() !== 'local') {
    safeCover = sourceCover || ''
  }
  if (globalCustom && safeCover && safeCover === globalCustom) return ''
  return sanitizeMediaByGifMode(safeCover, 'track')
}

function restoreSourceCoversInCollections() {
  const normalize = (arr) => {
    if (!Array.isArray(arr)) return false
    let changed = false
    arr.forEach((t) => {
      if (!t || typeof t !== 'object') return
      const cover = String(t.cover || '').trim()
      const backup = String(t._sourceCover || t.sourceCover || t.originalCover || '').trim()
      const isDataImage = /^data:image\//i.test(cover)
      if (isDataImage && String(t.source || '').toLowerCase() !== 'local') {
        const next = backup || ''
        if (cover !== next) {
          t.cover = next
          changed = true
        }
      }
    })
    return changed
  }

  normalize(queue)
  normalize(sharedQueue)

  const liked = getLiked()
  if (normalize(liked)) localStorage.setItem('flow_liked', JSON.stringify(liked))

  const playlists = getPlaylists().map(normalizePlaylist)
  let playlistsChanged = false
  playlists.forEach((pl) => {
    if (normalize(pl.tracks)) playlistsChanged = true
  })
  if (playlistsChanged) savePlaylists(playlists)
}

const COVER_CACHE_DB_NAME = 'flow_cover_cache'
const COVER_CACHE_STORE = 'covers'
const COVER_CACHE_MAX_ITEMS = 500
let _coverCacheDbPromise = null
const _coverObjectUrlMap = new Map()

function openCoverCacheDb() {
  if (_coverCacheDbPromise) return _coverCacheDbPromise
  _coverCacheDbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(COVER_CACHE_DB_NAME, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(COVER_CACHE_STORE)) {
          const store = db.createObjectStore(COVER_CACHE_STORE, { keyPath: 'key' })
          store.createIndex('updatedAt', 'updatedAt', { unique: false })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return _coverCacheDbPromise
}

function coverCacheTx(db, mode, runner) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(COVER_CACHE_STORE, mode)
      const store = tx.objectStore(COVER_CACHE_STORE)
      runner(store, resolve)
      tx.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

function coverCacheKey(url, trackId = '') {
  return `${String(trackId || 'global')}::${String(url || '').trim()}`
}

async function enforceCoverCacheLimit(db) {
  if (!db) return
  await coverCacheTx(db, 'readonly', (store, done) => {
    const countReq = store.count()
    countReq.onsuccess = async () => {
      const total = Number(countReq.result || 0)
      const overflow = total - COVER_CACHE_MAX_ITEMS
      if (overflow <= 0) return done(true)
      await coverCacheTx(db, 'readwrite', (rwStore, doneRw) => {
        const idx = rwStore.index('updatedAt')
        const cursorReq = idx.openCursor()
        let removed = 0
        cursorReq.onsuccess = (ev) => {
          const cursor = ev.target.result
          if (!cursor || removed >= overflow) return doneRw(true)
          const val = cursor.value
          if (val?.key) rwStore.delete(val.key)
          removed += 1
          cursor.continue()
        }
        cursorReq.onerror = () => doneRw(null)
      })
      done(true)
    }
    countReq.onerror = () => done(null)
  })
}

async function getAndCacheCover(url, trackId = '') {
  const raw = String(url || '').trim()
  if (!raw) return ''
  if (raw.startsWith('data:image/')) return raw
  const key = coverCacheKey(raw, trackId)
  const db = await openCoverCacheDb()
  if (!db) return raw

  const fromCache = await coverCacheTx(db, 'readwrite', (store, done) => {
    const req = store.get(key)
    req.onsuccess = () => {
      const row = req.result
      if (!row?.blob) return done(null)
      row.updatedAt = Date.now()
      try { store.put(row) } catch {}
      done(row.blob)
    }
    req.onerror = () => done(null)
  })
  if (fromCache instanceof Blob) {
    const prev = _coverObjectUrlMap.get(key)
    if (prev) return prev
    const objectUrl = URL.createObjectURL(fromCache)
    _coverObjectUrlMap.set(key, objectUrl)
    return objectUrl
  }

  try {
    const resp = await fetch(raw)
    if (!resp.ok) return raw
    const blob = await resp.blob()
    await coverCacheTx(db, 'readwrite', (store, done) => {
      try {
        store.put({ key, url: raw, trackId: String(trackId || ''), updatedAt: Date.now(), blob })
      } catch {}
      done(true)
    })
    await enforceCoverCacheLimit(db)
    const prev = _coverObjectUrlMap.get(key)
    if (prev) return prev
    const objectUrl = URL.createObjectURL(blob)
    _coverObjectUrlMap.set(key, objectUrl)
    return objectUrl
  } catch {
    return raw
  }
}

function applyCachedCoverBackground(el, coverUrl, fallbackBg, trackId = '') {
  if (!el) return
  const url = String(coverUrl || '').trim()
  if (!url) {
    el.style.backgroundImage = ''
    if (fallbackBg) el.style.background = fallbackBg
    el.innerHTML = COVER_ICON
    return
  }
  const token = `${Date.now()}_${Math.random()}`
  el.dataset.coverToken = token
  getAndCacheCover(url, trackId).then((cachedUrl) => {
    if (!cachedUrl || el.dataset.coverToken !== token) return
    el.style.background = ''
    el.style.backgroundImage = `url(${cachedUrl})`
    el.style.backgroundSize = 'cover'
    el.style.backgroundPosition = 'center'
    if (el.innerHTML === COVER_ICON) el.innerHTML = ''
  }).catch(() => {})
}

function applyCoverArt(el, coverUrl, fallbackBg) {
  if (!el) return
  const url = String(coverUrl || '').trim()
  if (!url) {
    el.style.backgroundImage = ''
    if (fallbackBg) el.style.background = fallbackBg
    el.innerHTML = COVER_ICON
    return
  }
  const cached = _coverLoadState.get(url)
  if (cached === false) {
    el.style.backgroundImage = ''
    if (fallbackBg) el.style.background = fallbackBg
    el.innerHTML = COVER_ICON
    return
  }
  const token = `${Date.now()}_${Math.random()}`
  el.dataset.coverToken = token
  getAndCacheCover(url, '').then((cachedUrl) => {
    if (!cachedUrl) throw new Error('no cover')
    _coverLoadState.set(url, true)
    if (el.dataset.coverToken !== token) return
    el.style.opacity = '0.35'
    el.style.background = ''
    el.style.backgroundImage = `url(${cachedUrl})`
    el.style.backgroundSize = 'cover'
    el.style.backgroundPosition = 'center'
    el.innerHTML = ''
    requestAnimationFrame(() => { el.style.opacity = '1' })
  }).catch(() => {
    _coverLoadState.set(url, false)
    if (el.dataset.coverToken !== token) return
    el.style.backgroundImage = ''
    if (fallbackBg) el.style.background = fallbackBg
    el.innerHTML = COVER_ICON
  })
}

function applyVisualSettings() {
  const blur   = document.getElementById('vs-blur')?.value ?? 40
  const bright = document.getElementById('vs-bright')?.value ?? 50
  const glass  = document.getElementById('vs-glass')?.value ?? 8
  const pb     = document.getElementById('vs-panel-blur')?.value ?? 30
  const scale  = document.getElementById('vs-scale')?.value ?? 100

  document.getElementById('vs-blur-val').textContent   = blur + 'px'
  document.getElementById('vs-bright-val').textContent = bright + '%'
  document.getElementById('vs-glass-val').textContent  = glass + '%'
  document.getElementById('vs-panel-blur-val').textContent = pb + 'px'
  if (document.getElementById('vs-scale-val')) document.getElementById('vs-scale-val').textContent = scale + '%'

  const v = getVisual()
  saveVisual({ blur:+blur, bright:+bright, glass:+glass, panelBlur:+pb, uiScale:+scale })

  document.documentElement.style.setProperty('--glass-blur', pb + 'px')
  document.documentElement.style.setProperty('--glass-bg', `rgba(255,255,255,${glass/100})`)
  document.documentElement.style.setProperty('--ui-scale', String((+scale || 100) / 100))

  const bgBlur = document.getElementById('bg-cover-blur')
  if (bgBlur) bgBlur.style.filter = `blur(${blur}px) brightness(${bright/100})`

  const bgLayer = document.getElementById('bg-layer')
  if (bgLayer) bgLayer.style.filter = `blur(${blur}px) brightness(${bright/100})`
  applyHomeSliderStyle()
}

function setBgType(type) {
  saveVisual({ bgType: type })
  document.querySelectorAll('[id^="bgt-"]').forEach(b => b.classList.remove('active'))
  document.getElementById('bgt-' + type)?.classList.add('active')
  document.getElementById('custom-bg-row').style.display = type === 'custom' ? 'flex' : 'none'
  refreshCustomBgPreview()
  updateBackground()
}

function toggleGifMode(category) {
  const v = getVisual()
  const gifMode = Object.assign({ bg: true, track: true, playlist: true }, v.gifMode || {})
  gifMode[category] = !Boolean(gifMode[category])
  saveVisual({ gifMode })
  initVisualSettings()
  syncPlayerUIFromTrack()
  syncPlayerModeUI()
  renderPlaylists()
}

function updateBackground() {
  const v = getVisual()
  const coverBlur = document.getElementById('bg-cover-blur')
  const blur = v.blur, bright = v.bright

  if (v.bgType === 'custom' && v.customBg) {
    const customBg = sanitizeMediaByGifMode(v.customBg, 'bg')
    coverBlur.style.backgroundImage = customBg ? `url(${customBg})` : ''
    coverBlur.style.opacity = customBg ? '1' : '0'
    coverBlur.style.filter = `blur(${blur}px) brightness(${bright/100})`
  } else if (v.bgType === 'cover' && currentTrack) {
    const coverUrl = sanitizeMediaByGifMode(getEffectiveCoverUrl(currentTrack), 'bg')
    if (!coverUrl) {
      coverBlur.style.opacity = '0'
      coverBlur.style.backgroundImage = ''
      return
    }
    coverBlur.style.backgroundImage = `url(${coverUrl})`
    coverBlur.style.opacity = '1'
    coverBlur.style.filter = `blur(${blur}px) brightness(${bright/100})`
  } else {
    coverBlur.style.opacity = '0'
    coverBlur.style.backgroundImage = ''
  }
}

function loadCustomBg(input) {
  const file = input.files[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = e => {
    saveVisual({ customBg: e.target.result })
    refreshCustomBgPreview(file.name)
    updateBackground()
    showToast('Фон установлен')
  }
  reader.readAsDataURL(file)
}

function pickCustomBgMedia(kind = 'image') {
  const input = document.getElementById('custom-bg-input')
  if (!input) return
  input.accept = kind === 'gif' ? '.gif,image/gif' : 'image/*'
  input.click()
}

function clearCustomBg() {
  saveVisual({ customBg: null })
  refreshCustomBgPreview()
  updateBackground()
  showToast('Фон убран')
}

function setMediaPreviewBox(prefix, mediaUrl, text, keepVisible = false) {
  const box = document.getElementById(`${prefix}-preview-box`)
  const thumb = document.getElementById(`${prefix}-preview-thumb`)
  const sub = document.getElementById(`${prefix}-preview-text`)
  if (!box || !thumb || !sub) return
  const hasMedia = Boolean(mediaUrl)
  box.classList.toggle('hidden', !hasMedia && !keepVisible)
  thumb.style.backgroundImage = hasMedia ? `url(${mediaUrl})` : ''
  sub.textContent = text || (hasMedia ? 'Выбран файл' : 'Ничего не выбрано')
}

function refreshCustomBgPreview(fileName = '') {
  const v = getVisual()
  const media = v.customBg || ''
  const label = fileName || (media ? 'Текущий пользовательский фон' : 'Ничего не выбрано')
  setMediaPreviewBox('custom-bg', media, label)
}

function setHomeSliderStyle(style) {
  saveVisual({ homeSliderStyle: style === 'wave' ? 'wave' : 'line' })
  applyHomeSliderStyle()
}

function applyHomeSliderStyle() {
  const v = getVisual()
  const style = v.homeSliderStyle === 'wave' ? 'wave' : 'line'
  const p = document.getElementById('home-clone-progress')
  if (p) p.classList.toggle('home-slider-wave', style === 'wave')
  const b1 = document.getElementById('slider-style-line')
  const b2 = document.getElementById('slider-style-wave')
  if (b1) b1.classList.toggle('active', style === 'line')
  if (b2) b2.classList.toggle('active', style === 'wave')
}

function toggleHomeWidgetEnabled() {
  const v = getVisual()
  const homeWidget = Object.assign({ enabled: true, mode: 'bars', image: null }, v.homeWidget || {})
  homeWidget.enabled = !homeWidget.enabled
  saveVisual({ homeWidget })
  syncHomeWidgetUI()
}

function setHomeWidgetMode(mode) {
  const modes = ['bars', 'wave', 'dots', 'image']
  const safe = modes.includes(mode) ? mode : 'bars'
  const v = getVisual()
  const homeWidget = Object.assign({ enabled: true, mode: 'bars', image: null }, v.homeWidget || {})
  homeWidget.mode = safe
  saveVisual({ homeWidget })
  syncHomeWidgetUI()
}

function setHomeWidgetImage(input) {
  const file = input?.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = (e) => {
    const v = getVisual()
    const homeWidget = Object.assign({ enabled: true, mode: 'image', image: null }, v.homeWidget || {})
    homeWidget.image = e.target?.result || null
    homeWidget.mode = 'image'
    saveVisual({ homeWidget })
    syncHomeWidgetUI()
    input.value = ''
  }
  reader.readAsDataURL(file)
}

function clearHomeWidgetImage() {
  const v = getVisual()
  const homeWidget = Object.assign({ enabled: true, mode: 'bars', image: null }, v.homeWidget || {})
  homeWidget.image = null
  if (homeWidget.mode === 'image') homeWidget.mode = 'bars'
  saveVisual({ homeWidget })
  syncHomeWidgetUI()
}

function syncHomeWidgetUI() {
  const v = getVisual()
  const hw = Object.assign({ enabled: true, mode: 'bars', image: null }, v.homeWidget || {})
  const wrap = document.getElementById('home-visualizer-wrap')
  const img = document.getElementById('home-visualizer-image')
  const canvas = document.getElementById('home-visualizer-canvas')
  if (wrap) wrap.classList.toggle('hidden', !hw.enabled)
  if (img) {
    img.classList.toggle('hidden', hw.mode !== 'image' || !hw.image)
    img.style.backgroundImage = hw.image ? `url(${hw.image})` : ''
  }
  if (canvas) canvas.style.display = hw.mode === 'image' ? 'none' : 'block'
  const t = document.getElementById('toggle-home-widget')
  if (t) t.classList.toggle('active', hw.enabled)
  ;['bars','wave','dots','image'].forEach((m) => {
    const el = document.getElementById('hw-mode-' + m)
    if (el) el.classList.toggle('active', hw.mode === m)
  })
  const imageRow = document.getElementById('home-widget-image-row')
  if (imageRow) imageRow.style.display = hw.mode === 'image' ? 'flex' : 'none'
}

function setAccent(a1, a2) {
  saveVisual({ accent: a1, accent2: a2, orb1Color: a1, orb2Color: a2 })
  document.documentElement.style.setProperty('--accent', a1)
  document.documentElement.style.setProperty('--accent2', a2)
  document.querySelectorAll('.vscol').forEach(b => b.classList.remove('active'))
  // highlight active
  document.querySelectorAll('.vscol').forEach(b => {
    if (b.title && b.style.background.includes(a1.replace('#',''))) b.classList.add('active')
  })
  // update gorb colors
  document.getElementById('gorb1').style.background = `radial-gradient(circle,${a1},transparent 70%)`
  document.getElementById('gorb2').style.background = `radial-gradient(circle,${a2},transparent 70%)`
  const o1 = document.getElementById('orb1-color')
  const o2 = document.getElementById('orb2-color')
  if (o1) o1.value = a1
  if (o2) o2.value = a2
}

function setOrbColor(idx, color) {
  const v = getVisual()
  if (idx === 1) saveVisual({ orb1Color: color })
  if (idx === 2) saveVisual({ orb2Color: color })
  const c1 = idx === 1 ? color : (v.orb1Color || v.accent)
  const c2 = idx === 2 ? color : (v.orb2Color || v.accent2)
  const g1 = document.getElementById('gorb1')
  const g2 = document.getElementById('gorb2')
  if (g1) g1.style.background = `radial-gradient(circle,${c1},transparent 70%)`
  if (g2) g2.style.background = `radial-gradient(circle,${c2},transparent 70%)`
}

function toggleEffect(name) {
  const v = getVisual()
  const effects = Object.assign({ orbs: true, glow: true, dyncolor: true, accentFromCover: false }, v.effects || {})
  effects[name] = !effects[name]
  saveVisual({ effects })
  const btn = document.getElementById('toggle-' + name)
  if (btn) btn.classList.toggle('active', effects[name])
  applyEffects(effects)
  if (name === 'accentFromCover') {
    if (effects.accentFromCover) {
      const cover = getEffectiveCoverUrl(currentTrack)
      if (cover) updateOrbsFromCover(cover)
    } else {
      document.documentElement.style.setProperty('--accent', v.accent || defaultVisual.accent)
      document.documentElement.style.setProperty('--accent2', v.accent2 || defaultVisual.accent2)
    }
  }
}

function applyEffects(effects) {
  const orbs = document.getElementById('bg-gradient-orbs')
  if (orbs) orbs.style.opacity = effects.orbs ? '1' : '0'
}

function updateOrbsFromCover(coverUrl) {
  const v = getVisual()
  const effects = Object.assign({ dyncolor: false, accentFromCover: false }, v.effects || {})
  if ((!effects.dyncolor && !effects.accentFromCover) || !coverUrl) return
  // Extract color via canvas pixel sampling
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.onload = () => {
    try {
      const c = document.createElement('canvas')
      c.width = 8; c.height = 8
      const ctx = c.getContext('2d')
      ctx.drawImage(img, 0, 0, 8, 8)
      const d = ctx.getImageData(0, 0, 8, 8).data
      // Average color from corners
      const r = Math.round((d[0] + d[28] + d[224] + d[252]) / 4)
      const g = Math.round((d[1] + d[29] + d[225] + d[253]) / 4)
      const b = Math.round((d[2] + d[30] + d[226] + d[254]) / 4)
      const c1 = `rgb(${r},${g},${b})`
      const c2 = `rgb(${Math.min(255,r+60)},${Math.min(255,g+30)},${Math.min(255,b+80)})`
      if (effects.dyncolor) {
        document.getElementById('gorb1').style.background = `radial-gradient(circle,${c1},transparent 70%)`
        document.getElementById('gorb2').style.background = `radial-gradient(circle,${c2},transparent 70%)`
      }
      if (effects.accentFromCover) {
        document.documentElement.style.setProperty('--accent', c1)
        document.documentElement.style.setProperty('--accent2', c2)
      }
      if (document.getElementById('pm-cover-glow')) {
        document.getElementById('pm-cover-glow').style.background = `radial-gradient(circle,${c1},transparent 70%)`
      }
      if (v.bgType === 'cover') updateBackground()
    } catch(e) {}
  }
  img.src = coverUrl
}

function initVisualSettings() {
  const v = getVisual()
  // Apply sliders
  const setSlider = (id, val) => { const el = document.getElementById(id); if (el) el.value = val }
  setSlider('vs-blur', v.blur)
  setSlider('vs-bright', v.bright)
  setSlider('vs-glass', v.glass)
  setSlider('vs-panel-blur', v.panelBlur)
  setSlider('vs-scale', v.uiScale || 100)
  // Labels
  if (document.getElementById('vs-blur-val')) document.getElementById('vs-blur-val').textContent = v.blur + 'px'
  if (document.getElementById('vs-bright-val')) document.getElementById('vs-bright-val').textContent = v.bright + '%'
  if (document.getElementById('vs-glass-val')) document.getElementById('vs-glass-val').textContent = v.glass + '%'
  if (document.getElementById('vs-panel-blur-val')) document.getElementById('vs-panel-blur-val').textContent = v.panelBlur + 'px'
  if (document.getElementById('vs-scale-val')) document.getElementById('vs-scale-val').textContent = (v.uiScale || 100) + '%'
  // CSS vars
  document.documentElement.style.setProperty('--accent', v.accent)
  document.documentElement.style.setProperty('--accent2', v.accent2)
  document.documentElement.style.setProperty('--glass-blur', v.panelBlur + 'px')
  document.documentElement.style.setProperty('--glass-bg', `rgba(255,255,255,${v.glass/100})`)
  document.documentElement.style.setProperty('--ui-scale', String((v.uiScale || 100) / 100))
  applyVisualMode(v.visualMode || 'minimal')
  // BG type buttons
  document.querySelectorAll('[id^="bgt-"]').forEach(b => b.classList.remove('active'))
  document.getElementById('bgt-' + (v.bgType || 'gradient'))?.classList.add('active')
  document.getElementById('custom-bg-row').style.display = v.bgType === 'custom' ? 'flex' : 'none'
  // Effects toggles
  const eff = Object.assign({}, defaultVisual.effects, v.effects || {})
  Object.keys(eff).forEach(k => {
    const btn = document.getElementById('toggle-' + k)
    if (btn) btn.classList.toggle('active', eff[k])
  })
  applyEffects(eff)
  const orb1 = v.orb1Color || v.accent
  const orb2 = v.orb2Color || v.accent2
  const g1 = document.getElementById('gorb1')
  const g2 = document.getElementById('gorb2')
  if (g1) g1.style.background = `radial-gradient(circle,${orb1},transparent 70%)`
  if (g2) g2.style.background = `radial-gradient(circle,${orb2},transparent 70%)`
  const o1 = document.getElementById('orb1-color')
  const o2 = document.getElementById('orb2-color')
  if (o1) o1.value = orb1
  if (o2) o2.value = orb2
  applyFontSettings(true)
  applyHomeSliderStyle()
  syncHomeWidgetUI()
  document.body.classList.toggle('nav-active-highlight', Boolean(v.navActiveHighlight))
  const navToggle = document.getElementById('toggle-nav-active')
  if (navToggle) navToggle.classList.toggle('active', Boolean(v.navActiveHighlight))
  applySidebarPosition(v.sidebarPosition || 'left')
  const gifMode = Object.assign({ bg: true, track: true, playlist: true }, v.gifMode || {})
  const gifBg = document.getElementById('toggle-gif-bg')
  const gifTrack = document.getElementById('toggle-gif-track')
  const gifPlaylist = document.getElementById('toggle-gif-playlist')
  if (gifBg) gifBg.classList.toggle('active', Boolean(gifMode.bg))
  if (gifTrack) gifTrack.classList.toggle('active', Boolean(gifMode.track))
  if (gifPlaylist) gifPlaylist.classList.toggle('active', Boolean(gifMode.playlist))
  refreshCustomBgPreview()
  refreshTrackCoverPreview()
  applyLyricsVisualSettings()
  reorderVisualSettingsSections()
  // background filter
  const coverBlur = document.getElementById('bg-cover-blur')
  if (coverBlur) coverBlur.style.filter = `blur(${v.blur}px) brightness(${v.bright/100})`
  updateBackground()
}

function reorderVisualSettingsSections() {
  const root = document.querySelector('#stab-panel-visual .visual-settings')
  if (!root) return
  const sections = Array.from(root.querySelectorAll('.vs-section'))
  const byTitle = (title) => sections.find((s) => (s.querySelector('.vs-section-title')?.textContent || '').trim() === title)
  const bg = byTitle('Фон')
  const player = byTitle('Плеер')
  if (!bg || !player || bg.nextElementSibling === player) return
  root.insertBefore(player, bg.nextElementSibling)
}

function toggleNavActiveHighlight() {
  const v = getVisual()
  saveVisual({ navActiveHighlight: !Boolean(v.navActiveHighlight) })
  applyVisualSettings()
}

function applySidebarPosition(position) {
  const safe = position === 'top' ? 'top' : 'left'
  document.body.classList.toggle('layout-top-nav', safe === 'top')
  const sidebar = document.getElementById('sidebar')
  if (sidebar && safe === 'top') sidebar.classList.remove('collapsed')
  const leftBtn = document.getElementById('layout-left')
  const topBtn = document.getElementById('layout-top')
  if (leftBtn) leftBtn.classList.toggle('active', safe === 'left')
  if (topBtn) topBtn.classList.toggle('active', safe === 'top')
}

function setSidebarPosition(position) {
  const safe = position === 'top' ? 'top' : 'left'
  saveVisual({ sidebarPosition: safe })
  applySidebarPosition(safe)
  showToast(safe === 'top' ? 'Меню перемещено наверх' : 'Меню возвращено влево')
}

function switchSettingsTab(tab) {
  document.querySelectorAll('.stab').forEach(b => b.classList.remove('active'))
  document.querySelectorAll('.stab-panel').forEach(p => { p.classList.remove('active'); p.classList.add('hidden') })
  document.getElementById('stab-' + tab)?.classList.add('active')
  const panel = document.getElementById('stab-panel-' + tab)
  if (panel) { panel.classList.remove('hidden'); panel.classList.add('active') }
  applyUiTextOverrides()
}

// в”Ђв”Ђв”Ђ FULLSCREEN PLAYER MODE в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
function enterPlayerMode() {
  _playerModeActive = true
  const pm = document.getElementById('player-mode')
  pm.classList.remove('hidden')
  requestAnimationFrame(() => pm.classList.add('active'))
  refreshLyricsPanelsVisibility()
  syncPlayerModeUI()
}

function exitPlayerMode() {
  _playerModeActive = false
  const pm = document.getElementById('player-mode')
  pm.classList.remove('active')
  // Don't spill fullscreen lyrics panel into sidebar after exit.
  _lyricsOpen = false
  document.getElementById('lyrics-btn')?.classList.remove('active')
  document.getElementById('pm-cover-lyrics-btn')?.classList.remove('active')
  document.getElementById('pm-lyrics-controls-panel')?.classList.add('hidden')
  _lyricsSettingsOpen = false
  refreshLyricsPanelsVisibility()
  setTimeout(() => pm.classList.add('hidden'), 400)
}

function refreshLyricsPanelsVisibility() {
  const sidePanel = document.getElementById('lyrics-panel')
  const pmPanel = document.getElementById('pm-lyrics-shell')
  const pmRoot = document.getElementById('player-mode')
  if (_playerModeActive) {
    if (sidePanel) sidePanel.classList.add('hidden')
    if (pmPanel) pmPanel.classList.toggle('hidden', !_lyricsOpen)
    pmRoot?.classList.toggle('lyrics-mode', _lyricsOpen)
  } else {
    if (pmPanel) pmPanel.classList.add('hidden')
    if (sidePanel) sidePanel.classList.toggle('hidden', !_lyricsOpen)
    pmRoot?.classList.remove('lyrics-mode')
  }
}

function syncPlayerModeUI() {
  if (!_playerModeActive) return
  const t = currentTrack
  const pmCover  = document.getElementById('pm-cover')
  const pmGlow   = document.getElementById('pm-cover-glow')
  const pmBg     = document.getElementById('pm-bg')
  const pmTitle  = document.getElementById('pm-title')
  const pmArtist = document.getElementById('pm-artist')
  const pmLike   = document.getElementById('pm-like-btn')
  const pmCoverLike = document.getElementById('pm-cover-like-btn')
  const pmCoverLyrics = document.getElementById('pm-cover-lyrics-btn')
  const v = getVisual()
  const orb1 = v.orb1Color || v.accent || '#4b5563'
  const orb2 = v.orb2Color || v.accent2 || '#9ca3af'

  if (t) {
    pmTitle.textContent  = t.title || 'РќРµРёР·РІРµСЃС‚РЅРѕ'
    pmArtist.textContent = t.artist || 'вЂ”'
    const effectiveCover = getEffectiveCoverUrl(t)
    if (effectiveCover) {
      applyCoverArt(pmCover, effectiveCover, t.bg || 'linear-gradient(135deg,#7c3aed,#a855f7)')
      if (pmGlow) pmGlow.style.background = `radial-gradient(circle, ${orb1}, transparent 70%)`
      if (pmBg) {
        pmBg.style.backgroundImage = `url(${effectiveCover})`
        pmBg.style.backgroundSize = 'cover'
        pmBg.style.backgroundPosition = 'center'
        pmBg.style.backgroundColor = '#080b12'
      }
    } else {
      pmCover.style.backgroundImage = ''
      pmCover.style.background = t.bg || 'linear-gradient(135deg,#7c3aed,#a855f7)'
      pmCover.innerHTML = COVER_ICON
      if (pmGlow) pmGlow.style.background = `radial-gradient(circle, ${orb2}, transparent 70%)`
      if (pmBg) {
        pmBg.style.backgroundImage = 'none'
        pmBg.style.background = `radial-gradient(circle at 18% 24%, ${orb1}55 0%, transparent 46%), radial-gradient(circle at 82% 20%, ${orb2}44 0%, transparent 44%), linear-gradient(145deg, #07090f 0%, #0b0e15 45%, #06080d 100%)`
      }
    }
    const liked = isLiked(t)
    if (pmLike) { pmLike.innerHTML = liked ? HEART_FILLED : HEART_OUTLINE; pmLike.classList.toggle('liked', liked) }
    if (pmCoverLike) { pmCoverLike.innerHTML = liked ? HEART_FILLED : HEART_OUTLINE; pmCoverLike.classList.toggle('liked', liked) }
  }
  // play/pause icon sync
  const icon = document.getElementById('pm-play-icon')
  if (icon) icon.innerHTML = audio.paused
    ? '<polygon points="5 3 19 12 5 21 5 3"/>'
    : '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'
  // volume sync
  const pmVol = document.getElementById('pm-volume')
  if (pmVol) pmVol.value = audio.volume
  const pmCoverVol = document.getElementById('pm-cover-volume')
  if (pmCoverVol) pmCoverVol.value = audio.volume
  if (pmCoverLyrics) pmCoverLyrics.classList.toggle('active', _lyricsOpen)
}

// в”Ђв”Ђв”Ђ TIME FORMATTING в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
function fmtTime(sec) {
  if (!sec || isNaN(sec)) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2,'0')}`
}

function withTimeout(promise, ms, label = 'timeout') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms)
    Promise.resolve(promise)
      .then((v) => { clearTimeout(t); resolve(v) })
      .catch((e) => { clearTimeout(t); reject(e) })
  })
}

function looksLikeMojibake(value) {
  if (!value || typeof value !== 'string') return false
  return /(?:[ÃÂÐÑРС]{2,}|Р[А-яЁёA-Za-z0-9]|С[А-яЁёA-Za-z0-9]|Ð.|Ñ.|Ã.|Â.|рџ|вЂ|сГ|Г[А-яЁёA-Za-z0-9]|�)/.test(value)
}

function mojibakeScore(value) {
  if (!value) return 0
  let score = 0
  score += (value.match(/Р[А-яЁёA-Za-z0-9]/g) || []).length
  score += (value.match(/С[А-яЁёA-Za-z0-9]/g) || []).length
  score += (value.match(/Ð.|Ñ.|рџ|вЂ/g) || []).length
  score += (value.match(/�/g) || []).length * 3
  return score
}

function cyrillicScore(value) {
  return (value?.match(/[А-Яа-яЁё]/g) || []).length
}

const CP1251_TO_BYTE = (() => {
  const map = new Map()
  try {
    const dec = new TextDecoder('windows-1251')
    for (let b = 0; b <= 255; b++) {
      const ch = dec.decode(Uint8Array.of(b))
      if (!map.has(ch)) map.set(ch, b)
    }
  } catch {}
  return map
})()

function decodeUtf8FromCp1251Mojibake(value) {
  if (!value) return value
  const bytes = new Uint8Array(value.length)
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    const code = ch.charCodeAt(0)
    if (code < 128) {
      bytes[i] = code
      continue
    }
    if (CP1251_TO_BYTE.has(ch)) {
      bytes[i] = CP1251_TO_BYTE.get(ch)
      continue
    }
    return value
  }
  try {
    return new TextDecoder('utf-8').decode(bytes)
  } catch {
    return value
  }
}

function decodeMojibakeCandidate(value) {
  if (!looksLikeMojibake(value)) return value
  let best = value
  const candidates = []
  try {
    candidates.push(decodeUtf8FromCp1251Mojibake(value))
  } catch {}
  try {
    candidates.push(decodeURIComponent(escape(value)))
  } catch {}
  try {
    const once = decodeUtf8FromCp1251Mojibake(value)
    candidates.push(decodeUtf8FromCp1251Mojibake(once))
  } catch {}

  for (const cand of candidates) {
    if (!cand || cand === value) continue
    const curScore = mojibakeScore(best)
    const nextScore = mojibakeScore(cand)
    const betterMojibake = nextScore < curScore
    const betterCyr = cyrillicScore(cand) >= cyrillicScore(best)
    if (betterMojibake && (betterCyr || nextScore <= Math.max(0, curScore - 2))) best = cand
  }
  return best
}

const COMMON_MOJIBAKE_FIXES = [
  ['в¬Ў', '⬢'],
  ['вЂ”', '—'],
  ['в™Є', '♪'],
  ['в™Ў', '♡'],
  ['в™Ґ', '♥'],
  ['вњ•', '✕'],
  ['вњ…', '✅'],
  ['вљЎ', '⚡'],
  ['вљ™пёЏ', '⚙️'],
  ['в†©', '↩'],
  ['в†’', '→'],
  ['в–¶', '▶'],
  ['вЏё', '⏸'],
  ['вЏ®', '⏮'],
  ['вЏ­', '⏭'],
  ['в•Ќ', '╌'],
  ['в›¶', '⛶'],
  ['рџ‘‹', '👋'],
  ['рџЋµ', '🎵'],
  ['рџЋ§', '🎧'],
  ['рџ–ј', '🖼'],
  ['рџ’§', '💧'],
  ['рџЋЁ', '🎨'],
  ['рџ”„', '🔄'],
  ['рџ”¶', '🔶'],
  ['рџ”µ', '🔵'],
  ['рџ“Ѓ', '📁'],
  ['рџ”Ќ', '🔍'],
]

function applyCommonMojibakeFixes(value) {
  let out = String(value || '')
  for (const [bad, good] of COMMON_MOJIBAKE_FIXES) out = out.split(bad).join(good)
  return out
}

function hasCommonMojibakeToken(value) {
  const src = String(value || '')
  return COMMON_MOJIBAKE_FIXES.some(([bad]) => src.includes(bad))
}

function sanitizeDisplayText(value) {
  if (typeof value !== 'string') return value
  const fixed = applyCommonMojibakeFixes(decodeMojibakeCandidate(value))
  return fixed
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function sanitizeTrack(track) {
  if (!track || typeof track !== 'object') return track
  const cleanTitle = smartCleaning.smartCleanTrackTitle
    ? smartCleaning.smartCleanTrackTitle(track.title || 'Без названия')
    : (track.title || 'Без названия')
  return {
    ...track,
    title: sanitizeDisplayText(cleanTitle) || 'Без названия',
    artist: sanitizeDisplayText(track.artist || '—') || '—'
  }
}

function sanitizeTrackList(results) {
  if (!Array.isArray(results)) return []
  return results.map(sanitizeTrack)
}

function fixNodeTextMojibake(root = document.body) {
  if (!root) return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    const src = node.nodeValue
    if (looksLikeMojibake(src) || hasCommonMojibakeToken(src)) {
      const fixed = sanitizeDisplayText(src)
      if (fixed && fixed !== src) node.nodeValue = fixed
    }
    node = walker.nextNode()
  }

  const attrs = ['placeholder', 'title', 'aria-label']
  const all = root.querySelectorAll ? root.querySelectorAll('*') : []
  all.forEach((el) => {
    attrs.forEach((attr) => {
      const src = el.getAttribute(attr)
      if (!src || (!looksLikeMojibake(src) && !hasCommonMojibakeToken(src))) return
      const fixed = sanitizeDisplayText(src)
      if (fixed && fixed !== src) el.setAttribute(attr, fixed)
    })
  })
}

function enableMojibakeAutoFix() {
  fixNodeTextMojibake(document.body)
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'characterData' && m.target?.nodeValue) {
        const src = m.target.nodeValue
        if (looksLikeMojibake(src) || hasCommonMojibakeToken(src)) {
          const fixed = sanitizeDisplayText(src)
          if (fixed && fixed !== src) m.target.nodeValue = fixed
        }
      } else if (m.type === 'childList') {
        m.addedNodes.forEach((n) => {
          const nodeText = n.nodeValue || ''
          if (n.nodeType === Node.TEXT_NODE && (looksLikeMojibake(nodeText) || hasCommonMojibakeToken(nodeText))) {
            const fixed = sanitizeDisplayText(nodeText)
            if (fixed && fixed !== n.nodeValue) n.nodeValue = fixed
          }
          if (n.nodeType === Node.ELEMENT_NODE) fixNodeTextMojibake(n)
        })
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  setInterval(() => fixNodeTextMojibake(document.body), 2000)
}



// в”Ђв”Ђв”Ђ SEARCH CACHE в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
const searchCache = new Map()
const SEARCH_CACHE_TTL_MS = 2 * 60 * 1000
function cacheGet(key) {
  const entry = searchCache.get(key) || null
  if (!entry) return null
  const ts = Number(entry.ts || 0)
  if (ts && (Date.now() - ts > SEARCH_CACHE_TTL_MS)) {
    searchCache.delete(key)
    return null
  }
  return entry.val ?? null
}
function cacheSet(key, val) {
  if (searchCache.size >= 60) searchCache.delete(searchCache.keys().next().value)
  searchCache.set(key, { ts: Date.now(), val })
}

// в”Ђв”Ђв”Ђ PROVIDERS в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
const providers = {
  youtube:    (q)    => searchYouTube(q),
  spotify:    (q, s) => searchSpotify(q, s.spotifyToken),
  audius:     (q)    => searchAudius(q),
}

// в”Ђв”Ђв”Ђ SETTINGS в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
function getSettings() {
  const raw = JSON.parse(localStorage.getItem('flow_settings')) || {
    soundcloudClientId: '', vkToken: '', spotifyToken: '', yandexToken: '', activeSource: 'youtube',
    discordClientId: '', discordRpcEnabled: false, lastfmApiKey: '', lastfmSharedSecret: '', lastfmSessionKey: ''
  }
  if (!providers[raw.activeSource]) raw.activeSource = 'youtube'
  return raw
}

function saveSettingsRaw(patch) {
  const s = getSettings()
  const updated = Object.assign(s, patch)
  localStorage.setItem('flow_settings', JSON.stringify(updated))
  currentSource = updated.activeSource || 'youtube'
  updateSourceBadge()
}

function openUrl(url) {
  if (window.api?.openExternal) window.api.openExternal(url)
  else window.open(url, '_blank')
}

function toggleToken(id) {
  const inp = document.getElementById(id)
  if (inp) inp.type = inp.type === 'password' ? 'text' : 'password'
}

function switchSrcTab(tab) {
  ;['sc','vk','hm','yt','sp'].forEach(t => {
    document.getElementById('srctab-'+t)?.classList.toggle('active', t === tab)
    const p = document.getElementById('panel-'+t)
    if (p) { p.classList.toggle('hidden', t !== tab); p.classList.toggle('active', t === tab) }
  })
}

function applyScId() {
  const val = document.getElementById('sc-custom-val')?.value.trim()
  if (!val) { showToast('Р’РІРµРґРё Client ID', true); return }
  saveSettingsRaw({ soundcloudClientId: val })
  updateScStatus(val)
  showToast('SoundCloud Client ID СЃРѕС…СЂР°РЅС‘РЅ')
}

function updateScStatus(clientId) {
  const statusEl = document.getElementById('sc-status')
  if (!statusEl) return
  const display = document.getElementById('sc-active-display')
  if (clientId) {
    statusEl.className = 'token-status token-ok'
    document.getElementById('sc-status-text').textContent = 'РќР°СЃС‚СЂРѕРµРЅ'
    document.getElementById('sc-status-sub').textContent = 'Client ID СЃРѕС…СЂР°РЅС‘РЅ'
    if (display) { display.textContent = clientId.slice(0,8)+'вЂўвЂўвЂўвЂў'+clientId.slice(-4); display.style.display='block' }
  } else {
    statusEl.className = 'token-status'
    document.getElementById('sc-status-text').textContent = 'РђРІС‚РѕРјР°С‚РёС‡РµСЃРєРёР№ СЂРµР¶РёРј'
    document.getElementById('sc-status-sub').textContent = 'Client ID РёР·РІР»РµРєР°РµС‚СЃСЏ СЃРѕ СЃС‚СЂР°РЅРёС†С‹ SC'
    if (display) display.style.display = 'none'
  }
}

async function getVkToken() {
  const login = document.getElementById('vk-login')?.value.trim()
  const password = document.getElementById('vk-password')?.value
  const tokenField = document.getElementById('vk-token-val')
  const msg = document.getElementById('vk-msg')
  const btn = document.getElementById('vk-get-btn')
  const manual = tokenField?.value.trim()
  if (manual && !login) { applyVkToken(manual); return }
  if (!login || !password) { msg.textContent='Введи логин и пароль'; msg.className='token-msg token-msg-err'; return }
  btn.textContent='Получаю...'; btn.disabled=true; msg.textContent=''
  try {
    const result = window.api?.getVkToken ? await window.api.getVkToken(login, password) : { ok:false, error:'Только в Electron' }
    if (result.ok) { tokenField.value=result.token; applyVkToken(result.token); msg.textContent='Токен получен!'; msg.className='token-msg token-msg-ok' }
    else { msg.textContent=result.error||'Ошибка'; msg.className='token-msg token-msg-err' }
  } catch(e) { msg.textContent=e.message; msg.className='token-msg token-msg-err' }
  btn.textContent='Получить токен'; btn.disabled=false
}

async function startVkBrowserAuth() {
  const msg = document.getElementById('vk-msg')
  if (!window.api?.openExternal) {
    if (msg) {
      msg.textContent = 'Браузерная авторизация доступна только в Electron'
      msg.className = 'token-msg token-msg-err'
    }
    return
  }
  const clientId = '2685278'
  const authUrl = `https://oauth.vk.com/authorize?client_id=${encodeURIComponent(clientId)}&display=page&redirect_uri=${encodeURIComponent('https://oauth.vk.com/blank.html')}&scope=${encodeURIComponent('audio,offline')}&response_type=token&v=5.131`
  try {
    window.api.openExternal(authUrl)
    if (msg) {
      msg.textContent = 'Открыл VK в системном браузере. После входа скопируй URL из адресной строки (с access_token) и вставь в поле токена ниже.'
      msg.className = 'token-msg'
    }
  } catch (e) {
    if (msg) {
      msg.textContent = e?.message || 'Не удалось открыть браузер'
      msg.className = 'token-msg token-msg-err'
    }
  }
}

function applyVkToken(token) {
  if (!token) return
  const m = token.match(/access_token=([^&]+)/)
  if (m) token = m[1]
  saveSettingsRaw({ vkToken: token })
  updateVkStatus(token)
  showToast('VK токен сохранен')
}

function updateVkStatus(token) {
  const el = document.getElementById('vk-status'); if (!el) return
  const display = document.getElementById('vk-active-display')
  if (token) {
    el.className='token-status token-ok'
    document.getElementById('vk-status-text').textContent='Настроен'
    document.getElementById('vk-status-sub').textContent='Токен сохранен'
    if (display) { display.textContent=token.slice(0,6)+'****'+token.slice(-4); display.style.display='block' }
  } else {
    el.className='token-status'
    document.getElementById('vk-status-text').textContent='Не настроен'
    document.getElementById('vk-status-sub').textContent='Настройте по инструкции'
    if (display) display.style.display='none'
  }
}





function applySpotifyToken() {
  const token = document.getElementById('sp-token-val')?.value.trim()
  if (!token) { showToast('Р’РІРµРґРё С‚РѕРєРµРЅ Spotify', true); return }
  saveSettingsRaw({ spotifyToken: token }); updateSpotifyStatus(token); showToast('Spotify С‚РѕРєРµРЅ СЃРѕС…СЂР°РЅС‘РЅ вњ“')
}

function applyYandexToken() {
  const token = document.getElementById('ym-token-val')?.value.trim()
  if (!token) { showToast('Введи токен Яндекс Музыки', true); return }
  saveSettingsRaw({ yandexToken: token })
  showToast('Токен Яндекс Музыки сохранен')
}

function updateSpotifyStatus(token) {
  const el = document.getElementById('sp-status'); if (!el) return
  const display = document.getElementById('sp-active-display')
  if (token) {
    el.className='token-status token-ok'
    document.getElementById('sp-status-text').textContent='РќР°СЃС‚СЂРѕРµРЅ'
    document.getElementById('sp-status-sub').textContent='Bearer С‚РѕРєРµРЅ СЃРѕС…СЂР°РЅС‘РЅ'
    if (display) { display.textContent=token.slice(0,6)+'вЂўвЂўвЂўвЂў'+token.slice(-4); display.style.display='block' }
  } else {
    el.className='token-status'
    document.getElementById('sp-status-text').textContent='РќРµ РЅР°СЃС‚СЂРѕРµРЅ'
    document.getElementById('sp-status-sub').textContent='РќСѓР¶РµРЅ Bearer С‚РѕРєРµРЅ'
    if (display) display.style.display='none'
  }
}

function setActiveSource(src) {
  const allowed = new Set(['youtube', 'yt', 'spotify', 'soundcloud', 'sc', 'audius', 'hitmo', 'hm'])
  const raw = String(src || '').toLowerCase()
  const normalized =
    raw === 'yt' ? 'youtube' :
    raw === 'sc' ? 'soundcloud' :
    raw === 'hm' ? 'hitmo' :
    raw
  const safe = allowed.has(normalized) ? normalized : 'youtube'
  saveSettingsRaw({ activeSource: safe })
  searchCache.clear()
}

function loadSettingsPage() {
  const s = getSettings()
  const ids = { 'sc-custom-val': s.soundcloudClientId, 'vk-token-val': s.vkToken, 'sp-token-val': s.spotifyToken, 'ym-token-val': s.yandexToken }
  for (const [id, val] of Object.entries(ids)) { const el = document.getElementById(id); if (el && val) el.value = val }
  updateScStatus(s.soundcloudClientId)
  updateVkStatus(s.vkToken)
  updateSpotifyStatus(s.spotifyToken)
  // Keep settings opening snappy; run heavier sync in next frame.
  requestAnimationFrame(() => {
    syncPlaybackModeUI()
    syncTrackCoverStatus()
    setFlowConfigStatus('Экспорт создаёт JSON с визуалом, профилем, плейлистами и настройками.', false)
    syncFontControls()
    syncHomeWidgetUI()
    applyHomeSliderStyle()
  })
}

function syncPlaybackModeUI() {
  const shBtn = document.getElementById('shuffle-btn')
  const rpBtn = document.getElementById('repeat-btn')
  const homeShBtn = document.getElementById('home-shuffle-btn')
  const homeRpBtn = document.getElementById('home-repeat-btn')
  const shSettings = document.getElementById('toggle-shuffle-btn')
  const rpSettings = document.getElementById('toggle-repeat-btn')
  if (shBtn) shBtn.classList.toggle('active', Boolean(playbackMode.shuffle))
  if (homeShBtn) homeShBtn.classList.toggle('active', Boolean(playbackMode.shuffle))
  if (shSettings) {
    shSettings.textContent = playbackMode.shuffle ? 'Включена' : 'Выключена'
    shSettings.classList.toggle('active', Boolean(playbackMode.shuffle))
  }
  const repeatLabel = playbackMode.repeat === 'one' ? 'Один трек' : (playbackMode.repeat === 'all' ? 'Очередь' : 'Выкл')
  if (rpBtn) {
    rpBtn.classList.toggle('active', playbackMode.repeat !== 'off')
    rpBtn.title = `Повтор: ${repeatLabel}`
  }
  if (homeRpBtn) {
    homeRpBtn.classList.toggle('active', playbackMode.repeat !== 'off')
    homeRpBtn.title = `Повтор: ${repeatLabel}`
  }
  if (rpSettings) {
    rpSettings.textContent = repeatLabel
    rpSettings.classList.toggle('active', playbackMode.repeat !== 'off')
  }
}

function toggleShuffleMode() {
  playbackMode.shuffle = !playbackMode.shuffle
  savePlaybackMode()
  syncPlaybackModeUI()
  showToast(playbackMode.shuffle ? 'Перемешка включена' : 'Перемешка выключена')
}

function toggleRepeatMode() {
  const order = ['off', 'all', 'one']
  const idx = order.indexOf(playbackMode.repeat)
  playbackMode.repeat = order[(idx + 1) % order.length]
  savePlaybackMode()
  syncPlaybackModeUI()
  const label = playbackMode.repeat === 'one' ? 'один трек' : (playbackMode.repeat === 'all' ? 'очередь' : 'выкл')
  showToast(`Повтор: ${label}`)
}

function syncTrackCoverStatus() {
  const el = document.getElementById('track-cover-status')
  if (!el) return
  const map = getCustomCoverMap()
  const globalCustom = getGlobalCustomCover(map)
  if (globalCustom) {
    el.textContent = 'Кастомная обложка используется только в плеере'
    refreshTrackCoverPreview()
    return
  }
  if (!currentTrack) {
    el.textContent = 'Выбери трек и задай для него свою обложку'
    refreshTrackCoverPreview()
    return
  }
  const hasCustom = getTrackCoverKeys(currentTrack).some((k) => Boolean(map[k]))
  el.textContent = hasCustom ? 'Для текущего трека используется кастомная обложка' : 'Для текущего трека используется обложка из источника'
  refreshTrackCoverPreview()
}

function setCustomTrackCover(input) {
  const file = input?.files?.[0]
  if (!file) return
  if (!currentTrack) {
    showToast('Сначала включи трек', true)
    input.value = ''
    return
  }
  const reader = new FileReader()
  reader.onload = (e) => {
    const keys = getTrackCoverKeys(currentTrack)
    const map = getCustomCoverMap()
    const value = e.target?.result || ''
    map.__global__ = value
    keys.forEach((key) => { map[key] = value })
    saveCustomCoverMap(map)
    _coverLoadState.clear()
    syncPlayerUIFromTrack()
    renderQueue()
    renderPlaylists()
    renderLiked()
    renderRoomQueue()
    syncTrackCoverStatus()
    refreshTrackCoverPreview(file.name)
    showToast('Кастомная обложка сохранена для плеера')
    input.value = ''
  }
  reader.readAsDataURL(file)
}

function pickCustomTrackCover(kind = 'image') {
  const input = document.getElementById('track-cover-input')
  if (!input) return
  input.accept = kind === 'gif' ? '.gif,image/gif' : 'image/*'
  input.click()
}

function clearCustomTrackCover() {
  const map = getCustomCoverMap()
  const globalCustom = getGlobalCustomCover(map)
  const hasPerTrack = Object.keys(map).some((k) => k !== '__global__' && Boolean(map[k]))
  const hasAny = Boolean(globalCustom) || hasPerTrack
  if (!hasAny) {
    showToast('Кастомная обложка не задана', true)
    return
  }
  // Full reset: clear global and legacy per-track bindings.
  Object.keys(map).forEach((key) => { delete map[key] })
  saveCustomCoverMap(map)
  const input = document.getElementById('track-cover-input')
  if (input) input.value = ''
  restoreSourceCoversInCollections()
  _coverLoadState.clear()
  syncPlayerUIFromTrack()
  renderQueue()
  renderPlaylists()
  renderLiked()
  renderRoomQueue()
  syncTrackCoverStatus()
  refreshTrackCoverPreview()
  showToast('Кастомная обложка удалена')
}

function refreshTrackCoverPreview(fileName = '') {
  const map = getCustomCoverMap()
  const globalCustom = getGlobalCustomCover(map)
  if (globalCustom) {
    const label = fileName || 'Кастомная обложка плеера'
    setMediaPreviewBox('track-cover', globalCustom, label, true)
    return
  }
  if (!currentTrack) {
    setMediaPreviewBox('track-cover', '', 'Сначала включи трек', true)
    return
  }
  const custom = getTrackCoverKeys(currentTrack).map((k) => map[k]).find(Boolean) || ''
  const label = fileName || (custom ? `Текущий трек: ${currentTrack.title || 'Без названия'}` : 'Для этого трека обложка не задана')
  setMediaPreviewBox('track-cover', custom, label, true)
}

function setFlowConfigStatus(text, isError = false) {
  const el = document.getElementById('flow-config-status')
  if (!el) return
  el.textContent = text
  el.classList.toggle('token-msg-err', Boolean(isError))
  el.classList.toggle('token-msg-ok', !isError)
}

function collectFlowConfigPayload() {
  const storage = {}
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key || !key.startsWith('flow_')) continue
    storage[key] = localStorage.getItem(key)
  }
  return {
    format: 'flow-config-v1',
    exportedAt: new Date().toISOString(),
    storage,
  }
}

function exportFlowConfig() {
  try {
    const payload = collectFlowConfigPayload()
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const stamp = new Date().toISOString().slice(0, 10)
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `flow-config-${stamp}.json`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(link.href)
    setFlowConfigStatus('Конфиг экспортирован. Можешь отправить JSON другу.', false)
    showToast('Конфиг экспортирован')
  } catch (err) {
    setFlowConfigStatus(`Ошибка экспорта: ${err?.message || err}`, true)
    showToast('Не удалось экспортировать конфиг', true)
  }
}

function pickFlowConfigFile() {
  const input = document.getElementById('flow-config-input')
  if (!input) return
  input.click()
}

function importFlowConfigFile(input) {
  const file = input?.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result || '{}'))
      if (parsed?.format !== 'flow-config-v1' || !parsed?.storage || typeof parsed.storage !== 'object') {
        throw new Error('Неверный формат файла')
      }
      const toDelete = []
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key && key.startsWith('flow_')) toDelete.push(key)
      }
      toDelete.forEach((key) => localStorage.removeItem(key))
      Object.entries(parsed.storage).forEach(([key, value]) => {
        if (!key.startsWith('flow_')) return
        localStorage.setItem(key, String(value ?? ''))
      })
      setFlowConfigStatus('Конфиг импортирован. Перезагружаю приложение...', false)
      showToast('Конфиг импортирован')
      setTimeout(() => window.location.reload(), 250)
    } catch (err) {
      setFlowConfigStatus(`Ошибка импорта: ${err?.message || err}`, true)
      showToast('Не удалось импортировать конфиг', true)
    } finally {
      input.value = ''
    }
  }
  reader.readAsText(file)
}

function updateSourceBadge() {
  currentSource = 'hybrid'
  const txt = 'Spotify → SoundCloud → Audius'
  const b1 = document.getElementById('source-badge'); if (b1) b1.textContent = txt
  const b2 = document.getElementById('source-badge-search'); if (b2) b2.textContent = txt
}

function switchSearchSource(src) {
  showToast('Режим фиксирован: Spotify → SoundCloud → Audius')
}

function syncSearchSourcePills() {
  document.querySelectorAll('.search-source-pill').forEach(p => {
    p.classList.toggle('active', p.getAttribute('data-src') === 'hybrid')
  })
}


function showToast(msg, isError = false) {
  let t = document.getElementById('toast')
  if (!t) { t = document.createElement('div'); t.id='toast'; document.body.appendChild(t) }
  t.textContent = msg
  t.className = 'toast' + (isError ? ' toast-error' : ' toast-ok')
  t.classList.add('toast-show')
  clearTimeout(t._timer)
  t._timer = setTimeout(() => t.classList.remove('toast-show'), 2800)
}

function switchTab(tab) {
  _authMode = tab === 'register' ? 'register' : 'login'
  const loginTab = document.getElementById('tab-login')
  const registerTab = document.getElementById('tab-register')
  if (loginTab) loginTab.classList.toggle('active', _authMode === 'login')
  if (registerTab) registerTab.classList.toggle('active', _authMode === 'register')
  const btn = document.getElementById('btn-label')
  if (btn) btn.textContent = _authMode === 'register' ? 'Создать профиль' : 'Войти'
}

function setAuthError(text = '') {
  const el = document.getElementById('auth-error')
  if (el) el.textContent = text
}

function syncProfileUi() {
  const username = _profile?.username || 'слушатель'
  const nameEl = document.getElementById('user-name')
  const avatarEl = document.getElementById('user-avatar')
  const welcomeEl = document.getElementById('welcome-text')
  const custom = getProfileCustom()
  if (nameEl) nameEl.textContent = username
  if (avatarEl) {
    if (custom.avatarData) {
      avatarEl.textContent = ''
      avatarEl.style.backgroundImage = `url(${custom.avatarData})`
      avatarEl.style.backgroundSize = 'cover'
      avatarEl.style.backgroundPosition = 'center'
    } else {
      avatarEl.style.backgroundImage = ''
      avatarEl.textContent = username.slice(0, 1).toUpperCase()
    }
  }
  if (welcomeEl) welcomeEl.textContent = `Привет, ${username}`
  renderProfilePage()
}

function getProfileCustom() {
  if (!_profile?.username) return { bio: '', avatarData: null, bannerData: null, pinnedTracks: [], pinnedPlaylists: [] }
  const key = `flow_profile_custom_${_profile.username}`
  try {
    return Object.assign({ bio: '', avatarData: null, bannerData: null, pinnedTracks: [], pinnedPlaylists: [] }, JSON.parse(localStorage.getItem(key) || '{}'))
  } catch {
    return { bio: '', avatarData: null, bannerData: null, pinnedTracks: [], pinnedPlaylists: [] }
  }
}

function getPublicProfilePayload(username = _profile?.username) {
  const safe = String(username || '').trim()
  if (!safe) return null
  const key = `flow_profile_custom_${safe}`
  let custom = {}
  try { custom = JSON.parse(localStorage.getItem(key) || '{}') || {} } catch {}
  return {
    username: safe,
    peerId: _socialPeer?.peer?.id || null,
    avatarData: custom.avatarData || null,
    bannerData: custom.bannerData || null,
    bio: custom.bio || '',
    stats: getListenStats(),
    pinnedTracks: Array.isArray(custom.pinnedTracks) ? custom.pinnedTracks.slice(0, 5) : [],
    pinnedPlaylists: Array.isArray(custom.pinnedPlaylists) ? custom.pinnedPlaylists.slice(0, 5) : [],
  }
}

let _supabaseProfileSyncTimer = null
function getSupabaseClient() {
  try {
    const factory = window?.supabase?.createClient
    if (typeof factory !== 'function') return null
    const url = String(localStorage.getItem('flow_supabase_url') || '').trim()
    const key = String(localStorage.getItem('flow_supabase_key') || '').trim()
    if (!url || !key) return null
    if (!window.__flowSbProfileClient) window.__flowSbProfileClient = factory(url, key)
    return window.__flowSbProfileClient
  } catch {
    return null
  }
}

function ensureActiveProfile() {
  if (_profile?.username) return _profile
  try {
    const current = typeof peerSocial.getCurrentProfile === 'function' ? peerSocial.getCurrentProfile() : null
    if (current?.username) _profile = current
  } catch {}
  return _profile
}

async function fetchCloudPublicProfile(username) {
  const safe = String(username || '').trim().toLowerCase()
  if (!safe) return null
  try {
    const sb = getSupabaseClient()
    if (!sb) return null
    const { data } = await sb
      .from('flow_profiles')
      .select('username,avatar_data,banner_data,bio,pinned_tracks,pinned_playlists,total_tracks,total_seconds,last_seen')
      .eq('username', safe)
      .maybeSingle()
    if (!data?.username) return null
    return {
      username: String(data.username || safe),
      avatarData: data.avatar_data || null,
      bannerData: data.banner_data || null,
      bio: data.bio || '',
      pinnedTracks: Array.isArray(data.pinned_tracks) ? data.pinned_tracks.slice(0, 5) : [],
      pinnedPlaylists: Array.isArray(data.pinned_playlists) ? data.pinned_playlists.slice(0, 5) : [],
      stats: {
        totalTracks: Number(data.total_tracks || 0),
        totalSeconds: Number(data.total_seconds || 0),
      }
    }
  } catch {
    return null
  }
}

function scheduleProfileCloudSync() {
  if (!ensureActiveProfile()?.username) return
  if (_supabaseProfileSyncTimer) clearTimeout(_supabaseProfileSyncTimer)
  _supabaseProfileSyncTimer = setTimeout(async () => {
    _supabaseProfileSyncTimer = null
    try {
      const me = ensureActiveProfile()
      if (!me?.username) return
      const custom = getProfileCustom()
      const stats = getListenStats()
      const sb = getSupabaseClient()
      if (!sb) return
      await sb.from('flow_profiles').upsert({
        username: me.username,
        online: true,
        last_seen: new Date().toISOString(),
        avatar_data: custom.avatarData || null,
        banner_data: custom.bannerData || null,
        bio: custom.bio || '',
        pinned_tracks: Array.isArray(custom.pinnedTracks) ? custom.pinnedTracks.slice(0, 5) : [],
        pinned_playlists: Array.isArray(custom.pinnedPlaylists) ? custom.pinnedPlaylists.slice(0, 5) : [],
        total_tracks: Number(stats.totalTracks || 0),
        total_seconds: Number(stats.totalSeconds || 0),
      }, { onConflict: 'username' })
    } catch {}
  }, 220)
}

function stopRoomServerSync() {
  try {
    const sb = getSupabaseClient()
    if (sb && _roomServerChannel) sb.removeChannel(_roomServerChannel)
  } catch {}
  _roomServerChannel = null
  if (_roomServerHeartbeatTimer) clearInterval(_roomServerHeartbeatTimer)
  _roomServerHeartbeatTimer = null
}

async function upsertRoomMemberPresence() {
  try {
    if (!_roomState?.roomId || !_profile?.username) return
    const sb = getSupabaseClient()
    if (!sb) return
    const peerId = String(_socialPeer?.peer?.id || `flow-${_profile.username}`)
    const profile = getPublicProfilePayload(_profile.username)
    await sb.from('flow_room_members').upsert({
      room_id: _roomState.roomId,
      peer_id: peerId,
      username: _profile.username,
      profile: profile || {},
      last_seen: new Date().toISOString(),
    }, { onConflict: 'room_id,peer_id' })
  } catch {}
}

async function removeRoomMemberPresence(roomId = _roomState?.roomId) {
  try {
    const sb = getSupabaseClient()
    const peerId = String(_socialPeer?.peer?.id || '')
    if (!sb || !roomId || !peerId) return
    await sb.from('flow_room_members').delete().eq('room_id', roomId).eq('peer_id', peerId)
  } catch {}
}

async function saveRoomStateToServer(patch = {}) {
  try {
    if (!_roomState?.roomId || !_profile?.username) return
    const sb = getSupabaseClient()
    if (!sb) return
    const hostPeerId = String(_roomState.host ? (_socialPeer?.peer?.id || _roomState.roomId) : (_roomState.hostPeerId || _roomState.roomId))
    const payload = Object.assign({
      room_id: _roomState.roomId,
      host_peer_id: hostPeerId,
      shared_queue: sharedQueue,
      updated_by_peer_id: String(_socialPeer?.peer?.id || hostPeerId),
      updated_at: new Date().toISOString(),
    }, patch || {})
    await sb.from('flow_rooms').upsert(payload, { onConflict: 'room_id' })
  } catch {}
}

async function loadRoomStateFromServer() {
  try {
    if (!_roomState?.roomId) return
    const sb = getSupabaseClient()
    if (!sb) return
    const nowIso = new Date(Date.now() - 20000).toISOString()
    const [{ data: room }, { data: members }] = await Promise.all([
      sb.from('flow_rooms').select('room_id,host_peer_id,shared_queue,now_playing,playback_ts').eq('room_id', _roomState.roomId).maybeSingle(),
      sb.from('flow_room_members').select('peer_id,username,profile,last_seen').eq('room_id', _roomState.roomId).gte('last_seen', nowIso)
    ])
    if (room?.host_peer_id) _roomState.hostPeerId = String(room.host_peer_id)
    if (Array.isArray(room?.shared_queue)) {
      sharedQueue = room.shared_queue.map((t) => sanitizeTrack(t)).filter(Boolean)
      renderRoomQueue()
    }
    if (Array.isArray(members)) {
      const next = new Map()
      members.forEach((m) => {
        const pid = String(m?.peer_id || '').trim()
        if (!pid) return
        const profile = Object.assign({ username: m?.username || pid.replace(/^flow-/, '') }, m?.profile || {}, { peerId: pid })
        next.set(pid, profile)
        cachePeerProfile(profile, pid)
      })
      if (_socialPeer?.peer?.id && _profile?.username) next.set(_socialPeer.peer.id, getPublicProfilePayload(_profile.username))
      _roomMembers = next
      renderRoomMembers()
    }
    if (!_roomState.host && room?.now_playing && Number(room?.playback_ts || 0) > _lastAppliedServerPlaybackTs) {
      _lastAppliedServerPlaybackTs = Number(room.playback_ts || 0)
      const serverTrack = sanitizeTrack(room.now_playing)
      const state = room?.playback_state || {}
      if (serverTrack && serverTrack.id !== currentTrack?.id) {
        playTrackObj(serverTrack, { remoteSync: true }).catch(() => {})
      }
      const targetTime = Number(state?.currentTime || 0)
      if (Number.isFinite(targetTime) && Math.abs(Number(audio.currentTime || 0) - targetTime) > 0.6) {
        audio.currentTime = Math.max(0, targetTime)
      }
      if (state?.paused === true && !audio.paused) audio.pause()
      if (state?.paused === false && audio.paused) audio.play().catch(() => {})
    }
  } catch {}
}

function startRoomServerSync() {
  stopRoomServerSync()
  if (!_roomState?.roomId) return
  const sb = getSupabaseClient()
  if (!sb) return
  _roomServerChannel = sb.channel(`flow-room-sync:${_roomState.roomId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'flow_rooms', filter: `room_id=eq.${_roomState.roomId}` }, () => {
      loadRoomStateFromServer().catch(() => {})
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'flow_room_members', filter: `room_id=eq.${_roomState.roomId}` }, () => {
      loadRoomStateFromServer().catch(() => {})
    })
    .subscribe(() => {})
  upsertRoomMemberPresence().catch(() => {})
  loadRoomStateFromServer().catch(() => {})
  _roomServerHeartbeatTimer = setInterval(() => {
    upsertRoomMemberPresence().catch(() => {})
  }, 2500)
}

function renderRoomMembers() {
  const el = document.getElementById('room-members-list')
  if (!el) return
  if (!_roomState?.roomId) {
    el.innerHTML = '<div class="social-empty">Рума не активна</div>'
    return
  }
  const members = Array.from(_roomMembers.values()).map((m) => {
    if (!m?.username) return m
    const cached = getCachedPeerProfile(m.username)
    return cached ? Object.assign({}, cached, m) : m
  })
  // Safety fallback: if profile packets are delayed, still show connected peers.
  const connectedPeerIds = Array.from(_socialPeer?.connections?.keys?.() || [])
  connectedPeerIds.forEach((peerId) => {
    if (!peerId || _roomMembers.has(peerId)) return
    const guessedName = String(peerId).replace(/^flow-/, '') || 'user'
    members.push({
      username: guessedName,
      peerId,
      avatarData: null,
      bannerData: null,
      bio: '',
      stats: { totalTracks: 0, totalSeconds: 0 },
      pinnedTracks: [],
      pinnedPlaylists: [],
    })
  })
  if (!members.length && _profile?.username) members.push(getPublicProfilePayload(_profile.username))
  el.innerHTML = members.map((m) => {
    if (!m) return ''
    const isHost = m.peerId && m.peerId === _roomState?.hostPeerId
    const isSelfHost = !isHost && _roomState?.host && m.username === _profile?.username
    const avatar = m.avatarData
      ? `<div class="social-friend-avatar social-friend-avatar-active" style="background-image:url(${m.avatarData})"></div>`
      : `<div class="social-friend-avatar social-friend-avatar-active">${String(m.username || '?').slice(0,1).toUpperCase()}</div>`
    return `<div class="social-friend-card online">${avatar}<div class="social-friend-meta"><strong>${m.username || 'user'} ${(isHost || isSelfHost) ? '👑' : ''}</strong><span>${m.username === _profile?.username ? 'это вы' : 'в комнате'}</span></div></div>`
  }).join('') || '<div class="social-empty">Нет участников</div>'
}

function broadcastRoomMembersState() {
  if (!_socialPeer || !_roomState?.roomId || !_roomState.host) return
  const members = Array.from(_roomMembers.entries()).map(([peerId, profile]) => ({
    peerId,
    profile: profile || null,
  }))
  _socialPeer.send({
    type: 'room-members-state',
    roomId: _roomState.roomId,
    members,
  })
}

function syncRoomPresenceHeartbeat() {
  if (!_socialPeer || !_roomState?.roomId || !_profile?.username) return
  const me = getPublicProfilePayload(_profile.username)
  if (_socialPeer?.peer?.id && me) _roomMembers.set(_socialPeer.peer.id, me)
  if (_roomState.host) {
    _socialPeer.send({ type: 'room-profile-state', roomId: _roomState.roomId, profile: me, sharedQueue })
    broadcastRoomMembersState()
  } else {
    _socialPeer.send({ type: 'room-profile-state', roomId: _roomState.roomId, profile: me, sharedQueue })
    _socialPeer.send({ type: 'room-queue-sync-request', roomId: _roomState.roomId })
  }
  updateRoomUi()
}

function resetRoomHeartbeat() {
  if (_roomHeartbeatTimer) clearInterval(_roomHeartbeatTimer)
  _roomHeartbeatTimer = null
  if (!_roomState?.roomId) return
  syncRoomPresenceHeartbeat()
  _roomHeartbeatTimer = setInterval(() => syncRoomPresenceHeartbeat(), 8000)
}

function renderRoomQueue() {
  const el = document.getElementById('room-queue-list')
  if (!el) return
  if (!_roomState?.roomId || !Array.isArray(sharedQueue) || !sharedQueue.length) {
    el.innerHTML = '<div class="social-empty">Очередь пуста</div>'
    return
  }
  const canEdit = Boolean(_roomState?.host)
  el.innerHTML = ''
  sharedQueue.forEach((t, i) => {
    const row = document.createElement('div')
    row.className = 'profile-row'
    row.dataset.idx = String(i)
    if (canEdit) {
      row.draggable = true
      row.addEventListener('dragstart', (e) => {
        _sharedQueueDragIndex = i
        row.classList.add('dragging')
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
      })
      row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drag-over') })
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'))
      row.addEventListener('drop', (e) => {
        e.preventDefault()
        row.classList.remove('drag-over')
        const toIndex = Number(row.dataset.idx)
        reorderSharedQueueTrack(_sharedQueueDragIndex, toIndex)
      })
      row.addEventListener('dragend', () => {
        _sharedQueueDragIndex = -1
        row.classList.remove('drag-over')
        row.classList.remove('dragging')
      })
    }
    const coverUrl = getListCoverUrl(t)
    const cover = coverUrl
      ? `<div class="profile-row-cover" style="background-image:url(${coverUrl})"></div>`
      : `<div class="profile-row-cover profile-row-cover-fallback">♪</div>`
    const controls = canEdit
      ? `<button class="playlist-track-action danger">✕</button>`
      : ''
    row.innerHTML = `${cover}<span>${t.title} — ${t.artist || '—'}</span>${controls}`
    if (canEdit) {
      row.querySelector('button')?.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        removeSharedQueueTrack(i)
      })
    }
    el.appendChild(row)
  })
}

function broadcastQueueUpdate() {
  if (!_socialPeer || !_roomState?.roomId || !_roomState.host) return
  const eventType = peerSocial?.EVENTS?.QUEUE_UPDATE || 'queue-update'
  _socialPeer.send({
    type: eventType,
    roomId: _roomState.roomId,
    sharedQueue,
  })
  saveRoomStateToServer({ shared_queue: sharedQueue }).catch(() => {})
}

function enqueueSharedTrack(track) {
  if (!_roomState?.roomId || !track) return
  const cleanTrack = sanitizeTrack(track)
  if (_roomState.host) {
    sharedQueue.push(cleanTrack)
    renderRoomQueue()
    broadcastQueueUpdate()
    return showToast('Трек добавлен в очередь комнаты')
  }
  // Optimistic update for clients: show item in queue instantly after click.
  sharedQueue.push(cleanTrack)
  renderRoomQueue()
  showToast('Трек добавлен в очередь комнаты')

  // Server-first queue append for non-host users (reliable even when direct peer messaging fails).
  ;(async () => {
    try {
      const sb = getSupabaseClient()
      if (!sb) throw new Error('no supabase')
      const { data } = await sb.from('flow_rooms').select('shared_queue').eq('room_id', _roomState.roomId).maybeSingle()
      const nextQueue = Array.isArray(data?.shared_queue) ? data.shared_queue.slice() : []
      nextQueue.push(cleanTrack)
      await saveRoomStateToServer({ shared_queue: nextQueue })
    } catch {
      const payload = { type: 'room-queue-add', roomId: _roomState.roomId, track: cleanTrack }
      // Broadcast in room channel is more robust than direct-only messages.
      _socialPeer?.send(payload)
      if (typeof _socialPeer?.sendToPeer === 'function' && _roomState?.hostPeerId) {
        _socialPeer.sendToPeer(_roomState.hostPeerId, payload)
      }
    }
  })()
}

function removeSharedQueueTrack(index) {
  if (!_roomState?.host) return
  const idx = Number(index)
  if (!Number.isFinite(idx) || idx < 0 || idx >= sharedQueue.length) return
  sharedQueue.splice(idx, 1)
  renderRoomQueue()
  broadcastQueueUpdate()
  saveRoomStateToServer({ shared_queue: sharedQueue }).catch(() => {})
}

function moveSharedQueueTrack(index, dir) {
  if (!_roomState?.host) return
  const i = Number(index)
  const d = Number(dir)
  const j = i + d
  if (!Number.isFinite(i) || !Number.isFinite(d) || i < 0 || j < 0 || i >= sharedQueue.length || j >= sharedQueue.length) return
  const tmp = sharedQueue[i]
  sharedQueue[i] = sharedQueue[j]
  sharedQueue[j] = tmp
  renderRoomQueue()
  broadcastQueueUpdate()
  saveRoomStateToServer({ shared_queue: sharedQueue }).catch(() => {})
}

function reorderSharedQueueTrack(fromIndex, toIndex) {
  if (!_roomState?.host) return
  const from = Number(fromIndex)
  const to = Number(toIndex)
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < 0 || from >= sharedQueue.length || to >= sharedQueue.length || from === to) return
  const [moved] = sharedQueue.splice(from, 1)
  sharedQueue.splice(to, 0, moved)
  renderRoomQueue()
  broadcastQueueUpdate()
  saveRoomStateToServer({ shared_queue: sharedQueue }).catch(() => {})
}

async function searchRoomQueueTracks() {
  const input = document.getElementById('room-queue-search')
  const list = document.getElementById('room-search-results')
  if (!input || !list) return
  const q = String(input.value || '').trim()
  if (!q) {
    _roomSearchResults = []
    list.innerHTML = ''
    return
  }
  list.innerHTML = '<div class="social-empty">Ищу треки...</div>'
  clearTimeout(_roomSearchDebounceTimer)
  _roomSearchDebounceTimer = setTimeout(async () => {
    try {
      const s = getSettings()
      const hybrid = await searchHybridTracks(q, s)
      _roomSearchResults = sanitizeTrackList(hybrid?.tracks || []).slice(0, 4)
      if (!_roomSearchResults.length) {
        list.innerHTML = '<div class="social-empty">Ничего не найдено</div>'
        return
      }
      list.innerHTML = _roomSearchResults.map((t, i) => {
        const coverUrl = getListCoverUrl(t)
        const cover = coverUrl
          ? `<div class="profile-row-cover" style="background-image:url(${coverUrl})"></div>`
          : `<div class="profile-row-cover profile-row-cover-fallback">♪</div>`
        return `<button class="profile-picker-item" onclick="addRoomSearchTrack(${i})" style="display:flex;align-items:center;gap:8px">${cover}<span>${t.title} — ${t.artist || '—'}</span></button>`
      }).join('')
    } catch {
      list.innerHTML = '<div class="social-empty">Ошибка поиска</div>'
    }
  }, 260)
}

function addRoomSearchTrack(index) {
  const track = _roomSearchResults[Number(index)]
  if (!track) return
  enqueueSharedTrack(track)
}

function openRoomOwnTracksPicker() {
  openPlaylistPickerModal({
    mode: 'room-own-source',
    title: 'Свои треки в очередь',
    items: [
      { id: 'liked', label: `Любимые (${getLiked().length})` },
      { id: 'playlists', label: `Плейлисты (${getPlaylists().length})` },
    ],
    payload: {}
  })
}

async function openPeerProfile(username, peerId = '') {
  const modal = document.getElementById('peer-profile-modal')
  const body = document.getElementById('peer-profile-body')
  if (!modal || !body) return
  const byName = Array.from(_peerProfiles.values()).find((p) => p?.username === username)
  const byPeer = peerId ? _peerProfiles.get(peerId) : null
  let data = byPeer || byName || { username }
  const cached = getCachedPeerProfile(username)
  if (cached) data = Object.assign({}, cached, data)
  const renderModal = (profileData) => {
    const avatar = profileData.avatarData
      ? `<div class="profile-avatar" style="background-image:url(${profileData.avatarData});background-size:cover;background-position:center"></div>`
      : `<div class="profile-avatar">${String(profileData.username || '?').slice(0,1).toUpperCase()}</div>`
    const banner = profileData.bannerData
      ? `linear-gradient(0deg, rgba(8,10,16,.35), rgba(8,10,16,.35)), url(${profileData.bannerData})`
      : 'linear-gradient(135deg,#1f2937,#111827)'
    const pinnedTracks = Array.isArray(profileData.pinnedTracks) ? profileData.pinnedTracks : []
    const friends = Array.from(_friendPresence.entries()).map(([name]) => name).slice(0, 24)
    body.innerHTML = `
      <div class="profile-shell peer-profile-shell" style="padding:0">
        <div class="profile-hero glass-card">
          <div class="profile-banner" style="background-image:${banner}"></div>
          <div class="profile-avatar-wrap">${avatar}</div>
          <div class="profile-main-meta">
            <h3>${profileData.username || 'user'}</h3>
            <p>${profileData.bio || 'Описание отсутствует'}</p>
          </div>
        </div>
        <div class="profile-grid">
          <div class="glass-card profile-card">
            <div class="profile-card-head"><strong>Закрепленные треки</strong></div>
            ${pinnedTracks.length ? pinnedTracks.map((t) => `<div class="profile-row"><span>${t.title} — ${t.artist || '—'}</span></div>`).join('') : '<div class="social-empty">Нет данных</div>'}
          </div>
          <div class="glass-card profile-card">
            <div class="profile-card-head"><strong>Отслеживание</strong></div>
            <div class="profile-stat-line"><strong>${((Number(profileData?.stats?.totalSeconds || 0))/3600).toFixed(1)}ч</strong> прослушивания</div>
            <div class="profile-stat-line"><strong>${Number(profileData?.stats?.totalTracks || 0)}</strong> треков</div>
          </div>
          <div class="glass-card profile-card">
            <div class="profile-card-head"><strong>Друзья</strong></div>
            ${friends.length ? friends.map((f) => `<div class="profile-row"><span>${f}</span></div>`).join('') : '<div class="social-empty">Нет данных</div>'}
          </div>
        </div>
      </div>
    `
    modal.classList.remove('hidden')
  }
  renderModal(data)
  const targetPeerId = String(peerId || data?.peerId || `flow-${username}` || '').trim()
  const cloud = await fetchCloudPublicProfile(username).catch(() => null)
  if (cloud) {
    data = Object.assign({}, data, cloud, { peerId: targetPeerId || data.peerId || null })
    if (data.peerId) _peerProfiles.set(data.peerId, data)
    cachePeerProfile(data, data.peerId)
    renderModal(data)
  }
  if (_socialPeer?.requestPeerData && targetPeerId && targetPeerId !== _socialPeer?.peer?.id) {
    const rsp = await _socialPeer.requestPeerData(targetPeerId, { type: 'presence-request' }, 1300).catch(() => null)
    const remoteProfile = rsp?.ok ? rsp?.data?.profile : null
    if (remoteProfile) {
      data = Object.assign({}, data, remoteProfile, { peerId: rsp?.data?.peerId || targetPeerId })
      _peerProfiles.set(data.peerId, data)
      cachePeerProfile(data, data.peerId)
      renderModal(data)
    }
  }
}

function closePeerProfile() {
  const modal = document.getElementById('peer-profile-modal')
  if (modal) modal.classList.add('hidden')
}

function getListenStats() {
  if (!_profile?.username) return { totalTracks: 0, totalSeconds: 0, lastTrackKey: null }
  const key = `flow_listen_stats_${_profile.username}`
  try { return Object.assign({ totalTracks: 0, totalSeconds: 0, lastTrackKey: null }, JSON.parse(localStorage.getItem(key) || '{}')) } catch { return { totalTracks: 0, totalSeconds: 0, lastTrackKey: null } }
}

function saveListenStats(patch = {}) {
  if (!ensureActiveProfile()?.username) return
  const key = `flow_listen_stats_${_profile.username}`
  const next = Object.assign(getListenStats(), patch || {})
  localStorage.setItem(key, JSON.stringify(next))
  scheduleProfileCloudSync()
}

function saveProfileCustom(patch = {}) {
  if (!ensureActiveProfile()?.username) {
    showToast('Сначала войди в профиль', true)
    return getProfileCustom()
  }
  const key = `flow_profile_custom_${_profile.username}`
  const next = Object.assign(getProfileCustom(), patch || {})
  localStorage.setItem(key, JSON.stringify(next))
  try {
    const publicPayload = getPublicProfilePayload(_profile.username)
    if (_socialPeer?.peer?.id && publicPayload) {
      _peerProfiles.set(_socialPeer.peer.id, publicPayload)
      cachePeerProfile(publicPayload, _socialPeer.peer.id)
    }
    if (_roomState?.roomId && _socialPeer?.send) {
      _socialPeer.send({ type: 'room-profile-state', roomId: _roomState.roomId, profile: publicPayload, sharedQueue })
    }
  } catch {}
  scheduleProfileCloudSync()
  return next
}

function renderProfilePage() {
  if (!_profile?.username) return
  const custom = getProfileCustom()
  const banner = document.getElementById('profile-banner')
  const avatar = document.getElementById('profile-avatar-large')
  const displayName = document.getElementById('profile-display-name')
  const bio = document.getElementById('profile-bio')
  const stats = document.getElementById('profile-stats')
  const friendsEl = document.getElementById('profile-friends-list')
  if (banner) {
    banner.style.backgroundImage = custom.bannerData
      ? `linear-gradient(0deg, rgba(8,10,16,.35), rgba(8,10,16,.35)), url(${custom.bannerData})`
      : 'linear-gradient(135deg, rgba(59,130,246,.3), rgba(139,92,246,.25))'
    banner.style.backgroundSize = 'cover'
    banner.style.backgroundPosition = 'center'
  }
  if (avatar) {
    if (custom.avatarData) {
      avatar.textContent = ''
      avatar.style.backgroundImage = `url(${custom.avatarData})`
      avatar.style.backgroundSize = 'cover'
      avatar.style.backgroundPosition = 'center'
    } else {
      avatar.style.backgroundImage = ''
      avatar.textContent = (_profile.username || '?').slice(0, 1).toUpperCase()
    }
  }
  if (displayName) displayName.textContent = _profile.username
  if (bio) bio.textContent = custom.bio || 'Добавь описание профиля'
  if (stats) {
    const st = getListenStats()
    const hours = (Number(st.totalSeconds || 0) / 3600).toFixed(1)
    const playlistsCount = getPlaylists().map(normalizePlaylist).length
    const likedCount = getLiked().length
    stats.innerHTML = `
      <div class="profile-stat-line"><strong>${hours}ч</strong> прослушивания</div>
      <div class="profile-stat-line"><strong>${Number(st.totalTracks || 0)}</strong> треков прослушано</div>
      <div class="profile-stat-line"><strong>${likedCount}</strong> лайков • <strong>${playlistsCount}</strong> плейлистов</div>
    `
  }
  if (friendsEl) {
    const friends = typeof peerSocial.getFriends === 'function' ? peerSocial.getFriends(_profile.username) : []
    friendsEl.innerHTML = friends.length
      ? friends.map((f) => `<div class="profile-chip">${f}</div>`).join('')
      : '<span style="opacity:.75">Пока нет друзей</span>'
  }
  renderPinnedTracks()
}

async function pickProfileAvatar() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    const dataUrl = await readFileAsDataUrl(file).catch(() => '')
    if (!dataUrl) return showToast('Не удалось загрузить аватар', true)
    saveProfileCustom({ avatarData: dataUrl })
    syncProfileUi()
    renderProfilePage()
  }
  input.click()
}

async function pickProfileBanner() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    const dataUrl = await readFileAsDataUrl(file).catch(() => '')
    if (!dataUrl) return showToast('Не удалось загрузить баннер', true)
    saveProfileCustom({ bannerData: dataUrl })
    renderProfilePage()
  }
  input.click()
}

function editProfileBio() {
  const cur = getProfileCustom()
  const next = window.prompt('Описание профиля:', cur.bio || '')
  if (next === null) return
  saveProfileCustom({ bio: String(next || '').trim().slice(0, 180) })
  renderProfilePage()
}

function addPinnedTrack() {
  const tracks = getAllKnownTracks()
  if (!tracks.length) return showToast('Нет доступных треков для добавления', true)
  openPlaylistPickerModal({
    mode: 'profile-track',
    title: 'Выбери трек в профиль',
    items: tracks.map((t, idx) => ({ id: String(idx), label: `${t.title} — ${t.artist || '—'}` })),
    payload: { tracks }
  })
}

function addPinnedPlaylist() {
  const playlists = getPlaylists().map(normalizePlaylist)
  if (!playlists.length) return showToast('Сначала создай плейлист', true)
  openPlaylistPickerModal({
    mode: 'profile-playlist',
    title: 'Выбери плейлист в профиль',
    items: playlists.map((p, idx) => ({ id: String(idx), label: `${p.name} (${p.tracks.length})` })),
    payload: {}
  })
}

function getAllKnownTracks() {
  const out = []
  const seen = new Set()
  const add = (t) => {
    if (!t || !t.id || !t.source) return
    const key = `${t.source}:${t.id}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(t)
  }
  add(currentTrack)
  getLiked().forEach(add)
  getPlaylists().map(normalizePlaylist).forEach((pl) => (pl.tracks || []).forEach(add))
  return out
}

function openPlaylistPickerModal(ctx) {
  _playlistPickerContext = ctx || null
  const modal = document.getElementById('playlist-picker-modal')
  const title = document.getElementById('playlist-picker-title')
  const list = document.getElementById('playlist-picker-list')
  if (!modal || !title || !list) return
  title.textContent = ctx?.title || 'Выбери'
  list.innerHTML = ''
  ;(ctx?.items || []).forEach((item) => {
    const btn = document.createElement('button')
    btn.className = 'profile-picker-item'
    btn.textContent = item.label
    btn.addEventListener('click', () => submitPlaylistPicker(item.id))
    list.appendChild(btn)
  })
  modal.classList.remove('hidden')
}

function closePlaylistPickerModal() {
  const modal = document.getElementById('playlist-picker-modal')
  if (modal) modal.classList.add('hidden')
  _playlistPickerContext = null
}

function submitPlaylistPicker(selectedId) {
  const ctx = _playlistPickerContext
  if (!ctx) return
  if (ctx.mode === 'add-track-playlist') {
    const idx = Number(selectedId)
    const pls = getPlaylists().map(normalizePlaylist)
    if (pls[idx] && ctx.payload?.track) {
      const track = ctx.payload.track
      if (!pls[idx].tracks.some((t) => t.id === track.id && t.source === track.source)) pls[idx].tracks.push(track)
      savePlaylists(pls)
      showToast(`Добавлено в "${pls[idx].name}"`)
    }
  } else if (ctx.mode === 'profile-track') {
    const idx = Number(selectedId)
    const track = ctx.payload?.tracks?.[idx]
    if (track) {
      const custom = getProfileCustom()
      const key = `${track.source}:${track.id}`
      if (!custom.pinnedTracks.some((t) => `${t.source}:${t.id}` === key)) custom.pinnedTracks.push(track)
      saveProfileCustom({ pinnedTracks: custom.pinnedTracks.slice(0, 8) })
      renderProfilePage()
    }
  } else if (ctx.mode === 'profile-playlist') {
    const idx = Number(selectedId)
    const custom = getProfileCustom()
    if (!custom.pinnedPlaylists.includes(idx)) custom.pinnedPlaylists.push(idx)
    saveProfileCustom({ pinnedPlaylists: custom.pinnedPlaylists.slice(0, 8) })
    renderProfilePage()
  } else if (ctx.mode === 'room-own-source') {
    if (selectedId === 'liked') {
      const liked = getLiked()
      openPlaylistPickerModal({
        mode: 'room-own-liked-track',
        title: 'Выбери трек из любимых',
        items: liked.map((t, idx) => ({ id: String(idx), label: `${t.title} — ${t.artist || '—'}` })),
        payload: { tracks: liked }
      })
      return
    }
    if (selectedId === 'playlists') {
      const pls = getPlaylists().map(normalizePlaylist)
      openPlaylistPickerModal({
        mode: 'room-own-playlist',
        title: 'Выбери плейлист',
        items: pls.map((p, idx) => ({ id: String(idx), label: `${p.name} (${p.tracks.length})` })),
        payload: { playlists: pls }
      })
      return
    }
  } else if (ctx.mode === 'room-own-liked-track') {
    const idx = Number(selectedId)
    const track = ctx.payload?.tracks?.[idx]
    if (track) enqueueSharedTrack(track)
  } else if (ctx.mode === 'room-own-playlist') {
    const idx = Number(selectedId)
    const playlist = ctx.payload?.playlists?.[idx]
    if (playlist?.tracks?.length) {
      openPlaylistPickerModal({
        mode: 'room-own-playlist-track',
        title: `Треки: ${playlist.name}`,
        items: playlist.tracks.map((t, tIdx) => ({ id: String(tIdx), label: `${t.title} — ${t.artist || '—'}` })),
        payload: { tracks: playlist.tracks }
      })
      return
    }
  } else if (ctx.mode === 'room-own-playlist-track') {
    const idx = Number(selectedId)
    const track = ctx.payload?.tracks?.[idx]
    if (track) enqueueSharedTrack(track)
  }
  closePlaylistPickerModal()
}

function createPlaylistFromPicker() {
  const ctx = _playlistPickerContext
  if (!ctx || ctx.mode !== 'add-track-playlist') return
  const nameInput = document.getElementById('playlist-picker-new-name')
  const name = String(nameInput?.value || '').trim()
  if (!name) return
  const pls = getPlaylists().map(normalizePlaylist)
  pls.push(normalizePlaylist({ name, tracks: [] }))
  savePlaylists(pls)
  const newIndex = pls.length - 1
  submitPlaylistPicker(String(newIndex))
}

function renderPinnedTracks() {
  const el = document.getElementById('profile-pinned-tracks')
  if (!el) return
  const custom = getProfileCustom()
  if (!custom.pinnedTracks?.length) {
    el.innerHTML = '<span style="opacity:.75">Добавь треки в профиль</span>'
    return
  }
  el.innerHTML = ''
  custom.pinnedTracks.forEach((track, i) => {
    const row = document.createElement('div')
    row.className = 'profile-row'
    const coverUrl = getListCoverUrl(track)
    const cover = coverUrl
      ? `<div class="profile-row-cover" style="background-image:url(${coverUrl})"></div>`
      : `<div class="profile-row-cover profile-row-cover-fallback">♪</div>`
    row.innerHTML = `${cover}<span>${track.title} — ${track.artist || '—'}</span><button class="playlist-track-action danger">✕</button>`
    row.querySelector('span')?.addEventListener('click', () => playTrackObj(track))
    row.querySelector('button')?.addEventListener('click', () => {
      const next = getProfileCustom()
      next.pinnedTracks.splice(i, 1)
      saveProfileCustom({ pinnedTracks: next.pinnedTracks })
      renderProfilePage()
    })
    el.appendChild(row)
  })
}

function renderPinnedPlaylists() {
  const el = document.getElementById('profile-pinned-playlists')
  if (!el) return
  const custom = getProfileCustom()
  const playlists = getPlaylists().map(normalizePlaylist)
  const pinned = (custom.pinnedPlaylists || []).map((idx) => ({ idx, pl: playlists[idx] })).filter((x) => x.pl)
  if (!pinned.length) {
    el.innerHTML = '<span style="opacity:.75">Добавь плейлисты в профиль</span>'
    return
  }
  el.innerHTML = ''
  pinned.forEach((item, i) => {
    const row = document.createElement('div')
    row.className = 'profile-row'
    row.innerHTML = `<span>${item.pl.name} (${item.pl.tracks.length})</span><button class="playlist-track-action danger">✕</button>`
    row.querySelector('span')?.addEventListener('click', () => openPlaylist(item.idx))
    row.querySelector('button')?.addEventListener('click', () => {
      const next = getProfileCustom()
      next.pinnedPlaylists.splice(i, 1)
      saveProfileCustom({ pinnedPlaylists: next.pinnedPlaylists })
      renderProfilePage()
    })
    el.appendChild(row)
  })
}

function ensureSocialUI() {
  if (document.getElementById('social-hub')) return
  const root = document.getElementById('page-social-content')
  if (!root) return
  const box = document.createElement('div')
  box.id = 'social-hub'
  box.className = 'glass-card social-hub'
  box.style.padding = '14px'
  box.innerHTML = `
    <div class="social-head">
      <strong>Flow Social (P2P)</strong>
      <span id="social-status" class="social-status">offline</span>
    </div>
    <div class="social-add-box">
      <div class="social-section-title">Добавить друга</div>
      <input id="friend-search-input" class="token-field flow-input" placeholder="Username друга" style="flex:1;min-width:180px" />
      <button class="btn-small" onclick="addFriendByUsername()">Отправить запрос</button>
    </div>
    <div class="social-friends-box">
      <div class="social-section-title">Входящие заявки</div>
      <div id="friend-requests-list"><div class="social-empty">Нет входящих заявок</div></div>
    </div>
    <div class="social-friends-box">
      <div class="social-section-title">Друзья</div>
      <div id="friends-list"></div>
    </div>
  `
  root.appendChild(box)
}

function ensureRoomsUI() {
  if (document.getElementById('rooms-hub')) return
  const root = document.getElementById('page-rooms-content')
  if (!root) return
  const box = document.createElement('div')
  box.id = 'rooms-hub'
  box.className = 'glass-card social-hub'
  box.style.padding = '14px'
  box.innerHTML = `
    <div class="social-room-box">
      <div class="social-section-title">Подключение</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input id="join-room-input" class="token-field flow-input" placeholder="ID или ник хоста" style="flex:1;min-width:180px" />
        <button class="btn-small" onclick="joinRoomById()">Присоединиться</button>
        <button class="btn-small" onclick="createRoom()">Создать свою комнату</button>
        <button class="btn-small" onclick="leaveRoom()">Покинуть руму</button>
      </div>
      <div id="room-status" style="margin-top:8px;font-size:12px;opacity:.85">Рума: не активна</div>
      <div style="margin-top:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span id="room-role-badge" class="room-role-badge room-role-solo">SOLO</span>
        <span id="room-members-count" style="font-size:12px;opacity:.8">Участники: —/3</span>
      </div>
      <div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn-small" onclick="copyInviteLink()">Copy Invite Link/ID</button>
        <button class="btn-small" onclick="promptInviteJoin()">Ввести Invite</button>
      </div>
    </div>
    <div class="social-room-box">
      <div class="social-section-title">В комнате</div>
      <div id="room-members-list" class="social-friends-grid"></div>
    </div>
    <div class="social-room-box">
      <div class="social-section-title">Поиск в очередь</div>
      <input id="room-queue-search" class="token-field flow-input" placeholder="Найти трек и добавить в очередь..." oninput="searchRoomQueueTracks()" />
      <div style="margin-top:8px"><button class="btn-small" onclick="openRoomOwnTracksPicker()">Свои треки</button></div>
      <div id="room-search-results" class="profile-picker-list" style="margin-top:8px"></div>
    </div>
    <div class="social-room-box">
      <div class="social-section-title">Очередь прослушивания</div>
      <div id="room-queue-list"></div>
    </div>
  `
  root.appendChild(box)
}

async function renderFriends() {
  const el = document.getElementById('friends-list')
  if (!el || !_profile?.username || !peerSocial.getFriends) return
  renderFriendRequests().catch(() => {})
  const list = peerSocial.getFriends(_profile.username)
  if (!list.length) {
    el.innerHTML = '<div class="social-empty">Пока нет друзей</div>'
    return
  }
  const online = []
  const offline = []
  list.forEach((name) => {
    const state = _friendPresence.get(name) || { online: false }
    if (state.online) online.push({ name, state })
    else offline.push({ name, state })
  })
  const resolveAvatar = (username) => {
    const remote = Array.from(_peerProfiles.values()).find((p) => p?.username === username)
    if (remote?.avatarData) return remote.avatarData
    const cached = getCachedPeerProfile(username)
    if (cached?.avatarData) return cached.avatarData
    const key = `flow_profile_custom_${username}`
    try {
      const data = JSON.parse(localStorage.getItem(key) || '{}')
      return data?.avatarData || null
    } catch {
      return null
    }
  }
  const fmtFriendCard = (item, onlineMode) => {
    const avatar = resolveAvatar(item.name)
    const roomId = item.state.roomId || `flow-${item.name}`
    const nowPlaying = onlineMode && item.state.track?.title
      ? `${item.state.track.title}${item.state.track.artist ? ` — ${item.state.track.artist}` : ''}`
      : (onlineMode ? 'в сети' : 'не в сети')
    const avatarHtml = avatar
      ? `<div class="social-friend-avatar" style="background-image:url(${avatar})"></div>`
      : `<div class="social-friend-avatar">${item.name.slice(0, 1).toUpperCase()}</div>`
    return `
      <div class="social-friend-card ${onlineMode ? 'online' : 'offline'}">
        ${avatarHtml}
        <div class="social-friend-meta">
          <strong onclick="openPeerProfile('${item.name}', '${item.state.peerId || ''}')">${item.name}</strong>
          <span>${nowPlaying}</span>
        </div>
        <button class="btn-small" onclick="openPeerProfile('${item.name}', '${item.state.peerId || ''}')">Профиль</button>
        ${onlineMode ? `<button class="btn-small" onclick="joinFriendRoom('${roomId}')">Join Room</button>` : ''}
      </div>
    `
  }
  el.innerHTML = `
    <div class="social-friends-section-title">В сети</div>
    <div class="social-friends-grid">${online.length ? online.map((item) => fmtFriendCard(item, true)).join('') : '<div class="social-empty">Никого онлайн</div>'}</div>
    <div class="social-friends-section-title">Не в сети</div>
    <div class="social-friends-grid">${offline.length ? offline.map((item) => fmtFriendCard(item, false)).join('') : '<div class="social-empty">Пусто</div>'}</div>
  `
}

function setSocialStatus(text) {
  const el = document.getElementById('social-status')
  if (el) el.textContent = text
}

function setRoomStatus(text) {
  const el = document.getElementById('room-status')
  if (el) el.textContent = text
}

function getLastFmPayload() {
  const s = getSettings()
  return {
    apiKey: s.lastfmApiKey || '',
    sharedSecret: s.lastfmSharedSecret || '',
    sessionKey: s.lastfmSessionKey || '',
  }
}

function syncIntegrationsUI() {
  const s = getSettings()
  const d = document.getElementById('discord-client-id')
  const k = document.getElementById('lastfm-api-key')
  const ss = document.getElementById('lastfm-shared-secret')
  const sk = document.getElementById('lastfm-session-key')
  if (d) d.value = s.discordClientId || ''
  if (k) k.value = s.lastfmApiKey || ''
  if (ss) ss.value = s.lastfmSharedSecret || ''
  if (sk) sk.value = s.lastfmSessionKey || ''
}

async function connectDiscordRpc() {
  const input = document.getElementById('discord-client-id')
  const clientId = String(input?.value || '').trim()
  if (!clientId) return showToast('Укажи Discord Client ID', true)
  saveSettingsRaw({ discordClientId: clientId, discordRpcEnabled: true })
  if (!window.api?.discordRpcConnect) return showToast('RPC доступен только в Electron', true)
  const r = await window.api.discordRpcConnect(clientId).catch((e) => ({ ok: false, error: e?.message || String(e) }))
  if (!r?.ok) return showToast(`Discord RPC: ${r?.error || 'ошибка'}`, true)
  syncIntegrationsUI()
  showToast('Discord RPC подключен')
}

async function disconnectDiscordRpc() {
  saveSettingsRaw({ discordRpcEnabled: false })
  if (window.api?.discordRpcClear) await window.api.discordRpcClear().catch(() => {})
  showToast('Discord RPC отключен')
}

function saveLastFmCredentials() {
  const apiKey = String(document.getElementById('lastfm-api-key')?.value || '').trim()
  const sharedSecret = String(document.getElementById('lastfm-shared-secret')?.value || '').trim()
  const sessionKey = String(document.getElementById('lastfm-session-key')?.value || '').trim()
  saveSettingsRaw({ lastfmApiKey: apiKey, lastfmSharedSecret: sharedSecret, lastfmSessionKey: sessionKey })
  syncIntegrationsUI()
  showToast('Last.fm данные сохранены')
}

async function updateDiscordPresence(track, roomInfo = null) {
  const s = getSettings()
  if (!s.discordRpcEnabled || !window.api?.discordRpcUpdate || !track) return
  const buttons = []
  if (roomInfo?.roomId) {
    buttons.push({ label: 'Join', url: `https://flow.local/join?room=${encodeURIComponent(roomInfo.roomId)}` })
  }
  await window.api.discordRpcUpdate({
    details: `Listening: ${track.title || 'Unknown'}`,
    state: `${track.artist || '—'}${roomInfo?.roomId ? ` • room ${roomInfo.roomId}` : ''}`,
    largeImageKey: 'flow',
    largeImageText: 'Flow',
    smallImageKey: 'music',
    smallImageText: track.source || 'audio',
    buttons,
    partySize: _socialPeer?.peersCount?.() || undefined,
    partyMax: roomInfo?.roomId ? 3 : undefined,
    joinSecret: roomInfo?.roomId || null,
    startTimestamp: Math.floor(Date.now() / 1000),
  }).catch(() => {})
}

async function pushLastFmNowPlaying(track) {
  const payload = getLastFmPayload()
  if (!payload.apiKey || !payload.sharedSecret || !payload.sessionKey || !window.api?.lastfmNowPlaying) return
  await window.api.lastfmNowPlaying({
    ...payload,
    artist: track?.artist || '',
    track: track?.title || '',
  }).catch(() => {})
}

async function scrobbleLastFm(track) {
  const payload = getLastFmPayload()
  if (!payload.apiKey || !payload.sharedSecret || !payload.sessionKey || !window.api?.lastfmScrobble) return
  const ts = _currentTrackStartedAt || Math.floor(Date.now() / 1000)
  await window.api.lastfmScrobble({
    ...payload,
    artist: track?.artist || '',
    track: track?.title || '',
    timestamp: ts,
  }).catch(() => {})
}

function initPeerSocial() {
  if (!_profile?.username || !peerSocial.FlowPeerSocial) return
  if (_socialPeer) _socialPeer.destroy()
  _socialPeer = new peerSocial.FlowPeerSocial(_profile.username, {
    maxPeers: 3,
    onStatus: (evt) => {
      if (evt.type === 'ready') setSocialStatus(`online: ${evt.id}`)
      if (evt.type === 'peer-joined') {
        setRoomStatus(`Рума ${_roomState.roomId || '—'}: участников ${_socialPeer.peersCount()}/3`)
        const me = getPublicProfilePayload(_profile?.username)
        if (me && _socialPeer?.peer?.id) _roomMembers.set(_socialPeer.peer.id, me)
        if (evt.peerId && !_roomMembers.has(evt.peerId)) {
          _roomMembers.set(evt.peerId, {
            username: String(evt.peerId).replace(/^flow-/, '') || 'user',
            peerId: evt.peerId,
            avatarData: null,
            bannerData: null,
            bio: '',
            stats: { totalTracks: 0, totalSeconds: 0 },
            pinnedTracks: [],
            pinnedPlaylists: [],
          })
        }
        if (_roomState?.roomId && _roomState.host) _socialPeer.send({ type: 'room-profile-state', roomId: _roomState.roomId, profile: me, sharedQueue })
        if (_roomState?.roomId && !_roomState.host && evt.peerId && _socialPeer?.sendToPeer) {
          _socialPeer.sendToPeer(evt.peerId, { type: 'room-profile-state', roomId: _roomState.roomId, profile: me, sharedQueue })
          _socialPeer.sendToPeer(evt.peerId, { type: 'room-queue-sync-request', roomId: _roomState.roomId })
        }
        broadcastRoomMembersState()
        resetRoomHeartbeat()
        updateRoomUi()
        if (evt.peerId) showToast(`${String(evt.peerId).replace(/^flow-/, '')}: вошёл в руму`)
      }
      if (evt.type === 'peer-left') {
        setRoomStatus(`Рума ${_roomState.roomId || '—'}: участников ${_socialPeer.peersCount()}/3`)
        if (evt.peerId) {
          _roomMembers.delete(evt.peerId)
          _peerProfiles.delete(evt.peerId)
        }
        if (!_roomState.host && evt.peerId && evt.peerId === _roomState.hostPeerId) {
          _roomState = { roomId: null, host: true, hostPeerId: null }
          _roomMembers.clear()
          showToast('Хост покинул комнату. Теперь вы управляете плеером сами')
          setRoomStatus('Хост отключился, автономный режим активирован')
        }
        broadcastRoomMembersState()
        resetRoomHeartbeat()
        updateRoomUi()
        if (evt.peerId) showToast(`${String(evt.peerId).replace(/^flow-/, '')}: вышел из румы`)
      }
      if (evt.type === 'error') {
        setSocialStatus(`error: ${evt.error}`)
        if (_roomState?.roomId) showToast(`Ошибка соединения: ${evt.error}`, true)
      }
    },
    onMessage: (msg, fromPeerId) => {
      if (!msg || typeof msg !== 'object') return
      const hostPeerId = _roomState.hostPeerId || _roomState.roomId
      const hostMsg = Boolean(msg._peerId && hostPeerId && msg._peerId === hostPeerId)
      if (msg.type === 'playback-sync' && msg.roomId === _roomState.roomId && !_roomState.host && (hostMsg || msg.roomId === _roomState.roomId)) {
        if (msg.track && msg.track.id !== currentTrack?.id) {
          playTrackObj(msg.track, { remoteSync: true }).catch(() => {})
        }
        if (typeof msg.currentTime === 'number' && audio.duration) {
          const latencySec = Math.max(0, (Date.now() - Number(msg._ts || Date.now())) / 1000)
          const targetTime = Math.max(0, msg.currentTime + latencySec)
          if (Math.abs(audio.currentTime - targetTime) > 0.45) audio.currentTime = targetTime
        }
        if (typeof msg.paused === 'boolean') {
          if (msg.paused && !audio.paused) audio.pause()
          if (!msg.paused && audio.paused) audio.play().catch(() => {})
        }
        if (Array.isArray(msg.sharedQueue)) {
          sharedQueue = msg.sharedQueue
          renderRoomQueue()
        }
      }
      if (msg.type === 'presence-request' && fromPeerId && _socialPeer) {
        const payload = {
          type: 'presence-state',
          _responseTo: msg?._reqId || null,
          toPeerId: fromPeerId,
          track: currentTrack ? { title: currentTrack.title || '', artist: currentTrack.artist || '' } : null,
          roomId: _roomState.roomId || null,
          host: Boolean(_roomState.host),
          profile: getPublicProfilePayload(_profile?.username),
          peerId: _socialPeer?.peer?.id || null,
        }
        if (typeof _socialPeer.sendToPeer === 'function') _socialPeer.sendToPeer(fromPeerId, payload)
        else _socialPeer.send(payload)
      }
      if (msg.type === 'presence-state' && msg.toPeerId && _socialPeer?.peer?.id && msg.toPeerId === _socialPeer.peer.id && msg._from) {
        const key = String(msg._from)
        _friendPresence.set(key.replace(/^flow-/, ''), {
          online: true,
          roomId: msg.roomId || null,
          track: msg.track || null,
          host: Boolean(msg.host),
          peerId: msg.peerId || msg._peerId || null,
          updatedAt: Date.now(),
        })
        if (msg.profile && (msg.peerId || msg._peerId)) {
          _peerProfiles.set(msg.peerId || msg._peerId, msg.profile)
          cachePeerProfile(msg.profile, msg.peerId || msg._peerId)
        }
        renderFriends()
      }
      if (msg.type === 'room-profile-state' && msg.roomId === _roomState.roomId && msg.profile && msg._peerId) {
        const profileWithPeer = Object.assign({}, msg.profile, { peerId: msg._peerId })
        _peerProfiles.set(msg._peerId, profileWithPeer)
        cachePeerProfile(profileWithPeer, msg._peerId)
        _roomMembers.set(msg._peerId, profileWithPeer)
        if (Array.isArray(msg.sharedQueue)) sharedQueue = msg.sharedQueue
        if (_roomState.host) broadcastRoomMembersState()
        resetRoomHeartbeat()
        updateRoomUi()
      }
      if (msg.type === 'room-members-state' && msg.roomId === _roomState.roomId && Array.isArray(msg.members)) {
        const map = new Map()
        msg.members.forEach((item) => {
          if (!item?.peerId || !item?.profile) return
          map.set(item.peerId, item.profile)
          cachePeerProfile(item.profile, item.peerId)
        })
        if (_socialPeer?.peer?.id && !map.has(_socialPeer.peer.id) && _profile?.username) {
          map.set(_socialPeer.peer.id, getPublicProfilePayload(_profile.username))
        }
        _roomMembers = map
        resetRoomHeartbeat()
        updateRoomUi()
      }
      if (msg.type === 'room-queue-add' && msg.roomId === _roomState.roomId && _roomState.host && msg.track) {
        const t = sanitizeTrack(msg.track)
        sharedQueue.push(t)
        broadcastQueueUpdate()
        _socialPeer.send({ type: 'room-profile-state', roomId: _roomState.roomId, profile: getPublicProfilePayload(_profile?.username), sharedQueue })
        saveRoomStateToServer({ shared_queue: sharedQueue }).catch(() => {})
        renderRoomQueue()
      }
      if (msg.type === 'room-control-toggle' && msg.roomId === _roomState.roomId && msg._peerId && msg._peerId !== _socialPeer?.peer?.id) {
        const shouldPause = Boolean(msg.paused)
        if (shouldPause && !audio.paused) audio.pause()
        if (!shouldPause && audio.paused) audio.play().catch(() => {})
        if (_roomState?.host) {
          saveRoomStateToServer({
            playback_state: { paused: Boolean(audio.paused), currentTime: Number(audio.currentTime || 0) },
            playback_ts: Date.now(),
          }).catch(() => {})
        }
      }
      if (msg.type === 'room-queue-sync-request' && msg.roomId === _roomState.roomId && _roomState.host) {
        const payload = { type: 'room-queue-sync-state', roomId: _roomState.roomId, sharedQueue }
        if (typeof _socialPeer.sendToPeer === 'function' && msg._peerId) _socialPeer.sendToPeer(msg._peerId, payload)
        else _socialPeer.send(payload)
      }
      if (msg.type === 'room-queue-sync-state' && msg.roomId === _roomState.roomId && Array.isArray(msg.sharedQueue)) {
        sharedQueue = msg.sharedQueue
        saveRoomStateToServer({ shared_queue: sharedQueue }).catch(() => {})
        renderRoomQueue()
      }
      if (msg.type === (peerSocial?.EVENTS?.QUEUE_UPDATE || 'queue-update') && msg.roomId === _roomState.roomId && Array.isArray(msg.sharedQueue)) {
        sharedQueue = msg.sharedQueue
        saveRoomStateToServer({ shared_queue: sharedQueue }).catch(() => {})
        renderRoomQueue()
      }
    },
  })
  const r = _socialPeer.init()
  if (!r?.ok) setSocialStatus(r?.error || 'peer init failed')
  updateRoomUi()
}

function submitAuth() {
  const input = document.getElementById('auth-login')
  const username = String(input?.value || '').trim()
  if (!username) return setAuthError('Введите Username')
  const fn = _authMode === 'register' ? peerSocial.createProfile : peerSocial.loginProfile
  if (typeof fn !== 'function') return setAuthError('Social модуль не загружен')
  const result = fn(username)
  if (!result?.ok) return setAuthError(result?.error || 'Ошибка входа')
  _profile = result.profile
  setAuthError('')
  document.getElementById('screen-auth')?.classList.add('hidden')
  document.getElementById('screen-main')?.classList.remove('hidden')
  syncProfileUi()
  ensureSocialUI()
  ensureRoomsUI()
  renderFriends()
  initPeerSocial()
  pollFriendsPresence().catch(() => {})
  if (_friendsPollTimer) clearInterval(_friendsPollTimer)
  _friendsPollTimer = setInterval(() => { pollFriendsPresence().catch(() => {}) }, 12000)
}

function logout() {
  removeRoomMemberPresence(_roomState?.roomId).catch(() => {})
  stopRoomServerSync()
  try { _socialPeer?.destroy() } catch {}
  _socialPeer = null
  _roomState = { roomId: null, host: false, hostPeerId: null }
  _friendPresence.clear()
  _roomMembers.clear()
  sharedQueue = []
  if (_roomHeartbeatTimer) clearInterval(_roomHeartbeatTimer)
  _roomHeartbeatTimer = null
  if (_friendsPollTimer) clearInterval(_friendsPollTimer)
  _friendsPollTimer = null
  updateRoomUi()
  disconnectDiscordRpc().catch?.(() => {})
  if (typeof peerSocial.logoutProfile === 'function') peerSocial.logoutProfile()
  _profile = null
  document.getElementById('screen-main')?.classList.add('hidden')
  document.getElementById('screen-auth')?.classList.remove('hidden')
}

async function addFriendByUsername() {
  const input = document.getElementById('friend-search-input')
  const friend = String(input?.value || '').trim()
  if (!_profile?.username || !friend || typeof peerSocial.sendFriendRequest !== 'function') return
  const r = await peerSocial.sendFriendRequest(_profile.username, friend)
  if (!r?.ok) return showToast(r?.error || 'Не удалось отправить запрос', true)
  renderFriends().catch(() => {})
  input.value = ''
  const online = await _socialPeer?.probeUser?.(friend, 1500).catch(() => false)
  showToast(online ? 'Запрос в друзья отправлен' : 'Запрос в друзья отправлен (доставится при входе)')
}

async function renderFriendRequests() {
  const el = document.getElementById('friend-requests-list')
  if (!el || !_profile?.username || typeof peerSocial.getIncomingFriendRequests !== 'function') return
  const reqs = await peerSocial.getIncomingFriendRequests(_profile.username).catch(() => [])
  if (!Array.isArray(reqs) || !reqs.length) {
    el.innerHTML = '<div class="social-empty">Нет входящих заявок</div>'
    return
  }
  el.innerHTML = reqs.map((req) => {
    const from = String(req.from_username || '')
    return `
      <div class="social-friend-card online">
        <div class="social-friend-avatar">${from.slice(0,1).toUpperCase()}</div>
        <div class="social-friend-meta">
          <strong>${from}</strong>
          <span>Предложение в друзья</span>
        </div>
        <button class="btn-small" onclick="respondFriendRequest('${from}', true)">Принять</button>
        <button class="btn-small" onclick="respondFriendRequest('${from}', false)">Отклонить</button>
      </div>
    `
  }).join('')
}

async function respondFriendRequest(fromUsername, accept) {
  if (!_profile?.username || typeof peerSocial.respondFriendRequest !== 'function') return
  const r = await peerSocial.respondFriendRequest(_profile.username, fromUsername, Boolean(accept))
  if (!r?.ok) return showToast(r?.error || 'Ошибка обработки заявки', true)
  showToast(accept ? 'Друг добавлен' : 'Запрос отклонен')
  renderFriends().catch(() => {})
  pollFriendsPresence().catch(() => {})
}

function createRoom() {
  if (!_socialPeer) return
  const r = _socialPeer.createRoom()
  if (!r?.ok) return showToast(r?.error || 'Ошибка создания', true)
  _roomState = { roomId: r.roomId, host: true, hostPeerId: r.roomId }
  _roomMembers.clear()
  sharedQueue = []
  if (_socialPeer?.peer?.id) _roomMembers.set(_socialPeer.peer.id, getPublicProfilePayload(_profile?.username))
  setRoomStatus(`Рума ${r.roomId}: участников 1/3`)
  resetRoomHeartbeat()
  startRoomServerSync()
  saveRoomStateToServer({ shared_queue: [], now_playing: null, playback_ts: Date.now() }).catch(() => {})
  updateRoomUi()
  showToast('Рума создана')
}

function joinRoomById(forceRoomId = '') {
  const input = document.getElementById('join-room-input')
  const roomId = resolveInviteToRoomId(forceRoomId || String(input?.value || '').trim())
  if (!_socialPeer || !roomId) return
  const r = _socialPeer.joinRoom(roomId)
  if (!r?.ok) return showToast(r?.error || 'Ошибка входа', true)
  _roomState = { roomId: r.roomId, host: false, hostPeerId: r.roomId }
  _roomMembers.clear()
  sharedQueue = []
  if (_socialPeer?.peer?.id) _roomMembers.set(_socialPeer.peer.id, getPublicProfilePayload(_profile?.username))
  setRoomStatus(`Подключение к руме ${r.roomId}...`)
  resetRoomHeartbeat()
  startRoomServerSync()
  loadRoomStateFromServer().catch(() => {})
  updateRoomUi()
  showToast('Подключение к руме...')
}

function joinFriendRoom(roomId) {
  joinRoomById(roomId)
}

function leaveRoom() {
  const prevRoomId = _roomState?.roomId
  removeRoomMemberPresence(prevRoomId).catch(() => {})
  stopRoomServerSync()
  if (!_socialPeer) return
  if (typeof _socialPeer.leaveRoom === 'function') _socialPeer.leaveRoom()
  _roomState = { roomId: null, host: false, hostPeerId: null }
  _roomMembers.clear()
  sharedQueue = []
  if (_roomHeartbeatTimer) clearInterval(_roomHeartbeatTimer)
  _roomHeartbeatTimer = null
  setRoomStatus('Рума: не активна')
  updateRoomUi()
  showToast('Вы покинули руму')
}

function copyInviteLink() {
  if (!_roomState?.roomId || !_profile?.username) return showToast('Сначала создай/войди в руму', true)
  const invite = `flow://join/${_profile.username}`
  navigator.clipboard?.writeText(invite)
    .then(() => showToast(`Invite скопирован: ${invite}`))
    .catch(() => showToast('Не удалось скопировать invite', true))
}

function openInviteModal() {
  const modal = document.getElementById('invite-modal')
  if (!modal) return
  const input = document.getElementById('invite-input')
  if (input) input.value = ''
  modal.classList.remove('hidden')
  requestAnimationFrame(() => { if (input) input.focus() })
}

function closeInviteModal() {
  const modal = document.getElementById('invite-modal')
  if (modal) modal.classList.add('hidden')
}

function submitInviteJoin() {
  const input = document.getElementById('invite-input')
  const roomId = resolveInviteToRoomId(String(input?.value || '').trim())
  if (!roomId) return
  closeInviteModal()
  joinRoomById(roomId)
}

function openPlaylistEditModal(mode, payload = {}) {
  const modal = document.getElementById('playlist-edit-modal')
  if (!modal) return
  const titleEl = document.getElementById('playlist-edit-title')
  const nameLabel = document.getElementById('playlist-edit-name-label')
  const descLabel = document.getElementById('playlist-edit-desc-label')
  const nameInput = document.getElementById('playlist-edit-name-input')
  const descInput = document.getElementById('playlist-edit-desc-input')
  if (!nameInput || !descInput) return
  _playlistEditContext = { mode, ...payload }
  if (mode === 'playlist-meta') {
    if (titleEl) titleEl.textContent = 'Редактировать плейлист'
    if (nameLabel) nameLabel.textContent = 'Название'
    if (descLabel) descLabel.textContent = 'Описание'
    nameInput.value = String(payload.name || '')
    descInput.value = String(payload.description || '')
    descInput.placeholder = 'Описание плейлиста'
  } else {
    if (titleEl) titleEl.textContent = 'Редактировать трек'
    if (nameLabel) nameLabel.textContent = 'Название трека'
    if (descLabel) descLabel.textContent = 'Исполнитель'
    nameInput.value = String(payload.title || '')
    descInput.value = String(payload.artist || '')
    descInput.placeholder = 'Исполнитель'
  }
  modal.classList.remove('hidden')
  requestAnimationFrame(() => nameInput.focus())
}

function closePlaylistEditModal() {
  const modal = document.getElementById('playlist-edit-modal')
  if (modal) modal.classList.add('hidden')
  _playlistEditContext = null
}

function submitPlaylistEditModal() {
  if (!_playlistEditContext) return
  const nameInput = document.getElementById('playlist-edit-name-input')
  const descInput = document.getElementById('playlist-edit-desc-input')
  if (!nameInput || !descInput) return
  const first = String(nameInput.value || '').trim()
  const second = String(descInput.value || '').trim()
  const pls = getPlaylists().map(normalizePlaylist)
  if (_playlistEditContext.mode === 'playlist-meta') {
    const idx = Number(_playlistEditContext.playlistIndex)
    if (!pls[idx]) return
    pls[idx].name = first || pls[idx].name
    pls[idx].description = second
    savePlaylists(pls)
    renderPlaylists()
    if (openPlaylistIndex === idx) openPlaylist(idx)
  } else if (_playlistEditContext.mode === 'track-meta') {
    const pIdx = Number(_playlistEditContext.playlistIndex)
    const tIdx = Number(_playlistEditContext.trackIndex)
    const track = pls[pIdx]?.tracks?.[tIdx]
    if (!track) return
    track.title = first || track.title
    track.artist = second || track.artist
    savePlaylists(pls)
    openPlaylist(pIdx)
  }
  closePlaylistEditModal()
}

function openLibraryActionModal(mode) {
  const modal = document.getElementById('library-action-modal')
  const title = document.getElementById('library-action-title')
  const input = document.getElementById('library-action-input')
  if (!modal || !title || !input) return
  _libraryActionMode = mode
  if (mode === 'create') {
    title.textContent = 'Создать плейлист'
    input.placeholder = 'Название плейлиста'
    input.value = ''
  } else {
    title.textContent = 'Импорт плейлиста по ссылке'
    input.placeholder = 'Вставь ссылку на плейлист (Spotify / Yandex / VK)'
    input.value = ''
  }
  modal.classList.remove('hidden')
  requestAnimationFrame(() => input.focus())
}

function closeLibraryActionModal() {
  const modal = document.getElementById('library-action-modal')
  if (modal) modal.classList.add('hidden')
  _libraryActionMode = null
}

async function submitLibraryActionModal() {
  const input = document.getElementById('library-action-input')
  const value = String(input?.value || '').trim()
  if (!value) return
  const mode = _libraryActionMode
  closeLibraryActionModal()
  if (mode === 'create') createPlaylist(value)
  else if (mode === 'import') await importPlaylistFromLink(value)
}

function openImportProgress(total = 0) {
  const modal = document.getElementById('import-progress-modal')
  if (modal) modal.classList.remove('hidden')
  updateImportProgress(0, total, 'Подготовка...')
}

function closeImportProgress() {
  const modal = document.getElementById('import-progress-modal')
  if (modal) modal.classList.add('hidden')
}

function updateImportProgress(done, total, text = '') {
  const safeDone = Math.max(0, Number(done) || 0)
  const safeTotal = Math.max(0, Number(total) || 0)
  const pct = safeTotal > 0 ? Math.round((safeDone / safeTotal) * 100) : 0
  const bar = document.getElementById('import-progress-bar')
  const count = document.getElementById('import-progress-count')
  const pctEl = document.getElementById('import-progress-pct')
  const textEl = document.getElementById('import-progress-text')
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`
  if (count) count.textContent = `${safeDone}/${safeTotal || 0}`
  if (pctEl) pctEl.textContent = `${pct}%`
  if (textEl) textEl.textContent = text || 'Импорт...'
}

function setImportProgressIndeterminate(enabled) {
  const bar = document.getElementById('import-progress-bar')
  const count = document.getElementById('import-progress-count')
  const pctEl = document.getElementById('import-progress-pct')
  if (bar) bar.classList.toggle('indeterminate', Boolean(enabled))
  if (enabled) {
    if (count) count.textContent = '...'
    if (pctEl) pctEl.textContent = '...'
  }
}

function promptInviteJoin() {
  openInviteModal()
}

async function pollFriendsPresence() {
  if (!_socialPeer || !_profile?.username || !peerSocial.getFriends) return
  const friends = peerSocial.getFriends(_profile.username) || []
  const entries = await Promise.all(friends.map(async (friend) => {
    const prev = _friendPresence.get(friend) || {}
    const isOnline = await _socialPeer.probeUser(friend, 1800).catch(() => false)
    if (!isOnline) {
      return [friend, { online: false, track: null, roomId: null, peerId: prev.peerId || null, updatedAt: Date.now() }]
    }
    let state = { online: true, track: prev.track || null, roomId: prev.roomId || `flow-${friend}`, peerId: prev.peerId || `flow-${friend}`, updatedAt: Date.now() }
    const peerId = `flow-${friend}`
    if (typeof _socialPeer.requestPeerData === 'function') {
      const response = await _socialPeer.requestPeerData(peerId, { type: 'presence-request' }, 2200).catch(() => null)
      if (response?.ok && response?.data?.type === 'presence-state') {
        const p = response.data
        state = {
          online: true,
          track: p.track || null,
          roomId: p.roomId || `flow-${friend}`,
          peerId: p.peerId || p._peerId || `flow-${friend}`,
          host: Boolean(p.host),
          updatedAt: Date.now(),
        }
        if (p.profile && (p.peerId || p._peerId)) {
          _peerProfiles.set(p.peerId || p._peerId, p.profile)
          cachePeerProfile(p.profile, p.peerId || p._peerId)
        }
      }
    }
    return [friend, state]
  }))
  _friendPresence = new Map(entries)
  renderFriends()
}

function broadcastPlaybackSync(force = false) {
  if (!_socialPeer || !_roomState.roomId || !currentTrack || !_roomState.host) return
  const now = Date.now()
  if (!force && now - _lastRoomSyncAt < 700) return
  _lastRoomSyncAt = now
  _socialPeer.send({
    type: 'playback-sync',
    roomId: _roomState.roomId,
    track: currentTrack,
    currentTime: Number(audio.currentTime || 0),
    paused: Boolean(audio.paused),
    source: currentTrack?.source || null,
    sharedQueue,
  })
  saveRoomStateToServer({
    now_playing: currentTrack,
    shared_queue: sharedQueue,
    playback_state: { paused: Boolean(audio.paused), currentTime: Number(audio.currentTime || 0) },
    playback_ts: Date.now(),
  }).catch(() => {})
}

// в”Ђв”Ђв”Ђ APP START в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
function startApp() {
  const profile = typeof peerSocial.getCurrentProfile === 'function' ? peerSocial.getCurrentProfile() : null
  _profile = profile || null
  if (_profile) {
    document.getElementById('screen-auth')?.classList.add('hidden')
    document.getElementById('screen-main')?.classList.remove('hidden')
    syncProfileUi()
    ensureSocialUI()
    ensureRoomsUI()
    renderFriends()
    initPeerSocial()
    syncIntegrationsUI()
    pollFriendsPresence().catch(() => {})
    if (_friendsPollTimer) clearInterval(_friendsPollTimer)
    _friendsPollTimer = setInterval(() => { pollFriendsPresence().catch(() => {}) }, 12000)
    const s = getSettings()
    if (s.discordRpcEnabled && s.discordClientId) {
      window.api?.discordRpcConnect?.(s.discordClientId).catch(() => {})
    }
  } else {
    document.getElementById('screen-main')?.classList.add('hidden')
    document.getElementById('screen-auth')?.classList.remove('hidden')
    switchTab('login')
    syncIntegrationsUI()
  }
  updateRoomUi()
  if (!localStorage.getItem('flow_first_launch_done')) {
    saveVisual({
      bgType: 'gradient',
      blur: 10,
      bright: 16,
      panelBlur: 18,
      visualMode: 'minimal',
      accent: '#4b5563',
      accent2: '#9ca3af',
      orb1Color: '#4b5563',
      orb2Color: '#9ca3af',
      homeSliderStyle: 'line',
      homeWidget: { enabled: true, mode: 'bars', image: null },
      effects: { orbs: false, glow: true, dyncolor: false },
      uiScale: 100
    })
    localStorage.setItem('flow_first_launch_done', '1')
  }
  // Repair previously injected custom covers in collections on each launch.
  restoreSourceCoversInCollections()
  renderLiked(); renderPlaylists(); updateSourceBadge(); syncSearchSourcePills()
  initVisualSettings()
  syncPlaybackModeUI()
  syncTrackCoverStatus()
}

function applyUiTextOverrides() {
  const set = (selector, text) => {
    const el = document.querySelector(selector)
    if (el) el.textContent = text
  }
  const setAttr = (selector, attr, value) => {
    const el = document.querySelector(selector)
    if (el) el.setAttribute(attr, value)
  }
  const nav = document.querySelectorAll('.nav-item')
  if (nav[0]?.querySelector('.nav-label')) nav[0].querySelector('.nav-label').textContent = 'Главная'
  if (nav[1]?.querySelector('.nav-label')) nav[1].querySelector('.nav-label').textContent = 'Поиск'
  if (nav[2]?.querySelector('.nav-label')) nav[2].querySelector('.nav-label').textContent = 'Библиотека'
  if (nav[3]?.querySelector('.nav-label')) nav[3].querySelector('.nav-label').textContent = 'Любимые'
  if (nav[4]?.querySelector('.nav-label')) nav[4].querySelector('.nav-label').textContent = 'Друзья'
  if (nav[5]?.querySelector('.nav-label')) nav[5].querySelector('.nav-label').textContent = 'Комнаты'
  if (nav[6]?.querySelector('.nav-label')) nav[6].querySelector('.nav-label').textContent = 'Настройки'
  const currentName = _profile?.username || 'слушатель'
  set('#welcome-text', `Привет, ${currentName}`)
  set('#user-name', currentName)
  set('.user-sub', 'слушатель')
  setAttr('#search-input', 'placeholder', 'Исполнитель, название трека...')
  set('#lyrics-track-name', '—')
  const setText = (selector, value) => {
    const el = document.querySelector(selector)
    if (el) el.textContent = value
  }
  setText('#page-settings .content-header h2', 'Настройки')
  setText('#page-library .content-header h2', 'Библиотека')
  setText('#page-liked .content-header h2', 'Любимые')
  setText('#page-profile .content-header h2', 'Профиль')
  setText('#page-profile .content-sub', 'Твой Flow профиль')
  setText('#page-rooms .content-header h2', 'Комнаты')
  setText('#page-rooms .content-sub', 'Совместное прослушивание и общая очередь')
  setText('#page-search .content-header h2', 'Поиск')
  setText('#page-search .content-sub', 'Найди трек')
  setText('#page-library .content-sub', 'Твои плейлисты')
  setText('#page-liked .content-sub', 'Треки, которые ты лайкнул')

  const labels = Array.from(document.querySelectorAll('#stab-panel-visual .vs-label'))
  labels.forEach((el) => {
    const t = (el.textContent || '').trim()
    if (t.includes('Blur') && t.includes('фона')) el.innerHTML = 'Blur фона <span class="vs-val" id="vs-blur-val">40px</span>'
    if (t.includes('Яркость') || t.includes('PЏ')) el.innerHTML = 'Яркость фона <span class="vs-val" id="vs-bright-val">50%</span>'
    if (t.includes('Прозрачн')) el.innerHTML = 'Прозрачность стекла <span class="vs-val" id="vs-glass-val">8%</span>'
    if (t.includes('панел')) el.innerHTML = 'Blur панелей <span class="vs-val" id="vs-panel-blur-val">30px</span>'
  })
}

function setupSidebarResize() {
  const sidebar = document.getElementById('sidebar')
  const resizer = document.getElementById('sidebar-resizer')
  if (!sidebar || !resizer) return
  const saved = parseInt(localStorage.getItem('flow_sidebar_w') || '210', 10)
  const applyW = (w) => {
    const clamped = Math.max(72, Math.min(320, w))
    document.documentElement.style.setProperty('--sidebar-w', clamped + 'px')
    localStorage.setItem('flow_sidebar_w', String(clamped))
    sidebar.classList.toggle('collapsed', clamped <= 92)
  }
  applyW(Number.isFinite(saved) ? saved : 210)
  let dragging = false
  resizer.addEventListener('mousedown', () => { dragging = true; document.body.style.cursor = 'ew-resize' })
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return
    applyW(e.clientX)
  })
  window.addEventListener('mouseup', () => {
    dragging = false
    document.body.style.cursor = ''
  })
}

function setupCardTilt() {
  const selector = '.track-card, .playlist-card, .social-friend-card, .profile-card, .home-card'
  let activeCard = null
  let rafId = 0
  let pendingEvt = null

  const resetCard = (el) => {
    if (!el) return
    el.style.setProperty('--card-tilt-x', '0deg')
    el.style.setProperty('--card-tilt-y', '0deg')
    el.style.setProperty('--card-tilt-glow-x', '50%')
    el.style.setProperty('--card-tilt-glow-y', '50%')
    el.classList.remove('is-tilting')
  }

  const updateTilt = () => {
    rafId = 0
    const e = pendingEvt
    const card = activeCard
    if (!e || !card) return
    const rect = card.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const px = (e.clientX - rect.left) / rect.width
    const py = (e.clientY - rect.top) / rect.height
    const rx = (0.5 - py) * 4.6
    const ry = (px - 0.5) * 4.6
    card.style.setProperty('--card-tilt-x', `${rx.toFixed(2)}deg`)
    card.style.setProperty('--card-tilt-y', `${ry.toFixed(2)}deg`)
    card.style.setProperty('--card-tilt-glow-x', `${Math.max(0, Math.min(100, px * 100)).toFixed(1)}%`)
    card.style.setProperty('--card-tilt-glow-y', `${Math.max(0, Math.min(100, py * 100)).toFixed(1)}%`)
    card.classList.add('is-tilting')
  }

  document.addEventListener('pointermove', (e) => {
    const card = e.target?.closest?.(selector) || null
    if (card !== activeCard) {
      resetCard(activeCard)
      activeCard = card
    }
    if (!activeCard) return
    pendingEvt = e
    if (!rafId) rafId = requestAnimationFrame(updateTilt)
  }, { passive: true })

  document.addEventListener('pointerleave', () => {
    pendingEvt = null
    if (rafId) cancelAnimationFrame(rafId)
    rafId = 0
    resetCard(activeCard)
    activeCard = null
  }, { passive: true })
}

function syncHomeCloneUI() {
  const cover = document.getElementById('home-clone-cover')
  const title = document.getElementById('home-clone-title')
  const artist = document.getElementById('home-clone-artist')
  const cur = document.getElementById('home-clone-time-cur')
  const tot = document.getElementById('home-clone-time-total')
  const prog = document.getElementById('home-clone-progress')
  if (!cover || !title || !artist || !cur || !tot || !prog) return
  if (currentTrack) {
    title.textContent = currentTrack.title || 'Ничего не играет'
    artist.textContent = currentTrack.artist || '—'
    applyCoverArt(cover, getEffectiveCoverUrl(currentTrack), currentTrack.bg || 'linear-gradient(135deg,#7c3aed,#a855f7)')
  } else {
    title.textContent = 'Ничего не играет'
    artist.textContent = '—'
    cover.style.backgroundImage = ''
    cover.innerHTML = COVER_ICON
  }
  cur.textContent = fmtTime(audio.currentTime)
  tot.textContent = fmtTime(audio.duration)
  prog.value = audio.duration ? (audio.currentTime / audio.duration) : 0
  const fill = (audio.duration ? (audio.currentTime / audio.duration) : 0) * 100
  prog.style.setProperty('--progress-fill', `${Math.max(0, Math.min(100, fill))}%`)
}

function alignHomeHeaderToPlay() {
  const main = document.querySelector('.home-clone-main')
  const head = document.querySelector('.home-clone-head')
  const play = document.querySelector('.home-clone-controls .play-btn')
  if (!main || !head || !play) return
  const mainRect = main.getBoundingClientRect()
  const headRect = head.getBoundingClientRect()
  const playRect = play.getBoundingClientRect()
  const headCenter = headRect.left + headRect.width / 2
  const playCenter = playRect.left + playRect.width / 2
  const delta = playCenter - headCenter
  const maxShift = Math.max(14, Math.floor(mainRect.width * 0.08))
  const shift = Math.max(-maxShift, Math.min(maxShift, delta))
  main.style.setProperty('--home-head-shift', `${shift.toFixed(1)}px`)
}

function ensureAudioAnalyzer() {
  const ensure = audioPlayer.ensureAudioAnalyser
  if (typeof ensure !== 'function') return false
  const state = { audioCtx: _audioCtx, analyser: _analyser, freqData: _freqData }
  const ok = ensure(audio, state)
  if (!ok) return false
  _audioCtx = state.audioCtx
  _analyser = state.analyser
  _freqData = state.freqData
  return true
}

function drawHomeVisualizerFrame() {
  const canvas = document.getElementById('home-visualizer-canvas')
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const v = getVisual()
  const hw = Object.assign({ enabled: true, mode: 'bars' }, v.homeWidget || {})
  if (!hw.enabled || hw.mode === 'image') return
  const w = canvas.width
  const h = canvas.height
  ctx.clearRect(0, 0, w, h)
  const canAnalyze = ensureAudioAnalyzer() && !audio.paused && !audio.ended
  if (canAnalyze) _analyser.getByteFrequencyData(_freqData)
  const data = _freqData || new Uint8Array(128)
  const baseColor = v.accent2 || '#9ca3af'
  ctx.strokeStyle = baseColor
  ctx.fillStyle = baseColor
  ctx.globalAlpha = 0.9
  if (hw.mode === 'wave') {
    ctx.beginPath()
    const step = Math.max(1, Math.floor(data.length / 52))
    for (let i = 0; i < 52; i++) {
      const val = data[i * step] || 0
      const y = h - (val / 255) * (h - 18) - 9
      const x = (i / 51) * w
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.lineWidth = 2
    ctx.stroke()
    return
  }
  if (hw.mode === 'dots') {
    const cols = 44
    const step = Math.max(1, Math.floor(data.length / cols))
    for (let i = 0; i < cols; i++) {
      const val = data[i * step] || 0
      const dots = Math.max(2, Math.round((val / 255) * 8))
      const x = 10 + (i / cols) * (w - 20)
      for (let d = 0; d < dots; d++) {
        const y = h - 10 - d * 12
        ctx.beginPath()
        ctx.arc(x, y, 2.4, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    return
  }
  const bars = 56
  const step = Math.max(1, Math.floor(data.length / bars))
  const bw = (w - 20) / bars
  for (let i = 0; i < bars; i++) {
    const val = data[i * step] || 0
    const bh = 8 + (val / 255) * (h - 24)
    const x = 10 + i * bw
    const y = h - bh - 6
    ctx.fillRect(x, y, Math.max(2, bw - 2), bh)
  }
}

function startHomeVisualizerLoop() {
  const tick = () => {
    drawHomeVisualizerFrame()
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

function syncPlayerUIFromTrack() {
  const track = currentTrack
  const cover = document.getElementById('player-cover')
  const homeCover = document.getElementById('home-clone-cover')
  const fallbackBg = track?.bg || 'linear-gradient(135deg,#7c3aed,#a855f7)'
  const coverUrl = getEffectiveCoverUrl(track)
  applyCoverArt(cover, coverUrl, fallbackBg)
  applyCoverArt(homeCover, coverUrl, fallbackBg)
  if (_playerModeActive) syncPlayerModeUI()
}

// в”Ђв”Ђв”Ђ NAVIGATION в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
let _activePageId = 'home'
let _deferredPageRenderRaf = 0

function runDeferredPageRender(id) {
  if (id === 'liked') return renderLiked()
  if (id === 'library') return renderPlaylists()
  if (id === 'social') return renderFriends()
  if (id === 'rooms') { renderRoomMembers(); return renderRoomQueue() }
  if (id === 'profile') return renderProfilePage()
  if (id === 'settings') return loadSettingsPage()
}

function openPage(id, opts = {}) {
  const force = Boolean(opts && opts.force)
  if (!force && id === _activePageId) return
  if (id === 'social') ensureSocialUI()
  if (id === 'rooms') ensureRoomsUI()
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'))
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'))
  document.getElementById('page-'+id)?.classList.add('active')
  const pages = ['home','search','library','liked','social','rooms','settings']
  const idx = pages.indexOf(id)
  if (idx >= 0) document.querySelectorAll('.nav-item')[idx]?.classList.add('active')
  _activePageId = id
  if (_deferredPageRenderRaf) cancelAnimationFrame(_deferredPageRenderRaf)
  _deferredPageRenderRaf = requestAnimationFrame(() => {
    _deferredPageRenderRaf = 0
    runDeferredPageRender(id)
  })
}

// в”Ђв”Ђв”Ђ PLAYER в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
async function playTrackObj(track, opts = {}) {
  if (_roomState?.roomId && !_roomState?.host && !opts?.remoteSync) {
    enqueueSharedTrack(track)
    return
  }
  const reqId = ++_playRequestSeq
  const isStale = () => reqId !== _playRequestSeq
  track = sanitizeTrack(track)
  const forcedCover = getEffectiveCoverUrl(track)
  if (forcedCover) {
    track = Object.assign({}, track, {
      _sourceCover: track?._sourceCover || track?.cover || '',
      cover: forcedCover,
      _customCover: true
    })
  }
  console.log('TRACK:', track)
  const originalRequestTrack = track
  const tryAlternateYoutubeVersion = async () => {
    try {
      const q = `${originalRequestTrack?.title || track.title} ${originalRequestTrack?.artist || track.artist}`.trim()
      const ytResults = await searchYouTube(q).catch(() => [])
      if (isStale()) return true
      const candidate = Array.isArray(ytResults)
        ? (ytResults.find((t) => t?.ytId && t.ytId !== track?.ytId) || null)
        : null
      if (!candidate || !candidate.ytId) return false
      showToast('YouTube: исходный ролик ограничен, пробую альтернативную версию')
      await playTrackObj(Object.assign({}, candidate, {
        title: originalRequestTrack?.title || candidate.title,
        artist: originalRequestTrack?.artist || candidate.artist,
        cover: getEffectiveCoverUrl(originalRequestTrack) || originalRequestTrack?.cover || candidate.cover
      }))
      return true
    } catch {
      return false
    }
  }
  // Spotify playback fallback through SoundCloud/Audius first.
  if (track.source === 'spotify' && !track.url) {
    showToast('\uD83C\uDFB5 Ищу в SoundCloud/Audius...')
    try {
      const query = `${track.title} ${track.artist}`.trim()
      if (isStale()) return
      const s = getSettings()
      const scResults = await searchSoundCloud(query, s.soundcloudClientId).catch(() => [])
      if (isStale()) return
      if (scResults?.length > 0) {
        return playTrackObj(Object.assign({}, scResults[0], {
          title: track.title,
          artist: track.artist,
          cover: getEffectiveCoverUrl(track) || track.cover || scResults[0].cover
        }))
      }
      const audResults = await searchAudius(query).catch(() => [])
      if (isStale()) return
      if (audResults?.length > 0) {
        return playTrackObj(Object.assign({}, audResults[0], {
          title: track.title,
          artist: track.artist,
          cover: getEffectiveCoverUrl(track) || track.cover || audResults[0].cover
        }))
      }
      showToast('Spotify: не найдено в SoundCloud/Audius', true)
      return
    } catch (e) {
      showToast('Spotify: ' + e.message, true)
      return
    }
  }

  currentTrack = track
  const newTrackKey = `${track.source}:${track.id}`
  const st = getListenStats()
  if (st.lastTrackKey !== newTrackKey) saveListenStats({ totalTracks: Number(st.totalTracks || 0) + 1, lastTrackKey: newTrackKey })
  let streamUrl = track.url
  let streamEngine = null
  const nameEl = document.getElementById('player-name')
  const artistEl = document.getElementById('player-artist')
  const playBtn = document.getElementById('play-btn')
  if (nameEl) nameEl.textContent = track.title || 'Без названия'
  const setStage = (text) => { if (artistEl) artistEl.textContent = text }
  setStage('Загрузка…')
  if (playBtn) playBtn.innerHTML = '<svg class="ui-icon spin-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7v5l3 2"/></svg>'

  // SoundCloud transcoding URL -> direct stream URL
  if (track.source === 'soundcloud' && track.scTranscoding && window.api?.scStream) {
    const res = await window.api.scStream(track.scTranscoding, track.scClientId).catch(e => ({ ok: false, error: e.message }))
    if (isStale()) return
    if (res.ok && res.url) {
      streamUrl = res.url
      track = Object.assign({}, track, { url: streamUrl })
      currentTrack = track
    } else {
      showToast('SoundCloud: ' + (res.error || 'ошибка'), true)
      if (playBtn) playBtn.innerHTML = ICONS.play
      return
    }
  }

  // YouTube stream URL via main process
  if (track.source === 'youtube' && track.ytId && window.api?.youtubeStream) {
    if (streamUrl && /^https?:\/\//i.test(streamUrl)) {
      streamEngine = track._streamInst || null
      setStage('YouTube: поток готов')
    } else {
      setStage('YouTube: получаю поток…')
      const res = await withTimeout(
        window.api.youtubeStream(track.ytId, _ytInstanceCache, { forceFresh: false }),
        35000,
        'youtube stream timeout'
      ).catch(e => ({ ok: false, error: e.message }))
      if (isStale()) return
      if (res.ok && res.url) {
        streamUrl = res.url
        track = Object.assign({}, track, { url: streamUrl })
        currentTrack = track
        streamEngine = res.inst || null
        if (res.inst) _ytInstanceCache = res.inst
        console.log('STREAM URL:', streamUrl, 'engine:', res.inst || 'unknown', 'cached:', Boolean(res.cached))
      } else {
        if (res?.code === 'AGE_RESTRICTED' || res?.code === 'BOT_CHECK' || /возрастн|нужны cookies|confirm your age|not a bot/i.test(String(res?.error || ''))) {
          const switched = await tryAlternateYoutubeVersion()
          if (switched || isStale()) return
        }
        setStage('YouTube: ошибка, пробую ещё раз…')
        // One quick retry with fresh URL before failing the track.
        const fresh = await withTimeout(
          window.api.youtubeStream(track.ytId, _ytInstanceCache, { forceFresh: true }),
          12000,
          'fresh youtube stream timeout'
        ).catch(e => ({ ok: false, error: e.message }))
        if (isStale()) return
        if (fresh.ok && fresh.url) {
          streamUrl = fresh.url
          track = Object.assign({}, track, { url: streamUrl })
          currentTrack = track
          streamEngine = fresh.inst || null
          if (fresh.inst) _ytInstanceCache = fresh.inst
          console.log('FRESH STREAM URL (after fail):', streamUrl, 'engine:', fresh.inst || 'unknown')
        } else {
          const switched = await tryAlternateYoutubeVersion()
          if (switched || isStale()) return
          showToast('YouTube: ' + (fresh.error || res.error || 'ошибка'), true)
          if (playBtn) playBtn.innerHTML = ICONS.play
          setStage('YouTube: ошибка')
          return
        }
      }
    }
  }

  if (!streamUrl) {
    showToast('Нет аудио потока', true)
    if (playBtn) playBtn.innerHTML = ICONS.play
    return
  }

  // External streams are played via local proxy for CORS/Range compatibility.
  let finalUrl = streamUrl
  // For yt-dlp direct googlevideo links, direct playback is often more stable than proxy.
  if (window.api?.proxySetUrl && /^https?:\/\//i.test(streamUrl) && streamEngine !== 'yt-dlp') {
    setStage('Прокси: подготовка…')
    try {
      finalUrl = await window.api.proxySetUrl(streamUrl)
    } catch (e) {
      console.warn('proxySetUrl failed, fallback to direct stream:', e?.message || e)
      finalUrl = streamUrl
    }
  }
  console.log('PLAY URL:', finalUrl)

  // Quick probe: helps decide if URL is dead/403 before we even try audio.
  if (window.api?.probeStreamUrl && /^https?:\/\//i.test(streamUrl) && streamEngine !== 'yt-dlp') {
    try {
      setStage('Проверка потока…')
      const p = await withTimeout(window.api.probeStreamUrl(streamUrl), 9000, 'probe timeout').catch(() => null)
      if (isStale()) return
      if (p && p.ok) {
        console.log('STREAM PROBE:', p.status, p.headers)
        // Common failure in 2026: 403 from googlevideo. Force fresh URL immediately.
        if (p.status === 403 && track.source === 'youtube' && track.ytId && window.api?.youtubeStream) {
          _ytInstanceCache = null
          const fresh = await withTimeout(
            window.api.youtubeStream(track.ytId, _ytInstanceCache, { forceFresh: true }),
            12000,
            'fresh youtube stream timeout'
          ).catch(err => ({ ok: false, error: err.message }))
          if (isStale()) return
          if (fresh.ok && fresh.url) {
            streamUrl = fresh.url
            if (fresh.inst) _ytInstanceCache = fresh.inst
            finalUrl = (window.api?.proxySetUrl && /^https?:\/\//i.test(streamUrl)) ? await window.api.proxySetUrl(streamUrl) : streamUrl
            console.log('FRESH URL AFTER 403 PROBE:', streamUrl, 'engine:', fresh.inst || 'unknown')
            setStage('YouTube: обновил поток, запускаю…')
          } else {
            showToast('YouTube 403: обнови yt-dlp (Настройки → Источники) или попробуй другой трек', true)
            setStage('YouTube: 403')
          }
        }
      }
    } catch {}
  }

  const waitForPlaybackProgress = (ms = 10000) => new Promise((resolve) => {
    const startedAt = audio.currentTime || 0
    const finish = (ok) => {
      clearTimeout(t)
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('playing', onPlaying)
      audio.removeEventListener('canplay', onCanPlay)
      resolve(ok)
    }
    const onTime = () => {
      if ((audio.currentTime || 0) > startedAt + 0.05) {
        finish(true)
      }
    }
    const onPlaying = () => {
      if (!audio.paused) finish(true)
    }
    const onCanPlay = () => {
      if (!audio.paused && audio.readyState >= 2) finish(true)
    }
    const t = setTimeout(() => {
      const advanced = (audio.currentTime || 0) > startedAt + 0.05
      const playable = !audio.paused && audio.readyState >= 2
      finish(Boolean(advanced || playable))
    }, ms)
    audio.addEventListener('timeupdate', onTime, { once: false })
    audio.addEventListener('playing', onPlaying, { once: true })
    audio.addEventListener('canplay', onCanPlay, { once: false })
  })

  const tryStartPlayback = async (url) => {
    if (isStale()) throw new Error('stale playback request')
    setStage('Старт воспроизведения…')
    audio.src = url
    await audio.play()
    // If nothing starts within ~5s, treat it as a dead stream and switch strategy.
    return waitForPlaybackProgress(5200)
  }

  let started = false
  try {
    started = await tryStartPlayback(finalUrl)
    if (!started) throw new Error('playback timeout')
  } catch (e) {
    if (String(e?.message || '').includes('stale playback request')) return
    // Retry path for YouTube: switch between direct/proxied strategies.
    if (track.source === 'youtube') {
      try {
        const alternateUrl = finalUrl === streamUrl
          ? ((window.api?.proxySetUrl && /^https?:\/\//i.test(streamUrl)) ? await window.api.proxySetUrl(streamUrl) : streamUrl)
          : streamUrl
        started = await tryStartPlayback(alternateUrl)
        if (!started) throw new Error('alternate playback timeout')
      } catch (e2) {
        if (String(e2?.message || '').includes('stale playback request')) return
        // Last chance: request a fresh stream URL and retry.
        try {
          // Avoid sticky dead instance/cache on retries.
          _ytInstanceCache = null
          const fresh = await withTimeout(
            window.api.youtubeStream(track.ytId, _ytInstanceCache, { forceFresh: true }),
            12000,
            'fresh youtube stream timeout'
          ).catch(err => ({ ok: false, error: err.message }))
          if (fresh.ok && fresh.url) {
            streamUrl = fresh.url
            if (fresh.inst) _ytInstanceCache = fresh.inst
            console.log('FRESH STREAM URL:', streamUrl, 'engine:', fresh.inst || 'unknown')
            const freshProxy = window.api?.proxySetUrl && /^https?:\/\//i.test(streamUrl) ? await window.api.proxySetUrl(streamUrl) : streamUrl
            started = await tryStartPlayback(freshProxy)
            if (!started) throw new Error('fresh stream timeout')
          } else {
            throw new Error(fresh.error || 'fresh stream failed')
          }
        } catch (e3) {
          if (String(e3?.message || '').includes('stale playback request')) return
          try {
            const switched = await tryAlternateYoutubeVersion()
            if (switched || isStale()) return
          } catch {}
          showToast('Ошибка воспроизведения: ' + (e3?.message || e2?.message || e?.message || 'unknown'), true)
          if (playBtn) playBtn.innerHTML = ICONS.play
          return
        }
      }
    } else {
      showToast('Ошибка воспроизведения: ' + (e?.message || 'unknown'), true)
      if (playBtn) playBtn.innerHTML = ICONS.play
      return
    }
  }

  if (nameEl) nameEl.textContent = track.title || 'Без названия'
  if (artistEl) artistEl.textContent = track.artist || '—'
  const cover = document.getElementById('player-cover')
  const effectiveCover = getEffectiveCoverUrl(track)
  applyCoverArt(cover, effectiveCover, track.bg || 'linear-gradient(135deg,#7c3aed,#a855f7)')
  if (playBtn) playBtn.innerHTML = ICONS.pause
  const pmIcon = document.getElementById('pm-play-icon')
  if (pmIcon) pmIcon.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'
  updatePlayerLikeBtn()
  // РћР±РЅРѕРІР»СЏРµРј titlebar
  const tinfo = document.getElementById('titlebar-track-info')
  if (tinfo) tinfo.textContent = track.title + (track.artist ? ' вЂ” ' + track.artist : '')
  // Р”РёРЅР°РјРёС‡РµСЃРєРёР№ С„РѕРЅ РѕС‚ РѕР±Р»РѕР¶РєРё
  if (effectiveCover) updateOrbsFromCover(effectiveCover)
  updateBackground()
  // РЎРёРЅС…СЂРѕРЅРёР·РёСЂСѓРµРј fullscreen РїР»РµРµСЂ
  syncPlayerModeUI()
  syncTrackCoverStatus()
  alignHomeHeaderToPlay()
  // Р—Р°РіСЂСѓР¶Р°РµРј lyrics РµСЃР»Рё РїР°РЅРµР»СЊ РѕС‚РєСЂС‹С‚Р°
  if (_lyricsOpen) loadLyrics(track)
  prewarmNextQueueTrack()
  renderRoomQueue()
  _currentTrackStartedAt = Math.floor(Date.now() / 1000)
  pushLastFmNowPlaying(track)
  updateDiscordPresence(track, _roomState)
  broadcastPlaybackSync(true)
}

function prewarmNextQueueTrack() {
  try {
    if (!window.api?.youtubeStream) return
    const next = queue[queueIndex + 1]
    if (!next || next.source !== 'youtube' || !next.ytId) return
    const key = String(next.ytId)
    const lastAt = Number(_ytPrewarmAt.get(key) || 0)
    if (Date.now() - lastAt < 90000) return
    _ytPrewarmAt.set(key, Date.now())
    window.api.youtubeStream(next.ytId, _ytInstanceCache, { forceFresh: false })
      .then((res) => {
        if (!res?.ok || !res?.url) return
        const idx = queueIndex + 1
        const cur = queue[idx]
        if (!cur || cur.ytId !== next.ytId) return
        queue[idx] = Object.assign({}, cur, { url: res.url, _streamInst: res.inst || null })
      })
      .catch(() => {})
  } catch {}
}

function togglePlay() {
  if (!audio.src) return
  const playBtn = document.getElementById('play-btn')
  const isRoomParticipant = Boolean(_roomState?.roomId)
  if (audio.paused) {
    audio.play()
    if (_audioCtx?.state === 'suspended') _audioCtx.resume().catch(() => {})
    if (playBtn) playBtn.innerHTML = ICONS.pause
    const icon = document.getElementById('pm-play-icon')
    if (icon) icon.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'
  } else {
    audio.pause()
    if (playBtn) playBtn.innerHTML = ICONS.play
    const icon = document.getElementById('pm-play-icon')
    if (icon) icon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>'
  }
  if (isRoomParticipant) {
    _socialPeer?.send?.({
      type: 'room-control-toggle',
      roomId: _roomState.roomId,
      paused: Boolean(audio.paused),
      currentTime: Number(audio.currentTime || 0),
    })
  }
  if (_roomState?.host) broadcastPlaybackSync(true)
}

function seekTo(val) {
  if (!canControlQueue()) {
    showHostOnlyToast()
    return
  }
  if (audio.duration) audio.currentTime = val * audio.duration
}
function setVolume(val) {
  const volume = Math.max(0, Math.min(1, Number(val) || 0))
  audio.volume = volume
  const v1 = document.getElementById('volume')
  const v2 = document.getElementById('pm-volume')
  const v3 = document.getElementById('pm-cover-volume')
  if (v1) v1.value = volume
  if (v2) v2.value = volume
  if (v3) v3.value = volume
}
function pickRandomQueueIndex() {
  if (!queue.length) return -1
  if (queue.length === 1) return 0
  let idx = queueIndex
  for (let i = 0; i < 8; i++) {
    const candidate = Math.floor(Math.random() * queue.length)
    if (candidate !== queueIndex) { idx = candidate; break }
  }
  return idx
}

function prevTrack() {
  if (!canControlQueue()) {
    showHostOnlyToast()
    return
  }
  if (!queue.length) return
  const resetThreshold = Math.max(1, Math.min(10, (Number(audio.duration) || 0) / 3 || 10))
  if (audio.currentTime > resetThreshold) { audio.currentTime = 0; return }
  const allowShuffle = playbackMode.shuffle && queueScope === 'liked'
  if (allowShuffle) {
    queueIndex = pickRandomQueueIndex()
    if (queueIndex >= 0) playTrackObj(queue[queueIndex])
    return
  }
  if (queueIndex > 0) {
    queueIndex--
  } else if (playbackMode.repeat === 'all') {
    queueIndex = queue.length - 1
  } else {
    audio.currentTime = 0
    return
  }
  playTrackObj(queue[queueIndex])
}

function nextTrack(autoEnded = false) {
  if (!canControlQueue() && !autoEnded) {
    showHostOnlyToast()
    return
  }
  if (!queue.length) return
  if (autoEnded && playbackMode.repeat === 'one') {
    audio.currentTime = 0
    audio.play().catch(() => {})
    return
  }
  const allowShuffle = playbackMode.shuffle && queueScope === 'liked'
  if (allowShuffle) {
    queueIndex = pickRandomQueueIndex()
    if (queueIndex >= 0) playTrackObj(queue[queueIndex])
    return
  }
  if (queueIndex < queue.length - 1) {
    queueIndex++
    playTrackObj(queue[queueIndex])
    return
  }
  if (playbackMode.repeat === 'all') {
    queueIndex = 0
    playTrackObj(queue[queueIndex])
    return
  }
  const playBtn = document.getElementById('play-btn')
  if (playBtn) playBtn.innerHTML = ICONS.play
}

audio.ontimeupdate = () => {
  // Keep general UI updates lightweight, but make lyrics sync feel tighter.
  const shouldSyncUi = (performance.now() - _lastUiSyncAt) >= 90
  if (_lyricsOpen && _lyricsData.length) syncLyrics((audio.currentTime || 0) + 0.03)
  if (shouldSyncUi) {
    _lastUiSyncAt = performance.now()
    const p = document.getElementById('progress')
    if (p && audio.duration) p.value = audio.currentTime / audio.duration

    const pmp = document.getElementById('pm-progress')
    if (pmp && audio.duration) pmp.value = audio.currentTime / audio.duration

    const cur = fmtTime(audio.currentTime)
    const tot = fmtTime(audio.duration)
    const el1 = document.getElementById('time-current'); if (el1) el1.textContent = cur
    const el2 = document.getElementById('time-total');   if (el2) el2.textContent = tot
    const el3 = document.getElementById('pm-time-current'); if (el3) el3.textContent = cur
    const el4 = document.getElementById('pm-time-total');   if (el4) el4.textContent = tot

    syncHomeCloneUI()
  }
  broadcastPlaybackSync(false)
  if (!_profile?.username || audio.paused || !audio.duration) return
  const now = Date.now()
  if (!_listenTickAt) _listenTickAt = now
  const delta = Math.max(0, now - _listenTickAt) / 1000
  _listenTickAt = now
  if (delta > 0 && delta < 4) {
    const st = getListenStats()
    saveListenStats({ totalSeconds: Number(st.totalSeconds || 0) + delta })
  }
}
audio.onended = () => {
  stopLyricsSyncLoop()
  _listenTickAt = 0
  const playBtn = document.getElementById('play-btn')
  if (playBtn) playBtn.innerHTML = ICONS.play
  if (currentTrack) scrobbleLastFm(currentTrack)
  if (isRoomClientRestricted()) return
  if (_roomState?.roomId && _roomState?.host && sharedQueue.length) {
    const nextRoomTrack = sharedQueue.shift()
    renderRoomQueue()
    broadcastQueueUpdate()
    saveRoomStateToServer({ shared_queue: sharedQueue, playback_ts: Date.now() }).catch(() => {})
    if (nextRoomTrack) {
      playTrackObj(nextRoomTrack, { fromSharedQueue: true }).catch(() => {})
      return
    }
  }
  nextTrack(true)
}

// в”Ђв”Ђв”Ђ SEARCH в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
function normalizeInvokeError(err) {
  const raw = String(err?.message || err || '')
  return raw.replace(/^Error invoking remote method '[^']+': Error:\s*/i, '').trim()
}

function isCredentialError(message, source) {
  const msg = String(message || '').toLowerCase()
  if (source === 'vk') return msg.includes('token') || msg.includes('kate') || msg.includes('access') || msg.includes('python runtime') || msg.includes('selenium') || msg.includes('webdriver')
  if (source === 'soundcloud') return msg.includes('client id') || msg.includes('token') || msg.includes('401') || msg.includes('403')
  if (source === 'spotify') return msg.includes('bearer') || msg.includes('token') || msg.includes('401') || msg.includes('403')
  return false
}

function pickFallbackSource(failedSource) {
  const order = ['youtube']
  return order.find((src) => src !== failedSource && providers[src]) || null
}

async function searchHybridTracks(q, settings) {
  if (window.api?.serverSearch) {
    const payload = await withTimeout(window.api.serverSearch(q, {
      spotifyToken: settings?.spotifyToken || '',
      soundcloudClientId: settings?.soundcloudClientId || ''
    }), 10000, null)
    if (payload?.ok) return { mode: payload.mode || 'hybrid', tracks: sanitizeTrackList(payload.tracks || []) }
    if (payload && !payload.ok) throw new Error(payload.error || 'Поиск на сервере не дал результатов')
    throw new Error('Серверный поиск недоступен')
  }
  throw new Error('Серверный поиск недоступен в этой версии приложения')
}

function searchTracks(queryOverride = '') {
  if (typeof queryOverride === 'string' && queryOverride.trim()) {
    return searchTracksDirect(queryOverride.trim(), getSettings())
  }
  clearTimeout(searchDebounceTimer)
  let q = document.getElementById('search-input').value.trim()
  const container = document.getElementById('search-results')
  if (!q) { container.innerHTML = ''; return }

  container.innerHTML = `<div class="search-loading"><div class="spinner"></div><span>Поиск: Spotify → SoundCloud → Audius...</span></div>`

  searchDebounceTimer = setTimeout(async () => {
    const s = getSettings()
    const key = `hybrid:${q}:${Boolean(s.spotifyToken)}`
    const cached = cacheGet(key)
    if (cached) {
      _lastSearchMode = cached.mode || 'hybrid'
      renderResults(cached.tracks || [])
      return
    }

    try {
      const hybrid = await searchHybridTracks(q, s)
      const results = sanitizeTrackList(hybrid.tracks || [])
      _lastSearchMode = hybrid.mode || 'hybrid'
      cacheSet(key, { mode: _lastSearchMode, tracks: results })
      renderResults(results)
    } catch (err) {
      const message = sanitizeDisplayText(normalizeInvokeError(err))
      container.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg class="ui-icon lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.8 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0Z"/></svg></div><p>${message}</p><button class="btn-small" onclick="openPage('settings')" style="margin-top:12px"><svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15.5A3.5 3.5 0 1 0 12 8.5a3.5 3.5 0 0 0 0 7Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.96 19.35a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87A1.7 1.7 0 0 0 3 13.96H2.9a2 2 0 1 1 0-4H3A1.7 1.7 0 0 0 4.64 8.4a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V2.9a2 2 0 1 1 4 0V3a1.7 1.7 0 0 0 1.04 1.56h.09a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c0 .69.41 1.31 1.04 1.56H21.1a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1.04V15Z"/></svg> Настройки</button></div>`
    }
  }, 350)
}

async function searchTracksDirect(query, settings = getSettings()) {
  const q = String(query || '').trim()
  if (!q) return []
  const src = String(settings?.activeSource || currentSource || 'youtube').toLowerCase()
  if (src === 'hitmo' || src === 'hm') return sanitizeTrackList(await searchHitmo(q))
  if (src === 'youtube' || src === 'yt') {
    if (!window.api?.youtubeSearch) throw new Error('YouTube поиск доступен только в Electron')
    const result = await window.api.youtubeSearch(q)
    if (!Array.isArray(result)) throw new Error('YouTube: unexpected response')
    return sanitizeTrackList(result.map((t) => ({
      title: t?.title || 'Без названия',
      artist: t?.artist || 'YouTube',
      ytId: t?.ytId || t?.id || '',
      url: t?.url || null,
      cover: t?.cover || null,
      bg: t?.bg || 'linear-gradient(135deg,#ff0000,#cc0000)',
      source: 'youtube',
      id: String(t?.id || t?.ytId || `${t?.title || ''}:${t?.artist || ''}`)
    }))).filter((t) => t.ytId)
  }
  const hybrid = await searchHybridTracks(q, settings)
  return sanitizeTrackList(hybrid?.tracks || [])
}
function renderResults(results) {
  results = sanitizeTrackList(results)
  const container = document.getElementById('search-results')
  const meta = document.getElementById('search-results-meta')
  const countEl = document.getElementById('results-count')
  const srcEl = document.getElementById('results-source-label')
  if (!results?.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg class="ui-icon lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg></div><p>Ничего не найдено</p><small>Попробуй другой запрос или источник</small></div>`
    if (meta) meta.style.display = 'none'
    return
  }
  queue = results; queueIndex = 0; queueScope = 'search'
  if (meta) { meta.style.display = 'flex'; }
  if (countEl) countEl.textContent = `${results.length} треков`
  if (srcEl) srcEl.textContent = getSourceLabel()
  container.innerHTML = ''
  results.forEach((track, i) => {
    const el = makeTrackEl(track, true, false)
    el.addEventListener('click', () => { queueIndex=i; playTrackObj(track) })
    container.appendChild(el)
  })
}

function getSourceLabel() {
  if (_lastSearchMode === 'spotify') return 'Spotify'
  if (_lastSearchMode === 'soundcloud') return 'SoundCloud'
  if (_lastSearchMode === 'audius') return 'Audius'
  if (_lastSearchMode === 'youtube') return 'YouTube'
  return 'Spotify → SoundCloud → Audius'
}

async function searchAudius(q) {
  if (!window.api?.audiusSearch) throw new Error('Audius доступен только в Electron приложении')
  const result = await window.api.audiusSearch(q)
  if (!Array.isArray(result)) throw new Error('Audius: некорректный ответ')
  return result.map((t) => ({
    title: t.title || 'Без названия',
    artist: t.artist || '—',
    url: t.url || null,
    cover: t.cover || null,
    bg: t.bg || 'linear-gradient(135deg,#2dd4bf,#0ea5e9)',
    source: 'audius',
    id: t.id || `${t.title || ''}:${t.artist || ''}`
  })).filter((t) => t.url)
}

// в”Ђв”Ђв”Ђ SOUNDCLOUD в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
let _scAutoClientId = null

async function getScClientId(manualId) {
  if (manualId) return manualId
  if (_scAutoClientId) return _scAutoClientId
  if (window.api?.scFetchClientId) {
    showToast('РџРѕР»СѓС‡Р°СЋ SoundCloud Client ID...')
    const r = await window.api.scFetchClientId()
    if (r.ok && r.clientId) { _scAutoClientId = r.clientId; return _scAutoClientId }
    throw new Error('РќРµ СѓРґР°Р»РѕСЃСЊ РїРѕР»СѓС‡РёС‚СЊ SC Client ID: ' + (r.error||''))
  }
  throw new Error('SoundCloud: РЅРµС‚ Client ID вЂ” СѓРєР°Р¶Рё РІ РЅР°СЃС‚СЂРѕР№РєР°С… вљ™пёЏ')
}

async function searchSoundCloud(q, manualClientId) {
  const clientId = await getScClientId(manualClientId)
  if (!window.api?.scSearch) throw new Error('SoundCloud серверный поиск недоступен')
  const result = await window.api.scSearch(q, clientId)
  if (!result.ok) {
    if (result.expired && !manualClientId) {
      _scAutoClientId = null
      const freshId = await getScClientId(null)
      const retry = await window.api.scSearch(q, freshId)
      if (!retry.ok) throw new Error('SoundCloud: ' + retry.error)
      return mapScTracks(retry.tracks, freshId)
    }
    throw new Error('SoundCloud: ' + result.error)
  }
  return mapScTracks(result.tracks, clientId)
}

async function mapScTracks(tracks, clientId) {
  const results = []
  for (const t of tracks) {
    if (!t.streamable) continue
    let transcodingUrl = null
    if (t.media?.transcodings?.length > 0) {
      const prog = t.media.transcodings.find(tr => tr.format?.protocol === 'progressive')
      const tr = prog || t.media.transcodings[0]
      if (tr) transcodingUrl = tr.url
    }
    results.push({
      title: t.title, artist: t.user?.username || 'вЂ”',
      url: t.stream_url ? `${t.stream_url}?client_id=${clientId}` : null,
      scTranscoding: transcodingUrl, scClientId: clientId,
      cover: t.artwork_url ? t.artwork_url.replace('large','t300x300') : null,
      bg: 'linear-gradient(135deg,#f26f23,#ff5500)', source: 'soundcloud', id: String(t.id)
    })
    if (results.length >= 20) break
  }
  return results
}

// в”Ђв”Ђв”Ђ VK в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
async function searchVK(q, token) {
  if (!token) throw new Error('Укажи токен ВКонтакте в настройках')
  if (window.api?.vkSearch) {
    let result
    try {
      result = await window.api.vkSearch(q, token)
    } catch (err) {
      throw new Error(normalizeInvokeError(err))
    }
    if (!Array.isArray(result)) throw new Error('VK: unexpected response')
    return result
  }
  const res = await fetch(`https://api.vk.com/method/audio.search?q=${encodeURIComponent(q)}&access_token=${token}&v=5.131&count=20`)
  if (!res.ok) throw new Error(`VK error ${res.status}`)
  const data = await res.json()
  if (data.error) {
    const c = data.error.error_code
    if (c===5) throw new Error('VK: токен недействителен — обнови в настройках')
    if (c===15) throw new Error('VK: нужен токен Kate Mobile')
    throw new Error('VK: ' + data.error.error_msg)
  }
  return (data.response?.items||[]).filter(t=>t?.url).map(t => ({
    title: t.title||'Без названия', artist: t.artist||'—', url: t.url,
    cover: t.album?.thumb?.photo_300||null, bg: 'linear-gradient(135deg,#4680c2,#5b9bd5)', source:'vk', id:String(t.id)
  }))
}

// в”Ђв”Ђв”Ђ HITMO в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
async function searchHitmo(q) {
  if (!window.api?.hitmoSearch) throw new Error('Hitmo серверный поиск недоступен')
  const result = await window.api.hitmoSearch(q)
  if (!result.ok) throw new Error('Hitmo: ' + (result.error || 'ошибка поиска'))
  return result.tracks
}

function parseHitmoResults(html) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')
  const tracks = []

  // Hitmo uses .play-track or similar list items
  const items = doc.querySelectorAll('.song-item, .track-item, .music-item, [data-url], [data-mp3]')

  items.forEach(item => {
    // Try to get mp3 url
    const audioUrl = item.getAttribute('data-mp3') || item.getAttribute('data-url') ||
      item.querySelector('[data-mp3]')?.getAttribute('data-mp3') ||
      item.querySelector('a[href$=".mp3"]')?.href

    // Title and artist
    const titleEl = item.querySelector('.song-title, .track-name, .title, h3, h4, .name')
    const artistEl = item.querySelector('.song-artist, .artist, .performer, .author')

    // Cover image
    const imgEl = item.querySelector('img[src], [data-src]')
    const coverUrl = imgEl?.src || imgEl?.getAttribute('data-src') || null

    if (!audioUrl && !titleEl) return

    const rawTitle = titleEl?.textContent?.trim() || item.getAttribute('data-title') || 'Р‘РµР· РЅР°Р·РІР°РЅРёСЏ'
    const rawArtist = artistEl?.textContent?.trim() || item.getAttribute('data-artist') || 'вЂ”'

    tracks.push({
      title: rawTitle,
      artist: rawArtist,
      url: audioUrl || null,
      cover: coverUrl,
      bg: 'linear-gradient(135deg,#ff2e88,#a020f0)',
      source: 'hitmo',
      id: audioUrl || (rawTitle + rawArtist)
    })

    if (tracks.length >= 25) return
  })

  // If selector didn't find items, try a more generic approach
  if (tracks.length === 0) {
    // Try JSON data embedded in page
    const scripts = doc.querySelectorAll('script')
    scripts.forEach(s => {
      const text = s.textContent
      // look for track list JSON
      const jsonMatch = text.match(/tracks\s*[:=]\s*(\[.*?\])/s) || text.match(/trackList\s*[:=]\s*(\[.*?\])/s)
      if (jsonMatch) {
        try {
          const data = JSON.parse(jsonMatch[1])
          data.forEach(t => {
            tracks.push({
              title: t.title || t.name || 'Р‘РµР· РЅР°Р·РІР°РЅРёСЏ',
              artist: t.artist || t.performer || 'вЂ”',
              url: t.url || t.mp3 || t.src || null,
              cover: t.cover || t.image || t.img || null,
              bg: 'linear-gradient(135deg,#ff2e88,#a020f0)',
              source: 'hitmo',
              id: t.id || (t.title + t.artist)
            })
          })
        } catch(e) {}
      }
    })
  }

  if (tracks.length === 0) {
    throw new Error('Hitmo: РЅРёС‡РµРіРѕ РЅРµ РЅР°Р№РґРµРЅРѕ РёР»Рё СЃС‚СЂСѓРєС‚СѓСЂР° СЃС‚СЂР°РЅРёС†С‹ РёР·РјРµРЅРёР»Р°СЃСЊ. РџРѕРїСЂРѕР±СѓР№ YouTube.')
  }

  return tracks
}

// в”Ђв”Ђв”Ђ YOUTUBE в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
let _ytInstanceCache = null

async function searchYouTube(q) {
  if (!window.api?.youtubeSearch) throw new Error('YouTube РґРѕСЃС‚СѓРїРµРЅ С‚РѕР»СЊРєРѕ РІ Electron РїСЂРёР»РѕР¶РµРЅРёРё')
  const result = await window.api.youtubeSearch(q)
  if (!result.ok) throw new Error(result.error || 'YouTube: РѕС€РёР±РєР° РїРѕРёСЃРєР°')
  if (!Array.isArray(result.tracks) || result.tracks.length === 0) return []
  _ytInstanceCache = result.instance
  const tracks = result.tracks
  if (window.api?.youtubePrefetchStreams) {
    const ids = tracks.slice(0, 8).map(t => t.ytId).filter(Boolean)
    if (ids.length) window.api.youtubePrefetchStreams(ids, _ytInstanceCache).catch(() => {})
  }
  return tracks
}

function setYtDlpStatus(text, sub = '') {
  const el = document.getElementById('ytdlp-status')
  const subEl = document.getElementById('ytdlp-sub')
  if (el) el.textContent = text
  if (subEl) subEl.textContent = sub || ''
}

async function refreshYtDlpStatus() {
  if (!window.api?.ytdlpInfo) return
  try {
    const info = await window.api.ytdlpInfo()
    if (!info?.ok) {
      setYtDlpStatus('Ошибка проверки', sanitizeDisplayText(info?.error || 'unknown'))
      return
    }
    const p = info.resolved?.path
    const v = info.resolved?.version
    if (p) setYtDlpStatus(`Готов: ${v || 'версия неизвестна'}`, p)
    else setYtDlpStatus('Не найден', 'Нажми “Обновить yt-dlp” или установи: winget install yt-dlp.yt-dlp')
  } catch (e) {
    setYtDlpStatus('Ошибка проверки', sanitizeDisplayText(e?.message || String(e)))
  }
}

async function updateYtDlpNow() {
  const btn = document.getElementById('ytdlp-update-btn')
  if (btn) { btn.disabled = true; btn.textContent = 'Обновляю...' }
  try {
    if (!window.api?.ytdlpUpdate) throw new Error('Недоступно (только в Electron)')
    const r = await window.api.ytdlpUpdate()
    if (!r?.ok) throw new Error(r?.error || 'update failed')
    const v = r?.info?.resolved?.version || r?.info?.managed?.version || r?.result?.version || null
    showToast(v ? `yt-dlp обновлён: ${v}` : 'yt-dlp обновлён')
  } catch (e) {
    showToast('yt-dlp: ' + sanitizeDisplayText(e?.message || String(e)), true)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Обновить yt-dlp' }
    refreshYtDlpStatus().catch(() => {})
  }
}

// в”Ђв”Ђв”Ђ SPOTIFY в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
async function searchSpotify(q, token) {
  if (!token) throw new Error('РЈРєР°Р¶Рё Spotify Bearer С‚РѕРєРµРЅ РІ РЅР°СЃС‚СЂРѕР№РєР°С… вљ™пёЏ')
  const res = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=20&market=RU`, {
    headers: { 'Authorization': `Bearer ${token}` }
  })
  if (res.status===401) throw new Error('Spotify: С‚РѕРєРµРЅ РёСЃС‚С‘Рє вЂ” РѕР±РЅРѕРІРё РІ РЅР°СЃС‚СЂРѕР№РєР°С… вљ™пёЏ')
  if (res.status===403) throw new Error('Spotify: РЅРµС‚ РґРѕСЃС‚СѓРїР° вљ™пёЏ')
  if (!res.ok) throw new Error(`Spotify РѕС€РёР±РєР° ${res.status}`)
  const data = await res.json()
  return (data.tracks?.items||[]).map(t => ({
    title: t.name, artist: t.artists?.map(a=>a.name).join(', ')||'вЂ”',
    cover: t.album?.images?.[0]?.url||null, url: null,
    bg: 'linear-gradient(135deg,#1db954,#1aa34a)',
    source: 'spotify', id: t.id, spotifyId: t.id
  }))
}

// в”Ђв”Ђв”Ђ LIKES в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
function getLiked() { return JSON.parse(localStorage.getItem('flow_liked')) || [] }
function isLiked(track) { return getLiked().some(t => t.id===track.id && t.source===track.source) }

function likeTrack(track) {
  let liked = getLiked()
  if (isLiked(track)) { liked=liked.filter(t=>!(t.id===track.id&&t.source===track.source)); showToast('РЈР±СЂР°РЅРѕ РёР· Р»СЋР±РёРјС‹С…') }
  else { liked.push(track); showToast('Р”РѕР±Р°РІР»РµРЅРѕ РІ Р»СЋР±РёРјС‹Рµ в™Ґ') }
  localStorage.setItem('flow_liked', JSON.stringify(liked))
  renderLiked(); updatePlayerLikeBtn(); syncLikeButtonsInVisibleLists()
}

function syncLikeButtonsInVisibleLists() {
  document.querySelectorAll('.track-like[data-track-json]').forEach((btn) => {
    let track = null
    try { track = JSON.parse(btn.getAttribute('data-track-json') || '{}') } catch {}
    if (!track) return
    const liked = isLiked(track)
    btn.classList.toggle('liked', liked)
    btn.innerHTML = liked ? HEART_FILLED : HEART_OUTLINE
  })
}

function likeCurrentTrack() { if (currentTrack) likeTrack(currentTrack) }

function updatePlayerLikeBtn() {
  const btn = document.getElementById('player-like-btn'); if (!btn||!currentTrack) return
  const liked = isLiked(currentTrack)
  btn.innerHTML = liked ? HEART_FILLED : HEART_OUTLINE
  btn.classList.toggle('liked', liked)
  const pmBtn = document.getElementById('pm-like-btn')
  const pmCoverBtn = document.getElementById('pm-cover-like-btn')
  if (pmBtn) { pmBtn.innerHTML = liked ? HEART_FILLED : HEART_OUTLINE; pmBtn.classList.toggle('liked', liked) }
  if (pmCoverBtn) { pmCoverBtn.innerHTML = liked ? HEART_FILLED : HEART_OUTLINE; pmCoverBtn.classList.toggle('liked', liked) }
}

let _likedRenderToken = 0
function renderLiked() {
  const token = ++_likedRenderToken
  const liked = getLiked()
  const container = document.getElementById('liked-list'); if (!container) return
  if (!liked.length) { container.innerHTML=`<div class="empty-state"><div class="empty-icon"><svg class="ui-icon lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-4.35-9.5-8A5.5 5.5 0 0 1 12 5.1 5.5 5.5 0 0 1 21.5 13c-2.5 3.65-9.5 8-9.5 8Z"/></svg></div><p>Ты еще не лайкнул ни одного трека</p></div>`; return }
  container.innerHTML = ''
  let i = 0
  const chunkSize = 18
  const renderChunk = () => {
    if (token !== _likedRenderToken) return
    const fragment = document.createDocumentFragment()
    for (let n = 0; n < chunkSize && i < liked.length; n++, i++) {
      const rowIndex = i
      const track = liked[rowIndex]
      const el = makeTrackEl(track, true, false)
      el.addEventListener('click', () => {
        queue = liked.slice()
        queueIndex = rowIndex
        queueScope = 'liked'
        playTrackObj(track)
      })
      fragment.appendChild(el)
    }
    container.appendChild(fragment)
    if (i < liked.length) setTimeout(renderChunk, 0)
  }
  renderChunk()
}

// в”Ђв”Ђв”Ђ PLAYLISTS в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
function getPlaylists() { return JSON.parse(localStorage.getItem('flow_playlists')) || [] }
function savePlaylists(pls) { localStorage.setItem('flow_playlists', JSON.stringify(pls)) }
function normalizePlaylist(pl) {
  const source = pl && typeof pl === 'object' ? pl : {}
  return {
    name: String(source.name || 'Playlist').trim() || 'Playlist',
    description: String(source.description || '').trim(),
    coverData: source.coverData || null,
    tracks: Array.isArray(source.tracks) ? source.tracks : [],
  }
}

function createPlaylist(nameFromUi = '') {
  const name = String(nameFromUi || '').trim()
  if (!name) return openLibraryActionModal('create')
  const pls = getPlaylists()
  pls.push(normalizePlaylist({ name: name.trim(), tracks: [] }))
  savePlaylists(pls)
  renderPlaylists()
}
window.createPlaylist = createPlaylist

function deletePlaylist(idx) {
  if (!confirm('РЈРґР°Р»РёС‚СЊ РїР»РµР№Р»РёСЃС‚?')) return
  const pls = getPlaylists(); pls.splice(idx,1); savePlaylists(pls); renderPlaylists()
}

function openPlaylist(idx) {
  openPlaylistIndex = idx
  const pl = normalizePlaylist(getPlaylists()[idx])
  if (!pl) return
  document.getElementById('playlist-view-name').textContent = pl.name
  const metaEl = document.getElementById('playlist-view-meta')
  if (metaEl) metaEl.textContent = pl.description || `${pl.tracks.length} треков`
  const coverEl = document.getElementById('playlist-view-cover')
  if (coverEl) {
    const playlistCover = sanitizeMediaByGifMode(pl.coverData || '', 'playlist')
    coverEl.style.backgroundImage = playlistCover ? `url(${playlistCover})` : ''
    coverEl.innerHTML = playlistCover ? '' : '<svg class="ui-icon lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'
  }
  document.getElementById('playlists-list').classList.add('hidden')
  document.querySelector('.section-header')?.classList.add('hidden')
  const viewEl = document.getElementById('playlist-view')
  if (viewEl) {
    viewEl.classList.remove('hidden')
    viewEl.classList.remove('is-opening')
    requestAnimationFrame(() => viewEl.classList.add('is-opening'))
  }
  const container = document.getElementById('playlist-tracks')
  if (!pl.tracks.length) { container.innerHTML=`<div class="empty-state"><div class="empty-icon"><svg class="ui-icon lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div><p>Плейлист пуст</p></div>`; return }
  container.innerHTML=''
  pl.tracks.forEach((track, i) => {
    const row = document.createElement('div')
    row.className = 'playlist-track-row'
    row.dataset.idx = String(i)
    row.draggable = true
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drag-over') })
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'))
    row.addEventListener('drop', (e) => {
      e.preventDefault()
      row.classList.remove('drag-over')
      const toIndex = Number(row.dataset.idx)
      reorderPlaylistTrack(openPlaylistIndex, _playlistDragIndex, toIndex)
    })
    row.addEventListener('dragend', () => {
      _playlistDragIndex = -1
      row.classList.remove('drag-over')
      row.classList.remove('dragging')
    })
    const handle = document.createElement('button')
    handle.className = 'playlist-track-handle'
    handle.title = 'Перетащить'
    handle.innerHTML = '<span>⋮⋮</span>'
    handle.addEventListener('dragstart', (e) => {
      _playlistDragIndex = i
      row.classList.add('dragging')
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
    })
    const el = makeTrackEl(track, false, false)
    el.classList.add('playlist-track-card')
    el.addEventListener('click', () => {
      queue = pl.tracks.slice()
      queueIndex = i
      queueScope = 'playlist'
      playTrackObj(track)
    })
    const actions = document.createElement('div')
    actions.className = 'playlist-track-actions'
    actions.innerHTML = `
      <button class="playlist-track-action" title="Редактировать трек">✎</button>
      <button class="playlist-track-action danger" title="Удалить из плейлиста">✕</button>
    `
    actions.children[0].addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      editPlaylistTrack(openPlaylistIndex, i)
    })
    actions.children[1].addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      removeTrackFromPlaylist(openPlaylistIndex, i)
    })
    row.appendChild(handle)
    row.appendChild(el)
    row.appendChild(actions)
    container.appendChild(row)
  })
}

function closePlaylist() {
  openPlaylistIndex=null
  const viewEl = document.getElementById('playlist-view')
  if (viewEl) {
    viewEl.classList.add('hidden')
    viewEl.classList.remove('is-opening')
  }
  document.getElementById('playlists-list').classList.remove('hidden')
  document.querySelector('.section-header')?.classList.remove('hidden')
}

function normalizeImportQuery(title, artist) {
  const rawTitle = String(title || '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim()
  const t = smartCleaning.smartCleanTrackTitle ? smartCleaning.smartCleanTrackTitle(rawTitle) : rawTitle
  const a = String(artist || '').replace(/\s+/g, ' ').trim()
  return `${a} ${t}`.trim()
}

function buildImportQueries(title, artist) {
  const t = String(title || '').trim()
  const a = String(artist || '').trim()
  const base = normalizeImportQuery(t, a)
  const variants = [
    base,
    `${a} - ${t}`.trim(),
    `${t} ${a}`.trim(),
    t,
  ].filter(Boolean)
  return [...new Set(variants)]
}

function importDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let _importProgressOpenedAt = 0
async function closeImportProgressSafe(minVisibleMs = 900) {
  const elapsed = Date.now() - Number(_importProgressOpenedAt || 0)
  if (elapsed < minVisibleMs) await importDelay(minVisibleMs - elapsed)
  closeImportProgress()
}

async function processPlaylistImport(trackList, imported = {}) {
  const srcTracks = Array.isArray(trackList) ? trackList : []
  const maxTracks = Math.min(srcTracks.length, 120)
  const collected = []
  const notFound = []
  openImportProgress(maxTracks)
  try {
    for (let i = 0; i < maxTracks; i++) {
      const it = srcTracks[i] || {}
      const queries = buildImportQueries(it.title, it.artist)
      const query = queries[0] || ''
      updateImportProgress(i, maxTracks, `Импорт: ${i} из ${maxTracks} треков...`)
      if (!query) {
        notFound.push(`Track ${i + 1}`)
        continue
      }
      try {
        let first = null
        const settings = getSettings()
        for (const q of queries) {
          // 1) Same chain as regular search bar.
          const hybrid = await searchHybridTracks(q, settings).catch(() => ({ tracks: [] }))
          const found = sanitizeTrackList(hybrid?.tracks || [])
          if (Array.isArray(found) && found.length) {
            first = found[0]
            break
          }
          // 2) Direct YouTube fallback (often more forgiving for imports).
          if (window.api?.youtubeSearch) {
            const yt = await window.api.youtubeSearch(q).catch(() => [])
            const ytSafe = sanitizeTrackList(Array.isArray(yt) ? yt : [])
            if (ytSafe.length) {
              first = ytSafe[0]
              break
            }
          }
        }
        if (first) {
          collected.push(Object.assign({}, first, {
            title: it.title || first.title,
            artist: it.artist || first.artist
          }))
        } else {
          const row = `${it.artist || '—'} - ${it.title || '—'}`
          notFound.push(row)
          console.warn('Не удалось найти:', row)
        }
      } catch (trackErr) {
        const row = `${it.artist || '—'} - ${it.title || '—'}`
        notFound.push(row)
        console.warn('Ошибка поиска, пропуск:', row, trackErr?.message || trackErr)
      }
      updateImportProgress(i + 1, maxTracks, `Импорт: ${i + 1} из ${maxTracks} треков...`)
      await importDelay(300 + Math.floor(Math.random() * 201))
    }
    const pls = getPlaylists()
    const name = `${imported.name || 'Imported Playlist'} [${imported.service || 'import'}]`
    pls.push(normalizePlaylist({ name, tracks: collected }))
    savePlaylists(pls)
    renderPlaylists()
    openPage('library')
  } finally {
    closeImportProgress()
  }
  return { added: collected.length, missed: notFound.length, total: maxTracks }
}

async function importPlaylistFromLink(urlFromUi = '') {
  showToast('Открываю импорт плейлиста...')
  const url = String(urlFromUi || '').trim()
  if (!url) return openLibraryActionModal('import')
  if (!window.api?.importPlaylistLink) {
    showToast('Импорт доступен только в Electron', true)
    return
  }
  const settings = getSettings()
  showToast('Импортирую плейлист...')
  openImportProgress(0)
  _importProgressOpenedAt = Date.now()
  setImportProgressIndeterminate(true)
  updateImportProgress(0, 0, 'Разбираю ссылку и получаю список треков...')
  const imported = await window.api.importPlaylistLink(url.trim(), {
    spotify: settings.spotifyToken || '',
    yandex: settings.yandexToken || '',
    vk: settings.vkToken || ''
  }).catch((e) => ({ ok: false, error: e?.message || String(e) }))
  setImportProgressIndeterminate(false)

  if (!imported?.ok) {
    updateImportProgress(0, 0, `Ошибка: ${sanitizeDisplayText(imported?.error || 'ошибка')}`)
    await closeImportProgressSafe(1200)
    showToast('Импорт: ' + sanitizeDisplayText(imported?.error || 'ошибка'), true)
    return
  }

  const srcTracks = Array.isArray(imported.tracks) ? imported.tracks : []
  if (!srcTracks.length) {
    updateImportProgress(0, 0, 'В плейлисте не найдено треков')
    await closeImportProgressSafe(1200)
    showToast('В плейлисте не найдено треков', true)
    return
  }

  try {
    const stats = await processPlaylistImport(srcTracks, imported)
    showToast(`Импорт завершен. Добавлено ${stats.added} треков, ${stats.missed} не найдено`)
  } catch (err) {
    updateImportProgress(0, 0, `Ошибка: ${sanitizeDisplayText(err?.message || String(err))}`)
    await closeImportProgressSafe(1200)
    showToast(`Импорт сорвался: ${sanitizeDisplayText(err?.message || String(err))}`, true)
  }
}
window.importPlaylistFromLink = importPlaylistFromLink

async function importVkPlaylistToFlow() {
  const input = document.getElementById('vk-playlist-link-input')
  if (!input) return showToast('Поле ссылки VK не найдено', true)
  const url = String(input?.value || '').trim()
  if (!url) return showToast('Вставь ссылку на плейлист VK', true)
  showToast('Запускаю импорт VK...')
  try {
    await importPlaylistFromLink(url)
  } catch (err) {
    showToast(`Импорт VK: ${sanitizeDisplayText(err?.message || String(err))}`, true)
  }
}
window.importVkPlaylistToFlow = importVkPlaylistToFlow

function addToPlaylist(track) {
  const pls = getPlaylists().map(normalizePlaylist)
  openPlaylistPickerModal({
    mode: 'add-track-playlist',
    title: 'Добавить трек в плейлист',
    items: pls.map((p, idx) => ({ id: String(idx), label: `${p.name} (${p.tracks.length})` })),
    payload: { track }
  })
}

let _playlistRenderToken = 0
function renderPlaylists() {
  const token = ++_playlistRenderToken
  const pls = getPlaylists().map(normalizePlaylist)
  const container = document.getElementById('playlists-list'); if (!container) return
  if (!pls.length) { container.innerHTML=`<div class="empty-state"><div class="empty-icon"><svg class="ui-icon lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg></div><p>Нет плейлистов — создай первый!</p></div>`; return }
  container.innerHTML=''
  let idx = 0
  const chunkSize = 20
  const renderChunk = () => {
    if (token !== _playlistRenderToken) return
    const fragment = document.createDocumentFragment()
    for (let n = 0; n < chunkSize && idx < pls.length; n++, idx++) {
      const currentIdx = idx
      const pl = pls[currentIdx]
      const el = document.createElement('div'); el.className='playlist-card'
      const playlistCover = sanitizeMediaByGifMode(pl.coverData || '', 'playlist')
      const coverStyle = ''
      el.innerHTML=`
        <div class="playlist-icon" style="${coverStyle}" title="Плейлист">${playlistCover ? '' : '<svg class="ui-icon lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'}</div>
        <div class="playlist-info" onclick="openPlaylist(${currentIdx})" style="cursor:pointer">
          <span class="playlist-name">${pl.name}</span>
          <span class="playlist-count">${pl.tracks.length} треков${pl.description ? ` • ${pl.description}` : ''}</span>
        </div>
        <div class="playlist-card-actions">
          <button class="playlist-del" onclick="event.stopPropagation();editPlaylistMeta(${currentIdx})" title="Редактировать">✎</button>
          <button class="playlist-del" onclick="event.stopPropagation();deletePlaylist(${currentIdx})">${ICONS.close}</button>
        </div>`
      if (playlistCover) {
        const icon = el.querySelector('.playlist-icon')
        applyCachedCoverBackground(icon, playlistCover, '', `playlist:${currentIdx}`)
      }
      el.addEventListener('click', () => openPlaylist(currentIdx))
      fragment.appendChild(el)
    }
    container.appendChild(fragment)
    if (idx < pls.length) setTimeout(renderChunk, 0)
  }
  renderChunk()
}

function playOpenPlaylist() {
  if (openPlaylistIndex == null) return
  const pl = normalizePlaylist(getPlaylists()[openPlaylistIndex])
  if (!pl?.tracks?.length) return showToast('Плейлист пуст', true)
  queue = pl.tracks.slice()
  queueIndex = 0
  queueScope = 'playlist'
  playTrackObj(queue[0]).catch(() => {})
}

function shuffleOpenPlaylist() {
  if (openPlaylistIndex == null) return
  const pl = normalizePlaylist(getPlaylists()[openPlaylistIndex])
  if (!pl?.tracks?.length) return showToast('Плейлист пуст', true)
  const shuffled = pl.tracks.slice().sort(() => Math.random() - 0.5)
  queue = shuffled
  queueIndex = 0
  queueScope = 'playlist'
  playTrackObj(queue[0]).catch(() => {})
}

function editOpenPlaylist() {
  if (openPlaylistIndex == null) return
  editPlaylistMeta(openPlaylistIndex)
  // Keep cover change inside the same edit flow.
  setTimeout(() => {
    const shouldPickCover = confirm('Сменить обложку плейлиста сейчас?')
    if (shouldPickCover) pickPlaylistCover(openPlaylistIndex)
  }, 40)
}

function exportPlaylistsFile() {
  try {
    const payload = {
      format: 'flow-playlists-v1',
      exportedAt: new Date().toISOString(),
      playlists: getPlaylists().map(normalizePlaylist),
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const stamp = new Date().toISOString().slice(0, 10)
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `flow-playlists-${stamp}.json`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(link.href)
    showToast('Плейлисты экспортированы')
  } catch (err) {
    showToast(`Ошибка экспорта: ${err?.message || err}`, true)
  }
}

function pickPlaylistImportFile() {
  const input = document.getElementById('playlist-import-file')
  if (!input) return
  input.click()
}

function importPlaylistsFile(input) {
  const file = input?.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    try {
      const payload = JSON.parse(String(reader.result || '{}'))
      const raw = Array.isArray(payload) ? payload : payload?.playlists
      if (!Array.isArray(raw)) throw new Error('Неверный формат файла')
      const imported = raw.map(normalizePlaylist).filter((pl) => pl?.name)
      if (!imported.length) throw new Error('В файле нет плейлистов')
      const current = getPlaylists().map(normalizePlaylist)
      savePlaylists([...current, ...imported])
      renderPlaylists()
      showToast(`Импортировано плейлистов: ${imported.length}`)
    } catch (err) {
      showToast(`Ошибка импорта: ${err?.message || err}`, true)
    } finally {
      input.value = ''
    }
  }
  reader.readAsText(file)
}

function removeTrackFromPlaylist(playlistIndex, trackIndex) {
  const pls = getPlaylists().map(normalizePlaylist)
  if (!pls[playlistIndex]) return
  pls[playlistIndex].tracks.splice(trackIndex, 1)
  savePlaylists(pls)
  openPlaylist(playlistIndex)
  renderPlaylists()
}

function editPlaylistTrack(playlistIndex, trackIndex) {
  const pls = getPlaylists().map(normalizePlaylist)
  const track = pls[playlistIndex]?.tracks?.[trackIndex]
  if (!track) return
  openPlaylistEditModal('track-meta', {
    playlistIndex,
    trackIndex,
    title: track.title || '',
    artist: track.artist || '',
  })
}

function reorderPlaylistTrack(playlistIndex, fromIndex, toIndex) {
  if (playlistIndex == null || fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return
  const pls = getPlaylists().map(normalizePlaylist)
  const list = pls[playlistIndex]?.tracks
  if (!Array.isArray(list) || fromIndex >= list.length || toIndex >= list.length) return
  const [moved] = list.splice(fromIndex, 1)
  list.splice(toIndex, 0, moved)
  savePlaylists(pls)
  openPlaylist(playlistIndex)
}

async function setPlaylistCoverFromFile(idx, file) {
  if (!file || !file.type.startsWith('image/')) return showToast('Нужен файл изображения', true)
  const dataUrl = await readFileAsDataUrl(file).catch(() => '')
  if (!dataUrl) return showToast('Не удалось прочитать изображение', true)
  const pls = getPlaylists().map(normalizePlaylist)
  if (!pls[idx]) return
  pls[idx].coverData = dataUrl
  savePlaylists(pls)
  renderPlaylists()
  showToast('Обложка плейлиста обновлена')
}

function pickPlaylistCover(idx) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (file) await setPlaylistCoverFromFile(idx, file)
  }
  input.click()
}

function editPlaylistMeta(idx) {
  const pls = getPlaylists().map(normalizePlaylist)
  const playlist = pls[idx]
  if (!playlist) return
  openPlaylistEditModal('playlist-meta', {
    playlistIndex: idx,
    name: playlist.name || '',
    description: playlist.description || '',
  })
}

// в”Ђв”Ђв”Ђ TRACK CARD в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
const SRC_LABELS = { soundcloud:'SC', vk:'VK', hitmo:'HM', youtube:'YT', spotify:'SP' }

function makeTrackEl(track, showPlaylist=false, bindDefaultPlay=true) {
  track = sanitizeTrack(track)
  const el = document.createElement('div'); el.className='track-card'
  const liked = isLiked(track)
  const trackJson = JSON.stringify(track).replace(/"/g,'&quot;')
  const trackCover = getListCoverUrl(track)
  const fallbackBg = track.bg||'linear-gradient(135deg,#7c3aed,#a855f7)'
  const coverStyle = `background:${fallbackBg};`
  const srcLbl = SRC_LABELS[track.source]||''
  const badge = srcLbl ? `<span class="track-source track-source-${track.source}">${srcLbl}</span>` : ''
  el.innerHTML=`
    <div class="track-cover" style="${coverStyle}">${trackCover?'':'<svg class="ui-icon lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'}
      <div class="cover-overlay"><div class="cover-play-icon"><svg viewBox="0 0 24 24" width="10" height="10" style="fill:#111;margin-left:1px"><polygon points="5 3 19 12 5 21 5 3"/></svg></div></div>
    </div>
    <div class="track-info">
      <span class="track-name">${track.title}</span>
      <span class="track-artist">${track.artist||'вЂ”'} ${badge}</span>
    </div>
    <button class="track-like ${liked?'liked':''}" data-track-json="${trackJson}" onclick="event.stopPropagation();likeTrack(${trackJson})">${liked ? HEART_FILLED : HEART_OUTLINE}</button>
    ${showPlaylist?`<button class="track-like" onclick="event.stopPropagation();addToPlaylist(${trackJson})" title="Р’ РїР»РµР№Р»РёСЃС‚">${ICONS.plus}</button>`:''}
    <button class="track-play"><svg viewBox="0 0 24 24" width="10" height="10" style="fill:currentColor;margin-left:1px"><polygon points="5 3 19 12 5 21 5 3"/></svg></button>`
  if (trackCover) {
    const coverEl = el.querySelector('.track-cover')
    applyCachedCoverBackground(coverEl, trackCover, fallbackBg, getTrackKey(track))
  }
  if (bindDefaultPlay) {
    el.addEventListener('click', () => {
      queue = [track]
      queueIndex = 0
      queueScope = 'generic'
      playTrackObj(track)
    })
  }
  return el
}

// в”Ђв”Ђв”Ђ LYRICS в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
let _lyricsData = []       // [{time, text}] РґР»СЏ synced
let _lyricsActiveIdx = -1
let _lyricsOpen = false
let _lyricsSettingsOpen = false
let _lyricsObserver = null
let _lyricsLastPaintAt = 0
let _lyricsRafId = 0

function stopLyricsSyncLoop() {
  if (_lyricsRafId) cancelAnimationFrame(_lyricsRafId)
  _lyricsRafId = 0
}

function startLyricsSyncLoop() {
  if (_lyricsRafId) return
  const tick = () => {
    if (!_lyricsOpen || !_lyricsData.length || audio.paused) {
      _lyricsRafId = 0
      return
    }
    syncLyrics((audio.currentTime || 0) + 0.03)
    _lyricsRafId = requestAnimationFrame(tick)
  }
  _lyricsRafId = requestAnimationFrame(tick)
}

function observeLyricsVisibility(target) {
  if (!target || typeof IntersectionObserver !== 'function') return
  if (_lyricsObserver) _lyricsObserver.disconnect()
  _lyricsObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) entry.target.classList.add('is-visible')
      else entry.target.classList.remove('is-visible')
    })
  }, { root: target, threshold: 0.12 })
  target.querySelectorAll('.lyrics-line').forEach((line) => _lyricsObserver.observe(line))
}

function getLyricsVisualSettings() {
  const v = getVisual()
  const src = v.lyrics || {}
  return {
    scrollMode: src.scrollMode === 'line' ? 'line' : 'smooth',
    align: src.align === 'center' ? 'center' : 'left',
    playbackMode: src.playbackMode === 'karaoke' ? 'karaoke' : (src.playbackMode === 'focus' ? 'focus' : 'standard'),
    effect: src.effect === 'glow' ? 'glow' : (src.effect === 'contrast' ? 'contrast' : 'soft'),
    size: Math.max(13, Math.min(42, Number(src.size || 16))),
    blur: Math.max(0, Math.min(8, Number(src.blur || 4))),
  }
}

function applyLyricsVisualSettings() {
  const cfg = getLyricsVisualSettings()
  document.documentElement.style.setProperty('--lyrics-size', `${cfg.size}px`)
  document.documentElement.style.setProperty('--lyrics-blur', `${cfg.blur}px`)
  document.body.classList.toggle('lyrics-align-center', cfg.align === 'center')
  document.body.classList.toggle('lyrics-align-left', cfg.align !== 'center')
  document.body.classList.remove('lyrics-mode-standard', 'lyrics-mode-karaoke', 'lyrics-mode-focus')
  document.body.classList.add(`lyrics-mode-${cfg.playbackMode}`)
  document.body.classList.remove('lyrics-effect-soft', 'lyrics-effect-glow', 'lyrics-effect-contrast')
  document.body.classList.add(`lyrics-effect-${cfg.effect}`)
  const modeEl = document.getElementById('pm-lyrics-scroll-mode')
  const playbackModeEl = document.getElementById('pm-lyrics-playback-mode')
  const effectEl = document.getElementById('pm-lyrics-effect')
  const sizeEl = document.getElementById('pm-lyrics-size')
  const leftBtn = document.getElementById('pm-lyrics-align-left')
  const centerBtn = document.getElementById('pm-lyrics-align-center')
  if (playbackModeEl) playbackModeEl.value = cfg.playbackMode
  if (modeEl) modeEl.value = cfg.scrollMode
  if (effectEl) effectEl.value = cfg.effect
  if (sizeEl) sizeEl.value = String(cfg.size)
  if (leftBtn) leftBtn.classList.toggle('active', cfg.align === 'left')
  if (centerBtn) centerBtn.classList.toggle('active', cfg.align === 'center')
}

function setLyricsPlaybackMode(mode) {
  const safe = mode === 'karaoke' ? 'karaoke' : (mode === 'focus' ? 'focus' : 'standard')
  const v = getVisual()
  const lyrics = Object.assign({}, v.lyrics || {}, { playbackMode: safe })
  saveVisual({ lyrics })
  applyLyricsVisualSettings()
}

function setLyricsEffect(effect) {
  const safe = effect === 'glow' ? 'glow' : (effect === 'contrast' ? 'contrast' : 'soft')
  const v = getVisual()
  const lyrics = Object.assign({}, v.lyrics || {}, { effect: safe })
  saveVisual({ lyrics })
  applyLyricsVisualSettings()
}

function setLyricsScrollMode(mode) {
  const v = getVisual()
  const lyrics = Object.assign({}, v.lyrics || {}, { scrollMode: mode === 'line' ? 'line' : 'smooth' })
  saveVisual({ lyrics })
  applyLyricsVisualSettings()
}

function setLyricsAlign(mode) {
  const v = getVisual()
  const lyrics = Object.assign({}, v.lyrics || {}, { align: mode === 'center' ? 'center' : 'left' })
  saveVisual({ lyrics })
  applyLyricsVisualSettings()
}

function setLyricsSize(value) {
  const v = getVisual()
  const size = Math.max(13, Math.min(42, Number(value || 16)))
  const lyrics = Object.assign({}, v.lyrics || {}, { size })
  saveVisual({ lyrics })
  applyLyricsVisualSettings()
}

function toggleLyrics() {
  _lyricsOpen = !_lyricsOpen
  if (!_lyricsOpen) {
    stopLyricsSyncLoop()
    _lyricsSettingsOpen = false
    document.getElementById('pm-lyrics-controls-panel')?.classList.add('hidden')
  }
  refreshLyricsPanelsVisibility()
  document.getElementById('lyrics-btn')?.classList.toggle('active', _lyricsOpen)
  document.getElementById('pm-cover-lyrics-btn')?.classList.toggle('active', _lyricsOpen)
  if (_lyricsOpen && currentTrack) {
    loadLyrics(currentTrack)
    startLyricsSyncLoop()
  }
}

function toggleLyricsSettingsPanel() {
  _lyricsSettingsOpen = !_lyricsSettingsOpen
  const panel = document.getElementById('pm-lyrics-controls-panel')
  if (panel) panel.classList.toggle('hidden', !_lyricsSettingsOpen)
}

function togglePmLyricsFromCover() {
  toggleLyrics()
}

function togglePmVolumePopover(event) {
  if (event?.stopPropagation) event.stopPropagation()
  const pop = document.getElementById('pm-cover-volume-pop')
  if (!pop) return
  pop.classList.toggle('hidden')
}

document.addEventListener('click', (event) => {
  const pop = document.getElementById('pm-cover-volume-pop')
  if (!pop || pop.classList.contains('hidden')) return
  const btn = document.getElementById('pm-cover-volume-btn')
  if (pop.contains(event.target) || btn?.contains(event.target)) return
  pop.classList.add('hidden')
})

function parseLRC(lrc) {
  const lines = lrc.split('\n')
  return lines.map(line => {
    const m = line.match(/\[(\d+):(\d+\.\d+)\](.*)/)
    if (!m) return null
    return { time: parseInt(m[1]) * 60 + parseFloat(m[2]), text: m[3].trim() }
  }).filter(x => x && x.text)
}

async function loadLyrics(track) {
  const container = document.getElementById('lyrics-content')
  const pmContainer = document.getElementById('pm-lyrics-content')
  const titleEl = document.getElementById('lyrics-track-name')
  const pmTitleEl = document.getElementById('pm-lyrics-track-name')
  if (!container && !pmContainer) return
  _lyricsData = []
  _lyricsActiveIdx = -1
  if (titleEl) titleEl.textContent = track.title || '—'
  if (pmTitleEl) pmTitleEl.textContent = track.title || '—'
  if (container) container.innerHTML = '<div class="lyrics-loading"><div class="spinner"></div><span>Загрузка текста...</span></div>'
  if (pmContainer) pmContainer.innerHTML = '<div class="lyrics-loading"><div class="spinner"></div><span>Загрузка текста...</span></div>'
  if (!window.api?.getLyrics) {
    if (container) container.innerHTML = '<div class="lyrics-empty">Текст доступен только в Electron</div>'
    if (pmContainer) pmContainer.innerHTML = '<div class="lyrics-empty">Текст доступен только в Electron</div>'
    return
  }
  const res = await window.api.getLyrics(track.title, track.artist || '', audio.duration || 0)
  if (!res.ok) {
    if (container) container.innerHTML = '<div class="lyrics-empty">Текст не найден</div>'
    if (pmContainer) pmContainer.innerHTML = '<div class="lyrics-empty">Текст не найден</div>'
    return
  }
  if (res.synced) {
    _lyricsData = parseLRC(res.synced)
    const renderSynced = (target) => {
      if (!target) return
      target.innerHTML = ''
      const topSpacer = document.createElement('div')
      topSpacer.className = 'lyrics-spacer'
      target.appendChild(topSpacer)
      _lyricsData.forEach((line, i) => {
        const div = document.createElement('div')
        div.className = 'lyrics-line'
        div.dataset.idx = String(i)
        div.innerHTML = ''
        ;[...String(line.text || '')].forEach((ch, chIdx) => {
          const span = document.createElement('span')
          span.className = 'lyrics-char'
          span.dataset.charIdx = String(chIdx)
          span.textContent = ch === ' ' ? '\u00A0' : ch
          div.appendChild(span)
        })
        div.onclick = () => {
          if (isRoomClientRestricted()) return showToast('Только хост управляет плеером', true)
          audio.currentTime = line.time
        }
        target.appendChild(div)
      })
      const bottomSpacer = document.createElement('div')
      bottomSpacer.className = 'lyrics-spacer'
      target.appendChild(bottomSpacer)
      observeLyricsVisibility(target)
    }
    renderSynced(container)
    renderSynced(pmContainer)
    if (_lyricsOpen) startLyricsSyncLoop()
  } else if (res.plain) {
    _lyricsData = []
    const plain = `<div class="lyrics-plain">${res.plain.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>`
    if (container) container.innerHTML = plain
    if (pmContainer) pmContainer.innerHTML = plain
  } else {
    if (container) container.innerHTML = '<div class="lyrics-empty">Текст не найден</div>'
    if (pmContainer) pmContainer.innerHTML = '<div class="lyrics-empty">Текст не найден</div>'
  }
}

function syncLyrics(currentTime) {
  if (!_lyricsData.length) return
  const cfg = getLyricsVisualSettings()
  let idx = -1
  for (let i = 0; i < _lyricsData.length; i++) {
    if (_lyricsData[i].time <= currentTime) idx = i
    else break
  }
  const idxChanged = idx !== _lyricsActiveIdx
  const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
  if (!idxChanged && now - _lyricsLastPaintAt < 16) return
  _lyricsLastPaintAt = now
  if (idxChanged) {
    _lyricsActiveIdx = idx
    document.querySelectorAll('.lyrics-line').forEach((el) => {
      const i = Number(el.dataset.idx || -1)
      el.classList.toggle('active', i === idx)
      el.classList.toggle('past', i >= 0 && i < idx)
      el.classList.toggle('future', i > idx)
    })
  }
  if (cfg.playbackMode === 'karaoke') {
    if (idxChanged) {
      document.querySelectorAll('.lyrics-line:not(.active) .lyrics-char.karaoke-on, .lyrics-line:not(.active) .lyrics-char.karaoke-next').forEach((el) => {
        el.classList.remove('karaoke-on', 'karaoke-next')
        el.style.removeProperty('--karaoke-frac')
      })
    }
    const start = idx >= 0 ? Number(_lyricsData[idx]?.time || 0) : 0
    const end = idx >= 0 ? Number(_lyricsData[idx + 1]?.time || (start + 2.2)) : 0
    const duration = Math.max(0.4, end - start)
    const progress = idx >= 0 ? Math.max(0, Math.min(1, (currentTime - start) / duration)) : 0
    const easedProgress = progress * progress * (3 - 2 * progress)
    document.querySelectorAll('.lyrics-line.active').forEach((lineEl) => {
      const chars = Array.from(lineEl.querySelectorAll('.lyrics-char'))
      if (!chars.length) return
      const spread = easedProgress * chars.length
      const activeCount = Math.max(0, Math.min(chars.length, Math.floor(spread)))
      const nextFrac = Math.max(0, Math.min(1, spread - activeCount))
      lineEl.style.setProperty('--line-progress', `${(easedProgress * 100).toFixed(2)}%`)
      chars.forEach((charEl, cIdx) => {
        charEl.classList.toggle('karaoke-on', cIdx < activeCount)
        const isNext = cIdx === activeCount && activeCount < chars.length
        charEl.classList.toggle('karaoke-next', isNext)
        if (isNext) charEl.style.setProperty('--karaoke-frac', nextFrac.toFixed(3))
        else charEl.style.removeProperty('--karaoke-frac')
      })
    })
  } else if (idxChanged) {
    document.querySelectorAll('.lyrics-char.karaoke-on, .lyrics-char.karaoke-next').forEach((el) => {
      el.classList.remove('karaoke-on', 'karaoke-next')
      el.style.removeProperty('--karaoke-frac')
    })
    document.querySelectorAll('.lyrics-line').forEach((lineEl) => lineEl.style.removeProperty('--line-progress'))
  }
  if (idx >= 0) {
    const el = document.querySelector('.pm-lyrics-shell:not(.hidden) .lyrics-line.active')
      || document.querySelector('#lyrics-panel:not(.hidden) .lyrics-line.active')
      || document.querySelector('.lyrics-line.active')
    if (el && idxChanged) el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
  }
}

// в”Ђв”Ђв”Ђ SC TEST в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
async function testScAutoId() {
  const btn = document.getElementById('sc-test-btn'); const msg = document.getElementById('sc-msg')
  if (!btn||!msg) return
  btn.textContent='вЏі РџСЂРѕРІРµСЂСЏСЋ...'; btn.disabled=true; msg.textContent=''; msg.className='token-msg'
  try {
    if (!window.api?.scFetchClientId) { msg.textContent='РўРѕР»СЊРєРѕ РІ Electron'; msg.className='token-msg token-msg-err'; return }
    _scAutoClientId = null
    const r = await window.api.scFetchClientId()
    if (r.ok && r.clientId) {
      _scAutoClientId = r.clientId
      msg.textContent=`вњ“ РџРѕРґРєР»СЋС‡РµРЅРѕ! ID: ${r.clientId.slice(0,8)}вЂўвЂўвЂўвЂў`; msg.className='token-msg token-msg-ok'
      const el = document.getElementById('sc-status'); if (el) el.className='token-status token-ok'
      const tx = document.getElementById('sc-status-text'); if (tx) tx.textContent='РџРѕРґРєР»СЋС‡РµРЅРѕ'
    } else { msg.textContent='вњ— '+(r.error||'РЅРµРёР·РІРµСЃС‚РЅРѕ'); msg.className='token-msg token-msg-err' }
  } catch(e) { msg.textContent='вњ— '+e.message; msg.className='token-msg token-msg-err' }
  btn.textContent='рџ”„ РџСЂРѕРІРµСЂРёС‚СЊ РїРѕРґРєР»СЋС‡РµРЅРёРµ Рє SoundCloud'; btn.disabled=false
}

function setupAppDragAndDrop() {
  if (typeof dragDrop.setupGlobalDragDrop !== 'function') return
  dragDrop.setupGlobalDragDrop({
    onMp3: (file) => {
      const objectUrl = URL.createObjectURL(file)
      const meta = smartCleaning.splitArtistAndTitle
        ? smartCleaning.splitArtistAndTitle(file.name)
        : { artist: 'Локальный файл', title: String(file.name || '').replace(/\.[a-z0-9]+$/i, '') }
      const localTrack = sanitizeTrack({
        title: meta.title,
        artist: meta.artist,
        url: objectUrl,
        source: 'local',
        id: `local:${file.name}:${file.size}:${file.lastModified}`,
        bg: 'linear-gradient(135deg,#7c3aed,#a855f7)',
      })
      playTrackObj(localTrack).catch((err) => showToast(`Файл не проигран: ${err?.message || err}`, true))
      showToast(`Локальный трек: ${meta.title}`)
    },
    onGif: (file) => {
      const reader = new FileReader()
      reader.onload = (e) => {
        saveVisual({ customBg: e.target?.result || null, bgType: 'custom' })
        setBgType('custom')
        showToast('GIF установлен как фон')
      }
      reader.readAsDataURL(file)
    },
    onInvalid: () => showToast('Поддерживаются только .mp3 и .gif', true),
  })
}

// в”Ђв”Ђв”Ђ INIT + HOTKEYS в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
window.addEventListener('DOMContentLoaded', () => {
  enableMojibakeAutoFix()
  startApp()
  applyUiTextOverrides()
  setupSidebarResize()
  setupCardTilt()
  syncHomeCloneUI()
  syncHomeWidgetUI()
  applyHomeSliderStyle()
  startHomeVisualizerLoop()
  alignHomeHeaderToPlay()
  window.addEventListener('resize', () => { alignHomeHeaderToPlay() })
  fixNodeTextMojibake(document.body)
  setTimeout(applyUiTextOverrides, 300)
  setTimeout(applyUiTextOverrides, 1200)
  refreshYtDlpStatus().catch(() => {})
  const createBtn = document.getElementById('btn-create-playlist')
  if (createBtn) createBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); createPlaylist() })
  const importBtn = document.getElementById('btn-import-playlist')
  if (importBtn) importBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); importPlaylistFromLink() })
  const importVkBtn = document.getElementById('btn-import-vk-to-flow')
  if (importVkBtn) importVkBtn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    importVkPlaylistToFlow()
  })
  const vkPlaylistInput = document.getElementById('vk-playlist-link-input')
  if (vkPlaylistInput) {
    vkPlaylistInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      importVkPlaylistToFlow()
    })
  }
  const inviteInput = document.getElementById('invite-input')
  if (inviteInput) {
    inviteInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        submitInviteJoin()
      }
    })
  }
  const playlistEditNameInput = document.getElementById('playlist-edit-name-input')
  const playlistEditDescInput = document.getElementById('playlist-edit-desc-input')
  const onPlaylistEditEnter = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submitPlaylistEditModal()
    }
  }
  if (playlistEditNameInput) playlistEditNameInput.addEventListener('keydown', onPlaylistEditEnter)
  if (playlistEditDescInput) playlistEditDescInput.addEventListener('keydown', onPlaylistEditEnter)
  const libraryActionInput = document.getElementById('library-action-input')
  if (libraryActionInput) {
    libraryActionInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        submitLibraryActionModal()
      }
    })
  }
  const roomSearchInput = document.getElementById('room-queue-search')
  if (roomSearchInput) {
    roomSearchInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      if (_roomSearchResults.length) addRoomSearchTrack(0)
    })
  }
  if (window.api?.appVersion) {
    window.api.appVersion().then((r) => {
      if (!r?.ok || !r?.version) return
      const logo = document.getElementById('titlebar-logo')
      if (logo) logo.textContent = `⬢ Flow v${r.version}`
      const welcomeSub = document.querySelector('#page-home .content-sub')
      if (welcomeSub) welcomeSub.textContent = `Выбери источник и начни слушать • билд ${r.version}`
      showToast(`Запущен билд v${r.version}`)
    }).catch(() => {})
  }

  if (window.api?.youtubeEngineStatus) {
    window.api.youtubeEngineStatus()
      .then((s) => {
        if (!s?.ytdlp) {
          showToast('YouTube engine: yt-dlp не найден. Поставь: winget install yt-dlp.yt-dlp', true)
          console.warn('YouTube engine status:', s)
        } else {
          console.log('YouTube engine ready:', s.ytdlpPath)
        }
      })
      .catch((e) => console.warn('youtubeEngineStatus failed:', e?.message || e))
  }
  syncIntegrationsUI()
  setupAppDragAndDrop()
  if (window.api?.onDiscordJoinSecret) {
    window.api.onDiscordJoinSecret((secret) => {
      const roomId = resolveInviteToRoomId(secret)
      if (!roomId || !_socialPeer) return
      joinRoomById(roomId)
      showToast(`Discord Join: подключение к ${roomId}`)
    })
  }

  audio.addEventListener('play', () => {
    if (_lyricsOpen) startLyricsSyncLoop()
  })
  audio.addEventListener('pause', () => {
    stopLyricsSyncLoop()
  })

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const modal = document.getElementById('invite-modal')
      if (modal && !modal.classList.contains('hidden')) {
        e.preventDefault()
        closeInviteModal()
        return
      }
      const editModal = document.getElementById('playlist-edit-modal')
      if (editModal && !editModal.classList.contains('hidden')) {
        e.preventDefault()
        closePlaylistEditModal()
        return
      }
      const libraryModal = document.getElementById('library-action-modal')
      if (libraryModal && !libraryModal.classList.contains('hidden')) {
        e.preventDefault()
        closeLibraryActionModal()
        return
      }
      const peerModal = document.getElementById('peer-profile-modal')
      if (peerModal && !peerModal.classList.contains('hidden')) {
        e.preventDefault()
        closePeerProfile()
        return
      }
    }
    const tag = document.activeElement?.tagName
    if (tag==='INPUT'||tag==='TEXTAREA') return

    if (e.code==='Space') { e.preventDefault(); togglePlay() }
    if (canControlQueue() && e.key==='ArrowRight' && audio.duration) audio.currentTime = Math.min(audio.currentTime+10, audio.duration)
    if (canControlQueue() && e.key==='ArrowLeft'  && audio.duration) audio.currentTime = Math.max(audio.currentTime-10, 0)

    // Источник фиксирован: Spotify -> YouTube
  })
})


