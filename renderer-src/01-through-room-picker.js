const { audioPlayer = {}, smartCleaning = {}, dragDrop = {}, peerSocial = {}, waveEngine: WE } = window.FlowModules || {}
const audio = (audioPlayer.createPlayerAudio || ((onErr) => {
  const el = new Audio()
  el.volume = 0.8
  el.onerror = () => {
    if (typeof window.__flowPlayerAudioError === 'function') {
      try {
        window.__flowPlayerAudioError(el)
        return
      } catch (e) {
        console.warn('__flowPlayerAudioError failed', e)
      }
    }
    onErr(el)
  }
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

;(function playbackPerfBackgroundHook() {
  try {
    /** Тяжёлый blur/фон в том же тике, что и старт декода, бьёт по UI; откладываем только на play. В старой репе этого хука не было — лишние updateBackground на pause/emptied убраны. */
    let deferBgScheduled = false
    const deferHeavyBackdrop = () => {
      if (deferBgScheduled) return
      deferBgScheduled = true
      const run = () => {
        deferBgScheduled = false
        try {
          updateBackground()
        } catch (_) {}
        try {
          const v = getVisual?.()
          if (v) applyVisualBackdropFilters(v.blur, v.bright)
        } catch (_) {}
      }
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(run))
      } else {
        setTimeout(run, 16)
      }
    }
    const syncPlayingClass = () => {
      document.body.classList.toggle('audio-playing', Boolean(audio && !audio.paused && !audio.ended))
      try {
        refreshNowPlayingTrackHighlight()
      } catch (_) {}
    }
    const onPlay = () => {
      syncPlayingClass()
      deferHeavyBackdrop()
    }
    audio.addEventListener('play', onPlay, { passive: true })
    audio.addEventListener('pause', syncPlayingClass, { passive: true })
    audio.addEventListener('ended', syncPlayingClass, { passive: true })
    audio.addEventListener('emptied', syncPlayingClass, { passive: true })
    syncPlayingClass()
  } catch (_) {}
})()

let currentTrack = null
let queue = []
let queueIndex = 0
let queueScope = 'generic' // generic | search | liked | playlist | myWave
let openPlaylistIndex = null
let searchDebounceTimer = null
let currentSource = 'hybrid'
let _playerModeActive = false
let _lastSearchMode = 'hybrid'
let _playRequestSeq = 0
const _ytPrewarmAt = new Map()
const _queuePrewarmAt = new Map()
let _queuePrewarmTimer = null
const _coverLoadState = new Map()

const defaultPlayback = { shuffle: false, repeat: 'off' } // repeat: off | all | one
let playbackMode = (() => {
  try { return Object.assign({}, defaultPlayback, JSON.parse(localStorage.getItem('flow_playback_mode') || '{}')) }
  catch { return { ...defaultPlayback } }
})()

function flowLucideSvg(name, extraClass = '') {
  const L = typeof FLOW_LUCIDE_INNER !== 'undefined' ? FLOW_LUCIDE_INNER : {}
  const paths = L[name] || ''
  const cls = ('ui-icon ' + String(extraClass || '').trim()).trim()
  if (!paths) return `<svg class="${cls}" viewBox="0 0 24 24"></svg>`
  if (name === 'play') return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" aria-hidden="true">${paths}</svg>`
  if (name === 'pause') return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" aria-hidden="true">${paths}</svg>`
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
}
const COVER_ICON = flowLucideSvg('music-2', 'lg')
let _audioCtx = null
let _eqFilters = null
let _analyser = null
let _freqData = null
let _customFontLoadedKey = ''
let _authMode = 'login'
let _profile = null
let _socialPeer = null
let _roomState = { roomId: null, host: false, hostPeerId: null }
let _lastRoomSyncAt = 0
let _currentTrackStartedAt = 0
let _flowSocialRoomUnsub = null
let _roomServerHeartbeatTimer = null
let _roomServerFullSyncTimer = null
let _profilesRealtimeUnsub = null
let _lastAppliedServerPlaybackTs = 0
/** Монотонный номер sync от хоста — гость отбрасывает только устаревшие пакеты, не «равные по ts» с pause. */
let _lastPlaybackSyncSeq = 0
let _hostPlaybackSyncSeq = 0
let _lastGuestP2pPlaybackAt = 0
let _lastRoomServerLoadAt = 0
let _friendPresence = new Map()
let _friendsPollTimer = null
let _friendsForceRefreshTimer = null
let _playlistDragIndex = -1
let _playlistEditContext = null
let _libraryActionMode = null
let _playlistPickerContext = null
let _playlistPickerSelection = new Set()
let _listenTickAt = 0
let _listenStatsPendingSec = 0
let _listenStatsLastFlushAt = 0
let _peerProfiles = new Map()
let _roomMembers = new Map()
let sharedQueue = []
let _roomSearchDebounceTimer = null
let _roomSearchResults = []
let _sharedQueueDragIndex = -1
let _lastHostOnlyToastAt = 0
let _lastUiSyncAt = 0
let _roomHeartbeatTimer = null
let _friendContext = null
let _pendingRoomInvite = null
let _myWaveRenderedTracks = []
let _myWaveBuilding = false
let _myWavePreloading = false
let _myWaveSeenKeys = new Set()
let _myWaveMode = (() => {
  try { return localStorage.getItem('flow_my_wave_mode') || 'default' } catch { return 'default' }
})()
let _profileEditDraft = null
let _roomContext = null
let _roomServerSaveTimer = null
let _lastServerStatusCheckAt = 0
const FRIEND_POLL_INTERVAL_MS = 2500
const FRIEND_FRESH_ONLINE_MS = 120000
const FRIEND_PROFILE_REFRESH_MS = 7000
const FRIEND_ONLINE_STALE_MS = 180000
const FLOW_SERVER_DEFAULT_URL = 'http://85.239.34.229:8787'
const FLOW_SOCIAL_DEFAULT_API_BASE = 'http://85.239.34.229/social'
const FLOW_SOCIAL_DEFAULT_API_SECRET = 'flowflow'
const FRIEND_NOTIFY_COOLDOWN_MS = 90 * 1000
/** Ленивый API «Моя волна» (реализация в src/modules/wave-engine.js). */
let _waveEngineApi = null
/** Яндекс «Моя волна» (rotor): queue в GET /tracks — id первого трека предыдущей выдачи. */
let _yandexWaveRotorQueueHint = ''
function waveEngine() {
  if (!_waveEngineApi && WE?.createWaveEngine) {
    _waveEngineApi = WE.createWaveEngine({
      getListenHistory,
      getLiked,
      getPlaylists,
      normalizePlaylist,
      sanitizeTrack,
      sanitizeTrackList,
      getSettings,
      searchHybridTracks,
      searchTracksDirect,
      getMyWaveSource,
      normalizeTrackSignature,
      getQueue: () => queue,
      getCurrentTrack: () => currentTrack,
      getYandexWaveQueueHint: () => _yandexWaveRotorQueueHint,
      setYandexWaveQueueHint: (id) => {
        _yandexWaveRotorQueueHint = String(id || '').trim()
      },
      fetchYandexRotorMyWave: async ({ mode, queueTrackId }) => {
        const tok = String(getSettings()?.yandexToken || '').trim()
        if (!tok || !window.api?.yandexMyWaveFetch) return null
        return window.api.yandexMyWaveFetch({
          token: tok,
          mode: String(mode || 'default'),
          queueTrackId: String(queueTrackId || '').trim(),
        })
      },
    })
  }
  return _waveEngineApi
}
function findMyWaveRecommendations(min, mode) {
  const api = waveEngine()
  return api ? api.findMyWaveRecommendations(min, mode) : Promise.resolve([])
}

function getMyWaveSeedTracks() {
  const api = waveEngine()
  return api ? api.getMyWaveSeedTracks() : []
}

function recordWaveEarlySkip(track) {
  waveEngine()?.recordWaveEarlySkip?.(track)
}

function recordWavePositiveListen(track) {
  waveEngine()?.recordWavePositiveListen?.(track)
}

const _friendProfileRefreshAt = new Map()
const _friendNotifyAt = new Map()

function getPeerProfileCache() {
  try { return JSON.parse(localStorage.getItem('flow_peer_public_profiles') || '{}') || {} } catch { return {} }
}

function savePeerProfileCache(map) {
  try { localStorage.setItem('flow_peer_public_profiles', JSON.stringify(map || {})) } catch {}
}

function mergeProfileData(base, incoming, peerId = '') {
  const prev = (base && typeof base === 'object') ? base : {}
  const next = (incoming && typeof incoming === 'object') ? incoming : {}
  const prevUsername = String(prev.username || '').trim().toLowerCase()
  const nextUsername = String(next.username || '').trim().toLowerCase()
  const sameUser = !nextUsername || !prevUsername || nextUsername === prevUsername
  const resolvedPeerId = String(peerId || next.peerId || prev.peerId || '').trim() || null
  const merged = Object.assign({}, prev, next)
  const hasOwn = Object.prototype.hasOwnProperty
  const hasAvatarPatch = hasOwn.call(next, 'avatarData')
  const hasBannerPatch = hasOwn.call(next, 'bannerData')
  merged.username = String(nextUsername || prevUsername || '').trim().toLowerCase()
  merged.peerId = resolvedPeerId
  // Respect explicit null/avatar removal from server instead of keeping stale cache.
  merged.avatarData = hasAvatarPatch
    ? (next.avatarData || null)
    : (sameUser ? (prev.avatarData || null) : null)
  merged.bannerData = hasBannerPatch
    ? (next.bannerData || null)
    : (sameUser ? (prev.bannerData || null) : null)
  merged.bio = typeof next.bio === 'string' ? next.bio : (prev.bio || '')
  merged.profileColor = typeof next.profileColor === 'string' ? next.profileColor : (prev.profileColor || '')
  if (Array.isArray(next.pinnedTracks)) merged.pinnedTracks = next.pinnedTracks
  else if (Array.isArray(prev.pinnedTracks)) merged.pinnedTracks = prev.pinnedTracks
  if (Array.isArray(next.pinnedPlaylists)) merged.pinnedPlaylists = next.pinnedPlaylists
  else if (Array.isArray(prev.pinnedPlaylists)) merged.pinnedPlaylists = prev.pinnedPlaylists
  const prevStats = prev.stats && typeof prev.stats === 'object' ? prev.stats : {}
  const nextStats = next.stats && typeof next.stats === 'object' ? next.stats : {}
  merged.stats = {
    totalTracks: Number.isFinite(Number(nextStats.totalTracks)) ? Number(nextStats.totalTracks) : Number(prevStats.totalTracks || 0),
    totalSeconds: Number.isFinite(Number(nextStats.totalSeconds)) ? Number(nextStats.totalSeconds) : Number(prevStats.totalSeconds || 0),
  }
  return merged
}

function withImageCacheBust(url) {
  const src = String(url || '').trim()
  if (!src || /^data:/i.test(src) || /^blob:/i.test(src)) return src
  const sep = src.includes('?') ? '&' : '?'
  return `${src}${sep}t=${Date.now()}`
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function cachePeerProfile(profile, peerId = '') {
  if (!profile || typeof profile !== 'object') return
  const username = String(profile.username || '').trim().toLowerCase()
  if (!username) return
  const cache = getPeerProfileCache()
  const prev = cache[username] || {}
  cache[username] = Object.assign(mergeProfileData(prev, Object.assign({}, profile, { username }), peerId), { updatedAt: Date.now() })
  savePeerProfileCache(cache)
}

function getCachedPeerProfile(username = '') {
  const safe = String(username || '').trim().toLowerCase()
  if (!safe) return null
  const cache = getPeerProfileCache()
  return cache[safe] || null
}

function getInviteMuteMap() {
  try { return JSON.parse(localStorage.getItem('flow_invite_mutes') || '{}') || {} } catch { return {} }
}

function saveInviteMuteMap(map) {
  try { localStorage.setItem('flow_invite_mutes', JSON.stringify(map || {})) } catch {}
}

function isInviteMutedFrom(username = '') {
  const safe = String(username || '').trim().toLowerCase()
  if (!safe) return false
  const map = getInviteMuteMap()
  const until = Number(map[safe] || 0)
  if (!until) return false
  if (Date.now() < until) return true
  delete map[safe]
  saveInviteMuteMap(map)
  return false
}

function muteInvitesFrom(username = '', ms = 15 * 60 * 1000) {
  const safe = String(username || '').trim().toLowerCase()
  if (!safe) return
  const map = getInviteMuteMap()
  map[safe] = Date.now() + Math.max(1000, Number(ms || 0))
  saveInviteMuteMap(map)
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
  syncSocialWidgetState()
  updateHostLockUi()
  renderRoomMembers()
  renderRoomNowPlaying()
  renderRoomQueue()
}

function syncSocialWidgetState() {
  const widget = document.getElementById('social-widget')
  if (!widget) return
  const active = Boolean(_roomState?.roomId)
  widget.classList.toggle('is-active', active)
  widget.classList.toggle('is-empty', !active)
  widget.setAttribute('aria-label', active ? 'Панель комнаты' : 'Создать комнату')
}

function handleSocialWidgetClick(event) {
  const target = event?.target
  if (target?.closest?.('button, input, .social-friend-card')) return
  if (_roomState?.roomId) return
  createRoom()
}

function handleSocialWidgetKeydown(event) {
  if (!event || (event.key !== 'Enter' && event.key !== ' ')) return
  event.preventDefault()
  handleSocialWidgetClick(event)
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

async function saveCustomMediaFile(file, purpose = 'media') {
  if (!file) return ''
  if (window.api?.saveCustomMedia && typeof file.arrayBuffer === 'function') {
    const bytes = await file.arrayBuffer()
    const saved = await window.api.saveCustomMedia({
      name: file.name || '',
      mime: file.type || '',
      purpose,
      bytes,
    })
    if (saved?.ok && saved.url) {
      try {
        bumpCustomizationGalleryRecent(String(saved.url))
      } catch (_) {}
      return String(saved.url)
    }
    throw new Error(saved?.error || 'media save failed')
  }
  const dataUrl = await readFileAsDataUrl(file)
  try {
    bumpCustomizationGalleryRecent(dataUrl)
  } catch (_) {}
  return dataUrl
}

function prepareProfileImageData(file, dataUrl, kind = 'avatar') {
  return new Promise((resolve) => {
    const raw = String(dataUrl || '')
    if (!raw) return resolve('')
    const isGif = /image\/gif/i.test(file?.type || raw.slice(0, 40))
    const maxBytes = kind === 'banner' ? 1200 * 1024 : 520 * 1024
    if (isGif || raw.length <= maxBytes * 1.35 || typeof Image === 'undefined') return resolve(raw)
    const img = new Image()
    img.onload = () => {
      try {
        const maxSide = kind === 'banner' ? 1200 : 420
        const ratio = Math.min(1, maxSide / Math.max(img.width || 1, img.height || 1))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round((img.width || 1) * ratio))
        canvas.height = Math.max(1, Math.round((img.height || 1) * ratio))
        canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/jpeg', kind === 'banner' ? 0.78 : 0.82))
      } catch {
        resolve(raw)
      }
    }
    img.onerror = () => resolve(raw)
    img.src = raw
  })
}

/** Сжатие data URL перед PUT (nginx / прокси часто режут тело ~1 МБ → 413). */
function shrinkProfileDataUrlForApi(dataUrl, kind = 'avatar') {
  return new Promise((resolve) => {
    const raw = String(dataUrl || '')
    if (!raw || typeof Image === 'undefined') return resolve(raw)
    if (raw.length < 65_000) return resolve(raw)
    const maxSide = kind === 'banner' ? 720 : 280
    const quality = kind === 'banner' ? 0.68 : 0.78
    const img = new Image()
    img.onload = () => {
      try {
        const ratio = Math.min(1, maxSide / Math.max(img.width || 1, img.height || 1))
        const w = Math.max(1, Math.round((img.width || 1) * ratio))
        const h = Math.max(1, Math.round((img.height || 1) * ratio))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        canvas.getContext('2d')?.drawImage(img, 0, 0, w, h)
        const out = canvas.toDataURL('image/jpeg', quality)
        resolve(out.length < raw.length ? out : raw)
      } catch {
        resolve(raw)
      }
    }
    img.onerror = () => resolve(raw)
    img.src = raw
  })
}

const ICONS = {
  play: flowLucideSvg('play', 'ctrl-play-icon'),
  pause: (() => {
    const L = typeof FLOW_LUCIDE_INNER !== 'undefined' ? FLOW_LUCIDE_INNER : {}
    const p = L.pause || ''
    return `<svg class="ui-icon ctrl-play-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`
  })(),
  plus: flowLucideSvg('plus'),
  close: flowLucideSvg('x'),
}
const HEART_OUTLINE = flowLucideSvg('heart', 'flow-ref-heart')
/** Полная заливка цветом «любимых», без обводки-«точки». */
const HEART_FILLED =
  '<svg class="ui-icon flow-ref-heart flow-ref-heart--filled" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<path fill="#f472b6" stroke="none" d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>' +
  '</svg>'
const PM_PLAY_INNER = (typeof FLOW_LUCIDE_INNER !== 'undefined' && FLOW_LUCIDE_INNER.play) ? FLOW_LUCIDE_INNER.play : '<path fill="currentColor" d="M9 8 L17 12 L9 16 Z"/>'
const PM_PAUSE_INNER =
  (typeof FLOW_LUCIDE_INNER !== 'undefined' && FLOW_LUCIDE_INNER.pause)
    ? FLOW_LUCIDE_INNER.pause
    : '<rect fill="currentColor" x="14" y="4" width="4" height="16" rx="1" stroke="none"/><rect fill="currentColor" x="6" y="4" width="4" height="16" rx="1" stroke="none"/>'
const ICON_SIMILAR = flowLucideSvg('audio-lines')

// в”Ђв”Ђв”Ђ VISUAL SETTINGS в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
const defaultVisual = {
  bgType: 'gradient',      // 'gradient' | 'cover' | 'custom'
  blur: 18, bright: 20, glass: 8, panelBlur: 24,
  accent: '#4b5563', accent2: '#9ca3af',
  orb1Color: '#4b5563',
  orb2Color: '#9ca3af',
  visualMode: 'minimal',   // 'minimal' | 'floated' | 'liquid'
  fontMode: 'default',
  customFontName: null,
  customFontData: null,
  customFontApplyTitle: false,
  uiScale: 100,
  customBg: null,
  homeSliderStyle: 'line',
  homeWidget: { enabled: true, mode: 'bars', image: null, intensity: 100, smoothing: 72 },
  effects: { orbs: false, glow: true, dyncolor: false, accentFromCover: false },
  navActiveHighlight: false,
  sidebarPosition: 'left',
  cardDensity: 'comfort',
  toastPosition: 'default',
  gifMode: { bg: true, track: true, playlist: true },
  lyrics: { scrollMode: 'smooth', align: 'left', size: 16, blur: 4 }
}

/** Нормализация сохранённого положения меню (устраняет «перепутанные» значения из импорта/старых ключей). */
function normalizeSidebarDockPosition(value) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
  const map = {
    l: 'left',
    r: 'right',
    t: 'top',
    b: 'bottom',
    tabs_top: 'top',
    tabs_bottom: 'bottom',
    tabs_right: 'right',
    tabs_left: 'left',
    start: 'left',
    end: 'right',
  }
  const step = map[raw] != null ? map[raw] : raw
  const allowed = new Set(['left', 'top', 'bottom', 'right'])
  return allowed.has(step) ? step : 'left'
}

const VS_GLASS_SLIDER_MAX = 40

/** Ползунок «прозрачность стекла»: 0 — минимум прозрачности (плотнее), дальше — прозрачнее. В `flow_visual.glass` хранится сила белой подложки (0 — почти невидима, 40 — плотнее). */
function glassTransparencyFromStored(glassStored) {
  const g = Number(glassStored)
  const gs = Number.isFinite(g) ? Math.max(0, Math.min(VS_GLASS_SLIDER_MAX, g)) : 8
  return VS_GLASS_SLIDER_MAX - gs
}

function glassStoredFromSliderTransparency(t) {
  const x = parseFloat(String(t))
  const tr = Number.isFinite(x) ? Math.max(0, Math.min(VS_GLASS_SLIDER_MAX, x)) : glassTransparencyFromStored(8)
  return VS_GLASS_SLIDER_MAX - tr
}

/** Кэш parse localStorage — getVisual() вызывается очень часто (в т.ч. каждый кадр домашнего визуализатора). */
let _flowVisualMemo = null

function getVisual() {
  try {
    let rawStr = localStorage.getItem('flow_visual') || '{}'
    if (_flowVisualMemo && _flowVisualMemo.s === rawStr) {
      return Object.assign({}, _flowVisualMemo.out)
    }
    let raw = {}
    try { raw = JSON.parse(rawStr) } catch (_) { raw = {} }
    if (raw.visualMode === 'premium') {
      raw.visualMode = 'floated'
      try {
        localStorage.setItem('flow_visual', JSON.stringify(raw))
      } catch (_) {}
      rawStr = localStorage.getItem('flow_visual') || '{}'
      try { raw = JSON.parse(rawStr) } catch (_) { raw = {} }
    }
    const out = Object.assign({}, defaultVisual, raw)
    out.sidebarPosition = normalizeSidebarDockPosition(out.sidebarPosition)
    _flowVisualMemo = { s: rawStr, out }
    return Object.assign({}, out)
  } catch {
    return { ...defaultVisual }
  }
}

function saveVisual(patch) {
  _flowVisualMemo = null
  const v = getVisual()
  const updated = Object.assign(v, patch)
  localStorage.setItem('flow_visual', JSON.stringify(updated))
  return updated
}

function getToastPosition(value = getVisual().toastPosition) {
  const allowed = new Set(['default', 'top-left', 'top-right', 'bottom-left', 'bottom-right'])
  return allowed.has(value) ? value : 'default'
}

function applyToastPosition(position = getVisual().toastPosition) {
  const safe = getToastPosition(position)
  document.body.setAttribute('data-toast-position', safe)
  document.querySelectorAll('[data-toast-position-option]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-toast-position-option') === safe)
  })
  document.querySelectorAll('[data-toast-pos]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-toast-pos') === safe)
  })
}

function setToastPosition(position) {
  const safe = getToastPosition(position)
  saveVisual({ toastPosition: safe })
  applyToastPosition(safe)
  showToast(safe === 'default' ? 'Уведомления: как сейчас' : 'Позиция уведомлений сохранена')
}

function toggleSettingsFold(id) {
  const section = document.querySelector(`[data-settings-fold="${id}"]`)
  if (!section) return
  const collapsed = !section.classList.contains('is-collapsed')
  section.classList.toggle('is-collapsed', collapsed)
  const btn = section.querySelector('.settings-fold-head')
  if (btn) btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
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

function normalizeVisualThemeMode(mode) {
  const m = String(mode || '')
  if (m === 'liquid' || m === 'yandex') return 'liquid'
  if (m === 'premium' || m === 'floated') return 'floated'
  return 'minimal'
}

/** Свободная геометрия блоков главной и конструктор — только в теме UI «Минимал» (floated). */
function isVisualFloatedLayout() {
  return normalizeVisualThemeMode(getVisual().visualMode) === 'floated'
}

function applyVisualMode(mode) {
  const safe = normalizeVisualThemeMode(mode)
  document.body.classList.remove('visual-minimal', 'visual-premium', 'visual-floated', 'visual-liquid', 'visual-yandex')
  if (safe === 'floated') {
    document.body.classList.add('visual-floated')
  } else if (safe === 'liquid') {
    document.body.classList.add('visual-liquid')
  } else {
    document.body.classList.add('visual-minimal')
  }
  syncNexoryDeskClass()
  const minimalBtn = document.getElementById('vm-minimal')
  const floatedBtn = document.getElementById('vm-floated')
  const liquidBtn = document.getElementById('vm-liquid')
  if (minimalBtn) minimalBtn.classList.toggle('active', safe === 'minimal')
  if (floatedBtn) floatedBtn.classList.toggle('active', safe === 'floated')
  if (liquidBtn) liquidBtn.classList.toggle('active', safe === 'liquid')
}

function syncHomeLayoutConstructorUi() {
  const wrap = document.getElementById('sidebar-layout-constructor')
  if (wrap) wrap.style.display = isVisualFloatedLayout() ? '' : 'none'
}

/** После смены темы UI: статичная главная в минимализме или восстановление макета в минимале. */
function syncDashboardLayoutToVisualMode() {
  syncHomeLayoutConstructorUi()
  if (!isVisualFloatedLayout()) {
    try {
      window.flowMainPaneResize?.clearDom?.()
    } catch (_) {}
    document.body.classList.remove('home-layout-edit', 'flow-edit-enabled')
    syncHomeLayoutEditButton()
    teardownHomeDashboardDrag(true)
    try {
      _teardownSidebarPanelDrag()
    } catch (_) {}
    applyStaticHomeDashboardOrder()
    applyHomeBlockGeometry(null)
    applyHomeEditorZoom(1)
    clearMainPaneShiftForClassicLayout()
    try {
      document.documentElement.style.removeProperty('--sidebar-panel-height')
    } catch (_) {}
    try {
      document.documentElement.style.removeProperty('--flow-floated-pane-drag-x')
      document.documentElement.style.removeProperty('--flow-floated-pane-drag-y')
    } catch (_) {}
    queueMicrotask(() => {
      try {
        resizeHomeVisualizerCanvas()
      } catch (_) {}
      try {
        alignHomeHeaderToPlay()
      } catch (_) {}
      scheduleMainShiftRemeasure()
    })
    return
  }
  syncHomeEditorZoomFromStorage()
  refreshHomeDashboardLayoutAfterContentChange()
}

/** Тихий сброс главной после «Минимализм» → «Минимал», без тоста (убирает «кашу» из старых координат). */
function quietResetHomeDashboardAfterMinimalismSwitch() {
  try {
    localStorage.removeItem(FLOW_HOME_BLOCK_GEOMETRY_LS)
    localStorage.removeItem(FLOW_HOME_BLOCK_ORDER_LS)
    localStorage.removeItem(FLOW_LAYOUT_COORDS_LS)
    localStorage.removeItem(FLOW_HOME_EDITOR_ZOOM_LS)
    localStorage.removeItem(FLOW_SIDEBAR_PANEL_H_LS)
  } catch (_) {}
  try {
    document.documentElement.style.removeProperty('--sidebar-panel-height')
  } catch (_) {}
  document.body.classList.remove('home-layout-edit', 'flow-edit-enabled')
  syncHomeLayoutEditButton()
  teardownHomeDashboardDrag(true)
  try {
    _teardownSidebarPanelDrag()
  } catch (_) {}
  applyHomeEditorZoom(1)
  clearMainPaneShiftForClassicLayout()
  const stack = document.getElementById('home-dashboard-stack')
  if (stack) {
    const map = {}
    stack.querySelectorAll(':scope > .home-dash-block[data-home-block]').forEach((el) => {
      map[el.dataset.homeBlock] = el
    })
    DEFAULT_HOME_BLOCK_ORDER.forEach((id) => {
      const el = map[id]
      if (el) stack.appendChild(el)
    })
  }
  applyHomeBlockGeometry(null)
  queueMicrotask(() => {
    try {
      syncFlowLayoutCoords()
    } catch (_) {}
    scheduleMainShiftRemeasure()
  })
}

function setVisualMode(mode) {
  const prev = normalizeVisualThemeMode(getVisual().visualMode)
  const safe = normalizeVisualThemeMode(mode)
  saveVisual({ visualMode: safe })
  applyVisualMode(safe)
  if (prev === 'minimal' && safe === 'floated') {
    quietResetHomeDashboardAfterMinimalismSwitch()
  }
  syncDashboardLayoutToVisualMode()
  queueMicrotask(() => {
    try {
      window.flowMainPaneResize?.refreshMode?.()
    } catch (_) {}
    try {
      window.flowFloatedMainPaneDrag?.refreshFrameShellGeometry?.()
    } catch (_) {}
    try {
      window.flowFloatedMainPaneDrag?.refreshFromStorage?.()
    } catch (_) {}
  })
  showToast(safe === 'liquid' ? 'Режим: Liquid Glass' : (safe === 'floated' ? 'Режим: минимал' : 'Режим: минимализм'))
}

async function toggleWindowMaximize() {
  try {
    if (!window.api?.maximizeToggle) return
    const r = await window.api.maximizeToggle()
    syncTitlebarMaximizeIcon(Boolean(r?.maximized))
  } catch (_) {}
}

function syncTitlebarMaximizeIcon(isMaximized) {
  const expand = document.getElementById('titlebar-ico-expand')
  const restore = document.getElementById('titlebar-ico-restore')
  const wrap = expand?.closest('button')
  if (expand) expand.style.display = isMaximized ? 'none' : 'block'
  if (restore) restore.style.display = isMaximized ? 'block' : 'none'
  if (wrap) {
    wrap.setAttribute('title', isMaximized ? 'Восстановить' : 'Развернуть')
    wrap.setAttribute('aria-label', isMaximized ? 'Восстановить окно' : 'Развернуть окно')
  }
}

function applyCardDensity(density = 'comfort') {
  const safe = density === 'compact' ? 'compact' : 'comfort'
  document.body.classList.toggle('density-compact', safe === 'compact')
  document.body.classList.toggle('density-comfort', safe !== 'compact')
  const comfortBtn = document.getElementById('density-comfort')
  const compactBtn = document.getElementById('density-compact')
  if (comfortBtn) comfortBtn.classList.toggle('active', safe !== 'compact')
  if (compactBtn) compactBtn.classList.toggle('active', safe === 'compact')
}

function setCardDensity(density) {
  const safe = density === 'compact' ? 'compact' : 'comfort'
  saveVisual({ cardDensity: safe })
  applyCardDensity(safe)
  showToast(safe === 'compact' ? 'Плотность: компактно' : 'Плотность: комфортно')
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

function refreshNowPlayingTrackHighlight() {
  const playing = Boolean(audio && !audio.paused && !audio.ended)
  document.querySelectorAll('.track-card.is-now-playing').forEach((el) => el.classList.remove('is-now-playing'))
  document.querySelectorAll('.playlist-track-row.is-now-playing').forEach((el) => el.classList.remove('is-now-playing'))
  if (!currentTrack) return

  const markCard = (card) => {
    if (!card) return
    card.classList.toggle('is-now-playing', playing)
    const row = card.closest('.playlist-track-row')
    if (row) row.classList.toggle('is-now-playing', playing)
  }

  const curKey = getTrackKey(currentTrack)
  document.querySelectorAll('.track-card[data-flow-track-key]').forEach((card) => {
    const key = String(card.getAttribute('data-flow-track-key') || '')
    if (!key || key !== curKey) return
    let t = null
    try {
      const enc = card.getAttribute('data-flow-track-json')
      if (enc) t = JSON.parse(decodeURIComponent(enc))
    } catch (_) {}
    if (t && !isSameTrackLoose(currentTrack, t)) return
    markCard(card)
  })
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

let _lazyCoverObserver = null
function observeLazyCoverBackground(el, coverUrl, fallbackBg = '', trackId = '') {
  if (!el) return
  const url = String(coverUrl || '').trim()
  if (!url) {
    applyCachedCoverBackground(el, '', fallbackBg, trackId)
    return
  }
  if (!('IntersectionObserver' in window)) {
    applyCachedCoverBackground(el, url, fallbackBg, trackId)
    return
  }
  if (!_lazyCoverObserver) {
    _lazyCoverObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return
        const target = entry.target
        _lazyCoverObserver?.unobserve(target)
        const lazyUrl = target.dataset.lazyCoverUrl || ''
        const lazyFallback = target.dataset.lazyCoverFallback || ''
        const lazyId = target.dataset.lazyCoverId || ''
        delete target.dataset.lazyCoverUrl
        delete target.dataset.lazyCoverFallback
        delete target.dataset.lazyCoverId
        applyCachedCoverBackground(target, lazyUrl, lazyFallback, lazyId)
      })
    }, { rootMargin: '260px 0px', threshold: 0.01 })
  }
  el.dataset.lazyCoverUrl = url
  el.dataset.lazyCoverFallback = fallbackBg || ''
  el.dataset.lazyCoverId = trackId || ''
  _lazyCoverObserver.observe(el)
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

