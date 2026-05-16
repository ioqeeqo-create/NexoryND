(() => {
  const EQ_FREQS = [64, 125, 250, 500, 1000, 2000, 4000, 8000, 12000, 16000, 20000]
  const TRACK_MAP_KEY = 'flow_eq_track_map'

  /** Gain in dB per band (11 values). */
  const PRESETS = {
    neutral: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    bass: [5, 4, 3, 1, 0, 0, 0, 0, 0, 0, 0],
    highs: [0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 4],
    vocal: [-1, 0, 0, 1, 3, 4, 3, 2, 1, 0, 0],
    classic: [3, 2, 1, 0, -1, -1, 0, 1, 2, 3, 3],
    jazz: [2, 1, 0, 1, 2, 1, 0, 1, 2, 2, 1],
    liquid: [2, 3, 2, 0, -1, 0, 1, 2, 3, 2, 1],
    'deep-ocean': [6, 5, 3, 1, 0, -2, -1, 0, 1, 2, 1],
    rock: [4, 3, 1, 0, 1, 2, 2, 1, 0, 0, 0],
  }

  const PRESET_LABELS = {
    neutral: 'Нейтральный',
    bass: 'Басы',
    highs: 'Высокие',
    vocal: 'Вокал',
    classic: 'Классика',
    jazz: 'Джаз',
    liquid: 'Liquid',
    'deep-ocean': 'Deep Ocean',
    rock: 'Rock',
  }

  let _sessionPreset = 'neutral'
  let _sessionGains = PRESETS.neutral.slice()

  function readTrackMap() {
    try {
      const raw = localStorage.getItem(TRACK_MAP_KEY)
      if (!raw) return {}
      const map = JSON.parse(raw)
      return map && typeof map === 'object' ? map : {}
    } catch (_) {
      return {}
    }
  }

  function writeTrackMap(map) {
    try {
      localStorage.setItem(TRACK_MAP_KEY, JSON.stringify(map))
    } catch (_) {}
  }

  function trackEqKey(track) {
    if (!track) return ''
    const src = String(track.source || 'unknown').trim() || 'unknown'
    const id = String(track.id ?? track.ytId ?? track.scId ?? track.title ?? '').trim()
    return `${src}:${id}`
  }

  function readStoredGains() {
    return _sessionGains.slice()
  }

  function readStoredPreset() {
    return _sessionPreset
  }

  function storeEqState(presetId, gains) {
    _sessionPreset = PRESETS[presetId] ? presetId : presetId === 'custom' ? 'custom' : 'neutral'
    _sessionGains = gains.map((v) => (Number.isFinite(Number(v)) ? Number(v) : 0))
  }

  function getPresetGains(presetId) {
    const id = PRESETS[presetId] ? presetId : 'neutral'
    return PRESETS[id].slice()
  }

  function getCurrentGains() {
    return _sessionGains.slice()
  }

  function ensureEqChain(audioCtx, state) {
    if (!audioCtx || state.eqFilters?.length === EQ_FREQS.length) return state.eqFilters || []
    const filters = EQ_FREQS.map((freq) => {
      const f = audioCtx.createBiquadFilter()
      f.type = 'peaking'
      f.frequency.value = freq
      f.Q.value = 1.1
      f.gain.value = 0
      return f
    })
    state.eqFilters = filters
    return filters
  }

  function connectEqChain(fromNode, filters, toNode) {
    if (!fromNode || !toNode || !filters?.length) return fromNode
    let node = fromNode
    for (const f of filters) {
      node.connect(f)
      node = f
    }
    node.connect(toNode)
    return filters[filters.length - 1]
  }

  function rampGain(filter, targetDb, ctx, when) {
    const t = when ?? ctx.currentTime
    try {
      filter.gain.cancelScheduledValues(t)
      filter.gain.setValueAtTime(filter.gain.value, t)
      filter.gain.linearRampToValueAtTime(targetDb, t + 0.22)
    } catch (_) {
      filter.gain.value = targetDb
    }
  }

  function applyGainsToFilters(filters, gains, audioCtx, animate) {
    if (!filters?.length || !gains?.length) return
    const ctx = audioCtx
    const t = ctx?.currentTime ?? 0
    filters.forEach((f, i) => {
      const db = Number(gains[i]) || 0
      if (animate && ctx) rampGain(f, db, ctx, t)
      else f.gain.value = db
    })
  }

  function applyPreset(presetId, state, audioCtx, animate = true) {
    const id = PRESETS[presetId] ? presetId : 'neutral'
    const gains = getPresetGains(id)
    storeEqState(id, gains)
    if (state?.eqFilters?.length) applyGainsToFilters(state.eqFilters, gains, audioCtx, animate)
    return { presetId: id, gains, label: PRESET_LABELS[id] || id }
  }

  function applyCustomGains(gains, state, audioCtx, animate = true) {
    const safe = EQ_FREQS.map((_, i) => {
      const v = Number(gains[i])
      return Number.isFinite(v) ? Math.max(-12, Math.min(12, v)) : 0
    })
    storeEqState('custom', safe)
    if (state?.eqFilters?.length) applyGainsToFilters(state.eqFilters, safe, audioCtx, animate)
    return safe
  }

  function loadEqForTrack(track, state, audioCtx) {
    const key = trackEqKey(track)
    const saved = key ? readTrackMap()[key] : null
    if (saved?.gains?.length === EQ_FREQS.length) {
      const presetId = saved.presetId || 'custom'
      storeEqState(presetId, saved.gains)
      if (state?.eqFilters?.length) applyGainsToFilters(state.eqFilters, saved.gains, audioCtx, false)
      return { presetId, gains: saved.gains.slice(), fromTrack: true }
    }
    return applyPreset('neutral', state, audioCtx, false)
  }

  function saveTrackEqState(track, presetId, gains) {
    const key = trackEqKey(track)
    if (!key) return false
    const safe = EQ_FREQS.map((_, i) => {
      const v = Number(gains[i])
      return Number.isFinite(v) ? Math.max(-12, Math.min(12, v)) : 0
    })
    const map = readTrackMap()
    map[key] = { presetId: presetId || 'custom', gains: safe, at: Date.now() }
    writeTrackMap(map)
    storeEqState(presetId || 'custom', safe)
    return true
  }

  function initEqFromStorage(state, audioCtx) {
    const gains = _sessionGains.slice()
    if (state?.eqFilters?.length) applyGainsToFilters(state.eqFilters, gains, audioCtx, false)
    return { presetId: _sessionPreset, gains }
  }

  window.FlowModules = window.FlowModules || {}
  window.FlowModules.parametricEq = {
    EQ_FREQS,
    PRESETS,
    PRESET_LABELS,
    ensureEqChain,
    connectEqChain,
    applyPreset,
    applyCustomGains,
    initEqFromStorage,
    loadEqForTrack,
    saveTrackEqState,
    trackEqKey,
    getCurrentGains,
    getPresetGains,
    readStoredPreset,
    storeEqState,
  }
})()
