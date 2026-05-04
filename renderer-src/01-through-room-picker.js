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
let _roomServerFullSyncTimer = null
let _profilesRealtimeUnsub = null
let _lastAppliedServerPlaybackTs = 0
/** Монотонный номер sync от хоста — гость отбрасывает только устаревшие пакеты, не «равные по ts» с pause. */
let _lastPlaybackSyncSeq = 0
let _hostPlaybackSyncSeq = 0
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
let _myWaveMode = (() => {
  try { return localStorage.getItem('flow_my_wave_mode') || 'default' } catch { return 'default' }
})()
let _profileEditDraft = null
let _roomContext = null
let _roomServerSaveTimer = null
let _lastServerStatusCheckAt = 0
const FRIEND_POLL_INTERVAL_MS = 2500
const FRIEND_FRESH_ONLINE_MS = 9000
const FRIEND_PROFILE_REFRESH_MS = 7000
const FLOW_SERVER_DEFAULT_URL = 'http://85.239.34.229:8787'
const FLOW_SOCIAL_DEFAULT_API_BASE = 'http://85.239.34.229/social'
const FLOW_SOCIAL_DEFAULT_API_SECRET = 'flowflow'
const FRIEND_NOTIFY_COOLDOWN_MS = 90 * 1000
const PROFILE_CACHE_TTL_MS = 60 * 1000
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
  visualMode: 'minimal',   // 'minimal' | 'floated' | 'yandex'
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
  if (m === 'yandex') return 'yandex'
  if (m === 'premium' || m === 'floated') return 'floated'
  return 'minimal'
}

/** Свободная геометрия блоков главной и конструктор — только в теме UI «Минимал» (floated). */
function isVisualFloatedLayout() {
  return normalizeVisualThemeMode(getVisual().visualMode) === 'floated'
}

function applyVisualMode(mode) {
  const safe = normalizeVisualThemeMode(mode)
  document.body.classList.remove('visual-minimal', 'visual-premium', 'visual-floated', 'visual-yandex')
  document.body.classList.add(safe === 'floated' ? 'visual-floated' : (safe === 'yandex' ? 'visual-yandex' : 'visual-minimal'))
  const minimalBtn = document.getElementById('vm-minimal')
  const floatedBtn = document.getElementById('vm-floated')
  const yandexBtn = document.getElementById('vm-yandex')
  if (minimalBtn) minimalBtn.classList.toggle('active', safe === 'minimal')
  if (floatedBtn) floatedBtn.classList.toggle('active', safe === 'floated')
  if (yandexBtn) yandexBtn.classList.toggle('active', safe === 'yandex')
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
  showToast(safe === 'yandex' ? 'Режим: Яндекс' : (safe === 'floated' ? 'Режим: минимал' : 'Режим: минимализм'))
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

function setYandexPlayerThemeFromRgb(r, g, b) {
  const root = document.documentElement
  const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)))
  const base = `rgb(${clamp(r * 0.72)}, ${clamp(g * 0.66)}, ${clamp(b * 0.6)})`
  const hi = `rgb(${clamp(r * 0.9 + 46)}, ${clamp(g * 0.84 + 40)}, ${clamp(b * 0.78 + 34)})`
  const lo = `rgb(${clamp(r * 0.38)}, ${clamp(g * 0.34)}, ${clamp(b * 0.32)})`
  root.style.setProperty('--yandex-player-bg', `linear-gradient(90deg, ${lo}, ${base} 32%, ${hi} 64%, ${base})`)
  root.style.setProperty('--yandex-player-card', `rgba(${clamp(r * 0.26)}, ${clamp(g * 0.24)}, ${clamp(b * 0.23)}, 0.58)`)
  root.style.setProperty('--yandex-player-glow', `rgba(${clamp(r)}, ${clamp(g)}, ${clamp(b)}, 0.26)`)
}