/** То же число, что `--ui-scale` и слайдер «Масштаб UI»; на стеке конструктора задаёт `--home-construct-zoom` (без transform). */
function syncHomeConstructStackScalePct(pctRaw) {
  const pct = Number(pctRaw)
  const clamped = Number.isFinite(pct) ? Math.max(80, Math.min(130, pct)) : 100
  const z = clamped / 100
  document.getElementById('home-dashboard-stack')?.style.setProperty('--home-construct-zoom', String(z))
}

function pulseHomeVisualLayoutSync() {
  if (_activePageId !== 'home') return
  requestAnimationFrame(() => {
    try {
      resizeHomeVisualizerCanvas()
    } catch (_) {}
    try {
      alignHomeHeaderToPlay()
    } catch (_) {}
    scheduleMainShiftRemeasure()
  })
}

/** При воспроизведении сильнее уменьшаем blur фона — меньше нагрузка на GPU. */
function effectiveBackdropBlurPx(baseBlurPx) {
  const b = Number(baseBlurPx)
  if (!Number.isFinite(b) || b < 0) return 18
  try {
    if (audio && !audio.paused && !audio.ended) {
      const soft = Math.round(b * 0.38)
      return Math.max(8, Math.min(b, soft))
    }
  } catch (_) {}
  return b
}

function applyVisualBackdropFilters(blurPx, brightPercent) {
  const blur = Number(blurPx)
  const bright = Number(brightPercent)
  const eb = effectiveBackdropBlurPx(Number.isFinite(blur) ? blur : 18)
  const br = Number.isFinite(bright) ? bright : 55
  const bgBlur = document.getElementById('bg-cover-blur')
  if (bgBlur) bgBlur.style.filter = `blur(${eb}px) brightness(${br / 100})`
  const bgLayer = document.getElementById('bg-layer')
  if (bgLayer) bgLayer.style.filter = `blur(${eb}px) brightness(${br / 100})`
}

function applyVisualSettings() {
  const blur   = document.getElementById('vs-blur')?.value ?? 40
  const bright = document.getElementById('vs-bright')?.value ?? 50
  const glassEl = document.getElementById('vs-glass')
  const glass = glassEl
    ? glassStoredFromSliderTransparency(glassEl.value)
    : (getVisual().glass ?? 8)
  const pb     = document.getElementById('vs-panel-blur')?.value ?? 30
  const scaleLegacyEl = document.getElementById('vs-scale')
  const scaleWindowEl = document.getElementById('vs-scale-window')
  const scaleFullscreenEl = document.getElementById('vs-scale-fullscreen')
  const clampScale = (n, lo = 75, hi = 140) => {
    const x = Number(n)
    return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : 100
  }
  const v0 = getVisual()
  const activeScaleId = document.activeElement?.id || ''
  const legacyScale = clampScale(scaleLegacyEl?.value ?? v0.uiScale ?? 100, 75, 140)
  const windowScale = clampScale(scaleWindowEl?.value ?? legacyScale, 75, 130)
  const fullscreenScale = clampScale(scaleFullscreenEl?.value ?? legacyScale, 75, 140)
  let scale = windowScale
  if (activeScaleId === 'vs-scale-fullscreen') scale = fullscreenScale
  else if (activeScaleId === 'vs-scale-window') scale = windowScale
  else if (activeScaleId === 'vs-scale') scale = legacyScale
  else if (scaleWindowEl) scale = windowScale
  else if (scaleFullscreenEl) scale = fullscreenScale
  else scale = legacyScale

  // Keep all scale sliders in sync so blur/brightness changes never reset UI scale.
  if (scaleLegacyEl && Number(scaleLegacyEl.value) !== scale) scaleLegacyEl.value = String(scale)
  if (scaleWindowEl && Number(scaleWindowEl.value) !== scale) scaleWindowEl.value = String(Math.max(75, Math.min(130, scale)))
  if (scaleFullscreenEl && Number(scaleFullscreenEl.value) !== scale) scaleFullscreenEl.value = String(scale)

  document.getElementById('vs-blur-val').textContent   = blur + 'px'
  document.getElementById('vs-bright-val').textContent = bright + '%'
  const glassTr = glassTransparencyFromStored(glass)
  const glassTrLabel = Number.isInteger(glassTr) ? `${glassTr}%` : `${glassTr.toFixed(1)}%`
  if (document.getElementById('vs-glass-val')) document.getElementById('vs-glass-val').textContent = glassTrLabel
  document.getElementById('vs-panel-blur-val').textContent = pb + 'px'
  if (document.getElementById('vs-scale-val')) document.getElementById('vs-scale-val').textContent = scale + '%'
  if (document.getElementById('vs-scale-window-val')) document.getElementById('vs-scale-window-val').textContent = scale + '%'
  if (document.getElementById('vs-scale-fullscreen-val')) document.getElementById('vs-scale-fullscreen-val').textContent = scale + '%'

  const v = getVisual()
  saveVisual({ blur:+blur, bright:+bright, glass:+glass, panelBlur:+pb, uiScale:+scale })

  document.documentElement.style.setProperty('--glass-blur', pb + 'px')
  document.documentElement.style.setProperty('--glass-bg', `rgba(255,255,255,${glass/100})`)
  document.documentElement.style.setProperty('--ui-scale', String((+scale || 100) / 100))
  syncHomeConstructStackScalePct(+scale || 100)
  applyToastPosition(v.toastPosition || 'default')

  applyVisualBackdropFilters(+blur, +bright)
  applyHomeSliderStyle()
  refreshHomeDashboardLayoutAfterContentChange()
  pulseHomeVisualLayoutSync()
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
  try {
    if (document.body.classList.contains('flow-opt-game-sleep')) return
    if (shouldIsolateHostTrackVisualsFromRoomGuest()) return
  } catch (_) {}
  const v = getVisual()
  const coverBlur = document.getElementById('bg-cover-blur')
  const blur = v.blur, bright = v.bright
  const eb = effectiveBackdropBlurPx(blur)

  if (v.bgType === 'custom' && v.customBg) {
    const customBg = sanitizeMediaByGifMode(v.customBg, 'bg')
    coverBlur.style.backgroundImage = customBg ? `url(${customBg})` : ''
    coverBlur.style.opacity = customBg ? '1' : '0'
    coverBlur.style.filter = `blur(${eb}px) brightness(${bright/100})`
  } else if (v.bgType === 'cover' && currentTrack) {
    const coverUrl = sanitizeMediaByGifMode(getEffectiveCoverUrl(currentTrack), 'bg')
    if (!coverUrl) {
      coverBlur.style.opacity = '0'
      coverBlur.style.backgroundImage = ''
      return
    }
    coverBlur.style.backgroundImage = `url(${coverUrl})`
    coverBlur.style.opacity = '1'
    coverBlur.style.filter = `blur(${eb}px) brightness(${bright/100})`
  } else {
    coverBlur.style.opacity = '0'
    coverBlur.style.backgroundImage = ''
  }
}

