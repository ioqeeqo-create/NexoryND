const { audioPlayer = {}, smartCleaning = {}, dragDrop = {}, peerSocial = {}, waveEngine: WE } = window.FlowModules || {}
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
let queueScope = 'generic' // generic | search | liked | playlist | myWave
let openPlaylistIndex = null
let searchDebounceTimer = null
let currentSource = 'hybrid'
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

const COVER_ICON = '<svg class="ui-icon lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'
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
let _flowSocialRoomUnsub = null
let _roomServerHeartbeatTimer = null
let _profilesRealtimeUnsub = null
let _lastAppliedServerPlaybackTs = 0
let _lastRoomServerLoadAt = 0
let _friendPresence = new Map()
let _friendsPollTimer = null
let _playlistDragIndex = -1
let _playlistEditContext = null
let _libraryActionMode = null
let _playlistPickerContext = null
let _playlistPickerSelection = new Set()
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
let _friendContext = null
let _pendingRoomInvite = null
let _myWaveRenderedTracks = []
let _myWaveBuilding = false
let _myWavePreloading = false
let _myWaveMode = (() => {
  try { return localStorage.getItem('flow_my_wave_mode') || 'default' } catch { return 'default' }
})()
let _profileEditDraft = null
let _roomContext = null
let _roomServerSaveTimer = null
let _lastServerStatusCheckAt = 0
const FRIEND_POLL_INTERVAL_MS = 3500
const FRIEND_FRESH_ONLINE_MS = 18000
const FRIEND_PROFILE_REFRESH_MS = 15000
const FLOW_SERVER_DEFAULT_URL = 'http://85.239.34.229:8787'
const FLOW_SOCIAL_DEFAULT_API_BASE = 'http://85.239.34.229:3847'
const FLOW_SOCIAL_DEFAULT_API_SECRET = 'ed33640b3cd6ca2418ebb2016d9f234db18fb58a25564a1c889363eb1d997dd4'
const FRIEND_NOTIFY_COOLDOWN_MS = 90 * 1000
const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000
/** Ленивый API «Моя волна» (реализация в src/modules/wave-engine.js). */
let _waveEngineApi = null
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
      normalizeTrackSignature,
      getQueue: () => queue,
      getCurrentTrack: () => currentTrack,
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
  merged.username = String(nextUsername || prevUsername || '').trim().toLowerCase()
  merged.peerId = resolvedPeerId
  merged.avatarData = next.avatarData || (sameUser ? (prev.avatarData || null) : null)
  merged.bannerData = next.bannerData || (sameUser ? (prev.bannerData || null) : null)
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
    if (saved?.ok && saved.url) return String(saved.url)
    throw new Error(saved?.error || 'media save failed')
  }
  return readFileAsDataUrl(file)
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

const ICONS = {
  play: '<svg class="ui-icon ctrl-play-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M9 8 L17 12 L9 16 Z"/></svg>',
  pause: '<svg class="ui-icon ctrl-play-icon" viewBox="0 0 24 24" fill="currentColor"><rect x="7.25" y="5.75" width="4" height="12.5" rx="1.15"/><rect x="12.75" y="5.75" width="4" height="12.5" rx="1.15"/></svg>',
  plus: '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
  close: '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'
}
const HEART_OUTLINE = '<svg class="ui-icon flow-ref-heart" viewBox="0 0 24 24" fill="none"><path stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" d="M12 20.4s6.5-4.35 8.82-7.74A5.05 5.05 0 0012 6.42a5.05 5.05 0 00-8.82 6.24C5.47 15.93 12 20.35 12 20.42z"/></svg>'
const HEART_FILLED = '<svg class="ui-icon flow-ref-heart" viewBox="0 0 24 24" fill="none"><path stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" d="M12 20.4s6.5-4.35 8.82-7.74A5.05 5.05 0 0012 6.42a5.05 5.05 0 00-8.82 6.24C5.47 15.93 12 20.35 12 20.42z"/><path fill="#e11d48" d="M12 16c-.72-.62-2.65-2.35-2.65-4a1.75 1.75 0 013.38-.72A1.75 1.75 0 0114.65 12c0 1.65-1.93 3.38-2.65 4z"/></svg>'
const PM_PLAY_INNER = '<path fill="currentColor" d="M9 8 L17 12 L9 16 Z"/>'
const PM_PAUSE_INNER = '<rect fill="currentColor" x="7.25" y="5.75" width="4" height="12.5" rx="1.15"/><rect fill="currentColor" x="12.75" y="5.75" width="4" height="12.5" rx="1.15"/>'
const ICON_SIMILAR = '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M14.83 14.83a4 4 0 0 1-6.63 1.1 4 4 0 0 1 1.53-6.73 4 4 0 0 1 5 .37l5.74 5.32"/><path d="M9.17 9.17a4 4 0 0 0 6.63-1.1 4 4 0 0 0-1.53 6.73 4 4 0 0 0-5-.37l-5.74-5.32"/></svg>'

// в”Ђв”Ђв”Ђ VISUAL SETTINGS в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
const defaultVisual = {
  bgType: 'gradient',      // 'gradient' | 'cover' | 'custom'
  blur: 18, bright: 20, glass: 8, panelBlur: 24,
  accent: '#4b5563', accent2: '#9ca3af',
  orb1Color: '#4b5563',
  orb2Color: '#9ca3af',
  visualMode: 'minimal',   // 'minimal' | 'floated'
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
  cardDensity: 'comfort',
  toastPosition: 'default',
  gifMode: { bg: true, track: true, playlist: true },
  lyrics: { scrollMode: 'smooth', align: 'left', size: 16, blur: 4 }
}

function getVisual() {
  try {
    const rawStr = localStorage.getItem('flow_visual') || '{}'
    let raw = {}
    try { raw = JSON.parse(rawStr) } catch (_) { raw = {} }
    if (raw.visualMode === 'premium') {
      raw.visualMode = 'floated'
      try {
        localStorage.setItem('flow_visual', JSON.stringify(raw))
      } catch (_) {}
    }
    return Object.assign({}, defaultVisual, raw)
  } catch {
    return { ...defaultVisual }
  }
}

function saveVisual(patch) {
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
  if (m === 'premium' || m === 'floated') return 'floated'
  return 'minimal'
}

