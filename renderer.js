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

function applyHomeSliderStyle() {
  const v = getVisual()
  const style = normalizeHomeSliderStyle(v.homeSliderStyle)
  for (const id of ['home-clone-progress', 'pm-progress']) {
    const el = document.getElementById(id)
    if (!el) continue
    el.classList.toggle('home-slider-wave', style === 'wave')
    el.classList.toggle('home-slider-ios', style === 'ios')
  }
  const b1 = document.getElementById('slider-style-line')
  const b2 = document.getElementById('slider-style-wave')
  const b3 = document.getElementById('slider-style-ios')
  if (b1) b1.classList.toggle('active', style === 'line')
  if (b2) b2.classList.toggle('active', style === 'wave')
  if (b3) b3.classList.toggle('active', style === 'ios')
  const preview = document.getElementById('vs-slider-preview')
  if (preview) preview.dataset.sliderStyle = style
  try { drawSliderPreviewFrame() } catch (_) {}
  try { startSliderPreviewLoop() } catch (_) {}
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
    const bw = (w - 8) / bars
    for (let i = 0; i < bars; i++) {
      const bh = 6 + (data[i] / 255) * (h - 10)
      const x = 4 + i * bw
      const y = h - bh
      const played = i / bars <= progress
      ctx.fillStyle = played ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.28)'
      ctx.fillRect(x, y, Math.max(2, bw - 1.5), bh)
    }
    const px = 4 + progress * (w - 8)
    ctx.fillStyle = '#fff'
    ctx.fillRect(px - 1, 2, 2, h - 4)
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
  const src = String(settings?.activeSource || currentSource || 'hybrid').toLowerCase()
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