async function loadCustomBg(input) {
  const file = input.files[0]
  if (!file) return
  try {
    const mediaUrl = await saveCustomMediaFile(file, 'background')
    saveVisual({ customBg: mediaUrl })
    refreshCustomBgPreview(file.name)
    updateBackground()
    showToast('Фон установлен')
  } catch (err) {
    showToast(`Не удалось сохранить фон: ${sanitizeDisplayText(err?.message || err)}`, true)
  } finally {
    input.value = ''
  }
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

function normalizeHomeSliderStyle(style) {
  const s = String(style || 'line').toLowerCase()
  if (s === 'wave' || s === 'ios') return s
  return 'line'
}

function setHomeSliderStyle(style) {
  const normalized = normalizeHomeSliderStyle(style)
  saveVisual({ homeSliderStyle: normalized })
  applyHomeSliderStyle()
}

let _homeWaveSliderResizeBound = false
const _homeWaveSliderBars = new Map()

function getHomeWaveSliderBars(key) {
  const k = String(key || 'default')
  if (_homeWaveSliderBars.has(k)) return _homeWaveSliderBars.get(k)
  const bars = 56
  const data = new Uint8Array(bars)
  for (let i = 0; i < bars; i++) {
    const t = i * 0.37 + k.length * 0.11
    data[i] = Math.floor(72 + Math.abs(Math.sin(t)) * 118 + Math.sin(t * 2.1) * 24)
  }
  _homeWaveSliderBars.set(k, data)
  return data
}

function drawHomeWaveSliderCanvas(canvas, progress, trackKey) {
  if (!canvas) return
  const host = canvas.parentElement
  const wCss = Math.max(120, Math.floor(host?.clientWidth || canvas.clientWidth || 320))
  const hCss = 26
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = Math.floor(wCss * dpr)
  const h = Math.floor(hCss * dpr)
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  let ctx = canvas._flowWave2d
  if (!ctx) {
    ctx = canvas.getContext('2d', { alpha: true })
    canvas._flowWave2d = ctx
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, wCss, hCss)
  const bars = getHomeWaveSliderBars(trackKey).length
  const data = getHomeWaveSliderBars(trackKey)
  const ratio = Math.max(0, Math.min(1, Number(progress) || 0))
  const pad = 2
  const bw = (wCss - pad * 2) / bars
  const barW = Math.max(2.5, bw - 1.4)
  for (let i = 0; i < bars; i++) {
    const norm = data[i] / 255
    const bh = 6 + norm * (hCss - 12)
    const x = pad + i * bw + (bw - barW) * 0.5
    const y = hCss - bh - 2
    const center = (i + 0.5) / bars
    const played = center <= ratio
    const alpha = played ? 0.94 : 0.34
    ctx.fillStyle = `rgba(255,255,255,${alpha})`
    ctx.fillRect(x, y, barW, bh)
  }
  const px = pad + ratio * (wCss - pad * 2)
  ctx.fillStyle = 'rgba(255,255,255,0.98)'
  ctx.fillRect(Math.round(px) - 1, 3, 2, hCss - 6)
}

function syncHomeWaveSliderCanvases(progress) {
  const style = normalizeHomeSliderStyle(getVisual().homeSliderStyle)
  const isWave = style === 'wave'
  const ratio = Math.max(0, Math.min(1, Number(progress) || 0))
  const trackKey = currentTrack ? `${currentTrack.source || ''}:${currentTrack.id || currentTrack.title || ''}` : 'idle'
  for (const [canvasId, inputId] of [
    ['home-clone-progress-wave', 'home-clone-progress'],
    ['pm-progress-wave', 'pm-progress'],
  ]) {
    const canvas = document.getElementById(canvasId)
    const input = document.getElementById(inputId)
    if (!canvas || !input) continue
    canvas.classList.toggle('hidden', !isWave)
    input.classList.toggle('home-slider-wave-active', isWave)
    if (!isWave) continue
    const p = Number.isFinite(progress) ? ratio : Number(input.value) || 0
    drawHomeWaveSliderCanvas(canvas, p, trackKey)
  }
}

function applyHomeSliderStyle() {
  const v = getVisual()
  const style = normalizeHomeSliderStyle(v.homeSliderStyle)
  for (const id of ['home-clone-progress', 'pm-progress']) {
    const el = document.getElementById(id)
    if (!el) continue
    el.dataset.sliderStyle = style
    el.classList.remove('home-slider-wave', 'home-slider-ios', 'home-slider-line', 'home-slider-wave-active')
    if (style === 'wave') el.classList.add('home-slider-wave')
    else if (style === 'ios') el.classList.add('home-slider-ios')
    else el.classList.add('home-slider-line')
    el.style.removeProperty('background')
  }
  const b1 = document.getElementById('slider-style-line')
  const b2 = document.getElementById('slider-style-wave')
  const b3 = document.getElementById('slider-style-ios')
  if (b1) b1.classList.toggle('active', style === 'line')
  if (b2) b2.classList.toggle('active', style === 'wave')
  if (b3) b3.classList.toggle('active', style === 'ios')
  const preview = document.getElementById('vs-slider-preview')
  if (preview) preview.dataset.sliderStyle = style
  document.body.classList.remove('flow-slider-style-line', 'flow-slider-style-wave', 'flow-slider-style-ios')
  document.body.classList.add('flow-slider-style-' + style)
  try { drawSliderPreviewFrame() } catch (_) {}
  try { startSliderPreviewLoop() } catch (_) {}
  try {
    if (typeof syncHomeClonePlaybackProgress === 'function') syncHomeClonePlaybackProgress()
    else syncHomeWaveSliderCanvases(0)
  } catch (_) {}
  if (!_homeWaveSliderResizeBound) {
    _homeWaveSliderResizeBound = true
    window.addEventListener('resize', () => {
      try {
        const prog = document.getElementById('home-clone-progress')
        syncHomeWaveSliderCanvases(prog ? Number(prog.value) : 0)
      } catch (_) {}
    })
  }
}

let _sliderPreviewRaf = 0
let _sliderPreviewPhase = 0

function drawSliderPreviewFrame() {
  const canvas = document.getElementById('vs-slider-preview-canvas')
  if (!canvas) return
  let ctx = canvas._flowPreview2d
  if (!ctx) {
    ctx = canvas.getContext('2d', { alpha: true })
    canvas._flowPreview2d = ctx
  }
  const w = canvas.width
  const h = canvas.height
  ctx.clearRect(0, 0, w, h)
  const style = normalizeHomeSliderStyle(getVisual().homeSliderStyle)
  const bars = 48
  const progress = 0.34 + Math.sin(_sliderPreviewPhase * 0.7) * 0.04
  const data = new Uint8Array(bars)
  for (let i = 0; i < bars; i++) {
    const t = _sliderPreviewPhase + i * 0.22
    data[i] = Math.floor(90 + Math.abs(Math.sin(t)) * 120 + Math.sin(t * 2.3) * 28)
  }
  if (style === 'wave') {
    const pad = 4
    const bw = (w - pad * 2) / bars
    const barW = Math.max(2.5, bw - 1.4)
    for (let i = 0; i < bars; i++) {
      const norm = data[i] / 255
      const bh = 6 + norm * (h - 12)
      const x = pad + i * bw + (bw - barW) * 0.5
      const y = h - bh - 2
      const played = (i + 0.5) / bars <= progress
      ctx.fillStyle = played ? 'rgba(255,255,255,0.94)' : 'rgba(255,255,255,0.34)'
      ctx.fillRect(x, y, barW, bh)
    }
    const px = pad + progress * (w - pad * 2)
    ctx.fillStyle = '#fff'
    ctx.fillRect(Math.round(px) - 1, 3, 2, h - 6)
  } else if (style === 'ios') {
    const trackY = h / 2
    ctx.fillStyle = 'rgba(255,255,255,0.22)'
    ctx.fillRect(4, trackY - 2, w - 8, 4)
    ctx.fillStyle = '#f2f2f2'
    ctx.fillRect(4, trackY - 2, (w - 8) * progress, 4)
    ctx.beginPath()
    ctx.arc(4 + (w - 8) * progress, trackY, 7, 0, Math.PI * 2)
    ctx.fill()
  } else {
    const trackY = h / 2
    ctx.strokeStyle = 'rgba(255,255,255,0.24)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(4, trackY)
    ctx.lineTo(w - 4, trackY)
    ctx.stroke()
    ctx.strokeStyle = '#fff'
    ctx.beginPath()
    ctx.moveTo(4, trackY)
    ctx.lineTo(4 + (w - 8) * progress, trackY)
    ctx.stroke()
    ctx.fillStyle = '#fff'
    ctx.fillRect(4 + (w - 8) * progress - 1, trackY - 7, 2, 14)
  }
  _sliderPreviewPhase += 0.06
}

function startSliderPreviewLoop() {
  if (_sliderPreviewRaf) cancelAnimationFrame(_sliderPreviewRaf)
  const tick = () => {
    const panel = document.getElementById('settings-panel-playback')
    const visible = panel && panel.classList.contains('active') && panel.offsetParent !== null
    if (visible && document.getElementById('vs-slider-preview-canvas')) drawSliderPreviewFrame()
    _sliderPreviewRaf = requestAnimationFrame(tick)
  }
  _sliderPreviewRaf = requestAnimationFrame(tick)
}
window.startSliderPreviewLoop = startSliderPreviewLoop

function toggleHomeWidgetEnabled() {
  const v = getVisual()
  const homeWidget = Object.assign({ enabled: true, mode: 'bars', image: null, intensity: 100, smoothing: 72 }, v.homeWidget || {})
  homeWidget.enabled = !homeWidget.enabled
  saveVisual({ homeWidget })
  syncHomeWidgetUI()
}

function normalizeHomeWidgetMode(mode) {
  const m = String(mode || 'bars').toLowerCase()
  if (m === 'wave' || m === 'dots' || m === 'web') return 'bars'
  if (m === 'liquid' || m === 'image' || m === 'bars') return m
  return 'bars'
}

function setHomeWidgetMode(mode) {
  const safe = normalizeHomeWidgetMode(mode)
  const v = getVisual()
  const homeWidget = Object.assign({ enabled: true, mode: 'bars', image: null, intensity: 100, smoothing: 72 }, v.homeWidget || {})
  homeWidget.mode = safe
  saveVisual({ homeWidget })
  syncHomeWidgetUI()
}

function setHomeWidgetIntensity(value) {
  const n = Math.max(60, Math.min(180, Number(value) || 100))
  const v = getVisual()
  const homeWidget = Object.assign({ enabled: true, mode: 'bars', image: null, intensity: 100, smoothing: 72 }, v.homeWidget || {})
  homeWidget.intensity = Math.round(n)
  saveVisual({ homeWidget })
  syncHomeWidgetUI()
}

function setHomeWidgetSmoothing(value) {
  const n = Math.max(20, Math.min(95, Number(value) || 72))
  const v = getVisual()
  const homeWidget = Object.assign({ enabled: true, mode: 'bars', image: null, intensity: 100, smoothing: 72 }, v.homeWidget || {})
  homeWidget.smoothing = Math.round(n)
  saveVisual({ homeWidget })
  syncHomeWidgetUI()
}

async function setHomeWidgetImage(input) {
  const file = input?.files?.[0]
  if (!file) return
  try {
    const mediaUrl = await saveCustomMediaFile(file, 'home-widget')
    const v = getVisual()
    const homeWidget = Object.assign({ enabled: true, mode: 'image', image: null, intensity: 100, smoothing: 72 }, v.homeWidget || {})
    homeWidget.image = mediaUrl
    homeWidget.mode = 'image'
    saveVisual({ homeWidget })
    syncHomeWidgetUI()
    showToast('Виджет сохранён')
  } catch (err) {
    showToast(`Не удалось сохранить виджет: ${sanitizeDisplayText(err?.message || err)}`, true)
  } finally {
    input.value = ''
  }
}

function clearHomeWidgetImage() {
  const v = getVisual()
  const homeWidget = Object.assign({ enabled: true, mode: 'bars', image: null, intensity: 100, smoothing: 72 }, v.homeWidget || {})
  homeWidget.image = null
  if (homeWidget.mode === 'image') homeWidget.mode = 'bars'
  saveVisual({ homeWidget })
  syncHomeWidgetUI()
}

function syncHomeWidgetUI() {
  const v = getVisual()
  const hw = Object.assign({ enabled: true, mode: 'bars', image: null, intensity: 100, smoothing: 72 }, v.homeWidget || {})
  const wrap = document.getElementById('home-visualizer-wrap')
  const img = document.getElementById('home-visualizer-image')
  const canvas = document.getElementById('home-visualizer-canvas')
  if (wrap) wrap.classList.toggle('hidden', !hw.enabled)
  if (img) {
    img.classList.toggle('hidden', hw.mode !== 'image' || !hw.image)
    img.style.backgroundImage = hw.image ? `url(${hw.image})` : ''
  }
  const mode = normalizeHomeWidgetMode(hw.mode)
  if (mode !== hw.mode) {
    hw.mode = mode
    saveVisual({ homeWidget: hw })
  }
  if (canvas) {
    canvas.style.display = mode === 'image' ? 'none' : 'block'
    canvas.classList.toggle('home-viz-liquid', mode === 'liquid')
  }
  const t = document.getElementById('toggle-home-widget')
  if (t) t.classList.toggle('active', hw.enabled)
  ;['bars', 'liquid', 'image'].forEach((m) => {
    const el = document.getElementById('hw-mode-' + m)
    if (el) el.classList.toggle('active', mode === m)
  })
  const imageRow = document.getElementById('home-widget-image-row')
  if (imageRow) imageRow.style.display = hw.mode === 'image' ? 'flex' : 'none'
  const intensityInput = document.getElementById('home-widget-intensity')
  const intensityVal = document.getElementById('home-widget-intensity-val')
  if (intensityInput) intensityInput.value = String(Math.max(60, Math.min(180, Number(hw.intensity) || 100)))
  if (intensityVal) intensityVal.textContent = `${Math.round(Math.max(60, Math.min(180, Number(hw.intensity) || 100)))}%`
  const smoothingInput = document.getElementById('home-widget-smoothing')
  const smoothingVal = document.getElementById('home-widget-smoothing-val')
  if (smoothingInput) smoothingInput.value = String(Math.max(20, Math.min(95, Number(hw.smoothing) || 72)))
  if (smoothingVal) smoothingVal.textContent = `${Math.round(Math.max(20, Math.min(95, Number(hw.smoothing) || 72)))}%`
}

function getSoundEnhancerProfile() {
  try {
    const raw = String(localStorage.getItem('flow_sound_profile') || 'clean').trim().toLowerCase()
    if (raw === 'balanced' || raw === 'bright') return raw
    return 'clean'
  } catch {
    return 'clean'
  }
}

function syncSoundEnhancerUI() {
  const cur = getSoundEnhancerProfile()
  ;['balanced', 'clean', 'bright'].forEach((id) => {
    const el = document.getElementById(`sound-profile-${id}`)
    if (el) el.classList.toggle('active', id === cur)
  })
}

function setSoundEnhancerProfile(profile) {
  const safe = profile === 'balanced' || profile === 'bright' ? profile : 'clean'
  try { localStorage.setItem('flow_sound_profile', safe) } catch {}
  syncSoundEnhancerUI()
  showToast(`Профиль звука: ${safe === 'balanced' ? 'Сбалансированный' : safe === 'bright' ? 'Яркий' : 'Чистый'}`)
  // Чтобы применить профиль сразу, переинициализируем граф WebAudio.
  try {
    if (audio && !audio.paused) {
      teardownAudioAnalyzer()
      ensureAudioAnalyzer()
    }
  } catch (_) {}
}

function normalizeAccentHex(c) {
  const s = String(c || '').trim().toLowerCase()
  if (!s.startsWith('#')) return s
  if (s.length === 4) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`
  return s
}

function syncAccentSwatchSelection(a1, a2) {
  const h1 = normalizeAccentHex(a1)
  const h2 = normalizeAccentHex(a2)
  document.querySelectorAll('.vscol').forEach((b) => {
    const d1 = normalizeAccentHex(b.getAttribute('data-a1') || '')
    const d2 = normalizeAccentHex(b.getAttribute('data-a2') || '')
    const match = Boolean(d1 && d2 && d1 === h1 && d2 === h2)
    b.classList.toggle('active', match)
  })
}

function setAccent(a1, a2) {
  saveVisual({ accent: a1, accent2: a2, orb1Color: a1, orb2Color: a2 })
  document.documentElement.style.setProperty('--accent', a1)
  document.documentElement.style.setProperty('--accent2', a2)
  syncAccentSwatchSelection(a1, a2)
  // update gorb colors (flat wash — без радиального градиента)
  document.getElementById('gorb1').style.background = `color-mix(in srgb, ${a1} 24%, transparent)`
  document.getElementById('gorb2').style.background = `color-mix(in srgb, ${a2} 24%, transparent)`
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
  if (g1) g1.style.background = `color-mix(in srgb, ${c1} 24%, transparent)`
  if (g2) g2.style.background = `color-mix(in srgb, ${c2} 24%, transparent)`
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

/** Гость в руме слушает трек хоста — не перекрашиваем весь UI (фон, орбы, акценты) из обложки трека. */
function shouldIsolateHostTrackVisualsFromRoomGuest() {
  try {
    return Boolean(
      typeof currentTrack !== 'undefined' &&
      currentTrack &&
      currentTrack._flowSkipGlobalThemeFromTrack &&
      _roomState?.roomId &&
      !_roomState?.host
    )
  } catch (_) {
    return false
  }
}

function updateOrbsFromCover(coverUrl) {
  if (shouldIsolateHostTrackVisualsFromRoomGuest()) return
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
        document.getElementById('gorb1').style.background = `color-mix(in srgb, ${c1} 24%, transparent)`
        document.getElementById('gorb2').style.background = `color-mix(in srgb, ${c2} 24%, transparent)`
      }
      if (effects.accentFromCover) {
        const relLum = (rr, gg, bb) => {
          const srgb = (x) => {
            const v = x / 255
            return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
          }
          const R = srgb(rr)
          const G = srgb(gg)
          const B = srgb(bb)
          return 0.2126 * R + 0.7152 * G + 0.0722 * B
        }
        const L = relLum(r, g, b)
        const nearWhite = L > 0.9 || (r > 236 && g > 236 && b > 236)
        const a1 = nearWhite ? (v.accent || defaultVisual.accent) : c1
        const a2 = nearWhite ? (v.accent2 || defaultVisual.accent2) : c2
        document.documentElement.style.setProperty('--accent', a1)
        document.documentElement.style.setProperty('--accent2', a2)
      }
      if (document.getElementById('pm-cover-glow')) {
        document.getElementById('pm-cover-glow').style.background = `color-mix(in srgb, ${c1} 28%, transparent)`
      }
      if (v.bgType === 'cover') updateBackground()
    } catch(e) {}
  }
  img.src = coverUrl
}

function setYandexPlayerThemeFromRgb(r, g, b) {
  const root = document.documentElement
  const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)))
  const base = `rgb(${clamp(r * 0.72)}, ${clamp(g * 0.66)}, ${clamp(b * 0.6)})`
  root.style.setProperty('--liquid-player-bg', base)
  root.style.setProperty('--liquid-player-card', `rgba(${clamp(r * 0.26)}, ${clamp(g * 0.24)}, ${clamp(b * 0.23)}, 0.58)`)
  root.style.setProperty('--liquid-player-glow', `rgba(${clamp(r)}, ${clamp(g)}, ${clamp(b)}, 0.26)`)
  // Legacy vars for backward compatibility with older style selectors.
  root.style.setProperty('--yandex-player-bg', base)
  root.style.setProperty('--yandex-player-card', `rgba(${clamp(r * 0.26)}, ${clamp(g * 0.24)}, ${clamp(b * 0.23)}, 0.58)`)
  root.style.setProperty('--yandex-player-glow', `rgba(${clamp(r)}, ${clamp(g)}, ${clamp(b)}, 0.26)`)
}

function updateYandexPlayerTheme(track = currentTrack) {
  if (shouldIsolateHostTrackVisualsFromRoomGuest()) return
  const fallback = String(track?.bg || '').trim()
  const coverUrl = getEffectiveCoverUrl(track)
  if (!coverUrl) {
    const solidFallback =
      fallback && !/^linear-gradient|^radial-gradient/i.test(String(fallback).trim())
        ? String(fallback).trim()
        : '#482618'
    document.documentElement.style.setProperty('--liquid-player-bg', solidFallback)
    document.documentElement.style.setProperty('--liquid-player-card', 'rgba(31, 18, 14, 0.5)')
    document.documentElement.style.setProperty('--liquid-player-glow', 'rgba(251, 255, 40, 0.12)')
    document.documentElement.style.setProperty('--yandex-player-bg', solidFallback)
    document.documentElement.style.setProperty('--yandex-player-card', 'rgba(31, 18, 14, 0.5)')
    document.documentElement.style.setProperty('--yandex-player-glow', 'rgba(251, 255, 40, 0.12)')
    return
  }
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.onload = () => {
    try {
      const c = document.createElement('canvas')
      c.width = 10
      c.height = 10
      const ctx = c.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(img, 0, 0, 10, 10)
      const d = ctx.getImageData(0, 0, 10, 10).data
      let r = 0, g = 0, b = 0, n = 0
      for (let i = 0; i < d.length; i += 4) {
        const max = Math.max(d[i], d[i + 1], d[i + 2])
        const min = Math.min(d[i], d[i + 1], d[i + 2])
        if (max < 18 || (max - min < 8 && max > 225)) continue
        r += d[i]; g += d[i + 1]; b += d[i + 2]; n++
      }
      if (n) setYandexPlayerThemeFromRgb(r / n, g / n, b / n)
    } catch {}
  }
  img.onerror = () => {}
  img.src = coverUrl
}

function initVisualSettings() {
  const v = getVisual()
  // Apply sliders
  const setSlider = (id, val) => {
    const el = document.getElementById(id)
    if (el) el.value = val == null ? '' : String(val)
  }
  setSlider('vs-blur', v.blur)
  setSlider('vs-bright', v.bright)
  setSlider('vs-glass', glassTransparencyFromStored(v.glass))
  setSlider('vs-panel-blur', v.panelBlur)
  setSlider('vs-scale', v.uiScale || 100)
  setSlider('vs-scale-window', v.uiScale || 100)
  setSlider('vs-scale-fullscreen', v.uiScale || 100)
  // Labels
  if (document.getElementById('vs-blur-val')) document.getElementById('vs-blur-val').textContent = v.blur + 'px'
  if (document.getElementById('vs-bright-val')) document.getElementById('vs-bright-val').textContent = v.bright + '%'
  const gTr = glassTransparencyFromStored(v.glass)
  if (document.getElementById('vs-glass-val')) {
    document.getElementById('vs-glass-val').textContent = Number.isInteger(gTr) ? `${gTr}%` : `${gTr.toFixed(1)}%`
  }
  if (document.getElementById('vs-panel-blur-val')) document.getElementById('vs-panel-blur-val').textContent = v.panelBlur + 'px'
  if (document.getElementById('vs-scale-val')) document.getElementById('vs-scale-val').textContent = (v.uiScale || 100) + '%'
  if (document.getElementById('vs-scale-window-val')) document.getElementById('vs-scale-window-val').textContent = (v.uiScale || 100) + '%'
  if (document.getElementById('vs-scale-fullscreen-val')) document.getElementById('vs-scale-fullscreen-val').textContent = (v.uiScale || 100) + '%'
  // CSS vars
  document.documentElement.style.setProperty('--accent', v.accent)
  document.documentElement.style.setProperty('--accent2', v.accent2)
  document.documentElement.style.setProperty('--glass-blur', v.panelBlur + 'px')
  document.documentElement.style.setProperty('--glass-bg', `rgba(255,255,255,${v.glass/100})`)
  document.documentElement.style.setProperty('--ui-scale', String((v.uiScale || 100) / 100))
  syncHomeConstructStackScalePct(v.uiScale || 100)
  applyVisualMode(v.visualMode || 'minimal')
  syncHomeLayoutConstructorUi()
  syncHomeEditorZoomFromStorage()
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
  if (g1) g1.style.background = `color-mix(in srgb, ${orb1} 24%, transparent)`
  if (g2) g2.style.background = `color-mix(in srgb, ${orb2} 24%, transparent)`
  const o1 = document.getElementById('orb1-color')
  const o2 = document.getElementById('orb2-color')
  if (o1) o1.value = orb1
  if (o2) o2.value = orb2
  applyFontSettings(true)
  applyHomeSliderStyle()
  syncHomeWidgetUI()
  syncSoundEnhancerUI()
  document.body.classList.toggle('nav-active-highlight', Boolean(v.navActiveHighlight))
  applyCardDensity(v.cardDensity || 'comfort')
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
  applyToastPosition(v.toastPosition || 'default')
  refreshCustomBgPreview()
  refreshTrackCoverPreview()
  applyLyricsVisualSettings()
  reorderVisualSettingsSections()
  try {
    normalizeSettingsSectionsPersistence()
    applySettingsSectionsState()
  } catch (_) {}
  applyCompactUi()
  // background filter
  const coverBlur = document.getElementById('bg-cover-blur')
  if (coverBlur) coverBlur.style.filter = `blur(${v.blur}px) brightness(${v.bright/100})`
  updateBackground()
  pulseHomeVisualLayoutSync()
  syncAccentSwatchSelection(v.accent, v.accent2)
  try {
    setupFlowOptimizationChannel()
  } catch (_) {}
  applyOptimizationSettings()
  installFlowLayoutPickerDelegatedClicks()
  try {
    refreshCustomizationPanel()
  } catch (_) {}
}

let _flowSidebarLayoutClickInstalled = false
function installFlowLayoutPickerDelegatedClicks() {
  if (_flowSidebarLayoutClickInstalled) return
  _flowSidebarLayoutClickInstalled = true
  document.addEventListener(
    'click',
    (e) => {
      const btn = e.target && e.target.closest && e.target.closest('[data-flow-sidebar-layout]')
      if (!btn) return
      e.preventDefault()
      const raw = btn.getAttribute('data-flow-sidebar-layout')
      const pos = normalizeSidebarDockPosition(raw)
      if (pos) setSidebarPosition(pos)
    },
    false,
  )
}

function reorderVisualSettingsSections() {
  /* Плеер вынесен в отдельную категорию настроек; порядок секций задаётся в HTML. */
}

function toggleNavActiveHighlight() {
  const v = getVisual()
  saveVisual({ navActiveHighlight: !Boolean(v.navActiveHighlight) })
  applyVisualSettings()
}

/** Вертикальная колонка меню слева (классический док). */
function isSidebarDockedLeft() {
  return (
    !document.body.classList.contains('layout-top-nav') &&
    !document.body.classList.contains('layout-bottom-nav') &&
    !document.body.classList.contains('layout-right-nav')
  )
}

/** Горизонтальная полоса меню сверху или снизу. */
function isSidebarHorizontalDock() {
  return (
    document.body.classList.contains('layout-top-nav') ||
    document.body.classList.contains('layout-bottom-nav')
  )
}

/** Nexory «рабочий стол»: заметнее и при меню справа. */
function syncNexoryDeskClass() {
  try {
    const v = getVisual()
    const floated = normalizeVisualThemeMode(v.visualMode) === 'floated'
    const pos = normalizeSidebarDockPosition(v.sidebarPosition)
    const horizontal = pos === 'top' || pos === 'bottom'
    const dockRight = pos === 'right'
    document.body.classList.toggle('nexory-desk', Boolean(floated || horizontal || dockRight))
  } catch (_) {}
}

/** Меню снизу: переключатель расположения — отдельной полосой над плеером (не внутри #player-bar). */
function syncLayoutDockMount() {
  try {
    const dock = document.getElementById('player-bar-layout-dock')
    const playerBar = document.getElementById('player-bar')
    const screenMain = document.getElementById('screen-main')
    if (!dock || !playerBar || !screenMain) return
    const safe = normalizeSidebarDockPosition(getVisual()?.sidebarPosition || 'left')
    if (safe === 'bottom') {
      if (dock.parentElement !== screenMain) screenMain.insertBefore(dock, playerBar)
      else if (dock.nextElementSibling !== playerBar) screenMain.insertBefore(dock, playerBar)
    } else if (dock.parentElement !== playerBar || playerBar.firstElementChild !== dock) {
      playerBar.insertBefore(dock, playerBar.firstChild)
    }
  } catch (_) {}
}

function applySidebarPosition(position) {
  const safe = normalizeSidebarDockPosition(position)
  document.body.classList.toggle('layout-top-nav', safe === 'top')
  document.body.classList.toggle('layout-bottom-nav', safe === 'bottom')
  document.body.classList.toggle('layout-right-nav', safe === 'right')
  const sidebar = document.getElementById('sidebar')
  if (sidebar && (safe === 'top' || safe === 'bottom')) sidebar.classList.remove('collapsed')
  if (safe === 'top' || safe === 'bottom') {
    document.documentElement.style.setProperty('--sidebar-shift', '0px')
  } else {
    try {
      const sv = parseInt(localStorage.getItem('flow_sidebar_shift') || '0', 10)
      const px = Number.isFinite(sv) ? Math.max(0, sv) : 0
      document.documentElement.style.setProperty('--sidebar-shift', px + 'px')
    } catch (_) {}
    queueMicrotask(() => {
      try { window.dispatchEvent(new Event('resize')) } catch (_) {}
    })
  }
  ;['left', 'top', 'bottom', 'right'].forEach((id) => {
    const el = document.getElementById(`layout-${id}`)
    if (el) el.classList.toggle('active', safe === id)
  })
  document.querySelectorAll('.pbl-dock-btn[data-flow-sidebar-layout]').forEach((el) => {
    const p = normalizeSidebarDockPosition(el.getAttribute('data-flow-sidebar-layout'))
    el.classList.toggle('active', p === safe)
  })
  syncLayoutDockMount()
  syncNexoryDeskClass()
}

function setSidebarPosition(position) {
  const safe = normalizeSidebarDockPosition(position)
  saveVisual({ sidebarPosition: safe })
  applySidebarPosition(safe)
  const msg =
    safe === 'top'
      ? 'Меню сверху'
      : safe === 'bottom'
        ? 'Меню снизу'
        : safe === 'right'
          ? 'Меню справа'
          : 'Меню слева'
  showToast(msg)
}

/** true = секция свёрнута (как в блоках аккаунтов). Всегда храним полный объект ключей. */
const SETTINGS_SECTION_COLLAPSED_DEFAULTS = {
  interface: true,
  background: true,
  cover: true,
  blur: true,
  accent: true,
  effects: true,
  scale: true,
  font: true,
  notifications: true,
  accountYoutube: true,
  accountSpotify: true,
  accountVk: true,
  accountYandex: true,
  accountSoundcloud: true,
}

function getSettingsSectionsState() {
  try {
    const raw = JSON.parse(localStorage.getItem('flow_settings_sections') || '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function saveSettingsSectionsState(state) {
  try { localStorage.setItem('flow_settings_sections', JSON.stringify(state || {})) } catch {}
}

function getMergedSettingsSectionsState() {
  const saved = getSettingsSectionsState()
  const out = {}
  for (const key of Object.keys(SETTINGS_SECTION_COLLAPSED_DEFAULTS)) {
    if (Object.prototype.hasOwnProperty.call(saved, key)) {
      out[key] = Boolean(saved[key])
    } else {
      out[key] = SETTINGS_SECTION_COLLAPSED_DEFAULTS[key]
    }
  }
  return out
}

/** Дописывает в localStorage все ключи (убирает баг «кликнул одну — остальные схлопнулись»). */
function normalizeSettingsSectionsPersistence() {
  saveSettingsSectionsState(getMergedSettingsSectionsState())
}

function applySettingsSectionsState() {
  const merged = getMergedSettingsSectionsState()
  document.querySelectorAll('.vs-collapsible[data-settings-section]').forEach((section) => {
    const key = section.getAttribute('data-settings-section')
    if (!key || !Object.prototype.hasOwnProperty.call(merged, key)) return
    const collapsed = Boolean(merged[key])
    section.classList.toggle('collapsed', collapsed)
    section.querySelector('.vs-section-head')?.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
  })
}

function toggleSettingsSection(key) {
  const sectionKey = String(key || '').trim()
  if (!sectionKey || !Object.prototype.hasOwnProperty.call(SETTINGS_SECTION_COLLAPSED_DEFAULTS, sectionKey)) return
  const merged = getMergedSettingsSectionsState()
  merged[sectionKey] = !Boolean(merged[sectionKey])
  saveSettingsSectionsState(merged)
  applySettingsSectionsState()
}
window.toggleSettingsSection = toggleSettingsSection

let _settingsCategory = 'appearance'

const SETTINGS_TAB_TO_CATEGORY = {
  visual: 'appearance',
  sources: 'accounts',
  integrations: 'services',
}

function switchSettingsCategory(cat) {
  const allowed = new Set(['appearance', 'customization', 'playback', 'optimization', 'accounts', 'services'])
  const c = allowed.has(cat) ? cat : 'appearance'
  _settingsCategory = c
  document.querySelectorAll('.settings-cat').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-settings-cat') === c)
  })
  document.querySelectorAll('.settings-category-panel').forEach((panel) => {
    const on = panel.id === `settings-panel-${c}`
    panel.classList.toggle('active', on)
  })
  applyUiTextOverrides()
  if (c === 'customization') {
    try {
      refreshCustomizationPanel()
    } catch (_) {}
  }
  if (c === 'playback') {
    try { drawSliderPreviewFrame() } catch (_) {}
    try { startSliderPreviewLoop() } catch (_) {}
  }
}

/** Совместимость со старыми вызовами switchSettingsTab('visual'|'sources'|'integrations'). */
function switchSettingsTab(tab) {
  const mapped = SETTINGS_TAB_TO_CATEGORY[tab] || tab
  switchSettingsCategory(mapped)
}
window.switchSettingsCategory = switchSettingsCategory

// ——— Settings: «Кастомизация» (галерея, недавние, пресеты вида) ———
const FLOW_CUSTOM_GALLERY_RECENT_V1 = 'flow_custom_gallery_recent_v1'
const FLOW_CUST_PRESETS_V1 = 'flow_cust_presets_v1'
const CUST_BG_COVER_SENT = '__cover__'
const CUST_BG_GRADIENT_SENT = '__gradient__'
const CUST_GALLERY_RECENT_CAP = 24
const CUST_PRESETS_CAP = 28

function bumpCustomizationGalleryRecent(url) {
  const u = String(url || '').trim()
  if (!u) return
  let list = []
  try {
    list = JSON.parse(localStorage.getItem(FLOW_CUSTOM_GALLERY_RECENT_V1) || '[]')
  } catch (_) {
    list = []
  }
  if (!Array.isArray(list)) list = []
  list = [u, ...list.filter((x) => x !== u)].slice(0, CUST_GALLERY_RECENT_CAP)
  try {
    localStorage.setItem(FLOW_CUSTOM_GALLERY_RECENT_V1, JSON.stringify(list))
  } catch (_) {}
  try {
    if (isCustomizationSettingsCategoryActive()) renderCustRecentStrip()
  } catch (_) {}
}

function getCustomizationGalleryRecentList() {
  try {
    const list = JSON.parse(localStorage.getItem(FLOW_CUSTOM_GALLERY_RECENT_V1) || '[]')
    return Array.isArray(list) ? list.filter(Boolean) : []
  } catch (_) {
    return []
  }
}

function clearCustomizationGalleryRecent() {
  try {
    localStorage.removeItem(FLOW_CUSTOM_GALLERY_RECENT_V1)
  } catch (_) {}
  try {
    if (isCustomizationSettingsCategoryActive()) renderCustRecentStrip()
  } catch (_) {}
  showToast('Недавние загрузки очищены')
}

/** Квадрат / широкий / высокий по размерам из main-процесса; иначе unknown. */
function classifyCustomMediaAspectKind(f) {
  const w = Number(f?.width)
  const h = Number(f?.height)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 2 || h < 2) return 'unknown'
  const r = w / h
  if (r >= 0.9 && r <= 1.11) return 'square'
  if (r > 1.11) return 'wide'
  return 'tall'
}

function bindHorizontalDragScroll(el, opts) {
  if (!el || el.dataset.hscrollBound === '1') return
  el.dataset.hscrollBound = '1'
  const faceTap = Boolean(opts && opts.faceTap)
  let session = null

  const endWindow = () => {
    if (!session) return
    window.removeEventListener('pointermove', onWinMove, true)
    window.removeEventListener('pointerup', onWinUp, true)
    window.removeEventListener('pointercancel', onWinUp, true)
    session.el.classList.remove('cust-hscroll--dragging')
    session = null
  }

  const onWinMove = (e) => {
    if (!session || e.pointerId !== session.pid) return
    const dx = e.clientX - session.sx
    const dy = e.clientY - session.sy
    if (!session.drag) {
      if (Math.hypot(dx, dy) < 6) return
      const canH = el.scrollWidth > el.clientWidth + 2
      if (canH && Math.abs(dx) >= Math.abs(dy)) {
        session.drag = true
        session.moved = true
        el.classList.add('cust-hscroll--dragging')
      } else {
        endWindow()
        return
      }
    }
    if (session && session.drag) {
      el.scrollLeft = session.sl - dx
      try {
        e.preventDefault()
      } catch (_) {}
    }
  }

  const onWinUp = (e) => {
    if (!session || (e.pointerId != null && e.pointerId !== session.pid)) return
    const s = session
    const { downTarget: dt, drag, moved } = s
    endWindow()
    if (drag) return
    if (faceTap && !moved && dt && dt.closest && dt.closest('.cust-gal-face')) {
      const tile = dt.closest('.cust-gal-tile')
      if (tile) {
        const willOpen = !tile.classList.contains('cust-gal-tile--actions-open')
        el.querySelectorAll('.cust-gal-tile--actions-open').forEach((t) => t.classList.remove('cust-gal-tile--actions-open'))
        if (willOpen) tile.classList.add('cust-gal-tile--actions-open')
      }
    }
  }

  el.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      if (e.target.closest && e.target.closest('button')) return
      if (session) endWindow()
      session = {
        el,
        sx: e.clientX,
        sy: e.clientY,
        sl: el.scrollLeft,
        pid: e.pointerId,
        moved: false,
        drag: false,
        downTarget: e.target,
      }
      window.addEventListener('pointermove', onWinMove, true)
      window.addEventListener('pointerup', onWinUp, true)
      window.addEventListener('pointercancel', onWinUp, true)
    },
    true,
  )

  el.addEventListener(
    'wheel',
    (e) => {
      if (el.scrollWidth <= el.clientWidth + 2) return
      const ax = Math.abs(e.deltaX)
      const ay = Math.abs(e.deltaY)
      if (ax > ay && ax > 0.5) {
        el.scrollLeft += e.deltaX
        e.preventDefault()
      } else if (e.shiftKey && ay > ax && ay > 0.5) {
        el.scrollLeft += e.deltaY
        e.preventDefault()
      }
    },
    { passive: false },
  )
}

function getCustomizationPresets() {
  try {
    const list = JSON.parse(localStorage.getItem(FLOW_CUST_PRESETS_V1) || '[]')
    return Array.isArray(list) ? list : []
  } catch (_) {
    return []
  }
}

function saveCustomizationPresetsList(arr) {
  const list = Array.isArray(arr) ? arr.slice(0, CUST_PRESETS_CAP) : []
  try {
    localStorage.setItem(FLOW_CUST_PRESETS_V1, JSON.stringify(list))
  } catch (_) {}
}

function newCustomizationPresetId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function custUrlCssBackground(u) {
  const s = String(u || '').trim()
  if (!s) return ''
  return `url(${JSON.stringify(s)})`
}

function normalizeMediaUrlKey(url) {
  try {
    const s = String(url || '').trim()
    if (!s) return ''
    const u = new URL(s)
    const path = String(u.pathname || '').replace(/\\/g, '/')
    return `${String(u.protocol || '').toLowerCase()}//${String(u.hostname || '').toLowerCase()}${path.toLowerCase()}`
  } catch (_) {
    return String(url || '').trim().toLowerCase()
  }
}

/** Имя вида `purpose-<ts>-<sha1-16>.ext` из save-custom-media — одинаковое содержимое → один тайл. */
function contentHashFromCustomMediaFilename(name) {
  const m = String(name || '').toLowerCase().match(/-([a-f0-9]{16})(\.[a-z0-9]+)$/)
  return m ? m[1] : ''
}

function dedupeCustomMediaFiles(files) {
  const sorted = [...(files || [])].sort((a, b) => (Number(b.mtime) || 0) - (Number(a.mtime) || 0))
  const seenUrl = new Set()
  const seenContent = new Set()
  const out = []
  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i]
    const urlKey = normalizeMediaUrlKey(f?.url)
    if (!urlKey || seenUrl.has(urlKey)) continue
    const ch = contentHashFromCustomMediaFilename(f?.name || '')
    if (ch) {
      if (seenContent.has(ch)) continue
      seenContent.add(ch)
    }
    seenUrl.add(urlKey)
    out.push(f)
  }
  return out
}

function custPreviewEffectiveCoverUrl() {
  if (!currentTrack) return ''
  const u = String(getEffectiveCoverUrl(currentTrack) || '').trim()
  let disp = sanitizeMediaByGifMode(u, 'track')
  if (disp) return disp
  const raw = String(currentTrack.cover || '').trim()
  return raw || ''
}

function customizationCoverMetaText() {
  if (!currentTrack) return 'Включи трек — здесь появится обложка из источника или своя.'
  const map = getCustomCoverMap()
  if (getGlobalCustomCover(map)) return 'Источник: своя картинка для плеера (глобально).'
  const keys = getTrackCoverKeys(currentTrack)
  const per = keys.map((k) => map[k]).find(Boolean)
  if (per) return 'Источник: своя обложка, привязанная к этому треку.'
  return 'Источник: обложка из сервиса / локального файла.'
}

function customizationBgMetaText() {
  const v = getVisual()
  if (v.bgType === 'custom' && v.customBg) return 'Источник: свой фон (файл из галереи или загрузки).'
  if (v.bgType === 'cover') return 'Источник: размытая обложка текущего трека.'
  return 'Источник: градиент и орбы (без своего файла).'
}

function customizationVizMetaText() {
  const hw = Object.assign({ enabled: true, mode: 'bars', image: null, intensity: 100, smoothing: 72 }, getVisual().homeWidget || {})
  const names = { bars: 'столбцы', wave: 'волна', dots: 'точки', image: 'своё фото', web: 'Web' }
  if (hw.mode === 'image' && hw.image) return 'Источник: своё изображение в виджете на главной.'
  return `Источник: анимация «${names[hw.mode] || hw.mode}».`
}

function galleryRoleMatchesUrl(role, fileUrl) {
  const key = normalizeMediaUrlKey(fileUrl)
  if (!key) return false
  if (role === 'cover') {
    const map = getCustomCoverMap()
    const g = getGlobalCustomCover(map)
    if (g && normalizeMediaUrlKey(g) === key) return true
    if (currentTrack) {
      const c = getTrackCoverKeys(currentTrack).map((k) => map[k]).find(Boolean)
      if (c && normalizeMediaUrlKey(String(c)) === key) return true
    }
    return false
  }
  if (role === 'bg') {
    const v = getVisual()
    return v.bgType === 'custom' && v.customBg && normalizeMediaUrlKey(String(v.customBg)) === key
  }
  if (role === 'viz') {
    const hw = Object.assign({ enabled: true, mode: 'bars', image: null, intensity: 100, smoothing: 72 }, getVisual().homeWidget || {})
    return hw.mode === 'image' && hw.image && normalizeMediaUrlKey(String(hw.image)) === key
  }
  return false
}

function collectCurrentCustomizationSnapshot() {
  const v = getVisual()
  const map = getCustomCoverMap()
  let cover = String(getGlobalCustomCover(map) || '').trim()
  if (!cover && currentTrack) {
    const ks = getTrackCoverKeys(currentTrack)
    cover = String(ks.map((k) => map[k]).find(Boolean) || '').trim()
  }
  let bg = CUST_BG_GRADIENT_SENT
  if (v.bgType === 'custom' && v.customBg) bg = String(v.customBg).trim()
  else if (v.bgType === 'cover') bg = CUST_BG_COVER_SENT
  const hw = Object.assign({ enabled: true, mode: 'bars', image: null, intensity: 100, smoothing: 72 }, v.homeWidget || {})
  const viz = hw.mode === 'image' && hw.image ? String(hw.image).trim() : ''
  return { cover, bg, viz }
}

function savedViewPresetMatchesCurrentScreen(p) {
  if (!p || typeof p !== 'object') return false
  const cur = collectCurrentCustomizationSnapshot()
  const sameStr = (a, b) => String(a ?? '') === String(b ?? '')
  const sameMedia = (a, b) => {
    if (sameStr(a, b)) return true
    const sa = String(a || '').trim()
    const sb = String(b || '').trim()
    if (!sa || !sb) return sa === sb
    if (/^(file:|https?:|data:)/i.test(sa) && /^(file:|https?:|data:)/i.test(sb))
      return normalizeMediaUrlKey(sa) === normalizeMediaUrlKey(sb)
    return false
  }
  return sameMedia(p.cover, cur.cover) && sameMedia(p.bg, cur.bg) && sameMedia(p.viz, cur.viz)
}

function applyCustomizationMediaFromGallery(url, role) {
  const u = String(url || '').trim()
  if (!u) return
  if (role === 'bg') {
    saveVisual({ bgType: 'custom', customBg: u })
    refreshCustomBgPreview()
    updateBackground()
    showToast('Фон обновлён')
  } else if (role === 'viz') {
    const v = getVisual()
    const homeWidget = Object.assign({ enabled: true, mode: 'bars', image: null, intensity: 100, smoothing: 72 }, v.homeWidget || {})
    homeWidget.image = u
    homeWidget.mode = 'image'
    saveVisual({ homeWidget })
    syncHomeWidgetUI()
    showToast('Визуализатор обновлён')
  } else {
    const map = getCustomCoverMap()
    map.__global__ = u
    if (currentTrack) getTrackCoverKeys(currentTrack).forEach((k) => { map[k] = u })
    saveCustomCoverMap(map)
    _coverLoadState.clear()
    syncPlayerUIFromTrack()
    try {
      renderQueue()
    } catch (_) {}
    try {
      renderPlaylists()
    } catch (_) {}
    try {
      renderLiked()
    } catch (_) {}
    try {
      renderRoomQueue()
    } catch (_) {}
    try {
      syncTrackCoverStatus()
    } catch (_) {}
    try {
      refreshTrackCoverPreview()
    } catch (_) {}
    showToast('Обложка обновлена')
  }
  try {
    refreshCustomizationPanel()
  } catch (_) {}
  try {
    const go = document.getElementById('cust-gallery-overlay')
    if (go && !go.classList.contains('hidden')) void renderCustGalleryContent()
  } catch (_) {}
}