function applyVisualMode(mode) {
  const safe = normalizeVisualThemeMode(mode)
  document.body.classList.remove('visual-minimal', 'visual-premium', 'visual-floated')
  document.body.classList.add(safe === 'floated' ? 'visual-floated' : 'visual-minimal')
  const minimalBtn = document.getElementById('vm-minimal')
  const floatedBtn = document.getElementById('vm-floated')
  if (minimalBtn) minimalBtn.classList.toggle('active', safe === 'minimal')
  if (floatedBtn) floatedBtn.classList.toggle('active', safe === 'floated')
}

function setVisualMode(mode) {
  const safe = normalizeVisualThemeMode(mode)
  saveVisual({ visualMode: safe })
  applyVisualMode(safe)
  showToast(safe === 'floated' ? 'Режим: минимал' : 'Режим: минимализм')
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
  applyToastPosition(v.toastPosition || 'default')

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

async function setHomeWidgetImage(input) {
  const file = input?.files?.[0]
  if (!file) return
  try {
    const mediaUrl = await saveCustomMediaFile(file, 'home-widget')
    const v = getVisual()
    const homeWidget = Object.assign({ enabled: true, mode: 'image', image: null }, v.homeWidget || {})
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
}

function reorderVisualSettingsSections() {
  /* Плеер вынесен в отдельную категорию настроек; порядок секций задаётся в HTML. */
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

function getSafeToastPosition(position) {
  const allowed = new Set(['default', 'top-left', 'top-right', 'bottom-left', 'bottom-right'])
  return allowed.has(position) ? position : 'default'
}

function applyToastPosition(position = getVisual().toastPosition) {
  const safe = getSafeToastPosition(position)
  document.body.setAttribute('data-toast-position', safe)
  document.querySelectorAll('[data-toast-pos]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-toast-pos') === safe)
  })
}

function setToastPosition(position) {
  const safe = getSafeToastPosition(position)
  saveVisual({ toastPosition: safe })
  applyToastPosition(safe)
  showToast('Позиция уведомлений сохранена')
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
  const allowed = new Set(['appearance', 'playback', 'accounts', 'services'])
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
}

/** Совместимость со старыми вызовами switchSettingsTab('visual'|'sources'|'integrations'). */
function switchSettingsTab(tab) {
  const mapped = SETTINGS_TAB_TO_CATEGORY[tab] || tab
  switchSettingsCategory(mapped)
}
window.switchSettingsCategory = switchSettingsCategory

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
  if (icon) icon.innerHTML = audio.paused ? PM_PLAY_INNER : PM_PAUSE_INNER
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

function getSearchCacheKey(query, settings = getSettings()) {
  const q = String(query || '').trim().toLowerCase()
  const src = String(settings?.activeSource || currentSource || 'hybrid').toLowerCase()
  const tokenSig = [
    settings?.spotifyToken ? 'sp1' : 'sp0',
    settings?.vkToken ? 'vk1' : 'vk0',
    settings?.soundcloudClientId ? 'sc1' : 'sc0',
    settings?.proxyBaseUrl ? `srv:${String(settings.proxyBaseUrl).trim().toLowerCase()}` : 'srv0',
  ].join(':')
  return `${src}:${q}:${tokenSig}`
}

// в”Ђв”Ђв”Ђ PROVIDERS в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
const providers = {
  youtube:    (q)    => searchYouTube(q),
  spotify:    (q, s) => searchSpotify(q, s.spotifyToken),
  audius:     (q)    => searchAudius(q),
}

/** Активный источник в настройках: гибрид отдельно от одиночных провайдеров в `providers`. */
const ALLOWED_ACTIVE_SOURCES = new Set(['hybrid', 'spotify', 'soundcloud', 'audius', 'hitmo'])

function normalizeStoredActiveSource(rawSrc) {
  const raw = String(rawSrc || 'hybrid').toLowerCase()
  // Основной рабочий поиск — серверный Spotify → SoundCloud → Audius; YouTube как activeSource не используем.
  if (raw === 'yt' || raw === 'youtube') return 'hybrid'
  if (raw === 'sc') return 'soundcloud'
  if (raw === 'hm') return 'hitmo'
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
    flowSocialApiBase: FLOW_SOCIAL_DEFAULT_API_BASE,
    flowSocialApiSecret: FLOW_SOCIAL_DEFAULT_API_SECRET,
  }
  if (typeof raw.compactUi !== 'boolean') raw.compactUi = false
  if (!Object.prototype.hasOwnProperty.call(raw, 'flowSocialApiBase')) raw.flowSocialApiBase = FLOW_SOCIAL_DEFAULT_API_BASE
  if (!Object.prototype.hasOwnProperty.call(raw, 'flowSocialApiSecret')) raw.flowSocialApiSecret = FLOW_SOCIAL_DEFAULT_API_SECRET
  if (!String(raw.flowSocialApiBase || '').trim()) raw.flowSocialApiBase = FLOW_SOCIAL_DEFAULT_API_BASE
  if (!String(raw.flowSocialApiSecret || '').trim()) raw.flowSocialApiSecret = FLOW_SOCIAL_DEFAULT_API_SECRET
  raw.proxyBaseUrl = normalizeFlowServerUrl(raw.proxyBaseUrl)
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

function saveSettingsRaw(patch) {
  const s = getSettings()
  const updated = Object.assign(s, patch)
  localStorage.setItem('flow_settings', JSON.stringify(updated))
  currentSource = updated.activeSource || 'hybrid'
  updateSourceBadge()
}

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
      if (msg) {
        msg.textContent = 'VK токен получен и сохранён. Теперь можно импортировать плейлист.'
        msg.className = 'token-msg token-msg-ok'
      }
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
  if (!token) return
  const m = token.match(/access_token=([^&]+)/)
  if (m) token = m[1]
  saveSettingsRaw({ vkToken: token })
  updateVkStatus(token)
  showToast('VK токен сохранен')
}