async function openPeerProfile(username, peerId = '') {
  const modal = document.getElementById('peer-profile-modal')
  const body = document.getElementById('peer-profile-body')
  if (!modal || !body) return
  const targetUsername = String(username || '').trim().toLowerCase()
  const byName = Array.from(_peerProfiles.values()).find((p) => String(p?.username || '').trim().toLowerCase() === targetUsername)
  const byPeerRaw = peerId ? _peerProfiles.get(peerId) : null
  const byPeer = byPeerRaw && String(byPeerRaw?.username || '').trim().toLowerCase() === targetUsername ? byPeerRaw : null
  let data = byPeer || byName || { username }
  let profileFriends = []
  const cached = getCachedPeerProfile(username)
  if (cached) data = mergeProfileData(data, cached, peerId || data?.peerId || '')
  data._friends = Array.isArray(data?._friends) ? data._friends : []
  const renderModal = (profileData) => {
    const uRaw = profileData.username || username || 'user'
    const unameKey = String(uRaw).trim().toLowerCase()
    const avatarSrc = withImageCacheBust(profileData.avatarData)
    const bannerSrc = withImageCacheBust(profileData.bannerData)
    const safeColor = normalizeProfileColor(profileData.profileColor || '')
    const colorRgb = hexToRgb(safeColor)
    const accent = safeColor || 'var(--accent2)'
    const bannerC1 = colorRgb ? `rgba(${colorRgb.r},${colorRgb.g},${colorRgb.b},0.34)` : 'rgba(124,58,237,0.24)'
    const bannerC2 = colorRgb
      ? `rgba(${Math.min(255, Math.round(colorRgb.r * 0.7 + 48))},${Math.min(255, Math.round(colorRgb.g * 0.7 + 48))},${Math.min(255, Math.round(colorRgb.b * 0.7 + 70))},0.24)`
      : 'rgba(59,130,246,0.2)'
    const peerThemeStyle = `--profile-accent:${accent};--profile-banner-c1:${bannerC1};--profile-banner-c2:${bannerC2};`
    const banner = bannerSrc
      ? `linear-gradient(0deg, rgba(8,10,16,.42), rgba(8,10,16,.42)), url(${bannerSrc})`
      : `linear-gradient(135deg, ${bannerC1}, ${bannerC2}), linear-gradient(180deg,#1a1f2e,#10131c)`
    const avatarInner = avatarSrc
      ? `<div class="profile-avatar profile-avatar--disc flow-profile-avatar-face" style="background-image:url(${avatarSrc});background-size:cover;background-position:center;"></div>`
      : `<div class="profile-avatar profile-avatar--disc flow-profile-avatar-face">${escapeHtml(String(uRaw).slice(0, 1).toUpperCase())}</div>`
    const pres = _friendPresence.get(unameKey) || {}
    const friends = Array.isArray(profileData._friends) ? profileData._friends.slice(0, 24) : []
    const friendsHtml = friends.length ? buildFlowProfileFriendsStripHtml(friends) : '<div class="flow-profile-friends-empty">Нет данных</div>'
    const listenTrack =
      pres.online && pres.track?.title
        ? {
            title: pres.track.title,
            artist: pres.track.artist || '',
            source: pres.track.source || 'soundcloud',
          }
        : null
    const listenCoverId = 'peer-flow-listening-cover'
    const listenHtml = stringifyFlowProfileListeningPanel(listenTrack, listenTrack ? 38 : 0, listenTrack ? listenCoverId : null)
    body.innerHTML = `
      <div class="profile-shell peer-profile-shell profile-unified flow-profile-card peer-profile-card-bleed" style="${peerThemeStyle}">
        <div class="peer-profile-cover-wrap">
          <div class="peer-profile-cover" style="background-image:${banner};"></div>
          <div class="flow-profile-hero-fill peer-profile-below-cover">
            <section class="flow-profile-main-tile flow-profile-nested-glass">
              <div class="flow-profile-top-row peer-profile-top-row">
                <div class="flow-profile-avatar-col">
                  <div class="flow-profile-avatar-ring-wrap">
                    <div class="flow-profile-avatar-ring">
                      ${avatarInner}
                    </div>
                    <span class="flow-profile-online-dot ${pres.online ? '' : 'flow-profile-online-dot--offline'}" aria-hidden="true"></span>
                  </div>
                </div>
              </div>
              <div class="flow-profile-identity">
                <h3 class="flow-profile-display-name">${escapeHtml(uRaw)}</h3>
                <p class="flow-profile-handle-line">@${escapeHtml(uRaw)} • custom</p>
                <div class="flow-profile-badge-strip">${getFlowProfileBadgeStripHtml()}</div>
                <p class="flow-profile-bio">${escapeHtml(profileData.bio || 'Описание отсутствует')}</p>
              </div>
              <div class="flow-profile-friends-zone">
                <div class="flow-profile-zone-label">Friends</div>
                <div class="flow-profile-friends-strip">${friendsHtml}</div>
              </div>
            </section>
            <div class="flow-profile-listening-slot">${listenHtml}</div>
          </div>
        </div>
      </div>
    `
    if (listenTrack) {
      queueMicrotask(() => {
        const c = document.getElementById(listenCoverId)
        if (!c) return
        c.textContent = '♪'
        c.style.display = 'flex'
        c.style.alignItems = 'center'
        c.style.justifyContent = 'center'
        c.style.fontSize = '20px'
        c.style.color = 'rgba(255,255,255,0.78)'
        c.style.backgroundImage = 'none'
        c.style.background = 'linear-gradient(135deg, rgba(124,58,237,0.58), rgba(59,130,246,0.48))'
      })
    }
    modal.classList.remove('hidden')
  }
  renderModal(data)
  const targetPeerId = String(peerId || data?.peerId || `flow-${targetUsername}` || '').trim()
  const cloud = await fetchCloudPublicProfile(username).catch(() => null)
  const cloudFriends = await fetchCloudFriendsForUser(username).catch(() => [])
  if (Array.isArray(cloudFriends) && cloudFriends.length) profileFriends = cloudFriends
  if (cloud) {
    data = mergeProfileData(data, cloud, targetPeerId || data.peerId || '')
    data._friends = profileFriends.slice()
    if (data.peerId) _peerProfiles.set(data.peerId, data)
    cachePeerProfile(data, data.peerId)
    renderModal(data)
  }
  if (_socialPeer?.requestPeerData && targetPeerId && targetPeerId !== _socialPeer?.peer?.id) {
    const rsp = await _socialPeer.requestPeerData(targetPeerId, { type: 'presence-request' }, 1300).catch(() => null)
    const remoteProfile = rsp?.ok ? rsp?.data?.profile : null
    if (remoteProfile) {
      data = mergeProfileData(data, remoteProfile, rsp?.data?.peerId || targetPeerId || '')
      if (!Array.isArray(data._friends)) data._friends = profileFriends.slice()
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

function toDbSafeBigint(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value))
  const normalized = String(value ?? '').trim().replace(/\s+/g, '').replace(',', '.')
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(0, Math.round(parsed))
}

function getListenHistory() {
  if (!_profile?.username) return []
  const key = `flow_listen_history_${_profile.username}`
  try {
    const list = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function saveListenHistory(list = []) {
  if (!_profile?.username) return
  const key = `flow_listen_history_${_profile.username}`
  try { localStorage.setItem(key, JSON.stringify(Array.isArray(list) ? list.slice(0, WE?.MY_WAVE_MAX_TRACKS ?? 30) : [])) } catch {}
}

function pushListenHistory(track) {
  const safe = sanitizeTrack(track)
  if (!safe?.id || !_profile?.username) return
  const key = `${safe.source || 'unknown'}:${safe.id}`
  const next = [{ key, playedAt: Date.now(), track: safe }]
  const seen = new Set([key])
  for (const item of getListenHistory()) {
    const itemKey = String(item?.key || '')
    if (!itemKey || seen.has(itemKey) || !item?.track?.id) continue
    seen.add(itemKey)
    next.push(item)
    if (next.length >= (WE?.MY_WAVE_MAX_TRACKS ?? 30)) break
  }
  saveListenHistory(next)
}

function getMyWaveMode() {
  return WE?.MY_WAVE_MODES?.[_myWaveMode] ? _myWaveMode : 'default'
}

function getMyWaveSource() {
  try {
    const raw = String(localStorage.getItem('flow_my_wave_source') || 'yandex').trim().toLowerCase()
    return raw === 'vk' ? 'vk' : 'yandex'
  } catch {
    return 'yandex'
  }
}

let _yandexRotorTrackStartedForId = null
let _yandexWaveMoodDockOpen = false

function flowWaveSourceBadgeLine(track) {
  const t = track && typeof track === 'object' ? track : null
  if (!t?.source) return ''
  const raw = String(t.source).toLowerCase()
  const base = raw === 'ya' || raw === 'ym' ? 'yandex' : raw
  if (base === 'yandex') {
    const ymWave = getMyWaveSource() === 'yandex' && queueScope === 'myWave'
    const m = getMyWaveMode()
    const lab = WE?.MY_WAVE_MODES?.[m]?.label || ''
    if (ymWave && lab) return `Яндекс · Волна · ${lab}`
    return 'Яндекс'
  }
  const short = { soundcloud: 'SoundCloud', vk: 'VK', youtube: 'YouTube', spotify: 'Spotify' }[base]
  return short || String(base).toUpperCase()
}

/** Цветной бейдж источника (SC / VK / Ян …) как в списках треков. */
function flowTrackSourceBadgeHtml(track) {
  const t = track && typeof track === 'object' ? track : null
  if (!t?.source) return ''
  const badgeKey = trackSourceBadgeKey(t.source)
  const SHORT = { soundcloud: 'SC', vk: 'VK', youtube: 'YT', spotify: 'SP', yandex: 'Ян' }
  const lbl = SHORT[badgeKey]
  if (!lbl) return ''
  return `<span class="track-source track-source-${badgeKey}">${lbl}</span>`
}

function syncInlineTrackSourcePill(track) {
  const el = document.getElementById('player-track-source-inline')
  if (!el) return
  const html = flowTrackSourceBadgeHtml(track || currentTrack)
  if (!html) {
    el.classList.add('hidden')
    el.innerHTML = ''
    return
  }
  el.innerHTML = html
  el.classList.remove('hidden')
}

function updateYandexWaveDislikeButtonsVisible() {
  const show = Boolean(
    queueScope === 'myWave' &&
    getMyWaveSource() === 'yandex' &&
    currentTrack &&
    String(currentTrack.source || '').toLowerCase() === 'yandex' &&
    Boolean(currentTrack?.yandexRotor?.batchId)
  )
  ;['player-wave-dislike-btn', 'pm-wave-dislike-btn', 'pm-dislike-btn', 'home-wave-dislike-btn'].forEach((id) => {
    const b = document.getElementById(id)
    if (b) b.classList.toggle('hidden', !show)
  })
}

function renderYandexWaveMoodDock() {
  const docks = document.querySelectorAll('.yandex-wave-mood-dock')
  if (!docks.length) return
  if (getMyWaveSource() !== 'yandex') {
    docks.forEach((dock) => {
      dock.classList.add('hidden')
      dock.classList.remove('is-open')
    })
    return
  }
  const mode = getMyWaveMode()
  const modes = Object.entries(WE?.MY_WAVE_MODES || {})
  const activeCfg = WE?.MY_WAVE_MODES?.[mode] || WE?.MY_WAVE_MODES?.default
  const icon = activeCfg?.moodIconSvg || (WE?.MY_WAVE_MODES?.default?.moodIconSvg || '')
  const html = `
    <div class="yandex-wave-mood-panel" role="menu">
      ${modes.map(([id, cfg]) => {
        const ic = cfg?.moodIconSvg || ''
        return `<button type="button" class="yandex-wave-mood-chip ${id === mode ? 'active' : ''}" data-wave-mood="${escapeHtml(id)}" title="${escapeHtml(sanitizeDisplayText(cfg.label || id))}" aria-pressed="${id === mode ? 'true' : 'false'}" onclick="setMyWaveMode('${escapeHtml(id)}'); toggleYandexWaveMoodDockPanel(false)">${ic}</button>`
      }).join('')}
    </div>
    <button type="button" class="yandex-wave-mood-toggle" onclick="toggleYandexWaveMoodDockPanel()" title="Настроение волны (${escapeHtml(sanitizeDisplayText(activeCfg?.label || ''))})" aria-expanded="${_yandexWaveMoodDockOpen ? 'true' : 'false'}">
      <span class="yandex-wave-mood-toggle-icon">${icon}</span>
    </button>
  `
  docks.forEach((dock) => {
    dock.classList.remove('hidden')
    dock.innerHTML = html
    dock.classList.toggle('is-open', Boolean(_yandexWaveMoodDockOpen))
  })
}

function toggleYandexWaveMoodDockPanel(force) {
  const docks = document.querySelectorAll('.yandex-wave-mood-dock')
  const first = docks[0]
  if (!first || first.classList.contains('hidden')) return
  if (typeof force === 'boolean') _yandexWaveMoodDockOpen = force
  else _yandexWaveMoodDockOpen = !_yandexWaveMoodDockOpen
  docks.forEach((dock) => {
    dock.classList.toggle('is-open', _yandexWaveMoodDockOpen)
    const btn = dock.querySelector('.yandex-wave-mood-toggle')
    if (btn) btn.setAttribute('aria-expanded', _yandexWaveMoodDockOpen ? 'true' : 'false')
  })
}

async function dislikeCurrentYandexWaveTrack() {
  const t = sanitizeTrack(currentTrack || {})
  if (!t?.id || String(t.source || '').toLowerCase() !== 'yandex') return
  if (!t?.yandexRotor?.batchId) return
  if (queueScope !== 'myWave' || getMyWaveSource() !== 'yandex') return
  const tok = String(getSettings()?.yandexToken || '').trim()
  if (!tok || !window.api?.yandexTrackDislike) return showToast('Нужен токен Яндекса', true)
  const r = await window.api.yandexTrackDislike({ token: tok, trackId: t.id }).catch(() => ({ ok: false }))
  if (r?.ok) showToast('Не рекомендовать: синхрон с Яндексом')
  else showToast('Яндекс: не удалось отметить трек', true)
  recordWaveEarlySkip(t)
  nextTrack()
}
window.toggleYandexWaveMoodDockPanel = toggleYandexWaveMoodDockPanel
window.dislikeCurrentYandexWaveTrack = dislikeCurrentYandexWaveTrack
window.flowWaveSourceBadgeLine = flowWaveSourceBadgeLine
window.flowTrackSourceBadgeHtml = flowTrackSourceBadgeHtml

function closeMyWaveSourceMenus() {
  try {
    document.querySelectorAll('.my-wave-settings-anchor.is-open').forEach((a) => {
      a.classList.remove('is-open')
      a.querySelector('.my-wave-settings-btn')?.setAttribute('aria-expanded', 'false')
    })
  } catch (_) {}
}

function toggleMyWaveSourceMenu(ev) {
  try {
    ev?.preventDefault?.()
    ev?.stopPropagation?.()
  } catch (_) {}
  const btn = ev?.currentTarget
  const anchor = btn?.closest?.('.my-wave-settings-anchor')
  if (!anchor) return
  const willOpen = !anchor.classList.contains('is-open')
  document.querySelectorAll('.my-wave-settings-anchor.is-open').forEach((a) => {
    if (a !== anchor) {
      a.classList.remove('is-open')
      a.querySelector('.my-wave-settings-btn')?.setAttribute('aria-expanded', 'false')
    }
  })
  anchor.classList.toggle('is-open', willOpen)
  btn?.setAttribute('aria-expanded', willOpen ? 'true' : 'false')
}

function openMyWaveSettingsFromStack(which) {
  try {
    closeMyWaveSourceMenus()
    const key = String(which || 'main').toLowerCase()
    const slotId = key === 'rooms' ? 'rooms-wave-source-slot' : 'my-wave-source-slot'
    const anchor = document.querySelector(`#${slotId} .my-wave-settings-anchor`)
    if (!anchor) return
    anchor.classList.add('is-open')
    anchor.querySelector('.my-wave-settings-btn')?.setAttribute('aria-expanded', 'true')
  } catch (_) {}
}
window.openMyWaveSettingsFromStack = openMyWaveSettingsFromStack

function pauseMyWaveInUi() {
  try {
    audio.pause()
  } catch (_) {}
  syncTransportPlayPauseUi()
  syncMyWaveOrbPlayUi()
}
window.pauseMyWaveInUi = pauseMyWaveInUi

function myWaveSourceFabMarkHtml(source) {
  const s = source === 'vk' ? 'vk' : 'yandex'
  const vkSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="30" height="30" aria-hidden="true">' +
    '<rect width="48" height="48" rx="11" fill="#0077FF"/>' +
    '<text x="24" y="31" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="17" font-weight="700" fill="#ffffff">vk</text>' +
    '</svg>'
  const yaSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="30" height="30" aria-hidden="true" fill="none">' +
    '<circle cx="24" cy="24" r="23" fill="#050508"/>' +
    '<path fill="#FFCC00" d="M24 2l1.4 9.2 8.3-5.6-4 9.7 10-.9-7.8 6.5 9 4.4-10 2.4 6.8 7.6-9.6-3.4 1.2 10.4L24 34.6l-6.3 8.5 1.2-10.4-9.6 3.4 6.8-7.6-10-2.4 9-4.4-7.8-6.5 10 .9-4-9.7 8.3 5.6L24 2z"/>' +
    '</svg>'
  if (s === 'vk') {
    return `<span class="my-wave-source-fab-mark my-wave-source-fab-mark--vk" aria-hidden="true">${vkSvg}</span>`
  }
  return `<span class="my-wave-source-fab-mark my-wave-source-fab-mark--yandex" aria-hidden="true">${yaSvg}</span>`
}

function renderMyWaveSourceSlotInto(slotEl) {
  if (!slotEl) return
  const source = getMyWaveSource()
  const mode = getMyWaveMode()
  const modeButtons = Object.entries(WE?.MY_WAVE_MODES || {}).map(([id, cfg]) => (
    `<button type="button" class="my-wave-settings-mode-btn ${id === mode ? 'is-active' : ''}" onclick="setMyWaveMode('${escapeHtml(id)}')">${escapeHtml(sanitizeDisplayText(cfg?.label || id))}</button>`
  )).join('')
  slotEl.innerHTML = `
    <div class="my-wave-settings-anchor">
      <button type="button" class="my-wave-settings-btn" onclick="toggleMyWaveSourceMenu(event)" title="Настройки волны" aria-haspopup="true" aria-expanded="false">
        <svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3.2"></circle>
          <path d="M19.4 15a1 1 0 0 0 .2 1.1l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9V20a2 2 0 1 1-4 0v-.2a1 1 0 0 0-.6-.9 1 1 0 0 0-1.1.2l-.1.1a1.9 1.9 0 0 1-2.7-2.7l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6H4a2 2 0 1 1 0-4h.2a1 1 0 0 0 .9-.6 1 1 0 0 0-.2-1.1l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1a1 1 0 0 0 1.1.2h.1a1 1 0 0 0 .6-.9V4a2 2 0 1 1 4 0v.2a1 1 0 0 0 .6.9 1 1 0 0 0 1.1-.2l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1 1 0 0 0-.2 1.1v.1a1 1 0 0 0 .9.6H20a2 2 0 1 1 0 4h-.2a1 1 0 0 0-.9.6z"></path>
        </svg>
      </button>
      <div class="my-wave-settings-dropdown" role="menu">
        <div class="my-wave-settings-section-label">Источник волны</div>
        <div class="my-wave-settings-source-row">
          <button type="button" role="menuitem" class="my-wave-settings-source-btn ${source === 'yandex' ? 'is-active' : ''}" onclick="setMyWaveSource('yandex')">
            ${myWaveSourceFabMarkHtml('yandex')} Яндекс
          </button>
          <button type="button" role="menuitem" class="my-wave-settings-source-btn ${source === 'vk' ? 'is-active' : ''}" onclick="setMyWaveSource('vk')">
            ${myWaveSourceFabMarkHtml('vk')} VK
          </button>
        </div>
        ${
          source === 'yandex'
            ? `<div class="my-wave-settings-section-label">Режим волны</div><div class="my-wave-settings-mode-grid">${modeButtons}</div>`
            : '<div class="my-wave-settings-vk-note">Для VK доступен только выбор источника.</div>'
        }
      </div>
    </div>
  `
}

window.toggleMyWaveSourceMenu = toggleMyWaveSourceMenu
window.closeMyWaveSourceMenus = closeMyWaveSourceMenus

function setMyWaveSource(source) {
  closeMyWaveSourceMenus()
  const next = String(source || '').trim().toLowerCase() === 'vk' ? 'vk' : 'yandex'
  try { localStorage.setItem('flow_my_wave_source', next) } catch {}
  if (next === 'vk') {
    try { _yandexWaveRotorQueueHint = '' } catch (_) {}
    _myWaveMode = 'default'
    try { localStorage.setItem('flow_my_wave_mode', _myWaveMode) } catch {}
    toggleYandexWaveMoodDockPanel(false)
  }
  if (next !== 'yandex') toggleYandexWaveModes(false)
  renderYandexWaveModes()
  renderMyWave()
  syncYandexWaveSettingsLabel()
}

function setMyWaveMode(mode) {
  if (getMyWaveSource() !== 'yandex') return
  _myWaveMode = WE?.MY_WAVE_MODES?.[mode] ? mode : 'default'
  try { localStorage.setItem('flow_my_wave_mode', _myWaveMode) } catch {}
  renderMyWave()
  renderYandexWaveModes()
  syncYandexWaveSettingsLabel()
  renderYandexWaveMoodDock()
  syncInlineTrackSourcePill(currentTrack)
}

function syncYandexWaveSettingsLabel() {
  const btn = document.querySelector('.yandex-wave-settings')
  if (!btn) return
  const source = getMyWaveSource()
  if (source !== 'yandex') {
    btn.style.display = 'none'
    return
  }
  btn.style.display = 'inline-flex'
  const mode = getMyWaveMode()
  const cfg = WE?.MY_WAVE_MODES?.[mode]
  const label = sanitizeDisplayText(cfg?.label || 'Настроить')
  btn.textContent = `☰ ${label}`
  btn.title = 'Настроить Мою волну'
}

function renderYandexWaveModes() {
  const pop = document.getElementById('yandex-wave-mode-pop')
  if (!pop) return
  if (getMyWaveSource() !== 'yandex') {
    pop.classList.add('hidden')
    return
  }
  const mode = getMyWaveMode()
  const modes = Object.entries(WE?.MY_WAVE_MODES || {})
  pop.innerHTML = `
    <div class="yandex-wave-mode-title">Режим Моей волны</div>
    <div class="yandex-wave-mode-grid">
      ${modes.map(([id, cfg]) => (
        `<button type="button" class="yandex-wave-mode-btn ${id === mode ? 'active' : ''}" data-wave-mode="${escapeHtml(id)}" onclick="setMyWaveMode('${escapeHtml(id)}'); toggleYandexWaveModes(false)">${escapeHtml(sanitizeDisplayText(cfg.label || id))}</button>`
      )).join('')}
    </div>
  `
  syncYandexWaveSettingsLabel()
}

function toggleYandexWaveModes(force) {
  if (getMyWaveSource() !== 'yandex') return
  const pop = document.getElementById('yandex-wave-mode-pop')
  if (!pop) return
  renderYandexWaveModes()
  const shouldOpen = typeof force === 'boolean' ? force : pop.classList.contains('hidden')
  pop.classList.toggle('hidden', !shouldOpen)
}

let _lastMyWavePreloadCheckAt = 0

function getMyWaveTrackUniqueKey(track) {
  const safe = sanitizeTrack(track || {})
  const src = String(safe.source || '').trim().toLowerCase()
  const id = String(safe.id || safe.ytId || safe.url || '').trim().toLowerCase()
  if (src && id) return `${src}:${id}`
  const sig = normalizeTrackSignature(safe)
  if (sig) return `sig:${sig}`
  const fallback = `${String(safe.artist || '').trim().toLowerCase()}::${String(safe.title || '').trim().toLowerCase()}`
  return fallback !== '::' ? `meta:${fallback}` : ''
}

const YANDEX_WAVE_RECENT_LS = 'flow_yandex_wave_recent_ids'
const YANDEX_WAVE_RECENT_MAX = 120
const YANDEX_WAVE_QUEUE_BUFFER_MAX = 8

function loadYandexWaveRecentIds() {
  try {
    const raw = JSON.parse(localStorage.getItem(YANDEX_WAVE_RECENT_LS) || '[]')
    return Array.isArray(raw) ? raw.map((x) => String(x || '').trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

function rememberYandexWaveTracks(tracks = []) {
  try {
    const set = new Set(loadYandexWaveRecentIds())
    ;(tracks || []).forEach((track) => {
      const key = getMyWaveTrackUniqueKey(track)
      if (key) set.add(key)
    })
    const list = Array.from(set).slice(-YANDEX_WAVE_RECENT_MAX)
    localStorage.setItem(YANDEX_WAVE_RECENT_LS, JSON.stringify(list))
    list.forEach((key) => _myWaveSeenKeys.add(key))
  } catch (_) {}
}

function syncYandexWaveQueueHintFromTrack(track) {
  const id = String(track?.id || '').trim()
  if (id && String(track?.source || '').toLowerCase() === 'yandex') {
    try {
      _yandexWaveRotorQueueHint = id
    } catch (_) {}
  }
}

/** Яндекс-волна: буфер до 8 треков вперёд (вся пачка из rotor, без обрезки до 2). */
function compactYandexMyWaveQueueIfNeeded() {
  if (queueScope !== 'myWave' || getMyWaveSource() !== 'yandex') return
  const cur = sanitizeTrack(currentTrack || queue[queueIndex] || null)
  if (!cur?.id) return
  const curKey = getMyWaveTrackUniqueKey(cur)
  const head = queue.slice(0, Math.max(0, queueIndex))
  const tail = queue.slice(queueIndex + 1)
  const uniqTail = []
  const seen = new Set([curKey])
  tail.forEach((track) => {
    const safe = sanitizeTrack(track)
    const key = getMyWaveTrackUniqueKey(safe)
    if (!key || seen.has(key)) return
    seen.add(key)
    uniqTail.push(safe)
  })
  const capped = uniqTail.slice(0, YANDEX_WAVE_QUEUE_BUFFER_MAX - 1)
  queue = [cur, ...capped]
  queueIndex = 0
  try {
    _myWaveRenderedTracks = queue.slice()
  } catch (_) {}
  syncYandexWaveQueueHintFromTrack(cur)
}

function mergeYandexWaveQueueAppend(freshTracks) {
  const cur = sanitizeTrack(currentTrack || queue[queueIndex] || null)
  const incoming = (freshTracks || []).map(sanitizeTrack).filter((t) => t?.id)
  if (!cur?.id) {
    queue = incoming.slice(0, YANDEX_WAVE_QUEUE_BUFFER_MAX)
    queueIndex = 0
    if (queue[0]) syncYandexWaveQueueHintFromTrack(queue[queue.length - 1] || queue[0])
    return
  }
  const curKey = getMyWaveTrackUniqueKey(cur)
  const seen = new Set([curKey])
  const append = []
  incoming.forEach((track) => {
    const key = getMyWaveTrackUniqueKey(track)
    if (!key || seen.has(key)) return
    seen.add(key)
    append.push(track)
  })
  const head = queue.slice(0, Math.max(0, queueIndex))
  const tail = queue.slice(queueIndex + 1)
  const mergedTail = []
  const tailSeen = new Set([curKey])
  ;[...tail, ...append].forEach((track) => {
    const safe = sanitizeTrack(track)
    const key = getMyWaveTrackUniqueKey(safe)
    if (!key || tailSeen.has(key)) return
    tailSeen.add(key)
    mergedTail.push(safe)
  })
  queue = [cur, ...mergedTail.slice(0, YANDEX_WAVE_QUEUE_BUFFER_MAX - 1)]
  queueIndex = 0
  const anchor = queue[queue.length - 1] || cur
  syncYandexWaveQueueHintFromTrack(anchor)
  rememberYandexWaveTracks(queue)
}

async function maybePreloadMyWave(force = false) {
  if (queueScope !== 'myWave' || _myWaveBuilding || _myWavePreloading) return
  const remaining = queue.length - queueIndex - 1
  if (!force) {
    if (getMyWaveSource() === 'yandex') {
      if (remaining >= 3) return
    } else if (remaining > 3) {
      return
    }
  }
  if (getMyWaveSeedTracks().length < 3) return
  if (getMyWaveSource() === 'yandex') {
    loadYandexWaveRecentIds().forEach((key) => _myWaveSeenKeys.add(key))
    const anchor = sanitizeTrack(currentTrack || queue[queueIndex] || null)
    if (anchor?.id) syncYandexWaveQueueHintFromTrack(anchor)
    else if (_yandexWaveRotorQueueHint) {
      try {
        _yandexWaveRotorQueueHint = String(_yandexWaveRotorQueueHint).trim()
      } catch (_) {}
    }
  }
  _myWavePreloading = true
  renderMyWave()
  try {
    const dedupeWithExisting = (tracks = []) => {
      const existing = new Set(
        queue
          .map((track) => getMyWaveTrackUniqueKey(track))
          .filter(Boolean),
      )
      _myWaveSeenKeys.forEach((key) => existing.add(key))
      loadYandexWaveRecentIds().forEach((key) => existing.add(key))
      const fresh = []
      tracks.forEach((track) => {
        const key = getMyWaveTrackUniqueKey(track)
        if (!key || existing.has(key)) return
        existing.add(key)
        _myWaveSeenKeys.add(key)
        fresh.push(track)
      })
      return fresh
    }
    const waveAsk = getMyWaveSource() === 'yandex' ? 5 : 10
    const additions = await findMyWaveRecommendations(waveAsk, getMyWaveMode())
    let fresh = dedupeWithExisting(additions)
    if (!fresh.length && force && getMyWaveSource() === 'yandex' && currentTrack?.yandexRotor?.batchId) {
      const tok = String(getSettings()?.yandexToken || '').trim()
      if (tok && window.api?.yandexRotorFeedback) {
        void window.api.yandexRotorFeedback({
          token: tok,
          station: currentTrack.yandexRotor.station || 'user:onyourwave',
          type: 'skip',
          trackId: currentTrack.id,
          batchId: currentTrack.yandexRotor.batchId,
          totalPlayedSeconds: Number(audio?.currentTime || 0) || 0,
        })
      }
      syncYandexWaveQueueHintFromTrack(currentTrack)
      const retry = await findMyWaveRecommendations(waveAsk, getMyWaveMode())
      fresh = dedupeWithExisting(retry)
    }
    if (fresh.length) {
      if (getMyWaveSource() === 'yandex') {
        mergeYandexWaveQueueAppend(fresh)
      } else {
        queue.push(...fresh)
      }
      _myWaveRenderedTracks = queue.slice()
      renderQueue()
      showToast(getMyWaveSource() === 'yandex' ? 'Моя волна: подгружен следующий трек' : `Моя волна дозагрузила ${fresh.length} треков`)
      if (force && queue.length > 1 && queue[1]) {
        queueIndex = 1
        await playTrackObj(queue[queueIndex])
      }
    } else if (force) {
      // Fallback: если строгий dedupe не дал новых треков, берем из последнего ответа
      // треки, которых нет рядом с текущим хвостом, чтобы волна не останавливалась.
      const recentKeys = new Set(
        queue
          .slice(Math.max(0, queueIndex - 2), queueIndex + 6)
          .map((t) => getMyWaveTrackUniqueKey(t))
          .filter(Boolean),
      )
      const fallback = (additions || []).filter((track) => {
        const key = getMyWaveTrackUniqueKey(track)
        if (!key || recentKeys.has(key)) return false
        return true
      })
      if (fallback.length) {
        if (getMyWaveSource() === 'yandex') {
          mergeYandexWaveQueueAppend(fallback)
        } else {
          queue.push(...fallback)
        }
        fallback.forEach((track) => {
          const key = getMyWaveTrackUniqueKey(track)
          if (key) _myWaveSeenKeys.add(key)
        })
        _myWaveRenderedTracks = queue.slice()
        renderQueue()
        showToast(getMyWaveSource() === 'yandex' ? 'Моя волна: подгружен следующий трек' : `Моя волна продолжила подборку (${fallback.length})`)
        if (queue.length > 1 && queue[1]) {
          queueIndex = 1
          await playTrackObj(queue[queueIndex])
        }
      }
    }
  } catch (err) {
    console.warn('my wave preload failed', err)
  } finally {
    _myWavePreloading = false
    renderMyWave()
  }
}

/** Тонкие пересекающиеся линии-«волны» в нижней части орба (SVG + CSS-анимация). */
function myWaveFineLinesLayerHtml() {
  const d1 = 'M0,50 C160,24 320,76 480,50 S800,24 960,50 S1120,76 1280,50 S1440,24 1440,50'
  const d2 = 'M0,66 C160,90 320,42 480,66 S800,90 960,66 S1120,42 1280,66 S1440,90 1440,66'
  const d3 = 'M0,34 C160,10 320,58 480,34 S800,10 960,34 S1120,58 1280,34 S1440,10 1440,34'
  const path = (d, stroke) =>
    `<path fill="none" stroke="${stroke}" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" d="${d}"/>`
  const pair = (d, stroke) => `${path(d, stroke)}<g transform="translate(1440 0)">${path(d, stroke)}</g>`
  return `
    <div class="my-wave-fine-lines" aria-hidden="true">
      <svg class="my-wave-fine-lines__svg" viewBox="0 0 720 92" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
        <g class="my-wave-fine-lines__g my-wave-fine-lines__g--1">${pair(d1, 'rgba(255,255,255,0.4)')}</g>
        <g class="my-wave-fine-lines__g my-wave-fine-lines__g--2">${pair(d2, 'rgba(255,255,255,0.3)')}</g>
        <g class="my-wave-fine-lines__g my-wave-fine-lines__g--3">${pair(d3, 'rgba(255,255,255,0.34)')}</g>
      </svg>
    </div>`
}

async function startMyWave() {
  if (_myWaveBuilding) return
  const seedTracks = getMyWaveSeedTracks()
  if (seedTracks.length < 3) return showToast('Послушай или лайкни еще несколько треков, чтобы волна поняла вкус', true)
  try { _yandexWaveRotorQueueHint = '' } catch (_) {}
  _yandexRotorTrackStartedForId = null
  _waveEngineApi = null
  _myWaveBuilding = true
  renderMyWave()
  showToast('Моя волна подбирает новые треки...')
  try {
    const waveAsk = getMyWaveSource() === 'yandex' ? 5 : (WE?.MY_WAVE_MIN_TRACKS ?? 10)
    _myWaveSeenKeys = new Set(loadYandexWaveRecentIds())
    const tracks = await findMyWaveRecommendations(waveAsk, getMyWaveMode())
    const unique = []
    ;(tracks || []).forEach((track) => {
      const key = getMyWaveTrackUniqueKey(track)
      if (!key || _myWaveSeenKeys.has(key)) return
      _myWaveSeenKeys.add(key)
      unique.push(track)
    })
    if (!unique.length) return showToast('Волна пока не нашла новые треки. Попробуй другой режим или послушай еще музыку', true)
    _myWaveRenderedTracks = unique.slice()
    queue = unique.slice()
    queueIndex = 0
    queueScope = 'myWave'
    if (getMyWaveSource() === 'yandex') rememberYandexWaveTracks(unique)
    showToast(
      getMyWaveSource() === 'yandex' && unique.length <= 1
        ? 'Моя волна: трек из Яндекса'
        : `Моя волна собрала ${unique.length} новых треков`,
    )
    await playTrackObj(queue[0])
  } catch (err) {
    showToast(`Моя волна не запустилась: ${sanitizeDisplayText(err?.message || err)}`, true)
  } finally {
    _myWaveBuilding = false
    renderMyWave()
  }
}

function myWaveOrbPlayInnerHtml() {
  try {
    const playing = Boolean(audio && !audio.paused && !audio.ended && queueScope === 'myWave')
    return playing
      ? `<svg class="my-wave-orb-play-svg" viewBox="0 0 24 24" aria-hidden="true">${PM_PAUSE_INNER}</svg>`
      : `<svg class="my-wave-orb-play-svg" viewBox="0 0 24 24" aria-hidden="true">${PM_PLAY_INNER}</svg>`
  } catch (_) {
    return `<svg class="my-wave-orb-play-svg" viewBox="0 0 24 24" aria-hidden="true">${PM_PLAY_INNER}</svg>`
  }
}

function renderMyWave() {
  const listEl = document.getElementById('my-wave-list')
  const hintEl = document.getElementById('my-wave-hint')
  const modesEl = document.getElementById('my-wave-modes')
  if (!listEl) return
  const mode = getMyWaveMode()
  const modeCfg = WE?.MY_WAVE_MODES?.[mode] || WE?.MY_WAVE_MODES?.default
  const loading = _myWaveBuilding || _myWavePreloading
  const stack = listEl.querySelector('.my-wave-visual-stack')
  if (stack) {
    const orb = stack.querySelector('.my-wave-orb')
    if (orb) {
      orb.className = `my-wave-orb mode-${mode} my-wave-orb--hero ${loading ? 'is-loading' : ''}`
      orb.setAttribute('aria-label', modeCfg.label)
      const playBtn = stack.querySelector('.my-wave-glass-btn--play')
      if (playBtn) playBtn.innerHTML = myWaveOrbPlayInnerHtml()
      const slot = document.getElementById('my-wave-source-slot')
      if (slot) renderMyWaveSourceSlotInto(slot)
      renderRoomsMyWave()
      return
    }
  }
  if (hintEl) {
    hintEl.textContent = ''
    hintEl.classList.add('hidden')
    hintEl.style.display = 'none'
    hintEl.setAttribute('aria-hidden', 'true')
  }
  if (modesEl) {
    modesEl.innerHTML = ''
    modesEl.style.display = 'none'
  }
  const orbPlayInner = myWaveOrbPlayInnerHtml()
  listEl.innerHTML = `
    <div class="my-wave-visual-stack">
      <div class="my-wave-orb mode-${mode} my-wave-orb--hero ${_myWaveBuilding || _myWavePreloading ? 'is-loading' : ''}" aria-label="${modeCfg.label}">
        <div class="my-wave-orb-ring"></div>
        <div class="my-wave-orb-core my-wave-orb-core--hero"></div>
        ${myWaveFineLinesLayerHtml()}
        <div class="my-wave-orb-overlay">
          <div class="my-wave-overlay-top">
            <button type="button" class="my-wave-glass-btn my-wave-glass-btn--play my-wave-glass-btn--inorb" onclick="toggleMyWaveOrbPlayback()" aria-label="Плей / пауза">${orbPlayInner}</button>
            <span class="my-wave-inline-title my-wave-inline-title--inorb">Моя волна</span>
          </div>
          <div class="my-wave-settings-dock-wrap">
            <button type="button" class="my-wave-settings-rect" onclick="openMyWaveSettingsFromStack('main')" title="Настройки волны">Настройки</button>
            <div id="my-wave-source-slot" class="my-wave-source-slot my-wave-source-slot--wave-dock"></div>
          </div>
        </div>
      </div>
    </div>
  `
  const mainWaveSlot = document.getElementById('my-wave-source-slot')
  if (mainWaveSlot) renderMyWaveSourceSlotInto(mainWaveSlot)
  renderRoomsMyWave()
  toggleYandexWaveMoodDockPanel(false)
  try {
    if (typeof hydrateFlowLucideIcons === 'function') {
      const w = document.getElementById('my-wave')
      if (w) hydrateFlowLucideIcons(w)
    }
  } catch (_) {}
  refreshHomeDashboardLayoutAfterContentChange()
}

function renderRoomsMyWave() {
  const hintEl = document.getElementById('rooms-wave-hint')
  const modesEl = document.getElementById('rooms-wave-modes')
  const listEl = document.getElementById('rooms-wave-list')
  if (!modesEl || !listEl) return
  if (hintEl) {
    hintEl.textContent = ''
    hintEl.classList.add('hidden')
    hintEl.style.display = 'none'
    hintEl.setAttribute('aria-hidden', 'true')
  }
  const mode = getMyWaveMode()
  const modeCfg = WE?.MY_WAVE_MODES?.[mode] || WE?.MY_WAVE_MODES?.default
  modesEl.innerHTML = ''
  modesEl.style.display = 'none'
  const roomsOrbPlayInner = (() => {
    try {
      const playing = Boolean(audio && !audio.paused && !audio.ended && queueScope === 'myWave')
      return playing
        ? `<svg class="my-wave-orb-play-svg" viewBox="0 0 24 24" aria-hidden="true">${PM_PAUSE_INNER}</svg>`
        : `<svg class="my-wave-orb-play-svg" viewBox="0 0 24 24" aria-hidden="true">${PM_PLAY_INNER}</svg>`
    } catch (_) {
      return `<svg class="my-wave-orb-play-svg" viewBox="0 0 24 24" aria-hidden="true">${PM_PLAY_INNER}</svg>`
    }
  })()
  listEl.innerHTML = `
    <div class="my-wave-visual-stack my-wave-visual-stack--rooms">
      <div class="my-wave-orb mode-${mode} my-wave-orb--hero my-wave-orb--rooms ${_myWaveBuilding || _myWavePreloading ? 'is-loading' : ''}" aria-label="${modeCfg.label}">
        <div class="my-wave-orb-ring"></div>
        <div class="my-wave-orb-core my-wave-orb-core--hero"></div>
        ${myWaveFineLinesLayerHtml()}
        <div class="my-wave-orb-overlay">
          <div class="my-wave-overlay-top">
            <button type="button" class="my-wave-glass-btn my-wave-glass-btn--play my-wave-glass-btn--inorb" onclick="toggleMyWaveOrbPlayback()" aria-label="Плей / пауза">${roomsOrbPlayInner}</button>
            <span class="my-wave-inline-title my-wave-inline-title--inorb">Моя волна</span>
          </div>
          <div class="my-wave-settings-dock-wrap">
            <button type="button" class="my-wave-settings-rect" onclick="openMyWaveSettingsFromStack('rooms')" title="Настройки волны">Настройки</button>
            <div id="rooms-wave-source-slot" class="my-wave-source-slot my-wave-source-slot--wave-dock"></div>
          </div>
        </div>
      </div>
    </div>
  `
  const roomsWaveSlot = document.getElementById('rooms-wave-source-slot')
  if (roomsWaveSlot) renderMyWaveSourceSlotInto(roomsWaveSlot)
  toggleYandexWaveMoodDockPanel(false)
  try {
    if (typeof hydrateFlowLucideIcons === 'function') {
      const box = document.querySelector('.rooms-wave-my-wave')
      if (box) hydrateFlowLucideIcons(box)
    }
  } catch (_) {}
}

function playTrackFromMyWave(index) {
  const i = Number(index)
  const track = Number.isInteger(i) ? _myWaveRenderedTracks[i] : null
  if (!track) return
  queue = _myWaveRenderedTracks.slice()
  queueIndex = i
  queueScope = 'myWave'
  playTrackObj(track).catch(() => {})
}

function saveListenStats(patch = {}) {
  if (!ensureActiveProfile()?.username) return
  const key = `flow_listen_stats_${_profile.username}`
  const next = Object.assign(getListenStats(), patch || {})
  localStorage.setItem(key, JSON.stringify(next))
  scheduleProfileCloudSync()
}

function flushListenStatsPending(force = false) {
  const pending = Number(_listenStatsPendingSec || 0)
  if (!force && pending < 0.9) return
  if (pending <= 0) return
  const st = getListenStats()
  saveListenStats({ totalSeconds: Number(st.totalSeconds || 0) + pending })
  _listenStatsPendingSec = 0
  _listenStatsLastFlushAt = Date.now()
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

function normalizeProfileColor(value = '') {
  const raw = String(value || '').trim()
  return /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : ''
}

function hexToRgb(hex = '') {
  const safe = normalizeProfileColor(hex)
  if (!safe) return null
  return {
    r: parseInt(safe.slice(1, 3), 16),
    g: parseInt(safe.slice(3, 5), 16),
    b: parseInt(safe.slice(5, 7), 16),
  }
}

function applyProfileColorTheme(profileColor = '') {
  const page = document.getElementById('page-profile')
  if (!page) return false
  const rgb = hexToRgb(profileColor)
  if (!rgb) return false
  const { r, g, b } = rgb
  page.style.setProperty('--profile-banner-c1', `rgba(${r},${g},${b},0.24)`)
  page.style.setProperty('--profile-banner-c2', `rgba(${Math.min(255, Math.round(r * 0.7 + 48))},${Math.min(255, Math.round(g * 0.7 + 48))},${Math.min(255, Math.round(b * 0.7 + 70))},0.18)`)
  page.style.setProperty('--profile-accent', profileColor)
  return true
}

async function applyProfileBannerTheme(bannerData, profileColor = '') {
  const page = document.getElementById('page-profile')
  if (!page) return
  if (applyProfileColorTheme(profileColor)) return
  if (!bannerData) {
    page.style.setProperty('--profile-banner-c1', 'rgba(124,58,237,0.16)')
    page.style.setProperty('--profile-banner-c2', 'rgba(59,130,246,0.14)')
    page.style.setProperty('--profile-accent', 'var(--accent2)')
    return
  }
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image()
      el.crossOrigin = 'anonymous'
      el.onload = () => resolve(el)
      el.onerror = reject
      el.src = bannerData
    })
    const c = document.createElement('canvas')
    c.width = 12
    c.height = 12
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    ctx.drawImage(img, 0, 0, c.width, c.height)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let r = 0; let g = 0; let b = 0; let n = 0
    for (let i = 0; i < d.length; i += 16) {
      r += d[i]; g += d[i + 1]; b += d[i + 2]; n++
    }
    if (!n) return
    r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n)
    const c1 = `rgba(${r},${g},${b},0.20)`
    const c2 = `rgba(${Math.min(255, Math.round(r * 0.75 + 38))},${Math.min(255, Math.round(g * 0.75 + 54))},${Math.min(255, Math.round(b * 0.75 + 84))},0.16)`
    page.style.setProperty('--profile-banner-c1', c1)
    page.style.setProperty('--profile-banner-c2', c2)
    page.style.setProperty('--profile-accent', `rgb(${r},${g},${b})`)
  } catch {}
}

function resolvePeerAvatarByUsername(username = '') {
  const safe = String(username || '').trim().toLowerCase()
  if (!safe) return null
  const remote = Array.from(_peerProfiles.values()).find((p) => String(p?.username || '').trim().toLowerCase() === safe)
  if (remote?.avatarData) return remote.avatarData
  const cached = getCachedPeerProfile(safe)
  if (cached?.avatarData) return cached.avatarData
  const key = `flow_profile_custom_${safe}`
  try {
    const data = JSON.parse(localStorage.getItem(key) || '{}')
    return data?.avatarData || null
  } catch {
    return null
  }
}

/** Ключ источника для класса `.track-source-*` и таблицы подписей (ya/ym → yandex). */
function trackSourceBadgeKey(source) {
  const s = String(source || '').toLowerCase()
  if (s === 'ya' || s === 'ym') return 'yandex'
  return s
}

/** Бейдж как на карточках треков: SC / Ya и т.д. (цвета в styles.css). */
function profileListeningSourcePillHtml(trackHint) {
  const LABELS = { soundcloud: 'SC', vk: 'VK', youtube: 'YT', spotify: 'SP', yandex: 'Ян' }
  const raw = trackHint && typeof trackHint.source === 'string' ? trackHint.source : ''
  const src = raw ? trackSourceBadgeKey(raw) : ''
  if (!src || !LABELS[src]) {
    return '<span class="flow-profile-src-badge flow-profile-src-badge--muted">SC</span>'
  }
  return `<span class="track-source track-source-${src} flow-profile-src-badge">${LABELS[src]}</span>`
}

/** @param {object|null} trackHint — нужен ли source для бейджа (плеер без трека → приглушённый SC). */
function flowProfileListeningBrandHtml(trackHint) {
  const pill = profileListeningSourcePillHtml(trackHint)
  return `<div class="flow-profile-listening-head">
    <span class="flow-profile-listening-brand-slot">${pill}</span>
    <span class="flow-profile-listening-caption">LISTENING TO NEXORY</span>
  </div>`
}

/** Карточка «Listening to Nexory» (аналог отдельного UI-компонента): обложка, прогресс, индикатор в углу. */
function buildProfileActivityCardHtml(track, progressPct, coverDomId) {
  const pct = Math.max(0, Math.min(100, Number(progressPct) || 0))
  const corner = '<span class="flow-profile-activity-corner-dot" aria-hidden="true"></span>'
  if (!track || !track.title) {
    return `${corner}${flowProfileListeningBrandHtml(null)}<div class="flow-profile-listening-empty"><span class="flow-profile-listening-dot"></span><span>Сейчас ничего не играет</span></div>`
  }
  const idAttr = coverDomId ? ` id="${coverDomId}"` : ''
  return `${corner}${flowProfileListeningBrandHtml(track)}
    <div class="flow-profile-listening-body">
      <div class="flow-profile-listening-cover"${idAttr}></div>
      <div class="flow-profile-listening-meta">
        <p class="flow-profile-listening-title">${escapeHtml(track.title)}</p>
        <span class="flow-profile-listening-artist">${escapeHtml(track.artist || '—')}</span>
        <div class="flow-profile-listening-bar">
          <span class="flow-profile-listening-bar-fill" style="width:${pct}%"></span>
          <span class="flow-profile-listening-knob" style="left:${pct}%"></span>
        </div>
      </div>
    </div>`
}

function stringifyFlowProfileListeningPanel(track, progressPct, coverDomId) {
  return buildProfileActivityCardHtml(track, progressPct, coverDomId)
}

/** @param {object|null} track @param {{ panel?: boolean }} [opts] */
function formatFlowProfileFavoriteSongHtml(track, opts = {}) {
  const usePanel = opts.panel !== false
  const pc = usePanel ? ' flow-profile-favorite--panel' : ''
  if (!track || !track.title) {
    return `<div class="flow-profile-favorite flow-profile-favorite--empty${pc}"><span class="flow-profile-favorite-label">Favorite song</span><span class="flow-profile-favorite-empty-note">—</span></div>`
  }
  const cover = getListCoverUrl(track) || getEffectiveCoverUrl(track) || ''
  const thumb = cover
    ? `<div class="flow-profile-favorite-thumb" style="background-image:url(${cover})"></div>`
    : `<div class="flow-profile-favorite-thumb flow-profile-favorite-thumb--ph">♪</div>`
  return `<div class="flow-profile-favorite${pc}"><span class="flow-profile-favorite-label">Favorite song</span><div class="flow-profile-favorite-row">${thumb}<div class="flow-profile-favorite-meta"><span class="flow-profile-favorite-title">${escapeHtml(track.title)}</span><span class="flow-profile-favorite-artist">${escapeHtml(track.artist || '—')}</span></div></div></div>`
}

function buildFlowProfileFriendsStripHtml(usernames) {
  const list = Array.isArray(usernames) ? usernames.map((x) => String(x || '').trim()).filter(Boolean) : []
  if (!list.length) return '<div class="flow-profile-friends-empty">Пока нет друзей</div>'
  return list
    .map((f) => {
      const av = resolvePeerAvatarByUsername(f)
      const face = av
        ? `<div class="flow-profile-friend-face" style="background-image:url(${av})"></div>`
        : `<div class="flow-profile-friend-face">${escapeHtml(f.slice(0, 1).toUpperCase())}</div>`
      return `<button type="button" class="flow-profile-friend-chip" onclick="openPeerProfile(${JSON.stringify(f)},'')">${face}<span>${escapeHtml(f)}</span></button>`
    })
    .join('')
}

function getFlowProfileBadgeStripHtml() {
  const flowIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 2l2.2 6.8H21l-5.5 4 2.1 6.5L12 15.2 6.4 19.3l2.1-6.5L3 8.8h6.8L12 2z"/></svg>`
  const trophyIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 21h8M12 17v4M6 3h12v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V3z"/><path d="M6 5H4a2 2 0 0 0 0 4h2M18 5h2a2 2 0 0 1 0 4h-2"/></svg>`
  const gemIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3l8 9-8 9-8-9 8-9z"/><path d="M4 12h16"/></svg>`
  const gearIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>`
  return `<span class="flow-profile-badge-chip" title="Nexory">${flowIcon}</span><span class="flow-profile-badge-chip">${trophyIcon}</span><span class="flow-profile-badge-chip">${gemIcon}</span><span class="flow-profile-badge-chip">${gearIcon}</span>`
}

function injectFlowProfileBadgeRow(el) {
  if (!el) return
  el.innerHTML = getFlowProfileBadgeStripHtml()
}

function renderProfileNowPlaying() {
  const box = document.getElementById('profile-now-playing')
  if (!box) return
  const duration = Number(audio?.duration || 0)
  const current = Number(audio?.currentTime || 0)
  const progress = duration > 0 ? (current / duration) * 100 : 0
  const coverId = 'profile-flow-listening-cover'
  const hasTrack = Boolean(currentTrack?.title)
  box.classList.toggle('flow-profile-activity-idle', !hasTrack)
  box.innerHTML = buildProfileActivityCardHtml(currentTrack, progress, hasTrack ? coverId : null)
  if (currentTrack && hasTrack) {
    const coverEl = document.getElementById(coverId)
    if (coverEl) {
      applyCoverArt(
        coverEl,
        getEffectiveCoverUrl(currentTrack),
        currentTrack.bg || 'linear-gradient(135deg,#7c3aed,#a855f7)',
      )
    }
  }
}

/** Только полоска прогресса на профиле — без innerHTML и без applyCoverArt (раньше это делалось из timeupdate ~11 раз/с). */
function patchProfileNowPlayingProgress() {
  if (_activePageId !== 'profile' || !currentTrack?.title) return
  const box = document.getElementById('profile-now-playing')
  if (!box || box.classList.contains('flow-profile-activity-idle')) return
  const duration = Number(audio?.duration || 0)
  const current = Number(audio?.currentTime || 0)
  const pct = Math.max(0, Math.min(100, duration > 0 ? (current / duration) * 100 : 0))
  const fill = box.querySelector('.flow-profile-listening-bar-fill')
  const knob = box.querySelector('.flow-profile-listening-knob')
  if (fill) fill.style.width = `${pct}%`
  if (knob) knob.style.left = `${pct}%`
}

function renderProfilePage() {
  if (!_profile?.username) return
  const custom = getProfileCustom()
  const banner = document.getElementById('profile-banner')
  const avatar = document.getElementById('profile-avatar-large')
  const displayName = document.getElementById('profile-display-name')
  const handleLine = document.getElementById('profile-handle-line')
  const badgeRow = document.getElementById('profile-badge-row')
  const favSlot = document.getElementById('profile-favorite-song')
  const bio = document.getElementById('profile-bio')
  const friendsEl = document.getElementById('profile-friends-list')
  if (banner) {
    if (custom.bannerData) {
      banner.style.backgroundImage = `linear-gradient(0deg, rgba(8,10,16,.32), rgba(8,10,16,.28)), url(${custom.bannerData})`
    } else {
      banner.style.backgroundImage =
        'linear-gradient(135deg, rgba(124,58,237,0.42), rgba(59,130,246,0.32)), linear-gradient(180deg, rgba(12,14,22,0.05) 0%, rgba(8,10,16,0.82) 100%)'
    }
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
  const bubbleEl = document.getElementById('profile-thought-bubble')
  if (bubbleEl) {
    const tb = String(custom.thoughtBubble || '').trim()
    if (tb) {
      bubbleEl.textContent = tb
      bubbleEl.classList.remove('flow-profile-thought-bubble--hidden')
      bubbleEl.setAttribute('aria-hidden', 'false')
    } else {
      bubbleEl.textContent = ''
      bubbleEl.classList.add('flow-profile-thought-bubble--hidden')
      bubbleEl.setAttribute('aria-hidden', 'true')
    }
  }
  const presDot = document.getElementById('profile-avatar-presence-dot')
  if (presDot) {
    const selfOnline = Boolean(_socialPeer)
    presDot.classList.toggle('flow-profile-online-dot--offline', !selfOnline)
  }
  if (displayName) displayName.textContent = _profile.username
  if (handleLine) handleLine.textContent = `@${_profile.username} • custom`
  injectFlowProfileBadgeRow(badgeRow)
  if (favSlot) favSlot.innerHTML = formatFlowProfileFavoriteSongHtml(custom.pinnedTracks?.[0] || null)
  if (bio) bio.textContent = custom.bio || 'Описание отсутствует'
  applyProfileBannerTheme(custom.bannerData, custom.profileColor).catch?.(() => {})
  renderProfileNowPlaying()
  if (friendsEl) {
    const friends = typeof peerSocial.getFriends === 'function' ? peerSocial.getFriends(_profile.username) : []
    friendsEl.innerHTML = buildFlowProfileFriendsStripHtml(friends)
  }
  syncProfileEditModal()
}

function syncProfileEditModal() {
  const modal = document.getElementById('profile-edit-modal')
  if (!modal || modal.classList.contains('hidden')) return
  const draft = _profileEditDraft || getProfileCustom()
  const avatar = document.getElementById('profile-edit-avatar-preview')
  const banner = document.getElementById('profile-edit-banner-preview')
  const bio = document.getElementById('profile-edit-bio')
  const thoughtBubbleInp = document.getElementById('profile-edit-thought-bubble')
  const colorPreview = document.getElementById('profile-edit-color-preview')
  const colorText = document.getElementById('profile-edit-color-text')
  const safeColor = normalizeProfileColor(draft.profileColor || '') || '#9ca3af'
  modal.style.setProperty('--profile-edit-accent', safeColor)
  if (avatar) {
    avatar.textContent = draft.avatarData ? '' : String(_profile?.username || '?').slice(0, 1).toUpperCase()
    avatar.style.backgroundImage = draft.avatarData ? `url(${draft.avatarData})` : ''
  }
  if (banner) {
    banner.style.backgroundImage = draft.bannerData
      ? `linear-gradient(0deg, rgba(8,10,16,.28), rgba(8,10,16,.28)), url(${draft.bannerData})`
      : 'linear-gradient(135deg, rgba(59,130,246,.24), rgba(139,92,246,.22))'
  }
  if (bio && document.activeElement !== bio) bio.value = draft.bio || ''
  if (thoughtBubbleInp && document.activeElement !== thoughtBubbleInp) thoughtBubbleInp.value = draft.thoughtBubble || ''
  if (colorPreview) colorPreview.style.setProperty('--profile-edit-accent', safeColor)
  if (colorText && document.activeElement !== colorText) colorText.value = normalizeProfileColor(draft.profileColor || '')
  document.querySelectorAll('.profile-color-swatch').forEach((btn) => {
    btn.classList.toggle('active', String(btn.dataset.color || '').toLowerCase() === safeColor)
  })
}

function openProfileEditModal() {
  if (!_profile?.username) return showToast('Сначала войди в профиль', true)
  _profileEditDraft = Object.assign({}, getProfileCustom())
  const modal = document.getElementById('profile-edit-modal')
  const name = document.getElementById('profile-edit-username')
  if (name) name.textContent = _profile.username
  modal?.classList.remove('hidden')
  syncProfileEditModal()
}

function closeProfileEditModal() {
  const modal = document.getElementById('profile-edit-modal')
  if (modal) modal.classList.add('hidden')
  _profileEditDraft = null
}

function setProfileEditDraft(patch = {}) {
  _profileEditDraft = Object.assign({}, _profileEditDraft || getProfileCustom(), patch || {})
  syncProfileEditModal()
}

async function pickProfileEditImage(kind) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*,.gif'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    const dataUrl = await readFileAsDataUrl(file).catch(() => '')
    const prepared = await prepareProfileImageData(file, dataUrl, kind).catch(() => dataUrl)
    if (!prepared) return showToast(kind === 'avatar' ? 'Не удалось загрузить аватар' : 'Не удалось загрузить баннер', true)
    setProfileEditDraft(kind === 'avatar' ? { avatarData: prepared } : { bannerData: prepared })
  }
  input.click()
}

function clearProfileEditImage(kind) {
  setProfileEditDraft(kind === 'avatar' ? { avatarData: null } : { bannerData: null })
}

function setProfileEditColor(value) {
  const raw = String(value || '').trim()
  const normalized = normalizeProfileColor(raw)
  setProfileEditDraft({ profileColor: normalized })
}

async function submitProfileEditModal() {
  if (!_profile?.username) return
  const bio = document.getElementById('profile-edit-bio')
  const thoughtBubbleInp = document.getElementById('profile-edit-thought-bubble')
  const colorText = document.getElementById('profile-edit-color-text')
  const draft = Object.assign({}, _profileEditDraft || getProfileCustom(), {
    bio: String(bio?.value || '').trim().slice(0, 180),
    thoughtBubble: String(thoughtBubbleInp?.value || '').trim().slice(0, 48),
    profileColor: normalizeProfileColor(colorText?.value || _profileEditDraft?.profileColor || ''),
  })
  saveProfileCustom(draft)
  syncProfileUi()
  renderProfilePage()
  scheduleProfileCloudSync()
  const result = await syncProfileCloudNow().catch((err) => ({ ok: false, error: err?.message || String(err) }))
  renderFriends().catch(() => {})
  pollFriendsPresence(true).catch(() => {})
  if (!result?.ok) return showToast(`Профиль сохранён локально, но сервер не ответил: ${result?.error || 'ошибка'}`, true)
  closeProfileEditModal()
  showToast('Профиль сохранён и синхронизирован с сервером')
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
    const prepared = await prepareProfileImageData(file, dataUrl, 'avatar').catch(() => dataUrl)
    saveProfileCustom({ avatarData: prepared })
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
    const prepared = await prepareProfileImageData(file, dataUrl, 'banner').catch(() => dataUrl)
    saveProfileCustom({ bannerData: prepared })
    renderProfilePage()
  }
  input.click()
}

function clearProfileAvatar() {
  saveProfileCustom({ avatarData: null })
  syncProfileUi()
  renderProfilePage()
  showToast('Аватар удалён')
}

function clearProfileBanner() {
  saveProfileCustom({ bannerData: null })
  renderProfilePage()
  showToast('Баннер удалён')
}

function editProfileBio() {
  openProfileEditModal()
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
  _playlistPickerSelection = new Set()
  const modal = document.getElementById('playlist-picker-modal')
  const title = document.getElementById('playlist-picker-title')
  const list = document.getElementById('playlist-picker-list')
  const createRow = document.getElementById('playlist-picker-create-row')
  const applyBtn = document.getElementById('playlist-picker-apply-btn')
  if (!modal || !title || !list || !createRow || !applyBtn) return
  title.textContent = ctx?.title || 'Выбери'
  list.innerHTML = ''
  createRow.style.display = ctx?.mode === 'add-track-playlist' ? 'flex' : 'none'
  applyBtn.style.display = ctx?.multi ? 'inline-flex' : 'none'
  ;(ctx?.items || []).forEach((item) => {
    const btn = document.createElement('button')
    btn.className = 'profile-picker-item'
    if (ctx?.multi) {
      btn.innerHTML = `<span style="opacity:.92">${item.label}</span><span class="profile-chip" data-picked="0">○</span>`
      btn.style.display = 'flex'
      btn.style.justifyContent = 'space-between'
      btn.style.alignItems = 'center'
      btn.addEventListener('click', () => togglePlaylistPickerSelection(item.id))
    } else {
      btn.textContent = item.label
      btn.addEventListener('click', () => submitPlaylistPicker(item.id))
    }
    btn.dataset.pickId = String(item.id)
    list.appendChild(btn)
  })
  modal.classList.remove('hidden')
}

function closePlaylistPickerModal() {
  const modal = document.getElementById('playlist-picker-modal')
  if (modal) modal.classList.add('hidden')
  _playlistPickerSelection = new Set()
  _playlistPickerContext = null
}

function togglePlaylistPickerSelection(itemId) {
  const id = String(itemId)
  if (_playlistPickerSelection.has(id)) _playlistPickerSelection.delete(id)
  else _playlistPickerSelection.add(id)
  const list = document.getElementById('playlist-picker-list')
  if (!list) return
  const rows = Array.from(list.querySelectorAll('.profile-picker-item'))
  const row = rows.find((el) => String(el.dataset.pickId || '') === id)
  if (!row) return
  const chip = row.querySelector('[data-picked]')
  const selected = _playlistPickerSelection.has(id)
  if (chip) chip.textContent = selected ? '●' : '○'
  row.classList.toggle('active', selected)
}

function applyPlaylistPickerSelection() {
  const ctx = _playlistPickerContext
  if (!ctx || !ctx.multi) return
  const ids = Array.from(_playlistPickerSelection)
  if (!ids.length) return showToast('Выбери минимум один трек', true)
  if (ctx.mode === 'room-own-liked-track-multi' || ctx.mode === 'room-own-playlist-track-multi') {
    const tracks = ctx.payload?.tracks || []
    let added = 0
    ids.forEach((id) => {
      const idx = Number(id)
      const track = tracks[idx]
      if (!track) return
      enqueueSharedTrack(track)
      added++
    })
    closePlaylistPickerModal()
    showToast(`Добавлено в очередь: ${added}`)
    return
  }
  closePlaylistPickerModal()
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
      const rest = (Array.isArray(custom.pinnedTracks) ? custom.pinnedTracks : []).filter(
        (t) => `${t.source}:${t.id}` !== key,
      )
      const next = [track, ...rest].slice(0, 8)
      saveProfileCustom({ pinnedTracks: next })
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
        mode: 'room-own-liked-track-multi',
        title: 'Выбери треки из любимых',
        multi: true,
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
        mode: 'room-own-playlist-track-multi',
        title: `Треки: ${playlist.name}`,
        multi: true,
        items: playlist.tracks.map((t, tIdx) => ({ id: String(tIdx), label: `${t.title} — ${t.artist || '—'}` })),
        payload: { tracks: playlist.tracks }
      })
      return
    }
  } else if (ctx.mode === 'room-own-liked-track-multi') {
    return
  } else if (ctx.mode === 'room-own-playlist-track-multi') {
    return
  } else if (ctx.mode === 'room-own-playlist-track') {
    const idx = Number(selectedId)
    const track = ctx.payload?.tracks?.[idx]
    if (track) enqueueSharedTrack(track)
  } else if (ctx.mode === 'room-invite-friend') {
    const username = String(selectedId || '').trim()
    if (username) {
      const state = _friendPresence.get(username.toLowerCase()) || {}
      sendRoomInviteToFriend(username, state.peerId || `flow-${username}`)
    }
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
    el.innerHTML = '<div class="flow-empty-state compact"><strong>Любимых треков нет</strong><span>Добавь треки в профиль из меню редактирования.</span></div>'
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
    el.innerHTML = '<div class="flow-empty-state compact"><strong>Плейлисты не закреплены</strong><span>Закрепи плейлист, чтобы он появился в профиле.</span></div>'
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

function ensureFriendInteractionUI() {
  if (!document.getElementById('friend-context-menu')) {
    const menu = document.createElement('div')
    menu.id = 'friend-context-menu'
    menu.className = 'friend-context-menu hidden glass-card'
    menu.innerHTML = `
      <button class="friend-context-item" onclick="friendMenuOpenProfile()">Зайти в профиль</button>
      <button class="friend-context-item" onclick="friendMenuJoinRoom()">Присоединиться к руме</button>
      <button class="friend-context-item" onclick="friendMenuInviteRoom()">Пригласить в комнату</button>
      <button class="friend-context-item" onclick="friendMenuRefresh()">Обновить</button>
      <button class="friend-context-item danger" onclick="friendMenuRemoveFriend()">Удалить из друзей</button>
    `
    document.body.appendChild(menu)
    document.addEventListener('click', () => closeFriendContextMenu())
  }
  if (!document.getElementById('room-member-context-menu')) {
    const menu = document.createElement('div')
    menu.id = 'room-member-context-menu'
    menu.className = 'friend-context-menu hidden glass-card'
    menu.innerHTML = `
      <button class="friend-context-item" onclick="transferRoomHostFromMenu()">Передать хоста</button>
    `
    document.body.appendChild(menu)
    document.addEventListener('click', () => closeRoomMemberContextMenu())
  }
  if (!document.getElementById('room-invite-popup')) {
    const modal = document.createElement('div')
    modal.id = 'room-invite-popup'
    modal.className = 'flow-modal hidden'
    modal.innerHTML = `
      <div class="flow-modal-backdrop" onclick="declineRoomInvite(false)"></div>
      <div class="flow-modal-card glass-card">
        <h3>Приглашение в руму</h3>
        <p id="room-invite-text" style="margin-top:8px;opacity:.9">Друг приглашает тебя в руму</p>
        <label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;opacity:.9">
          <input type="checkbox" id="room-invite-mute15" />
          Отклонить и не получать приглашения 15 минут
        </label>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
          <button class="btn-small" onclick="declineRoomInvite(true)">Отклонить</button>
          <button class="btn-small" onclick="acceptRoomInvite()">Присоединиться</button>
        </div>
      </div>
    `
    document.body.appendChild(modal)
  }
  if (!document.getElementById('playlist-card-context-menu')) {
    const menu = document.createElement('div')
    menu.id = 'playlist-card-context-menu'
    menu.className = 'friend-context-menu hidden glass-card'
    menu.innerHTML = `
      <button type="button" class="friend-context-item" onclick="playlistCardCtxExportJson()">Экспорт JSON</button>
      <button type="button" class="friend-context-item" onclick="playlistCardCtxEdit()">Изменить</button>
      <button type="button" class="friend-context-item danger" onclick="playlistCardCtxDelete()">Удалить</button>
    `
    document.body.appendChild(menu)
    document.addEventListener('click', () => closePlaylistCardContextMenu())
  }
}

let _playlistCardCtxIdx = -1

function closePlaylistCardContextMenu() {
  document.getElementById('playlist-card-context-menu')?.classList.add('hidden')
  _playlistCardCtxIdx = -1
}

function openPlaylistCardContextMenu(event, idx) {
  event?.preventDefault?.()
  event?.stopPropagation?.()
  ensureFriendInteractionUI()
  const menu = document.getElementById('playlist-card-context-menu')
  if (!menu) return
  _playlistCardCtxIdx = Number(idx)
  menu.style.left = `${Math.max(8, Number(event?.clientX || 0))}px`
  menu.style.top = `${Math.max(8, Number(event?.clientY || 0))}px`
  menu.classList.remove('hidden')
}

function playlistCardCtxEdit() {
  const i = Number(_playlistCardCtxIdx)
  closePlaylistCardContextMenu()
  if (!Number.isFinite(i) || i < 0) return
  editPlaylistMeta(i)
}

function playlistCardCtxDelete() {
  const i = Number(_playlistCardCtxIdx)
  closePlaylistCardContextMenu()
  if (!Number.isFinite(i) || i < 0) return
  deletePlaylist(i)
}

function exportPlaylistToJsonFile(playlistIndex) {
  const idx = Number(playlistIndex)
  const pls = getPlaylists()
  if (!Number.isFinite(idx) || idx < 0 || idx >= pls.length) return showToast('Плейлист не найден', true)
  try {
    const pl = normalizePlaylist(pls[idx])
    const payload = {
      format: 'flow-playlists-v1',
      exportedAt: new Date().toISOString(),
      playlists: [pl],
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const stamp = String(pl.name || 'playlist').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 120) || 'playlist'
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `${stamp}.json`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(link.href)
    showToast('Плейлист экспортирован')
  } catch (err) {
    showToast(`Ошибка экспорта: ${err?.message || err}`, true)
  }
}

function exportOpenPlaylistJson() {
  if (openPlaylistIndex == null) return showToast('Плейлист не выбран', true)
  exportPlaylistToJsonFile(openPlaylistIndex)
}

function playlistCardCtxExportJson() {
  const i = Number(_playlistCardCtxIdx)
  closePlaylistCardContextMenu()
  if (!Number.isFinite(i) || i < 0) return
  exportPlaylistToJsonFile(i)
}

window.playlistCardCtxEdit = playlistCardCtxEdit
window.playlistCardCtxDelete = playlistCardCtxDelete
window.playlistCardCtxExportJson = playlistCardCtxExportJson
window.exportPlaylistToJsonFile = exportPlaylistToJsonFile
window.exportOpenPlaylistJson = exportOpenPlaylistJson
window.openPlaylistCardContextMenu = openPlaylistCardContextMenu

function openRoomMemberContextMenu(event, peerId = '', username = '') {
  event?.preventDefault?.()
  event?.stopPropagation?.()
  ensureFriendInteractionUI()
  const menu = document.getElementById('room-member-context-menu')
  if (!menu) return
  _roomContext = { peerId: String(peerId || '').trim(), username: String(username || '').trim() }
  menu.style.left = `${Math.max(8, Number(event?.clientX || 0))}px`
  menu.style.top = `${Math.max(8, Number(event?.clientY || 0))}px`
  menu.classList.remove('hidden')
}

function closeRoomMemberContextMenu() {
  document.getElementById('room-member-context-menu')?.classList.add('hidden')
}

function transferRoomHostFromMenu() {
  const ctx = _roomContext || {}
  closeRoomMemberContextMenu()
  transferRoomHost(ctx.peerId, ctx.username)
}

async function transferRoomHost(peerId = '', username = '') {
  const targetPeerId = String(peerId || '').trim()
  if (!_roomState?.roomId || !_roomState.host) return showToast('Передавать хоста может только текущий хост', true)
  if (!targetPeerId || targetPeerId === _socialPeer?.peer?.id) return showToast('Выбери другого участника', true)
  const prevHost = String(_socialPeer?.peer?.id || _roomState.hostPeerId || '')
  let transferredOnServer = false
  if (isFlowSocialReady()) {
    try {
      const rid = encodeURIComponent(String(_roomState.roomId || '').trim())
      const resp = await window.FlowSocialBackend.request('POST', `/flow-api/v1/rooms/${rid}/transfer-host`, {
        to_peer_id: targetPeerId,
        requested_by_peer_id: prevHost,
      })
      transferredOnServer = Boolean(resp?.ok)
    } catch (_) {}
  }
  _roomState.host = false
  _roomState.hostPeerId = targetPeerId
  _socialPeer?.sendToPeer?.(targetPeerId, { type: 'room-host-transfer', roomId: _roomState.roomId, hostPeerId: targetPeerId, sharedQueue })
  _socialPeer?.send?.({ type: 'room-host-changed', roomId: _roomState.roomId, hostPeerId: targetPeerId, username })
  if (!transferredOnServer) await saveRoomStateToServer({ host_peer_id: targetPeerId, shared_queue: sharedQueue }).catch(() => {})
  updateRoomUi()
  showToast(`Хост передан: ${username || targetPeerId.replace(/^flow-/, '')}`)
}

function openFriendContextMenu(event, username, peerId = '', roomId = '', online = false) {
  event?.preventDefault?.()
  event?.stopPropagation?.()
  ensureFriendInteractionUI()
  const menu = document.getElementById('friend-context-menu')
  if (!menu) return
  _friendContext = {
    username: String(username || ''),
    peerId: String(peerId || ''),
    roomId: String(roomId || ''),
    online: Boolean(online),
  }
  menu.style.left = `${Math.max(8, Number(event?.clientX || 0))}px`
  menu.style.top = `${Math.max(8, Number(event?.clientY || 0))}px`
  menu.classList.remove('hidden')
}

function closeFriendContextMenu() {
  const menu = document.getElementById('friend-context-menu')
  if (menu) menu.classList.add('hidden')
}

function friendMenuInviteRoom() {
  closeFriendContextMenu()
  if (!_friendContext?.username) return
  const un = String(_friendContext.username || '').trim().toLowerCase()
  if (!_friendPresence.get(un)?.online) {
    showToast('Пригласить можно только друга в сети', true)
    return
  }
  sendRoomInviteToFriend(_friendContext.username, _friendContext.peerId || _friendContext.roomId || '')
}

function friendMenuJoinRoom() {
  closeFriendContextMenu()
  const roomId = String(_friendContext?.roomId || '').trim()
  if (!roomId) return showToast('У друга сейчас нет активной румы', true)
  joinRoomById(roomId)
}

function friendMenuOpenProfile() {
  closeFriendContextMenu()
  if (!_friendContext?.username) return
  openPeerProfile(_friendContext.username, _friendContext.peerId || '')
}

async function friendMenuRefresh() {
  closeFriendContextMenu()
  if (!_friendContext?.username) return
  const username = String(_friendContext.username || '').trim().toLowerCase()
  if (!username) return
  if (_socialPeer?.requestPeerData && _friendContext.peerId) {
    const rsp = await _socialPeer.requestPeerData(_friendContext.peerId, { type: 'presence-request' }, 1300).catch(() => null)
    const profile = rsp?.ok ? rsp?.data?.profile : null
    if (profile) {
      const pid = rsp?.data?.peerId || _friendContext.peerId
      const merged = mergeProfileData(_peerProfiles.get(pid) || getCachedPeerProfile(username), Object.assign({}, profile, { peerId: pid }), pid)
      cachePeerProfile(merged, pid)
      _peerProfiles.set(pid, merged)
      if (_roomMembers.has(pid)) _roomMembers.set(pid, merged)
    }
    if (rsp?.ok) {
      const prev = _friendPresence.get(username) || {}
      _friendPresence.set(username, Object.assign({}, prev, {
        online: true,
        peerId: rsp?.data?.peerId || rsp?.data?._peerId || prev.peerId || _friendContext.peerId || `flow-${username}`,
        roomId: rsp?.data?.roomId || prev.roomId || null,
        host: Boolean(rsp?.data?.host),
        updatedAt: Date.now(),
      }))
    }
  }
  const cloud = await fetchCloudPublicProfile(username).catch(() => null)
  if (cloud) {
    const pid = _friendContext.peerId || `flow-${username}`
    const merged = mergeProfileData(_peerProfiles.get(pid) || getCachedPeerProfile(username), Object.assign({}, cloud, { peerId: pid }), pid)
    cachePeerProfile(merged, pid)
    _peerProfiles.set(pid, merged)
    if (_roomMembers.has(pid)) _roomMembers.set(pid, merged)
  }
  renderRoomMembers()
  renderFriends().catch(() => {})
  pollFriendsPresence(true).catch(() => {})
  const modal = document.getElementById('peer-profile-modal')
  if (modal && !modal.classList.contains('hidden')) {
    openPeerProfile(username, _friendContext.peerId || '').catch(() => {})
  }
  showToast('Профиль обновлён')
}

function friendMenuRemoveFriend() {
  closeFriendContextMenu()
  if (!_profile?.username || !_friendContext?.username || typeof peerSocial.removeFriend !== 'function') return
  const friend = String(_friendContext.username || '').trim().toLowerCase()
  if (!friend) return
  const ok = confirm(`Удалить ${friend} из друзей?`)
  if (!ok) return
  const result = peerSocial.removeFriend(_profile.username, friend)
  if (!result?.ok) return showToast(result?.error || 'Не удалось удалить друга', true)
  _friendPresence.delete(friend)
  const pid = String(_friendContext.peerId || `flow-${friend}`).trim()
  if (pid) {
    _peerProfiles.delete(pid)
    _roomMembers.delete(pid)
  }
  renderFriends().catch(() => {})
  renderRoomMembers()
  showToast(`${friend} удалён из друзей`)
}

function sendRoomInviteToFriend(username, peerId = '') {
  if (!_roomState?.roomId) return showToast('Сначала зайди в руму', true)
  const toPeer = String(peerId || `flow-${username}`).trim()
  if (!toPeer || !_socialPeer?.sendToPeer) return showToast('Друг офлайн', true)
  _socialPeer.sendToPeer(toPeer, {
    type: 'room-invite',
    roomId: _roomState.roomId,
    fromUsername: _profile?.username || 'user',
  })
  showToast(`Приглашение отправлено: ${username}`)
}

function openRoomInvitePicker() {
  if (!_profile?.username || !peerSocial.getFriends) return
  const friends = peerSocial.getFriends(_profile.username) || []
  const onlineFriends = friends.filter((name) => {
    const key = String(name || '').trim().toLowerCase()
    return key && (_friendPresence.get(key)?.online)
  })
  if (!onlineFriends.length) return showToast('Нет друзей в сети — пригласить можно только онлайн', true)
  openPlaylistPickerModal({
    mode: 'room-invite-friend',
    title: 'Пригласить в руму (только онлайн)',
    items: onlineFriends.map((name) => ({ id: String(name), label: `${name} • в сети` })),
    payload: {}
  })
}

function showRoomInvitePrompt(invite) {
  ensureFriendInteractionUI()
  _pendingRoomInvite = invite || null
  const popup = document.getElementById('room-invite-popup')
  const text = document.getElementById('room-invite-text')
  const mute = document.getElementById('room-invite-mute15')
  if (!popup || !text || !mute) return
  mute.checked = false
  text.textContent = `${invite?.fromUsername || 'Друг'} приглашает в руму ${invite?.roomId || ''}`
  popup.classList.remove('hidden')
}

function acceptRoomInvite() {
  const popup = document.getElementById('room-invite-popup')
  if (popup) popup.classList.add('hidden')
  const roomId = String(_pendingRoomInvite?.roomId || '').trim()
  _pendingRoomInvite = null
  if (roomId) joinRoomById(roomId)
}

function declineRoomInvite(withMuteChoice = true) {
  const popup = document.getElementById('room-invite-popup')
  if (popup) popup.classList.add('hidden')
  const fromUser = String(_pendingRoomInvite?.fromUsername || '').trim().toLowerCase()
  const mute = document.getElementById('room-invite-mute15')
  if (withMuteChoice && mute?.checked && fromUser) {
    muteInvitesFrom(fromUser, 15 * 60 * 1000)
    showToast('Приглашения от пользователя скрыты на 15 минут')
  }
  _pendingRoomInvite = null
}

function showOnboardingIfNeeded() {
  if (localStorage.getItem('flow_onboarding_done')) return
  const modal = document.createElement('div')
  modal.id = 'flow-onboarding-modal'
  modal.className = 'flow-modal flow-onboarding-modal'
  modal.innerHTML = `
    <div class="flow-modal-backdrop" onclick="finishOnboarding()"></div>
    <div class="flow-modal-card glass-card onboarding-card">
      <div class="onboarding-badge">Nexory старт</div>
      <h3>Добро пожаловать в Nexory</h3>
      <p>Пару важных вещей, чтобы у тебя и друзей всё работало без ручной настройки.</p>
      <div class="onboarding-grid">
        <div class="onboarding-item"><strong>Аккаунт</strong><span>Логин и пароль сохраняют профиль на сервере, поэтому очистка кэша больше не убивает аккаунт.</span></div>
        <div class="onboarding-item"><strong>Сервер</strong><span>Адрес уже стоит по умолчанию. Его можно поменять в Настройки → Интеграции.</span></div>
        <div class="onboarding-item"><strong>Комнаты</strong><span>Создавай руму, кидай invite другу и управляй очередью вместе.</span></div>
        <div class="onboarding-item"><strong>VK-импорт</strong><span>Сервер Nexory читает плейлист VK, а приложение ищет эти треки в твоих источниках.</span></div>
      </div>
      <div class="onboarding-actions">
        <button class="btn-small" onclick="openSettingsFromOnboarding()">Открыть настройки</button>
        <button class="btn-main" onclick="finishOnboarding()">Погнали</button>
      </div>
    </div>
  `
  document.body.appendChild(modal)
}

function finishOnboarding() {
  localStorage.setItem('flow_onboarding_done', '1')
  document.getElementById('flow-onboarding-modal')?.remove()
}

function openSettingsFromOnboarding() {
  finishOnboarding()
  showPage('settings')
  switchSettingsTab?.('integrations')
}

function ensureSocialUI() {
  ensureFriendInteractionUI()
  if (document.getElementById('social-hub')) return
  const root = document.getElementById('page-social-content')
  if (!root) return
  const box = document.createElement('div')
  box.id = 'social-hub'
  box.className = 'glass-card social-hub'
  box.style.padding = '14px'
  box.innerHTML = `
    <div class="social-head">
      <strong>Nexory Social (Cloud)</strong>
      <span id="social-status" class="social-status">offline</span>
    </div>
    <div class="social-add-box">
      <div class="social-section-title">Добавить друга</div>
      <input id="friend-search-input" class="token-field flow-input" placeholder="Username друга" style="flex:1;min-width:180px" />
      <button class="btn-small" onclick="addFriendByUsername()">Отправить запрос</button>
    </div>
    <div class="social-friends-box">
      <div class="social-section-title">Входящие заявки</div>
      <div id="friend-requests-list"><div class="flow-empty-state compact"><strong>Заявок нет</strong><span>Когда кто-то добавит тебя, запрос появится здесь.</span></div></div>
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
  box.className = 'glass-card social-hub rooms-liquid-hub'
  box.innerHTML = `
    <div class="room-connect-panel">
      <div id="social-widget" class="social-widget is-empty" onclick="handleSocialWidgetClick(event)" onkeydown="handleSocialWidgetKeydown(event)" role="button" tabindex="0">
        <div class="widget-placeholder">
          <span class="glow-text">Создать комнату</span>
        </div>
        <div class="widget-content">
          <div class="widget-members-area">
            <div class="widget-mini-head">
              <span class="social-section-title">В комнате</span>
              <span id="room-role-badge" class="room-role-badge room-role-solo">SOLO</span>
            </div>
            <div id="room-members-list" class="sidebar-users"><div class="flow-empty-state compact"><strong>Комната пустая</strong><span>Создай руму или присоединись по invite.</span></div></div>
          </div>
          <div class="actions-menu">
            <button class="action-btn invite" onclick="event.stopPropagation();openRoomInvitePicker()" title="Пригласить друга"><span>＋</span><small>Пригласить</small></button>
            <button class="action-btn noop" onclick="event.stopPropagation();showToast('Пока ничего')" title="Пока ничего"><span>ничего</span><small>Пока ничего</small></button>
            <button class="action-btn leave" onclick="event.stopPropagation();leaveRoom()" title="Покинуть группу"><span>✕</span><small>Покинуть</small></button>
          </div>
        </div>
      </div>
    </div>
    <div class="social-room-box rooms-search-tile">
      <div class="social-section-title">Поиск в очередь</div>
      <input id="room-queue-search" class="token-field flow-input" placeholder="Найти трек и добавить в очередь..." oninput="searchRoomQueueTracks()" />
      <div style="margin-top:8px"><button class="btn-small" onclick="openRoomOwnTracksPicker()">Свои треки</button></div>
      <div class="rooms-wave-embedded">
        <div class="my-wave rooms-wave-my-wave">
          <div class="my-wave-hero my-wave-hero--compact-title my-wave-hero--no-hint">
            <div class="my-wave-hero-top">
              <div class="my-wave-hero-copy">
                <p id="rooms-wave-hint" class="hidden" aria-hidden="true"></p>
              </div>
              <div class="my-wave-hero-trailing">
                <div id="rooms-yandex-wave-mood-dock" class="yandex-wave-mood-dock hidden" aria-label="Настроение волны Яндекса"></div>
              </div>
            </div>
            <div id="rooms-wave-modes" class="my-wave-modes hidden" aria-hidden="true" style="display:none"></div>
          </div>
          <div class="my-wave-list" id="rooms-wave-list"></div>
        </div>
      </div>
      <div id="room-search-results" class="profile-picker-list" style="margin-top:8px"><div class="flow-empty-state compact"><strong>Начни поиск</strong><span>Введи название трека, чтобы добавить его в очередь.</span></div></div>
    </div>
    <div class="social-room-box">
      <div class="social-section-title">Очередь прослушивания</div>
      <div id="room-now-playing" class="room-now-playing-line">Сейчас ничего не играет</div>
      <div id="room-queue-list"></div>
    </div>
  `
  root.appendChild(box)
  syncSocialWidgetState()
  renderRoomsMyWave()
}

async function renderFriends() {
  const el = document.getElementById('friends-list')
  if (!el || !_profile?.username || !peerSocial.getFriends) return
  renderFriendRequests().catch(() => {})
  const list = peerSocial.getFriends(_profile.username)
  if (!list.length) {
    el.innerHTML = '<div class="flow-empty-state"><strong>Пока нет друзей</strong><span>Добавь друга по username, чтобы видеть онлайн, профиль и комнаты.</span></div>'
    return
  }
  const online = []
  const offline = []
  list.forEach((name) => {
    const safe = String(name || '').trim().toLowerCase()
    const state = _friendPresence.get(safe) || { online: false }
    if (state.online) online.push({ name, state })
    else offline.push({ name, state })
  })
  const fmtFriendCard = (item, onlineMode) => {
    const avatar = resolvePeerAvatarByUsername(item.name)
    const roomId = item.state.roomId || ''
    const nowPlaying = onlineMode && item.state.track?.title
      ? `слушает: ${item.state.track.title}${item.state.track.artist ? ` — ${item.state.track.artist}` : ''}`
      : (onlineMode ? 'в сети' : 'не в сети')
    const avatarHtml = avatar
      ? `<div class="social-friend-avatar" style="background-image:url(${avatar})"></div>`
      : `<div class="social-friend-avatar">${item.name.slice(0, 1).toUpperCase()}</div>`
    return `
      <div class="social-friend-card ${onlineMode ? 'online' : 'offline'}" oncontextmenu="openFriendContextMenu(event, '${item.name}', '${item.state.peerId || ''}', '${roomId}', ${onlineMode ? 'true' : 'false'})">
        ${avatarHtml}
        <div class="social-friend-meta">
          <strong>${item.name}</strong>
          <span>${nowPlaying}</span>
        </div>
      </div>
    `
  }
  el.innerHTML = `
    <div class="social-friends-section-title">В сети</div>
    <div class="social-friends-grid">${online.length ? online.map((item) => fmtFriendCard(item, true)).join('') : '<div class="flow-empty-state compact"><strong>Никого онлайн</strong><span>Nexory покажет друга сразу, как он появится в сети.</span></div>'}</div>
    <div class="social-friends-section-title">Не в сети</div>
    <div class="social-friends-grid">${offline.length ? offline.map((item) => fmtFriendCard(item, false)).join('') : '<div class="flow-empty-state compact"><strong>Пусто</strong><span>Все друзья сейчас онлайн.</span></div>'}</div>
  `
}

let _socialLastOnlineAt = 0
/** Время успешного auth_ok по WS (соц-слой). */
let _lastWsAuthOkAt = 0
/** initPeerSocial → ready (профиль поднят). */
let _peerSocialReadyAt = 0

function setSocialStatus(text) {
  const el = document.getElementById('social-status')
  if (!el) return
  const raw = String(text || '').trim().toLowerCase()
  let state = 'degraded'
  let label = String(text || 'degraded')
  const now = Date.now()
  if (raw.startsWith('online')) {
    state = 'online'
    label = 'online'
    _socialLastOnlineAt = now
  } else if (raw.startsWith('connecting')) {
    if (_socialLastOnlineAt && (now - _socialLastOnlineAt) < 20000) {
      state = 'online'
      label = 'online'
    } else {
      state = 'connecting'
      label = 'connecting'
    }
  } else if (raw.startsWith('degraded')) {
    if (_socialLastOnlineAt && now - _socialLastOnlineAt < 120000) {
      state = 'online'
      label = 'online'
    } else {
      state = 'degraded'
      label = 'degraded'
    }
  } else if (raw.startsWith('error')) {
    state = 'degraded'
    label = `degraded (${String(text || '').replace(/^error:\s*/i, '')})`
  }
  el.textContent = label
  el.classList.remove('social-status--online', 'social-status--connecting', 'social-status--degraded')
  el.classList.add(`social-status--${state}`)
}

function setRoomStatus(text) {
  const el = document.getElementById('room-status')
  if (el) el.textContent = text
}

let _appUpdateState = {
  available: false,
  latestVersion: '',
  downloadedPath: '',
  checking: false,
  downloading: false,
}

function setAppUpdateStatus(text, mode = 'neutral') {
  const el = document.getElementById('app-update-status')
  if (!el) return
  el.textContent = String(text || '')
  el.classList.remove('app-update-status--checking', 'app-update-status--ready', 'app-update-status--error')
  if (mode === 'checking') el.classList.add('app-update-status--checking')
  if (mode === 'ready') el.classList.add('app-update-status--ready')
  if (mode === 'error') el.classList.add('app-update-status--error')
}

function updateAppUpdaterUiState() {
  const downloadBtn = document.getElementById('app-update-download-btn')
  const installBtn = document.getElementById('app-update-install-btn')
  if (downloadBtn) {
    downloadBtn.disabled = !_appUpdateState.available || _appUpdateState.downloading
    downloadBtn.textContent = _appUpdateState.downloading ? 'Скачиваю...' : 'Скачать'
  }
  if (installBtn) {
    installBtn.disabled = !_appUpdateState.downloadedPath
  }
}

async function checkAppUpdatesNow() {
  if (!window.api?.appUpdateCheck || _appUpdateState.checking) return
  _appUpdateState.checking = true
  setAppUpdateStatus('Проверяю stable-канал...', 'checking')
  updateAppUpdaterUiState()
  try {
    const result = await window.api.appUpdateCheck()
    if (!result?.ok) throw new Error(result?.error || 'update check failed')
    _appUpdateState.available = Boolean(result.available)
    _appUpdateState.latestVersion = String(result.latestVersion || '')
    _appUpdateState.downloadedPath = ''
    if (_appUpdateState.available) {
      setAppUpdateStatus(`Доступна версия ${_appUpdateState.latestVersion}`, 'ready')
      showToast(`Доступно обновление ${_appUpdateState.latestVersion}`)
    } else {
      setAppUpdateStatus(`У вас актуальная версия (${result.currentVersion || 'unknown'})`)
    }
  } catch (e) {
    setAppUpdateStatus(`Ошибка проверки: ${sanitizeDisplayText(e?.message || String(e))}`, 'error')
  } finally {
    _appUpdateState.checking = false
    updateAppUpdaterUiState()
  }
}

async function downloadAppUpdateNow() {
  if (!window.api?.appUpdateDownload || !_appUpdateState.available || _appUpdateState.downloading) return
  _appUpdateState.downloading = true
  setAppUpdateStatus(`Скачиваю ${_appUpdateState.latestVersion || 'обновление'}...`, 'checking')
  updateAppUpdaterUiState()
  try {
    const result = await window.api.appUpdateDownload()
    if (!result?.ok || !result?.downloadedPath) throw new Error(result?.error || 'download failed')
    _appUpdateState.downloadedPath = String(result.downloadedPath || '')
    setAppUpdateStatus(`Готово: ${result.latestVersion || _appUpdateState.latestVersion}`, 'ready')
    showToast('Обновление скачано. Нажми "Установить и перезапустить"')
  } catch (e) {
    setAppUpdateStatus(`Ошибка скачивания: ${sanitizeDisplayText(e?.message || String(e))}`, 'error')
  } finally {
    _appUpdateState.downloading = false
    updateAppUpdaterUiState()
  }
}

async function installAppUpdateNow() {
  if (!window.api?.appUpdateInstall || !_appUpdateState.downloadedPath) return
  setAppUpdateStatus('Запускаю установщик и перезапуск...', 'checking')
  try {
    const result = await window.api.appUpdateInstall(_appUpdateState.downloadedPath)
    if (!result?.ok) throw new Error(result?.error || 'install failed')
  } catch (e) {
    setAppUpdateStatus(`Ошибка установки: ${sanitizeDisplayText(e?.message || String(e))}`, 'error')
  }
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
  const p = document.getElementById('proxy-base-url')
  const k = document.getElementById('lastfm-api-key')
  const ss = document.getElementById('lastfm-shared-secret')
  const sk = document.getElementById('lastfm-session-key')
  const fsb = document.getElementById('flow-social-api-base')
  const fss = document.getElementById('flow-social-api-secret')
  if (d) d.value = s.discordClientId || ''
  if (p) p.value = normalizeFlowServerUrl(s.proxyBaseUrl || FLOW_SERVER_DEFAULT_URL)
  if (k) k.value = s.lastfmApiKey || ''
  if (ss) ss.value = s.lastfmSharedSecret || ''
  if (sk) sk.value = s.lastfmSessionKey || ''
  if (fsb) {
    fsb.value = String(window.FlowSocialBackend?.getConfig?.().base || FLOW_SOCIAL_DEFAULT_API_BASE).trim().replace(/\/$/, '')
    fsb.disabled = true
    fsb.title = 'В этой сборке значение фиксированное'
  }
  if (fss) {
    fss.value = '********'
    fss.disabled = true
    fss.title = 'В этой сборке значение фиксированное'
  }
  updateAppUpdaterUiState()
}

function saveFlowSocialBackendSettings() {
  showToast('В этой версии социальный backend зафиксирован и не требует ручного ввода')
}

async function checkFlowSocialBackendStatus() {
  const statusEl = document.getElementById('flow-social-api-status')
  const setStatus = (text, ok = null) => {
    if (!statusEl) return
    statusEl.textContent = text
    if (ok === true) statusEl.style.color = '#7ee787'
    else if (ok === false) statusEl.style.color = '#ff9b9b'
    else statusEl.style.color = ''
  }
  const cfg = window.FlowSocialBackend?.getConfig?.() || {}
  const base = String(cfg.base || FLOW_SOCIAL_DEFAULT_API_BASE || '').trim().replace(/\/$/, '')
  const secret = String(cfg.secret || FLOW_SOCIAL_DEFAULT_API_SECRET || '').trim()
  if (!base || !secret) {
    setStatus('Соц-API: конфиг отсутствует', false)
    return
  }
  setStatus('Соц-API: проверяю…')
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 5500)
    const r = await fetch(`${base}/flow-api/v1/health`, {
      method: 'GET',
      cache: 'no-store',
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${secret}` },
    })
    clearTimeout(timer)
    if (!r.ok) setStatus(`Соц-API: ошибка ${r.status}`, false)
    else setStatus('Соц-API: OK', true)
  } catch (_) {
    setStatus('Соц-API: недоступен (проверь URL, секрет, firewall)', false)
  }
}

function saveProxySettings() {
  const input = document.getElementById('proxy-base-url')
  const proxyBaseUrl = normalizeFlowServerUrl(input?.value || FLOW_SERVER_DEFAULT_URL)
  saveSettingsRaw({ proxyBaseUrl })
  if (input) input.value = proxyBaseUrl
  showToast('Сервер Nexory сохранён')
  checkFlowServerStatus().catch(() => {})
}

async function checkFlowServerStatus() {
  const statusEl = document.getElementById('flow-server-status')
  const setStatus = (text, ok = null) => {
    if (!statusEl) return
    statusEl.textContent = text
    if (ok === true) statusEl.style.color = '#7ee787'
    else if (ok === false) statusEl.style.color = '#ff9b9b'
    else statusEl.style.color = ''
  }
  const input = document.getElementById('proxy-base-url')
  const base = normalizeFlowServerUrl(input?.value || getSettings().proxyBaseUrl || FLOW_SERVER_DEFAULT_URL)
  saveSettingsRaw({ proxyBaseUrl: base })
  if (input) input.value = base
  if (!/^https?:\/\//i.test(base)) {
    setStatus('Сервер: неверный адрес', false)
    return { ok: false, ping: null }
  }
  _lastServerStatusCheckAt = Date.now()
  setStatus('Сервер: проверяю...')
  const started = performance.now()
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 5500)
    const rsp = await fetch(`${base}/health`, { method: 'GET', cache: 'no-store', signal: ctrl.signal })
    clearTimeout(timer)
    const ping = Math.max(1, Math.round(performance.now() - started))
    if (!rsp.ok) {
      setStatus(`Сервер: оффлайн (${rsp.status})`, false)
      return { ok: false, ping }
    }
    setStatus(`Сервер: онлайн, ping ${ping} ms`, true)
    return { ok: true, ping }
  } catch {
    setStatus('Сервер: оффлайн', false)
    return { ok: false, ping: null }
  }
}

async function checkProxyConnection() {
  const statusEl = document.getElementById('proxy-check-status')
  const setStatus = (text, ok = null) => {
    if (!statusEl) return
    statusEl.textContent = text
    if (ok === true) statusEl.style.color = '#7ee787'
    else if (ok === false) statusEl.style.color = '#ff9b9b'
    else statusEl.style.color = ''
  }
  if (!window.api?.proxySetUrl) {
    setStatus('Статус: проверка доступна только в Electron', false)
    return
  }
  setStatus('Статус: проверяю прокси и источники...')
  const checks = [
    { name: 'SoundCloud CDN', url: 'https://cf-media.sndcdn.com/' },
    { name: 'Audius API', url: 'https://discoveryprovider.audius.co/v1/health_check' },
    { name: 'Googlevideo (YouTube stream)', url: 'https://r1---sn-4g5e6n7s.googlevideo.com/' },
  ]
  const probe = async (url) => {
    try {
      const proxyUrl = await window.api.proxySetUrl(url)
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 6000)
      const res = await fetch(proxyUrl, { method: 'GET', headers: { Range: 'bytes=0-0' }, signal: ctrl.signal })
      clearTimeout(timer)
      return res.ok || res.status === 206
    } catch {
      return false
    }
  }
  let okCount = 0
  const lines = []
  for (const item of checks) {
    const ok = await probe(item.url)
    if (ok) okCount++
    lines.push(`${ok ? 'OK' : 'FAIL'} ${item.name}`)
  }
  const allOk = okCount === checks.length
  const msg = `Статус: ${okCount}/${checks.length} прошло | ${lines.join(' | ')}`
  setStatus(msg, allOk ? true : (okCount > 0 ? null : false))
  showToast(allOk ? 'Прокси проверен: все источники отвечают' : `Прокси проверка: прошло ${okCount}/${checks.length}`, !allOk)
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
    largeImageText: 'Nexory',
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
  startProfilesRealtimeSync()
  if (_socialPeer) _socialPeer.destroy()
  _lastWsAuthOkAt = 0
  _peerSocialReadyAt = 0
  _socialPeer = new peerSocial.FlowPeerSocial(_profile.username, {
    maxPeers: 3,
    onStatus: (evt) => {
      if (evt.type === 'ready') {
        _peerSocialReadyAt = Date.now()
        setSocialStatus(`online: ${evt.id}`)
      }
      if (evt.type === 'ws-state') {
        const now = Date.now()
        if (evt.state === 'online') {
          _lastWsAuthOkAt = now
          setSocialStatus('online')
        } else if (evt.state === 'connecting' || evt.state === 'degraded') {
          const recentWs = _lastWsAuthOkAt && now - _lastWsAuthOkAt < 120000
          const recentHttp = _socialLastOnlineAt && now - _socialLastOnlineAt < 120000
          const bootGrace = _peerSocialReadyAt && !_lastWsAuthOkAt && now - _peerSocialReadyAt < 45000
          if (recentWs || recentHttp || bootGrace) setSocialStatus('online')
          else if (evt.state === 'connecting') {
            setSocialStatus(`connecting${evt.attempt ? ` (#${evt.attempt})` : ''}`)
          } else if (evt.reason === 'auth_err') {
            setSocialStatus('degraded (auth)')
          } else {
            setSocialStatus('connecting')
          }
        }
      }
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
          _roomState.hostPeerId = null
          showToast('Хост вышел. Выбираем нового хоста...')
          setRoomStatus('Хост вышел, server election...')
          loadRoomStateFromServer(true).catch(() => {})
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
      if (fromPeerId || msg._peerId) setSocialStatus('online')
      if (msg.type === 'playback-sync' && msg.roomId === _roomState.roomId && !_roomState.host) {
        const expectedHostId = String(_roomState.hostPeerId || '').trim()
        const senderId = String(msg._peerId || fromPeerId || '').trim()
        if (!_roomState.hostPeerId && senderId) _roomState.hostPeerId = senderId
        if (expectedHostId && senderId && senderId !== expectedHostId) return
        const seq = Number(msg.syncSeq || 0)
        if (seq && _lastPlaybackSyncSeq && seq < _lastPlaybackSyncSeq) return
        if (seq) _lastPlaybackSyncSeq = Math.max(_lastPlaybackSyncSeq || 0, seq)
        const ts = Number(msg.playbackTs || msg._ts || 0)
        if (ts) _lastAppliedServerPlaybackTs = Math.max(_lastAppliedServerPlaybackTs || 0, ts)
        _lastGuestP2pPlaybackAt = Date.now()
        if (Array.isArray(msg.sharedQueue)) {
          sharedQueue = msg.sharedQueue.map((t) => sanitizeTrack(t)).filter(Boolean)
          renderRoomQueue()
        }
        if (typeof msg.paused === 'boolean') {
          if (msg.paused && !audio.paused) audio.pause()
        }
        if (msg.track) {
          const incomingTrack = sanitizeTrack(msg.track)
          const incomingSig = normalizeTrackSignature(incomingTrack)
          const currentSig = normalizeTrackSignature(currentTrack || {})
          const noActiveAudio = !audio?.src || audio?.ended || audio?.error
          const shouldReloadTrack =
            noActiveAudio ||
            !currentTrack ||
            !incomingSig ||
            !currentSig ||
            incomingSig !== currentSig
          if (shouldReloadTrack) {
            playTrackObj(incomingTrack, { remoteSync: true }).catch(() => {})
          }
        }
        if (typeof msg.currentTime === 'number' && Number.isFinite(audio.duration) && audio.duration > 0) {
          const sentAt = Number(msg._ts || msg.playbackTs || Date.now())
          const latencySec = Math.max(0, (Date.now() - sentAt) / 1000)
          const targetTime = Math.max(0, Math.min(msg.currentTime + latencySec, audio.duration))
          if (Math.abs(audio.currentTime - targetTime) > 0.12) audio.currentTime = targetTime
        }
        if (typeof msg.paused === 'boolean') {
          if (!msg.paused && audio.paused && audio.src) audio.play().catch(() => {})
        }
        try {
          syncTransportPlayPauseUi()
        } catch (_) {}
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
        const key = String(msg._from).replace(/^flow-/, '').trim().toLowerCase()
        const prevPresence = _friendPresence.get(key) || {}
        const nextPresence = {
          online: true,
          roomId: msg.roomId || null,
          track: msg.track || null,
          host: Boolean(msg.host),
          peerId: msg.peerId || msg._peerId || null,
          updatedAt: Date.now(),
        }
        notifyFriendPresenceChange(key, prevPresence, nextPresence)
        _friendPresence.set(key, nextPresence)
        if (msg.profile && (msg.peerId || msg._peerId)) {
          const pid = msg.peerId || msg._peerId
          const merged = mergeProfileData(_peerProfiles.get(pid) || getCachedPeerProfile(msg.profile.username), Object.assign({}, msg.profile, { peerId: pid }), pid)
          _peerProfiles.set(pid, merged)
          cachePeerProfile(merged, pid)
        }
        renderFriends()
      }
      if (msg.type === 'room-invite') {
        const fromUsername = String(msg.fromUsername || String(msg._from || '').replace(/^flow-/, '')).trim().toLowerCase()
        if (isInviteMutedFrom(fromUsername)) return
        const roomId = String(msg.roomId || '').trim()
        if (!roomId) return
        showRoomInvitePrompt({ roomId, fromUsername })
      }
      if (msg.type === 'room-host-transfer' && msg.roomId === _roomState.roomId) {
        const myPeerId = String(_socialPeer?.peer?.id || '')
        if (myPeerId && msg.hostPeerId === myPeerId) {
          _roomState.host = true
          _roomState.hostPeerId = myPeerId
          if (Array.isArray(msg.sharedQueue)) sharedQueue = msg.sharedQueue.map((t) => sanitizeTrack(t)).filter(Boolean)
          saveRoomStateToServer({ host_peer_id: myPeerId, shared_queue: sharedQueue }).catch(() => {})
          broadcastRoomMembersState()
          broadcastQueueUpdate()
          updateRoomUi()
          showToast('Теперь ты хост комнаты')
        }
      }
      if (msg.type === 'room-host-changed' && msg.roomId === _roomState.roomId && msg.hostPeerId) {
        const myPeerId = String(_socialPeer?.peer?.id || '')
        _roomState.hostPeerId = String(msg.hostPeerId || '')
        _roomState.host = myPeerId && _roomState.hostPeerId === myPeerId
        updateRoomUi()
        if (!_roomState.host) showToast(`Новый хост: ${String(msg.username || msg.hostPeerId).replace(/^flow-/, '')}`)
      }
      if (msg.type === 'room-profile-state' && msg.roomId === _roomState.roomId && msg.profile && msg._peerId) {
        const profileWithPeer = mergeProfileData(_peerProfiles.get(msg._peerId) || getCachedPeerProfile(msg.profile.username), Object.assign({}, msg.profile, { peerId: msg._peerId }), msg._peerId)
        _peerProfiles.set(msg._peerId, profileWithPeer)
        cachePeerProfile(profileWithPeer, msg._peerId)
        _roomMembers.set(msg._peerId, profileWithPeer)
        // Queue should be synchronized only via authoritative events:
        // playback-sync / queue-update / room-queue-sync-state / server flow_rooms.
        // Applying queue from profile packets causes occasional stale "flicker".
        if (_roomState.host) broadcastRoomMembersState()
        resetRoomHeartbeat()
        updateRoomUi()
      }
      if (msg.type === 'room-members-state' && msg.roomId === _roomState.roomId && Array.isArray(msg.members)) {
        msg.members.forEach((item) => {
          if (!item?.peerId || !item?.profile) return
          const merged = mergeProfileData(
            _roomMembers.get(item.peerId) || _peerProfiles.get(item.peerId) || getCachedPeerProfile(item.profile.username) || {},
            Object.assign({}, item.profile, { peerId: item.peerId }),
            item.peerId
          )
          _roomMembers.set(item.peerId, merged)
          cachePeerProfile(merged, item.peerId)
        })
        if (_socialPeer?.peer?.id && _profile?.username && !_roomMembers.has(_socialPeer.peer.id)) {
          _roomMembers.set(_socialPeer.peer.id, getPublicProfilePayload(_profile.username))
        }
        renderRoomMembers()
        resetRoomHeartbeat()
        updateRoomUi()
      }
      if (msg.type === 'room-queue-add' && msg.roomId === _roomState.roomId && _roomState.host && msg.track) {
        const t = sanitizeTrack(msg.track)
        const sig = normalizeTrackSignature(t)
        if (!sig || !sharedQueue.some((item) => normalizeTrackSignature(item) === sig)) {
          sharedQueue.push(t)
        }
        broadcastQueueUpdate()
        _socialPeer.send({ type: 'room-profile-state', roomId: _roomState.roomId, profile: getPublicProfilePayload(_profile?.username), sharedQueue })
        saveRoomStateToServer({ shared_queue: sharedQueue }).catch(() => {})
        renderRoomQueue()
      }
      if (msg.type === 'room-control-toggle' && msg.roomId === _roomState.roomId && msg._peerId && msg._peerId !== _socialPeer?.peer?.id) {
        const expectedHostId = String(_roomState.hostPeerId || '').trim()
        const senderId = String(msg._peerId || '').trim()
        if (expectedHostId && senderId && senderId !== expectedHostId) return
        if (_roomState?.host) return
        if (typeof msg.currentTime === 'number' && Number.isFinite(audio.duration) && audio.duration > 0) {
          const ct = Math.max(0, Math.min(Number(msg.currentTime), audio.duration))
          if (Math.abs(audio.currentTime - ct) > 1.25) audio.currentTime = ct
        }
        const shouldPause = Boolean(msg.paused)
        if (shouldPause && !audio.paused) audio.pause()
        if (!shouldPause && audio.paused) audio.play().catch(() => {})
        try {
          syncTransportPlayPauseUi()
        } catch (_) {}
      }
      if (msg.type === 'room-queue-sync-request' && msg.roomId === _roomState.roomId && _roomState.host) {
        const payload = { type: 'room-queue-sync-state', roomId: _roomState.roomId, sharedQueue }
        if (typeof _socialPeer.sendToPeer === 'function' && msg._peerId) _socialPeer.sendToPeer(msg._peerId, payload)
        else _socialPeer.send(payload)
      }
      if (msg.type === 'room-queue-sync-state' && msg.roomId === _roomState.roomId && Array.isArray(msg.sharedQueue)) {
        sharedQueue = msg.sharedQueue.map((t) => sanitizeTrack(t)).filter(Boolean)
        renderRoomQueue()
      }
      if (msg.type === (peerSocial?.EVENTS?.QUEUE_UPDATE || 'queue-update') && msg.roomId === _roomState.roomId && Array.isArray(msg.sharedQueue)) {
        sharedQueue = msg.sharedQueue.map((t) => sanitizeTrack(t)).filter(Boolean)
        renderRoomQueue()
      }
    },
  })
  const r = _socialPeer.init()
  if (!r?.ok) setSocialStatus(r?.error || 'peer init failed')
  updateRoomUi()
}

async function submitAuth() {
  const input = document.getElementById('auth-login')
  const passInput = document.getElementById('auth-password')
  const username = String(input?.value || '').trim()
  const password = String(passInput?.value || '')
  if (!username) return setAuthError('Введите Username')
  if (!password) return setAuthError('Введите пароль')
  const fn = _authMode === 'register' ? peerSocial.createProfile : peerSocial.loginProfile
  if (typeof fn !== 'function') return setAuthError('Social модуль не загружен')
  let result = await fn(username, password)
  if (!result?.ok && _authMode === 'login' && result?.legacy && typeof peerSocial.migrateLegacyAccount === 'function') {
    const ok = confirm('Найден старый аккаунт без пароля. Мигрировать его на текущий пароль?')
    if (!ok) return setAuthError('Миграция отменена')
    result = await peerSocial.migrateLegacyAccount(username, password)
    if (result?.ok) showToast('Аккаунт мигрирован. Теперь вход работает через пароль.')
  }
  if (!result?.ok) return setAuthError(result?.error || 'Ошибка входа')
  _profile = result.profile
  setAuthError('')
  try {
    if (_profile?.username) localStorage.setItem('flow_auth_last_user', String(_profile.username).trim().toLowerCase())
  } catch {}
  if (passInput) passInput.value = ''
  setAuthScreensAuthorized(true)
  syncProfileUi()
  ensureSocialUI()
  ensureRoomsUI()
  renderFriends()
  initPeerSocial()
  showOnboardingIfNeeded()
  pollFriendsPresence().catch(() => {})
  if (_friendsPollTimer) clearInterval(_friendsPollTimer)
  _friendsPollTimer = setInterval(() => { pollFriendsPresence().catch(() => {}) }, FRIEND_POLL_INTERVAL_MS)
}

function logout() {
  stopProfileCloudPresenceHeartbeat()
  removeRoomMemberPresence(_roomState?.roomId).catch(() => {})
  stopRoomServerSync()
  stopProfilesRealtimeSync()
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
  setAuthScreensAuthorized(false)
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
  showToast(online ? `Запрос в друзья отправлен: ${friend}` : `Запрос в друзья отправлен: ${friend} (доставится при входе)`)
}

async function renderFriendRequests() {
  const el = document.getElementById('friend-requests-list')
  if (!el || !_profile?.username || typeof peerSocial.getIncomingFriendRequests !== 'function') return
  const reqs = await peerSocial.getIncomingFriendRequests(_profile.username).catch(() => [])
  if (!Array.isArray(reqs) || !reqs.length) {
    el.innerHTML = '<div class="flow-empty-state compact"><strong>Заявок нет</strong><span>Новые запросы в друзья появятся отдельными карточками.</span></div>'
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

async function createRoom() {
  if (!_socialPeer) return
  const r = _socialPeer.createRoom()
  if (!r?.ok) return showToast(r?.error || 'Ошибка создания', true)
  stopCurrentPlaybackForRoomMode()
  _roomState = { roomId: r.roomId, host: true, hostPeerId: _socialPeer?.peer?.id || r.roomId }
  _roomMembers.clear()
  sharedQueue = []
  _lastPlaybackSyncSeq = 0
  _hostPlaybackSyncSeq = 0
  _lastGuestP2pPlaybackAt = 0
  if (_socialPeer?.peer?.id) _roomMembers.set(_socialPeer.peer.id, getPublicProfilePayload(_profile?.username))
  setRoomStatus(`Рума ${r.roomId}: участников 1/3`)
  resetRoomHeartbeat()
  await saveRoomStateToServer({ shared_queue: [], now_playing: null, playback_ts: Date.now() }).catch(() => {})
  startRoomServerSync()
  updateRoomUi()
  showToast('Рума создана')
}

async function joinRoomById(forceRoomId = '') {
  const input = document.getElementById('join-room-input')
  const roomId = resolveInviteToRoomId(forceRoomId || String(input?.value || '').trim())
  if (!_socialPeer || !roomId) return
  const r = _socialPeer.joinRoom(roomId)
  if (!r?.ok) return showToast(r?.error || 'Ошибка входа', true)
  _roomState = { roomId: r.roomId, host: false, hostPeerId: null }
  // Вход в комнату переводит в отдельный комнатный режим, персональный плеер мгновенно останавливаем.
  stopCurrentPlaybackForRoomMode()
  _roomMembers.clear()
  sharedQueue = []
  _lastPlaybackSyncSeq = 0
  _hostPlaybackSyncSeq = 0
  _lastGuestP2pPlaybackAt = 0
  if (_socialPeer?.peer?.id) _roomMembers.set(_socialPeer.peer.id, getPublicProfilePayload(_profile?.username))
  setRoomStatus(`Подключение к руме ${r.roomId}...`)
  resetRoomHeartbeat()
  startRoomServerSync({ skipInitialLoad: true })
  await loadRoomStateFromServer(true).catch(() => {})
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
  stopCurrentPlaybackForRoomMode()
  if (!_socialPeer) return
  if (typeof _socialPeer.leaveRoom === 'function') _socialPeer.leaveRoom()
  _roomState = { roomId: null, host: false, hostPeerId: null }
  _roomMembers.clear()
  sharedQueue = []
  _lastPlaybackSyncSeq = 0
  _hostPlaybackSyncSeq = 0
  _lastAppliedServerPlaybackTs = 0
  _lastGuestP2pPlaybackAt = 0
  if (_roomHeartbeatTimer) clearInterval(_roomHeartbeatTimer)
  _roomHeartbeatTimer = null
  setRoomStatus('Рума: не активна')
  updateRoomUi()
  showToast('Вы покинули руму')
}

function stopCurrentPlaybackForRoomMode() {
  // Invalidate pending async play resolutions from previous (personal) context.
  _playRequestSeq = Number(_playRequestSeq || 0) + 1
  try { audio.pause() } catch (_) {}
  try { audio.removeAttribute('src'); audio.load() } catch (_) {}
  currentTrack = null
  try { syncTransportPlayPauseUi() } catch (_) {}
  try { renderRoomNowPlaying() } catch (_) {}
  try { refreshNowPlayingTrackHighlight() } catch (_) {}
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

async function fetchServerFriendsPresence(username) {
  if (!isFlowSocialReady() || !username) return null
  try {
    const rid = encodeURIComponent(String(username || '').trim().toLowerCase())
    const rows = await window.FlowSocialBackend.request('GET', `/flow-api/v1/presence/friends/${rid}`)
    if (!Array.isArray(rows)) return null
    const map = new Map()
    rows.forEach((row) => {
      const uname = String(row?.username || '').trim().toLowerCase()
      if (!uname) return
      const onlineFromServer =
        row?.online === true ||
        row?.online === 1 ||
        String(row?.online || '') === '1' ||
        String(row?.online || '').toLowerCase() === 'true'
      map.set(uname, {
        online: Boolean(onlineFromServer),
        roomId: row?.room_id ? String(row.room_id) : null,
        peerId: row?.peer_id ? String(row.peer_id) : `flow-${uname}`,
        updatedAt: Date.now(),
      })
    })
    return map
  } catch {
    return null
  }
}

async function pollFriendsPresence(force = false) {
  if (!_socialPeer || !_profile?.username || !peerSocial.getFriends) return
  const serverPresence = await fetchServerFriendsPresence(_profile.username).catch(() => null)
  if (serverPresence !== null) {
    _socialLastOnlineAt = Date.now()
    setSocialStatus('online')
  }
  const friends = peerSocial.getFriends(_profile.username) || []
  const entries = await Promise.all(friends.map(async (friend) => {
    const uname = String(friend || '').trim().toLowerCase()
    const prev = _friendPresence.get(uname) || {}
    const cloud = serverPresence?.get(uname) || null
    const freshOnline = !force && prev.online && (Date.now() - Number(prev.updatedAt || 0) < FRIEND_FRESH_ONLINE_MS)
    let isOnline = false
    if (cloud) {
      isOnline = Boolean(cloud.online)
    } else if (freshOnline) {
      isOnline = true
    } else {
      isOnline = await _socialPeer.probeUser(uname, 2800).catch(() => false)
    }
    if (!isOnline && (freshOnline || cloud === null)) {
      const probed = await _socialPeer.probeUser(uname, 2200).catch(() => false)
      if (probed) isOnline = true
    }
    if (!isOnline) {
      return [uname, { online: false, track: null, roomId: cloud?.roomId || null, peerId: cloud?.peerId || prev.peerId || null, updatedAt: Date.now() }]
    }
    let state = {
      online: true,
      track: prev.track || null,
      roomId: cloud?.roomId || prev.roomId || `flow-${uname}`,
      peerId: cloud?.peerId || prev.peerId || `flow-${uname}`,
      updatedAt: Date.now(),
    }
    const peerId = String(state.peerId || `flow-${uname}`)
    if (typeof _socialPeer.requestPeerData === 'function') {
      const response = await _socialPeer.requestPeerData(peerId, { type: 'presence-request' }, 1100).catch(() => null)
      if (response?.ok && response?.data?.type === 'presence-state') {
        const p = response.data
        state = {
          online: true,
          track: p.track || null,
          roomId: p.roomId || `flow-${uname}`,
          peerId: p.peerId || p._peerId || `flow-${uname}`,
          host: Boolean(p.host),
          updatedAt: Date.now(),
        }
        if (p.profile && (p.peerId || p._peerId)) {
          const pid = p.peerId || p._peerId
          const merged = mergeProfileData(_peerProfiles.get(pid) || getCachedPeerProfile(p.profile.username), Object.assign({}, p.profile, { peerId: pid }), pid)
          _peerProfiles.set(pid, merged)
          cachePeerProfile(merged, pid)
        }
      }
    }
    const shouldForceProfileRefresh = force || !prev.online
    await refreshFriendProfileFromCloud(uname, shouldForceProfileRefresh).catch(() => null)
    return [uname, state]
  }))
  const prevPresence = _friendPresence
  entries.forEach(([uname, state]) => notifyFriendPresenceChange(uname, prevPresence.get(uname) || {}, state || {}))
  _friendPresence = new Map(entries)
  renderFriends()
}

function notifyFriendPresenceChange(username, prev = {}, next = {}) {
  const name = String(username || '').trim()
  if (!name) return
  const now = Date.now()
  const canNotify = (kind) => {
    const key = `${name}:${kind}`
    const last = Number(_friendNotifyAt.get(key) || 0)
    if (now - last < FRIEND_NOTIFY_COOLDOWN_MS) return false
    _friendNotifyAt.set(key, now)
    return true
  }
  if (!prev.online && next.online && canNotify('online')) {
    showToast(`${name} теперь онлайн`)
  }
  const prevTrack = prev.track ? `${prev.track.artist || ''}:${prev.track.title || ''}` : ''
  const nextTrack = next.track ? `${next.track.artist || ''}:${next.track.title || ''}` : ''
  if (next.online && nextTrack && nextTrack !== prevTrack && canNotify(`track:${nextTrack}`)) {
    showToast(`${name} слушает: ${next.track.title || 'трек'}${next.track.artist ? ` — ${next.track.artist}` : ''}`)
  }
}

function broadcastPlaybackSync(force = false) {
  if (!_socialPeer || !_roomState.roomId || !currentTrack || !_roomState.host) return
  const now = Date.now()
  if (!force && now - _lastRoomSyncAt < 700) return
  _lastRoomSyncAt = now
  _hostPlaybackSyncSeq = Number(_hostPlaybackSyncSeq || 0) + 1
  const syncTs = Date.now()
  _socialPeer.send({
    type: 'playback-sync',
    roomId: _roomState.roomId,
    track: currentTrack,
    playbackTs: syncTs,
    syncSeq: _hostPlaybackSyncSeq,
    currentTime: Number(audio.currentTime || 0),
    paused: Boolean(audio.paused),
    source: currentTrack?.source || null,
    sharedQueue,
  })
  saveRoomStateToServer({
    now_playing: currentTrack,
    shared_queue: sharedQueue,
    playback_state: { paused: Boolean(audio.paused), currentTime: Number(audio.currentTime || 0) },
    playback_ts: syncTs,
  }).catch(() => {})
}

// в”Ђв”Ђв”Ђ APP START в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
function startApp() {
  try {
    const s0 = getSettings()
    const b = String(s0.flowSocialApiBase || '').trim()
    const k = String(s0.flowSocialApiSecret || '').trim()
    if (b) localStorage.setItem('flow_social_api_base', b.replace(/\/$/, ''))
    if (k) localStorage.setItem('flow_social_api_secret', k)
  } catch (_) {}
  const profile = typeof peerSocial.getCurrentProfile === 'function' ? peerSocial.getCurrentProfile() : null
  _profile = profile || null
  if (_profile) {
    setAuthScreensAuthorized(true)
    syncProfileUi()
    ensureSocialUI()
    ensureRoomsUI()
    renderFriends()
    initPeerSocial()
    syncIntegrationsUI()
    showOnboardingIfNeeded()
    pollFriendsPresence().catch(() => {})
    startProfileCloudPresenceHeartbeat()
    if (_friendsPollTimer) clearInterval(_friendsPollTimer)
    _friendsPollTimer = setInterval(() => { pollFriendsPresence().catch(() => {}) }, FRIEND_POLL_INTERVAL_MS)
    const s = getSettings()
    if (s.discordRpcEnabled && s.discordClientId) {
      window.api?.discordRpcConnect?.(s.discordClientId).catch(() => {})
    }
  } else {
    setAuthScreensAuthorized(false)
    switchTab('login')
    syncIntegrationsUI()
  }
  checkAppUpdatesNow().catch(() => {})
  try { renderYandexWaveMoodDock() } catch (_) {}
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
  renderQueue()
  renderMainHub()
  renderMyWave()
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
  const setNavLabel = (pageId, value) => {
    const el = document.querySelector(`.nav-item[data-nav-page="${pageId}"] .nav-label`)
    if (el) el.textContent = value
  }
  setNavLabel('main', 'Главная')
  setNavLabel('home', 'Медиа')
  setNavLabel('search', 'Поиск')
  setNavLabel('library', 'Библиотека')
  setNavLabel('liked', 'Любимые')
  setNavLabel('social', 'Друзья')
  setNavLabel('rooms', 'Комнаты')
  setNavLabel('settings', 'Настройки')
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
  setText('#page-settings .content-header .content-sub', 'Выбери раздел слева — настройки сгруппированы по смыслу.')
  setText('#page-library .content-header h2', 'Библиотека')
  setText('#page-liked .content-header h2', 'Любимые')
  setText('#page-profile .content-header h2', 'Профиль')
  setText('#page-profile .content-sub', 'Твой профиль Nexory')
  setText('#page-rooms .content-header h2', 'Комнаты')
  setText('#page-rooms .content-sub', 'Совместное прослушивание и общая очередь')
  setText('#page-search .content-header h2', 'Поиск')
  setText('#page-search .content-sub', 'Найди трек')
  setText('#page-library .content-sub', 'Твои плейлисты')
  setText('#page-liked .content-sub', 'Треки, которые ты лайкнул')
  setText('#page-home .content-header h2', 'Медиа')
  setText('#page-home .content-header .content-sub', 'Управляй текущим треком и очередью')

  const labels = Array.from(document.querySelectorAll('#settings-panel-appearance .vs-label, #settings-panel-playback .vs-label'))
  labels.forEach((el) => {
    const t = (el.textContent || '').trim()
    if (t.includes('Blur') && t.includes('фона')) el.innerHTML = 'Blur фона <span class="vs-val" id="vs-blur-val">40px</span>'
    if (t.includes('Яркость') || t.includes('PЏ')) el.innerHTML = 'Яркость фона <span class="vs-val" id="vs-bright-val">50%</span>'
    if (t.includes('Прозрачн')) el.innerHTML = 'Прозрачность стекла <span class="vs-val" id="vs-glass-val">32%</span>'
    if (t.includes('панел')) el.innerHTML = 'Blur панелей <span class="vs-val" id="vs-panel-blur-val">30px</span>'
  })
}

let scheduleMainShiftRemeasure = () => {}

const FLOW_SIDEBAR_FLOAT_Y_LS = 'flow_sidebar_float_y'

/** Slack L/T/R/B (px): «кусок» правой карточки от максимального прямоугольника в UI «Минимал». */
const FLOW_MAIN_CARD_SLACK_LS = 'flow_main_card_slack_v1'

/** Сохранённое смещение правой карточки («окна» контента) в UI «Минимал», px. */
const FLOW_MAIN_PANE_DRAG_LS = 'flow_floated_pane_drag_v1'

function setupFloatedMainContentResize() {
  const root = document.documentElement
  const MAIN_MIN_W = 360
  const MAIN_MIN_H = 240
  /** Дополнительное «вырастание» карточки у углов: отрицательный slack; общий модуль ограничен. */
  const SLACK_NEG_CAP = 72

  const modeOk = () =>
    document.body.classList.contains('visual-floated') &&
    !document.body.classList.contains('visual-minimal') &&
    typeof isSidebarDockedLeft === 'function' &&
    isSidebarDockedLeft()

  /** @typedef {{ l: number, t: number, r: number, b: number }} Slack */

  /** @returns {{ baseMl: number, baseMt: number, maxW: number, maxH: number }} */
  function readMaxBox() {
    try {
      const gcs = getComputedStyle(root)
      const mis = parseFloat(gcs.getPropertyValue('--main-inset-start')) || 22
      const mie = parseFloat(gcs.getPropertyValue('--main-inset-end')) || 22
      const pans = parseFloat(gcs.getPropertyValue('--floated-pane-stack-start')) || 300
      const offx = parseFloat(gcs.getPropertyValue('--floated-right-pane-offset-x') || '') || 0
      const offy = parseFloat(gcs.getPropertyValue('--floated-right-pane-offset-y') || '') || 0
      const smpt = parseFloat(gcs.getPropertyValue('--screen-main-pt')) || 18
      const tb = parseFloat(gcs.getPropertyValue('--titlebar-h')) || 32
      const ph = parseFloat(gcs.getPropertyValue('--player-h')) || 88
      const psb = parseFloat(gcs.getPropertyValue('--player-stack-bottom')) || 22
      const iw = typeof window !== 'undefined' ? window.innerWidth : 1100
      const ih = typeof window !== 'undefined' ? window.innerHeight : 700
      const nominalStart = mis + pans + offx
      let baseMl = nominalStart
      try {
        const sb = typeof document !== 'undefined' ? document.getElementById('sidebar') : null
        if (sb && document.body?.classList?.contains?.('visual-floated')) {
          const br = sb.getBoundingClientRect()
          const guardStr = gcs.getPropertyValue('--floated-content-overlap-guard').trim()
          const guard = parseFloat(guardStr) || 44
          if (br.width > 4 && br.height > 4) {
            const dyn = br.right + guard
            baseMl = Math.max(nominalStart, dyn)
          }
        }
      } catch (_) {}
      const baseMt = smpt + offy
      const maxW = Math.max(MAIN_MIN_W, Math.floor(iw - baseMl - mie))
      const maxH = Math.max(MAIN_MIN_H, Math.floor(ih - tb - smpt - offy - ph - psb + 10))
      return { baseMl, baseMt, maxW, maxH }
    } catch (_) {
      return { baseMl: 22, baseMt: 18, maxW: 800, maxH: 600 }
    }
  }

  function clampSlacks(s) {
    const { maxW, maxH } = readMaxBox()
    const clampH = (v) => Math.max(-SLACK_NEG_CAP, Math.min(Math.round(v), maxW))
    const clampV = (v) => Math.max(-SLACK_NEG_CAP, Math.min(Math.round(v), maxH))
    let L = clampH(s.l)
    let T = clampV(s.t)
    let R = clampH(s.r)
    let B = clampV(s.b)

    const shrinkHoriz = () => {
      let wAvail = maxW - L - R
      if (wAvail >= MAIN_MIN_W) return
      let need = MAIN_MIN_W - wAvail
      const eatNeg = () => {
        while (need > 0 && L < 0) {
          const t = Math.min(need, -L)
          L += t
          need -= t
        }
        while (need > 0 && R < 0) {
          const t = Math.min(need, -R)
          R += t
          need -= t
        }
      }
      eatNeg()
      let guard = 0
      while (need > 0 && guard < 5600) {
        guard++
        if (L >= R && L > 0) {
          L--
          need--
        } else if (R > 0) {
          R--
          need--
        } else if (L < 0) {
          L++
          need--
        } else if (R < 0) {
          R++
          need--
        } else break
      }
    }

    const shrinkVert = () => {
      let hAvail = maxH - T - B
      if (hAvail >= MAIN_MIN_H) return
      let need = MAIN_MIN_H - hAvail
      const eatNeg = () => {
        while (need > 0 && T < 0) {
          const t = Math.min(need, -T)
          T += t
          need -= t
        }
        while (need > 0 && B < 0) {
          const t = Math.min(need, -B)
          B += t
          need -= t
        }
      }
      eatNeg()
      let guard = 0
      while (need > 0 && guard < 5600) {
        guard++
        if (T >= B && T > 0) {
          T--
          need--
        } else if (B > 0) {
          B--
          need--
        } else if (T < 0) {
          T++
          need--
        } else if (B < 0) {
          B++
          need--
        } else break
      }
    }

    shrinkHoriz()
    shrinkVert()
    return { l: L, t: T, r: R, b: B }
  }

  /** @returns {Slack}
   */
  function readStoredSlacks() {
    try {
      const raw = localStorage.getItem(FLOW_MAIN_CARD_SLACK_LS)
      if (!raw) return { l: 0, t: 0, r: 0, b: 0 }
      const p = JSON.parse(raw)
      if (!p || typeof p !== 'object') return { l: 0, t: 0, r: 0, b: 0 }
      return clampSlacks({
        l: +p.l || 0,
        t: +p.t || 0,
        r: +p.r || 0,
        b: +p.b || 0,
      })
    } catch (_) {
      return { l: 0, t: 0, r: 0, b: 0 }
    }
  }

  /** @type {Slack}
   */
  let liveSlacks = readStoredSlacks()

  function clearDomSlacks() {
    try {
      ;['--flow-main-card-sl-l', '--flow-main-card-sl-t', '--flow-main-card-sl-r', '--flow-main-card-sl-b'].forEach(
        (prop) => {
          root.style.removeProperty(prop)
        },
      )
    } catch (_) {}
    try {
      document.body.classList.remove('has-flow-main-pane-slack')
    } catch (_) {}
  }

  function persistSlacks() {
    try {
      localStorage.setItem(FLOW_MAIN_CARD_SLACK_LS, JSON.stringify(liveSlacks))
    } catch (_) {}
  }

  function syncSlacksToDom(slack) {
    if (!modeOk()) return
    try {
      root.style.setProperty('--flow-main-card-sl-l', `${slack.l}px`)
      root.style.setProperty('--flow-main-card-sl-t', `${slack.t}px`)
      root.style.setProperty('--flow-main-card-sl-r', `${slack.r}px`)
      root.style.setProperty('--flow-main-card-sl-b', `${slack.b}px`)
    } catch (_) {}
  }

  function applySlacks(s) {
    liveSlacks = clampSlacks(s)
    if (!modeOk()) {
      clearDomSlacks()
      return
    }
    const flat =
      Math.abs(liveSlacks.l) +
        Math.abs(liveSlacks.t) +
        Math.abs(liveSlacks.r) +
        Math.abs(liveSlacks.b) <
      0.25
    if (flat) {
      clearDomSlacks()
      liveSlacks = { l: 0, t: 0, r: 0, b: 0 }
      return
    }
    syncSlacksToDom(liveSlacks)
    try {
      document.body.classList.add('has-flow-main-pane-slack')
    } catch (_) {}
  }

  /** @returns {Slack}
   */
  function applyStoredOrClear() {
    if (!modeOk()) {
      clearDomSlacks()
      return liveSlacks
    }
    const rd = readStoredSlacks()
    const sumAbs =
      Math.abs(rd.l) +
      Math.abs(rd.t) +
      Math.abs(rd.r) +
      Math.abs(rd.b)
    if (sumAbs <= 0.25) {
      clearDomSlacks()
      liveSlacks = { l: 0, t: 0, r: 0, b: 0 }
      return liveSlacks
    }
    liveSlacks = rd
    syncSlacksToDom(liveSlacks)
    try {
      document.body.classList.add('has-flow-main-pane-slack')
    } catch (_) {}
    return liveSlacks
  }

  let cornerDragging = false
  /** @type {null | { corner: string, cx: number, cy: number, s: Slack }} */
  let anchor = null
  /** @type {null | Element} */
  let captureEl = null
  let capPid = /** @type {null | number} */ (null)

  function finishCorner() {
    if (!cornerDragging) return
    cornerDragging = false
    anchor = null
    document.body.style.cursor = ''
    try {
      document.body.classList.remove('flow-main-pane-resizing')
    } catch (_) {}
    window.removeEventListener('pointermove', onMv, true)
    window.removeEventListener('pointerup', finishCorner, true)
    window.removeEventListener('pointercancel', finishCorner, true)
    if (captureEl && capPid != null) {
      try {
        captureEl.releasePointerCapture(capPid)
      } catch (_) {}
    }
    captureEl = null
    capPid = null
    persistSlacks()
    try {
      scheduleMainShiftRemeasure()
    } catch (_) {}
    try {
      syncFlowLayoutCoords()
    } catch (_) {}
  }

  /** @param {PointerEvent} e */
  function onMv(e) {
    if (!cornerDragging || !anchor) return
    const { corner, cx: sx, cy: sy, s: startSlack } = anchor
    const cx = e.clientX
    const cy = e.clientY
    const dx = cx - sx
    const dy = cy - sy
    const ns = { ...startSlack }
    if (corner === 'br') {
      ns.r = startSlack.r - dx
      ns.b = startSlack.b - dy
    } else if (corner === 'tr') {
      ns.r = startSlack.r - dx
      ns.t = startSlack.t + dy
    } else if (corner === 'bl') {
      ns.l = startSlack.l + dx
      ns.b = startSlack.b - dy
    } else if (corner === 'tl') {
      ns.l = startSlack.l + dx
      ns.t = startSlack.t + dy
    }
    applySlacks(ns)
  }

  /** @param {string} corner @param {PointerEvent} e @param {Element} el */
  function beginCorner(corner, e, el) {
    if (!modeOk()) return
    if (!e.isPrimary || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    anchor = { corner, cx: e.clientX, cy: e.clientY, s: { ...liveSlacks } }
    cornerDragging = true
    try {
      document.body.classList.add('flow-main-pane-resizing')
    } catch (_) {}
    document.body.style.cursor = corner === 'tl' || corner === 'br' ? 'nwse-resize' : 'nesw-resize'
    captureEl = el
    capPid = e.pointerId
    window.addEventListener('pointermove', onMv, true)
    window.addEventListener('pointerup', finishCorner, true)
    window.addEventListener('pointercancel', finishCorner, true)
    try {
      el.setPointerCapture(e.pointerId)
    } catch (_) {}
  }

  const pane = document.getElementById('main-content-pane')
  document.querySelectorAll('[data-main-pane-corner]').forEach((btn) => {
    const corner = String(btn.getAttribute('data-main-pane-corner') || '')
    if (!['tl', 'tr', 'bl', 'br'].includes(corner)) return
    btn.addEventListener('pointerdown', (e) => beginCorner(corner, e, btn))
  })

  let rt = 0
  window.addEventListener(
    'resize',
    () => {
      clearTimeout(rt)
      rt = setTimeout(() => {
        try {
          if (!pane || !modeOk()) return
          liveSlacks = clampSlacks(liveSlacks)
          applySlacks(liveSlacks)
          persistSlacks()
        } catch (_) {}
      }, 140)
    },
    { passive: true },
  )

  window.flowMainPaneResize = {
    reclamp() {
      applySlacks(clampSlacks(liveSlacks))
    },
    reset() {
      try {
        localStorage.removeItem(FLOW_MAIN_CARD_SLACK_LS)
      } catch (_) {}
      liveSlacks = { l: 0, t: 0, r: 0, b: 0 }
      clearDomSlacks()
    },
    clearDom() {
      clearDomSlacks()
    },
    refreshMode() {
      if (!pane) return
      if (!modeOk()) {
        clearDomSlacks()
        return
      }
      applyStoredOrClear()
    },
  }

  if (pane && modeOk()) applyStoredOrClear()
}

/** Рамки по периметру карточки: перетаскивание только из полос (уголки освобождены под ресайз). */
function setupFloatedMainPaneDrag() {
  const paneEl = document.getElementById('main-content-pane')
  const hits = paneEl?.querySelectorAll('.main-pane-frame-hit') ?? []
  if (!paneEl || hits.length === 0) return

  const modeOkDrag = () =>
    document.body.classList.contains('visual-floated') &&
    !document.body.classList.contains('visual-minimal') &&
    typeof isSidebarDockedLeft === 'function' &&
    isSidebarDockedLeft()

  /** Высота sticky-shell = видимая область панели, чтобы рамки не «уплывали» при прокрутке контента. */
  function refreshFrameShellGeometry() {
    try {
      if (!modeOkDrag()) return
      const ph = paneEl.clientHeight
      paneEl.style.setProperty('--main-pane-frame-shell-h', `${Math.max(64, Math.round(ph))}px`)
    } catch (_) {}
  }

  function readDragLs() {
    try {
      const raw = localStorage.getItem(FLOW_MAIN_PANE_DRAG_LS)
      if (!raw) return { x: 0, y: 0 }
      const p = JSON.parse(raw)
      return { x: +p.x || 0, y: +p.y || 0 }
    } catch (_) {
      return { x: 0, y: 0 }
    }
  }

  function applyDragVars(x, y) {
    try {
      document.documentElement.style.setProperty('--flow-floated-pane-drag-x', `${Math.round(x)}px`)
      document.documentElement.style.setProperty('--flow-floated-pane-drag-y', `${Math.round(y)}px`)
    } catch (_) {}
  }

  function persistDrag(x, y) {
    try {
      localStorage.setItem(
        FLOW_MAIN_PANE_DRAG_LS,
        JSON.stringify({ x: Math.round(x), y: Math.round(y) }),
      )
    } catch (_) {}
    try {
      syncFlowLayoutCoords()
    } catch (_) {}
  }

  /** @returns {{ x: number, y: number }} */
  function clampDrag(x, y) {
    const content = document.getElementById('main-content-pane')
    const pad = 8
    let cx = x
    let cy = y
    if (!content || !modeOkDrag()) return { x: cx, y: cy }
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1200
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800
    const gcs = getComputedStyle(document.documentElement)
    const parseVar = (name, fallback) => {
      const n = parseFloat(gcs.getPropertyValue(name))
      return Number.isFinite(n) ? n : fallback
    }
    const titleH = parseVar('--titlebar-h', 32)
    const mainPt = parseVar('--screen-main-pt', 18)
    const offY = parseVar('--floated-right-pane-offset-y', 0)
    const playerH = parseVar('--player-h', 88)
    const playerBottom = parseVar('--player-stack-bottom', 12)
    const insetStart = parseVar('--main-inset-start', 22)
    const paneStack = parseVar('--floated-pane-stack-start', 300)
    const offX = parseVar('--floated-right-pane-offset-x', 0)
    const mainShift = parseVar('--main-shift-x', 0)
    const insetEnd = parseVar('--main-inset-end', 22)
    /* Барьер правой панели поменян местами: резерв уходит на правый край. */
    const minLeft = insetStart + pad
    const maxRight = vw - insetEnd - (paneStack + offX + Math.max(0, mainShift)) - pad
    const minTop = titleH + mainPt + offY + 4
    const maxBottom = vh - (playerH + playerBottom + 6)
    for (let iter = 0; iter < 8; iter++) {
      applyDragVars(cx, cy)
      const cr = content.getBoundingClientRect()
      const prevCx = cx
      const prevCy = cy
      if (cr.left < minLeft) cx += minLeft - cr.left
      if (cr.right > maxRight) cx -= cr.right - maxRight
      if (cr.top < minTop) cy += minTop - cr.top
      if (cr.bottom > maxBottom) cy -= cr.bottom - maxBottom

      if (Math.abs(cx - prevCx) < 0.25 && Math.abs(cy - prevCy) < 0.25) break
    }
    return { x: Math.round(cx), y: Math.round(cy) }
  }

  function refreshFromStorage() {
    if (!modeOkDrag()) return
    const saved = readDragLs()
    const c = clampDrag(saved.x, saved.y)
    applyDragVars(c.x, c.y)
    if (Math.abs(c.x - saved.x) > 0.6 || Math.abs(c.y - saved.y) > 0.6) persistDrag(c.x, c.y)
    try {
      scheduleMainShiftRemeasure()
    } catch (_) {}
  }

  queueMicrotask(() => {
    refreshFrameShellGeometry()
    refreshFromStorage()
  })

  try {
    let roRaf = 0
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            if (roRaf) return
            roRaf = requestAnimationFrame(() => {
              roRaf = 0
              try {
                refreshFrameShellGeometry()
              } catch (_) {}
            })
          })
        : null
    ro?.observe(paneEl)
  } catch (_) {}

  let resizeRaf = 0
  window.addEventListener(
    'resize',
    () => {
      if (resizeRaf) return
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0
        try {
          refreshFrameShellGeometry()
          refreshFromStorage()
        } catch (_) {}
      })
    },
    { passive: true },
  )

  let dragging = false
  let sx = 0
  let sy = 0
  let ox = 0
  let oy = 0
  /** @type {null | HTMLElement} */
  let capEl = null
  let capId = /** @type {null | number} */ (null)

  const fin = () => {
    if (!dragging) return
    dragging = false
    document.body.classList.remove('flow-floated-main-pane-dragging')
    window.removeEventListener('pointermove', mv, true)
    window.removeEventListener('pointerup', fin, true)
    window.removeEventListener('pointercancel', fin, true)
    try {
      if (capEl) capEl.releasePointerCapture(capId ?? -1)
    } catch (_) {}
    capEl = null
    capId = null
    try {
      let xPx = 0
      let yPx = 0
      try {
        xPx = parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--flow-floated-pane-drag-x'),
        ) || 0
      } catch (_) {}
      try {
        yPx = parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--flow-floated-pane-drag-y'),
        ) || 0
      } catch (_) {}
      persistDrag(xPx, yPx)
    } catch (_) {}
    try {
      window.flowMainPaneResize?.reclamp?.()
    } catch (_) {}
    try {
      scheduleMainShiftRemeasure()
    } catch (_) {}
  }

  /** @param {PointerEvent} ev */
  function mv(ev) {
    if (!dragging) return
    const rawX = ox + (ev.clientX - sx)
    const rawY = oy + (ev.clientY - sy)
    const c = clampDrag(rawX, rawY)
    applyDragVars(c.x, c.y)
    persistDrag(c.x, c.y)
  }

  /** @param {PointerEvent} e @param {HTMLElement} captureTarget */
  function onHitPointerDown(e, captureTarget) {
    if (!modeOkDrag()) return
    if (document.body.classList.contains('home-layout-edit')) return
    if (!e.isPrimary || e.button !== 0) return
    if (e.target instanceof Element && e.target.closest('.content-corner-resize')) return
    e.preventDefault()
    e.stopPropagation()
    dragging = true
    document.body.classList.add('flow-floated-main-pane-dragging')
    sx = e.clientX
    sy = e.clientY
    capEl = captureTarget
    try {
      ox = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--flow-floated-pane-drag-x'),
      ) || 0
    } catch (_) {
      ox = 0
    }
    try {
      oy = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--flow-floated-pane-drag-y'),
      ) || 0
    } catch (_) {
      oy = 0
    }
    capId = e.pointerId
    window.addEventListener('pointermove', mv, true)
    window.addEventListener('pointerup', fin, true)
    window.addEventListener('pointercancel', fin, true)
    try {
      captureTarget.setPointerCapture(e.pointerId)
    } catch (_) {}
  }

  hits.forEach((el) =>
    el.addEventListener(
      'pointerdown',
      (e) => onHitPointerDown(e, /** @type {HTMLElement} */ (el)),
      true,
    ),
  )

  window.flowFloatedMainPaneDrag = {
    refreshFromStorage,
    refreshFrameShellGeometry,
    clear: () => {
      applyDragVars(0, 0)
      persistDrag(0, 0)
    },
  }
}

function applySidebarFloatYPx(px) {
  let maxY = 320
  try {
    if (typeof window !== 'undefined') {
      const ih = window.innerHeight
      const root = document.documentElement
      const gcs = getComputedStyle(root)
      const tb = parseFloat(gcs.getPropertyValue('--titlebar-h')) || 32
      const ph = parseFloat(gcs.getPropertyValue('--player-h')) || 88
      const psb = parseFloat(gcs.getPropertyValue('--player-stack-bottom')) || 0
      const smpt = parseFloat(gcs.getPropertyValue('--screen-main-pt')) || 0
      /* Симметрия вверх/вниз: одинаковый модуль, clamp ниже в [-maxY, +maxY]. */
      maxY = Math.max(160, Math.min(560, Math.floor(ih - tb - ph - psb - smpt - 180)))
    }
  } catch (_) {
    maxY = 320
  }
  const c = Math.max(0, Math.min(maxY, Math.round(px)))
  try {
    document.documentElement.style.setProperty('--sidebar-float-y', `${c}px`)
  } catch (_) {}
  try {
    localStorage.setItem(FLOW_SIDEBAR_FLOAT_Y_LS, String(c))
  } catch (_) {}
  try {
    syncFlowLayoutCoords()
  } catch (_) {}
}

/** Сброс перетаскивания сайдбара ( Escape / смена страницы ). */
let _teardownSidebarPanelDrag = () => {}

function setupSidebarResize() {
  const MIN_W = 72
  const MAX_W = 320
  const MIN_CONTENT_TAIL = 260
  const sidebar = document.getElementById('sidebar')
  const gutters = [
    ['left', document.getElementById('sidebar-resize-gutter-left')],
    ['right', document.getElementById('sidebar-resize-gutter')],
  ].filter(([, el]) => el)
  if (!sidebar || gutters.length === 0) return

  const root = document.documentElement

  const getSidebarGapPx = () => {
    const raw = String(getComputedStyle(root).getPropertyValue('--sidebar-gap') || '').trim()
    const n = parseFloat(raw)
    return Number.isFinite(n) ? n : 12
  }
  const getMainInsetLeft = () => {
    const main = document.getElementById('screen-main')
    if (!main) return 0
    let inset = 0
    try {
      inset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--main-inset-start')) || 0
    } catch (_) {}
    const pl = parseFloat(getComputedStyle(main).paddingLeft) || 0
    return main.getBoundingClientRect().left + pl + inset
  }
  const computeMaxShift = (sidebarWidthPx) => {
    const main = document.getElementById('screen-main')
    if (!main) return 0
    const r = main.getBoundingClientRect()
    const pcs = getComputedStyle(main)
    const pl = parseFloat(pcs.paddingLeft) || 0
    const pr = parseFloat(pcs.paddingRight) || 0
    const usable = Math.max(0, r.width - pl - pr)
    const gap = getSidebarGapPx()
    /* «Минимал»: сдвиг только в пределах окна — не от ширины flex-контейнера (иначе панель «дрожит» при ресайзе). */
    if (
      document.body.classList.contains('visual-floated') &&
      typeof isSidebarDockedLeft === 'function' &&
      isSidebarDockedLeft()
    ) {
      let insetStart = 0
      let insetEnd = 0
      let paneStack = 300
      let offX = 0
      let mainShift = 0
      let nudge = 0
      try {
        insetStart = parseFloat(getComputedStyle(root).getPropertyValue('--main-inset-start')) || 0
        insetEnd = parseFloat(getComputedStyle(root).getPropertyValue('--main-inset-end')) || 0
        paneStack = parseFloat(getComputedStyle(root).getPropertyValue('--floated-pane-stack-start')) || 300
        offX = parseFloat(getComputedStyle(root).getPropertyValue('--floated-right-pane-offset-x')) || 0
        mainShift = parseFloat(getComputedStyle(root).getPropertyValue('--main-shift-x')) || 0
        nudge = parseFloat(getComputedStyle(root).getPropertyValue('--floated-sidebar-nudge-x')) || 0
      } catch (_) {}
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1200
      const w = Math.max(MIN_W, Math.min(MAX_W, Math.round(sidebarWidthPx)))
      let maxShift = Math.max(0, Math.floor(vw - insetEnd - w - insetStart - 10))
      /* Невидимый фиолетовый барьер: sb.right не может перейти в старт жёлтой зоны контента. */
      try {
        const barrier = insetStart + paneStack + offX + mainShift - 12
        const byBarrier = Math.floor(barrier - insetStart - nudge - w)
        if (Number.isFinite(byBarrier)) maxShift = Math.min(maxShift, Math.max(0, byBarrier))
      } catch (_) {}
      return maxShift
    }
    return Math.max(0, usable - sidebarWidthPx - gap - MIN_CONTENT_TAIL)
  }
  const readShiftStored = () => {
    const s = parseInt(localStorage.getItem('flow_sidebar_shift') || '0', 10)
    return Number.isFinite(s) ? Math.max(0, s) : 0
  }
  const clampShiftForWidth = (wPx, shiftPx) =>
    Math.max(0, Math.min(computeMaxShift(wPx), shiftPx))

  const setWidthCss = (w) => {
    const clamped = Math.max(MIN_W, Math.min(MAX_W, Math.round(w)))
    root.style.setProperty('--sidebar-w', clamped + 'px')
    localStorage.setItem('flow_sidebar_w', String(clamped))
    sidebar.classList.toggle('collapsed', clamped <= 92)
    return clamped
  }
  const setShiftCss = (shiftPx) => {
    const s = Math.max(0, Math.round(shiftPx))
    root.style.setProperty('--sidebar-shift', s + 'px')
    localStorage.setItem('flow_sidebar_shift', String(s))
  }

  const sidebarWidthEffectivePx = () => {
    try {
      if (typeof isSidebarHorizontalDock === 'function' && !isSidebarHorizontalDock()) {
        const bw = sidebar.getBoundingClientRect().width
        if (Number.isFinite(bw) && bw >= 48) return Math.round(bw)
      }
    } catch (_) {}
    let wParsed = NaN
    try { wParsed = parseFloat(getComputedStyle(root).getPropertyValue('--sidebar-w')) || NaN } catch (_) {}
    const wPx = Number.isFinite(wParsed) ? Math.round(wParsed) : 210
    return Math.max(MIN_W, Math.min(MAX_W, wPx))
  }

  const syncShiftToWidth = () => {
    let wPx = sidebarWidthEffectivePx()
    wPx = Math.max(MIN_W, Math.min(MAX_W, wPx))
    let shParsed = 0
    try { shParsed = parseFloat(getComputedStyle(root).getPropertyValue('--sidebar-shift')) || 0 } catch (_) {}
    const sh = clampShiftForWidth(wPx, shParsed)
    if (Math.abs(sh - shParsed) > 0.5) setShiftCss(sh)
  }

  /** Якорь — левая координата сайдбара в момент захвата (правый грип). */
  let anchorLeftPx = 0
  /** Якорь — правая координата сайдбара в момент захвата (левый грип): стык с основной областью. */
  let anchorRightPx = 0

  const applyRightDrag = (clientX) => {
    setWidthCss(clientX - anchorLeftPx)
    syncShiftToWidth()
  }
  /** Левый грип: двигаем левую сторону, правая (у меню контента) остаётся на месте до отпускания. */
  const applyLeftDrag = (clientX) => {
    const wReq = anchorRightPx - clientX
    const clampedW = Math.max(MIN_W, Math.min(MAX_W, Math.round(wReq)))
    const leftDesired = anchorRightPx - clampedW
    const innerL = getMainInsetLeft()
    let shiftReq = leftDesired - innerL
    shiftReq = clampShiftForWidth(clampedW, shiftReq)
    setWidthCss(clampedW)
    setShiftCss(shiftReq)
  }

  const SIDEBAR_H_MIN = 196

  const applySidebarPanelHeightFromStorage = () => {
    if (!document.body.classList.contains('visual-floated')) {
      root.style.removeProperty('--sidebar-panel-height')
      return
    }
    try {
      const n = parseInt(localStorage.getItem(FLOW_SIDEBAR_PANEL_H_LS) || '', 10)
      if (Number.isFinite(n) && n >= SIDEBAR_H_MIN) {
        root.style.setProperty('--sidebar-panel-height', `${n}px`)
      }
    } catch (_) {}
  }

  /** @param {number} h @param {{ fixedHMax?: number, lockSidebarTopPx?: number, lockPlayerTopPx?: number }} [opts] */
  const setPanelHeightClamped = (h, opts = {}) => {
    let hMax
    if (opts.fixedHMax != null && Number.isFinite(opts.fixedHMax)) {
      hMax = opts.fixedHMax
    } else {
      const sidebarTop =
        opts.lockSidebarTopPx != null ? opts.lockSidebarTopPx : sidebar.getBoundingClientRect().top
      const playerBar = document.getElementById('player-bar')
      const pt =
        opts.lockPlayerTopPx != null
          ? opts.lockPlayerTopPx
          : playerBar
            ? playerBar.getBoundingClientRect().top
            : window.innerHeight - 88
      hMax = Math.max(SIDEBAR_H_MIN + 40, Math.floor(pt - sidebarTop - 8))
    }
    const clamped = Math.max(SIDEBAR_H_MIN, Math.min(hMax, Math.round(h)))
    root.style.setProperty('--sidebar-panel-height', `${clamped}px`)
    return clamped
  }

  let dragging = false
  let dragEdge = 'right'
  let activePointerId = null
  let captureEl = null

  let cornerDragging = false
  let cornerCaptureEl = null
  let cornerPointerId = null
  /** @type {{ corner: string, freezeL: number, freezeR: number, freezeT: number, freezeB: number, innerL: number, fixedHMax: number, startCx: number, startCy: number, startW: number, startShift: number, startPanelH: number } | null} */
  let cornerAnchor = null

  const winPointerMove = (e) => {
    if (!dragging || (typeof isSidebarHorizontalDock === 'function' && isSidebarHorizontalDock())) return
    if (dragEdge === 'left') applyLeftDrag(e.clientX)
    else applyRightDrag(e.clientX)
  }
  const winPointerUp = () => {
    if (!dragging) return
    dragging = false
    document.body.style.cursor = ''
    document.body.classList.remove('is-resizing-sidebar')
    window.removeEventListener('pointermove', winPointerMove, true)
    window.removeEventListener('pointerup', winPointerUp, true)
    window.removeEventListener('pointercancel', winPointerUp, true)
    if (captureEl != null && activePointerId != null) {
      try { captureEl.releasePointerCapture(activePointerId) } catch (_) {}
    }
    captureEl = null
    activePointerId = null
    scheduleMainShiftRemeasure()
    try {
      syncFlowLayoutCoords()
    } catch (_) {}
  }

  const finishCornerDrag = () => {
    if (!cornerDragging) return
    cornerDragging = false
    document.body.style.cursor = ''
    document.body.classList.remove('is-resizing-sidebar')
    window.removeEventListener('pointermove', winCornerMove, true)
    window.removeEventListener('pointerup', finishCornerDrag, true)
    window.removeEventListener('pointercancel', finishCornerDrag, true)
    if (cornerCaptureEl != null && cornerPointerId != null) {
      try {
        cornerCaptureEl.releasePointerCapture(cornerPointerId)
      } catch (_) {}
    }
    cornerCaptureEl = null
    cornerPointerId = null
    cornerAnchor = null
    try {
      const raw = getComputedStyle(root).getPropertyValue('--sidebar-panel-height').trim()
      const n = parseFloat(raw)
      if (Number.isFinite(n) && n >= SIDEBAR_H_MIN) {
        localStorage.setItem(FLOW_SIDEBAR_PANEL_H_LS, String(Math.round(n)))
      }
    } catch (_) {}
    scheduleMainShiftRemeasure()
    try {
      syncFlowLayoutCoords()
    } catch (_) {}
  }

  const winCornerMove = (e) => {
    if (!cornerDragging || !cornerAnchor) return
    const a = cornerAnchor
    const { corner, fixedHMax, startCx, startCy, startW, startShift, startPanelH } = a
    const cx = e.clientX
    const cy = e.clientY
    const hOpts = { fixedHMax }
    /* Дельты от точки захвата для всех углов — freezeL/freezeR при драге «плывут» и правые углы дёргались. */
    if (corner === 'br') {
      const nw = Math.max(MIN_W, Math.min(MAX_W, Math.round(startW + (cx - startCx))))
      const nh = Math.max(SIDEBAR_H_MIN, Math.min(fixedHMax, Math.round(startPanelH + (cy - startCy))))
      setWidthCss(nw)
      setPanelHeightClamped(nh, hOpts)
    } else if (corner === 'tl') {
      /* Левый верх: ширина/сдвиг от дельты — фиксируем правый край (innerL+shift+w), иначе cx-innerL даёт «схлопывание». */
      const newW = Math.max(MIN_W, Math.min(MAX_W, Math.round(startW + (startCx - cx))))
      const newH = Math.max(SIDEBAR_H_MIN, Math.min(fixedHMax, Math.round(startPanelH + (startCy - cy))))
      const sh = clampShiftForWidth(newW, startShift + startW - newW)
      setWidthCss(newW)
      setShiftCss(sh)
      setPanelHeightClamped(newH, hOpts)
    } else if (corner === 'tr') {
      const nw = Math.max(MIN_W, Math.min(MAX_W, Math.round(startW + (cx - startCx))))
      const nh = Math.max(SIDEBAR_H_MIN, Math.min(fixedHMax, Math.round(startPanelH + (startCy - cy))))
      setWidthCss(nw)
      setPanelHeightClamped(nh, hOpts)
    } else if (corner === 'bl') {
      const newW = Math.max(MIN_W, Math.min(MAX_W, Math.round(startW + (startCx - cx))))
      const newH = Math.max(SIDEBAR_H_MIN, Math.min(fixedHMax, Math.round(startPanelH + (cy - startCy))))
      const sh = clampShiftForWidth(newW, startShift + startW - newW)
      setWidthCss(newW)
      setShiftCss(sh)
      setPanelHeightClamped(newH, hOpts)
    }
  }

  const startSidebarCornerDrag = (corner, e, capEl) => {
    if (!document.body.classList.contains('visual-floated')) return
    if (typeof isSidebarHorizontalDock === 'function' && isSidebarHorizontalDock()) return
    if (
      !document.body.classList.contains('flow-edit-enabled') ||
      !document.body.classList.contains('home-layout-edit')
    ) {
      return
    }
    if (!e.isPrimary || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    winPointerUp()
    const rect = sidebar.getBoundingClientRect()
    const playerBar = document.getElementById('player-bar')
    const startPlayerTop = playerBar ? playerBar.getBoundingClientRect().top : window.innerHeight - 88
    const fixedHMax = Math.max(SIDEBAR_H_MIN + 40, Math.floor(startPlayerTop - rect.top - 8))
    let wParsed = NaN
    try {
      wParsed = parseFloat(String(getComputedStyle(root).getPropertyValue('--sidebar-w') || '').trim())
    } catch (_) {}
    const startW = Math.max(
      MIN_W,
      Math.min(MAX_W, Number.isFinite(wParsed) ? Math.round(wParsed) : sidebarWidthEffectivePx()),
    )
    let shParsed = 0
    try {
      shParsed = parseFloat(getComputedStyle(root).getPropertyValue('--sidebar-shift')) || 0
    } catch (_) {}
    const startShift = clampShiftForWidth(startW, shParsed)
    let ph0 = NaN
    try {
      ph0 = parseFloat(getComputedStyle(root).getPropertyValue('--sidebar-panel-height').trim())
    } catch (_) {}
    const startPanelH =
      Number.isFinite(ph0) && ph0 >= SIDEBAR_H_MIN ? ph0 : Math.max(SIDEBAR_H_MIN, rect.height)
    cornerDragging = true
    cornerAnchor = {
      corner,
      freezeL: rect.left,
      freezeR: rect.right,
      freezeT: rect.top,
      freezeB: rect.bottom,
      innerL: getMainInsetLeft(),
      fixedHMax,
      startCx: e.clientX,
      startCy: e.clientY,
      startW,
      startShift,
      startPanelH,
    }
    cornerCaptureEl = capEl
    cornerPointerId = e.pointerId
    document.body.classList.add('is-resizing-sidebar')
    document.body.style.cursor = corner === 'tl' || corner === 'br' ? 'nwse-resize' : 'nesw-resize'
    window.addEventListener('pointermove', winCornerMove, true)
    window.addEventListener('pointerup', finishCornerDrag, true)
    window.addEventListener('pointercancel', finishCornerDrag, true)
    try {
      capEl.setPointerCapture(e.pointerId)
    } catch (_) {}
  }

  const startEdgeDrag = (edge, e, capEl) => {
    if (typeof isSidebarHorizontalDock === 'function' && isSidebarHorizontalDock()) return
    if (!e.isPrimary) return
    e.preventDefault()
    e.stopPropagation()
    const rect = sidebar.getBoundingClientRect()
    if (edge === 'left') anchorRightPx = rect.right
    else anchorLeftPx = rect.left
    dragging = true
    dragEdge = edge
    captureEl = capEl
    activePointerId = e.pointerId
    document.body.style.cursor = 'ew-resize'
    document.body.classList.add('is-resizing-sidebar')
    window.addEventListener('pointermove', winPointerMove, true)
    window.addEventListener('pointerup', winPointerUp, true)
    window.addEventListener('pointercancel', winPointerUp, true)
    try { capEl.setPointerCapture(e.pointerId) } catch (_) {}
  }

  gutters.forEach(([edge, gutter]) => {
    gutter.addEventListener('pointerdown', (e) => startEdgeDrag(edge, e, gutter))
  })

  document.querySelectorAll('.sidebar-corner-resize[data-sidebar-corner]').forEach((btn) => {
    const corner = String(btn.getAttribute('data-sidebar-corner') || '')
    if (!['tl', 'tr', 'bl', 'br'].includes(corner)) return
    btn.addEventListener('pointerdown', (e) => startSidebarCornerDrag(corner, e, btn))
  })

  const saved = parseInt(localStorage.getItem('flow_sidebar_w') || '210', 10)
  const wInit = Number.isFinite(saved) ? saved : 210
  const cw = setWidthCss(wInit)
  setShiftCss(clampShiftForWidth(cw, readShiftStored()))
  applySidebarPanelHeightFromStorage()

  const rebalanceSidebarAfterResize = () => {
    const floated =
      document.body.classList.contains('visual-floated') &&
      typeof isSidebarDockedLeft === 'function' &&
      isSidebarDockedLeft()
    if (floated) {
      try {
        const raw = getComputedStyle(root).getPropertyValue('--sidebar-panel-height').trim()
        const n = parseFloat(raw)
        if (Number.isFinite(n)) setPanelHeightClamped(n)
      } catch (_) {}
      /* Не вызываем syncShiftToWidth: он привязывает сдвиг к ширине #screen-main и даёт «резину» при ресайзе. */
      let wPx = NaN
      try {
        wPx = parseFloat(getComputedStyle(root).getPropertyValue('--sidebar-w')) || NaN
      } catch (_) {}
      wPx = Math.max(MIN_W, Math.min(MAX_W, Number.isFinite(wPx) ? Math.round(wPx) : 210))
      let shParsed = 0
      try {
        shParsed = parseFloat(getComputedStyle(root).getPropertyValue('--sidebar-shift')) || 0
      } catch (_) {}
      const cap = Math.max(0, Math.min(computeMaxShift(wPx), Math.round(shParsed)))
      if (Math.abs(cap - shParsed) > 0.5) setShiftCss(cap)
      return
    }
    syncShiftToWidth()
    try {
      const raw = getComputedStyle(root).getPropertyValue('--sidebar-panel-height').trim()
      const n = parseFloat(raw)
      if (Number.isFinite(n)) setPanelHeightClamped(n)
    } catch (_) {}
  }
  window.addEventListener(
    'resize',
    debounceSidebarLayoutSync(rebalanceSidebarAfterResize, 160),
    { passive: true },
  )
  window.addEventListener('blur', () => {
    winPointerUp()
    finishCornerDrag()
  })

  window.flowSidebarPanel = {
    clampShiftForWidth,
    setShiftCss,
    sidebarWidthEffectivePx,
    syncShiftToWidth,
  }
}

function setupSidebarPanelEditDrag() {
  const sidebar = document.getElementById('sidebar')
  if (!sidebar) return

  const isExcludedDragSurface = (t) => {
    try {
      if (!t || typeof t.closest !== 'function') return true
      return !!(
        t.closest('a.nav-item') ||
        t.closest('.sidebar-user') ||
        t.closest('.sidebar-logo') ||
        t.closest('#sidebar-layout-constructor') ||
        t.closest('.sidebar-corner-resize') ||
        t.closest('.sidebar-resize-gutter') ||
        t.closest('#sidebar-edit-drag-strip')
      )
    } catch (_) {
      return true
    }
  }

  const readShiftPx = () => {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-shift').trim()
      const n = parseFloat(v)
      return Number.isFinite(n) ? n : 0
    } catch (_) {
      return 0
    }
  }
  const readFloatYPx = () => {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-float-y').trim()
      const n = parseFloat(v)
      return Number.isFinite(n) ? n : 0
    } catch (_) {
      return 0
    }
  }

  let dragging = false
  let startX = 0
  let startY = 0
  let originShift = 0
  let originFloat = 0
  let pid = null
  let capEl = null

  const mv = (e) => {
    if (!dragging) return
    const api = window.flowSidebarPanel
    if (!api) return
    const wPx = api.sidebarWidthEffectivePx()
    let nextShift = originShift + (e.clientX - startX)
    nextShift = api.clampShiftForWidth(wPx, nextShift)
    api.setShiftCss(nextShift)
    applySidebarFloatYPx(originFloat + (e.clientY - startY))
  }

  const fin = () => {
    if (!dragging) return
    dragging = false
    document.body.classList.remove('sidebar-panel-dragging')
    window.removeEventListener('pointermove', mv, true)
    window.removeEventListener('pointerup', fin, true)
    window.removeEventListener('pointercancel', fin, true)
    if (capEl != null && pid != null) {
      try {
        capEl.releasePointerCapture(pid)
      } catch (_) {}
    }
    capEl = null
    pid = null
    scheduleMainShiftRemeasure()
    try {
      reclampHomeGeometryOnResize()
    } catch (_) {}
    try {
      syncFlowLayoutCoords()
    } catch (_) {}
  }

  _teardownSidebarPanelDrag = () => {
    fin()
  }

  sidebar.addEventListener(
    'pointerdown',
    (e) => {
      if (!document.body.classList.contains('visual-floated')) return
      if (typeof isSidebarHorizontalDock === 'function' && isSidebarHorizontalDock()) return
      if (!e.isPrimary || e.button !== 0) return
      const t = e.target
      if (!sidebar.contains(t)) return
      if (isExcludedDragSurface(t)) return
      e.preventDefault()
      e.stopPropagation()
      dragging = true
      document.body.classList.add('sidebar-panel-dragging')
      startX = e.clientX
      startY = e.clientY
      originShift = readShiftPx()
      originFloat = readFloatYPx()
      capEl = sidebar
      pid = e.pointerId
      window.addEventListener('pointermove', mv, true)
      window.addEventListener('pointerup', fin, true)
      window.addEventListener('pointercancel', fin, true)
      try {
        sidebar.setPointerCapture(e.pointerId)
      } catch (_) {}
    },
    true,
  )
}

function debounceSidebarLayoutSync(fn, ms = 140) {
  let t = 0
  return () => {
    if (typeof isSidebarHorizontalDock === 'function' && isSidebarHorizontalDock()) return
    clearTimeout(t)
    t = setTimeout(fn, ms)
  }
}

const FLOW_MAIN_SHIFT_LS = 'flow_main_shift_px'
const FLOW_SIDEBAR_PANEL_H_LS = 'flow_sidebar_panel_h'

/** Сброс горизонтального сдвига (классический «Минимализм» без оффсета). */
function clearMainPaneShiftForClassicLayout() {
  try {
    document.documentElement.style.setProperty('--main-shift-x', '0px')
    localStorage.setItem(FLOW_MAIN_SHIFT_LS, '0')
    const sl = document.getElementById('main-shift-slider')
    if (sl) sl.value = '0'
  } catch (_) {}
}

/** Горизонтальный сдвиг основной области (.content + нижний плеер + текстовая панель) в границах окна. */
function setupMainPaneShift() {
  const slider = document.getElementById('main-shift-slider')
  const btn = document.getElementById('main-shift-reset')
  if (!slider || !btn) return

  const root = document.documentElement.style
  /** @type {{ min: number, max: number }} */
  let limits = { min: -280, max: 280 }

  const applyShiftPx = (px) => {
    root.setProperty('--main-shift-x', `${Math.round(px)}px`)
  }

  const clampAndPersist = (px) => {
    const c = Math.max(limits.min, Math.min(limits.max, Math.round(px)))
    applyShiftPx(c)
    try { localStorage.setItem(FLOW_MAIN_SHIFT_LS, String(c)) } catch (_) {}
    slider.value = String(c)
    return c
  }

  const recomputeLimits = () => {
    const scr = document.getElementById('screen-main')
    const content = document.querySelector('#screen-main .content')
    const player = document.getElementById('player-bar')
    if (!scr || scr.classList.contains('hidden') || !content) return

    applyShiftPx(0)
    requestAnimationFrame(() => {
      const vw = window.innerWidth
      const margin = 12
      const cr = content.getBoundingClientRect()
      const pr = player ? player.getBoundingClientRect() : cr
      const unionL = Math.min(cr.left, pr.left)
      const unionR = Math.max(cr.right, pr.right)

      const winMin = Math.floor(margin - unionL)
      const winMax = Math.floor(vw - margin - unionR)

      let rawMin = winMin
      let rawMax = winMax

      const barDock = typeof isSidebarHorizontalDock === 'function' && isSidebarHorizontalDock()
      /* «Минимал»: колонка контента не привязана к sb.right — лимиты сдвига только от окна. */
      if (!barDock && !document.body.classList.contains('visual-floated') && !document.body.classList.contains('layout-right-nav')) {
        const sidebar = document.getElementById('sidebar')
        let gapPx = 12
        try {
          gapPx = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-gap')) || 12
        } catch (_) {}
        if (sidebar) {
          const sb = sidebar.getBoundingClientRect()
          const boundary = sb.right + gapPx + 2
          const needContent = Math.ceil(boundary - cr.left)
          const needPlayer = Math.ceil(boundary - pr.left)
          rawMin = Math.max(rawMin, needContent, needPlayer)
        }
      }

      rawMin = Math.max(-520, rawMin)
      rawMax = Math.min(520, rawMax)
      if (rawMin >= rawMax - 6) {
        rawMin = -120
        rawMax = 120
      }
      limits = { min: rawMin, max: rawMax }

      slider.min = String(limits.min)
      slider.max = String(limits.max)
      slider.step = Math.abs(limits.max - limits.min) > 420 ? '4' : '2'

      let saved = 0
      try { saved = parseInt(localStorage.getItem(FLOW_MAIN_SHIFT_LS) || '0', 10) } catch (_) {}
      clampAndPersist(Number.isFinite(saved) ? saved : 0)
    })
  }

  slider.addEventListener('input', () => {
    clampAndPersist(parseFloat(slider.value || '0'))
  })
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    try {
      localStorage.setItem('flow_sidebar_shift', '0')
      document.documentElement.style.setProperty('--sidebar-shift', '0px')
    } catch (_) {}
    try {
      localStorage.setItem(FLOW_MAIN_SHIFT_LS, '0')
    } catch (_) {}
    applyShiftPx(0)
    slider.value = '0'
    requestAnimationFrame(() => {
      recomputeLimits()
      try { window.dispatchEvent(new Event('resize')) } catch (_) {}
    })
  })

  let rt = 0
  window.addEventListener(
    'resize',
    () => {
      clearTimeout(rt)
      rt = setTimeout(recomputeLimits, 100)
    },
    { passive: true },
  )

  let rSched = 0
  scheduleMainShiftRemeasure = () => {
    clearTimeout(rSched)
    rSched = setTimeout(recomputeLimits, 70)
  }

  queueMicrotask(recomputeLimits)
}

function setupCardTilt() {
  /* 3D card tilt disabled: perspective + pointermove caused glitches on track rows. */
}

/** Только время и прогресс на клоне главной — вызывать из timeupdate (без обложки и без карточки профиля). */
function syncHomeClonePlaybackProgress() {
  const cur = document.getElementById('home-clone-time-cur')
  const tot = document.getElementById('home-clone-time-total')
  const prog = document.getElementById('home-clone-progress')
  if (!cur || !tot || !prog) return
  cur.textContent = fmtTime(audio.currentTime)
  tot.textContent = fmtTime(audio.duration)
  const ratio = audio.duration ? audio.currentTime / audio.duration : 0
  prog.value = ratio
  const nxLine = document.getElementById('page-home')?.classList.contains('media-queue-off')
  if (!nxLine) {
    const fill = ratio * 100
    prog.style.setProperty('--progress-fill', `${Math.max(0, Math.min(100, fill))}%`)
  } else {
    prog.style.removeProperty('--progress-fill')
  }
  try {
    if (typeof syncHomeNxCoverModeProgress === 'function') syncHomeNxCoverModeProgress()
  } catch (_) {}
}

function syncHomeNxFooter() {
  const vol = document.getElementById('home-nx-volume')
  const volVal = document.getElementById('home-nx-vol-val')
  if (vol) {
    const slider = Math.max(0, Math.min(1, Number(localStorage.getItem('flow_volume_slider') || '0.8') || 0.8))
    vol.value = String(slider)
    if (volVal) volVal.textContent = String(Math.max(0, Math.min(10, Math.round(slider * 10))))
  }
  try {
    if (typeof syncHomeNxSourceLogo === 'function') syncHomeNxSourceLogo()
  } catch (_) {}
}

function animateFlowMediaText(el, text, mode = 'letter') {
  if (!el) return
  const safe = String(text ?? '')
  if (el.dataset.flowText === safe) return
  el.dataset.flowText = safe
  el.classList.remove('flow-text-animated')
  const parts =
    mode === 'word'
      ? safe.split(/(\s+)/).filter((p) => p.length)
      : [...safe]
  const step = mode === 'word' ? 42 : 26
  el.innerHTML = parts
    .map((ch, i) => {
      const delay = ((i * step) / 1000).toFixed(3)
      const esc =
        typeof escapeHtml === 'function'
          ? escapeHtml(ch)
          : ch.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      return `<span class="flow-text-char" style="--ft-delay:${delay}s">${esc}</span>`
    })
    .join('')
  requestAnimationFrame(() => el.classList.add('flow-text-animated'))
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
    animateFlowMediaText(title, currentTrack.title || 'Ничего не играет', 'letter')
    animateFlowMediaText(artist, currentTrack.artist || '—', 'word')
    applyCoverArt(cover, getEffectiveCoverUrl(currentTrack), currentTrack.bg || 'linear-gradient(135deg,#7c3aed,#a855f7)')
  } else {
    animateFlowMediaText(title, 'Ничего не играет', 'letter')
    animateFlowMediaText(artist, '—', 'word')
    cover.style.backgroundImage = ''
    cover.innerHTML = COVER_ICON
  }
  syncHomeClonePlaybackProgress()
  syncHomeNxFooter()
  if (_activePageId === 'profile') renderProfileNowPlaying()
}
window.syncHomeNxFooter = syncHomeNxFooter

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
  const state = { audioCtx: _audioCtx, analyser: _analyser, freqData: _freqData, eqFilters: _eqFilters }
  const ok = ensure(audio, state)
  if (!ok) return false
  _audioCtx = state.audioCtx
  _analyser = state.analyser
  _freqData = state.freqData
  _eqFilters = state.eqFilters
  try {
    if (_audioCtx?.state === 'suspended') _audioCtx.resume().catch(() => {})
  } catch (_) {}
  return true
}

function teardownAudioAnalyzer() {
  const close = audioPlayer.closeAudioContext
  const state = { audioCtx: _audioCtx, analyser: _analyser, freqData: _freqData, eqFilters: _eqFilters }
  if (typeof close === 'function') close(state)
  _audioCtx = null
  _analyser = null
  _freqData = null
  _eqFilters = null
}

function resizeHomeVisualizerCanvas() {
  const canvas = document.getElementById('home-visualizer-canvas')
  const wrap = document.getElementById('home-visualizer-wrap')
  if (!canvas || !wrap || wrap.classList.contains('hidden')) return
  const r = wrap.getBoundingClientRect()
  const rw = Math.max(1, Math.round(r.width))
  const rh = Math.max(1, Math.round(r.height))
  if (canvas.width !== rw || canvas.height !== rh) {
    canvas.width = rw
    canvas.height = rh
    try {
      delete canvas._flowViz2d
    } catch (_) {}
  }
}

const FLOW_HOME_BLOCK_ORDER_LS = 'flow_home_block_order'
const FLOW_HOME_BLOCK_GEOMETRY_LS = 'flow_home_block_geometry'
/** Агрегат макета (блоки главной + снимок сайдбара) — дублирует геометрию блоков для обмена/бэкапа. */
const FLOW_LAYOUT_COORDS_LS = 'flow_layout_coords'
/** Масштаб блоков главной в «Минимал» (число 0.72–1.38, умножение zoom на стек). */
const FLOW_HOME_EDITOR_ZOOM_LS = 'flow_home_editor_zoom'

function loadHomeEditorZoomValue() {
  try {
    const z = parseFloat(localStorage.getItem(FLOW_HOME_EDITOR_ZOOM_LS) || '')
    if (!Number.isFinite(z)) return 1
    return Math.max(0.72, Math.min(1.38, z))
  } catch (_) {
    return 1
  }
}

function applyHomeEditorZoom(_z) {
  const stack = document.getElementById('home-dashboard-stack')
  if (!stack) return
  stack.style.removeProperty('--home-editor-zoom')
}

function persistHomeEditorZoom(z) {
  try {
    localStorage.setItem(FLOW_HOME_EDITOR_ZOOM_LS, String(z))
  } catch (_) {}
}

function syncHomeEditorZoomFromStorage() {
  if (!isVisualFloatedLayout()) {
    applyHomeEditorZoom(1)
    return
  }
  applyHomeEditorZoom(loadHomeEditorZoomValue())
}

const DEFAULT_HOME_BLOCK_ORDER = Object.freeze(['welcome', 'clone', 'cards', 'wave'])

function snapshotSidebarLayoutForCoords() {
  try {
    const cs = getComputedStyle(document.documentElement)
    const phRaw = cs.getPropertyValue('--sidebar-panel-height').trim()
    const ph = parseFloat(phRaw)
    return {
      shift: Math.round(parseFloat(cs.getPropertyValue('--sidebar-shift')) || 0),
      floatY: Math.round(parseFloat(cs.getPropertyValue('--sidebar-float-y')) || 0),
      width: Math.round(parseFloat(cs.getPropertyValue('--sidebar-w')) || 210),
      mainInsetStart: Math.round(parseFloat(cs.getPropertyValue('--main-inset-start')) || 0),
      panelHeight: Number.isFinite(ph) ? Math.round(ph) : null,
    }
  } catch (_) {
    return {}
  }
}

/** Сохранить единый снимок `flow_layout_coords` из текущего LS геометрии блоков + CSS-сайдбара. */
function syncFlowLayoutCoords() {
  try {
    let blocks = {}
    const rawLegacy = localStorage.getItem(FLOW_HOME_BLOCK_GEOMETRY_LS)
    if (rawLegacy) {
      const p = JSON.parse(rawLegacy)
      if (p && typeof p === 'object' && !Array.isArray(p)) blocks = p
    }
    localStorage.setItem(
      FLOW_LAYOUT_COORDS_LS,
      JSON.stringify({
        v: 1,
        blocks,
        sidebar: snapshotSidebarLayoutForCoords(),
        updatedAt: Date.now(),
      }),
    )
  } catch (_) {}
}

function loadHomeBlockGeometryRaw() {
  try {
    let legacy = null
    const rawLegacy = localStorage.getItem(FLOW_HOME_BLOCK_GEOMETRY_LS)
    if (rawLegacy) {
      const p = JSON.parse(rawLegacy)
      if (p && typeof p === 'object' && !Array.isArray(p)) legacy = p
    }
    const legacyKeys = legacy ? Object.keys(legacy).filter((k) => legacy[k] && typeof legacy[k] === 'object') : []
    let fromCoords = null
    try {
      const rawU = localStorage.getItem(FLOW_LAYOUT_COORDS_LS)
      if (rawU) {
        const u = JSON.parse(rawU)
        if (u?.blocks && typeof u.blocks === 'object' && !Array.isArray(u.blocks)) fromCoords = u.blocks
      }
    } catch (_) {}
    const coordKeys = fromCoords ? Object.keys(fromCoords) : []

    if (legacyKeys.length > 0) return legacy

    if (coordKeys.length > 0 && fromCoords) {
      const g = cloneHomeGeometry(fromCoords)
      try {
        localStorage.setItem(FLOW_HOME_BLOCK_GEOMETRY_LS, JSON.stringify(g))
      } catch (_) {}
      syncFlowLayoutCoords()
      return g
    }
  } catch (_) {}
  return null
}

function cloneHomeGeometry(geom) {
  const o = {}
  if (!geom) return o
  for (const k of Object.keys(geom)) {
    const v = geom[k]
    if (!v || typeof v !== 'object') continue
    const x = +v.x
    const y = +v.y
    const w = +v.w
    const h = +v.h
    if (![x, y, w, h].every(Number.isFinite)) continue
    o[k] = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
  }
  return o
}

function homeGeomRectValid(rect) {
  return !!(rect && rect.width >= 48 && rect.height >= 48)
}

/** Одна запись для отрисовки position:absolute блока. */
function homeGeomQuadValid(g) {
  return !!(
    g &&
    Number.isFinite(g.x) &&
    Number.isFinite(g.y) &&
    Number.isFinite(g.w) &&
    Number.isFinite(g.h) &&
    g.w >= 48 &&
    g.h >= 48
  )
}

/** Главная не скрыта — иначе getBoundingClientRect даёт «нулевой» контур и затрёт сохранённые координаты. */
function isHomePageActiveForDashboardMeasure() {
  const pageHome = document.getElementById('page-home')
  return !!(pageHome && pageHome.classList.contains('active'))
}

function readHomeBlockGeometryFromDom() {
  const stack = document.getElementById('home-dashboard-stack')
  if (!stack || !isHomePageActiveForDashboardMeasure()) return {}
  const sr = stack.getBoundingClientRect()
  if (!homeGeomRectValid(sr)) return {}
  const g = {}
  stack.querySelectorAll(':scope > .home-dash-block[data-home-block]').forEach((el) => {
    const id = el.dataset.homeBlock
    const r = el.getBoundingClientRect()
    const w = Math.round(r.width)
    const h = Math.round(r.height)
    if (!Number.isFinite(w) || !Number.isFinite(h) || !homeGeomQuadValid({ x: 0, y: 0, w, h })) return
    const x = Math.round(r.left - sr.left)
    const y = Math.round(r.top - sr.top)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    g[id] = { x, y, w, h }
  })
  return g
}

function saveHomeBlockGeometry(geom) {
  try {
    const payload = geom && typeof geom === 'object' && !Array.isArray(geom) ? geom : {}
    localStorage.setItem(FLOW_HOME_BLOCK_GEOMETRY_LS, JSON.stringify(payload))
    syncFlowLayoutCoords()
  } catch (_) {}
}

const _HOME_BLOCK_MIN = Object.freeze({
  welcome: [200, 96],
  clone: [300, 200],
  cards: [240, 130],
  wave: [240, 160],
})

function clampHomeBlockInStack(stack, id, geom) {
  const g = geom[id]
  if (!g || !stack) return
  const sw = Math.max(stack.clientWidth, 200)
  const [minW, minH] = _HOME_BLOCK_MIN[id] || [200, 120]
  g.w = Math.max(minW, Math.min(Math.round(g.w), sw - 8))
  g.h = Math.max(minH, Math.round(g.h))
  g.x = Math.max(4, Math.min(Math.round(g.x), Math.max(sw - g.w - 4, 4)))
  g.y = Math.max(4, Math.round(g.y))
}

function applyHomeBlockGeometry(geom) {
  const stack = document.getElementById('home-dashboard-stack')
  if (!stack) return
  const ids = [...stack.querySelectorAll(':scope > .home-dash-block[data-home-block]')].map((el) => el.dataset.homeBlock)
  const g0 = cloneHomeGeometry(geom)
  const has = ids.some((id) => g0[id] && homeGeomQuadValid(g0[id]))
  stack.classList.toggle('home-dashboard-stack--geometry', Boolean(has))
  if (!has) {
    stack.querySelectorAll(':scope > .home-dash-block').forEach((el) => {
      el.style.left = el.style.top = el.style.width = el.style.height = ''
      el.style.zIndex = ''
    })
    stack.style.minHeight = ''
    return
  }
  let maxB = 0
  ids.forEach((id) => {
    const el = stack.querySelector(`:scope > .home-dash-block[data-home-block="${id}"]`)
    const g = g0[id]
    if (!el || !g || !homeGeomQuadValid(g)) return
    el.style.left = `${Math.round(g.x)}px`
    el.style.top = `${Math.round(g.y)}px`
    el.style.width = `${Math.round(g.w)}px`
    el.style.height = `${Math.round(g.h)}px`
    maxB = Math.max(maxB, g.y + g.h)
  })
  stack.style.minHeight = `${Math.max(Math.ceil(maxB + 24), 240)}px`
}

function persistHomeDashboardLayoutFromDom() {
  if (!isVisualFloatedLayout()) return
  const stack = document.getElementById('home-dashboard-stack')
  if (!stack) return
  const hasGeoClass = stack.classList.contains('home-dashboard-stack--geometry')
  const hasInlineGeom = [...stack.querySelectorAll(':scope > .home-dash-block[data-home-block]')].some(
    (el) =>
      el.style.left &&
      el.style.top &&
      el.style.width &&
      el.style.height,
  )
  if (!hasGeoClass && !hasInlineGeom) return
  const g = readHomeBlockGeometryFromDom()
  const sanitized = {}
  for (const id of Object.keys(g)) {
    if (homeGeomQuadValid(g[id])) sanitized[id] = g[id]
  }
  if (Object.keys(sanitized).length === 0) return
  saveHomeBlockGeometry(sanitized)
  try {
    stack.classList.add('home-dashboard-stack--geometry')
  } catch (_) {}
}

let _homeDashGeomReflowT = null
/** После show главной один проход clamp+paint (двойная отрисовка — стабильные clientWidth/stack). */
function scheduleHomeDashboardGeometryReflow() {
  if (!isVisualFloatedLayout()) return
  clearTimeout(_homeDashGeomReflowT)
  _homeDashGeomReflowT = setTimeout(() => {
    _homeDashGeomReflowT = null
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const stack = document.getElementById('home-dashboard-stack')
        if (_activePageId !== 'home' || !isHomePageActiveForDashboardMeasure()) return
        if (!stack?.classList.contains('home-dashboard-stack--geometry')) return
        if (!homeGeomRectValid(stack.getBoundingClientRect())) return
        const g = cloneHomeGeometry(loadHomeBlockGeometryRaw())
        if (!Object.keys(g).length) return
        getHomeBlockIdsFromStack(stack).forEach((id) => clampHomeBlockInStack(stack, id, g))
        applyHomeBlockGeometry(g)
        try {
          saveHomeBlockGeometry(g)
        } catch (_) {}
        try {
          resizeHomeVisualizerCanvas()
        } catch (_) {}
        try {
          alignHomeHeaderToPlay()
        } catch (_) {}
        scheduleMainShiftRemeasure()
      })
    })
  }, 0)
}

function reclampHomeGeometryOnResize() {
  scheduleHomeDashboardGeometryReflow()
}

function refreshHomeDashboardLayoutAfterContentChange() {
  if (!isVisualFloatedLayout()) {
    applyStaticHomeDashboardOrder()
    applyHomeBlockGeometry(null)
    applyHomeEditorZoom(1)
    return
  }
  applyHomeDashboardOrder()
  const raw = loadHomeBlockGeometryRaw()
  const cloned = cloneHomeGeometry(raw)
  if (cloned && Object.keys(cloned).some((id) => homeGeomQuadValid(cloned[id]))) {
    applyHomeBlockGeometry(cloned)
    scheduleHomeDashboardGeometryReflow()
  } else applyHomeBlockGeometry(null)
  syncHomeEditorZoomFromStorage()
}

/** Сайдбар: сброс раскладки — только в теме «Минимал» (floated). */
function resetHomeDashboardLayoutPressed() {
  if (!isVisualFloatedLayout()) {
    showToast('Сброс раскладки доступен только в интерфейсе «Минимал»')
    return
  }
  resetHomeDashboardLayout()
}

/** Сброс сохранённого макета главной (конструктор + порядок). Без интерact.js — чистые LS + DOM. */
function resetHomeDashboardLayout() {
  try {
    localStorage.removeItem(FLOW_HOME_BLOCK_GEOMETRY_LS)
    localStorage.removeItem(FLOW_HOME_BLOCK_ORDER_LS)
    localStorage.removeItem(FLOW_LAYOUT_COORDS_LS)
    localStorage.removeItem(FLOW_HOME_EDITOR_ZOOM_LS)
  } catch (_) {}
  applyHomeEditorZoom(1)
  document.body.classList.remove('home-layout-edit', 'flow-edit-enabled')
  syncHomeLayoutEditButton()
  teardownHomeDashboardDrag(true)
  try {
    _teardownSidebarPanelDrag()
  } catch (_) {}
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
  if (_activePageId === 'home') {
    requestAnimationFrame(() => {
      resizeHomeVisualizerCanvas()
      try {
        alignHomeHeaderToPlay()
      } catch (_) {}
      scheduleMainShiftRemeasure()
    })
  }
  showToast('Раскладка главной сброшена')
  queueMicrotask(() => scheduleMainShiftRemeasure())
}

/** Прямые потомки `#home-dashboard-stack` — порядок узла = порядок в конструкторе. */
function getHomeBlockIdsFromStack(stack) {
  if (!stack) return []
  return [...stack.children]
    .filter((c) => c?.classList?.contains?.('home-dash-block') && c?.dataset?.homeBlock)
    .map((c) => String(c.dataset.homeBlock))
}

/** Только id из DOM по сохранённому порядку; отсутствовавшие ранее блоки — в конец. */
function mergeSavedHomeOrderWithDom(saved, domOrderedIds) {
  const domSet = new Set(domOrderedIds)
  const seen = new Set()
  const out = []
  if (Array.isArray(saved)) {
    for (const id of saved) {
      const sid = typeof id === 'string' ? id : ''
      if (sid && domSet.has(sid) && !seen.has(sid)) {
        seen.add(sid)
        out.push(sid)
      }
    }
  }
  for (const id of domOrderedIds) {
    if (id && !seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

/** Статичный порядок блоков главной («Минимализм») — всегда как в разметке по умолчанию. */
function applyStaticHomeDashboardOrder() {
  const stack = document.getElementById('home-dashboard-stack')
  if (!stack) return
  const map = {}
  stack.querySelectorAll(':scope > .home-dash-block[data-home-block]').forEach((el) => {
    map[el.dataset.homeBlock] = el
  })
  DEFAULT_HOME_BLOCK_ORDER.forEach((id) => {
    const el = map[id]
    if (el) stack.appendChild(el)
  })
}

function applyHomeDashboardOrder() {
  const stack = document.getElementById('home-dashboard-stack')
  if (!stack) return
  const domIds = getHomeBlockIdsFromStack(stack)
  if (!domIds.length) return
  let saved = []
  try {
    const p = JSON.parse(localStorage.getItem(FLOW_HOME_BLOCK_ORDER_LS) || 'null')
    if (Array.isArray(p)) saved = p
  } catch (_) {}
  const order = mergeSavedHomeOrderWithDom(saved, domIds)
  try {
    if (JSON.stringify(saved) !== JSON.stringify(order)) {
      localStorage.setItem(FLOW_HOME_BLOCK_ORDER_LS, JSON.stringify(order))
    }
  } catch (_) {}

  const map = {}
  stack.querySelectorAll(':scope > .home-dash-block[data-home-block]').forEach((el) => {
    map[el.dataset.homeBlock] = el
  })
  order.forEach((id) => {
    const el = map[id]
    if (el) stack.appendChild(el)
  })
}

let _homeDashDragState = null

function teardownHomeDashboardDrag(force = false) {
  const st = _homeDashDragState
  if (!st) return
  window.removeEventListener('pointermove', st.mv, true)
  window.removeEventListener('pointerup', st.fin, true)
  window.removeEventListener('pointercancel', st.fin, true)
  if (st.block) {
    st.block.classList.remove('home-dash-block--dragging')
    st.block.style.zIndex = ''
  }
  document.body.classList.remove('home-dash-dragging', 'home-dash-sizing')
  try {
    st.captureEl?.releasePointerCapture?.(st.pointerId)
  } catch (_) {}
  _homeDashDragState = null
  if (!force) {
    persistHomeDashboardLayoutFromDom()
    requestAnimationFrame(() => {
      resizeHomeVisualizerCanvas()
      try {
        alignHomeHeaderToPlay()
      } catch (_) {}
      scheduleMainShiftRemeasure()
    })
  }
}

function setupHomeDashboardDragAndDrop() {
  const stack = document.getElementById('home-dashboard-stack')
  if (!stack || stack.dataset.homeDndReady === '1') return
  stack.dataset.homeDndReady = '1'

  stack.addEventListener(
    'pointerdown',
    (e) => {
      if (!document.body.classList.contains('flow-edit-enabled')) return
      if (!stack.classList.contains('home-dashboard-stack--geometry')) return
      const block = e.target.closest('.home-dash-block[data-home-block]')
      if (!block || !stack.contains(block)) return
      const id = block.dataset.homeBlock
      const resizeGrip = e.target.closest('.home-dash-resize, .resizer-corner')
      const dragGrip = e.target.closest('.home-dash-drag, .home-dash-handle')
      const isResize = resizeGrip && block.contains(resizeGrip)
      if (!isResize) {
        if (!dragGrip || !block.contains(dragGrip)) return
      }

      e.preventDefault()
      e.stopPropagation()
      teardownHomeDashboardDrag(true)

      const domG = readHomeBlockGeometryFromDom()
      const geom = cloneHomeGeometry(loadHomeBlockGeometryRaw())
      Object.keys(domG).forEach((k) => {
        if (!geom[k]) geom[k] = domG[k]
      })
      if (!geom[id]) geom[id] = domG[id]
      const origin = { ...geom[id] }
      block.classList.add('home-dash-block--dragging')
      document.body.classList.add(isResize ? 'home-dash-sizing' : 'home-dash-dragging')
      block.style.zIndex = '60'

      const startX = e.clientX
      const startY = e.clientY
      const captureEl = isResize ? resizeGrip : dragGrip

      const mv = (ev) => {
        if (isResize) {
          geom[id].w = Math.round(origin.w + ev.clientX - startX)
          geom[id].h = Math.round(origin.h + ev.clientY - startY)
        } else {
          geom[id].x = Math.round(origin.x + ev.clientX - startX)
          geom[id].y = Math.round(origin.y + ev.clientY - startY)
        }
        clampHomeBlockInStack(stack, id, geom)
        applyHomeBlockGeometry(geom)
      }
      const fin = () => {
        teardownHomeDashboardDrag(false)
      }
      window.addEventListener('pointermove', mv, true)
      window.addEventListener('pointerup', fin, true)
      window.addEventListener('pointercancel', fin, true)
      try {
        captureEl.setPointerCapture(e.pointerId)
      } catch (_) {}
      _homeDashDragState = { mv, fin, stack, block, captureEl, pointerId: e.pointerId }
    },
    true,
  )
}

/** API из плана «свободных блоков»: элемент уже обслуживается делегированием со стека. */
function makeBlockDynamic(sectionEl) {
  return !!(sectionEl && typeof sectionEl.matches === 'function' && sectionEl.matches('.home-dash-block[data-home-block]'))
}

/** Повторно применить порядок/геометрию из хранилища и обновить flow_layout_coords. */
function initFloatingHomeWorkspace() {
  refreshHomeDashboardLayoutAfterContentChange()
  syncFlowLayoutCoords()
}

function syncHomeLayoutEditButton() {
  const btn = document.getElementById('btn-home-layout-edit')
  const label = document.getElementById('btn-home-layout-edit-label')
  if (!btn) return
  const on = document.body.classList.contains('home-layout-edit')
  btn.classList.toggle('active', on)
  btn.setAttribute('aria-pressed', on ? 'true' : 'false')
  if (label) label.textContent = on ? 'Сохранить' : 'Изменить'
  btn.title = on ? 'Сохранить расположение блоков главной' : 'Изменить расположение блоков главной'
  btn.setAttribute('aria-label', on ? 'Сохранить макет главной' : 'Редактировать макет главной')
}

/** Конструктор главной: классы body + сохранённая геометрия в LS (flow_home_block_geometry). */
function toggleHomeLayoutEdit() {
  if (!isVisualFloatedLayout()) {
    showToast('Конструктор главной доступен только в интерфейсе «Минимал»')
    return
  }
  const on = !document.body.classList.contains('home-layout-edit')
  document.body.classList.toggle('home-layout-edit', on)
  document.body.classList.toggle('flow-edit-enabled', on)
  syncHomeLayoutEditButton()
  if (on) syncHomeEditorZoomFromStorage()
  const stack = document.getElementById('home-dashboard-stack')
  if (on) {
    let geom = cloneHomeGeometry(loadHomeBlockGeometryRaw())
    if (!Object.keys(geom).length) {
      applyHomeBlockGeometry(null)
      requestAnimationFrame(() => {
        geom = readHomeBlockGeometryFromDom()
        if (Object.keys(geom).length) {
          saveHomeBlockGeometry(geom)
          applyHomeBlockGeometry(cloneHomeGeometry(geom))
        }
        scheduleHomeDashboardGeometryReflow()
        showToast('Редактор: зона под контентом — перенос, уголок — размер')
        pulseHomeVisualLayoutSync()
      })
    } else {
      const snap = readHomeBlockGeometryFromDom()
      Object.keys(snap).forEach((id) => {
        if (!geom[id] && homeGeomQuadValid(snap[id])) geom[id] = snap[id]
      })
      saveHomeBlockGeometry(geom)
      applyHomeBlockGeometry(cloneHomeGeometry(geom))
      scheduleHomeDashboardGeometryReflow()
      showToast('Редактор: зона под контентом — перенос, уголок — размер')
      pulseHomeVisualLayoutSync()
    }
  } else {
    try {
      _teardownSidebarPanelDrag()
    } catch (_) {}
    persistHomeDashboardLayoutFromDom()
    applyHomeBlockGeometry(cloneHomeGeometry(loadHomeBlockGeometryRaw()))
    showToast('Макет главной сохранён')
    pulseHomeVisualLayoutSync()
  }
  queueMicrotask(() => scheduleMainShiftRemeasure())
}

/** Троттлинг отрисовки виджета на главной: 60 FPS + Web Audio + canvas давали микрофризы при режиме «волна». */
let _homeVizLastDrawAt = 0

function drawHomeVisualizerFrame() {
  const wrap = document.getElementById('home-visualizer-wrap')
  if (!wrap || wrap.classList.contains('hidden')) return
  const canvas = document.getElementById('home-visualizer-canvas')
  if (!canvas) return
  try {
    if (document.body.classList.contains('flow-opt-bg-sleep')) return
    if (document.body.classList.contains('flow-opt-game-sleep')) return
  } catch (_) {}
  let ctx = canvas._flowViz2d
  if (!ctx) {
    try {
      ctx = canvas.getContext('2d', { alpha: true, desynchronized: true })
    } catch (_) {
      ctx = null
    }
    if (!ctx) ctx = canvas.getContext('2d')
    canvas._flowViz2d = ctx
  }
  if (!ctx) return
  const v = getVisual()
  const hw = Object.assign({ enabled: true, mode: 'bars', intensity: 100, smoothing: 72 }, v.homeWidget || {})
  if (!hw.enabled || hw.mode === 'image') return
  const w = canvas.width
  const h = canvas.height
  ctx.clearRect(0, 0, w, h)
  const canAnalyze = ensureAudioAnalyzer() && !audio.paused && !audio.ended
  if (canAnalyze) {
    try { _analyser.smoothingTimeConstant = Math.max(0.2, Math.min(0.95, Number(hw.smoothing || 72) / 100)) } catch (_) {}
    _analyser.getByteFrequencyData(_freqData)
  }
  const data = _freqData || new Uint8Array(128)
  const intensityScale = Math.max(0.6, Math.min(1.8, Number(hw.intensity || 100) / 100))
  const baseColor = v.accent2 || '#9ca3af'
  ctx.strokeStyle = baseColor
  ctx.fillStyle = baseColor
  ctx.globalAlpha = 0.9
  const mode = typeof normalizeHomeWidgetMode === 'function' ? normalizeHomeWidgetMode(hw.mode) : hw.mode
  if (mode === 'liquid') {
    const cols = 32
    const t = performance.now() * 0.001
    const pts = []
    for (let i = 0; i <= cols; i++) {
      const ratio = i / cols
      const binIdx = Math.min(data.length - 1, Math.floor(Math.pow(ratio, 1.45) * (data.length - 1)))
      let val = data[binIdx] || 0
      if (!canAnalyze) val = 48 + Math.sin(ratio * 9 + t * 2.2) * 36 + Math.sin(ratio * 3.1 - t) * 22
      else val = Math.min(255, val * 1.05 + Math.sin(ratio * 6 + t * 3) * 14)
      pts.push({ x: ratio * w, y: h - (Math.min(255, val * intensityScale) / 255) * (h - 14) - 8 })
    }
    ctx.beginPath()
    ctx.moveTo(0, h)
    ctx.lineTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length - 1; i++) {
      const xc = (pts[i].x + pts[i + 1].x) / 2
      const yc = (pts[i].y + pts[i + 1].y) / 2
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc)
    }
    ctx.lineTo(w, pts[pts.length - 1].y)
    ctx.lineTo(w, h)
    ctx.closePath()
    const fillGrad = ctx.createLinearGradient(0, 0, 0, h)
    fillGrad.addColorStop(0, 'rgba(255,255,255,0.82)')
    fillGrad.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = fillGrad
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.lineWidth = 1.8
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length - 1; i++) {
      const xc = (pts[i].x + pts[i + 1].x) / 2
      const yc = (pts[i].y + pts[i + 1].y) / 2
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc)
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y)
    ctx.stroke()
    return
  }
  const bars = 56
  const step = Math.max(1, Math.floor(data.length / bars))
  const bw = (w - 20) / bars
  for (let i = 0; i < bars; i++) {
    const val = data[i * step] || 0
    const bh = 8 + (Math.min(255, val * intensityScale) / 255) * (h - 24)
    const x = 10 + i * bw
    const y = h - bh - 6
    ctx.fillRect(x, y, Math.max(2, bw - 2), bh)
  }
}

function startHomeVisualizerLoop() {
  const tick = () => {
    if (_activePageId === 'home') {
      if (typeof document !== 'undefined' && document.hidden) {
        requestAnimationFrame(tick)
        return
      }
      let playing = false
      try {
        playing = Boolean(audio && !audio.paused && !audio.ended)
      } catch (_) {}
      // При открытом тексте и проигре визуализатор главной отключён — иначе два тяжёлых RAF подряд дают микрофризы.
      let gameSleep = false
      try {
        gameSleep = document.body.classList.contains('flow-opt-game-sleep')
      } catch (_) {}
      const skipViz = Boolean(_lyricsOpen && playing) || gameSleep
      let shouldDraw = !skipViz
      if (shouldDraw) {
        const v = getVisual()
        const hw = Object.assign({ enabled: true, mode: 'bars', intensity: 100, smoothing: 72 }, v.homeWidget || {})
        if (!hw.enabled || hw.mode === 'image') shouldDraw = false
        else {
          const now = performance.now()
          const mode = typeof normalizeHomeWidgetMode === 'function' ? normalizeHomeWidgetMode(hw.mode) : hw.mode
          const heavy = mode === 'liquid'
          const minMs = playing ? (heavy ? 66 : 40) : 240
          if (now - _homeVizLastDrawAt < minMs) shouldDraw = false
          else _homeVizLastDrawAt = now
        }
      }
      if (shouldDraw) drawHomeVisualizerFrame()
      requestAnimationFrame(tick)
    } else {
      setTimeout(() => requestAnimationFrame(tick), 250)
    }
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
  try {
    if (typeof shouldIsolateHostTrackVisualsFromRoomGuest === 'function' && shouldIsolateHostTrackVisualsFromRoomGuest()) {
      if (_playerModeActive) syncPlayerModeUI()
      return
    }
  } catch (_) {}
  updateYandexPlayerTheme(track)
  if (_playerModeActive) syncPlayerModeUI()
}

// в”Ђв”Ђв”Ђ NAVIGATION в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
let _activePageId = 'main'
let _deferredPageRenderRaf = 0

function runDeferredPageRender(id) {
  if (id === 'main') return renderMainHub()
  if (id === 'home') return renderQueue()
  if (id === 'liked') return renderLiked()
  if (id === 'library') return renderPlaylists()
  if (id === 'social') return renderFriends()
  if (id === 'rooms') { renderRoomMembers(); return renderRoomQueue() }
  if (id === 'profile') return renderProfilePage()
  if (id === 'settings') return loadSettingsPage()
}

function openPage(id, opts = {}) {
  toggleYandexWaveModes(false)
  const force = Boolean(opts && opts.force)
  if (!force && id === _activePageId) return
  const prevPage = _activePageId
  if (prevPage === 'home' && id !== 'home') {
    if (
      isVisualFloatedLayout() &&
      document.getElementById('home-dashboard-stack')?.classList.contains('home-dashboard-stack--geometry')
    ) {
      persistHomeDashboardLayoutFromDom()
    }
    document.body.classList.remove('home-layout-edit', 'flow-edit-enabled')
    syncHomeLayoutEditButton()
    teardownHomeDashboardDrag(true)
    try {
      _teardownSidebarPanelDrag()
    } catch (_) {}
  }
  if (id === 'social') ensureSocialUI()
  if (id === 'rooms') ensureRoomsUI()
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'))
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'))
  document.getElementById('page-'+id)?.classList.add('active')
  const navItem = document.querySelector(`.sidebar-nav .nav-item[data-nav-page="${id}"]`)
  if (navItem) {
    navItem.classList.add('active')
    navItem.classList.add('flow-nav-item--pulse')
    window.setTimeout(() => navItem.classList.remove('flow-nav-item--pulse'), 460)
  }
  _activePageId = id
  try { document.body.setAttribute('data-active-page', id) } catch {}
  try {
    applyMediaPlayerBarVisibility()
  } catch (_) {}
  syncSearchBarCollapsedState()
  if (_deferredPageRenderRaf) cancelAnimationFrame(_deferredPageRenderRaf)
  _deferredPageRenderRaf = requestAnimationFrame(() => {
    _deferredPageRenderRaf = 0
    runDeferredPageRender(id)
  })
  if (id === 'search') {
    queueMicrotask(() => {
      try {
        if (typeof syncHomeNxSourceLogo === 'function') syncHomeNxSourceLogo()
      } catch (_) {}
      try {
        const shell = document.getElementById('nx-search-shell')
        if (shell && typeof hydrateFlowLucideIcons === 'function') hydrateFlowLucideIcons(shell)
      } catch (_) {}
    })
  }
  if (id === 'home') {
    queueMicrotask(() => {
      try {
        applyMediaQueueLayout()
      } catch (_) {}
      try {
        if (isVisualFloatedLayout()) {
          refreshHomeDashboardLayoutAfterContentChange()
        }
      } catch (_) {}
      requestAnimationFrame(() => {
        try {
          resizeHomeVisualizerCanvas()
        } catch (_) {}
        try {
          alignHomeHeaderToPlay()
        } catch (_) {}
        try {
          scheduleMainShiftRemeasure()
        } catch (_) {}
      })
    })
  }
}

// в”Ђв”Ђв”Ђ PLAYER в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
/** Ключ для локального кэша потока (Spotify / SoundCloud / Audius). */
function getStreamCacheKey(track) {
  if (!track || typeof track !== 'object') return ''
  const src = String(track.source || '').toLowerCase()
  if (src !== 'soundcloud' && src !== 'audius' && src !== 'spotify') return ''
  const id = String(track.spotifyId || track.id || '').trim()
  if (!id) return ''
  return `${src}:${id}`
}

async function playTrackObj(track, opts = {}) {
  if (_roomState?.roomId && !_roomState?.host && !opts?.remoteSync) {
    enqueueSharedTrack(track)
    return
  }
  if (_roomState?.roomId && _roomState?.host && !opts?.remoteSync && !opts?.fromSharedQueue && !opts?.allowRoomDirectPlay) {
    enqueueSharedTrack(track)
    showToast('Трек добавлен в очередь комнаты. Для запуска выбери трек в очереди.')
    return
  }
  const reqId = ++_playRequestSeq
  const isStale = () => reqId !== _playRequestSeq
  if (!opts?._recoverPlayback) _flowYandexStreamRetryId = ''
  track = sanitizeTrack(track)
  if (opts?.remoteSync && _roomState?.roomId && !_roomState?.host) {
    track = Object.assign({}, track, { _flowSkipGlobalThemeFromTrack: true })
  }
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
  if (!opts._recoverPlayback) {
    const st = getListenStats()
    if (st.lastTrackKey !== newTrackKey) {
      saveListenStats({ totalTracks: Number(st.totalTracks || 0) + 1, lastTrackKey: newTrackKey })
      try {
        localStorage.setItem('flow_playback_rate', '1')
      } catch (_) {}
      try {
        if (typeof setPlaybackRate === 'function') setPlaybackRate(1)
        else if (typeof applyPlaybackRate === 'function') applyPlaybackRate()
      } catch (_) {}
    }
    pushListenHistory(track)
    try {
      onHomeNxTrackEqChanged(track)
    } catch (_) {}
  }
  if (_activePageId === 'main') renderMyWave()
  let streamUrl = track.url
  let streamEngine = null
  const nameEl = document.getElementById('player-name')
  const artistEl = document.getElementById('player-artist')
  const playBtn = document.getElementById('play-btn')
  if (nameEl) nameEl.textContent = track.title || 'Без названия'
  const setStage = (text) => { if (artistEl) artistEl.textContent = text }
  setStage('Загрузка…')
  if (playBtn) playBtn.innerHTML = '<svg class="ui-icon spin-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7v5l3 2"/></svg>'

  if (String(track.source || '').toLowerCase() === 'yandex' && !/^https?:\/\//i.test(String(streamUrl || '')) && track.id && window.api?.yandexStream) {
    const ymTok = String(getSettings()?.yandexToken || '').trim()
    if (!ymTok) {
      showToast('Яндекс: укажи токен в настройках', true)
      if (playBtn) playBtn.innerHTML = ICONS.play
      setStage('Яндекс: нужен токен')
      return
    }
    setStage('Яндекс: получаю поток…')
    const ymRes = await window.api.yandexStream(String(track.id), ymTok).catch((e) => ({ ok: false, error: e?.message || String(e) }))
    let resolvedYmUrl = ymRes?.ok && ymRes?.url ? String(ymRes.url) : ''
    if (isStale()) return
    if (!ymRes?.ok || !ymRes.url) {
      const ymFallbackQuery = `${track.artist || ''} ${track.title || ''}`.trim()
      const ymFallbackList = ymFallbackQuery && window.api?.yandexSearch
        ? await window.api.yandexSearch(ymFallbackQuery, ymTok).catch(() => [])
        : []
      const ymFallback = Array.isArray(ymFallbackList)
        ? ymFallbackList.find((item) => String(item?.id || '').trim())
        : null
      const fallbackId = String(ymFallback?.id || '').trim()
      if (fallbackId && fallbackId !== String(track.id || '').trim()) {
        setStage('Яндекс: пробую альтернативный трек…')
        const ymRetry = await window.api.yandexStream(fallbackId, ymTok).catch((e) => ({ ok: false, error: e?.message || String(e) }))
        if (isStale()) return
        if (ymRetry?.ok && ymRetry?.url) {
          resolvedYmUrl = String(ymRetry.url)
          track = Object.assign({}, track, {
            id: fallbackId,
            url: resolvedYmUrl,
            cover: track.cover || ymFallback?.cover || null,
          })
          streamUrl = track.url
          currentTrack = track
        } else {
          showToast('Яндекс: ' + (ymRetry?.error || ymRes?.error || 'не удалось получить поток'), true)
          if (playBtn) playBtn.innerHTML = ICONS.play
          setStage('Яндекс: ошибка')
          return
        }
      } else {
        showToast('Яндекс: ' + (ymRes?.error || 'не удалось получить поток'), true)
        if (playBtn) playBtn.innerHTML = ICONS.play
        setStage('Яндекс: ошибка')
        return
      }
    }
    track = Object.assign({}, track, { url: resolvedYmUrl })
    streamUrl = track.url
    currentTrack = track
  }

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

  let usedStreamCache = false
  const streamCacheKey = getStreamCacheKey(track)
  let remoteUrlForCache = streamUrl
  let finalUrl = streamUrl

  if (
    streamCacheKey &&
    window.api?.streamCacheLookup &&
    track.source !== 'youtube' &&
    /^https?:\/\//i.test(streamUrl) &&
    !/127\.0\.0\.1|localhost/i.test(streamUrl)
  ) {
    setStage('Кэш: проверка…')
    const hit = await window.api.streamCacheLookup({ cacheKey: streamCacheKey }).catch(() => ({ hit: false }))
    if (isStale()) return
    if (hit?.hit && hit.url) {
      finalUrl = hit.url
      usedStreamCache = true
      setStage('Кэш: воспроизведение')
    }
  }

  // External streams are played via local proxy for CORS/Range compatibility.
  if (!usedStreamCache) {
    // For yt-dlp direct googlevideo links, direct playback is often more stable than proxy.
    if (window.api?.proxySetUrl && shouldUseProxyStream() && /^https?:\/\//i.test(streamUrl) && streamEngine !== 'yt-dlp') {
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
              remoteUrlForCache = streamUrl
              if (fresh.inst) _ytInstanceCache = fresh.inst
              finalUrl = (window.api?.proxySetUrl && shouldUseProxyStream() && /^https?:\/\//i.test(streamUrl)) ? await window.api.proxySetUrl(streamUrl) : streamUrl
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
  } else {
    console.log('PLAY URL (offline cache):', finalUrl)
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
    const guestRoomBuffer =
      Boolean(opts?.remoteSync) && Boolean(_roomState?.roomId) && !_roomState?.host
    if (guestRoomBuffer) {
      await new Promise((resolve) => {
        let done = false
        let t = null
        const finish = () => {
          if (done) return
          done = true
          if (t) clearTimeout(t)
          try {
            audio.removeEventListener('canplaythrough', finish)
            audio.removeEventListener('canplay', onCan)
          } catch (_) {}
          resolve()
        }
        const onCan = () => {
          if ((audio.readyState || 0) >= 3) finish()
        }
        if ((audio.readyState || 0) >= 4) {
          finish()
          return
        }
        t = setTimeout(finish, 14000)
        audio.addEventListener('canplaythrough', finish, { once: true })
        audio.addEventListener('canplay', onCan, { once: true })
      })
    }
    await audio.play()
    try {
      if (_audioCtx?.state === 'suspended') await _audioCtx.resume().catch(() => {})
    } catch (_) {}
    try {
      ensureAudioAnalyzer()
      if (_audioCtx?.state === 'suspended') await _audioCtx.resume().catch(() => {})
    } catch (_) {}
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
          ? ((window.api?.proxySetUrl && shouldUseProxyStream() && /^https?:\/\//i.test(streamUrl)) ? await window.api.proxySetUrl(streamUrl) : streamUrl)
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
            const freshProxy = window.api?.proxySetUrl && shouldUseProxyStream() && /^https?:\/\//i.test(streamUrl) ? await window.api.proxySetUrl(streamUrl) : streamUrl
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

  if (
    streamCacheKey &&
    !usedStreamCache &&
    started &&
    remoteUrlForCache &&
    /^https?:\/\//i.test(remoteUrlForCache) &&
    !/127\.0\.0\.1|localhost/i.test(remoteUrlForCache) &&
    window.api?.streamCacheStore
  ) {
    window.api.streamCacheStore({ cacheKey: streamCacheKey, url: remoteUrlForCache }).catch(() => {})
  }

  if (nameEl) nameEl.textContent = track.title || 'Без названия'
  if (artistEl) artistEl.textContent = track.artist || '—'
  syncInlineTrackSourcePill(track)
  updateYandexWaveDislikeButtonsVisible()
  renderYandexWaveMoodDock()
  const yr = track?.yandexRotor
  if (yr?.batchId && queueScope === 'myWave' && getMyWaveSource() === 'yandex' && track?.id) {
    const tid = String(track.id)
    if (_yandexRotorTrackStartedForId !== tid) {
      _yandexRotorTrackStartedForId = tid
      const tok = String(getSettings()?.yandexToken || '').trim()
      if (tok && window.api?.yandexRotorFeedback) {
        void window.api.yandexRotorFeedback({
          token: tok,
          station: yr.station || 'user:onyourwave',
          type: 'trackStarted',
          trackId: tid,
          batchId: yr.batchId,
        })
      }
    }
    rememberYandexWaveTracks([track])
  } else {
    _yandexRotorTrackStartedForId = null
  }
  const cover = document.getElementById('player-cover')
  const effectiveCover = getEffectiveCoverUrl(track)
  if (playBtn) playBtn.innerHTML = ICONS.pause
  const pmIcon = document.getElementById('pm-play-icon')
  if (pmIcon) pmIcon.innerHTML = PM_PAUSE_INNER
  updatePlayerLikeBtn()
  // РћР±РЅРѕРІР»СЏРµРј titlebar
  const tinfo = document.getElementById('titlebar-track-info')
  if (tinfo) tinfo.textContent = track.title + (track.artist ? ' вЂ” ' + track.artist : '')
  const deferHeavyPlaybackUi = () => {
    try {
      applyCoverArt(cover, effectiveCover, track.bg || 'linear-gradient(135deg,#7c3aed,#a855f7)')
      updateYandexPlayerTheme(track)
      if (effectiveCover) updateOrbsFromCover(effectiveCover)
      updateBackground()
    } catch (_) {}
  }
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(deferHeavyPlaybackUi))
  } else {
    setTimeout(deferHeavyPlaybackUi, 16)
  }
  // РЎРёРЅС…СЂРѕРЅРёР·РёСЂСѓРµРј fullscreen РїР»РµРµСЂ
  syncPlayerModeUI()
  syncTrackCoverStatus()
  alignHomeHeaderToPlay()
  // Р—Р°РіСЂСѓР¶Р°РµРј lyrics РµСЃР»Рё РїР°РЅРµР»СЊ РѕС‚РєСЂС‹С‚Р°
  if (_lyricsOpen) loadLyrics(track)
  scheduleNextTrackPrewarm(track)
  renderRoomNowPlaying()
  renderRoomQueue()
  _currentTrackStartedAt = Math.floor(Date.now() / 1000)
  pushLastFmNowPlaying(track)
  updateDiscordPresence(track, _roomState)
  if (_roomState?.roomId && _roomState?.host) {
    const onceRoomHostSync = () => {
      try {
        audio.removeEventListener('playing', onceRoomHostSync)
        audio.removeEventListener('canplaythrough', onceRoomHostSync)
      } catch (_) {}
      broadcastPlaybackSync(true)
    }
    if ((audio.readyState || 0) >= 4) broadcastPlaybackSync(true)
    else {
      audio.addEventListener('playing', onceRoomHostSync, { once: true })
      audio.addEventListener('canplaythrough', onceRoomHostSync, { once: true })
    }
  } else {
    broadcastPlaybackSync(true)
  }
  try {
    compactYandexMyWaveQueueIfNeeded()
  } catch (_) {}
  syncHomeCloneUI()
  renderQueue()
  try {
    refreshNowPlayingTrackHighlight()
  } catch (_) {}
}

function scheduleNextTrackPrewarm(referenceTrack = null) {
  try {
    if (_queuePrewarmTimer) {
      clearTimeout(_queuePrewarmTimer)
      _queuePrewarmTimer = null
    }
    const ref = referenceTrack || currentTrack
    if (!ref) return
    const refKey = `${String(ref.source || '').toLowerCase()}:${String(ref.id || ref.ytId || ref.url || '')}:${queueIndex}`
    const src = String(ref.source || '').toLowerCase()
    const delayMs = src === 'yandex' ? 12000 : 6500
    _queuePrewarmTimer = setTimeout(() => {
      _queuePrewarmTimer = null
      if (!audio || audio.paused || audio.ended) return
      if ((audio.readyState || 0) < 3) return
      if (Number(audio.currentTime || 0) < 4) return
      const remain = Number(audio.duration || 0) - Number(audio.currentTime || 0)
      if (Number.isFinite(remain) && remain > 0 && remain < 10) return
      const cur = currentTrack
      const curKey = `${String(cur?.source || '').toLowerCase()}:${String(cur?.id || cur?.ytId || cur?.url || '')}:${queueIndex}`
      if (curKey !== refKey) return
      prewarmNextQueueTrack()
    }, delayMs)
  } catch {}
}

function prewarmNextQueueTrack() {
  try {
    if (!audio || audio.paused || audio.ended) return
    if ((audio.readyState || 0) < 3) return
    const idx = queueIndex + 1
    const next = queue[idx]
    if (!next) return
    const source = String(next.source || '').toLowerCase()
    const markPrewarm = (key, ttlMs = 90000) => {
      const now = Date.now()
      const lastAt = Number(_queuePrewarmAt.get(key) || 0)
      if (now - lastAt < ttlMs) return false
      _queuePrewarmAt.set(key, now)
      return true
    }
    if (source === 'youtube' && next.ytId && window.api?.youtubeStream) {
      const key = `yt:${String(next.ytId)}`
      if (!markPrewarm(key, 90000)) return
      _ytPrewarmAt.set(String(next.ytId), Date.now())
      window.api.youtubeStream(next.ytId, _ytInstanceCache, { forceFresh: false })
        .then((res) => {
          if (!res?.ok || !res?.url) return
          const cur = queue[idx]
          if (!cur || cur.ytId !== next.ytId) return
          queue[idx] = Object.assign({}, cur, { url: res.url, _streamInst: res.inst || null })
        })
        .catch(() => {})
      return
    }
    if (source === 'soundcloud' && next.scTranscoding && window.api?.scStream) {
      const key = `sc:${String(next.id || next.scTranscoding)}`
      if (!markPrewarm(key, 120000)) return
      window.api.scStream(next.scTranscoding, next.scClientId)
        .then((res) => {
          if (!res?.ok || !res?.url) return
          const cur = queue[idx]
          if (!cur || String(cur.source || '').toLowerCase() !== 'soundcloud') return
          queue[idx] = Object.assign({}, cur, { url: res.url })
        })
        .catch(() => {})
      return
    }
    if (source === 'yandex' && next.id && !/^https?:\/\//i.test(String(next.url || '')) && window.api?.yandexStream) {
      const ymTok = String(getSettings()?.yandexToken || '').trim()
      if (!ymTok) return
      const key = `ym:${String(next.id)}`
      if (!markPrewarm(key, 120000)) return
      window.api.yandexStream(String(next.id), ymTok)
        .then((res) => {
          if (!res?.ok || !res?.url) return
          const cur = queue[idx]
          if (!cur || String(cur.source || '').toLowerCase() !== 'yandex' || String(cur.id || '') !== String(next.id || '')) return
          queue[idx] = Object.assign({}, cur, { url: res.url })
        })
        .catch(() => {})
    }
  } catch {}
}

async function toggleMyWaveOrbPlayback() {
  const isRoomParticipant = Boolean(_roomState?.roomId)
  const isRoomGuest = isRoomParticipant && !_roomState?.host
  if (isRoomGuest) {
    showHostOnlyToast()
    return
  }
  if (queueScope === 'myWave' && currentTrack) {
    if (!audio.paused) {
      audio.pause()
    } else if (audio.src) {
      audio.play().catch(() => {})
      if (_audioCtx?.state === 'suspended') _audioCtx.resume().catch(() => {})
    } else {
      await startMyWave()
    }
    syncTransportPlayPauseUi()
    return
  }
  await startMyWave()
}
window.toggleMyWaveOrbPlayback = toggleMyWaveOrbPlayback

function syncMyWaveOrbPlayUi() {
  const playing = Boolean(audio && !audio.paused && !audio.ended && queueScope === 'myWave')
  const inner = playing
    ? `<svg class="my-wave-orb-play-svg" viewBox="0 0 24 24" aria-hidden="true">${PM_PAUSE_INNER}</svg>`
    : `<svg class="my-wave-orb-play-svg" viewBox="0 0 24 24" aria-hidden="true">${PM_PLAY_INNER}</svg>`
  document.querySelectorAll('.my-wave-glass-btn--play').forEach((btn) => {
    btn.innerHTML = inner
    btn.setAttribute('aria-label', playing ? 'Пауза' : 'Запустить волну')
  })
}

function syncTransportPlayPauseUi() {
  const playing = Boolean(audio && !audio.paused && !audio.ended)
  const iconInner = playing ? ICONS.pause : ICONS.play
  const playBtn = document.getElementById('play-btn')
  const icon = document.getElementById('pm-play-icon')
  const homePlay = document.getElementById('home-play-btn')
  if (playBtn) playBtn.innerHTML = iconInner
  if (icon) icon.innerHTML = playing ? PM_PAUSE_INNER : PM_PLAY_INNER
  if (homePlay) {
    homePlay.innerHTML = iconInner
    homePlay.setAttribute('aria-label', playing ? 'Пауза' : 'Воспроизвести')
  }
  document.querySelectorAll('.home-clone-controls .play-btn').forEach((btn) => {
    btn.innerHTML = iconInner
    btn.setAttribute('aria-label', playing ? 'Пауза' : 'Воспроизвести')
  })
  try {
    syncMyWaveOrbPlayUi()
  } catch (_) {}
}

function togglePlay() {
  if (!audio.src) return
  const isRoomParticipant = Boolean(_roomState?.roomId)
  const isRoomGuest = isRoomParticipant && !_roomState?.host
  if (isRoomGuest) {
    showHostOnlyToast()
    return
  }
  if (audio.paused) {
    audio.play()
    if (_audioCtx?.state === 'suspended') _audioCtx.resume().catch(() => {})
  } else {
    audio.pause()
  }
  syncTransportPlayPauseUi()
  try {
    refreshNowPlayingTrackHighlight()
  } catch (_) {}
  if (isRoomParticipant) {
    _socialPeer?.send?.({
      type: 'room-control-toggle',
      roomId: _roomState.roomId,
      paused: Boolean(audio.paused),
      currentTime: Number(audio.currentTime || 0),
    })
    saveRoomStateToServer({
      playback_state: { paused: Boolean(audio.paused), currentTime: Number(audio.currentTime || 0) },
      playback_ts: Date.now(),
    }).catch(() => {})
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
  const slider = Math.max(0, Math.min(1, Number(val) || 0))
  // Perceptual curve: mid slider is quieter, fine-grained low-volume control.
  const volume = Math.max(0, Math.min(1, slider * slider))
  audio.volume = volume
  const v1 = document.getElementById('volume')
  const v2 = document.getElementById('pm-volume')
  const v3 = document.getElementById('pm-cover-volume')
  const v4 = document.getElementById('home-nx-volume')
  const v4Val = document.getElementById('home-nx-vol-val')
  if (v1) v1.value = slider
  if (v2) v2.value = slider
  if (v3) v3.value = slider
  if (v4) v4.value = slider
  if (v4Val) v4Val.textContent = String(Math.max(0, Math.min(10, Math.round(slider * 10))))
  try { localStorage.setItem('flow_volume_slider', String(slider)) } catch {}
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
  if (_roomState?.roomId && _roomState?.host) {
    audio.currentTime = 0
    broadcastPlaybackSync(true)
    return
  }
  const resetThreshold = Math.max(1, Math.min(10, (Number(audio.duration) || 0) / 3 || 10))
  if (audio.currentTime > resetThreshold) { audio.currentTime = 0; return }
  const allowShuffle = playbackMode.shuffle && (queueScope === 'liked' || queueScope === 'playlist')
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
  if (_roomState?.roomId && _roomState?.host) {
    if (sharedQueue.length) {
      const nextRoomTrack = sharedQueue.shift()
      renderRoomQueue()
      broadcastQueueUpdate()
      saveRoomStateToServer({ shared_queue: sharedQueue, playback_ts: Date.now() }).catch(() => {})
      if (nextRoomTrack) {
        playTrackObj(nextRoomTrack, { fromSharedQueue: true }).catch(() => {})
      }
    } else if (!autoEnded) {
      showToast('Очередь комнаты пуста')
    }
    return
  }
  if (!queue.length) return
  const ymRotorLeaving =
    queueScope === 'myWave' &&
    getMyWaveSource() === 'yandex' &&
    currentTrack &&
    String(currentTrack.source || '').toLowerCase() === 'yandex' &&
    currentTrack.yandexRotor?.batchId
  if (ymRotorLeaving) {
    const tok = String(getSettings()?.yandexToken || '').trim()
    if (tok && window.api?.yandexRotorFeedback) {
      const typ = autoEnded ? 'trackFinished' : 'skip'
      const dur = Number(audio?.duration || 0) || 0
      const ct = Number(audio?.currentTime || 0) || 0
      const totalPlayedSeconds = typ === 'trackFinished' ? (dur > 1 ? dur : ct) : ct
      void window.api.yandexRotorFeedback({
        token: tok,
        station: currentTrack.yandexRotor.station || 'user:onyourwave',
        type: typ,
        trackId: currentTrack.id,
        batchId: currentTrack.yandexRotor.batchId,
        totalPlayedSeconds,
      })
    }
  }
  if (
    queueScope === 'myWave' &&
    !autoEnded &&
    currentTrack &&
    Number(audio?.duration || 0) > 2 &&
    Number(audio?.currentTime || 0) < (WE?.WAVE_EARLY_SKIP_SEC ?? 14)
  ) {
    recordWaveEarlySkip(currentTrack)
  }
  if (autoEnded && playbackMode.repeat === 'one') {
    audio.currentTime = 0
    audio.play().catch(() => {})
    return
  }
  const allowShuffle = playbackMode.shuffle && (queueScope === 'liked' || queueScope === 'playlist')
  if (allowShuffle) {
    queueIndex = pickRandomQueueIndex()
    if (queueIndex >= 0) playTrackObj(queue[queueIndex])
    return
  }
  if (queueIndex < queue.length - 1) {
    queueIndex++
    playTrackObj(queue[queueIndex])
    maybePreloadMyWave(false)
    return
  }
  if (queueScope === 'myWave') {
    maybePreloadMyWave(true)
    showToast('Волна ищет продолжение...')
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

let _flowAudioErrCooldownAt = 0
let _flowYandexStreamRetryId = ''

function flowAdvanceAfterStreamFailure() {
  _flowYandexStreamRetryId = ''
  try {
    if (queueIndex < queue.length - 1) {
      queueIndex++
      playTrackObj(queue[queueIndex]).catch(() => {})
      return
    }
    if (queueScope === 'myWave') {
      void maybePreloadMyWave(true)
    }
    if (playbackMode.repeat === 'all' && queue.length) {
      queueIndex = 0
      playTrackObj(queue[0]).catch(() => {})
    }
  } catch (_) {}
}

window.__flowPlayerAudioError = function __flowPlayerAudioError(el) {
  console.error('AUDIO ERROR', {
    code: el?.error?.code,
    message: el?.error?.message || null,
    src: el?.currentSrc || el?.src || null,
  })
  const now = Date.now()
  if (now - _flowAudioErrCooldownAt < 650) return
  _flowAudioErrCooldownAt = now
  try {
    const code = el?.error?.code ? `код ${el.error.code}` : 'код неизвестен'
    showToast(`Сбой потока (${code}), пробуем восстановить…`, true)
  } catch (_) {}
  const t = sanitizeTrack(currentTrack || null)
  const src = String(t?.source || '').toLowerCase()
  const tid = String(t?.id || '').trim()
  if (src === 'yandex' && tid && window.api?.yandexStream && _flowYandexStreamRetryId !== tid) {
    _flowYandexStreamRetryId = tid
    const tok = String(getSettings()?.yandexToken || '').trim()
    if (tok) {
      void window.api.yandexStream(tid, tok).then((res) => {
        if (res?.ok && res?.url) {
          const nt = Object.assign({}, t, { url: res.url })
          currentTrack = nt
          if (queue.length && queueIndex >= 0 && queue[queueIndex]) {
            const qi = sanitizeTrack(queue[queueIndex])
            if (String(qi.source || '').toLowerCase() === 'yandex' && String(qi.id || '').trim() === tid) {
              queue[queueIndex] = nt
            }
          }
          return playTrackObj(nt, { _recoverPlayback: true }).catch(() => flowAdvanceAfterStreamFailure())
        }
        flowAdvanceAfterStreamFailure()
      }).catch(() => flowAdvanceAfterStreamFailure())
      return
    }
  }
  flowAdvanceAfterStreamFailure()
}

audio.ontimeupdate = () => {
  // Keep general UI updates lightweight, but make lyrics sync feel tighter.
  const shouldSyncUi = (performance.now() - _lastUiSyncAt) >= 90
  // Во время play караоке крутится в RAF — второй вызов из timeupdate даёт лишний main-thread и рывки UI.
  if (_lyricsOpen && _lyricsData.length && audio.paused) syncLyrics(getLyricsSmoothedTime())
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

    syncHomeClonePlaybackProgress()
    patchProfileNowPlayingProgress()

    if (_profile?.username && !audio.paused && audio.duration) {
      const now = Date.now()
      if (!_listenTickAt) _listenTickAt = now
      const delta = Math.max(0, now - _listenTickAt) / 1000
      _listenTickAt = now
      if (delta > 0 && delta < 4) {
        _listenStatsPendingSec = Number(_listenStatsPendingSec || 0) + delta
        const flushDueMs = 2600
        if (!_listenStatsLastFlushAt) _listenStatsLastFlushAt = now
        if (_listenStatsPendingSec >= 2.2 || (now - _listenStatsLastFlushAt) >= flushDueMs) {
          flushListenStatsPending(false)
        }
      }
    }
  }
  if (queueScope === 'myWave' && !audio.paused && queue.length - queueIndex - 1 <= 2) {
    const t = performance.now()
    if (t - (_lastMyWavePreloadCheckAt || 0) > 3500) {
      _lastMyWavePreloadCheckAt = t
      maybePreloadMyWave(false)
    }
  }
  broadcastPlaybackSync(false)
}
audio.onpause = () => {
  flushListenStatsPending(true)
  _listenTickAt = 0
  if (_roomState?.roomId && _roomState?.host) {
    _socialPeer?.send?.({
      type: 'room-control-toggle',
      roomId: _roomState.roomId,
      paused: true,
      currentTime: Number(audio.currentTime || 0),
    })
    broadcastPlaybackSync(true)
  }
}
audio.onplay = () => {
  if (_roomState?.roomId && _roomState?.host) {
    _socialPeer?.send?.({
      type: 'room-control-toggle',
      roomId: _roomState.roomId,
      paused: false,
      currentTime: Number(audio.currentTime || 0),
    })
    broadcastPlaybackSync(true)
  }
}
audio.onended = () => {
  flushListenStatsPending(true)
  stopLyricsSyncLoop()
  _listenTickAt = 0
  try {
    syncTransportPlayPauseUi()
  } catch (_) {}
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
  if (queueScope === 'myWave' && currentTrack) recordWavePositiveListen(currentTrack)
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

function searchLoadingPlaceholderLine(settings = getSettings()) {
  const src = String(settings?.activeSource || currentSource || 'hybrid').toLowerCase()
  if (src === 'yandex' || src === 'ya' || src === 'ym') return 'Поиск: Яндекс Музыка...'
  if (src === 'vk') return 'Поиск: ВКонтакте...'
  if (src === 'youtube' || src === 'yt') return 'Поиск: YouTube...'
  return 'Поиск: Spotify → SoundCloud → Audius...'
}

function searchTracks(queryOverride = '') {
  if (typeof queryOverride === 'string' && queryOverride.trim()) {
    return searchTracksDirect(queryOverride.trim(), getSettings())
  }
  clearTimeout(searchDebounceTimer)
  let q = document.getElementById('search-input').value.trim()
  const container = document.getElementById('search-results')
  if (!q) { container.innerHTML = ''; return }

  container.innerHTML = `<div class="search-loading"><div class="spinner"></div><span>${searchLoadingPlaceholderLine()}</span></div>`

  searchDebounceTimer = setTimeout(async () => {
    const s = getSettings()
    const key = getSearchCacheKey(q, s, _searchFilter)
    const cached = cacheGet(key)
    if (cached) {
      _lastSearchMode = cached.mode || 'hybrid'
      renderResults(cached.tracks || [])
      return
    }

    try {
      const results = await fetchSearchResultsForFilter(q, s, _searchFilter)
      _lastSearchMode = results.mode
      cacheSet(key, { mode: _lastSearchMode, tracks: results.items })
      renderResults(results.items)
    } catch (err) {
      const message = sanitizeDisplayText(normalizeInvokeError(err))
      container.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg class="ui-icon lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.8 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0Z"/></svg></div><p>${message}</p><small>Источник: ${getSourceLabel()}</small><div style="display:flex;gap:8px;justify-content:center;margin-top:12px"><button class="btn-small" onclick="searchTracks()">Повторить</button><button class="btn-small" onclick="openPage('settings')">Настройки</button></div></div>`
    }
  }, 350)
}

async function searchTracksDirect(query, settings = getSettings(), filter = 'tracks') {
  const q = String(query || '').trim()
  if (!q) return []
  const pack = await fetchSearchResultsForFilter(q, settings, filter)
  _lastSearchMode = pack.mode
  return pack.items.filter((it) => !it?.entityType || it.entityType === 'track').map((t) => sanitizeTrack(t))
}

function mapSearchFilterToApiType(filter) {
  const f = String(filter || 'all').toLowerCase()
  if (f === 'tracks') return 'track'
  if (f === 'playlists') return 'playlist'
  if (f === 'albums') return 'album'
  if (f === 'artists') return 'artist'
  if (f === 'lyrics') return 'lyrics'
  return 'all'
}

async function fetchSearchResultsForFilter(q, settings = getSettings(), filter = 'all') {
  const src = String(settings?.activeSource || currentSource || 'hybrid').toLowerCase()
  const apiType = mapSearchFilterToApiType(filter)
  const needTyped = apiType !== 'track'

  if (src === 'yandex' || src === 'ya' || src === 'ym') {
    const token = String(settings?.yandexToken || '').trim()
    if (!token) throw new Error('Яндекс: укажи токен Музыки в настройках')
    if (!window.api?.yandexSearch) throw new Error('Яндекс поиск недоступен в этой сборке')
    const ymList = await withTimeout(window.api.yandexSearch(q, token, apiType), 24000, 'yandex search timeout').catch((e) => {
      throw new Error(normalizeInvokeError(e) || 'таймаут поиска')
    })
    if (!Array.isArray(ymList)) throw new Error('Яндекс: некорректный ответ')
    return { mode: 'yandex', items: ymList }
  }

  if (needTyped) {
    const filterLabel = apiType === 'playlist' ? 'плейлисты'
      : apiType === 'album' ? 'альбомы'
      : apiType === 'artist' ? 'артисты'
      : apiType === 'lyrics' ? 'текст песен' : 'этот тип'
    if (src === 'youtube' || src === 'yt') throw new Error(`YouTube: поиск «${filterLabel}» недоступен — только треки`)
    if (src === 'vk') throw new Error(`VK: поиск «${filterLabel}» недоступен — только треки`)
    if (src === 'hybrid') throw new Error(`Classic: поиск «${filterLabel}» недоступен — выбери Яндекс в источнике поиска`)
    throw new Error(`Для этого источника поиск «${filterLabel}» недоступен`)
  }

  if (src === 'youtube' || src === 'yt') {
    if (!window.api?.youtubeSearch) throw new Error('YouTube поиск доступен только в Electron')
    const ytList = await window.api.youtubeSearch(q)
    if (!Array.isArray(ytList)) throw new Error('YouTube: некорректный ответ')
    const items = sanitizeTrackList(ytList.map((t) => ({
      entityType: 'track',
      title: t?.title || 'Без названия',
      artist: t?.artist || 'YouTube',
      ytId: t?.ytId || t?.id || '',
      url: t?.url || null,
      cover: t?.cover || null,
      bg: t?.bg || 'linear-gradient(135deg,#ff0000,#cc0000)',
      source: 'youtube',
      id: String(t?.id || t?.ytId || `${t?.title || ''}:${t?.artist || ''}`)
    }))).filter((t) => t.ytId)
    return { mode: 'youtube', items }
  }

  if (src === 'vk') {
    const token = String(settings?.vkToken || '').trim()
    if (!token) throw new Error('VK: укажи токен в настройках → Источники → ВКонтакте')
    if (!window.api?.vkSearch) throw new Error('VK поиск доступен только в приложении Electron')
    const vkList = await withTimeout(searchVK(q, token), 60000, 'vk search timeout').catch((e) => {
      throw new Error(normalizeInvokeError(e) || 'таймаут поиска')
    })
    if (!Array.isArray(vkList)) throw new Error('VK: некорректный ответ')
    return { mode: 'vk', items: sanitizeTrackList(vkList.map((t) => ({ ...t, entityType: 'track' }))) }
  }

  const hybrid = await searchHybridTracks(q, settings)
  return {
    mode: hybrid.mode || 'hybrid',
    items: sanitizeTrackList((hybrid.tracks || []).map((t) => ({ ...t, entityType: 'track' }))),
  }
}

let _lastSearchResults = []
let _searchFilter = 'all'

function setSearchFilter(filter) {
  _searchFilter = String(filter || 'all').toLowerCase()
  document.querySelectorAll('.nx-search-filter').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-filter') === _searchFilter)
  })
  const q = String(document.getElementById('search-input')?.value || '').trim()
  if (q) searchTracks()
  else if (_lastSearchResults.length) renderResults(_lastSearchResults)
}
window.setSearchFilter = setSearchFilter

function onSearchInput() {
  const input = document.getElementById('search-input')
  const clearBtn = document.getElementById('search-clear-btn')
  const q = String(input?.value || '')
  if (clearBtn) clearBtn.classList.toggle('hidden', !q.trim())
  searchTracks()
}
window.onSearchInput = onSearchInput

function clearSearchInput() {
  const input = document.getElementById('search-input')
  if (input) input.value = ''
  onSearchInput()
  const container = document.getElementById('search-results')
  if (container) container.innerHTML = ''
  _lastSearchResults = []
}
window.clearSearchInput = clearSearchInput

function toggleSearchSourcePopover(ev) {
  try {
    ev?.preventDefault?.()
    ev?.stopPropagation?.()
  } catch (_) {}
  const pop = document.getElementById('search-src-pop')
  const btn = document.getElementById('search-src-btn')
  if (!pop || !btn) return
  const wasHidden = pop.classList.contains('hidden')
  pop.classList.toggle('hidden')
  btn.setAttribute('aria-expanded', wasHidden ? 'true' : 'false')
  if (wasHidden) syncHomeNxSourceLogo()
}
window.toggleSearchSourcePopover = toggleSearchSourcePopover

function pickSearchSource(src) {
  switchSearchSource(src)
  const pop = document.getElementById('search-src-pop')
  const btn = document.getElementById('search-src-btn')
  pop?.classList.add('hidden')
  btn?.setAttribute('aria-expanded', 'false')
  syncHomeNxSourceLogo(true)
}
window.pickSearchSource = pickSearchSource

function searchEntityTypeLabel(type) {
  const t = String(type || 'track').toLowerCase()
  if (t === 'playlist') return 'плейлистов'
  if (t === 'album') return 'альбомов'
  if (t === 'artist') return 'артистов'
  return 'треков'
}

function makeSearchEntityEl(item) {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'search-entity-row'
  const type = String(item?.entityType || 'track').toLowerCase()
  const cover = item?.cover
    ? `background-image:url(${escapeHtml(item.cover)})`
    : `background:${item?.bg || 'linear-gradient(135deg,#7c3aed,#a855f7)'}`
  const badge = typeof flowTrackSourceBadgeHtml === 'function' ? flowTrackSourceBadgeHtml(item) : ''
  const meta =
    type === 'playlist' || type === 'album'
      ? `${item?.trackCount ? `${item.trackCount} треков` : 'Коллекция'}`
      : type === 'artist'
        ? `${item?.trackCount ? `${item.trackCount} треков` : 'Артист'}`
        : ''
  row.innerHTML = `
    <span class="search-entity-cover" style="${cover}"></span>
    <span class="search-entity-meta">
      <strong>${escapeHtml(item?.title || '—')}</strong>
      <span>${escapeHtml(item?.artist || '—')}${meta ? ` · ${escapeHtml(meta)}` : ''}</span>
    </span>
    <span class="search-entity-kind">${escapeHtml(type === 'track' ? 'Трек' : type === 'playlist' ? 'Плейлист' : type === 'album' ? 'Альбом' : 'Артист')}</span>
    ${badge ? `<span class="search-entity-src">${badge}</span>` : ''}
  `
  return row
}

async function openSearchEntity(item) {
  const type = String(item?.entityType || 'track').toLowerCase()
  if (type === 'track' || !type) {
    const track = sanitizeTrack(item)
    queue = [track]
    queueIndex = 0
    queueScope = 'search'
    await playTrackObj(track)
    return
  }
  if (type === 'artist') {
    const q = String(item?.title || item?.artist || '').trim()
    if (!q) return
    _searchFilter = 'tracks'
    document.querySelectorAll('.nx-search-filter').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-filter') === 'tracks')
    })
    const input = document.getElementById('search-input')
    if (input) input.value = q
    return searchTracks()
  }
  const url = String(item?.importUrl || '').trim()
  if (!url || !window.api?.importPlaylistLink) {
    showToast('Для этого результата нет ссылки импорта', true)
    return
  }
  showToast('Импорт коллекции...')
  const imported = await window.api.importPlaylistLink(url, {
    yandex: String(getSettings()?.yandexToken || '').trim(),
    vk: String(getSettings()?.vkToken || '').trim(),
    spotify: String(getSettings()?.spotifyToken || '').trim(),
  }).catch((e) => ({ ok: false, error: normalizeInvokeError(e) }))
  if (!imported?.ok || !imported?.tracks?.length) {
    showToast(imported?.error || 'Не удалось загрузить коллекцию', true)
    return
  }
  const tracks = sanitizeTrackList(imported.tracks)
  queue = tracks
  queueIndex = 0
  queueScope = 'search'
  showToast(`${imported.name || 'Коллекция'}: ${tracks.length} треков`)
  await playTrackObj(tracks[0])
}
window.openSearchEntity = openSearchEntity

function renderResults(results) {
  _lastSearchResults = Array.isArray(results) ? results.slice() : []
  const container = document.getElementById('search-results')
  const meta = document.getElementById('search-results-meta')
  const countEl = document.getElementById('results-count')
  const srcEl = document.getElementById('results-source-label')
  if (!container) return
  if (!_lastSearchResults.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg class="ui-icon lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg></div><p>Ничего не найдено</p><small>Попробуй другой запрос или источник</small></div>`
    if (meta) meta.style.display = 'none'
    return
  }
  const tracksOnly = _lastSearchResults.filter((it) => !it?.entityType || it.entityType === 'track')
  if (tracksOnly.length === _lastSearchResults.length) {
    queue = sanitizeTrackList(tracksOnly)
    queueIndex = 0
    queueScope = 'search'
  }
  if (meta) meta.style.display = 'flex'
  const kind = _lastSearchResults[0]?.entityType || 'track'
  if (countEl) countEl.textContent = `${_lastSearchResults.length} ${searchEntityTypeLabel(kind)}`
  if (srcEl) srcEl.textContent = getSourceLabel()
  container.innerHTML = ''
  let trackQueueIdx = 0
  _lastSearchResults.forEach((item, i) => {
    const type = String(item?.entityType || 'track').toLowerCase()
    if (type === 'track') {
      const track = sanitizeTrack(item)
      const el = makeTrackEl(track, true, false)
      const qi = trackQueueIdx
      trackQueueIdx += 1
      el.addEventListener('click', () => {
        queueIndex = qi
        playTrackObj(track)
      })
      container.appendChild(el)
      return
    }
    const el = makeSearchEntityEl(item)
    el.addEventListener('click', () => openSearchEntity(item))
    container.appendChild(el)
  })
  try {
    refreshNowPlayingTrackHighlight()
  } catch (_) {}
}

function getSourceLabel() {
  if (_lastSearchMode === 'spotify') return 'Spotify'
  if (_lastSearchMode === 'soundcloud') return 'SoundCloud'
  if (_lastSearchMode === 'audius') return 'Audius'
  if (_lastSearchMode === 'youtube') return 'YouTube'
  if (_lastSearchMode === 'yandex') return 'Яндекс Музыка'
  if (_lastSearchMode === 'vk') return 'ВКонтакте'
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
      result = await window.api.vkSearch(q, token, Boolean(getSettings().vkSeleniumBridge))
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
  if (!track) return
  const wasLiked = isLiked(track)
  let liked = getLiked()
  if (wasLiked) {
    liked = liked.filter((t) => !(t.id === track.id && t.source === track.source))
    showToast('РЈР±СЂР°РЅРѕ РёР· Р»СЋР±РёРјС‹С…')
    try {
      const tok = String(getSettings()?.yandexToken || '').trim()
      if (String(track.source || '').toLowerCase() === 'yandex' && tok && window.api?.yandexTrackUnlike) {
        void window.api.yandexTrackUnlike({ token: tok, trackId: String(track.id || '').trim() }).then((r) => {
          if (!r?.ok) showToast('Яндекс: не удалось снять лайк', true)
        })
      }
    } catch (_) {}
  } else {
    liked.push(track)
    showToast('Р”РѕР±Р°РІР»РµРЅРѕ РІ Р»СЋР±РёРјС‹Рµ в™Ґ')
    try {
      const tok = String(getSettings()?.yandexToken || '').trim()
      if (String(track.source || '').toLowerCase() === 'yandex' && tok && window.api?.yandexTrackLike) {
        void window.api.yandexTrackLike({ token: tok, trackId: String(track.id || '').trim() }).then((r) => {
          if (!r?.ok) showToast('Яндекс: не удалось отправить лайк', true)
        })
      }
      if (
        queueScope === 'myWave' &&
        getMyWaveSource() === 'yandex' &&
        String(track.source || '').toLowerCase() === 'yandex' &&
        track?.yandexRotor?.batchId &&
        tok &&
        window.api?.yandexRotorFeedback
      ) {
        void window.api.yandexRotorFeedback({
          token: tok,
          station: track.yandexRotor.station || 'user:onyourwave',
          type: 'like',
          trackId: String(track.id || '').trim(),
          batchId: track.yandexRotor.batchId,
        })
      }
    } catch (_) {}
  }
  localStorage.setItem('flow_liked', JSON.stringify(liked))
  syncLikeButtonsInVisibleLists()
  updatePlayerLikeBtn()
  requestAnimationFrame(() => {
    renderLiked()
  })
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
  if (!currentTrack) return
  const liked = isLiked(currentTrack)
  const btn = document.getElementById('player-like-btn')
  if (btn) {
    btn.innerHTML = liked ? HEART_FILLED : HEART_OUTLINE
    btn.classList.toggle('liked', liked)
  }
  const pmCoverBtn = document.getElementById('pm-cover-like-btn')
  const homeNxBtn = document.getElementById('home-nx-like-btn')
  if (pmCoverBtn) { pmCoverBtn.innerHTML = liked ? HEART_FILLED : HEART_OUTLINE; pmCoverBtn.classList.toggle('liked', liked) }
  if (homeNxBtn) { homeNxBtn.innerHTML = liked ? HEART_FILLED : HEART_OUTLINE; homeNxBtn.classList.toggle('liked', liked) }
}

/** Склонение для «N трек/трека/треков» (рус.). */
function ruTrackWordAfterCurrent(n) {
  const a = Math.abs(Math.floor(Number(n) || 0)) % 100
  const b = a % 10
  if (a > 10 && a < 20) return 'треков'
  if (b === 1) return 'трек'
  if (b >= 2 && b <= 4) return 'трека'
  return 'треков'
}

function renderQueue() {
  const listEl = document.getElementById('home-up-next-list')
  if (!listEl) return
  if (typeof isMediaQueueEnabled === 'function' && !isMediaQueueEnabled()) return

  try {
  const qlen = Array.isArray(queue) ? queue.length : 0
  const after = Math.max(0, qlen - (Number(queueIndex) + 1))
  const nextTracks = Array.isArray(queue) ? queue.slice(queueIndex + 1, queueIndex + 6) : []
  const emptyListHtml = '<div class="empty-state compact"><p>Запусти трек, и тут появятся следующие позиции очереди</p></div>'

  if (!qlen) {
    listEl.innerHTML = emptyListHtml
    return
  }

  if (after === 0) {
    listEl.innerHTML =
      '<div class="empty-state compact"><p>Дальше в очереди ничего нет — добавь треки или выбери другой плейлист</p></div>'
    return
  }

  listEl.innerHTML = ''
  const frag = document.createDocumentFragment()
  nextTracks.forEach((track, pos) => {
    const t = sanitizeTrack(track)
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'home-up-next-item'
    const cover = getListCoverUrl(t)
    const fallbackBg = t.bg || 'linear-gradient(135deg,#7c3aed,#a855f7)'
    const coverStyle = cover
      ? `background-image:url('${escapeHtml(cover)}');background-color:#0e0e14;`
      : `background:${fallbackBg};`
    row.innerHTML = `
      <span class="home-up-next-order">${queueIndex + pos + 2}</span>
      <span class="home-up-next-cover" style="${coverStyle}"></span>
      <span class="home-up-next-meta-wrap">
        <strong>${escapeHtml(sanitizeDisplayText(t.title || 'Без названия'))}</strong>
        <span>${escapeHtml(sanitizeDisplayText(t.artist || '—'))}</span>
      </span>
      <span class="home-up-next-src">›</span>
    `
    row.addEventListener('click', () => {
      const idx = queueIndex + pos + 1
      const nextTrack = queue[idx]
      if (!nextTrack) return
      queueIndex = idx
      playTrackObj(nextTrack).catch(() => {})
    })
    frag.appendChild(row)
  })
  listEl.appendChild(frag)
  } finally {
    try {
      if (typeof _playerModeActive !== 'undefined' && _playerModeActive && typeof syncPmQueuePreviews === 'function') {
        syncPmQueuePreviews()
      }
    } catch (_) {}
  }
}

function bindHorizontalStripDrag(el) {
  if (!el || el.dataset.hDragReady === '1') return
  el.dataset.hDragReady = '1'
  let drag = null
  const onMove = (ev) => {
    if (!drag) return
    const dx = ev.clientX - drag.x
    if (!drag.moved && Math.abs(dx) > 4) drag.moved = true
    if (!drag.moved) return
    ev.preventDefault()
    el.scrollLeft = drag.left - dx
  }
  const onUp = () => {
    if (!drag) return
    if (drag.moved) el.dataset.hDragSuppressClickUntil = String(Date.now() + 220)
    drag = null
    el.classList.remove('is-dragging')
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }
  el.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return
    drag = { x: ev.clientX, left: el.scrollLeft, moved: false }
    el.classList.add('is-dragging')
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  })
  el.addEventListener(
    'click',
    (ev) => {
      const until = Number(el.dataset.hDragSuppressClickUntil || 0)
      if (until && Date.now() < until) {
        ev.preventDefault()
        ev.stopPropagation()
      }
    },
    true,
  )
}

function renderMainHub() {
  renderMyWave()
  renderMainQuickPlaylists()
  renderMainQuickLiked()
  bindHorizontalStripDrag(document.getElementById('main-quick-playlists'))
  bindHorizontalStripDrag(document.getElementById('main-quick-liked'))
}

function renderMainQuickPlaylists() {
  const root = document.getElementById('main-quick-playlists')
  if (!root) return
  const playlists = getPlaylists().map(normalizePlaylist)
  if (!playlists.length) {
    root.innerHTML = '<div class="empty-state compact"><p>Добавь несколько плейлистов для быстрого доступа</p></div>'
    return
  }
  root.innerHTML = ''
  const frag = document.createDocumentFragment()
  playlists.forEach((pl, idx) => {
    const card = document.createElement('button')
    card.type = 'button'
    card.className = 'main-quick-playlist'
    const cover = sanitizeMediaByGifMode(pl.coverData || '', 'playlist')
    card.innerHTML = `
      <span class="main-quick-playlist-cover"${cover ? ` style="background-image:url('${escapeHtml(cover)}')"` : ''}>
        ${cover ? '' : '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'}
      </span>
      <span class="main-quick-playlist-meta">
        <strong>${escapeHtml(sanitizeDisplayText(pl.name || 'Плейлист'))}</strong>
        <span>${pl.tracks.length} треков</span>
      </span>
    `
    card.addEventListener('click', () => {
      openPage('library')
      openPlaylist(idx)
    })
    frag.appendChild(card)
  })
  root.appendChild(frag)
}

function renderMainQuickLiked() {
  const root = document.getElementById('main-quick-liked')
  if (!root) return
  const liked = getLiked()
  if (!liked.length) {
    root.innerHTML = '<div class="empty-state compact"><p>Лайкни треки, чтобы они появились здесь</p></div>'
    return
  }
  root.innerHTML = ''
  liked.forEach((track, idx) => {
    const row = makeTrackEl(track, false, false)
    row.classList.add('main-quick-liked-item')
    row.querySelectorAll('.track-like, .track-play').forEach((btn) => btn.remove())
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('button')) return
      queue = getLiked().slice()
      queueIndex = idx
      queueScope = 'liked'
      playTrackObj(track).catch(() => {})
    })
    root.appendChild(row)
  })
}

let _likedRenderToken = 0
function renderLiked() {
  const token = ++_likedRenderToken
  const liked = getLiked()
  renderMainQuickLiked()
  document.body.classList.toggle('flow-heavy-liked', liked.length >= 220)
  const container = document.getElementById('liked-list'); if (!container) return
  if (!liked.length) { container.innerHTML=`<div class="empty-state"><div class="empty-icon"><svg class="ui-icon lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-4.35-9.5-8A5.5 5.5 0 0 1 12 5.1 5.5 5.5 0 0 1 21.5 13c-2.5 3.65-9.5 8-9.5 8Z"/></svg></div><p>Ты еще не лайкнул ни одного трека</p></div>`; return }
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
    try {
      refreshNowPlayingTrackHighlight()
    } catch (_) {}
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

function getTrackDedupeKey(track = {}) {
  const source = String(track.source || '').trim().toLowerCase()
  const id = String(track.id || track.ytId || track.url || '').trim().toLowerCase()
  if (source && id) return `${source}:${id}`
  const artist = String(track.artist || '').trim().toLowerCase()
  const title = String(track.title || '').trim().toLowerCase()
  return `${artist}:${title}`.replace(/\s+/g, ' ')
}

function removeOpenPlaylistDuplicates() {
  const idx = Number(openPlaylistIndex)
  const pls = getPlaylists().map(normalizePlaylist)
  const pl = pls[idx]
  if (!pl) return
  const seen = new Set()
  const nextTracks = []
  let removed = 0
  ;(pl.tracks || []).forEach((track) => {
    const key = getTrackDedupeKey(track)
    if (key && seen.has(key)) {
      removed++
      return
    }
    if (key) seen.add(key)
    nextTracks.push(track)
  })
  if (!removed) return showToast('Дублей в плейлисте нет')
  pls[idx].tracks = nextTracks
  savePlaylists(pls)
  openPlaylist(idx)
  renderPlaylists()
  showToast(`Удалено дублей: ${removed}`)
}

function openPlaylist(idx) {
  openPlaylistIndex = idx
  const pl = normalizePlaylist(getPlaylists()[idx])
  if (!pl) return
  document.body.classList.toggle('flow-heavy-playlist', (pl.tracks || []).length >= 180)
  const playlistCover = sanitizeMediaByGifMode(pl.coverData || '', 'playlist')
  document.getElementById('playlist-view-name').textContent = pl.name
  const metaEl = document.getElementById('playlist-view-meta')
  if (metaEl) metaEl.textContent = pl.description || `${pl.tracks.length} треков`
  const coverEl = document.getElementById('playlist-view-cover')
  if (coverEl) {
    coverEl.style.backgroundImage = playlistCover ? `url(${playlistCover})` : ''
    coverEl.innerHTML = playlistCover ? '' : '<svg class="ui-icon lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'
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
  if (!pl.tracks.length) { container.innerHTML=`<div class="empty-state"><div class="empty-icon"><svg class="ui-icon lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div><p>Плейлист пуст</p></div>`; return }
  container.innerHTML=''
  const token = ++_openPlaylistTrackRenderToken
  let cursor = 0
  const chunkSize = pl.tracks.length > 250 ? 28 : 18
  const renderChunk = () => {
    if (token !== _openPlaylistTrackRenderToken) return
    const fragment = document.createDocumentFragment()
    for (let n = 0; n < chunkSize && cursor < pl.tracks.length; n++, cursor++) {
      const trackIndex = cursor
      const track = pl.tracks[trackIndex]
      const row = document.createElement('div')
      row.className = 'playlist-track-row'
      row.dataset.idx = String(trackIndex)
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
        _playlistDragIndex = trackIndex
        row.classList.add('dragging')
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
      })
      const el = makeTrackEl(track, false, false)
      el.classList.add('playlist-track-card')
      el.addEventListener('click', () => {
        queue = pl.tracks.slice()
        queueIndex = trackIndex
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
        editPlaylistTrack(openPlaylistIndex, trackIndex)
      })
      actions.children[1].addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        removeTrackFromPlaylist(openPlaylistIndex, trackIndex)
      })
      row.appendChild(handle)
      row.appendChild(el)
      row.appendChild(actions)
      fragment.appendChild(row)
    }
    container.appendChild(fragment)
    try {
      refreshNowPlayingTrackHighlight()
    } catch (_) {}
    if (cursor < pl.tracks.length) setTimeout(renderChunk, 0)
  }
  requestAnimationFrame(renderChunk)
}

function closePlaylist() {
  openPlaylistIndex=null
  document.body.classList.remove('flow-heavy-playlist')
  _openPlaylistTrackRenderToken++
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

function cleanImportText(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
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

function getImportPreferredSource(imported = {}) {
  const service = String(imported?.service || '').trim().toLowerCase()
  if (service === 'yandex') return 'yandex'
  if (service === 'vk') return 'vk'
  return ''
}

function isTrackPlayableCandidate(track = {}) {
  const src = String(track?.source || '').trim().toLowerCase()
  const url = String(track?.url || '').trim()
  if (src === 'youtube') return Boolean(track?.ytId || /youtube\.com|youtu\.be/i.test(url))
  if (src === 'yandex') return Boolean(track?.id || url)
  if (src === 'soundcloud') return Boolean(url || track?.scTranscoding)
  if (src === 'vk' || src === 'audius') return Boolean(url)
  if (src === 'spotify') return Boolean(url)
  if (src === 'local') return Boolean(track?.filePath || url)
  return Boolean(url || track?.id || track?.ytId)
}

async function searchImportTrackWithSource(q, settings, preferredSource = '') {
  const src = String(preferredSource || '').trim().toLowerCase()
  if (src === 'yandex') {
    const token = String(settings?.yandexToken || '').trim()
    if (!token || !window.api?.yandexSearch) return []
    const ymList = await withTimeout(window.api.yandexSearch(q, token), 22000, 'yandex search timeout').catch(() => [])
    return sanitizeTrackList(Array.isArray(ymList) ? ymList : [])
  }
  if (src === 'vk') {
    const token = String(settings?.vkToken || '').trim()
    if (!token || !window.api?.vkSearch) return []
    const vkList = await withTimeout(searchVK(q, token), 60000, 'vk search timeout').catch(() => [])
    return sanitizeTrackList(Array.isArray(vkList) ? vkList : [])
  }
  const hybrid = await searchHybridTracks(q, settings).catch(() => ({ tracks: [] }))
  return sanitizeTrackList(hybrid?.tracks || [])
}

async function processPlaylistImport(trackList, imported = {}) {
  const srcTracks = Array.isArray(trackList) ? trackList : []
  const maxTracks = Math.min(srcTracks.length, 120)
  const collected = []
  const notFound = []
  const skippedUnplayable = []
  const preferredSource = getImportPreferredSource(imported)
  openImportProgress(maxTracks)
  try {
    for (let i = 0; i < maxTracks; i++) {
      const it = srcTracks[i] || {}
      const directOriginalId = String(it?.original_id || it?.originalId || '').trim()
      const queries = buildImportQueries(it.title, it.artist)
      const query = queries[0] || ''
      updateImportProgress(i, maxTracks, `Ищу: ${it.artist || '—'} - ${it.title || '—'}${notFound.length ? ` | не найдено: ${notFound.slice(-3).join('; ')}` : ''}`)
      if (preferredSource === 'yandex' && directOriginalId) {
        const directYandex = {
          title: it.title || 'Без названия',
          artist: it.artist || '—',
          duration: Number(it?.duration || 0) || null,
          cover: it?.cover || null,
          source: 'yandex',
          id: directOriginalId,
        }
        if (isTrackPlayableCandidate(directYandex)) {
          collected.push(directYandex)
          updateImportProgress(i + 1, maxTracks, `Импорт: ${i + 1} из ${maxTracks}${notFound.length ? ` | не найдено: ${notFound.slice(-3).join('; ')}` : ''}`)
          await importDelay(180)
          continue
        }
      }
      if (!query) {
        notFound.push(`Track ${i + 1}`)
        continue
      }
      try {
        let first = null
        const settings = getSettings()
        for (const q of queries) {
          // 1) Prefer source-specific import search (e.g. Yandex -> Yandex).
          const found = await searchImportTrackWithSource(q, settings, preferredSource)
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
          const picked = Object.assign({}, first, {
            title: it.title || first.title,
            artist: it.artist || first.artist
          })
          if (preferredSource === 'yandex' && directOriginalId && String(picked.source || '').toLowerCase() === 'yandex') {
            picked.id = directOriginalId
            if (!picked.duration && it?.duration) picked.duration = Number(it.duration) || null
            if (!picked.cover && it?.cover) picked.cover = it.cover
          }
          if (!isTrackPlayableCandidate(picked)) {
            skippedUnplayable.push(`${picked.artist || '—'} - ${picked.title || '—'}`)
            continue
          }
          collected.push(picked)
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
      updateImportProgress(i + 1, maxTracks, `Импорт: ${i + 1} из ${maxTracks}${notFound.length ? ` | не найдено: ${notFound.slice(-3).join('; ')}` : ''}`)
      await importDelay(300 + Math.floor(Math.random() * 201))
    }
    const pls = getPlaylists()
    const name = `${imported.name || 'Imported Playlist'} [${imported.service || 'import'}]`
    const normalizedName = String(name).trim().toLowerCase()
    const existingIdx = pls.findIndex((p) => String(p?.name || '').trim().toLowerCase() === normalizedName)
    const importedCover = String(imported?.cover || '').trim()
    const fallbackCover = String(collected.find((t) => t?.cover)?.cover || '').trim()
    const nextPlaylist = normalizePlaylist({
      name,
      coverData: importedCover || fallbackCover || null,
      tracks: collected,
    })
    if (existingIdx >= 0) pls[existingIdx] = nextPlaylist
    else pls.push(nextPlaylist)
    savePlaylists(pls)
    renderPlaylists()
    openPage('library')
    if (notFound.length || skippedUnplayable.length) {
      const reportRows = [...notFound.slice(0, 8), ...skippedUnplayable.slice(0, 4)]
      const report = reportRows.join('; ')
      updateImportProgress(
        maxTracks,
        maxTracks,
        `Готово. Не найдено ${notFound.length}, отброшено неиграбельных ${skippedUnplayable.length}: ${report}${(notFound.length + skippedUnplayable.length) > 12 ? '...' : ''}`
      )
      await importDelay(1600)
    }
  } finally {
    closeImportProgress()
  }
  return { added: collected.length, missed: notFound.length, skipped: skippedUnplayable.length, total: maxTracks }
}

function collectImportTracksDeep(value, out = [], limit = 500) {
  if (out.length >= limit || value == null) return out
  if (Array.isArray(value)) {
    if (
      value.length >= 5
      && Number.isFinite(Number(value[0]))
      && Number.isFinite(Number(value[1]))
      && typeof value[3] === 'string'
      && typeof value[4] === 'string'
    ) {
      out.push({
        title: cleanImportText(value[3]),
        artist: cleanImportText(value[4]),
        duration: Number(value[5] || 0) || null,
        original_id: `${value[1]}_${value[0]}`,
      })
    }
    for (const item of value) {
      if (out.length >= limit) break
      collectImportTracksDeep(item, out, limit)
    }
    return out
  }
  if (typeof value === 'object') {
    const title = value.title || value.name
    const artist = value.artist || value.performer || value.author || value.subtitle
    if (title && artist) {
      out.push({
        title: cleanImportText(title),
        artist: cleanImportText(artist),
        duration: Number(value.duration || value.durationSec || 0) || null,
        original_id: value.original_id || value.originalId || value.id || '',
      })
    }
    for (const item of Object.values(value)) {
      if (out.length >= limit) break
      collectImportTracksDeep(item, out, limit)
    }
  }
  return out
}

function parseTrackRowsFromText(text) {
  const raw = String(text || '').trim()
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw.replace(/^<!--/, '').trim())
    const jsonTracks = collectImportTracksDeep(parsed)
    if (jsonTracks.length) return jsonTracks
  } catch {}

  const rows = []
  const lines = raw.split(/\r?\n/)
  for (const line of lines) {
    let value = line
      .replace(/^\s*\d+[\).:-]\s*/, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!value) continue
    value = value.replace(/^["'`]+|["'`]+$/g, '').trim()
    const parts = value.split(/\s+(?:-|–|—|\||•)\s+/)
    let artist = ''
    let title = ''
    if (parts.length >= 2) {
      artist = parts.shift().trim()
      title = parts.join(' - ').trim()
    } else {
      const comma = value.split(/\s*,\s*/)
      if (comma.length >= 2 && comma[0].length <= 80) {
        artist = comma.shift().trim()
        title = comma.join(', ').trim()
      } else {
        title = value
      }
    }
    if (!title) continue
    rows.push({ artist: artist || '', title })
  }
  const seen = new Set()
  return rows.filter((item) => {
    const key = `${String(item.artist || '').toLowerCase()}::${String(item.title || '').toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function openTextPlaylistImportModal() {
  const modal = document.getElementById('text-import-modal')
  const input = document.getElementById('text-import-input')
  const name = document.getElementById('text-import-name')
  if (!modal || !input) return showToast('Окно импорта текстом не найдено', true)
  input.value = ''
  if (name) name.value = ''
  modal.classList.remove('hidden')
  requestAnimationFrame(() => input.focus())
}
window.openTextPlaylistImportModal = openTextPlaylistImportModal

function closeTextPlaylistImportModal() {
  document.getElementById('text-import-modal')?.classList.add('hidden')
}
window.closeTextPlaylistImportModal = closeTextPlaylistImportModal

async function importPlaylistFromText(text, name = '') {
  const tracks = parseTrackRowsFromText(text)
  if (!tracks.length) {
    showToast('Не нашёл строк с artist/title', true)
    return
  }
  showToast(`Нашёл строк: ${tracks.length}. Запускаю поиск Nexory...`)
  const stats = await processPlaylistImport(tracks, {
    name: name || 'VK Artist Title',
    service: 'text',
  })
  showToast(`Импорт текстом завершен. Добавлено ${stats.added}, не найдено ${stats.missed}`)
}
window.importPlaylistFromText = importPlaylistFromText

async function submitTextPlaylistImportModal() {
  const input = document.getElementById('text-import-input')
  const name = document.getElementById('text-import-name')
  const text = String(input?.value || '').trim()
  if (!text) return showToast('Вставь список треков', true)
  closeTextPlaylistImportModal()
  await importPlaylistFromText(text, String(name?.value || '').trim()).catch((err) => {
    showToast(`Импорт текстом: ${sanitizeDisplayText(err?.message || String(err))}`, true)
  })
}
window.submitTextPlaylistImportModal = submitTextPlaylistImportModal

async function importPlaylistFromLink(urlFromUi = '') {
  showToast('Открываю импорт плейлиста...')
  const url = String(urlFromUi || '').trim()
  if (!url) return openLibraryActionModal('import')
  if (!window.api?.importPlaylistLink) {
    showToast('Импорт доступен только в Electron', true)
    return
  }
  const settings = getSettings()
  const isYandexLink = /(^|\/\/)(music\.)?yandex\.[^/]+\/users\/[^/]+\/playlists\/[^/?#]+/i.test(url)
  if (isYandexLink && !settings.yandexToken) {
    showToast('Для импорта Яндекс Музыки нужен активный OAuth token', true)
    openPage('settings')
    switchSettingsTab('sources')
    setTimeout(() => document.getElementById('ym-token-val')?.focus(), 120)
    return
  }
  showToast('Импортирую плейлист...')
  openImportProgress(0)
  _importProgressOpenedAt = Date.now()
  setImportProgressIndeterminate(true)
  const isVkLink = /(^|\/\/)(m\.)?vk\.com\//i.test(url)
  updateImportProgress(0, 0, isVkLink ? 'Отправляю VK плейлист на РФ сервер и получаю список треков...' : (isYandexLink ? 'Читаю плейлист Яндекс Музыки по OAuth token...' : 'Разбираю ссылку и получаю список треков...'))
  const imported = await window.api.importPlaylistLink(url.trim(), {
    spotify: settings.spotifyToken || '',
    yandex: settings.yandexToken || '',
    vk: isVkLink ? getCurrentVkTokenForImport() : (settings.vkToken || ''),
    serverBaseUrl: settings.proxyBaseUrl || '',
    allowVkSeleniumBridge: Boolean(settings.vkSeleniumBridge),
  }).catch((e) => ({ ok: false, error: e?.message || String(e) }))
  setImportProgressIndeterminate(false)

  if (!imported?.ok) {
    const errorText = sanitizeDisplayText(imported?.error || 'ошибка')
    const needsVkAuth = isVkLink && /auth_required|access_token|user authorization|authorization/i.test(errorText)
    if (needsVkAuth) {
      updateImportProgress(0, 0, 'VK не отдал плейлист без авторизации. Открой Настройки -> Источники -> VK и войди в VK для импорта.')
      await closeImportProgressSafe(1800)
      showToast('Для этого VK плейлиста нужен вход в VK / токен', true)
      openPage('settings')
      switchSettingsTab('sources')
      setTimeout(() => {
        switchSrcTab('vk')
        document.getElementById('vk-token-val')?.focus()
      }, 120)
      return
    }
    if (isYandexLink && /yandex token required|oauth|token/i.test(errorText)) {
      updateImportProgress(0, 0, 'Яндекс Музыка требует активный OAuth token. Открой Источники и сохрани токен.')
      await closeImportProgressSafe(1800)
      showToast('Для Яндекс Музыки нужен OAuth token', true)
      openPage('settings')
      switchSettingsTab('sources')
      setTimeout(() => document.getElementById('ym-token-val')?.focus(), 120)
      return
    }
    updateImportProgress(0, 0, `Ошибка: ${errorText}`)
    await closeImportProgressSafe(1200)
    showToast('Импорт: ' + errorText, true)
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
    if (imported?.via === 'flow-vk-server') showToast(`VK сервер вернул треков: ${srcTracks.length}`)
    const stats = await processPlaylistImport(srcTracks, imported)
    showToast(`Импорт завершен. Добавлено ${stats.added} треков, ${stats.missed} не найдено, ${stats.skipped || 0} отброшено`)
  } catch (err) {
    updateImportProgress(0, 0, `Ошибка: ${sanitizeDisplayText(err?.message || String(err))}`)
    await closeImportProgressSafe(1200)
    showToast(`Импорт сорвался: ${sanitizeDisplayText(err?.message || String(err))}`, true)
  }
}
window.importPlaylistFromLink = importPlaylistFromLink

async function importPlaylistLinkFromBar() {
  const input = document.getElementById('playlist-link-import-input')
  if (!input) return showToast('Поле ссылки не найдено', true)
  const url = String(input?.value || '').trim()
  if (!url) return showToast('Вставь ссылку на плейлист VK или Яндекс Музыки', true)
  try {
    await importPlaylistFromLink(url)
  } catch (err) {
    showToast(`Импорт: ${sanitizeDisplayText(err?.message || String(err))}`, true)
  }
}
window.importPlaylistLinkFromBar = importPlaylistLinkFromBar
window.importVkPlaylistToFlow = importPlaylistLinkFromBar

function addToPlaylist(track) {
  const pls = getPlaylists().map(normalizePlaylist)
  openPlaylistPickerModal({
    mode: 'add-track-playlist',
    title: 'Добавить трек в плейлист',
    items: pls.map((p, idx) => ({ id: String(idx), label: `${p.name} (${p.tracks.length})` })),
    payload: { track }
  })
}

function addCurrentTrackToPlaylist() {
  if (!currentTrack) return showToast('Сначала включи трек', true)
  addToPlaylist(currentTrack)
}
window.addCurrentTrackToPlaylist = addCurrentTrackToPlaylist

let _playlistRenderToken = 0
let _openPlaylistTrackRenderToken = 0
function renderPlaylists() {
  const token = ++_playlistRenderToken
  const pls = getPlaylists().map(normalizePlaylist)
  renderMainQuickPlaylists()
  const container = document.getElementById('playlists-list'); if (!container) return
  if (!pls.length) { container.innerHTML=`<div class="empty-state"><div class="empty-icon"><svg class="ui-icon lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg></div><p>Нет плейлистов — создай первый!</p></div>`; return }
  container.innerHTML=''
  let idx = 0
  const chunkSize = 12
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
        <div class="playlist-icon" style="${coverStyle}" title="Плейлист">${playlistCover ? '' : '<svg class="ui-icon lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'}</div>
        <div class="playlist-info" style="cursor:pointer">
          <span class="playlist-name">${pl.name}</span>
          <span class="playlist-count">${pl.tracks.length} треков${pl.description ? ` • ${pl.description}` : ''}</span>
        </div>`
      if (playlistCover) {
        const icon = el.querySelector('.playlist-icon')
        observeLazyCoverBackground(icon, playlistCover, '', `playlist:${currentIdx}`)
      }
      el.addEventListener('click', () => openPlaylist(currentIdx))
      el.addEventListener('contextmenu', (ev) => openPlaylistCardContextMenu(ev, currentIdx))
      fragment.appendChild(el)
    }
    container.appendChild(fragment)
    if (idx < pls.length) setTimeout(renderChunk, 0)
  }
  requestAnimationFrame(renderChunk)
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
const SRC_LABELS = { soundcloud: 'SC', vk: 'VK', youtube: 'YT', spotify: 'SP', yandex: 'Ян' }

function makeTrackEl(track, showPlaylist=false, bindDefaultPlay=true) {
  track = sanitizeTrack(track)
  const el = document.createElement('div'); el.className='track-card'
  try {
    el.setAttribute('data-flow-track-key', getTrackKey(track))
    el.setAttribute('data-flow-track-json', encodeURIComponent(JSON.stringify(track)))
  } catch (_) {}
  const liked = isLiked(track)
  const trackJson = JSON.stringify(track).replace(/"/g,'&quot;')
  const trackCover = getListCoverUrl(track)
  const fallbackBg = track.bg||'linear-gradient(135deg,#7c3aed,#a855f7)'
  const coverStyle = `background:${fallbackBg};`
  const badgeKey = trackSourceBadgeKey(track.source)
  const srcLbl = SRC_LABELS[badgeKey] || ''
  const badge = srcLbl ? `<span class="track-source track-source-${badgeKey}">${srcLbl}</span>` : ''
  el.innerHTML=`
    <div class="track-cover" style="${coverStyle}">${trackCover?'':'<svg class="ui-icon lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'}
      <div class="cover-overlay"><div class="cover-play-icon"><svg class="ctrl-play-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M9 8 L17 12 L9 16 Z"/></svg></div></div>
    </div>
    <div class="track-info">
      <span class="track-name">${track.title}</span>
      <span class="track-artist">${track.artist||'вЂ”'} ${badge}</span>
    </div>
    <button class="track-like ${liked?'liked':''}" data-track-json="${trackJson}" onclick="event.stopPropagation();likeTrack(${trackJson})">${liked ? HEART_FILLED : HEART_OUTLINE}</button>
    <button class="track-like" onclick="event.stopPropagation();findSimilarTracks(${trackJson})" title="Найти похожие">${ICON_SIMILAR}</button>
    ${showPlaylist?`<button class="track-like" onclick="event.stopPropagation();addToPlaylist(${trackJson})" title="Р’ РїР»РµР№Р»РёСЃС‚">${ICONS.plus}</button>`:''}
    <button class="track-play"><svg class="ctrl-play-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M9 8 L17 12 L9 16 Z"/></svg></button>`
  if (trackCover) {
    const coverEl = el.querySelector('.track-cover')
    observeLazyCoverBackground(coverEl, trackCover, fallbackBg, getTrackKey(track))
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

function findSimilarTracks(track = null) {
  const t = sanitizeTrack(track || currentTrack || {})
  const query = [t.artist, t.title].filter(Boolean).join(' ').trim()
  if (!query) return showToast('Сначала выбери трек', true)
  openPage('search')
  const input = document.getElementById('search-input')
  if (input) input.value = query
  showToast('Ищу похожие треки')
  searchTracks()
}

// в”Ђв”Ђв”Ђ LYRICS в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
let _lyricsData = []       // [{time, text}] РґР»СЏ synced
let _lyricsActiveIdx = -1
let _lyricsOpen = false
let _lyricsSettingsOpen = false
let _lyricsObserver = null
let _lyricsLastPaintAt = 0

/** Интервал согласования с частотой кадров (~60–165 Гц); караоке идёт на каждый RAF. */
let _lyricsFrameBudgetCachedMs = null
function refreshLyricsFrameBudgetCache() {
  _lyricsFrameBudgetCachedMs = null
}
function getLyricsFrameBudgetMs() {
  if (_lyricsFrameBudgetCachedMs != null) return _lyricsFrameBudgetCachedMs
  try {
    const rr = Number(typeof window !== 'undefined' && window.screen?.refreshRate)
    if (Number.isFinite(rr) && rr >= 30 && rr <= 360) {
      _lyricsFrameBudgetCachedMs = Math.max(4, Math.floor(1000 / rr))
      return _lyricsFrameBudgetCachedMs
    }
  } catch (_) {}
  _lyricsFrameBudgetCachedMs = 1000 / 60
  return _lyricsFrameBudgetCachedMs
}
if (typeof window !== 'undefined') {
  window.addEventListener('resize', refreshLyricsFrameBudgetCache, { passive: true })
}
let _lyricsRafId = 0
/** Сглаживание времени между «ступеньками» currentTime для караоке (lerp по performance.now). */
const LYRICS_TIME_DRIFT_RESYNC_SEC = 0.1
let _lyricsSmoothedTimeAnchor = { audio: 0, perfMs: 0 }

function getLyricsSmoothedTime() {
  try {
    if (!audio || audio.paused || audio.ended) {
      const t = Number(audio?.currentTime || 0)
      _lyricsSmoothedTimeAnchor = { audio: t, perfMs: performance.now() }
      return t
    }
    const now = performance.now()
    const actual = Number(audio.currentTime || 0)
    if (!_lyricsSmoothedTimeAnchor.perfMs) {
      _lyricsSmoothedTimeAnchor = { audio: actual, perfMs: now }
      return actual
    }
    const predicted = _lyricsSmoothedTimeAnchor.audio + (now - _lyricsSmoothedTimeAnchor.perfMs) / 1000
    if (Math.abs(actual - predicted) > LYRICS_TIME_DRIFT_RESYNC_SEC) {
      _lyricsSmoothedTimeAnchor = { audio: actual, perfMs: now }
      return actual
    }
    return predicted
  } catch {
    return Number(audio?.currentTime || 0)
  }
}

function stopLyricsSyncLoop() {
  if (_lyricsRafId) cancelAnimationFrame(_lyricsRafId)
  _lyricsRafId = 0
}

function startLyricsSyncLoop() {
  if (_lyricsRafId) return
  const tick = () => {
    try {
      if (document.body.classList.contains('flow-opt-game-sleep')) {
        _lyricsRafId = 0
        return
      }
    } catch (_) {}
    if (!_lyricsOpen || !_lyricsData.length || audio.paused) {
      _lyricsRafId = 0
      return
    }
    syncLyrics(getLyricsSmoothedTime())
    _lyricsRafId = requestAnimationFrame(tick)
  }
  _lyricsRafId = requestAnimationFrame(tick)
}

/** Контейнер со строками текста — только видимая панель (иначе караоке каждый кадр правит два дерева DOM). */
function getLyricsSyncRoot() {
  try {
    const pmShell = document.getElementById('pm-lyrics-shell')
    const pmContent = document.getElementById('pm-lyrics-content')
    if (pmShell && !pmShell.classList.contains('hidden') && pmContent) return pmContent
    const sidePanel = document.getElementById('lyrics-panel')
    const sideContent = document.getElementById('lyrics-content')
    if (sidePanel && !sidePanel.classList.contains('hidden') && sideContent) return sideContent
    return pmContent || sideContent || null
  } catch (_) {
    return null
  }
}

function getKaraokeLineDuration(idx) {
  if (idx < 0 || idx >= _lyricsData.length) return 0
  const start = Number(_lyricsData[idx]?.time || 0)
  const nextStartRaw = Number(_lyricsData[idx + 1]?.time)
  const nextStart = Number.isFinite(nextStartRaw) ? nextStartRaw : (start + 2.4)
  const gapDuration = Math.max(0.35, nextStart - start)
  const chars = Math.max(1, String(_lyricsData[idx]?.text || '').length)
  const readingDuration = Math.max(0.85, Math.min(3.8, chars * 0.085))
  // Long instrumental gaps should freeze on the line instead of stretching highlight.
  return Math.min(gapDuration, readingDuration)
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

function normalizeLyricsPlaybackMode(raw) {
  const m = String(raw || '')
  if (m === 'karaoke') return 'karaoke'
  if (m === 'focus') return 'focus'
  if (m === 'scale') return 'scale'
  if (m === 'neon') return 'neon'
  return 'standard'
}

/** Пресеты кнопок «A» для подсветки выбора в попапе. */
const _LYRICS_SIZE_PRESETS = [16, 22, 28, 38]

function getLyricsVisualSettings() {
  const v = getVisual()
  const src = v.lyrics || {}
  return {
    scrollMode: src.scrollMode === 'line' ? 'line' : 'smooth',
    align: src.align === 'center' ? 'center' : 'left',
    playbackMode: normalizeLyricsPlaybackMode(src.playbackMode),
    effect: src.effect === 'glow' ? 'glow' : (src.effect === 'contrast' ? 'contrast' : 'soft'),
    size: Math.max(13, Math.min(42, Number(src.size || 16))),
    blur: Math.max(0, Math.min(8, Number(src.blur || 4))),
  }
}

let _lyricsCfgQuickMemo = null
function getLyricsVisualSettingsQuick() {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
  if (_lyricsCfgQuickMemo && now - _lyricsCfgQuickMemo.at < 800) return _lyricsCfgQuickMemo.cfg
  const cfg = getLyricsVisualSettings()
  _lyricsCfgQuickMemo = { at: now, cfg }
  return cfg
}

function applyLyricsVisualSettings() {
  _lyricsCfgQuickMemo = null
  const cfg = getLyricsVisualSettings()
  document.documentElement.style.setProperty('--lyrics-size', `${cfg.size}px`)
  document.documentElement.style.setProperty('--lyrics-blur', `${cfg.blur}px`)
  document.body.classList.toggle('lyrics-align-center', cfg.align === 'center')
  document.body.classList.toggle('lyrics-align-left', cfg.align !== 'center')
  document.body.classList.remove('lyrics-mode-standard', 'lyrics-mode-karaoke', 'lyrics-mode-focus', 'lyrics-mode-scale', 'lyrics-mode-neon')
  document.body.classList.add(`lyrics-mode-${cfg.playbackMode}`)
  document.body.classList.remove('lyrics-effect-soft', 'lyrics-effect-glow', 'lyrics-effect-contrast')
  document.body.classList.add(`lyrics-effect-${cfg.effect}`)
  document.querySelectorAll('.pm-lyrics-opt[data-playback]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.getAttribute('data-playback') === cfg.playbackMode)
  })
  document.querySelectorAll('.pm-lyrics-opt[data-effect]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.getAttribute('data-effect') === cfg.effect)
  })
  const scrollSmooth = document.getElementById('pm-lyrics-scroll-smooth')
  const scrollLine = document.getElementById('pm-lyrics-scroll-line')
  if (scrollSmooth) scrollSmooth.classList.toggle('is-active', cfg.scrollMode === 'smooth')
  if (scrollLine) scrollLine.classList.toggle('is-active', cfg.scrollMode === 'line')
  const leftBtn = document.getElementById('pm-lyrics-align-left')
  const centerBtn = document.getElementById('pm-lyrics-align-center')
  if (leftBtn) leftBtn.classList.toggle('is-active', cfg.align === 'left')
  if (centerBtn) centerBtn.classList.toggle('is-active', cfg.align === 'center')
  let near = _LYRICS_SIZE_PRESETS[0]
  let best = Math.abs(cfg.size - near)
  for (const s of _LYRICS_SIZE_PRESETS) {
    const d = Math.abs(cfg.size - s)
    if (d < best) {
      best = d
      near = s
    }
  }
  document.querySelectorAll('.pm-lyrics-size-a').forEach((btn) => {
    btn.classList.toggle('is-active', Number(btn.dataset.size) === near)
  })
}

function setLyricsPlaybackMode(mode) {
  const safe = normalizeLyricsPlaybackMode(mode)
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

function closeLyricsSettingsPanel() {
  if (!_lyricsSettingsOpen) return
  _lyricsSettingsOpen = false
  document.getElementById('pm-lyrics-controls-panel')?.classList.add('hidden')
}

function toggleLyricsSettingsPanel() {
  _lyricsSettingsOpen = !_lyricsSettingsOpen
  const panel = document.getElementById('pm-lyrics-controls-panel')
  if (panel) panel.classList.toggle('hidden', !_lyricsSettingsOpen)
}

document.addEventListener('click', (event) => {
  if (!_lyricsSettingsOpen) return
  const wrap = document.querySelector('.pm-lyrics-settings-wrap')
  if (wrap?.contains(event.target)) return
  closeLyricsSettingsPanel()
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeLyricsSettingsPanel()
})

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
  _lyricsSmoothedTimeAnchor = { audio: 0, perfMs: 0 }
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
          requestAnimationFrame(() => {
            try {
              div.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
            } catch (_) {}
          })
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

function findLyricsLineIndexAtTime(t) {
  const arr = _lyricsData
  const n = arr.length
  if (!n) return -1
  const tt = Number(t)
  const t0 = Number(arr[0].time || 0)
  if (tt < t0) return -1
  const lastT = Number(arr[n - 1].time || 0)
  if (tt >= lastT) return n - 1
  let lo = 0
  let hi = n - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (Number(arr[mid].time || 0) <= tt) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

function syncLyrics(currentTime) {
  try {
    if (document.body.classList.contains('flow-opt-game-sleep')) return
  } catch (_) {}
  if (!_lyricsData.length) return
  const root = getLyricsSyncRoot()
  if (!root) return
  const cfg = getLyricsVisualSettingsQuick()
  const idx = findLyricsLineIndexAtTime(currentTime)
  const idxChanged = idx !== _lyricsActiveIdx
  const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
  const karaokeHighRate = cfg.playbackMode === 'karaoke' && idx >= 0
  const frameBudget = getLyricsFrameBudgetMs()
  // При не-караоке не чаще одного экранного кадра (60/90/120/144 Гц), караоке — каждый RAF.
  if (!idxChanged && now - _lyricsLastPaintAt < frameBudget && !karaokeHighRate) return
  _lyricsLastPaintAt = now
  if (idxChanged) {
    _lyricsActiveIdx = idx
    root.querySelectorAll('.lyrics-line').forEach((el) => {
      try {
        delete el.dataset.kPaintSig
      } catch (_) {}
      const i = Number(el.dataset.idx || -1)
      el.classList.toggle('active', i === idx)
      el.classList.toggle('past', i >= 0 && i < idx)
      el.classList.toggle('future', i > idx)
    })
  }
  if (cfg.playbackMode === 'karaoke') {
    if (idxChanged) {
      root.querySelectorAll('.lyrics-line:not(.active) .lyrics-char.karaoke-on, .lyrics-line:not(.active) .lyrics-char.karaoke-next').forEach((el) => {
        el.classList.remove('karaoke-on', 'karaoke-next')
        el.style.removeProperty('--karaoke-frac')
      })
    }
    const start = idx >= 0 ? Number(_lyricsData[idx]?.time || 0) : 0
    const duration = Math.max(0.35, idx >= 0 ? getKaraokeLineDuration(idx) : 0.35)
    const progress = idx >= 0 ? Math.max(0, Math.min(1, (currentTime - start) / duration)) : 0
    const lineEl = root.querySelector('.lyrics-line.active')
    if (lineEl) {
      const chars = lineEl.querySelectorAll('.lyrics-char')
      if (chars.length) {
        const spread = progress * chars.length
        const activeCount = Math.max(0, Math.min(chars.length, Math.floor(spread)))
        const nextFrac = Math.max(0, Math.min(1, spread - activeCount))
        const qFrac = Math.round(nextFrac * 40) / 40
        const qProg = Math.round(progress * 240) / 240
        const paintSig = `${activeCount}|${qFrac}|${qProg}`
        if (lineEl.dataset.kPaintSig !== paintSig) {
          lineEl.dataset.kPaintSig = paintSig
          lineEl.style.setProperty('--line-progress', `${(qProg * 100).toFixed(2)}%`)
          chars.forEach((charEl, cIdx) => {
            charEl.classList.toggle('karaoke-on', cIdx < activeCount)
            const isNext = cIdx === activeCount && activeCount < chars.length
            charEl.classList.toggle('karaoke-next', isNext)
            if (isNext) charEl.style.setProperty('--karaoke-frac', qFrac.toFixed(3))
            else charEl.style.removeProperty('--karaoke-frac')
          })
        }
      }
    }
  } else if (idxChanged) {
    root.querySelectorAll('.lyrics-char.karaoke-on, .lyrics-char.karaoke-next').forEach((el) => {
      el.classList.remove('karaoke-on', 'karaoke-next')
      el.style.removeProperty('--karaoke-frac')
    })
    root.querySelectorAll('.lyrics-line').forEach((lineEl) => lineEl.style.removeProperty('--line-progress'))
  }
  if (idx >= 0) {
    const el = root.querySelector('.lyrics-line.active')
    if (el && idxChanged) {
      const scrollBeh =
        cfg.playbackMode === 'karaoke' ? 'auto' : cfg.scrollMode === 'smooth' ? 'smooth' : 'auto'
      try {
        el.scrollIntoView({ behavior: scrollBeh, block: 'center', inline: 'nearest' })
      } catch (_) {
        try {
          el.scrollIntoView(true)
        } catch (_) {}
      }
    }
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
    onGif: async (file) => {
      try {
        const mediaUrl = await saveCustomMediaFile(file, 'background')
        saveVisual({ customBg: mediaUrl, bgType: 'custom' })
        setBgType('custom')
        showToast('GIF установлен как фон')
      } catch (err) {
        showToast(`GIF не сохранён: ${sanitizeDisplayText(err?.message || err)}`, true)
      }
    },
    onInvalid: () => showToast('Поддерживаются только .mp3 и .gif', true),
  })
}

// в”Ђв”Ђв”Ђ INIT + HOTKEYS в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
window.addEventListener('DOMContentLoaded', () => {
  window.addEventListener(
    'beforeunload',
    () => {
      try {
        flushListenStatsPending(true)
        teardownAudioAnalyzer()
      } catch (_) {}
    },
    { passive: true },
  )
  fixNodeTextMojibake(document.body)
  startApp()
  try { document.body.setAttribute('data-active-page', _activePageId || 'main') } catch {}
  applyUiTextOverrides()
  syncTrayClosePreferenceToMain()
  refreshLaunchAtLoginFromMain().catch(() => {})
  syncPlaybackSystemToggles()
  refreshHomeDashboardLayoutAfterContentChange()
  setupHomeDashboardDragAndDrop()
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !document.body.classList.contains('home-layout-edit')) return
    try {
      _teardownSidebarPanelDrag()
    } catch (_) {}
    document.body.classList.remove('home-layout-edit', 'flow-edit-enabled')
    syncHomeLayoutEditButton()
    teardownHomeDashboardDrag(true)
    persistHomeDashboardLayoutFromDom()
    if (isVisualFloatedLayout()) {
      applyHomeBlockGeometry(cloneHomeGeometry(loadHomeBlockGeometryRaw()))
    }
    pulseHomeVisualLayoutSync()
    queueMicrotask(() => scheduleMainShiftRemeasure())
  })
  {
    const fySaved = parseInt(localStorage.getItem(FLOW_SIDEBAR_FLOAT_Y_LS) || '0', 10)
    applySidebarFloatYPx(Math.max(0, Number.isFinite(fySaved) ? fySaved : 0))
  }
  setupSidebarResize()
  setupFloatedMainContentResize()
  setupFloatedMainPaneDrag()
  setupSidebarPanelEditDrag()
  setupMainPaneShift()
  try {
    syncFlowLayoutCoords()
  } catch (_) {}
  setupCardTilt()
  const savedSlider = Number(localStorage.getItem('flow_volume_slider') || '0.8')
  setVolume(Number.isFinite(savedSlider) ? savedSlider : 0.8)
  syncHomeCloneUI()
  syncHomeWidgetUI()
  applyHomeSliderStyle()
  applyMediaQueueLayout()
  startHomeVisualizerLoop()
  alignHomeHeaderToPlay()
  window.addEventListener('resize', () => {
    reclampHomeGeometryOnResize()
    alignHomeHeaderToPlay()
    resizeHomeVisualizerCanvas()
  })
  fixNodeTextMojibake(document.body)
  setTimeout(applyUiTextOverrides, 300)
  setTimeout(applyUiTextOverrides, 1200)
  refreshYtDlpStatus().catch(() => {})
  const createBtn = document.getElementById('btn-create-playlist')
  if (createBtn) createBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); createPlaylist() })
  const importTextBtn = document.getElementById('btn-import-text-playlist')
  if (importTextBtn) importTextBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openTextPlaylistImportModal() })
  const importLinkBtn = document.getElementById('btn-import-playlist-link')
  if (importLinkBtn) importLinkBtn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    importPlaylistLinkFromBar()
  })
  const playlistLinkInput = document.getElementById('playlist-link-import-input')
  if (playlistLinkInput) {
    playlistLinkInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      importPlaylistLinkFromBar()
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
      const verEl = document.getElementById('titlebar-version')
      if (verEl) verEl.textContent = `\u00A0v${r.version}`
      const welcomeSub = document.querySelector('#page-home .content-sub')
      if (welcomeSub) welcomeSub.textContent = `Выбери источник и начни слушать • билд ${r.version}`
      showToast(`Запущен билд v${r.version}`)
    }).catch(() => {})
  }
  if (window.api?.isWindowMaximized) {
    window.api.isWindowMaximized().then((m) => syncTitlebarMaximizeIcon(Boolean(m))).catch(() => {})
  }
  window.addEventListener('resize', () => {
    window.api?.isWindowMaximized?.()?.then?.((m) => syncTitlebarMaximizeIcon(Boolean(m)))?.catch?.(() => {})
  })

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
  ;(function setupFlowChromeMicroPulse() {
    const pulse = (ev) => {
      const el = ev.target?.closest?.(
        'button, .player-like-btn, .ctrl-btn, .pm-btn, .pm-btn-side, .pm-cover-action-btn',
      )
      if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return
      el.classList.remove('flow-ui-pulse')
      void el.offsetWidth
      el.classList.add('flow-ui-pulse')
      window.setTimeout(() => el.classList.remove('flow-ui-pulse'), 480)
    }
    document.getElementById('player-bar')?.addEventListener('click', pulse, true)
    document.getElementById('player-mode')?.addEventListener('click', pulse, true)
  })()
  document.addEventListener(
    'pointerdown',
    (ev) => {
      try {
        if (ev?.target?.closest?.('.my-wave-settings-anchor')) return
        closeMyWaveSourceMenus()
      } catch (_) {}
    },
    true,
  )
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
    try {
      syncTransportPlayPauseUi()
    } catch (_) {}
  })
  audio.addEventListener('pause', () => {
    stopLyricsSyncLoop()
    try {
      syncTransportPlayPauseUi()
    } catch (_) {}
  })

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      try {
        closeMyWaveSourceMenus()
      } catch (_) {}
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
      const profileEditModal = document.getElementById('profile-edit-modal')
      if (profileEditModal && !profileEditModal.classList.contains('hidden')) {
        e.preventDefault()
        closeProfileEditModal()
        return
      }
      const libraryModal = document.getElementById('library-action-modal')
      if (libraryModal && !libraryModal.classList.contains('hidden')) {
        e.preventDefault()
        closeLibraryActionModal()
        return
      }
      const textImportModal = document.getElementById('text-import-modal')
      if (textImportModal && !textImportModal.classList.contains('hidden')) {
        e.preventDefault()
        closeTextPlaylistImportModal()
        return
      }
      const peerModal = document.getElementById('peer-profile-modal')
      if (peerModal && !peerModal.classList.contains('hidden')) {
        e.preventDefault()
        closePeerProfile()
        return
      }
      if (_playerModeActive) {
        e.preventDefault()
        exitPlayerMode()
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

;(function setupFlowBootSplash() {
  let done = false
  let loadTs = 0
  let pendingTimer = null
  const MIN_VISIBLE_MS = 3600
  const doDismiss = () => {
    if (done) return
    if (pendingTimer != null) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
    done = true
    document.body.classList.add('flow-boot-ready')
    const el = document.getElementById('flow-boot-splash')
    if (!el) return
    el.classList.add('flow-boot-splash--out')
    const removeEl = () => {
      try {
        el.remove()
      } catch (_) {}
    }
    window.setTimeout(removeEl, 720)
    el.addEventListener(
      'transitionend',
      (e) => {
        if (e.propertyName === 'opacity') removeEl()
      },
      { once: true },
    )
  }
  const queueDismissAfterMinHold = () => {
    if (done) return
    if (pendingTimer != null) clearTimeout(pendingTimer)
    const elapsed = loadTs ? Date.now() - loadTs : 0
    const wait = Math.max(0, MIN_VISIBLE_MS - elapsed)
    pendingTimer = window.setTimeout(() => {
      pendingTimer = null
      doDismiss()
    }, wait)
  }
  const onLoaded = () => {
    loadTs = Date.now()
    window.setTimeout(queueDismissAfterMinHold, 80)
  }
  if (document.readyState === 'complete') onLoaded()
  else window.addEventListener('load', onLoaded, { once: true })
  window.setTimeout(() => {
    if (!done) {
      if (!loadTs) loadTs = Date.now()
      queueDismissAfterMinHold()
    }
  }, 15000)
})()