function syncCustPreviewMedia(container, imageUrl, emptyBackgroundCss) {
  if (!container) return
  container.querySelectorAll(':scope > img.cust-prev-thumb').forEach((n) => n.remove())
  container.style.backgroundImage = ''
  container.style.backgroundSize = ''
  container.style.backgroundPosition = ''
  const u = String(imageUrl || '').trim()
  if (u) {
    container.style.background = '#13151d'
    const img = document.createElement('img')
    img.className = 'cust-prev-thumb'
    img.alt = ''
    img.decoding = 'async'
    img.loading = 'eager'
    img.draggable = false
    if (/^https?:\/\//i.test(u)) img.referrerPolicy = 'no-referrer'
    img.src = u
    img.onerror = () => {
      img.remove()
      try {
        container.style.backgroundImage = custUrlCssBackground(u)
        container.style.backgroundSize = 'cover'
        container.style.backgroundPosition = 'center'
        container.style.backgroundColor = '#13151d'
      } catch (_) {
        container.style.backgroundImage = ''
        container.style.background = emptyBackgroundCss
      }
    }
    container.appendChild(img)
  } else {
    container.style.background = emptyBackgroundCss
  }
}

function mountPresetStripThumb(el, url, fallbackCss) {
  if (!el) return
  el.textContent = ''
  el.style.backgroundImage = ''
  const u = String(url || '').trim()
  if (!u) {
    el.style.background = fallbackCss || 'rgba(12,14,20,.9)'
    return
  }
  el.style.background = '#12141c'
  const img = document.createElement('img')
  img.className = 'cust-preset-thumb-img'
  img.alt = ''
  img.decoding = 'async'
  img.loading = 'lazy'
  img.draggable = false
  if (/^https?:\/\//i.test(u)) img.referrerPolicy = 'no-referrer'
  img.src = u
  img.onerror = () => {
    img.remove()
    try {
      el.style.backgroundImage = custUrlCssBackground(u)
      el.style.backgroundSize = 'cover'
      el.style.backgroundPosition = 'center'
    } catch (_) {
      el.style.background = fallbackCss || 'rgba(12,14,20,.9)'
    }
  }
  el.appendChild(img)
}

function renderPresetCardBgLayer(bgEl, p) {
  if (!bgEl) return
  const v = getVisual()
  if (p.bg && p.bg !== CUST_BG_COVER_SENT && p.bg !== CUST_BG_GRADIENT_SENT) {
    mountPresetStripThumb(bgEl, p.bg, 'rgba(20,22,30,.95)')
    return
  }
  if (p.bg === CUST_BG_COVER_SENT) {
    const u = currentTrack ? sanitizeMediaByGifMode(custPreviewEffectiveCoverUrl(), 'bg') : ''
    mountPresetStripThumb(bgEl, u, 'rgba(20,22,30,.95)')
    return
  }
  const o1 = v.orb1Color || v.accent || '#7c3aed'
  const o2 = v.orb2Color || v.accent2 || '#3b82f6'
  bgEl.textContent = ''
  bgEl.style.background = `linear-gradient(125deg, ${o1}44, ${o2}55, #0c0e14)`
}

function isCustomizationSettingsCategoryActive() {
  return _settingsCategory === 'customization'
}

function refreshCustomizationPanel() {
  const elCover = document.getElementById('cust-prev-cover')
  const elBg = document.getElementById('cust-prev-bg')
  const elViz = document.getElementById('cust-prev-viz')
  const mCov = document.getElementById('cust-prev-cover-meta')
  const mBg = document.getElementById('cust-prev-bg-meta')
  const mViz = document.getElementById('cust-prev-viz-meta')
  const v = getVisual()

  const coverUrl = custPreviewEffectiveCoverUrl()
  syncCustPreviewMedia(elCover, coverUrl, 'linear-gradient(145deg,#2d2238,#151a24)')
  if (mCov) mCov.textContent = customizationCoverMetaText()

  if (elBg) {
    if (v.bgType === 'custom' && v.customBg) {
      const raw = String(v.customBg).trim()
      const u = sanitizeMediaByGifMode(raw, 'bg') || raw
      syncCustPreviewMedia(elBg, u, 'linear-gradient(125deg,#2a1f32,#12141c)')
    } else if (v.bgType === 'cover' && currentTrack) {
      const u0 = custPreviewEffectiveCoverUrl()
      const bgU = sanitizeMediaByGifMode(u0, 'bg') || u0
      syncCustPreviewMedia(elBg, bgU, 'linear-gradient(125deg,#2a1f32,#12141c)')
    } else {
      const o1 = v.orb1Color || v.accent || '#7c3aed'
      const o2 = v.orb2Color || v.accent2 || '#3b82f6'
      syncCustPreviewMedia(elBg, '', `linear-gradient(125deg, ${o1}38, ${o2}42, #0d1018)`)
    }
  }
  if (mBg) mBg.textContent = customizationBgMetaText()

  if (elViz) {
    const hw = Object.assign({ enabled: true, mode: 'bars', image: null, intensity: 100, smoothing: 72 }, v.homeWidget || {})
    if (hw.mode === 'image' && hw.image) {
      syncCustPreviewMedia(elViz, String(hw.image).trim(), 'linear-gradient(180deg,rgba(124,58,237,.35),rgba(59,130,246,.2)),repeating-linear-gradient(90deg,rgba(255,255,255,.08) 0 2px,transparent 2px 6px)')
    } else {
      syncCustPreviewMedia(elViz, '', 'linear-gradient(180deg,rgba(124,58,237,.35),rgba(59,130,246,.2)),repeating-linear-gradient(90deg,rgba(255,255,255,.08) 0 2px,transparent 2px 6px)')
    }
  }
  if (mViz) mViz.textContent = customizationVizMetaText()

  if (!isCustomizationSettingsCategoryActive()) return
  try {
    renderCustRecentStrip()
  } catch (_) {}
  try {
    renderCustPresetStrip()
  } catch (_) {}
}

function renderCustRecentStrip() {
  const wrap = document.getElementById('cust-recent-strip')
  if (!wrap) return
  const list = getCustomizationGalleryRecentList()
  wrap.textContent = ''
  if (!list.length) {
    wrap.innerHTML =
      '<span class="cust-hint" style="margin:0;padding:4px 0">Пока нет — загрузи баннер, обложку или картинку виджета в разделе «Оформление».</span>'
    return
  }
  list.forEach((u) => {
    const t = document.createElement('button')
    t.type = 'button'
    t.className = 'cust-recent-tile'
    t.title = 'Применить как фон'
    const url = String(u || '').trim()
    if (url) {
      const img = document.createElement('img')
      img.className = 'cust-recent-thumb'
      img.alt = ''
      img.decoding = 'async'
      img.loading = 'lazy'
      img.draggable = false
      img.src = url
      img.onerror = () => {
        img.remove()
        t.style.background = 'linear-gradient(145deg,#2a2230,#151a24)'
      }
      t.appendChild(img)
    } else {
      t.style.background = 'linear-gradient(145deg,#2a2230,#151a24)'
    }
    t.addEventListener('click', () => {
      applyCustomizationMediaFromGallery(u, 'bg')
    })
    wrap.appendChild(t)
  })
  bindHorizontalDragScroll(wrap)
}

function renderCustPresetStrip() {
  const wrap = document.getElementById('cust-preset-strip')
  if (!wrap) return
  const list = getCustomizationPresets()
  wrap.textContent = ''
  if (!list.length) {
    wrap.innerHTML = '<span class="cust-hint" style="margin:0;padding:4px 0">Нет сохранённых видов.</span>'
    return
  }
  list.forEach((p) => {
    if (!p || !p.id) return
    const card = document.createElement('div')
    card.className = 'cust-preset-card'
    if (savedViewPresetMatchesCurrentScreen(p)) card.classList.add('cust-preset-card--matches-current')
    card.dataset.presetId = p.id
    const bg = document.createElement('div')
    bg.className = 'cust-preset-bg'
    renderPresetCardBgLayer(bg, p)
    const cover = document.createElement('div')
    cover.className = 'cust-preset-cover'
    mountPresetStripThumb(cover, p.cover, 'rgba(12,14,20,.55)')
    const viz = document.createElement('div')
    viz.className = 'cust-preset-viz'
    if (p.viz) mountPresetStripThumb(viz, p.viz, 'rgba(0,0,0,.35)')
    else {
      viz.textContent = ''
      viz.style.background =
        'repeating-linear-gradient(90deg,rgba(255,255,255,.12) 0 2px,transparent 2px 5px)'
    }
    card.appendChild(bg)
    card.appendChild(cover)
    card.appendChild(viz)
    card.addEventListener('click', (e) => {
      if (e.button !== 0) return
      applyCustomizationPresetById(p.id)
    })
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      deleteCustomizationPresetById(p.id)
    })
    wrap.appendChild(card)
  })
  bindHorizontalDragScroll(wrap)
}

function applyCustomizationPresetById(id, opts) {
  const list = getCustomizationPresets()
  const p = list.find((x) => x && x.id === id)
  if (!p) return
  const skipToast = opts && opts.skipToast
  const map = getCustomCoverMap()
  if (p.cover) {
    map.__global__ = p.cover
    if (currentTrack) getTrackCoverKeys(currentTrack).forEach((k) => { map[k] = p.cover })
  } else {
    delete map.__global__
    if (currentTrack) getTrackCoverKeys(currentTrack).forEach((k) => { delete map[k] })
  }
  saveCustomCoverMap(map)
  _coverLoadState.clear()
  syncPlayerUIFromTrack()
  try {
    renderQueue()
  } catch (_) {}
  try {
    renderPlaylists()
  } catch (_) {}
  try {
    renderLiked()
  } catch (_) {}
  try {
    renderRoomQueue()
  } catch (_) {}
  try {
    syncTrackCoverStatus()
  } catch (_) {}
  try {
    refreshTrackCoverPreview()
  } catch (_) {}

  const v0 = getVisual()
  const hwBase = { enabled: true, mode: 'bars', image: null, intensity: 100, smoothing: 72 }
  const merged = Object.assign(hwBase, v0.homeWidget || {})
  if (p.viz) {
    merged.mode = 'image'
    merged.image = p.viz
  } else {
    merged.image = null
    if (merged.mode === 'image') merged.mode = 'bars'
  }
  if (p.bg === CUST_BG_COVER_SENT) saveVisual({ bgType: 'cover', customBg: null, homeWidget: merged })
  else if (p.bg === CUST_BG_GRADIENT_SENT) saveVisual({ bgType: 'gradient', customBg: null, homeWidget: merged })
  else if (p.bg) saveVisual({ bgType: 'custom', customBg: p.bg, homeWidget: merged })
  else saveVisual({ homeWidget: merged })

  try {
    initVisualSettings()
  } catch (_) {}
  try {
    updateBackground()
  } catch (_) {}
  try {
    refreshCustomizationPanel()
  } catch (_) {}
  if (!skipToast) showToast('Вид применён')
}

function deleteCustomizationPresetById(id) {
  const prev = getCustomizationPresets()
  const next = prev.filter((x) => x && x.id !== id)
  if (next.length === prev.length) return
  saveCustomizationPresetsList(next)
  try {
    if (isCustomizationSettingsCategoryActive()) renderCustPresetStrip()
  } catch (_) {}
  showToast('Пресет удалён')
}

function saveCustomizationPresetSnapshot() {
  const snap = collectCurrentCustomizationSnapshot()
  const next = [{ id: newCustomizationPresetId(), ts: Date.now(), ...snap }, ...getCustomizationPresets()].slice(0, CUST_PRESETS_CAP)
  saveCustomizationPresetsList(next)
  try {
    if (isCustomizationSettingsCategoryActive()) renderCustPresetStrip()
  } catch (_) {}
  showToast('Текущий вид сохранён')
}

let _custGalGridBound = false
let _custGalEscBound = false

function ensureCustGalleryGridDelegate() {
  if (_custGalGridBound) return
  const grid = document.getElementById('cust-gallery-grid')
  if (!grid) return
  _custGalGridBound = true
  grid.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('[data-cust-gal]')
    if (!btn) return
    e.preventDefault()
    const role = btn.getAttribute('data-cust-gal')
    const url = btn.getAttribute('data-url')
    if (!role || !url) return
    applyCustomizationMediaFromGallery(url, role)
  })
}

function ensureCustGalleryEscClose() {
  if (_custGalEscBound) return
  _custGalEscBound = true
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    const ov = document.getElementById('cust-gallery-overlay')
    if (!ov || ov.classList.contains('hidden')) return
    closeCustomizationGallery()
  })
}

let _custGalSheetClickBound = false
function ensureCustGallerySheetClickCollapse() {
  if (_custGalSheetClickBound) return
  _custGalSheetClickBound = true
  document.addEventListener(
    'click',
    (e) => {
      const sheet = document.querySelector('.cust-gallery-sheet')
      if (!sheet || !sheet.contains(e.target)) return
      if (e.target.closest && e.target.closest('.cust-gal-tile')) return
      document.querySelectorAll('.cust-gal-tile--actions-open').forEach((t) => t.classList.remove('cust-gal-tile--actions-open'))
    },
    true,
  )
}

async function renderCustGalleryContent() {
  const grid = document.getElementById('cust-gallery-grid')
  if (!grid) return
  grid.innerHTML = '<span class="cust-hint">Загрузка…</span>'
  try {
    if (!window.api?.listCustomMedia) {
      grid.innerHTML = '<span class="cust-hint">Галерея недоступна в этом режиме.</span>'
      return
    }
    const res = await window.api.listCustomMedia()
    const raw = res && res.ok && Array.isArray(res.files) ? res.files : []
    const files = dedupeCustomMediaFiles(raw)
    if (!files.length) {
      grid.innerHTML = '<span class="cust-hint">В папке пока нет файлов.</span>'
      return
    }
    const byKind = { square: [], wide: [], tall: [], unknown: [] }
    files.forEach((f) => {
      const u = String(f.url || '').trim()
      if (!u) return
      const k = classifyCustomMediaAspectKind(f)
      byKind[k].push(f)
    })
    const sections = [
      ['square', 'Квадратные (≈ 1∶1)'],
      ['wide', 'Широкие'],
      ['tall', 'Высокие'],
      ['unknown', 'Размер неизвестен'],
    ]
    grid.textContent = ''
    let any = false
    for (let si = 0; si < sections.length; si++) {
      const key = sections[si][0]
      const title = sections[si][1]
      const list = byKind[key]
      if (!list.length) continue
      any = true
      const sec = document.createElement('div')
      sec.className = 'cust-gal-section'
      const h = document.createElement('div')
      h.className = 'cust-gal-section-title'
      h.textContent = title
      sec.appendChild(h)
      const row = document.createElement('div')
      row.className = 'cust-gal-scroll-row'
      list.forEach((f) => {
        const u = String(f.url || '').trim()
        if (!u) return
        const tile = document.createElement('div')
        tile.className = 'cust-gal-tile'
        tile.classList.add(`cust-gal-tile--shape-${key}`)
        if (['cover', 'bg', 'viz'].some((r) => galleryRoleMatchesUrl(r, u))) tile.classList.add('cust-gal-tile--on')
        const w = Number(f.width)
        const h0 = Number(f.height)
        if (Number.isFinite(w) && Number.isFinite(h0) && w > 0 && h0 > 0) {
          tile.style.setProperty('--cust-ar', String(w / h0))
        } else {
          tile.style.setProperty('--cust-ar', '1')
        }

        const face = document.createElement('div')
        face.className = 'cust-gal-face'
        const img = document.createElement('img')
        img.className = 'cust-gal-thumb'
        img.alt = ''
        img.loading = 'lazy'
        img.decoding = 'async'
        img.draggable = false
        if (/^https?:\/\//i.test(u)) img.referrerPolicy = 'no-referrer'
        img.src = u
        img.onerror = () => {
          img.remove()
          try {
            face.style.backgroundImage = custUrlCssBackground(u)
            face.style.backgroundSize = 'contain'
            face.style.backgroundPosition = 'center'
            face.style.backgroundRepeat = 'no-repeat'
          } catch (_) {
            face.classList.add('cust-gal-face--broken')
          }
        }
        img.addEventListener('load', () => {
          try {
            const nw = img.naturalWidth
            const nh = img.naturalHeight
            if (nw > 1 && nh > 1) tile.style.setProperty('--cust-ar', String(nw / nh))
          } catch (_) {}
        })
        face.appendChild(img)
        tile.appendChild(face)

        const actions = document.createElement('div')
        actions.className = 'cust-gal-actions'
        ;[
          ['cover', 'Обложка'],
          ['bg', 'Фон'],
          ['viz', 'Виджет'],
        ].forEach(([role, label]) => {
          const b = document.createElement('button')
          b.type = 'button'
          b.className = 'vsb cust-gal-btn'
          if (galleryRoleMatchesUrl(role, u)) b.classList.add('active')
          b.dataset.custGal = role
          b.dataset.url = u
          b.textContent = label
          actions.appendChild(b)
        })
        tile.appendChild(actions)
        row.appendChild(tile)
      })
      sec.appendChild(row)
      grid.appendChild(sec)
      bindHorizontalDragScroll(row, { faceTap: true })
    }
    if (!any) {
      grid.innerHTML = '<span class="cust-hint">В папке пока нет файлов.</span>'
    }
  } catch (err) {
    grid.innerHTML = `<span class="cust-hint">Ошибка: ${escapeHtml(String(err?.message || err))}</span>`
  }
}

function exportSavedViewPresetsJson() {
  try {
    const presets = getCustomizationPresets()
    const payload = {
      format: 'nexory-saved-views-v1',
      app: 'Nexory',
      exportedAt: new Date().toISOString(),
      presets,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const stamp = new Date().toISOString().slice(0, 10)
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `nexory-saved-views-${stamp}.json`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(link.href)
    showToast('Список сохранённых видов экспортирован')
  } catch (err) {
    showToast(`Экспорт не удался: ${sanitizeDisplayText(err?.message || err)}`, true)
  }
}

function pickSavedViewPresetsFile() {
  document.getElementById('cust-views-import-input')?.click()
}

function importSavedViewPresetsFromFile(input) {
  const file = input?.files?.[0]
  const reset = () => {
    try {
      input.value = ''
    } catch (_) {}
  }
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result || '{}'))
      let incoming = []
      if (Array.isArray(parsed)) incoming = parsed
      else if (parsed && Array.isArray(parsed.presets)) incoming = parsed.presets
      if (!incoming.length) throw new Error('В файле нет пресетов')
      const cleaned = []
      for (let i = 0; i < incoming.length; i++) {
        const p = incoming[i]
        if (!p || typeof p !== 'object') continue
        const id = typeof p.id === 'string' && p.id ? p.id : newCustomizationPresetId()
        const bgRaw = p.bg != null ? String(p.bg).trim() : ''
        let bg = CUST_BG_GRADIENT_SENT
        if (bgRaw === CUST_BG_COVER_SENT || bgRaw === CUST_BG_GRADIENT_SENT) bg = bgRaw
        else if (bgRaw) bg = bgRaw
        cleaned.push({
          id,
          ts: Number.isFinite(Number(p.ts)) ? Number(p.ts) : Date.now(),
          cover: p.cover != null ? String(p.cover) : '',
          bg,
          viz: p.viz != null ? String(p.viz) : '',
        })
      }
      if (!cleaned.length) throw new Error('Не удалось разобрать пресеты')
      const impIds = new Set(cleaned.map((p) => p.id))
      const rest = getCustomizationPresets().filter((p) => p && !impIds.has(p.id))
      saveCustomizationPresetsList([...cleaned, ...rest].slice(0, CUST_PRESETS_CAP))
      if (cleaned[0]?.id) {
        try {
          applyCustomizationPresetById(cleaned[0].id, { skipToast: true })
        } catch (_) {}
      } else {
        try {
          refreshCustomizationPanel()
        } catch (_) {}
      }
      showToast(`Импортировано видов: ${cleaned.length}. Первый из списка применён к экрану.`)
    } catch (err) {
      showToast(`Импорт: ${sanitizeDisplayText(err?.message || err)}`, true)
    } finally {
      reset()
    }
  }
  reader.onerror = () => {
    showToast('Не удалось прочитать файл', true)
    reset()
  }
  reader.readAsText(file)
}

function openCustomizationGallery() {
  ensureCustGalleryGridDelegate()
  ensureCustGalleryEscClose()
  ensureCustGallerySheetClickCollapse()
  const ov = document.getElementById('cust-gallery-overlay')
  if (ov) {
    ov.classList.remove('hidden')
    ov.setAttribute('aria-hidden', 'false')
  }
  void renderCustGalleryContent()
}

function closeCustomizationGallery() {
  const ov = document.getElementById('cust-gallery-overlay')
  if (ov) {
    ov.classList.add('hidden')
    ov.setAttribute('aria-hidden', 'true')
  }
}

window.openCustomizationGallery = openCustomizationGallery
window.closeCustomizationGallery = closeCustomizationGallery
window.saveCustomizationPresetSnapshot = saveCustomizationPresetSnapshot
window.clearCustomizationGalleryRecent = clearCustomizationGalleryRecent

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
    try {
      if (pmRoot && _lyricsOpen) {
        pmRoot.classList.remove('pm-lyrics-opening')
        void pmRoot.offsetWidth
        pmRoot.classList.add('pm-lyrics-opening')
        window.setTimeout(() => pmRoot.classList.remove('pm-lyrics-opening'), 640)
      }
    } catch (_) {}
  } else {
    if (pmPanel) pmPanel.classList.add('hidden')
    if (sidePanel) sidePanel.classList.toggle('hidden', !_lyricsOpen)
    pmRoot?.classList.remove('lyrics-mode')
  }
  // После смены видимой панели подтянуть состояние строк в новом дереве (раньше обновлялось только скрытое).
  try {
    if (_lyricsOpen && _lyricsData?.length && typeof syncLyrics === 'function' && typeof getLyricsSmoothedTime === 'function') {
      queueMicrotask(() => syncLyrics(getLyricsSmoothedTime()))
    }
  } catch (_) {}
}

function cssQuoteForUrl(value) {
  if (value == null || typeof value !== 'string') return ''
  return String(value).trim().replace(/\\/g, '/').replace(/'/g, '%27')
}

function syncPmQueuePreviews() {
  const strip = document.getElementById('pm-queue-strip')
  const countEl = document.getElementById('pm-queue-count')
  if (!strip || !_playerModeActive) return
  strip.innerHTML = ''
  const qlen = Array.isArray(queue) ? queue.length : 0
  const qIdx = Number(queueIndex) || 0
  const upcoming = Math.max(0, qlen - qIdx - 1)
  if (countEl) countEl.textContent = upcoming > 0 ? String(upcoming) : ''
  if (!qlen || upcoming <= 0) {
    const empty = document.createElement('span')
    empty.className = 'pm-queue-empty'
    empty.textContent = qlen && qIdx >= qlen - 1 ? 'Конец очереди' : 'Нет треков впереди'
    strip.appendChild(empty)
    return
  }
  const start = qIdx + 1
  const slice = queue.slice(start, start + 10)
  slice.forEach((tr, i) => {
    const targetIdx = start + i
    const url = getEffectiveCoverUrl(tr)
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'pm-queue-thumb'
    btn.setAttribute('role', 'listitem')
    btn.title = `${tr.title || 'Трек'}${tr.artist ? ' — ' + tr.artist : ''}`
    const safe = cssQuoteForUrl(url)
    if (safe) btn.style.backgroundImage = `url('${safe}')`
    else btn.classList.add('pm-queue-thumb--empty')
    btn.addEventListener('click', () => {
      if (typeof playTrackObj !== 'function') return
      if (targetIdx < 0 || targetIdx >= queue.length) return
      queueIndex = targetIdx
      playTrackObj(queue[queueIndex]).catch(() => {})
    })
    strip.appendChild(btn)
  })
}

function syncPlayerModeUI() {
  if (!_playerModeActive) return
  const t = currentTrack
  const pmCover  = document.getElementById('pm-cover')
  const pmGlow   = document.getElementById('pm-cover-glow')
  const pmBg     = document.getElementById('pm-bg')
  const pmTitle  = document.getElementById('pm-title')
  const pmArtist = document.getElementById('pm-artist')
  const pmCoverLike = document.getElementById('pm-cover-like-btn')
  const pmCoverLyrics = document.getElementById('pm-cover-lyrics-btn')
  const v = getVisual()
  const orb1 = v.orb1Color || v.accent || '#4b5563'
  const orb2 = v.orb2Color || v.accent2 || '#9ca3af'

  if (t) {
    pmTitle.textContent  = t.title || 'РќРµРёР·РІРµСЃС‚РЅРѕ'
    pmArtist.textContent = t.artist || 'вЂ”'
    const pmSrc = document.getElementById('pm-source-badge')
    if (pmSrc && typeof window.flowTrackSourceBadgeHtml === 'function') {
      const html = window.flowTrackSourceBadgeHtml(t)
      if (html) {
        pmSrc.innerHTML = html
        pmSrc.classList.remove('hidden')
      } else {
        pmSrc.innerHTML = ''
        pmSrc.classList.add('hidden')
      }
    }
    const effectiveCover = getEffectiveCoverUrl(t)
    if (effectiveCover) {
      applyCoverArt(pmCover, effectiveCover, t.bg || 'linear-gradient(135deg,#7c3aed,#a855f7)')
      if (pmGlow) pmGlow.style.background = `color-mix(in srgb, ${orb1} 28%, transparent)`
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
      if (pmGlow) pmGlow.style.background = `color-mix(in srgb, ${orb2} 28%, transparent)`
      if (pmBg) {
        pmBg.style.backgroundImage = 'none'
        pmBg.style.background = '#07090f'
      }
    }
    const liked = isLiked(t)
    if (pmCoverLike) { pmCoverLike.innerHTML = liked ? HEART_FILLED : HEART_OUTLINE; pmCoverLike.classList.toggle('liked', liked) }
  }
  // play/pause icon sync
  const icon = document.getElementById('pm-play-icon')
  if (icon) icon.innerHTML = audio.paused ? PM_PLAY_INNER : PM_PAUSE_INNER
  // volume sync
  const pmVol = document.getElementById('pm-volume')
  if (pmVol) pmVol.value = audio.volume
  const pmVolVal = document.getElementById('pm-vol-val')
  if (pmVolVal) pmVolVal.textContent = String(Math.max(0, Math.min(10, Math.round(audio.volume * 10))))
  const pmCoverVol = document.getElementById('pm-cover-volume')
  if (pmCoverVol) pmCoverVol.value = audio.volume
  if (pmCoverLyrics) pmCoverLyrics.classList.toggle('active', _lyricsOpen)
  syncPmQueuePreviews()
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
  if (hasCommonMojibakeToken(value)) return true
  if (/[ÃÂÐÑ]|Ð.|Ñ.|Ã.|Â.|рџ|в‚|сГ|�/.test(value)) return true
  const runs = value.match(/(?:Р|С)[Ѐ-ӿ]/g)
  if (!runs || runs.length < 4) return false
  return runs.length * 2 >= value.replace(/\s/g, '').length * 0.34
}

function mojibakeScore(value) {
  if (!value) return 0
  let score = 0
  score += (value.match(/(?:Р|С)[Ѐ-ӿ]/g) || []).length
  score += (value.match(/Ð.|Ñ.|рџ|в‚/g) || []).length * 2
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
      if (m.type === 'attributes' && m.target && m.target.nodeType === Node.ELEMENT_NODE) {
        const el = /** @type {Element} */ (m.target)
        const attr = m.attributeName
        if (attr === 'placeholder' || attr === 'title' || attr === 'aria-label') {
          const src = el.getAttribute(attr)
          if (!src || (!looksLikeMojibake(src) && !hasCommonMojibakeToken(src))) continue
          const fixed = sanitizeDisplayText(src)
          if (fixed && fixed !== src) el.setAttribute(attr, fixed)
        }
        continue
      }
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
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['placeholder', 'title', 'aria-label'],
  })
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

