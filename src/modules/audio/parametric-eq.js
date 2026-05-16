(() => {
  const EQ_FREQS = [64, 125, 250, 500, 1000, 2000, 4000, 8000, 12000, 16000, 20000]

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

  function readStoredGains() {
    try {
      const raw = localStorage.getItem('flow_eq_gains')
      if (!raw) return null
      const arr = JSON.parse(raw)
      if (!Array.isArray(arr) || arr.length !== EQ_FREQS.length) return null
      return arr.map((v) => (Number.isFinite(Number(v)) ? Number(v) : 0))
    } catch (_) {
      return null
    }
  }

  function readStoredPreset() {
    try {
      return String(localStorage.getItem('flow_eq_preset') || 'neutral').trim().toLowerCase()
    } catch (_) {
      return 'neutral'
    }
  }

  function storeEqState(presetId, gains) {
    try {
      localStorage.setItem('flow_eq_preset', presetId)
      localStorage.setItem('flow_eq_gains', JSON.stringify(gains))
    } catch (_) {}
  }

  function getPresetGains(presetId) {
    const id = PRESETS[presetId] ? presetId : 'neutral'
    return PRESETS[id].slice()
  }

  function getCurrentGains() {
    return readStoredGains() || getPresetGains(readStoredPreset())
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

  function initEqFromStorage(state, audioCtx) {
    const preset = readStoredPreset()
    const gains = readStoredGains() || getPresetGains(preset)
    if (state?.eqFilters?.length) applyGainsToFilters(state.eqFilters, gains, audioCtx, false)
    return { presetId: preset, gains }
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
    getCurrentGains,
    getPresetGains,
    readStoredPreset,
    storeEqState,
  }
})()