function updateYandexPlayerTheme(track = currentTrack) {
  if (shouldIsolateHostTrackVisualsFromRoomGuest()) return
  const fallback = String(track?.bg || '').trim()
  const coverUrl = getEffectiveCoverUrl(track)
  if (!coverUrl) {
    if (fallback && /^linear-gradient|^radial-gradient/i.test(fallback)) {
      document.documentElement.style.setProperty('--yandex-player-bg', fallback)
    } else {
      document.documentElement.style.setProperty('--yandex-player-bg', 'linear-gradient(90deg, #3b1d12, #6b2f14 52%, #8a411c)')
    }
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
  pulseHomeVisualLayoutSync()
  syncAccentSwatchSelection(v.accent, v.accent2)
  try {
    setupFlowOptimizationChannel()
  } catch (_) {}
  applyOptimizationSettings()
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
  if (safe === 'top') {
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
  const allowed = new Set(['appearance', 'playback', 'optimization', 'accounts', 'services'])
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
  // После смены видимой панели подтянуть состояние строк в новом дереве (раньше обновлялось только скрытое).
  try {
    if (_lyricsOpen && _lyricsData?.length && typeof syncLyrics === 'function' && typeof getLyricsSmoothedTime === 'function') {
      queueMicrotask(() => syncLyrics(getLyricsSmoothedTime()))
    }
  } catch (_) {}
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

function getSearchCacheKey(query, settings = getSettings()) {
  const q = String(query || '').trim().toLowerCase()
  const src = String(settings?.activeSource || currentSource || 'hybrid').toLowerCase()
  const tokenSig = [
    settings?.spotifyToken ? 'sp1' : 'sp0',
    settings?.vkToken ? 'vk1' : 'vk0',
    settings?.soundcloudClientId ? 'sc1' : 'sc0',
    settings?.yandexToken ? 'ym1' : 'ym0',
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
const ALLOWED_ACTIVE_SOURCES = new Set(['hybrid', 'spotify', 'soundcloud', 'audius', 'hitmo', 'yandex', 'vk'])

function normalizeStoredActiveSource(rawSrc) {
  const raw = String(rawSrc || 'hybrid').toLowerCase()
  // Основной рабочий поиск — серверный Spotify → SoundCloud → Audius; YouTube как activeSource не используем.
  if (raw === 'yt' || raw === 'youtube') return 'hybrid'
  if (raw === 'ya' || raw === 'ym') return 'yandex'
  if (raw === 'sc') return 'soundcloud'
  if (raw === 'hm') return 'hitmo'
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
    flowSocialApiBase: FLOW_SOCIAL_DEFAULT_API_BASE,
    flowSocialApiSecret: FLOW_SOCIAL_DEFAULT_API_SECRET,
  }
  if (typeof raw.compactUi !== 'boolean') raw.compactUi = false
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
  refreshOptimizationAmbientClasses()
}

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
    return
  }
  if (!window.api?.vkValidateToken) {
    if (msg) {
      msg.textContent = 'Проверка доступна только в Electron'
      msg.className = 'token-msg token-msg-err'
    }
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
          line += ' По умолчанию Flow не открывает Chrome сам: если нужен обход через Chrome+Selenium (Python, selenium, webdriver-manager; профиль %LOCALAPPDATA%\\Flow\\vk_chrome_profile), включи ниже «Обход через Chrome (Selenium)».'
          if (msg) {
            msg.textContent = line
            msg.className = 'token-msg token-msg-warn'
          }
          return
        }

        let line = who
          ? `Профиль подтверждён (${who}), но аудио в Flow недоступно${ac}${detail}. На vkhost выбери Kate Mobile и право «Аудио».`
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
      : String(document.getElementById('vk-token-val')?.value || '').trim()
  if (!t) {
    showToast('Введи или вставь VK токен', true)
    const mEl = document.getElementById('vk-msg')
    if (mEl) {
      mEl.textContent = 'Поле токена пустое'
      mEl.className = 'token-msg token-msg-err'
    }
    return
  }
  const extracted = t.match(/access_token=([^&]+)/)
  if (extracted) t = extracted[1]
  saveSettingsRaw({ vkToken: t })
  const field = document.getElementById('vk-token-val')
  if (field) field.value = t
  updateVkStatus(t)
  showToast('VK токен сохранен')
  if (window.api?.vkValidateToken) void checkVkToken().catch(() => {})
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

async function checkYandexToken() {
  const msg = document.getElementById('ym-msg')
  let tok = document.getElementById('ym-token-val')?.value.trim() || String(getSettings().yandexToken || '').trim()
  const m = tok.match(/access_token=([^&#]+)/)
  if (m) tok = decodeURIComponent(m[1])
  tok = String(tok || '').trim()
  if (!tok) {
    if (msg) {
      msg.textContent = 'Вставь токен или сохрани его галочкой выше'
      msg.className = 'token-msg token-msg-err'
    }
    return
  }
  if (!window.api?.yandexValidateToken) {
    if (msg) {
      msg.textContent = 'Проверка доступна только в Electron'
      msg.className = 'token-msg token-msg-err'
    }
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
    raw === 'hm' ? 'hitmo' :
    raw === 'ya' || raw === 'ym' ? 'yandex' :
    raw === 'vkontakte' ? 'vk' :
    raw
  if (!ALLOWED_ACTIVE_SOURCES.has(normalized)) normalized = 'hybrid'
  saveSettingsRaw({ activeSource: normalized })
  searchCache.clear()
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
  updateScStatus(s.soundcloudClientId)
  updateVkStatus(s.vkToken)
  syncVkSeleniumBridgeToggle()
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
    applyOptimizationSettings()
    syncSearchSourceRows()
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
  const raw = normalizeStoredActiveSource(getSettings()?.activeSource || currentSource || 'hybrid')
  currentSource = raw
  let txt = 'Spotify → SoundCloud → Audius'
  if (raw === 'yandex') txt = 'Яндекс Музыка'
  else if (raw === 'vk') txt = 'ВКонтакте'
  else if (raw === 'spotify') txt = 'Spotify'
  else if (raw === 'soundcloud') txt = 'SoundCloud'
  else if (raw === 'audius') txt = 'Audius'
  else if (raw === 'hitmo') txt = 'Hitmo'
  const b1 = document.getElementById('source-badge'); if (b1) b1.textContent = txt
  const b2 = document.getElementById('source-badge-search'); if (b2) b2.textContent = txt
}

function syncSearchSourceRows() {
  const resolved = normalizeStoredActiveSource(getSettings()?.activeSource || 'hybrid')
  const sel = '.source-mode-card[data-src="hybrid"], .source-mode-card[data-src="yandex"], .source-mode-card[data-src="vk"]'
  document.querySelectorAll(sel).forEach((btn) => {
    const ds = String(btn.getAttribute('data-src') || '')
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
  syncSearchSourceRows()
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
    const membersPath = force
      ? `/flow-api/v1/room-members/${rid}`
      : `/flow-api/v1/room-members/${rid}?since=${encodeURIComponent(nowIso)}`
    const [room, members] = await Promise.all([
      flowSocialGet(`/flow-api/v1/rooms/${rid}`),
      flowSocialGet(membersPath),
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
    loadRoomStateFromServer(false).catch(() => {})
  })
  upsertRoomMemberPresence().catch(() => {})
  loadRoomStateFromServer(true).catch(() => {})
  _roomServerHeartbeatTimer = setInterval(() => {
    upsertRoomMemberPresence().catch(() => {})
  }, 2500)
  _roomServerFullSyncTimer = setInterval(() => {
    loadRoomStateFromServer(true).catch(() => {})
  }, 12000)
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