function getSearchCacheKey(query, settings = getSettings(), filter = 'all') {
  const q = String(query || '').trim().toLowerCase()
  const src = typeof getSearchActiveSource === 'function'
    ? getSearchActiveSource(settings)
    : String(settings?.activeSource || currentSource || 'hybrid').toLowerCase()
  const f = String(filter || 'all').toLowerCase()
  const tokenSig = [
    settings?.spotifyToken ? 'sp1' : 'sp0',
    settings?.vkToken ? 'vk1' : 'vk0',
    settings?.soundcloudClientId ? 'sc1' : 'sc0',
    settings?.yandexToken ? 'ym1' : 'ym0',
    settings?.proxyBaseUrl ? `srv:${String(settings.proxyBaseUrl).trim().toLowerCase()}` : 'srv0',
  ].join(':')
  return `${src}:${f}:${q}:${tokenSig}`
}

// в”Ђв”Ђв”Ђ PROVIDERS в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
const providers = {
  youtube:    (q)    => searchYouTube(q),
  spotify:    (q, s) => searchSpotify(q, s.spotifyToken),
  audius:     (q)    => searchAudius(q),
}

/** Активный источник в настройках: гибрид отдельно от одиночных провайдеров в `providers`. */
const ALLOWED_ACTIVE_SOURCES = new Set(['hybrid', 'spotify', 'soundcloud', 'audius', 'yandex', 'vk'])

function normalizeStoredActiveSource(rawSrc) {
  const raw = String(rawSrc || 'hybrid').toLowerCase()
  // Основной рабочий поиск — серверный Spotify → SoundCloud → Audius; YouTube как activeSource не используем.
  if (raw === 'yt' || raw === 'youtube') return 'hybrid'
  if (raw === 'ya' || raw === 'ym') return 'yandex'
  if (raw === 'sc') return 'soundcloud'
  if (raw === 'hm' || raw === 'hitmo') return 'hybrid'
  if (raw === 'vkontakte') return 'vk'
  if (ALLOWED_ACTIVE_SOURCES.has(raw)) return raw
  return 'hybrid'
}