function getCurrentVkTokenForImport() {
  const fieldToken = String(document.getElementById('vk-token-val')?.value || '').trim()
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
  let token = document.getElementById('ym-token-val')?.value.trim()
  const msg = document.getElementById('ym-msg')
  const m = token.match(/access_token=([^&#]+)/)
  if (m) token = decodeURIComponent(m[1])
  if (!token) {
    if (msg) { msg.textContent = 'Вставь access_token или полный redirect URL после OAuth-входа'; msg.className = 'token-msg token-msg-err' }
    showToast('Введи токен Яндекс Музыки', true)
    return
  }
  saveSettingsRaw({ yandexToken: token })
  updateYandexStatus(token)
  if (msg) { msg.textContent = 'Токен сохранен. Теперь можно импортировать плейлисты Яндекс Музыки по ссылке.'; msg.className = 'token-msg token-msg-ok' }
  showToast('Токен Яндекс Музыки сохранен')
}

function openYandexTokenGuide() {
  openUrl(YANDEX_MUSIC_TOKEN_GUIDE_URL)
}

function openYandexOAuthTokenPage() {
  openUrl(YANDEX_MUSIC_OAUTH_URL)
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
  const allowed = new Set(['hybrid', 'spotify', 'soundcloud', 'sc', 'audius', 'hitmo', 'hm'])
  const raw = String(src || '').toLowerCase()
  const normalized =
    raw === 'yt' || raw === 'youtube' ? 'hybrid' :
    raw === 'sc' ? 'soundcloud' :
    raw === 'hm' ? 'hitmo' :
    raw
  const safe = allowed.has(normalized) ? normalized : 'hybrid'
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
  updateYandexStatus(s.yandexToken)
  // Keep settings opening snappy; run heavier sync in next frame.
  requestAnimationFrame(() => {
    syncPlaybackModeUI()
    syncTrackCoverStatus()
    setFlowConfigStatus('Экспорт создаёт JSON с визуалом, профилем, плейлистами и настройками.', false)
    syncFontControls()
    syncHomeWidgetUI()
    applyHomeSliderStyle()
    applyCompactUi()
    switchSettingsCategory(_settingsCategory)
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
    format: 'flow-preset-v1',
    app: 'Flow',
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
    setFlowConfigStatus('Flow preset экспортирован. Можно отправлять .flowpreset другу.', false)
    showToast('Flow preset экспортирован')
    if (failedEmbed && failedEmbed.length) {
      showToast(
        `Не удалось встроить ${failedEmbed.length} файл(ов) с диска — на другом ПК их не будет.`,
        true
      )
    }
  } catch (err) {
    setFlowConfigStatus(`Ошибка экспорта: ${err?.message || err}`, true)
    showToast('Не удалось экспортировать preset', true)
  }
}

function pickFlowConfigFile() {
  const input = document.getElementById('flow-config-input')
  if (!input) return
  input.click()
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
  reader.onload = () => {
    try {
      const sessionBackup = {
        flow_profiles: localStorage.getItem('flow_profiles'),
        flow_current_user: localStorage.getItem('flow_current_user'),
        flow_auth_last_user: localStorage.getItem('flow_auth_last_user'),
      }
      const parsed = JSON.parse(String(reader.result || '{}'))
      const preset = normalizeImportedFlowPreset(parsed)
      const storage = preset?.storage
      if (!storage || typeof storage !== 'object') {
        throw new Error('Неверный формат файла')
      }
      if (preset.replaceAll) {
        const protectedKeys = new Set([
          'flow_profile',
          'flow_profile_accounts',
          'flow_profile_active',
          'flow_profile_presence',
          'flow_profile_pending_messages',
          'flow_profile_presence_room_id',
          'flow_profile_password',
          'flow_profile_password_hash',
          'flow_profile_password_salt',
          'flow_social_accounts',
          'flow_social_session',
          'flow_social_profile',
          'flow_social_pending',
          'flow_friends_cache',
          'flow_auth_last_user',
          'flow_profiles',
          'flow_current_user',
        ])
        const toDelete = []
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i)
          if (key && key.startsWith('flow_') && !protectedKeys.has(key) && !key.startsWith('flow_friends_')) toDelete.push(key)
        }
        toDelete.forEach((key) => localStorage.removeItem(key))
      }
      Object.entries(storage).forEach(([key, value]) => {
        if (!key.startsWith('flow_')) return
        if (
          key === 'flow_profile'
          || key === 'flow_profile_accounts'
          || key === 'flow_profile_active'
          || key === 'flow_profile_presence'
          || key === 'flow_profile_pending_messages'
          || key === 'flow_profile_password'
          || key === 'flow_profile_password_hash'
          || key === 'flow_profile_password_salt'
          || key === 'flow_social_accounts'
          || key === 'flow_social_session'
          || key === 'flow_social_profile'
          || key === 'flow_social_pending'
          || key === 'flow_auth_last_user'
          || key === 'flow_profiles'
          || key === 'flow_current_user'
          || key.startsWith('flow_friends_')
        ) return
        localStorage.setItem(key, String(value ?? ''))
      })
      // Force-restore auth session keys regardless of preset payload content.
      Object.entries(sessionBackup).forEach(([key, value]) => {
        if (typeof value === 'string' && value.trim()) localStorage.setItem(key, value)
      })
      syncRuntimeCachesAfterPresetImport()
      setFlowConfigStatus('Flow preset импортирован. Сессия аккаунта сохранена, перезагрузка не требуется.', false)
      showToast('Flow preset импортирован')
      try { applySettingsSectionsState() } catch {}
      // Важно: не вызывать applyVisualSettings() — она берёт значения из DOM и перезаписывает только что импортированный flow_visual.
      try { initVisualSettings() } catch {}
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
      setFlowConfigStatus(`Ошибка импорта: ${err?.message || err}`, true)
      showToast('Не удалось импортировать preset', true)
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
  const ui = data.ui || {}
  const gifs = data.gifs || {}
  const visual = Object.assign({}, getVisual())
  if (gifs.background) {
    visual.bgType = 'custom'
    visual.customBg = String(gifs.background)
  }
  if (gifs.visualizer) {
    visual.homeWidget = Object.assign({ enabled: true, mode: 'image', image: null }, visual.homeWidget || {}, {
      enabled: true,
      mode: 'image',
      image: String(gifs.visualizer),
    })
  } else if (ui.visualization?.style === 'wave') {
    visual.homeWidget = Object.assign({ enabled: true, mode: 'bars', image: null }, visual.homeWidget || {}, {
      enabled: true,
      mode: 'wave',
    })
  }
  const transparency = ui.transparency || {}
  if (transparency.glass && typeof transparency.glass === 'object') {
    const blur = Number(transparency.glass.blur)
    const strength = Number(transparency.glass.strength)
    if (Number.isFinite(blur)) visual.panelBlur = Math.max(0, Math.min(40, blur))
    if (Number.isFinite(strength)) visual.glass = Math.max(0, Math.min(40, strength))
  }
  const scale = Array.isArray(ui.scale?.default) ? Number(ui.scale.default[0]) : Number(ui.scale?.default)
  if (Number.isFinite(scale)) visual.uiScale = Math.max(80, Math.min(130, scale))
  if (ui.tabs?.position === 'top') visual.sidebarPosition = 'top'
  if (ui.customfont?.family) visual.customFontName = String(ui.customfont.family)
  const storage = { flow_visual: JSON.stringify(visual) }
  if (gifs.cover) storage.flow_track_covers = JSON.stringify({ __global__: String(gifs.cover) })
  return storage
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

function setAuthScreensAuthorized(isAuthorized) {
  const loggedIn = Boolean(isAuthorized)
  document.getElementById('screen-auth')?.classList.toggle('hidden', loggedIn)
  document.getElementById('screen-main')?.classList.toggle('hidden', !loggedIn)
  // Hide the bottom player panel before login/register.
  document.getElementById('player-bar')?.classList.toggle('hidden', !loggedIn)
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
  const defaults = { bio: '', avatarData: null, bannerData: null, profileColor: '', pinnedTracks: [], pinnedPlaylists: [] }
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
    return {
      username: String(data.username || safe),
      avatarData: data.avatar_data || null,
      bannerData: data.banner_data || null,
      profileColor: data.profile_color || '',
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
  const cached = getCachedPeerProfile(safe)
  if (!force && cached?.updatedAt && (now - Number(cached.updatedAt || 0)) < PROFILE_CACHE_TTL_MS) return cached
  const lastPullAt = Number(_friendProfileRefreshAt.get(safe) || 0)
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
  const payload = {
    username: me.username,
    online: true,
    last_seen: new Date().toISOString(),
    avatar_data: custom.avatarData || null,
    banner_data: custom.bannerData || null,
    profile_color: custom.profileColor || null,
    bio: custom.bio || '',
    pinned_tracks: Array.isArray(custom.pinnedTracks) ? custom.pinnedTracks.slice(0, 5) : [],
    pinned_playlists: Array.isArray(custom.pinnedPlaylists) ? custom.pinnedPlaylists.slice(0, 5) : [],
    total_tracks: totalTracks,
    total_seconds: totalSeconds,
  }
  try {
    await flowSocialPut('/flow-api/v1/profile', payload)
  } catch (e1) {
    try {
      const fallbackPayload = Object.assign({}, payload)
      delete fallbackPayload.profile_color
      await flowSocialPut('/flow-api/v1/profile', fallbackPayload)
    } catch (e2) {
      try {
        await flowSocialPut(
          '/flow-api/v1/profile',
          Object.assign({}, payload, { total_tracks: 0, total_seconds: 0 })
        )
      } catch (e3) {
        return { ok: false, error: e3?.message || e2?.message || e1?.message || String(e1) }
      }
    }
  }
  return { ok: true }
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
    const cloudProfile = {
      username,
      avatarData: row?.avatar_data || null,
      bannerData: row?.banner_data || null,
      profileColor: row?.profile_color || '',
      bio: row?.bio || '',
      pinnedTracks: Array.isArray(row?.pinned_tracks) ? row.pinned_tracks.slice(0, 5) : [],
      pinnedPlaylists: Array.isArray(row?.pinned_playlists) ? row.pinned_playlists.slice(0, 5) : [],
      stats: {
        totalTracks: Number(row?.total_tracks || 0),
        totalSeconds: Number(row?.total_seconds || 0),
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
    if (_profile?.username && username === String(_profile.username).trim().toLowerCase()) {
      syncProfileUi()
    }
    renderFriends().catch(() => {})
    if (_roomState?.roomId) renderRoomMembers()
  })
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
    const hostPeerId = _roomState.host
      ? String(_socialPeer?.peer?.id || _roomState.roomId)
      : ((_roomState.hostPeerId && _roomState.hostPeerId !== _roomState.roomId) ? String(_roomState.hostPeerId) : null)
    const payload = Object.assign({
      room_id: _roomState.roomId,
      shared_queue: sharedQueue,
      updated_by_peer_id: String(_socialPeer?.peer?.id || hostPeerId || _roomState.roomId),
      updated_at: new Date().toISOString(),
    }, patch || {})
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

async function loadRoomStateFromServer(force = false) {
  try {
    if (!_roomState?.roomId) return
    const now = Date.now()
    if (!force && (now - _lastRoomServerLoadAt) < 280) return
    _lastRoomServerLoadAt = now
    if (!isFlowSocialReady()) return
    const rid = encodeURIComponent(_roomState.roomId)
    const nowIso = new Date(Date.now() - 20000).toISOString()
    const [room, members] = await Promise.all([
      flowSocialGet(`/flow-api/v1/rooms/${rid}`),
      flowSocialGet(`/flow-api/v1/room-members/${rid}?since=${encodeURIComponent(nowIso)}`),
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
    const profile = mergeProfileData(
      getCachedPeerProfile(m?.username || pid.replace(/^flow-/, '')) || _peerProfiles.get(pid) || { username: m?.username || pid.replace(/^flow-/, '') },
      Object.assign({ username: m?.username || pid.replace(/^flow-/, '') }, m?.profile || {}, { peerId: pid }),
      pid
    )
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
  if (!_roomState?.roomId || !window.FlowSocialBackend?.isConfigured?.()) return
  window.FlowSocialBackend.ensureWs()
  window.FlowSocialBackend.wsSubscribeTopics([`room:${_roomState.roomId}`])
  _flowSocialRoomUnsub = window.FlowSocialBackend.onMessage((msg) => {
    const rid = String(msg?.room_id || '').trim()
    if (rid !== String(_roomState.roomId || '').trim()) return
    if (msg?.table !== 'flow_rooms' && msg?.table !== 'flow_room_members') return
    loadRoomStateFromServer(true).catch(() => {})
  })
  upsertRoomMemberPresence().catch(() => {})
  loadRoomStateFromServer(true).catch(() => {})
  _roomServerHeartbeatTimer = setInterval(() => {
    upsertRoomMemberPresence().catch(() => {})
  }, 2500)
}

function renderRoomMembers() {
  const el = document.getElementById('room-members-list')
  if (!el) return
  if (!_roomState?.roomId) {
    el.innerHTML = '<div class="flow-empty-state compact"><strong>Рума не активна</strong><span>Создай комнату или вставь invite друга.</span></div>'
    return
  }
  const members = Array.from(_roomMembers.values()).map((m) => {
    if (!m?.username) return m
    const cached = getCachedPeerProfile(m.username)
    return cached ? mergeProfileData(cached, m, m?.peerId || cached?.peerId || '') : m
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
    return `<div class="social-friend-card online" oncontextmenu="openRoomMemberContextMenu(event, '${m.peerId || ''}', '${m.username || ''}')">${avatar}<div class="social-friend-meta"><strong>${m.username || 'user'} ${(isHost || isSelfHost) ? 'HOST' : ''}</strong><span>${m.username === _profile?.username ? 'это вы' : 'в комнате'}</span></div></div>`
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
  sharedQueue.push(cleanTrack)
  renderRoomQueue()
  ;(async () => {
    try {
      if (!isFlowSocialReady()) return
      const rid = encodeURIComponent(_roomState.roomId)
      const data = await flowSocialGet(`/flow-api/v1/rooms/${rid}`)
      const nextQueue = Array.isArray(data?.shared_queue)
        ? data.shared_queue.map((t) => sanitizeTrack(t)).filter(Boolean)
        : []
      nextQueue.push(cleanTrack)
      await saveRoomStateToServer({ shared_queue: nextQueue })
    } catch {}
  })()
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
  list.innerHTML = '<div class="flow-empty-state compact"><strong>Ищу треки...</strong><span>Проверяю доступные источники Flow.</span></div>'
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
  if (cached) data = Object.assign({}, cached, data)
  data._friends = Array.isArray(data?._friends) ? data._friends : []
  const renderModal = (profileData) => {
    const avatarSrc = withImageCacheBust(profileData.avatarData)
    const bannerSrc = withImageCacheBust(profileData.bannerData)
    const avatar = avatarSrc
      ? `<div class="profile-avatar" style="background-image:url(${avatarSrc});background-size:cover;background-position:center;background-repeat:no-repeat"></div>`
      : `<div class="profile-avatar">${String(profileData.username || '?').slice(0,1).toUpperCase()}</div>`
    const banner = bannerSrc
      ? `linear-gradient(0deg, rgba(8,10,16,.35), rgba(8,10,16,.35)), url(${bannerSrc})`
      : 'linear-gradient(135deg,#1f2937,#111827)'
    const pinnedTracks = Array.isArray(profileData.pinnedTracks) ? profileData.pinnedTracks : []
    const friends = Array.isArray(profileData._friends) ? profileData._friends.slice(0, 24) : []
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

function setMyWaveMode(mode) {
  _myWaveMode = WE?.MY_WAVE_MODES?.[mode] ? mode : 'default'
  try { localStorage.setItem('flow_my_wave_mode', _myWaveMode) } catch {}
  renderMyWave()
}


async function maybePreloadMyWave(force = false) {
  if (queueScope !== 'myWave' || _myWaveBuilding || _myWavePreloading) return
  const remaining = queue.length - queueIndex - 1
  if (!force && remaining > 3) return
  if (getMyWaveSeedTracks().length < 3) return
  const startLength = queue.length
  _myWavePreloading = true
  renderMyWave()
  try {
    const additions = await findMyWaveRecommendations(10, getMyWaveMode())
    const existing = new Set(queue.map((track) => normalizeTrackSignature(track)).filter(Boolean))
    const fresh = additions.filter((track) => {
      const sig = normalizeTrackSignature(track)
      if (!sig || existing.has(sig)) return false
      existing.add(sig)
      return true
    })
    if (fresh.length) {
      queue.push(...fresh)
      _myWaveRenderedTracks = queue.slice()
      renderQueue()
      showToast(`Моя волна дозагрузила ${fresh.length} треков`)
      if (force && queueIndex >= startLength - 1 && queue[queueIndex + 1]) {
        queueIndex++
        await playTrackObj(queue[queueIndex])
      }
    }
  } catch (err) {
    console.warn('my wave preload failed', err)
  } finally {
    _myWavePreloading = false
    renderMyWave()
  }
}

async function startMyWave() {
  if (_myWaveBuilding) return
  const seedTracks = getMyWaveSeedTracks()
  if (seedTracks.length < 3) return showToast('Послушай или лайкни еще несколько треков, чтобы волна поняла вкус', true)
  _myWaveBuilding = true
  renderMyWave()
  showToast('Моя волна подбирает новые треки...')
  try {
    const tracks = await findMyWaveRecommendations(WE?.MY_WAVE_MIN_TRACKS ?? 10, getMyWaveMode())
    if (!tracks.length) return showToast('Волна пока не нашла новые треки. Попробуй другой режим или послушай еще музыку', true)
    _myWaveRenderedTracks = tracks.slice()
    queue = tracks.slice()
    queueIndex = 0
    queueScope = 'myWave'
    showToast(`Моя волна собрала ${tracks.length} новых треков`)
    await playTrackObj(queue[0])
  } catch (err) {
    showToast(`Моя волна не запустилась: ${sanitizeDisplayText(err?.message || err)}`, true)
  } finally {
    _myWaveBuilding = false
    renderMyWave()
  }
}

function renderMyWave() {
  const listEl = document.getElementById('my-wave-list')
  const hintEl = document.getElementById('my-wave-hint')
  const modesEl = document.getElementById('my-wave-modes')
  if (!listEl || !hintEl) return
  const mode = getMyWaveMode()
  const modeCfg = WE?.MY_WAVE_MODES?.[mode] || WE?.MY_WAVE_MODES?.default
  const seedCount = getMyWaveSeedTracks().length
  if (modesEl) {
    modesEl.innerHTML = Object.entries(WE?.MY_WAVE_MODES || {}).map(([id, cfg]) => (
      `<button class="my-wave-mode ${id === mode ? 'active' : ''}" data-wave-mode="${id}" onclick="setMyWaveMode('${id}')">${cfg.label}</button>`
    )).join('')
  }
  if (seedCount < 3) {
    hintEl.textContent = `Послушай или лайкни еще ${3 - seedCount} трек(ов), чтобы волна поняла твой вкус`
  } else if (_myWaveBuilding) {
    hintEl.textContent = `${modeCfg.label}: ищу новые треки по твоему вкусу...`
  } else if (_myWavePreloading) {
    hintEl.textContent = `${modeCfg.label}: дозагружаю новые треки, чтобы волна не кончалась...`
  } else {
    hintEl.textContent = `${modeCfg.label}: ${modeCfg.hint}. Нажми запуск, и волна сама соберет новую очередь`
  }
  listEl.innerHTML = `
    <div class="my-wave-orb mode-${mode} ${_myWaveBuilding || _myWavePreloading ? 'is-loading' : ''}" aria-label="${modeCfg.label}">
      <div class="my-wave-orb-ring"></div>
      <div class="my-wave-orb-core"></div>
    </div>
  `
  renderRoomsMyWave()
}

function renderRoomsMyWave() {
  const hintEl = document.getElementById('rooms-wave-hint')
  const modesEl = document.getElementById('rooms-wave-modes')
  const listEl = document.getElementById('rooms-wave-list')
  if (!hintEl || !modesEl || !listEl) return
  const mode = getMyWaveMode()
  const modeCfg = WE?.MY_WAVE_MODES?.[mode] || WE?.MY_WAVE_MODES?.default
  const seedCount = getMyWaveSeedTracks().length
  modesEl.innerHTML = Object.entries(WE?.MY_WAVE_MODES || {}).map(([id, cfg]) => (
    `<button class="my-wave-mode ${id === mode ? 'active' : ''}" data-wave-mode="${id}" onclick="setMyWaveMode('${id}')">${cfg.label}</button>`
  )).join('')
  if (seedCount < 3) {
    hintEl.textContent = `Послушай или лайкни еще ${3 - seedCount} трек(ов), чтобы волна поняла твой вкус`
  } else if (_myWaveBuilding) {
    hintEl.textContent = `${modeCfg.label}: ищу новые треки по твоему вкусу...`
  } else if (_myWavePreloading) {
    hintEl.textContent = `${modeCfg.label}: дозагружаю новые треки, чтобы волна не кончалась...`
  } else {
    hintEl.textContent = `${modeCfg.label}: ${modeCfg.hint}. Нажми запуск, и волна сама соберет новую очередь`
  }
  listEl.innerHTML = `
    <div class="my-wave-orb mode-${mode} ${_myWaveBuilding || _myWavePreloading ? 'is-loading' : ''}" aria-label="${modeCfg.label}">
      <div class="my-wave-orb-ring"></div>
      <div class="my-wave-orb-core"></div>
    </div>
  `
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
  applyProfileBannerTheme(custom.bannerData, custom.profileColor).catch?.(() => {})
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
  syncProfileEditModal()
}

function syncProfileEditModal() {
  const modal = document.getElementById('profile-edit-modal')
  if (!modal || modal.classList.contains('hidden')) return
  const draft = _profileEditDraft || getProfileCustom()
  const avatar = document.getElementById('profile-edit-avatar-preview')
  const banner = document.getElementById('profile-edit-banner-preview')
  const bio = document.getElementById('profile-edit-bio')
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
  const colorText = document.getElementById('profile-edit-color-text')
  const draft = Object.assign({}, _profileEditDraft || getProfileCustom(), {
    bio: String(bio?.value || '').trim().slice(0, 180),
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
}

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
  _roomState.host = false
  _roomState.hostPeerId = targetPeerId
  _socialPeer?.sendToPeer?.(targetPeerId, { type: 'room-host-transfer', roomId: _roomState.roomId, hostPeerId: targetPeerId, sharedQueue })
  _socialPeer?.send?.({ type: 'room-host-changed', roomId: _roomState.roomId, hostPeerId: targetPeerId, username })
  await saveRoomStateToServer({ host_peer_id: targetPeerId, shared_queue: sharedQueue }).catch(() => {})
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
  if (!friends.length) return showToast('Список друзей пуст', true)
  openPlaylistPickerModal({
    mode: 'room-invite-friend',
    title: 'Пригласить друга в руму',
    items: friends.map((name) => ({ id: String(name), label: name })),
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
      <div class="onboarding-badge">Flow старт</div>
      <h3>Добро пожаловать в Flow</h3>
      <p>Пару важных вещей, чтобы у тебя и друзей всё работало без ручной настройки.</p>
      <div class="onboarding-grid">
        <div class="onboarding-item"><strong>Аккаунт</strong><span>Логин и пароль сохраняют профиль на сервере, поэтому очистка кэша больше не убивает аккаунт.</span></div>
        <div class="onboarding-item"><strong>Сервер</strong><span>Адрес уже стоит по умолчанию. Его можно поменять в Настройки → Интеграции.</span></div>
        <div class="onboarding-item"><strong>Комнаты</strong><span>Создавай руму, кидай invite другу и управляй очередью вместе.</span></div>
        <div class="onboarding-item"><strong>VK-импорт</strong><span>Flow сервер читает плейлист VK, а приложение ищет эти треки в твоих источниках.</span></div>
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
          <div class="my-wave-hero">
            <div class="my-wave-badge">Моя волна</div>
            <h3>Волна для комнаты</h3>
            <p id="rooms-wave-hint">Выбери режим и запусти волну для общей очереди</p>
            <div class="my-wave-actions">
              <button class="my-wave-start" onclick="startMyWave()">Запустить волну</button>
              <div class="my-wave-modes" id="rooms-wave-modes"></div>
            </div>
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
    <div class="social-friends-grid">${online.length ? online.map((item) => fmtFriendCard(item, true)).join('') : '<div class="flow-empty-state compact"><strong>Никого онлайн</strong><span>Flow покажет друга сразу, как он появится в сети.</span></div>'}</div>
    <div class="social-friends-section-title">Не в сети</div>
    <div class="social-friends-grid">${offline.length ? offline.map((item) => fmtFriendCard(item, false)).join('') : '<div class="flow-empty-state compact"><strong>Пусто</strong><span>Все друзья сейчас онлайн.</span></div>'}</div>
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
  if (fsb) fsb.value = String(s.flowSocialApiBase || '').trim().replace(/\/$/, '')
  if (fss) fss.value = String(s.flowSocialApiSecret || '').trim()
}

function saveFlowSocialBackendSettings() {
  const elB = document.getElementById('flow-social-api-base')
  const elS = document.getElementById('flow-social-api-secret')
  const base = String(elB?.value || '').trim().replace(/\/$/, '')
  const secret = String(elS?.value || '').trim()
  saveSettingsRaw({ flowSocialApiBase: base, flowSocialApiSecret: secret })
  try {
    localStorage.setItem('flow_social_api_base', base)
    localStorage.setItem('flow_social_api_secret', secret)
  } catch (_) {}
  try {
    stopProfilesRealtimeSync()
    stopRoomServerSync()
    window.FlowSocialBackend?.invalidate?.()
    if (_profile?.username) initPeerSocial()
    if (_roomState?.roomId) startRoomServerSync()
  } catch (_) {}
  showToast('Социальный сервер сохранён')
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
  const base = String(document.getElementById('flow-social-api-base')?.value || '').trim().replace(/\/$/, '')
  const secret = String(document.getElementById('flow-social-api-secret')?.value || '').trim()
  saveSettingsRaw({ flowSocialApiBase: base, flowSocialApiSecret: secret })
  try {
    localStorage.setItem('flow_social_api_base', base)
    localStorage.setItem('flow_social_api_secret', secret)
  } catch (_) {}
  if (!base || !secret) {
    setStatus('Соц-API: укажи URL и секрет', false)
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
  showToast('Flow сервер сохранён')
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
  startProfilesRealtimeSync()
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
      if (msg.type === 'playback-sync' && msg.roomId === _roomState.roomId && !_roomState.host) {
        const expectedHostId = String(_roomState.hostPeerId || '').trim()
        const senderId = String(msg._peerId || fromPeerId || '').trim()
        if (!_roomState.hostPeerId && senderId) _roomState.hostPeerId = senderId
        if (expectedHostId && senderId && senderId !== expectedHostId) return
        const ts = Number(msg.playbackTs || msg._ts || 0)
        if (ts && ts <= _lastAppliedServerPlaybackTs) return
        if (ts) _lastAppliedServerPlaybackTs = ts
        if (msg.track && msg.track.id !== currentTrack?.id) {
          playTrackObj(msg.track, { remoteSync: true }).catch(() => {})
        }
        if (typeof msg.currentTime === 'number') {
          const latencySec = Math.max(0, (Date.now() - Number(msg._ts || Date.now())) / 1000)
          const targetTime = Math.max(0, msg.currentTime + latencySec)
          if (Math.abs(audio.currentTime - targetTime) > 0.10) audio.currentTime = targetTime
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
          broadcastPlaybackSync(true)
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

function createRoom() {
  if (!_socialPeer) return
  const r = _socialPeer.createRoom()
  if (!r?.ok) return showToast(r?.error || 'Ошибка создания', true)
  _roomState = { roomId: r.roomId, host: true, hostPeerId: _socialPeer?.peer?.id || r.roomId }
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
  _roomState = { roomId: r.roomId, host: false, hostPeerId: null }
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

async function pollFriendsPresence(force = false) {
  if (!_socialPeer || !_profile?.username || !peerSocial.getFriends) return
  const friends = peerSocial.getFriends(_profile.username) || []
  const entries = await Promise.all(friends.map(async (friend) => {
    const uname = String(friend || '').trim().toLowerCase()
    const prev = _friendPresence.get(uname) || {}
    const freshOnline = !force && prev.online && (Date.now() - Number(prev.updatedAt || 0) < FRIEND_FRESH_ONLINE_MS)
    const isOnline = freshOnline ? true : await _socialPeer.probeUser(uname, 900).catch(() => false)
    if (!isOnline) {
      return [uname, { online: false, track: null, roomId: null, peerId: prev.peerId || null, updatedAt: Date.now() }]
    }
    let state = { online: true, track: prev.track || null, roomId: prev.roomId || `flow-${uname}`, peerId: prev.peerId || `flow-${uname}`, updatedAt: Date.now() }
    const peerId = `flow-${uname}`
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
    await refreshFriendProfileFromCloud(uname, force).catch(() => null)
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
  _socialPeer.send({
    type: 'playback-sync',
    roomId: _roomState.roomId,
    track: currentTrack,
    playbackTs: Date.now(),
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
  setText('#page-settings .content-header .content-sub', 'Выбери раздел слева — настройки сгруппированы по смыслу.')
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

  const labels = Array.from(document.querySelectorAll('#settings-panel-appearance .vs-label, #settings-panel-playback .vs-label'))
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
    if (_activePageId === 'home') {
      drawHomeVisualizerFrame()
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
  if (_playerModeActive) syncPlayerModeUI()
}

// в”Ђв”Ђв”Ђ NAVIGATION в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
let _activePageId = 'home'
let _deferredPageRenderRaf = 0

function runDeferredPageRender(id) {
  if (id === 'home') return renderMyWave()
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
  try { document.body.setAttribute('data-active-page', id) } catch {}
  syncSearchBarCollapsedState()
  if (_deferredPageRenderRaf) cancelAnimationFrame(_deferredPageRenderRaf)
  _deferredPageRenderRaf = requestAnimationFrame(() => {
    _deferredPageRenderRaf = 0
    runDeferredPageRender(id)
  })
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
  pushListenHistory(track)
  if (_activePageId === 'home') renderMyWave()
  let streamUrl = track.url
  let streamEngine = null
  const nameEl = document.getElementById('player-name')
  const artistEl = document.getElementById('player-artist')
  const playBtn = document.getElementById('play-btn')
  if (nameEl) nameEl.textContent = track.title || 'Без названия'
  const setStage = (text) => { if (artistEl) artistEl.textContent = text }
  setStage('Загрузка…')
  if (playBtn) playBtn.innerHTML = '<svg class="ui-icon spin-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7v5l3 2"/></svg>'

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
  const cover = document.getElementById('player-cover')
  const effectiveCover = getEffectiveCoverUrl(track)
  applyCoverArt(cover, effectiveCover, track.bg || 'linear-gradient(135deg,#7c3aed,#a855f7)')
  if (playBtn) playBtn.innerHTML = ICONS.pause
  const pmIcon = document.getElementById('pm-play-icon')
  if (pmIcon) pmIcon.innerHTML = PM_PAUSE_INNER
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
  renderRoomNowPlaying()
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
    if (icon) icon.innerHTML = PM_PAUSE_INNER
  } else {
    audio.pause()
    if (playBtn) playBtn.innerHTML = ICONS.play
    const icon = document.getElementById('pm-play-icon')
    if (icon) icon.innerHTML = PM_PLAY_INNER
  }
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
  if (v1) v1.value = slider
  if (v2) v2.value = slider
  if (v3) v3.value = slider
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
  const allowShuffle = playbackMode.shuffle && queueScope === 'liked'
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

audio.ontimeupdate = () => {
  // Keep general UI updates lightweight, but make lyrics sync feel tighter.
  const shouldSyncUi = (performance.now() - _lastUiSyncAt) >= 90
  if (_lyricsOpen && _lyricsData.length) syncLyrics(getLyricsSmoothedTime())
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
  if (queueScope === 'myWave' && !audio.paused && queue.length - queueIndex - 1 <= 3) maybePreloadMyWave(false)
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
    const key = getSearchCacheKey(q, s)
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
      container.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg class="ui-icon lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.8 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0Z"/></svg></div><p>${message}</p><small>Источник: ${getSourceLabel()}</small><div style="display:flex;gap:8px;justify-content:center;margin-top:12px"><button class="btn-small" onclick="searchTracks()">Повторить</button><button class="btn-small" onclick="openPage('settings')">Настройки</button></div></div>`
    }
  }, 350)
}

async function searchTracksDirect(query, settings = getSettings()) {
  const q = String(query || '').trim()
  if (!q) return []
  const src = String(settings?.activeSource || currentSource || 'hybrid').toLowerCase()
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
    container.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg class="ui-icon lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg></div><p>Ничего не найдено</p><small>Попробуй другой запрос или источник</small></div>`
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
  if (isLiked(track)) {
    liked = liked.filter((t) => !(t.id === track.id && t.source === track.source))
    showToast('РЈР±СЂР°РЅРѕ РёР· Р»СЋР±РёРјС‹С…')
  } else {
    liked.push(track)
    showToast('Р”РѕР±Р°РІР»РµРЅРѕ РІ Р»СЋР±РёРјС‹Рµ в™Ґ')
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
  document.getElementById('playlist-view-name').textContent = pl.name
  const metaEl = document.getElementById('playlist-view-meta')
  if (metaEl) metaEl.textContent = pl.description || `${pl.tracks.length} треков`
  const coverEl = document.getElementById('playlist-view-cover')
  if (coverEl) {
    const playlistCover = sanitizeMediaByGifMode(pl.coverData || '', 'playlist')
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
    if (cursor < pl.tracks.length) setTimeout(renderChunk, 0)
  }
  requestAnimationFrame(renderChunk)
}

function closePlaylist() {
  openPlaylistIndex=null
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
      updateImportProgress(i, maxTracks, `Ищу: ${it.artist || '—'} - ${it.title || '—'}${notFound.length ? ` | не найдено: ${notFound.slice(-3).join('; ')}` : ''}`)
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
      updateImportProgress(i + 1, maxTracks, `Импорт: ${i + 1} из ${maxTracks}${notFound.length ? ` | не найдено: ${notFound.slice(-3).join('; ')}` : ''}`)
      await importDelay(300 + Math.floor(Math.random() * 201))
    }
    const pls = getPlaylists()
    const name = `${imported.name || 'Imported Playlist'} [${imported.service || 'import'}]`
    pls.push(normalizePlaylist({ name, tracks: collected }))
    savePlaylists(pls)
    renderPlaylists()
    openPage('library')
    if (notFound.length) {
      const report = notFound.slice(0, 12).join('; ')
      updateImportProgress(maxTracks, maxTracks, `Готово. Не найдено ${notFound.length}: ${report}${notFound.length > 12 ? '...' : ''}`)
      await importDelay(1600)
    }
  } finally {
    closeImportProgress()
  }
  return { added: collected.length, missed: notFound.length, total: maxTracks }
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
  showToast(`Нашёл строк: ${tracks.length}. Запускаю поиск Flow...`)
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
    showToast(`Импорт завершен. Добавлено ${stats.added} треков, ${stats.missed} не найдено`)
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

let _playlistRenderToken = 0
let _openPlaylistTrackRenderToken = 0
function renderPlaylists() {
  const token = ++_playlistRenderToken
  const pls = getPlaylists().map(normalizePlaylist)
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
        observeLazyCoverBackground(icon, playlistCover, '', `playlist:${currentIdx}`)
      }
      el.addEventListener('click', () => openPlaylist(currentIdx))
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
    if (!_lyricsOpen || !_lyricsData.length || audio.paused) {
      _lyricsRafId = 0
      return
    }
    syncLyrics(getLyricsSmoothedTime())
    _lyricsRafId = requestAnimationFrame(tick)
  }
  _lyricsRafId = requestAnimationFrame(tick)
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

function applyLyricsVisualSettings() {
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
  const karaokeHighRate = cfg.playbackMode === 'karaoke' && idx >= 0
  const frameBudget = getLyricsFrameBudgetMs()
  // При не-караоке не чаще одного экранного кадра (60/90/120/144 Гц), караоке — каждый RAF.
  if (!idxChanged && now - _lyricsLastPaintAt < frameBudget && !karaokeHighRate) return
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
    const duration = Math.max(0.35, idx >= 0 ? getKaraokeLineDuration(idx) : 0.35)
    const progress = idx >= 0 ? Math.max(0, Math.min(1, (currentTime - start) / duration)) : 0
    document.querySelectorAll('.lyrics-line.active').forEach((lineEl) => {
      const chars = Array.from(lineEl.querySelectorAll('.lyrics-char'))
      if (!chars.length) return
      const spread = progress * chars.length
      const activeCount = Math.max(0, Math.min(chars.length, Math.floor(spread)))
      const nextFrac = Math.max(0, Math.min(1, spread - activeCount))
      lineEl.style.setProperty('--line-progress', `${(progress * 100).toFixed(2)}%`)
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
  enableMojibakeAutoFix()
  startApp()
  try { document.body.setAttribute('data-active-page', _activePageId || 'home') } catch {}
  applyUiTextOverrides()
  setupSidebarResize()
  setupCardTilt()
  const savedSlider = Number(localStorage.getItem('flow_volume_slider') || '0.8')
  setVolume(Number.isFinite(savedSlider) ? savedSlider : 0.8)
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
      const logo = document.getElementById('titlebar-logo')
      if (logo) logo.textContent = `⬢ Flow v${r.version}`
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