// в”Ђв”Ђв”Ђ SETTINGS в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
function normalizeFlowServerUrl(value = '') {
  let raw = String(value || '').trim()
  if (!raw) raw = FLOW_SERVER_DEFAULT_URL
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`
  raw = raw.replace(/\/+$/, '')
  raw = raw.replace(/\/health$/i, '')
  if (/^https:\/\/85\.239\.34\.229(?::8787)?$/i.test(raw)) raw = raw.replace(/^https:/i, 'http:')
  return raw || FLOW_SERVER_DEFAULT_URL
}

function getSettings() {
  const raw = JSON.parse(localStorage.getItem('flow_settings')) || {
    soundcloudClientId: '', vkToken: '', spotifyToken: '', yandexToken: '', activeSource: 'hybrid',
    discordClientId: '', discordRpcEnabled: false, lastfmApiKey: '', lastfmSharedSecret: '', lastfmSessionKey: '',
    proxyBaseUrl: FLOW_SERVER_DEFAULT_URL,
    compactUi: false,
    mediaShowQueue: true,
    mediaMetaAlign: 'left',
    mediaPlayerBarMode: 'always',
    minimizeToTrayOnClose: true,
    launchAtLogin: false,
    flowSocialApiBase: FLOW_SOCIAL_DEFAULT_API_BASE,
    flowSocialApiSecret: FLOW_SOCIAL_DEFAULT_API_SECRET,
  }
  if (typeof raw.compactUi !== 'boolean') raw.compactUi = false
  if (typeof raw.mediaShowQueue !== 'boolean') raw.mediaShowQueue = true
  const metaAlign = String(raw.mediaMetaAlign || 'left').trim().toLowerCase()
  raw.mediaMetaAlign = metaAlign === 'center' || metaAlign === 'right' ? metaAlign : 'left'
  const barMode = String(raw.mediaPlayerBarMode || 'always').trim().toLowerCase()
  raw.mediaPlayerBarMode = barMode === 'hide-on-media' ? 'hide-on-media' : 'always'
  if (!Object.prototype.hasOwnProperty.call(raw, 'flowSocialApiBase')) raw.flowSocialApiBase = FLOW_SOCIAL_DEFAULT_API_BASE
  if (!Object.prototype.hasOwnProperty.call(raw, 'flowSocialApiSecret')) raw.flowSocialApiSecret = FLOW_SOCIAL_DEFAULT_API_SECRET
  if (!String(raw.flowSocialApiBase || '').trim()) raw.flowSocialApiBase = FLOW_SOCIAL_DEFAULT_API_BASE
  if (!String(raw.flowSocialApiSecret || '').trim()) raw.flowSocialApiSecret = FLOW_SOCIAL_DEFAULT_API_SECRET
  raw.proxyBaseUrl = normalizeFlowServerUrl(raw.proxyBaseUrl)
  if (typeof raw.optDisableAnimations !== 'boolean') raw.optDisableAnimations = false
  if (typeof raw.optSimpleGraphics !== 'boolean') raw.optSimpleGraphics = false
  if (typeof raw.optFreezePlayerWhenMinimized !== 'boolean') raw.optFreezePlayerWhenMinimized = true
  if (typeof raw.optPauseHeavyBgWhenBackgrounded !== 'boolean') raw.optPauseHeavyBgWhenBackgrounded = true
  if (typeof raw.optGameSleepMode !== 'boolean') raw.optGameSleepMode = false
  if (typeof raw.minimizeToTrayOnClose !== 'boolean') raw.minimizeToTrayOnClose = true
  if (typeof raw.launchAtLogin !== 'boolean') raw.launchAtLogin = false
  if (typeof raw.vkSeleniumBridge !== 'boolean') raw.vkSeleniumBridge = false
  const prevActive = raw.activeSource
  raw.activeSource = normalizeStoredActiveSource(raw.activeSource)
  if (!ALLOWED_ACTIVE_SOURCES.has(raw.activeSource)) raw.activeSource = 'hybrid'
  if (prevActive !== raw.activeSource) {
    try { localStorage.setItem('flow_settings', JSON.stringify(raw)) } catch {}
  }
  return raw
}

function shouldUseProxyStream() {
  const s = getSettings()
  const mode = String(s.proxyBaseUrl || '').trim().toLowerCase()
  return mode !== 'off' && mode !== FLOW_SERVER_DEFAULT_URL.toLowerCase()
}

/** VK/Яндекс часто отвечают 403 без Referer как в браузере — локальный прокси в main нужен даже при дефолтном flow server. */
function shouldForceStreamProxyForUrl(url, source) {
  const src = String(source || '').toLowerCase()
  if (src === 'vk' || src === 'yandex') return true
  try {
    const h = new URL(String(url || '')).hostname.toLowerCase()
    if (
      h.includes('vk.com') ||
      h.includes('vk-cdn') ||
      h.includes('vkuseraudio') ||
      h.includes('userapi.com') ||
      h.includes('vkuservideo') ||
      h.includes('vk-portal') ||
      h.includes('api.vk.ru')
    )
      return true
    if (h.includes('strm.yandex')) return true
    if (h.includes('yandex.net') && (h.includes('storage') || h.includes('strm'))) return true
    if (h === 'api.music.yandex.net' || h.includes('music.yandex')) return true
  } catch (_) {}
  return false
}

function shouldProxyThisStreamUrl(url, source) {
  if (!/^https?:\/\//i.test(String(url || ''))) return false
  return shouldUseProxyStream() || shouldForceStreamProxyForUrl(url, source)
}

function saveSettingsRaw(patch) {
  const s = getSettings()
  const updated = Object.assign(s, patch)
  localStorage.setItem('flow_settings', JSON.stringify(updated))
  currentSource = updated.activeSource || 'hybrid'
  updateSourceBadge()
  try {
    syncSearchSourceRows?.()
  } catch (_) {}
}

/** Состояние окна из Electron (свёрнуто и т.д.) — для оптимизаций панели и фона. */
let _flowElectronMinimized = false
/** На Windows Chromium часто не даёт visibility:hidden при Alt+Tab — ориентируемся ещё и на blur окна. */
let _flowElectronFocused = true
let _flowOptimizationChannelBound = false

function applyFlowWindowStatePayload(state) {
  if (!state || typeof state !== 'object') return
  _flowElectronMinimized = Boolean(state.minimized)
  if (typeof state.focused === 'boolean') _flowElectronFocused = state.focused
}

function setupFlowOptimizationChannel() {
  if (_flowOptimizationChannelBound) return
  _flowOptimizationChannelBound = true
  document.addEventListener('visibilitychange', () => {
    try {
      refreshOptimizationAmbientClasses()
    } catch (_) {}
  }, { passive: true })
  try {
    window.api?.onFlowWindowState?.((state) => {
      applyFlowWindowStatePayload(state)
      refreshOptimizationAmbientClasses()
    })
  } catch (_) {}
  try {
    const p = window.api?.getFlowWindowState?.()
    if (p && typeof p.then === 'function') {
      p.then((state) => {
        applyFlowWindowStatePayload(state)
        refreshOptimizationAmbientClasses()
      }).catch(() => {})
    }
  } catch (_) {}
}

function refreshOptimizationAmbientClasses() {
  let bgSleep = false
  let freezePb = false
  let gameSleep = false
  try {
    const s = getSettings()
    const away =
      document.visibilityState === 'hidden' ||
      _flowElectronMinimized ||
      !_flowElectronFocused
    gameSleep = Boolean(s.optGameSleepMode && away)
    if (s.optPauseHeavyBgWhenBackgrounded) {
      if (document.visibilityState === 'hidden') bgSleep = true
      else if (_flowElectronMinimized) bgSleep = true
    }
    freezePb = Boolean(s.optFreezePlayerWhenMinimized && _flowElectronMinimized)
  } catch (_) {}
  document.body.classList.toggle('flow-opt-bg-sleep', bgSleep)
  document.body.classList.toggle('flow-opt-freeze-player', freezePb)
  document.body.classList.toggle('flow-opt-game-sleep', gameSleep)
  try {
    const overlay = document.getElementById('flow-game-sleep-overlay')
    if (overlay) overlay.setAttribute('aria-hidden', gameSleep ? 'false' : 'true')
  } catch (_) {}
  try {
    if (gameSleep) {
      if (typeof stopLyricsSyncLoop === 'function') stopLyricsSyncLoop()
    } else {
      let canResumeLyrics = false
      try {
        canResumeLyrics = Boolean(_lyricsOpen && _lyricsData?.length && audio && !audio.paused)
      } catch (_) {}
      if (canResumeLyrics && typeof startLyricsSyncLoop === 'function') startLyricsSyncLoop()
    }
  } catch (_) {}
}

function syncOptimizationPanelToggles() {
  const s = getSettings()
  const pairs = [
    ['toggle-opt-animations', 'optDisableAnimations'],
    ['toggle-opt-simple-gfx', 'optSimpleGraphics'],
    ['toggle-opt-freeze-player', 'optFreezePlayerWhenMinimized'],
    ['toggle-opt-bg-when-away', 'optPauseHeavyBgWhenBackgrounded'],
    ['toggle-opt-game-sleep', 'optGameSleepMode'],
  ]
  pairs.forEach(([id, key]) => {
    const el = document.getElementById(id)
    if (el) el.classList.toggle('active', Boolean(s[key]))
  })
}

function applyOptimizationSettings() {
  const s = getSettings()
  document.body.classList.toggle('flow-opt-no-animations', Boolean(s.optDisableAnimations))
  document.body.classList.toggle('flow-performance', Boolean(s.optSimpleGraphics))
  syncOptimizationPanelToggles()
  syncPlaybackSystemToggles()
  refreshOptimizationAmbientClasses()
}

function isMediaQueueEnabled() {
  return getSettings().mediaShowQueue !== false
}

function syncMediaQueueToggle() {
  const el = document.getElementById('toggle-media-show-queue')
  if (el) el.classList.toggle('active', isMediaQueueEnabled())
}

function getMediaMetaAlign() {
  const a = String(getSettings().mediaMetaAlign || 'left').trim().toLowerCase()
  return a === 'center' || a === 'right' ? a : 'left'
}

function getMediaPlayerBarMode() {
  return String(getSettings().mediaPlayerBarMode || 'always').trim().toLowerCase() === 'hide-on-media'
    ? 'hide-on-media'
    : 'always'
}

function syncMediaMetaAlignUI() {
  const align = getMediaMetaAlign()
  ;['center', 'left', 'right'].forEach((id) => {
    const btn = document.getElementById(`media-meta-align-${id}`)
    if (btn) btn.classList.toggle('active', id === align)
  })
}

function syncMediaPlayerBarModeUI() {
  const mode = getMediaPlayerBarMode()
  const always = document.getElementById('media-player-bar-always')
  const hide = document.getElementById('media-player-bar-hide')
  if (always) always.classList.toggle('active', mode === 'always')
  if (hide) hide.classList.toggle('active', mode === 'hide-on-media')
}

function applyMediaMetaAlign() {
  const page = document.getElementById('page-home')
  if (!page) return
  page.classList.remove('media-meta-align-center', 'media-meta-align-left', 'media-meta-align-right')
  page.classList.add(`media-meta-align-${getMediaMetaAlign()}`)
  syncMediaMetaAlignUI()
}

function applyMediaPlayerBarVisibility() {
  const onMedia = _activePageId === 'home'
  const hide = onMedia && getMediaPlayerBarMode() === 'hide-on-media'
  document.body.classList.toggle('media-page-active', onMedia)
  document.body.classList.toggle('media-player-bar-hidden', hide)
  syncMediaPlayerBarModeUI()
}

function applyMediaQueueLayout() {
  const on = isMediaQueueEnabled()
  const page = document.getElementById('page-home')
  const shell = document.getElementById('playback-page-shell')
  const sub = document.getElementById('page-home-sub')
  if (page) page.classList.toggle('media-queue-off', !on)
  if (shell) shell.classList.toggle('media-queue-off', !on)
  if (sub) sub.textContent = on ? 'Управляй текущим треком и очередью' : 'Сейчас играет — режим Nexory'
  const upNext = document.getElementById('home-up-next')
  if (upNext) upNext.classList.toggle('hidden', !on)
  syncMediaQueueToggle()
  applyMediaMetaAlign()
  applyMediaPlayerBarVisibility()
  applyHomeSliderStyle()
  syncHomeNxFooter()
  if (!on) initHomeNxMediaTools()
  if (on && typeof renderQueue === 'function') renderQueue()
  queueMicrotask(() => {
    try {
      if (on) alignHomeHeaderToPlay()
      resizeHomeVisualizerCanvas()
    } catch (_) {}
  })
}

function setMediaMetaAlign(align) {
  const a = String(align || '').trim().toLowerCase()
  const safe = a === 'center' || a === 'right' ? a : 'left'
  saveSettingsRaw({ mediaMetaAlign: safe })
  applyMediaMetaAlign()
  showToast(`Текст в медиа: ${safe === 'center' ? 'по центру' : safe === 'right' ? 'справа' : 'слева'}`)
}
window.setMediaMetaAlign = setMediaMetaAlign

function setMediaPlayerBarMode(mode) {
  const m = String(mode || '').trim().toLowerCase()
  const safe = m === 'hide-on-media' ? 'hide-on-media' : 'always'
  saveSettingsRaw({ mediaPlayerBarMode: safe })
  applyMediaPlayerBarVisibility()
  showToast(safe === 'hide-on-media' ? 'Панель скрывается в медиа' : 'Панель всегда видна')
}
window.setMediaPlayerBarMode = setMediaPlayerBarMode

function toggleMediaShowQueue() {
  const next = !isMediaQueueEnabled()
  saveSettingsRaw({ mediaShowQueue: next })
  applyMediaQueueLayout()
  showToast(next ? 'Очередь в медиа включена' : 'Очередь скрыта — режим Nexory')
}
window.toggleMediaShowQueue = toggleMediaShowQueue
window.applyMediaQueueLayout = applyMediaQueueLayout
window.isMediaQueueEnabled = isMediaQueueEnabled

function cycleSoundEnhancerProfile() {
  const order = ['clean', 'balanced', 'bright']
  const cur = getSoundEnhancerProfile()
  const i = Math.max(0, order.indexOf(cur))
  setSoundEnhancerProfile(order[(i + 1) % order.length])
}
window.cycleSoundEnhancerProfile = cycleSoundEnhancerProfile

function openPlaybackEqSettings() {
  openPage('settings')
  switchSettingsCategory('playback')
  requestAnimationFrame(() => {
    document.getElementById('sound-profile-clean')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  })
}
window.openPlaybackEqSettings = openPlaybackEqSettings

function openMediaSourceSettings() {
  openPage('settings')
  switchSettingsCategory('accounts')
}
window.openMediaSourceSettings = openMediaSourceSettings

const HOME_NX_SRC_LOGOS = {
  vk: 'assets/source-vk.png',
  yandex: 'assets/source-yandex-music.png',
  hybrid: 'assets/icon-source.png',
}

let _homeNxPlaybackRamp = null

function applyPlaybackPitchForRate(rate) {
  const slowed = Number(rate) < 1
  try {
    if ('preservesPitch' in audio) audio.preservesPitch = !slowed
    if ('mozPreservesPitch' in audio) audio.mozPreservesPitch = !slowed
    if ('webkitPreservesPitch' in audio) audio.webkitPreservesPitch = !slowed
  } catch (_) {}
}

function rampAudioPlaybackRate(targetRate) {
  const r = Math.max(0.5, Math.min(2, Number(targetRate) || 1))
  applyPlaybackPitchForRate(r)
  if (_homeNxPlaybackRamp) {
    clearInterval(_homeNxPlaybackRamp)
    _homeNxPlaybackRamp = null
  }
  const from = Number(audio.playbackRate) || 1
  if (!audio?.src || Math.abs(from - r) < 0.02) {
    try {
      audio.playbackRate = r
    } catch (_) {}
    return
  }
  const steps = 14
  const ms = 160
  let i = 0
  _homeNxPlaybackRamp = setInterval(() => {
    i += 1
    const t = i / steps
    const eased = t * t * (3 - 2 * t)
    try {
      audio.playbackRate = from + (r - from) * eased
    } catch (_) {}
    if (i >= steps) {
      clearInterval(_homeNxPlaybackRamp)
      _homeNxPlaybackRamp = null
      try {
        audio.playbackRate = r
      } catch (_) {}
    }
  }, Math.max(8, Math.round(ms / steps)))
}

const HOME_NX_SPEED_MIN = 0.75

function getPlaybackRate() {
  try {
    const v = Number(localStorage.getItem('flow_playback_rate') || '1')
    if (!Number.isFinite(v)) return 1
    const clamped = Math.max(HOME_NX_SPEED_MIN, Math.min(2, v))
    if (clamped !== v) {
      try {
        localStorage.setItem('flow_playback_rate', String(clamped))
      } catch (_) {}
    }
    return clamped
  } catch (_) {
    return 1
  }
}

function formatPlaybackRateLabel(rate) {
  const n = Math.round(Number(rate) * 100) / 100
  if (Math.abs(n - Math.round(n)) < 0.01) return `${Math.round(n)}×`
  return `${n.toFixed(2).replace(/\.?0+$/, '')}×`
}

function syncHomeNxSpeedUI() {
  const r = getPlaybackRate()
  const slider = document.getElementById('home-nx-speed-slider')
  const badge = document.getElementById('home-nx-speed-badge')
  if (slider) slider.value = String(r)
  if (badge) badge.textContent = formatPlaybackRateLabel(r)
  document.querySelectorAll('.home-nx-speed-pill, .home-nx-speed-chip').forEach((btn) => {
    const v = Number(btn.getAttribute('data-rate'))
    btn.classList.toggle('active', Math.abs(v - r) < 0.03)
  })
}

function applyPlaybackRate() {
  const r = getPlaybackRate()
  applyPlaybackPitchForRate(r)
  rampAudioPlaybackRate(r)
  syncHomeNxSpeedUI()
}

function setPlaybackRate(rate) {
  const r = Math.max(HOME_NX_SPEED_MIN, Math.min(2, Number(rate) || 1))
  try {
    localStorage.setItem('flow_playback_rate', String(r))
  } catch (_) {}
  rampAudioPlaybackRate(r)
  syncHomeNxSpeedUI()
}
window.setPlaybackRate = setPlaybackRate

function restoreHomeNxDropdown(menu) {
  if (!menu?._homeNxMenuWrap) return
  try {
    menu._homeNxMenuWrap.appendChild(menu)
  } catch (_) {}
  delete menu._homeNxMenuWrap
}

function closeHomeNxMenus() {
  ;['home-nx-speed-menu', 'home-nx-eq-menu', 'home-nx-source-menu'].forEach((id) => {
    const menu = document.getElementById(id)
    if (!menu) return
    menu.classList.add('hidden')
    restoreHomeNxDropdown(menu)
  })
  document.getElementById('home-nx-speed-btn')?.setAttribute('aria-expanded', 'false')
  document.getElementById('home-nx-eq-btn')?.setAttribute('aria-expanded', 'false')
  document.getElementById('home-nx-source-btn')?.setAttribute('aria-expanded', 'false')
  document.querySelectorAll('.home-nx-foot-btn.is-open, .home-nx-ctrl-btn.is-open').forEach((el) => el.classList.remove('is-open'))
  document.querySelectorAll('.home-nx-dropdown.is-fixed').forEach((el) => {
    el.classList.remove('is-fixed')
    el.style.position = ''
    el.style.left = ''
    el.style.right = ''
    el.style.bottom = ''
    el.style.top = ''
    el.style.width = ''
    el.style.maxWidth = ''
    el.style.transform = ''
    el.style.visibility = ''
    el.style.pointerEvents = ''
  })
}
window.closeHomeNxPopovers = closeHomeNxMenus
window.closeHomeNxMenus = closeHomeNxMenus

function positionHomeNxDropdown(menu, btn) {
  if (!menu || !btn) return
  menu.classList.add('is-fixed')
  menu.style.position = 'fixed'
  menu.style.right = 'auto'
  menu.style.bottom = 'auto'
  menu.style.visibility = 'hidden'
  menu.style.pointerEvents = 'auto'
  const pad = 12
  const vw = window.innerWidth
  const vh = window.innerHeight
  const rect = btn.getBoundingClientRect()
  const gap = 10
  const mw = Math.min(Math.max(menu.scrollWidth || 0, menu.offsetWidth || 0, 220), vw - pad * 2)
  menu.style.width = `${mw}px`
  menu.style.maxWidth = `${vw - pad * 2}px`
  const mh = menu.offsetHeight || 220
  let left = rect.left + rect.width / 2 - mw / 2
  left = Math.max(pad, Math.min(left, vw - mw - pad))
  let top = rect.top - mh - gap
  if (top < pad) top = Math.min(rect.bottom + gap, vh - mh - pad)
  if (top + mh > vh - pad) top = Math.max(pad, vh - mh - pad)
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
  menu.style.visibility = 'visible'
}

function toggleHomeNxMenu(ev, menuId, btnId, onOpen) {
  ev?.stopPropagation?.()
  const menu = document.getElementById(menuId)
  const btn = document.getElementById(btnId)
  if (!menu) return
  const willOpen = menu.classList.contains('hidden')
  closeHomeNxMenus()
  if (willOpen) {
    const wrap = btn?.closest?.('.home-nx-menu-wrap')
    if (wrap && menu.parentElement !== document.body) {
      menu._homeNxMenuWrap = wrap
      document.body.appendChild(menu)
    }
    menu.classList.remove('hidden')
    btn?.setAttribute('aria-expanded', 'true')
    btn?.classList.add('is-open')
    if (typeof onOpen === 'function') onOpen()
    requestAnimationFrame(() => {
      positionHomeNxDropdown(menu, btn)
      requestAnimationFrame(() => positionHomeNxDropdown(menu, btn))
    })
  }
}

function toggleHomeNxSpeedMenu(ev) {
  toggleHomeNxMenu(ev, 'home-nx-speed-menu', 'home-nx-speed-btn', syncHomeNxSpeedUI)
}
window.toggleHomeNxSpeedMenu = toggleHomeNxSpeedMenu
window.toggleHomeNxSpeedPopover = toggleHomeNxSpeedMenu

function toggleHomeNxEqMenu(ev) {
  toggleHomeNxMenu(ev, 'home-nx-eq-menu', 'home-nx-eq-btn', renderHomeNxEqUI)
}
window.toggleHomeNxEqMenu = toggleHomeNxEqMenu
window.toggleHomeNxEqPopover = toggleHomeNxEqMenu

function toggleHomeNxSourceMenu(ev) {
  toggleHomeNxMenu(ev, 'home-nx-source-menu', 'home-nx-source-btn')
}
window.toggleHomeNxSourceMenu = toggleHomeNxSourceMenu

function pickHomeNxSource(src) {
  switchSearchSource(src)
  closeHomeNxMenus()
  syncHomeNxSourceLogo(true)
}
window.pickHomeNxSource = pickHomeNxSource

function syncHomeNxSourceLogo(pulse = false) {
  const raw = normalizeStoredActiveSource(getSettings()?.activeSource || currentSource || 'hybrid')
  const src = HOME_NX_SRC_LOGOS[raw] || HOME_NX_SRC_LOGOS.hybrid
  ;['home-nx-src-logo', 'pm-source-logo', 'search-src-logo'].forEach((id) => {
    const img = document.getElementById(id)
    if (!img) return
    if (!String(img.getAttribute('src') || '').includes(src.replace(/^\//, ''))) img.src = src
    img.alt = raw
    if (id === 'search-src-logo') img.setAttribute('data-search-src', raw)
    if (pulse) {
      const btn = img.closest('.home-nx-source-btn, .pm-source-btn, .nx-search-src-btn')
      btn?.classList.remove('home-nx-source-btn--pulse')
      void btn?.offsetWidth
      btn?.classList.add('home-nx-source-btn--pulse')
    }
  })
  const menu = document.getElementById('home-nx-source-menu')
  menu?.querySelectorAll('.home-nx-src-opt').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-src') === raw)
  })
  document.querySelectorAll('.nx-search-src-opt').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-src') === raw)
  })
}

function getParametricEqModule() {
  return window.FlowModules?.parametricEq || null
}

function getEqAudioState() {
  return { audioCtx: _audioCtx, analyser: _analyser, freqData: _freqData, eqFilters: _eqFilters }
}

function ensureEqAudioChainReady() {
  if (_eqFilters?.length && _audioCtx?.state !== 'closed') return true
  try {
    if (typeof ensureAudioAnalyzer === 'function') ensureAudioAnalyzer()
  } catch (_) {}
  return !!_eqFilters?.length
}

function applyHomeNxEqPreset(presetId) {
  const eq = getParametricEqModule()
  if (!eq) return
  const state = getEqAudioState()
  ensureEqAudioChainReady()
  const animate = !!state.eqFilters?.length
  eq.applyPreset?.(presetId, state, _audioCtx, animate)
  _eqFilters = state.eqFilters
  renderHomeNxEqUI()
}

let _homeNxEqDrag = null

function bindHomeNxEqGraphDrag() {
  const graph = document.getElementById('home-nx-eq-graph')
  const eq = getParametricEqModule()
  if (!graph || !eq || graph.dataset.dragBound) return
  graph.dataset.dragBound = '1'
  const onMove = (e) => {
    if (!_homeNxEqDrag) return
    const pt = graph.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const ctm = graph.getScreenCTM()
    if (!ctm) return
    const sp = pt.matrixTransform(ctm.inverse())
    const h = 132
    const midY = h * 0.55
    const db = ((midY - sp.y) / (h * 0.42)) * 12
    const gains = eq.getCurrentGains?.() || []
    gains[_homeNxEqDrag] = Math.max(-12, Math.min(12, db))
    const state = getEqAudioState()
    eq.applyCustomGains?.(gains, state, _audioCtx, !!state.eqFilters?.length)
    _eqFilters = state.eqFilters
    renderHomeNxEqUI(false)
  }
  const onUp = () => {
    _homeNxEqDrag = null
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
  }
  const pickBandFromEvent = (e) => {
    const node = e.target.closest?.('.home-nx-eq-node')
    if (node) return Number(node.getAttribute('data-band'))
    const pt = graph.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const ctm = graph.getScreenCTM()
    if (!ctm) return NaN
    const sp = pt.matrixTransform(ctm.inverse())
    const freqs = eq.EQ_FREQS || []
    const w = 400
    const idx = freqs.length > 1 ? Math.round((sp.x / w) * (freqs.length - 1)) : 0
    return Math.max(0, Math.min(freqs.length - 1, idx))
  }
  graph.addEventListener('pointerdown', (e) => {
    _homeNxEqDrag = pickBandFromEvent(e)
    if (!Number.isFinite(_homeNxEqDrag)) return
    ensureEqAudioChainReady()
    e.preventDefault()
    graph.setPointerCapture?.(e.pointerId)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  })
}

const HOME_NX_EQ_PRESET_ORDER = ['neutral', 'bass', 'highs', 'vocal', 'classic', 'jazz', 'liquid', 'deep-ocean', 'rock']

function bindHomeNxEqPresetControls() {
  const presetsEl = document.getElementById('home-nx-eq-presets')
  const eq = getParametricEqModule()
  if (!presetsEl || !eq || presetsEl.dataset.ready) return
  presetsEl.dataset.ready = '1'
  presetsEl.innerHTML = HOME_NX_EQ_PRESET_ORDER.map((id) => {
    const label = eq.PRESET_LABELS?.[id] || id
    return `<button type="button" class="home-nx-eq-preset" data-preset="${id}">${label}</button>`
  }).join('')
  presetsEl.querySelectorAll('.home-nx-eq-preset').forEach((btn) => {
    btn.addEventListener('click', () => applyHomeNxEqPreset(btn.getAttribute('data-preset')))
  })
  presetsEl.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      presetsEl.scrollLeft += (e.deltaY || e.deltaX) * 0.85
    },
    { passive: false }
  )
  document.getElementById('home-nx-eq-scroll-l')?.addEventListener('click', (e) => {
    e.stopPropagation()
    presetsEl.scrollBy({ left: -140, behavior: 'smooth' })
  })
  document.getElementById('home-nx-eq-scroll-r')?.addEventListener('click', (e) => {
    e.stopPropagation()
    presetsEl.scrollBy({ left: 140, behavior: 'smooth' })
  })
}

function onHomeNxTrackEqChanged(track) {
  const eq = getParametricEqModule()
  if (!eq?.loadEqForTrack) return
  if (ensureEqAudioChainReady()) {
    const state = getEqAudioState()
    eq.loadEqForTrack(track, state, _audioCtx)
    _eqFilters = state.eqFilters
  } else {
    eq.loadEqForTrack(track, { eqFilters: [] }, null)
  }
  renderHomeNxEqUI(true)
}

function saveHomeNxEqForTrack(ev) {
  ev?.stopPropagation?.()
  if (!currentTrack) {
    showToast('Сначала включи трек', true)
    return
  }
  const eq = getParametricEqModule()
  if (!eq?.saveTrackEqState) return
  ensureEqAudioChainReady()
  const gains = eq.getCurrentGains?.() || []
  const presetId = eq.readStoredPreset?.() || 'custom'
  eq.saveTrackEqState(currentTrack, presetId, gains)
  showToast('Эквалайзер сохранён для этого трека')
  renderHomeNxEqUI(false)
}
window.saveHomeNxEqForTrack = saveHomeNxEqForTrack
window.onHomeNxTrackEqChanged = onHomeNxTrackEqChanged

function renderHomeNxEqUI(rebindPresets = true) {
  const eq = getParametricEqModule()
  const presetsEl = document.getElementById('home-nx-eq-presets')
  const graph = document.getElementById('home-nx-eq-graph')
  const labels = document.getElementById('home-nx-eq-freq-labels')
  if (!eq || !presetsEl || !graph) return
  if (rebindPresets) bindHomeNxEqPresetControls()
  const activePreset = eq.readStoredPreset?.() || 'neutral'
  const gains = eq.getCurrentGains?.() || eq.getPresetGains('neutral')
  presetsEl.querySelectorAll('.home-nx-eq-preset').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-preset') === activePreset)
  })
  const freqs = eq.EQ_FREQS || []
  const w = 400
  const h = 132
  const midY = h * 0.55
  const pts = gains.map((g, i) => {
    const x = freqs.length > 1 ? (i / (freqs.length - 1)) * w : w / 2
    const y = midY - (Number(g) / 12) * (h * 0.42)
    return [x, y]
  })
  const line = pts.map((p) => p.join(',')).join(' ')
  graph.innerHTML = `<polyline class="home-nx-eq-line" points="${line}"></polyline>${pts
    .map(
      ([x, y], i) =>
        `<circle class="home-nx-eq-node" data-band="${i}" cx="${x}" cy="${y}" r="7"></circle>`
    )
      .join('')}`
  bindHomeNxEqGraphDrag()
  if (labels && !labels.dataset.ready) {
    labels.dataset.ready = '1'
    labels.innerHTML = freqs
      .map((f) => `<span>${f >= 1000 ? `${f / 1000}k` : f}</span>`)
      .join('')
  }
}

function openHomeNxCoverMode() {
  if (typeof enterPlayerMode === 'function') {
    enterPlayerMode()
    return
  }
}
window.openHomeNxCoverMode = openHomeNxCoverMode

function closeHomeNxCoverMode() {
  const panel = document.getElementById('home-nx-cover-mode')
  if (!panel) return
  panel.classList.add('hidden')
  panel.setAttribute('aria-hidden', 'true')
  document.getElementById('page-home')?.classList.remove('home-nx-cover-mode-active')
}
window.closeHomeNxCoverMode = closeHomeNxCoverMode

function syncHomeNxCoverModeProgress() {
  const cur = document.getElementById('home-nx-cover-mode-cur')
  const tot = document.getElementById('home-nx-cover-mode-tot')
  const prog = document.getElementById('home-nx-cover-mode-progress')
  if (!cur || !tot || !prog) return
  cur.textContent = fmtTime(audio.currentTime)
  tot.textContent = fmtTime(audio.duration)
  const ratio = audio.duration ? audio.currentTime / audio.duration : 0
  prog.value = ratio
}

function initHomeNxMediaTools() {
  closeHomeNxMenus()
  syncHomeNxSpeedUI()
  syncHomeNxSourceLogo()
  applyPlaybackRate()
  try {
    hydrateFlowLucideIcons?.(document.querySelector('.home-clone-controls--nx') || document.getElementById('page-home') || document)
  } catch (_) {}
  bindHomeNxEqPresetControls()
  if (!document.body.dataset.homeNxPopBound) {
    document.body.dataset.homeNxPopBound = '1'
    document.addEventListener('click', (e) => {
      if (e.target.closest?.('.home-nx-menu-wrap, .home-nx-source-wrap, .home-nx-dropdown')) return
      closeHomeNxMenus()
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeHomeNxMenus()
        closeHomeNxCoverMode()
      }
    })
    window.addEventListener('resize', () => closeHomeNxMenus())
  }
}

function syncPlaybackSystemToggles() {
  const s = getSettings()
  const tray = document.getElementById('toggle-minimize-to-tray')
  if (tray) tray.classList.toggle('active', Boolean(s.minimizeToTrayOnClose))
  const login = document.getElementById('toggle-launch-at-login')
  if (login) login.classList.toggle('active', Boolean(s.launchAtLogin))
  syncMediaQueueToggle()
}

function syncTrayClosePreferenceToMain() {
  try {
    if (!window.api?.setTrayOnClose) return
    const s = getSettings()
    window.api.setTrayOnClose(Boolean(s.minimizeToTrayOnClose))
  } catch (_) {}
}

function toggleMinimizeToTrayOnClose() {
  const cur = getSettings()
  saveSettingsRaw({ minimizeToTrayOnClose: !Boolean(cur.minimizeToTrayOnClose) })
  syncPlaybackSystemToggles()
  syncTrayClosePreferenceToMain()
  showToast(getSettings().minimizeToTrayOnClose ? 'Закрытие: в трей (музыка играет)' : 'Закрытие: выход из приложения')
}
window.toggleMinimizeToTrayOnClose = toggleMinimizeToTrayOnClose

async function toggleLaunchAtLogin() {
  if (!window.api?.setLaunchAtLogin || !window.api?.getLaunchAtLogin) return
  const cur = getSettings()
  const next = !Boolean(cur.launchAtLogin)
  try {
    const r = await window.api.setLaunchAtLogin(next)
    if (!r?.ok) {
      showToast(String(r?.error || 'Не удалось изменить автозапуск'), true)
      return
    }
    saveSettingsRaw({ launchAtLogin: Boolean(r.enabled) })
    syncPlaybackSystemToggles()
    showToast(r.enabled ? 'Автозапуск включён' : 'Автозапуск выключен')
  } catch (err) {
    showToast(String(err?.message || err), true)
  }
}
window.toggleLaunchAtLogin = toggleLaunchAtLogin

async function refreshLaunchAtLoginFromMain() {
  if (!window.api?.getLaunchAtLogin) return
  try {
    const r = await window.api.getLaunchAtLogin()
    if (r?.ok && typeof r.enabled === 'boolean') saveSettingsRaw({ launchAtLogin: r.enabled })
    syncPlaybackSystemToggles()
  } catch (_) {}
}

function flowHandleTitlebarClose() {
  try {
    if (!window.api?.close) return
    const s = getSettings()
    window.api.close({ toTray: Boolean(s.minimizeToTrayOnClose) })
  } catch (_) {}
}
window.flowHandleTitlebarClose = flowHandleTitlebarClose

function toggleOptimizationSetting(key) {
  const allowed = new Set(['optDisableAnimations', 'optSimpleGraphics', 'optFreezePlayerWhenMinimized', 'optPauseHeavyBgWhenBackgrounded', 'optGameSleepMode'])
  if (!allowed.has(key)) return
  const cur = getSettings()
  saveSettingsRaw({ [key]: !Boolean(cur[key]) })
  applyOptimizationSettings()
}
window.toggleOptimizationSetting = toggleOptimizationSetting

let _compactSearchListenersBound = false

function syncCompactSearchInputTabIndex() {
  const bar = document.getElementById('search-bar')
  const input = document.getElementById('search-input')
  if (!bar || !input) return
  const peek = document.body.classList.contains('flow-compact-ui') && bar.classList.contains('search-bar--peek')
  input.tabIndex = peek ? -1 : 0
}

function syncSearchBarCollapsedState() {
  const bar = document.getElementById('search-bar')
  const input = document.getElementById('search-input')
  if (!bar || !input) return
  if (!document.body.classList.contains('flow-compact-ui')) {
    bar.classList.remove('search-bar--peek')
    syncCompactSearchInputTabIndex()
    return
  }
  if (_activePageId !== 'search') {
    bar.classList.add('search-bar--peek')
    syncCompactSearchInputTabIndex()
    return
  }
  if (!String(input.value || '').trim()) bar.classList.add('search-bar--peek')
  else bar.classList.remove('search-bar--peek')
  syncCompactSearchInputTabIndex()
}

function setupCompactSearchListeners() {
  if (_compactSearchListenersBound) return
  _compactSearchListenersBound = true
  const bar = document.getElementById('search-bar')
  const input = document.getElementById('search-input')
  if (!bar || !input) return
  bar.addEventListener('mousedown', (e) => {
    if (!document.body.classList.contains('flow-compact-ui')) return
    if (!bar.classList.contains('search-bar--peek')) return
    e.preventDefault()
    bar.classList.remove('search-bar--peek')
    syncCompactSearchInputTabIndex()
    requestAnimationFrame(() => { input.focus() })
  })
  input.addEventListener('focus', () => {
    if (!document.body.classList.contains('flow-compact-ui')) return
    bar.classList.remove('search-bar--peek')
    syncCompactSearchInputTabIndex()
  })
  input.addEventListener('blur', () => {
    setTimeout(() => {
      syncSearchBarCollapsedState()
    }, 160)
  })
  input.addEventListener('input', () => {
    syncSearchBarCollapsedState()
  })
}

/** Компактный / Zen UI: узкий скелет, иконки в меню, мини-поиск. */
function applyCompactUi(enabled) {
  const on = typeof enabled === 'boolean' ? enabled : Boolean(getSettings().compactUi)
  document.body.classList.toggle('flow-compact-ui', on)
  const sw = document.getElementById('toggle-compact-ui')
  if (sw) sw.classList.toggle('active', on)
  setupCompactSearchListeners()
  syncSearchBarCollapsedState()
  scheduleMainShiftRemeasure()
  try {
    window.dispatchEvent(new Event('resize'))
  } catch (_) {}
  requestAnimationFrame(() => {
    resizeHomeVisualizerCanvas()
    try {
      alignHomeHeaderToPlay()
    } catch (_) {}
  })
}

function toggleCompactUi() {
  const next = !getSettings().compactUi
  saveSettingsRaw({ compactUi: next })
  applyCompactUi(next)
  showToast(next ? 'Компактный режим включён' : 'Компактный режим выключен')
}

function openUrl(url) {
  if (window.api?.openExternal) window.api.openExternal(url)
  else window.open(url, '_blank')
}

const YANDEX_MUSIC_TOKEN_GUIDE_URL = 'https://yandex-music.readthedocs.io/en/main/token.html'
const YANDEX_MUSIC_OAUTH_URL = 'https://oauth.yandex.ru/authorize?response_type=token&client_id=23cabbbdc6cd418abb4b39c32c41195d'
const VKHOST_TOKEN_PAGE = 'https://vkhost.github.io/'
const FLOW_YANDEX_TELEGRAPH_GUIDE_URL = 'https://telegra.ph/Kak-podklyuchit-YAndeks-Muzyku-vo-Flow-05-03'
/** Опубликованный гайд VK (Telegraph); имеет приоритет над GitHub. */
const FLOW_VK_TELEGRAPH_GUIDE_URL = 'https://telegra.ph/Kak-podklyuchit-VKontakte-vo-Flow-05-04'
/** Публичный гайд по токену VK (HTML в репозитории). */
const FLOW_VK_GUIDE_GITHUB_BLOB =
  'https://github.com/ioqeeqo-create/NexoryND/blob/main/assets/guides/vk-token-dlya-flow.html'

function openFlowYandexTelegraphGuide() {
  openUrl(FLOW_YANDEX_TELEGRAPH_GUIDE_URL)
}
window.openFlowYandexTelegraphGuide = openFlowYandexTelegraphGuide

function openFlowVkTelegraphGuide() {
  const tele = String(FLOW_VK_TELEGRAPH_GUIDE_URL || '').trim()
  if (tele && /^https?:\/\//i.test(tele)) {
    openUrl(tele)
    return
  }
  if (String(FLOW_VK_GUIDE_GITHUB_BLOB || '').trim()) {
    openUrl(FLOW_VK_GUIDE_GITHUB_BLOB.trim())
    return
  }
  try {
    const href = String(window.location?.href || '')
    if (href) {
      const u = new URL('assets/guides/vk-token-dlya-flow.html', href)
      openUrl(u.href)
      return
    }
  } catch (_) {}
  openUrl(VKHOST_TOKEN_PAGE)
}
window.openFlowVkTelegraphGuide = openFlowVkTelegraphGuide

function forceSettingsSectionOpen(key) {
  const sectionKey = String(key || '').trim()
  if (!sectionKey || !Object.prototype.hasOwnProperty.call(SETTINGS_SECTION_COLLAPSED_DEFAULTS, sectionKey)) return
  const merged = getMergedSettingsSectionsState()
  merged[sectionKey] = false
  saveSettingsSectionsState(merged)
  applySettingsSectionsState()
}

function openAdvancedSourceSections() {
  switchSettingsCategory('accounts')
  ;['accountYoutube', 'accountSpotify', 'accountSoundcloud', 'accountVk', 'accountYandex'].forEach(forceSettingsSectionOpen)
  requestAnimationFrame(() => {
    document.querySelector('[data-settings-section="accountYoutube"]')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  })
}
window.openAdvancedSourceSections = openAdvancedSourceSections

function setAuthDrawerOpen(sourceKey) {
  const stack = document.getElementById('auth-source-stack')
  if (!stack) return
  if (!sourceKey) {
    stack.querySelectorAll('.auth-source-row.is-open').forEach((row) => row.classList.remove('is-open'))
    stack.querySelectorAll('.auth-source-drawer').forEach((d) => d.setAttribute('aria-hidden', 'true'))
    return
  }
  stack.querySelectorAll('.auth-source-row').forEach((row) => {
    const on = row.getAttribute('data-auth-row') === sourceKey
    row.classList.toggle('is-open', on)
    const drawer = row.querySelector('.auth-source-drawer')
    if (drawer) drawer.setAttribute('aria-hidden', on ? 'false' : 'true')
  })
}

function onAuthSourceTileClick(evt, kind) {
  const k = String(kind || '')
  if (k === 'spotify') {
    evt?.preventDefault?.()
    const row = document.querySelector(`.auth-source-row[data-auth-row="spotify"]`)
    const nextOpen = !row?.classList.contains('is-open')
    setAuthDrawerOpen(nextOpen ? 'spotify' : null)
    return
  }

  if (k === 'hybrid') setActiveSource('hybrid')
  if (k === 'yandex') setActiveSource('yandex')
  if (k === 'vk') setActiveSource('vk')

  const row = document.querySelector(`.auth-source-row[data-auth-row="${k}"]`)
  const nextOpen = !row?.classList.contains('is-open')
  setAuthDrawerOpen(nextOpen ? k : null)

  if (nextOpen && (k === 'yandex' || k === 'vk')) {
    if (k === 'yandex') syncYmTokenFieldsFromMain()
    if (k === 'vk') syncVkTokenFieldsFromMain()
  }
}
window.onAuthSourceTileClick = onAuthSourceTileClick

function syncYmTokenFieldsFromMain() {
  const a = document.getElementById('ym-token-val')
  const b = document.getElementById('ym-token-val-compact')
  if (a && b) {
    b.value = a.value
    b.type = a.type
  }
}

function syncYmTokenFieldsFromCompact() {
  const a = document.getElementById('ym-token-val')
  const b = document.getElementById('ym-token-val-compact')
  if (a && b) {
    a.value = b.value
    a.type = b.type
  }
}

function syncVkTokenFieldsFromMain() {
  const a = document.getElementById('vk-token-val')
  const b = document.getElementById('vk-token-val-compact')
  if (a && b) {
    b.value = a.value
    b.type = a.type
  }
}

function syncVkTokenFieldsFromCompact() {
  const a = document.getElementById('vk-token-val')
  const b = document.getElementById('vk-token-val-compact')
  if (a && b) {
    a.value = b.value
    a.type = b.type
  }
}
window.syncYmTokenFieldsFromCompact = syncYmTokenFieldsFromCompact
window.syncVkTokenFieldsFromCompact = syncVkTokenFieldsFromCompact

function mirrorTokenMsg(srcId, dstId) {
  const src = document.getElementById(srcId)
  const dst = document.getElementById(dstId)
  if (!src || !dst) return
  dst.textContent = src.textContent || ''
  dst.className = src.className || 'token-msg'
}

function applyYandexTokenFromCompact() {
  syncYmTokenFieldsFromCompact()
  applyYandexToken()
  mirrorTokenMsg('ym-msg', 'ym-msg-compact')
}
window.applyYandexTokenFromCompact = applyYandexTokenFromCompact

function checkYandexTokenFromCompact() {
  syncYmTokenFieldsFromCompact()
  void checkYandexToken().then(() => mirrorTokenMsg('ym-msg', 'ym-msg-compact')).catch(() => mirrorTokenMsg('ym-msg', 'ym-msg-compact'))
}
window.checkYandexTokenFromCompact = checkYandexTokenFromCompact

function applyVkTokenFromCompact() {
  syncVkTokenFieldsFromCompact()
  applyVkToken()
  mirrorTokenMsg('vk-msg', 'vk-msg-compact')
}
window.applyVkTokenFromCompact = applyVkTokenFromCompact

function checkVkTokenFromCompact() {
  syncVkTokenFieldsFromCompact()
  void checkVkToken().then(() => mirrorTokenMsg('vk-msg', 'vk-msg-compact')).catch(() => mirrorTokenMsg('vk-msg', 'vk-msg-compact'))
}
window.checkVkTokenFromCompact = checkVkTokenFromCompact

function toggleToken(id) {
  const inp = document.getElementById(id)
  if (inp) inp.type = inp.type === 'password' ? 'text' : 'password'
  if (id === 'ym-token-val-compact') {
    const main = document.getElementById('ym-token-val')
    if (main) main.type = inp.type
  }
  if (id === 'ym-token-val') {
    const c = document.getElementById('ym-token-val-compact')
    if (c) c.type = inp.type
  }
  if (id === 'vk-token-val-compact') {
    const main = document.getElementById('vk-token-val')
    if (main) main.type = inp.type
  }
  if (id === 'vk-token-val') {
    const c = document.getElementById('vk-token-val-compact')
    if (c) c.type = inp.type
  }
}

function switchSrcTab(tab) {
  ;['sc','vk','yt','sp'].forEach(t => {
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
    if (result.ok) {
      tokenField.value = result.token
      applyVkToken(result.token)
    } else {
      msg.textContent = result.error || 'Ошибка'
      msg.className = 'token-msg token-msg-err'
    }
  } catch (e) {
    msg.textContent = e.message
    msg.className = 'token-msg token-msg-err'
  }
  btn.textContent='Получить токен'; btn.disabled=false
}

function openVkHostTokenPage() {
  openUrl(VKHOST_TOKEN_PAGE)
}

async function checkVkToken() {
  const msg = document.getElementById('vk-msg')
  const token = getCurrentVkTokenForImport()
  if (!token) {
    if (msg) {
      msg.textContent = 'Вставь токен в поле ниже или нажми «сохранить» после вставки'
      msg.className = 'token-msg token-msg-err'
    }
    mirrorTokenMsg('vk-msg', 'vk-msg-compact')
    return
  }
  if (!window.api?.vkValidateToken) {
    if (msg) {
      msg.textContent = 'Проверка доступна только в Electron'
      msg.className = 'token-msg token-msg-err'
    }
    mirrorTokenMsg('vk-msg', 'vk-msg-compact')
    return
  }
  if (msg) {
    msg.textContent = 'Проверяю токен...'
    msg.className = 'token-msg'
  }
  try {
    const r = await window.api.vkValidateToken(token)
    if (r?.ok) {
      const who = [r.name, r.userId != null ? `id ${r.userId}` : ''].filter(Boolean).join(', ')
      if (r.audioOk) {
        let text = who ? `Токен рабочий (${who}).` : 'Токен рабочий.'
        text += ' Доступ к audio API есть — импорт и поиск по VK должны работать.'
        if (msg) {
          msg.textContent = text
          msg.className = 'token-msg token-msg-ok'
        }
      } else {
        if (r.audioMissingAudioScope) {
          let line = who
            ? `Профиль OK (${who}), но в токене нет доступа «Аудио» по данным VK. На экране входа нужно явно разрешить музыку/аудио (не только профиль).`
            : 'В токене по данным VK нет доступа «Аудио». Пройди вход заново и разреши аудио на экране VK ID.'
          if (msg) {
            msg.textContent = line
            msg.className = 'token-msg token-msg-err'
          }
          mirrorTokenMsg('vk-msg', 'vk-msg-compact')
          return
        }
        const ac = r.audioCode != null ? ` (код ${r.audioCode})` : ''
        const detail = r.audioError ? `: ${r.audioError}` : ''

        if (r.audioScopeOkButMethodsBlocked || Number(r.audioCode) === 3) {
          const maskHint = r.permissionMask != null && (Number(r.permissionMask) & 8) !== 0
            ? ' В маске прав VK бит «Аудио» есть — это не «не тот токен»: VK всё равно режет audio.* для части аккаунтов.'
            : ''
          let line = who
            ? `Профиль подтверждён (${who}). Официальные методы audio.* недоступны${ac}${detail}.${maskHint}`
            : `Официальные методы audio.* недоступны${ac}${detail}.${maskHint}`
          line += ' И новый токен Kate, и токен из веба при этом часто ведут себя одинаково — это ограничение VK, а не «испорченная вставка».'
          line += ' По умолчанию Nexory не открывает Chrome сам: если нужен обход через Chrome+Selenium (Python, selenium, webdriver-manager; профиль %LOCALAPPDATA%\\Nexory\\vk_chrome_profile), включи ниже «Обход через Chrome (Selenium)».'
          if (msg) {
            msg.textContent = line
            msg.className = 'token-msg token-msg-warn'
          }
          mirrorTokenMsg('vk-msg', 'vk-msg-compact')
          return
        }

        let line = who
          ? `Профиль подтверждён (${who}), но аудио в Nexory недоступно${ac}${detail}. На vkhost выбери Kate Mobile и право «Аудио».`
          : `Аудио API недоступно${ac}${detail}. На vkhost — Kate Mobile и право «Аудио».`
        if (Number(r.audioCode) === 6) {
          line += ' Код 6 — слишком много запросов к VK: подожди 30–60 секунд и нажми проверку снова; не кликай «Проверить токен» много раз подряд.'
        }
        if (msg) {
          msg.textContent = line
          msg.className = 'token-msg token-msg-err'
        }
      }
    } else if (msg) {
      const errText = r?.error || 'Токен не подходит'
      const withCode = r?.code != null ? `${errText} (код ${r.code})` : errText
      msg.textContent = withCode
      msg.className = 'token-msg token-msg-err'
    }
  } catch (e) {
    if (msg) {
      msg.textContent = e?.message || 'Ошибка проверки'
      msg.className = 'token-msg token-msg-err'
    }
  }
  mirrorTokenMsg('vk-msg', 'vk-msg-compact')
}

async function startVkBrowserAuth() {
  const msg = document.getElementById('vk-msg')
  if (!window.api?.vkBrowserAuth) {
    if (msg) {
      msg.textContent = 'Браузерная авторизация доступна только в Electron'
      msg.className = 'token-msg token-msg-err'
    }
    return
  }
  try {
    if (msg) {
      msg.textContent = 'Открыл окно VK. Войди и разреши доступ к аудио для импорта плейлистов.'
      msg.className = 'token-msg'
    }
    const result = await window.api.vkBrowserAuth()
    if (result?.ok && result?.token) {
      const tokenField = document.getElementById('vk-token-val')
      if (tokenField) tokenField.value = result.token
      applyVkToken(result.token)
      return
    }
    if (msg) {
      msg.textContent = result?.error || 'VK авторизация отменена'
      msg.className = 'token-msg token-msg-err'
    }
  } catch (e) {
    if (msg) {
      msg.textContent = e?.message || 'Не удалось открыть браузер'
      msg.className = 'token-msg token-msg-err'
    }
  }
}

function applyVkToken(token) {
  let t =
    token != null && String(token).trim() !== ''
      ? String(token).trim()
      : String(document.getElementById('vk-token-val-compact')?.value || '').trim() ||
        String(document.getElementById('vk-token-val')?.value || '').trim()
  if (!t) {
    showToast('Введи или вставь VK токен', true)
    const mEl = document.getElementById('vk-msg')
    if (mEl) {
      mEl.textContent = 'Поле токена пустое'
      mEl.className = 'token-msg token-msg-err'
    }
    mirrorTokenMsg('vk-msg', 'vk-msg-compact')
    return
  }
  const extracted = t.match(/access_token=([^&]+)/)
  if (extracted) t = extracted[1]
  saveSettingsRaw({ vkToken: t })
  const field = document.getElementById('vk-token-val')
  if (field) field.value = t
  const compact = document.getElementById('vk-token-val-compact')
  if (compact) {
    compact.value = t
    compact.type = field?.type || compact.type
  }
  updateVkStatus(t)
  showToast('VK токен сохранен')
  if (window.api?.vkValidateToken) void checkVkToken().catch(() => {})
  mirrorTokenMsg('vk-msg', 'vk-msg-compact')
}

function getCurrentVkTokenForImport() {
  const fieldToken =
    String(document.getElementById('vk-token-val-compact')?.value || '').trim() ||
    String(document.getElementById('vk-token-val')?.value || '').trim()
  let token = fieldToken || String(getSettings().vkToken || '').trim()
  const m = token.match(/access_token=([^&]+)/)
  if (m) token = m[1]
  if (token && token !== getSettings().vkToken) {
    saveSettingsRaw({ vkToken: token })
    updateVkStatus(token)
  }
  return token
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
  let token =
    String(document.getElementById('ym-token-val-compact')?.value || '').trim() ||
    String(document.getElementById('ym-token-val')?.value || '').trim()
  const msg = document.getElementById('ym-msg')
  const m = token.match(/access_token=([^&#]+)/)
  if (m) token = decodeURIComponent(m[1])
  if (!token) {
    if (msg) { msg.textContent = 'Вставь access_token или полный redirect URL после OAuth-входа'; msg.className = 'token-msg token-msg-err' }
    mirrorTokenMsg('ym-msg', 'ym-msg-compact')
    showToast('Введи токен Яндекс Музыки', true)
    return
  }
  saveSettingsRaw({ yandexToken: token })
  const main = document.getElementById('ym-token-val')
  const compact = document.getElementById('ym-token-val-compact')
  if (main) main.value = token
  if (compact) {
    compact.value = token
    compact.type = main?.type || compact.type
  }
  updateYandexStatus(token)
  if (msg) { msg.textContent = 'Токен сохранен. Теперь можно импортировать плейлисты Яндекс Музыки по ссылке.'; msg.className = 'token-msg token-msg-ok' }
  mirrorTokenMsg('ym-msg', 'ym-msg-compact')
  showToast('Токен Яндекс Музыки сохранен')
}

function openYandexTokenGuide() {
  openUrl(YANDEX_MUSIC_TOKEN_GUIDE_URL)
}

function openYandexOAuthTokenPage() {
  openUrl(YANDEX_MUSIC_OAUTH_URL)
}

async function checkYandexToken() {
  const msg = document.getElementById('ym-msg')
  let tok =
    String(document.getElementById('ym-token-val-compact')?.value || '').trim() ||
    String(document.getElementById('ym-token-val')?.value || '').trim() ||
    String(getSettings().yandexToken || '').trim()
  const m = tok.match(/access_token=([^&#]+)/)
  if (m) tok = decodeURIComponent(m[1])
  tok = String(tok || '').trim()
  if (!tok) {
    if (msg) {
      msg.textContent = 'Вставь токен или сохрани его галочкой выше'
      msg.className = 'token-msg token-msg-err'
    }
    mirrorTokenMsg('ym-msg', 'ym-msg-compact')
    return
  }
  if (!window.api?.yandexValidateToken) {
    if (msg) {
      msg.textContent = 'Проверка доступна только в Electron'
      msg.className = 'token-msg token-msg-err'
    }
    mirrorTokenMsg('ym-msg', 'ym-msg-compact')
    return
  }
  if (msg) {
    msg.textContent = 'Проверяю токен...'
    msg.className = 'token-msg'
  }
  try {
    const r = await window.api.yandexValidateToken(tok)
    if (r?.ok) {
      if (msg) {
        msg.textContent = r.login ? `Токен рабочий (аккаунт: ${r.login}).` : 'Токен рабочий.'
        msg.className = 'token-msg token-msg-ok'
      }
    } else if (msg) {
      msg.textContent = r?.error || 'Токен не подходит'
      msg.className = 'token-msg token-msg-err'
    }
  } catch (e) {
    if (msg) {
      msg.textContent = e?.message || 'Ошибка проверки'
      msg.className = 'token-msg token-msg-err'
    }
  }
  mirrorTokenMsg('ym-msg', 'ym-msg-compact')
}

function updateYandexStatus(token) {
  const el = document.getElementById('ym-status')
  if (!el) return
  const display = document.getElementById('ym-active-display')
  const text = document.getElementById('ym-status-text')
  const sub = document.getElementById('ym-status-sub')
  if (token) {
    el.className = 'token-status token-ok'
    if (text) text.textContent = 'Настроен'
    if (sub) sub.textContent = 'OAuth token сохранен, импорт Яндекс плейлистов доступен'
    if (display) { display.textContent = token.slice(0, 6) + '****' + token.slice(-4); display.style.display = 'block' }
  } else {
    el.className = 'token-status'
    if (text) text.textContent = 'Не настроен'
    if (sub) sub.textContent = 'Нужен OAuth token для чтения плейлистов'
    if (display) display.style.display = 'none'
  }
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
  const raw = String(src || '').toLowerCase()
  let normalized =
    raw === 'yt' || raw === 'youtube' ? 'hybrid' :
    raw === 'sc' ? 'soundcloud' :
    raw === 'hm' || raw === 'hitmo' ? 'hybrid' :
    raw === 'ya' || raw === 'ym' ? 'yandex' :
    raw === 'vkontakte' ? 'vk' :
    raw
  if (!ALLOWED_ACTIVE_SOURCES.has(normalized)) normalized = 'hybrid'
  saveSettingsRaw({ activeSource: normalized })
  searchCache.clear()
  try {
    syncSearchSourceRows()
    syncAuthSourceStackActive()
    syncSearchSourcePills()
    updateSourceBadge()
    if (typeof syncHomeNxSourceLogo === 'function') syncHomeNxSourceLogo()
  } catch (_) {}
}

function syncVkSeleniumBridgeToggle() {
  const el = document.getElementById('toggle-vk-selenium-bridge')
  if (el) el.classList.toggle('active', Boolean(getSettings().vkSeleniumBridge))
}

function toggleVkSeleniumBridgeSetting() {
  const cur = getSettings()
  saveSettingsRaw({ vkSeleniumBridge: !Boolean(cur.vkSeleniumBridge) })
  syncVkSeleniumBridgeToggle()
}
window.toggleVkSeleniumBridgeSetting = toggleVkSeleniumBridgeSetting

function loadSettingsPage() {
  const s = getSettings()
  const ids = { 'sc-custom-val': s.soundcloudClientId, 'vk-token-val': s.vkToken, 'sp-token-val': s.spotifyToken, 'ym-token-val': s.yandexToken }
  for (const [id, val] of Object.entries(ids)) { const el = document.getElementById(id); if (el && val) el.value = val }
  syncYmTokenFieldsFromMain()
  syncVkTokenFieldsFromMain()
  mirrorTokenMsg('ym-msg', 'ym-msg-compact')
  mirrorTokenMsg('vk-msg', 'vk-msg-compact')
  updateScStatus(s.soundcloudClientId)
  updateVkStatus(s.vkToken)
  syncVkSeleniumBridgeToggle()
  updateSpotifyStatus(s.spotifyToken)
  updateYandexStatus(s.yandexToken)
  // Keep settings opening snappy; run heavier sync in next frame.
  requestAnimationFrame(() => {
    syncPlaybackModeUI()
    syncTrackCoverStatus()
    syncFontControls()
    syncHomeWidgetUI()
    applyHomeSliderStyle()
    applyCompactUi()
    switchSettingsCategory(_settingsCategory)
    applyOptimizationSettings()
    applyMediaQueueLayout()
    syncMediaMetaAlignUI()
    syncMediaPlayerBarModeUI()
    syncSearchSourceRows()
    syncAuthSourceStackActive()
    updateSourceBadge()
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
  const pmSh = document.getElementById('pm-shuffle-btn')
  if (pmSh) pmSh.classList.toggle('active', Boolean(playbackMode.shuffle))
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
  const pmRp = document.getElementById('pm-repeat-pm-btn')
  if (pmRp) {
    pmRp.classList.toggle('active', playbackMode.repeat !== 'off')
    pmRp.title = `Повтор: ${repeatLabel}`
  }
  if (homeRpBtn) {
    homeRpBtn.classList.toggle('active', playbackMode.repeat !== 'off')
    homeRpBtn.title = `Повтор: ${repeatLabel}`
  }
  if (rpSettings) {
    rpSettings.textContent = repeatLabel
    rpSettings.classList.toggle('active', playbackMode.repeat !== 'off')
  }
  const repeatLucide = playbackMode.repeat === 'one' ? 'repeat-1' : 'repeat'
  ;['repeat-btn', 'home-repeat-btn', 'pm-repeat-pm-btn'].forEach((id) => {
    const btn = document.getElementById(id)
    const svg = btn?.querySelector?.('svg[data-lucide]')
    if (svg) {
      svg.setAttribute('data-lucide', repeatLucide)
      if (typeof hydrateFlowLucideIcons === 'function') hydrateFlowLucideIcons(btn)
    }
  })
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

async function setCustomTrackCover(input) {
  const file = input?.files?.[0]
  if (!file) return
  if (!currentTrack) {
    showToast('Сначала включи трек', true)
    input.value = ''
    return
  }
  try {
    const keys = getTrackCoverKeys(currentTrack)
    const map = getCustomCoverMap()
    const value = await saveCustomMediaFile(file, 'track-cover')
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
  } catch (err) {
    showToast(`Не удалось сохранить обложку: ${sanitizeDisplayText(err?.message || err)}`, true)
  } finally {
    input.value = ''
  }
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

function guessExtFromMime(m) {
  const t = String(m || '').toLowerCase()
  if (t.includes('png')) return '.png'
  if (t.includes('webp')) return '.webp'
  if (t.includes('gif')) return '.gif'
  if (t.includes('jpeg') || t.includes('jpg')) return '.jpg'
  return '.bin'
}

async function mirrorRemoteUrlToCustomGallery(url, purpose) {
  const u = String(url || '').trim()
  if (!u) return ''
  if (/^file:\/\//i.test(u)) return u
  if (!/^https?:|^data:/i.test(u)) return u
  try {
    const res = await fetch(u, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' })
    if (!res.ok) return u
    const blob = await res.blob()
    if (!blob || !blob.size) return u
    const ext = guessExtFromMime(blob.type)
    const file = new File([blob], `preset-${purpose}-${Date.now()}${ext}`, {
      type: blob.type || 'application/octet-stream',
    })
    return await saveCustomMediaFile(file, purpose)
  } catch (_) {
    return u
  }
}

/** После импорта пресета: http(s)/data URL фона и виджета копируются в папку галереи и переписываются на file://. */
async function mirrorPresetVisualUrlsToGallery() {
  const v0 = getVisual()
  const patch = {}
  if (v0.bgType === 'custom' && v0.customBg && /^https?:|^data:/i.test(String(v0.customBg))) {
    const nu = await mirrorRemoteUrlToCustomGallery(v0.customBg, 'background')
    if (nu && nu !== v0.customBg) patch.customBg = nu
  }
  const hw = Object.assign({ enabled: true, mode: 'bars', image: null, intensity: 100, smoothing: 72 }, v0.homeWidget || {})
  if (hw.image && /^https?:|^data:/i.test(String(hw.image))) {
    const nu = await mirrorRemoteUrlToCustomGallery(hw.image, 'home-widget')
    if (nu && nu !== hw.image) {
      patch.homeWidget = Object.assign({}, hw, { image: nu })
      if (hw.mode === 'image' || patch.homeWidget.mode === 'image') patch.homeWidget.mode = 'image'
    }
  }
  if (Object.keys(patch).length) {
    saveVisual(patch)
    _flowVisualMemo = null
  }
}

async function mirrorHttpUrlsInCustomCoverMap() {
  const map = getCustomCoverMap()
  const next = { ...map }
  let changed = false
  const keys = Object.keys(next)
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    const v = next[k]
    if (v == null || typeof v !== 'string') continue
    const t = v.trim()
    if (!/^https?:|^data:/i.test(t)) continue
    try {
      const nu = await mirrorRemoteUrlToCustomGallery(t, 'track-cover')
      if (nu && nu !== t) {
        next[k] = nu
        changed = true
      }
    } catch (_) {}
  }
  if (changed) {
    saveCustomCoverMap(next)
    try {
      _coverLoadState.clear()
    } catch (_) {}
  }
}

function setFlowConfigStatus(_text, _isError = false) {
  /* Статус под карточкой пресета убран из UI — оставлена заглушка для совместимости. */
}

function collectFlowConfigPayload() {
  const storage = {}
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key || !key.startsWith('flow_')) continue
    storage[key] = localStorage.getItem(key)
  }
  return {
    format: 'flow-preset-v1',
    app: 'Nexory',
    exportedAt: new Date().toISOString(),
    storage,
  }
}

async function presetEmbedInvoke(fileUrl) {
  try {
    if (typeof window.api?.presetEmbedMedia === 'function') {
      return await window.api.presetEmbedMedia(fileUrl)
    }
  } catch {}
  return { ok: false, dataUrl: '' }
}

async function embedOneFileUrl(fileUrl, cache, embedInvoke, failedEmbed) {
  const t = String(fileUrl || '').trim()
  if (!/^file:\/\//i.test(t)) return fileUrl
  if (cache.has(t)) return cache.get(t)
  const res = await embedInvoke(t)
  const ok = !!(res && res.ok && res.dataUrl)
  const replacement = ok ? res.dataUrl : fileUrl
  if (!ok) failedEmbed?.push?.(t)
  cache.set(t, replacement)
  return replacement
}

async function embedFileUrlsDeep(value, embedInvoke, cache, failedEmbed) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    const t = String(value).trim()
    if (/^file:\/\//i.test(t)) {
      return await embedOneFileUrl(t, cache, embedInvoke, failedEmbed)
    }
    return value
  }
  if (Array.isArray(value)) {
    const out = []
    for (let i = 0; i < value.length; i++) out.push(await embedFileUrlsDeep(value[i], embedInvoke, cache, failedEmbed))
    return out
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value)
    const out = {}
    for (let j = 0; j < keys.length; j++) {
      const k = keys[j]
      out[k] = await embedFileUrlsDeep(value[k], embedInvoke, cache, failedEmbed)
    }
    return out
  }
  return value
}

async function portableizePresetStorage(rawStorage, embedInvoke = presetEmbedInvoke) {
  if (!rawStorage || typeof rawStorage !== 'object') return { storage: rawStorage || {}, failedEmbed: [] }
  const cache = new Map()
  const failedEmbed = []
  const storage = {}
  const keysList = Object.keys(rawStorage)
  for (let i = 0; i < keysList.length; i++) {
    const key = keysList[i]
    const raw = rawStorage[key]
    const sv = raw == null ? '' : String(raw)
    if (!sv) {
      storage[key] = sv
      continue
    }
    const trimmed = sv.trim()
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        const parsed = JSON.parse(sv)
        const embedded = await embedFileUrlsDeep(parsed, embedInvoke, cache, failedEmbed)
        storage[key] = JSON.stringify(embedded)
        continue
      } catch {
        /** fallthrough to plain-string handling */
      }
    }
    if (/^file:\/\//i.test(trimmed)) {
      storage[key] = await embedOneFileUrl(trimmed, cache, embedInvoke, failedEmbed)
    } else {
      storage[key] = sv
    }
  }
  return { storage, failedEmbed }
}

async function exportFlowConfig() {
  try {
    const basePayload = collectFlowConfigPayload()
    const { storage, failedEmbed } = await portableizePresetStorage(basePayload.storage)
    const payload = { ...basePayload, storage }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const stamp = new Date().toISOString().slice(0, 10)
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `flow-preset-${stamp}.flowpreset`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(link.href)
    showToast('Nexory preset экспортирован')
    if (failedEmbed && failedEmbed.length) {
      showToast(
        `Не удалось встроить ${failedEmbed.length} файл(ов) с диска — на другом ПК их не будет.`,
        true
      )
    }
  } catch (err) {
    showToast(`Не удалось экспортировать preset: ${err?.message || err}`, true)
  }
}

function pickFlowConfigFile() {
  const input = document.getElementById('flow-config-input')
  if (!input) return
  input.click()
}

/**
 * Импорт .flowpreset / dotify: только внешний вид — подмешиваем в текущий `flow_visual` поля
 * bgType, customBg, gifMode, glass, panelBlur, homeWidget и при наличии `flow_track_covers`.
 * Размытие, яркость и прозрачность стекла (blur, bright, glass) из файла не применяются — остаются текущие значения пользователя.
 * Остальные ключи localStorage не меняем (сессия, источники, тема UI и т.д.).
 */
function applyPresetAppearanceOnly(storage) {
  if (!storage || typeof storage !== 'object') return { appliedVisual: false, appliedCovers: false }

  const incomingStr = storage.flow_visual
  let incoming = {}
  if (incomingStr != null && String(incomingStr).trim()) {
    try {
      incoming = JSON.parse(String(incomingStr))
    } catch {
      incoming = {}
    }
    if (!incoming || typeof incoming !== 'object') incoming = {}
  }

  const cur = getVisual()
  const patch = {}

  if (Object.prototype.hasOwnProperty.call(incoming, 'panelBlur')) {
    const n = Number(incoming.panelBlur)
    if (Number.isFinite(n)) patch.panelBlur = Math.max(0, Math.min(60, n))
  }
  if (Object.prototype.hasOwnProperty.call(incoming, 'bgType')) {
    const t = String(incoming.bgType || '')
    if (t === 'gradient' || t === 'cover' || t === 'custom') patch.bgType = t
  }
  if (Object.prototype.hasOwnProperty.call(incoming, 'customBg')) {
    patch.customBg =
      incoming.customBg == null || incoming.customBg === '' ? null : String(incoming.customBg)
    if (patch.customBg && !patch.bgType) patch.bgType = 'custom'
  }
  if (Object.prototype.hasOwnProperty.call(incoming, 'gifMode') && incoming.gifMode && typeof incoming.gifMode === 'object') {
    const g = incoming.gifMode
    const base = Object.assign({ bg: true, track: true, playlist: true }, cur.gifMode || {})
    patch.gifMode = Object.assign({}, base, {
      bg: typeof g.bg === 'boolean' ? g.bg : base.bg,
      track: typeof g.track === 'boolean' ? g.track : base.track,
      playlist: typeof g.playlist === 'boolean' ? g.playlist : base.playlist,
    })
  }
  if (Object.prototype.hasOwnProperty.call(incoming, 'homeWidget') && incoming.homeWidget && typeof incoming.homeWidget === 'object') {
    const hw = incoming.homeWidget
    const base = Object.assign(
      { enabled: true, mode: 'bars', image: null, intensity: 100, smoothing: 72 },
      cur.homeWidget || {},
    )
    patch.homeWidget = Object.assign({}, base)
    if (typeof hw.enabled === 'boolean') patch.homeWidget.enabled = hw.enabled
    const mode = String(hw.mode || '')
    if (mode === 'image' || mode === 'bars' || mode === 'liquid' || mode === 'wave') {
      patch.homeWidget.mode = normalizeHomeWidgetMode(mode)
    }
    if (hw.image != null && String(hw.image).trim() !== '') patch.homeWidget.image = String(hw.image)
    const inten = Number(hw.intensity)
    if (Number.isFinite(inten)) patch.homeWidget.intensity = Math.max(60, Math.min(180, inten))
    const sm = Number(hw.smoothing)
    if (Number.isFinite(sm)) patch.homeWidget.smoothing = Math.max(20, Math.min(95, sm))
  }

  const hasCoversKey =
    Object.prototype.hasOwnProperty.call(storage, 'flow_track_covers') && storage.flow_track_covers != null

  let appliedVisual = false
  if (Object.keys(patch).length) {
    _flowVisualMemo = null
    localStorage.setItem('flow_visual', JSON.stringify(Object.assign({}, cur, patch)))
    appliedVisual = true
  }

  let appliedCovers = false
  if (hasCoversKey) {
    localStorage.setItem('flow_track_covers', String(storage.flow_track_covers))
    appliedCovers = true
  }

  return { appliedVisual, appliedCovers }
}

/** После импорта .flowpreset — карточка «сохранённый вид» с текущим экраном, чтобы сразу было видно заполненный превью-ряд. */
function pushCustomizationSnapshotAfterFlowpresetImport() {
  try {
    const snap = collectCurrentCustomizationSnapshot()
    const list = getCustomizationPresets()
    const entry = { id: newCustomizationPresetId(), ts: Date.now(), ...snap }
    saveCustomizationPresetsList([entry, ...list].slice(0, CUST_PRESETS_CAP))
  } catch (_) {}
}

/** После записи ключей пресета в localStorage подтянуть in-memory состояние и не затирать flow_visual ползунками формы. */
function syncRuntimeCachesAfterPresetImport() {
  try {
    playbackMode = Object.assign({}, defaultPlayback, JSON.parse(localStorage.getItem('flow_playback_mode') || '{}'))
  } catch {
    playbackMode = { ...defaultPlayback }
  }
  try {
    _myWaveMode = localStorage.getItem('flow_my_wave_mode') || 'default'
  } catch {}
  try {
    const s = getSettings()
    currentSource = s.activeSource || 'hybrid'
    updateSourceBadge()
    syncSearchSourcePills()
    applyCompactUi()
    try {
      applyOptimizationSettings()
    } catch (_) {}
    try {
      const s = getSettings()
      if (s.flowSocialApiBase) localStorage.setItem('flow_social_api_base', String(s.flowSocialApiBase).trim().replace(/\/$/, ''))
      if (s.flowSocialApiSecret) localStorage.setItem('flow_social_api_secret', String(s.flowSocialApiSecret).trim())
      window.FlowSocialBackend?.invalidate?.()
    } catch (_) {}
  } catch {}
}

function importFlowConfigFile(input) {
  const file = input?.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = async () => {
    try {
      const parsed = JSON.parse(String(reader.result || '{}'))
      const preset = normalizeImportedFlowPreset(parsed)
      const storage = preset?.storage
      if (!storage || typeof storage !== 'object') {
        throw new Error('Неверный формат файла')
      }
      const { appliedVisual, appliedCovers } = applyPresetAppearanceOnly(storage)
      if (!appliedVisual && !appliedCovers) {
        throw new Error('В файле нет данных о фоне, обложках или виджете')
      }
      syncRuntimeCachesAfterPresetImport()
      try {
        await mirrorPresetVisualUrlsToGallery()
      } catch (_) {}
      try {
        await mirrorHttpUrlsInCustomCoverMap()
      } catch (_) {}
      try {
        pushCustomizationSnapshotAfterFlowpresetImport()
      } catch (_) {}
      showToast('Внешний вид применён; в «Сохранённые виды» добавлена карточка текущего экрана')
      try {
        switchSettingsCategory('customization')
      } catch (_) {}
      try {
        refreshCustomizationPanel()
      } catch (_) {}
      try { applySettingsSectionsState() } catch {}
      // Важно: не вызывать applyVisualSettings() — она берёт значения из DOM и перезаписывает только что импортированный flow_visual.
      try { initVisualSettings() } catch {}
      try { updateBackground() } catch {}
      try { syncIntegrationsUI() } catch {}
      try { applyUiTextOverrides() } catch {}
      requestAnimationFrame(() => {
        try { syncPlaybackModeUI() } catch {}
        try { syncTrackCoverStatus() } catch {}
        try { syncFontControls() } catch {}
      })
      try { renderPlaylists() } catch {}
      try { syncProfileUi() } catch {}
      try { renderFriends().catch(() => {}) } catch {}
      try { pollFriendsPresence(true).catch(() => {}) } catch {}
    } catch (err) {
      showToast(`Ошибка импорта: ${err?.message || err}`, true)
    } finally {
      input.value = ''
    }
  }
  reader.readAsText(file)
}

function normalizeImportedFlowPreset(parsed) {
  if ((parsed?.format === 'flow-preset-v1' || parsed?.format === 'flow-config-v1') && parsed?.storage && typeof parsed.storage === 'object') {
    return { storage: parsed.storage, replaceAll: true }
  }
  if (parsed?.data && typeof parsed.data === 'object') {
    return { storage: convertDotifyPresetToFlowStorage(parsed), replaceAll: false }
  }
  return null
}

function convertDotifyPresetToFlowStorage(preset) {
  const data = preset?.data || {}
  const ui = data.uiSettings || data.ui || {}
  const gifs = data.gifs || {}
  const visual = Object.assign({}, defaultVisual)

  /** Dotify ≥ новый формат: gifSettings — объект с ключами "0","1",… или массив; у каждого usage: background | cover | visualizer | … */
  const gifList = []
  const rawGifSettings = data.gifSettings
  if (rawGifSettings && typeof rawGifSettings === 'object') {
    if (Array.isArray(rawGifSettings)) {
      for (let i = 0; i < rawGifSettings.length; i++) if (rawGifSettings[i]) gifList.push(rawGifSettings[i])
    } else {
      Object.keys(rawGifSettings)
        .filter((k) => /^\d+$/.test(k))
        .sort((a, b) => Number(a) - Number(b))
        .forEach((k) => {
          const it = rawGifSettings[k]
          if (it && typeof it === 'object') gifList.push(it)
        })
    }
  }

  let coverUrl = ''
  for (let i = 0; i < gifList.length; i++) {
    const item = gifList[i]
    const usage = String(item.usage || '').toLowerCase()
    const url = item.url != null ? String(item.url).trim() : ''
    if (!url) continue
    if (usage === 'background') {
      visual.bgType = 'custom'
      visual.customBg = url
    } else if (usage === 'cover') {
      coverUrl = url
    } else if (usage === 'visualizer') {
      visual.homeWidget = Object.assign(
        { enabled: true, mode: 'image', image: null, intensity: 100, smoothing: 72 },
        visual.homeWidget || {},
        { enabled: true, mode: 'image', image: url },
      )
    }
  }

  if (!visual.customBg && gifs.background) {
    visual.bgType = 'custom'
    visual.customBg = String(gifs.background)
  }
  if (!(visual.homeWidget && visual.homeWidget.image) && gifs.visualizer) {
    visual.homeWidget = Object.assign(
      { enabled: true, mode: 'image', image: null, intensity: 100, smoothing: 72 },
      visual.homeWidget || {},
      { enabled: true, mode: 'image', image: String(gifs.visualizer) },
    )
  } else if (!gifList.length && ui.visualization?.style === 'wave') {
    visual.homeWidget = Object.assign(
      { enabled: true, mode: 'bars', image: null, intensity: 100, smoothing: 72 },
      visual.homeWidget || {},
      { enabled: true, mode: 'wave' },
    )
  }
  if (!coverUrl && gifs.cover) coverUrl = String(gifs.cover)

  const transparency = ui.transparency || {}
  if (transparency.glass && typeof transparency.glass === 'object') {
    const gBlur = Number(transparency.glass.blur)
    const strength = Number(transparency.glass.strength)
    if (Number.isFinite(gBlur)) {
      visual.panelBlur = Math.max(0, Math.min(60, gBlur))
      visual.blur = Math.max(0, Math.min(80, Math.round(gBlur * 6)))
    }
    if (Number.isFinite(strength)) {
      visual.glass =
        strength > 0 && strength <= 1
          ? Math.max(0, Math.min(40, Math.round(strength * 40)))
          : Math.max(0, Math.min(40, strength))
    }
  }
  const op = Number(transparency.opacity)
  if (Number.isFinite(op)) {
    visual.bright = Math.max(10, Math.min(100, Math.round(25 + (op / 100) * 70)))
  }

  const scaleRaw = ui.scale
  let scale = NaN
  if (typeof scaleRaw === 'number') scale = scaleRaw
  else if (Array.isArray(scaleRaw?.default)) scale = Number(scaleRaw.default[0])
  else scale = Number(scaleRaw?.default)
  if (Number.isFinite(scale)) visual.uiScale = Math.max(80, Math.min(130, scale))

  if (ui.tabs === 'top' || ui.tabs?.position === 'top') visual.sidebarPosition = 'top'
  else if (ui.tabs === 'bottom' || ui.tabs?.position === 'bottom') visual.sidebarPosition = 'bottom'
  else if (ui.tabs === 'right' || ui.tabs?.position === 'right') visual.sidebarPosition = 'right'
  if (ui.customfont?.family) visual.customFontName = String(ui.customfont.family)

  const storage = { flow_visual: JSON.stringify(visual) }
  if (coverUrl) storage.flow_track_covers = JSON.stringify({ __global__: coverUrl })
  return storage
}

function updateSourceBadge() {
  const raw = normalizeStoredActiveSource(getSettings()?.activeSource || currentSource || 'hybrid')
  currentSource = raw
  let txt = 'Spotify → SoundCloud → Audius'
  if (raw === 'yandex') txt = 'Яндекс Музыка'
  else if (raw === 'vk') txt = 'ВКонтакте'
  else if (raw === 'spotify') txt = 'Spotify'
  else if (raw === 'soundcloud') txt = 'SoundCloud'
  else if (raw === 'audius') txt = 'Audius'
  const b1 = document.getElementById('source-badge'); if (b1) b1.textContent = txt
  const b2 = document.getElementById('source-badge-search'); if (b2) b2.textContent = txt
}

function syncSearchSourceRows() {
  const resolved = normalizeStoredActiveSource(getSettings()?.activeSource || 'hybrid')
  const sel =
    '#page-search .source-mode-grid .source-mode-card[data-src="hybrid"], ' +
    '#page-search .source-mode-grid .source-mode-card[data-src="yandex"], ' +
    '#page-search .source-mode-grid .source-mode-card[data-src="vk"]'
  document.querySelectorAll(sel).forEach((btn) => {
    const ds = String(btn.getAttribute('data-src') || '')
    btn.classList.toggle('active', ds === resolved)
  })
}

function syncAuthSourceStackActive() {
  const resolved = normalizeStoredActiveSource(getSettings()?.activeSource || 'hybrid')
  const stack = document.getElementById('auth-source-stack')
  if (!stack) return
  stack.querySelectorAll('.auth-source-tile.source-mode-card[data-src]').forEach((btn) => {
    const ds = String(btn.getAttribute('data-src') || '')
    if (!ds || ds === 'spotify-dev') return
    btn.classList.toggle('active', ds === resolved)
  })
}

function getSearchActiveSource(settings = getSettings()) {
  const img = document.getElementById('search-src-logo')
  const fromUi = img?.getAttribute('data-search-src')
  if (fromUi) return normalizeStoredActiveSource(fromUi)
  return normalizeStoredActiveSource(settings?.activeSource || currentSource || 'hybrid')
}
window.getSearchActiveSource = getSearchActiveSource

function getSearchSourceLabelBySrc(src) {
  const s = normalizeStoredActiveSource(src)
  if (s === 'yandex') return 'Яндекс Музыка'
  if (s === 'vk') return 'ВКонтакте'
  if (s === 'youtube' || s === 'yt') return 'YouTube'
  return 'Classic'
}
window.getSearchSourceLabelBySrc = getSearchSourceLabelBySrc

function switchSearchSource(src) {
  const raw = String(src || 'hybrid').toLowerCase()
  const normalized =
    raw === 'yandex' || raw === 'ya' || raw === 'ym'
      ? 'yandex'
      : raw === 'vk' || raw === 'vkontakte'
        ? 'vk'
        : 'hybrid'
  setActiveSource(normalized)
  const msg =
    normalized === 'yandex'
      ? 'Источник: Яндекс Музыка (нужен токен в Настройках → Источники)'
      : normalized === 'vk'
        ? 'Источник: ВКонтакте (токен Kate / OAuth в Настройках → Источники)'
        : 'Источник: классический поиск (Spotify → SoundCloud → Audius)'
  showToast(msg)
  try {
    if (typeof searchTracks === 'function' && String(document.getElementById('search-input')?.value || '').trim()) searchTracks()
  } catch (_) {}
}

function syncSearchSourcePills() {
  syncSearchSourceRows()
  document.querySelectorAll('.search-source-pill').forEach(p => {
    const resolved = normalizeStoredActiveSource(getSettings()?.activeSource || 'hybrid')
    p.classList.toggle('active', p.getAttribute('data-src') === resolved)
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

function setAuthScreensAuthorized(isAuthorized) {
  const loggedIn = Boolean(isAuthorized)
  document.getElementById('screen-auth')?.classList.toggle('hidden', loggedIn)
  document.getElementById('screen-main')?.classList.toggle('hidden', !loggedIn)
  // Hide the bottom player panel before login/register.
  document.getElementById('player-bar')?.classList.toggle('hidden', !loggedIn)
  if (loggedIn) queueMicrotask(() => scheduleMainShiftRemeasure())
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
  const defaults = { bio: '', avatarData: null, bannerData: null, profileColor: '', thoughtBubble: '', pinnedTracks: [], pinnedPlaylists: [] }
  if (!_profile?.username) return defaults
  const key = `flow_profile_custom_${_profile.username}`
  try {
    return Object.assign({}, defaults, JSON.parse(localStorage.getItem(key) || '{}'))
  } catch {
    return defaults
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
    profileColor: custom.profileColor || '',
    bio: custom.bio || '',
    stats: getListenStats(),
    pinnedTracks: Array.isArray(custom.pinnedTracks) ? custom.pinnedTracks.slice(0, 5) : [],
    pinnedPlaylists: Array.isArray(custom.pinnedPlaylists) ? custom.pinnedPlaylists.slice(0, 5) : [],
  }
}

let _flowSocialProfileSyncTimer = null
let _profileCloudPresenceTimer = null

function startProfileCloudPresenceHeartbeat() {
  stopProfileCloudPresenceHeartbeat()
  if (!ensureActiveProfile()?.username) return
  syncProfileCloudNow().catch(() => {})
  _profileCloudPresenceTimer = setInterval(() => {
    syncProfileCloudNow().catch(() => {})
  }, 25000)
}

function stopProfileCloudPresenceHeartbeat() {
  if (_profileCloudPresenceTimer) {
    clearInterval(_profileCloudPresenceTimer)
    _profileCloudPresenceTimer = null
  }
}

function isFlowSocialReady() {
  return typeof window.FlowSocialBackend?.isConfigured === 'function' && window.FlowSocialBackend.isConfigured()
}

async function flowSocialGet(path) {
  if (!isFlowSocialReady()) return null
  try {
    return await window.FlowSocialBackend.request('GET', path)
  } catch {
    return null
  }
}

async function flowSocialPut(path, body) {
  if (!isFlowSocialReady()) throw new Error('no social backend')
  return window.FlowSocialBackend.request('PUT', path, body)
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
    const data = await flowSocialGet(`/flow-api/v1/profile-public/${encodeURIComponent(safe)}`)
    if (!data?.username) return null
    const hasOwn = Object.prototype.hasOwnProperty
    const hasAvatar = hasOwn.call(data, 'avatar_data') || hasOwn.call(data, 'avatarData')
    const hasBanner = hasOwn.call(data, 'banner_data') || hasOwn.call(data, 'bannerData')
    return {
      username: String(data.username || safe),
      avatarData: hasAvatar ? (data.avatar_data ?? data.avatarData ?? null) : null,
      bannerData: hasBanner ? (data.banner_data ?? data.bannerData ?? null) : null,
      profileColor: data.profile_color || data.profileColor || '',
      bio: data.bio || '',
      pinnedTracks: Array.isArray(data.pinned_tracks) ? data.pinned_tracks.slice(0, 5) : (Array.isArray(data.pinnedTracks) ? data.pinnedTracks.slice(0, 5) : []),
      pinnedPlaylists: Array.isArray(data.pinned_playlists) ? data.pinned_playlists.slice(0, 5) : (Array.isArray(data.pinnedPlaylists) ? data.pinnedPlaylists.slice(0, 5) : []),
      stats: {
        totalTracks: Number(data.total_tracks ?? data.totalTracks ?? 0),
        totalSeconds: Number(data.total_seconds ?? data.totalSeconds ?? 0),
      }
    }
  } catch {
    return null
  }
}

async function fetchCloudFriendsForUser(username) {
  const safe = String(username || '').trim().toLowerCase()
  if (!safe) return []
  try {
    const data = await flowSocialGet(`/flow-api/v1/friends/${encodeURIComponent(safe)}`)
    if (!Array.isArray(data)) return []
    const out = data
      .map((row) => String(row?.friend_username || '').trim().toLowerCase())
      .filter(Boolean)
    return Array.from(new Set(out)).slice(0, 50)
  } catch {
    return []
  }
}

async function refreshFriendProfileFromCloud(username, force = false) {
  const safe = String(username || '').trim().toLowerCase()
  if (!safe) return null
  const now = Date.now()
  const lastPullAt = Number(_friendProfileRefreshAt.get(safe) || 0)
  // Только интервал между запросами: старый PROFILE_CACHE_TTL по updatedAt блокировал
  // подтягивание новых аватаров/баннеров до ~60 с, пока не придёт WS-пуш (при degraded — никогда).
  if (!force && (now - lastPullAt) < FRIEND_PROFILE_REFRESH_MS) return null
  _friendProfileRefreshAt.set(safe, now)
  const cloud = await fetchCloudPublicProfile(safe).catch(() => null)
  if (!cloud) return null
  const knownPeerId = `flow-${safe}`
  const merged = mergeProfileData(
    _peerProfiles.get(knownPeerId) || getCachedPeerProfile(safe),
    Object.assign({}, cloud, { peerId: knownPeerId }),
    knownPeerId
  )
  _peerProfiles.set(knownPeerId, merged)
  cachePeerProfile(merged, knownPeerId)
  return merged
}

async function syncProfileCloudNow() {
  const me = ensureActiveProfile()
  if (!me?.username) return { ok: false, error: 'no profile' }
  if (!isFlowSocialReady()) return { ok: false, error: 'no social backend' }
  const custom = getProfileCustom()
  const stats = getListenStats()
  const totalTracks = toDbSafeBigint(stats.totalTracks, 0)
  const totalSeconds = toDbSafeBigint(stats.totalSeconds, 0)

  let av = custom.avatarData || null
  let bn = custom.bannerData || null
  if (av) av = await shrinkProfileDataUrlForApi(av, 'avatar')
  if (bn) bn = await shrinkProfileDataUrlForApi(bn, 'banner')

  const core = {
    username: me.username,
    online: true,
    last_seen: new Date().toISOString(),
    bio: custom.bio || '',
    pinned_tracks: Array.isArray(custom.pinnedTracks) ? custom.pinnedTracks.slice(0, 5) : [],
    pinned_playlists: Array.isArray(custom.pinnedPlaylists) ? custom.pinnedPlaylists.slice(0, 5) : [],
    total_tracks: totalTracks,
    total_seconds: totalSeconds,
  }

  const pc = custom.profileColor || null
  const variants = [
    { ...core, avatar_data: av, banner_data: bn, ...(pc ? { profile_color: pc } : {}) },
    { ...core, avatar_data: av, banner_data: bn },
    { ...core, avatar_data: null, banner_data: null, ...(pc ? { profile_color: pc } : {}) },
    { ...core, avatar_data: null, banner_data: null },
    { ...core, avatar_data: null, banner_data: null, total_tracks: 0, total_seconds: 0 },
  ]

  let lastErr = ''
  for (const body of variants) {
    try {
      await flowSocialPut('/flow-api/v1/profile', body)
      try {
        if (typeof setSocialStatus === 'function') setSocialStatus('online')
      } catch (_) {}
      return { ok: true }
    } catch (e) {
      lastErr = e?.message || String(e)
    }
  }
  return { ok: false, error: lastErr }
}

function scheduleProfileCloudSync() {
  if (!ensureActiveProfile()?.username) return
  if (_flowSocialProfileSyncTimer) clearTimeout(_flowSocialProfileSyncTimer)
  _flowSocialProfileSyncTimer = setTimeout(async () => {
    _flowSocialProfileSyncTimer = null
    await syncProfileCloudNow().catch(() => {})
  }, 220)
}

function stopRoomServerSync() {
  try {
    if (typeof _flowSocialRoomUnsub === 'function') _flowSocialRoomUnsub()
  } catch {}
  _flowSocialRoomUnsub = null
  if (_roomServerHeartbeatTimer) clearInterval(_roomServerHeartbeatTimer)
  _roomServerHeartbeatTimer = null
  if (_roomServerFullSyncTimer) clearInterval(_roomServerFullSyncTimer)
  _roomServerFullSyncTimer = null
}

function stopProfilesRealtimeSync() {
  try {
    if (typeof _profilesRealtimeUnsub === 'function') _profilesRealtimeUnsub()
  } catch {}
  _profilesRealtimeUnsub = null
}

function startProfilesRealtimeSync() {
  stopProfilesRealtimeSync()
  if (!_profile?.username || !window.FlowSocialBackend?.isConfigured?.()) return
  window.FlowSocialBackend.ensureWs()
  window.FlowSocialBackend.wsSubscribeTopics(['profiles'])
  _profilesRealtimeUnsub = window.FlowSocialBackend.onMessage((msg) => {
    if (msg?.table !== 'flow_profiles') return
    const row = msg.new
    const username = String(row?.username || '').trim().toLowerCase()
    if (!username) return
    const self = String(_profile?.username || '').trim().toLowerCase()
    const friends =
      peerSocial.getFriends && self ? peerSocial.getFriends(self) || [] : []
    const watchSet = new Set([self, ...friends.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean)])
    if (!watchSet.has(username)) return
    const hasOwn = Object.prototype.hasOwnProperty
    const hasAvatar = hasOwn.call(row || {}, 'avatar_data') || hasOwn.call(row || {}, 'avatarData')
    const hasBanner = hasOwn.call(row || {}, 'banner_data') || hasOwn.call(row || {}, 'bannerData')
    const cloudProfile = {
      username,
      avatarData: hasAvatar ? (row?.avatar_data ?? row?.avatarData ?? null) : null,
      bannerData: hasBanner ? (row?.banner_data ?? row?.bannerData ?? null) : null,
      profileColor: row?.profile_color || row?.profileColor || '',
      bio: row?.bio || '',
      pinnedTracks: Array.isArray(row?.pinned_tracks) ? row.pinned_tracks.slice(0, 5) : (Array.isArray(row?.pinnedTracks) ? row.pinnedTracks.slice(0, 5) : []),
      pinnedPlaylists: Array.isArray(row?.pinned_playlists) ? row.pinned_playlists.slice(0, 5) : (Array.isArray(row?.pinnedPlaylists) ? row.pinnedPlaylists.slice(0, 5) : []),
      stats: {
        totalTracks: Number(row?.total_tracks ?? row?.totalTracks ?? 0),
        totalSeconds: Number(row?.total_seconds ?? row?.totalSeconds ?? 0),
      },
    }
    const peerId = `flow-${username}`
    const merged = mergeProfileData(
      _peerProfiles.get(peerId) || getCachedPeerProfile(username),
      Object.assign({}, cloudProfile, { peerId }),
      peerId
    )
    _peerProfiles.set(peerId, merged)
    cachePeerProfile(merged, peerId)
    if (username !== self) scheduleFriendsPresenceRefresh(true, 180)
    if (_profile?.username && username === String(_profile.username).trim().toLowerCase()) {
      syncProfileUi()
    }
    renderFriends().catch(() => {})
    if (_roomState?.roomId) renderRoomMembers()
  })
}

function scheduleFriendsPresenceRefresh(force = false, delay = 220) {
  if (_friendsForceRefreshTimer) clearTimeout(_friendsForceRefreshTimer)
  _friendsForceRefreshTimer = setTimeout(() => {
    _friendsForceRefreshTimer = null
    pollFriendsPresence(Boolean(force)).catch(() => {})
  }, Math.max(80, Number(delay || 220)))
}

async function upsertRoomMemberPresence() {
  try {
    if (!_roomState?.roomId || !_profile?.username || !isFlowSocialReady()) return
    const peerId = String(_socialPeer?.peer?.id || `flow-${_profile.username}`)
    const profile = getPublicProfilePayload(_profile.username)
    await flowSocialPut('/flow-api/v1/room-members', {
      room_id: _roomState.roomId,
      peer_id: peerId,
      username: _profile.username,
      profile: profile || {},
      last_seen: new Date().toISOString(),
    })
  } catch {}
}

async function removeRoomMemberPresence(roomId = _roomState?.roomId) {
  try {
    const peerId = String(_socialPeer?.peer?.id || '')
    if (!isFlowSocialReady() || !roomId || !peerId) return
    const qs = `?room_id=${encodeURIComponent(roomId)}&peer_id=${encodeURIComponent(peerId)}`
    await window.FlowSocialBackend.request('DELETE', `/flow-api/v1/room-members${qs}`)
  } catch {}
}

async function saveRoomStateToServer(patch = {}) {
  try {
    if (!_roomState?.roomId || !_profile?.username || !isFlowSocialReady()) return
    const isHost = Boolean(_roomState.host)
    const payloadPatch = Object.assign({}, patch || {})
    if (!isHost) {
      delete payloadPatch.shared_queue
      delete payloadPatch.now_playing
      delete payloadPatch.playback_state
      delete payloadPatch.playback_ts
    }
    const hostPeerId = _roomState.host
      ? String(_socialPeer?.peer?.id || _roomState.roomId)
      : ((_roomState.hostPeerId && _roomState.hostPeerId !== _roomState.roomId) ? String(_roomState.hostPeerId) : null)
    const payload = Object.assign(
      {
        room_id: _roomState.roomId,
        updated_by_peer_id: String(_socialPeer?.peer?.id || hostPeerId || _roomState.roomId),
        updated_at: new Date().toISOString(),
      },
      isHost ? { shared_queue: sharedQueue } : {},
      payloadPatch
    )
    if (hostPeerId) payload.host_peer_id = hostPeerId
    await flowSocialPut('/flow-api/v1/rooms', payload)
  } catch {}
}

function scheduleRoomStateSave(patch = {}, delay = 450) {
  if (_roomServerSaveTimer) clearTimeout(_roomServerSaveTimer)
  const payload = Object.assign({}, patch || {})
  _roomServerSaveTimer = setTimeout(() => {
    _roomServerSaveTimer = null
    saveRoomStateToServer(payload).catch(() => {})
  }, Math.max(120, Number(delay || 450)))
}

function applyRoomMembersRowsFromServer(rows) {
  if (!Array.isArray(rows)) return
  const merged = new Map(_roomMembers)
  rows.forEach((m) => {
    const pid = String(m?.peer_id || '').trim()
    if (!pid) return
    const base =
      merged.get(pid) ||
      _peerProfiles.get(pid) ||
      getCachedPeerProfile(m?.username || pid.replace(/^flow-/, '')) || { username: m?.username || pid.replace(/^flow-/, '') }
    const profile = mergeProfileData(
      base,
      Object.assign({ username: m?.username || pid.replace(/^flow-/, '') }, m?.profile || {}, { peerId: pid }),
      pid
    )
    merged.set(pid, profile)
    cachePeerProfile(profile, pid)
  })
  if (_socialPeer?.peer?.id && _profile?.username) {
    merged.set(_socialPeer.peer.id, getPublicProfilePayload(_profile.username))
  }
  _roomMembers = merged
  renderRoomMembers()
}

async function loadRoomStateFromServer(force = false) {
  try {
    if (!_roomState?.roomId) return
    const now = Date.now()
    if (!force && (now - _lastRoomServerLoadAt) < 280) return
    _lastRoomServerLoadAt = now
    if (!isFlowSocialReady()) return
    const rid = encodeURIComponent(_roomState.roomId)
    const [room, members] = await Promise.all([
      flowSocialGet(`/flow-api/v1/rooms/${rid}`),
      flowSocialGet(`/flow-api/v1/room-members/${rid}`),
    ])
    const myPeerId = String(_socialPeer?.peer?.id || '')
    const roomIdStr = String(_roomState.roomId || '').trim()
    const iOwnRoomNamespace = Boolean(myPeerId && roomIdStr === myPeerId)
    let serverHost = room?.host_peer_id != null && String(room.host_peer_id).trim() !== '' ? String(room.host_peer_id).trim() : ''
    if (iOwnRoomNamespace && serverHost && serverHost !== myPeerId) {
      _roomState.hostPeerId = myPeerId
      _roomState.host = true
      saveRoomStateToServer({ host_peer_id: myPeerId, shared_queue: sharedQueue }).catch(() => {})
    } else if (serverHost) {
      _roomState.hostPeerId = serverHost
      if (myPeerId) _roomState.host = _roomState.hostPeerId === myPeerId
    } else if (roomIdStr.startsWith('flow-')) {
      _roomState.hostPeerId = roomIdStr
      if (myPeerId) _roomState.host = myPeerId === roomIdStr
    }
    // Хост не подменяет очередь снимком с сервера: иначе гонка с saveRoomStateToServer
    // затирает локальную очередь (пропадают треки, «залипает» один старый).
    if (Array.isArray(room?.shared_queue) && !_roomState.host) {
      sharedQueue = room.shared_queue.map((t) => sanitizeTrack(t)).filter(Boolean)
      renderRoomQueue()
    }
    applyRoomMembersRowsFromServer(members)
    if (!_roomState.host && room?.now_playing && Number(room?.playback_ts || 0) > _lastAppliedServerPlaybackTs) {
      _lastAppliedServerPlaybackTs = Number(room.playback_ts || 0)
      const serverTrack = sanitizeTrack(room.now_playing)
      const state = room?.playback_state || {}
      const serverSig = normalizeTrackSignature(serverTrack || {})
      const currentSig = normalizeTrackSignature(currentTrack || {})
      const noActiveAudio = !audio?.src || audio?.ended || audio?.error
      const shouldReloadFromServer =
        Boolean(serverTrack) &&
        (noActiveAudio || !currentTrack || !serverSig || !currentSig || serverSig !== currentSig)
      if (shouldReloadFromServer) playTrackObj(serverTrack, { remoteSync: true }).catch(() => {})
      const p2pFresh = Date.now() - (_lastGuestP2pPlaybackAt || 0) < 1200
      const targetTime = Number(state?.currentTime || 0)
      const dur = Number(audio?.duration || 0)
      const canSeek = Number.isFinite(targetTime) && Number.isFinite(dur) && dur > 0
      const drift = canSeek ? Math.abs(Number(audio.currentTime || 0) - targetTime) : 0
      if (shouldReloadFromServer) {
        if (canSeek && drift > 0.45) audio.currentTime = Math.max(0, Math.min(targetTime, dur))
        if (state?.paused === true && !audio.paused) audio.pause()
        if (state?.paused === false && audio.paused) audio.play().catch(() => {})
      } else if (!p2pFresh) {
        if (canSeek && drift > 2.0) audio.currentTime = Math.max(0, Math.min(targetTime, dur))
        if (state?.paused === true && !audio.paused) audio.pause()
        if (state?.paused === false && audio.paused) audio.play().catch(() => {})
      }
    }
  } catch {}
}

function startRoomServerSync(opts = {}) {
  stopRoomServerSync()
  if (!_roomState?.roomId || !window.FlowSocialBackend?.isConfigured?.()) return
  window.FlowSocialBackend.ensureWs()
  window.FlowSocialBackend.wsSubscribeTopics([`room:${_roomState.roomId}`])
  _flowSocialRoomUnsub = window.FlowSocialBackend.onMessage((msg) => {
    const rid = String(msg?.room_id || '').trim()
    if (rid !== String(_roomState.roomId || '').trim()) return
    if (msg?.table !== 'flow_rooms' && msg?.table !== 'flow_room_members') return
    loadRoomStateFromServer(false).catch(() => {})
  })
  upsertRoomMemberPresence().catch(() => {})
  if (!opts.skipInitialLoad) loadRoomStateFromServer(true).catch(() => {})
  _roomServerHeartbeatTimer = setInterval(() => {
    upsertRoomMemberPresence().catch(() => {})
  }, 1800)
  _roomServerFullSyncTimer = setInterval(() => {
    loadRoomStateFromServer(true).catch(() => {})
  }, 5200)
}

function renderRoomMembers() {
  const el = document.getElementById('room-members-list')
  if (!el) return
  if (!_roomState?.roomId) {
    el.innerHTML = '<div class="flow-empty-state compact"><strong>Рума не активна</strong><span>Создай комнату или вставь invite друга.</span></div>'
    return
  }
  const hostPeerId = String(_roomState?.hostPeerId || '').trim()
  const seen = new Set()
  const members = []
  Array.from(_roomMembers.values()).forEach((raw) => {
    if (!raw?.peerId) return
    const pid = String(raw.peerId)
    if (seen.has(pid)) return
    seen.add(pid)
    let m = raw
    if (m?.username) {
      const cached = getCachedPeerProfile(m.username)
      if (cached) m = mergeProfileData(cached, m, m?.peerId || cached?.peerId || '')
    }
    members.push(m)
  })
  const connectedPeerIds = Array.from(_socialPeer?.connections?.keys?.() || []).map(String).sort()
  connectedPeerIds.forEach((peerId) => {
    if (!peerId || seen.has(peerId)) return
    seen.add(peerId)
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
  members.sort((a, b) => {
    const ah = hostPeerId && a.peerId === hostPeerId ? 0 : 1
    const bh = hostPeerId && b.peerId === hostPeerId ? 0 : 1
    if (ah !== bh) return ah - bh
    return String(a.username || '').localeCompare(String(b.username || ''), 'ru')
  })
  el.innerHTML = members.map((m) => {
    if (!m) return ''
    const isHost = Boolean(hostPeerId && m.peerId && m.peerId === hostPeerId)
    const avatar = m.avatarData
      ? `<div class="social-friend-avatar social-friend-avatar-active" style="background-image:url(${m.avatarData})"></div>`
      : `<div class="social-friend-avatar social-friend-avatar-active">${String(m.username || '?').slice(0,1).toUpperCase()}</div>`
    const hostTag = isHost ? '<span class="room-host-pill">хост</span>' : ''
    return `<div class="social-friend-card online" oncontextmenu="openRoomMemberContextMenu(event, '${m.peerId || ''}', '${m.username || ''}')">${avatar}<div class="social-friend-meta"><strong>${m.username || 'user'} ${hostTag}</strong><span>${m.username === _profile?.username ? 'это вы' : 'в комнате'}</span></div></div>`
  }).join('') || '<div class="flow-empty-state compact"><strong>Нет участников</strong><span>Подключение появится здесь.</span></div>'
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
    _socialPeer.send({ type: 'room-profile-state', roomId: _roomState.roomId, profile: me })
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
    el.innerHTML = '<div class="flow-empty-state compact"><strong>Очередь пуста</strong><span>Добавь трек через поиск или из своих треков.</span></div>'
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
    row.addEventListener('click', () => {
      if (!_roomState?.host) return
      playSharedQueueTrackAt(i)
    })
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

function renderRoomNowPlaying() {
  const el = document.getElementById('room-now-playing')
  if (!el) return
  if (!_roomState?.roomId || !currentTrack) {
    el.textContent = 'Сейчас ничего не играет'
    return
  }
  el.textContent = `Играет сейчас: ${currentTrack.title || 'Без названия'}${currentTrack.artist ? ` — ${currentTrack.artist}` : ''}`
}

function playSharedQueueTrackAt(index) {
  if (!_roomState?.host) return
  const idx = Number(index)
  if (!Number.isFinite(idx) || idx < 0 || idx >= sharedQueue.length) return
  const [track] = sharedQueue.splice(idx, 1)
  renderRoomQueue()
  broadcastQueueUpdate()
  if (track) playTrackObj(track, { fromSharedQueue: true }).catch(() => {})
}

function broadcastQueueUpdate() {
  if (!_socialPeer || !_roomState?.roomId || !_roomState.host) return
  const eventType = peerSocial?.EVENTS?.QUEUE_UPDATE || 'queue-update'
  _socialPeer.send({
    type: eventType,
    roomId: _roomState.roomId,
    sharedQueue,
  })
  scheduleRoomStateSave({ shared_queue: sharedQueue })
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
  // Гость только отправляет запрос хосту: локальная запись sharedQueue
  // создаёт гонки и "пропадающие" треки при серверной синхронизации.
  const payload = { type: 'room-queue-add', roomId: _roomState.roomId, track: cleanTrack }
  _socialPeer?.send(payload)
  if (typeof _socialPeer?.sendToPeer === 'function' && _roomState?.hostPeerId) {
    _socialPeer.sendToPeer(_roomState.hostPeerId, payload)
  }
  showToast('Трек добавлен в очередь комнаты')
}

function removeSharedQueueTrack(index) {
  if (!_roomState?.host) return
  const idx = Number(index)
  if (!Number.isFinite(idx) || idx < 0 || idx >= sharedQueue.length) return
  sharedQueue.splice(idx, 1)
  renderRoomQueue()
  broadcastQueueUpdate()
  scheduleRoomStateSave({ shared_queue: sharedQueue })
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
  scheduleRoomStateSave({ shared_queue: sharedQueue })
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
  scheduleRoomStateSave({ shared_queue: sharedQueue })
}

async function searchRoomQueueTracks() {
  const input = document.getElementById('room-queue-search')
  const list = document.getElementById('room-search-results')
  if (!input || !list) return
  const q = String(input.value || '').trim()
  if (!q) {
    _roomSearchResults = []
    list.innerHTML = '<div class="flow-empty-state compact"><strong>Начни поиск</strong><span>Введи название трека, чтобы добавить его в очередь.</span></div>'
    return
  }
  list.innerHTML = '<div class="flow-empty-state compact"><strong>Ищу треки...</strong><span>Проверяю доступные источники Nexory.</span></div>'
  clearTimeout(_roomSearchDebounceTimer)
  _roomSearchDebounceTimer = setTimeout(async () => {
    try {
      const s = getSettings()
      const hybrid = await searchHybridTracks(q, s)
      _roomSearchResults = sanitizeTrackList(hybrid?.tracks || []).slice(0, 4)
      if (!_roomSearchResults.length) {
        list.innerHTML = '<div class="flow-empty-state compact"><strong>Ничего не найдено</strong><span>Попробуй другой запрос или источник.</span></div>'
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
      list.innerHTML = '<div class="flow-empty-state compact"><strong>Ошибка поиска</strong><span>Источник не ответил, попробуй позже.</span></div>'
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

