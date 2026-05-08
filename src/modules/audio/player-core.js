(() => {
  function createPlayerAudio(onError) {
    const audio = new Audio()
    audio.volume = 0.8
    audio.onerror = () => {
      if (typeof onError === 'function') onError(audio)
    }
    return audio
  }

  function resumeAudioCtxIfNeeded(ctx) {
    try {
      if (ctx && ctx.state === 'suspended') void ctx.resume()
    } catch (_) {}
  }

  function getSoundProfileConfig() {
    let profile = 'clean'
    try {
      const raw = String(window?.localStorage?.getItem('flow_sound_profile') || 'clean').trim().toLowerCase()
      if (raw === 'balanced' || raw === 'bright') profile = raw
    } catch (_) {}
    if (profile === 'balanced') {
      return {
        lowShelfGain: 1.2,
        presenceGain: 1.1,
        compressor: { threshold: -20, knee: 16, ratio: 2.9, attack: 0.006, release: 0.21 },
        outputGain: 1.02,
      }
    }
    if (profile === 'bright') {
      return {
        lowShelfGain: 0.6,
        presenceGain: 2.8,
        compressor: { threshold: -23, knee: 19, ratio: 3.4, attack: 0.004, release: 0.18 },
        outputGain: 1.04,
      }
    }
    return {
      // "clean": мягкий low-end и подчистка середины/верха без сильной компрессии.
      lowShelfGain: 0.9,
      presenceGain: 2.1,
      compressor: { threshold: -24, knee: 20, ratio: 3.1, attack: 0.004, release: 0.2 },
      outputGain: 1.03,
    }
  }

  function ensureAudioAnalyser(audio, state) {
    if (
      state.analyser &&
      state.freqData &&
      state.audioCtx &&
      state.audioCtx.state !== 'closed'
    ) {
      resumeAudioCtxIfNeeded(state.audioCtx)
      return true
    }
    try {
      if (state.audioCtx && state.audioCtx.state === 'closed') {
        state.audioCtx = null
        state.analyser = null
        state.freqData = null
      }
      state.audioCtx = state.audioCtx || new (window.AudioContext || window.webkitAudioContext)()
      if (!state.audioCtx) return false
      const src = state.audioCtx.createMediaElementSource(audio)
      state.analyser = state.audioCtx.createAnalyser()
      /* 128 → меньше работы на аудио-потоке; для виджета на главной достаточно 64 бинов. */
      state.analyser.fftSize = 128
      state.analyser.smoothingTimeConstant = 0.72

      const lowShelf = state.audioCtx.createBiquadFilter()
      lowShelf.type = 'lowshelf'
      lowShelf.frequency.value = 170
      const soundCfg = getSoundProfileConfig()
      lowShelf.gain.value = soundCfg.lowShelfGain

      const presence = state.audioCtx.createBiquadFilter()
      presence.type = 'peaking'
      presence.frequency.value = 3100
      presence.Q.value = 0.9
      presence.gain.value = soundCfg.presenceGain

      const compressor = state.audioCtx.createDynamicsCompressor()
      compressor.threshold.value = soundCfg.compressor.threshold
      compressor.knee.value = soundCfg.compressor.knee
      compressor.ratio.value = soundCfg.compressor.ratio
      compressor.attack.value = soundCfg.compressor.attack
      compressor.release.value = soundCfg.compressor.release

      const outputGain = state.audioCtx.createGain()
      outputGain.gain.value = soundCfg.outputGain

      // Как в FlowPleerLoww: один линейный граф (два выхода с одного MediaElementSource дают лишнюю работу рендеру аудио)
      src.connect(state.analyser)
      state.analyser.connect(lowShelf)
      lowShelf.connect(presence)
      presence.connect(compressor)
      compressor.connect(outputGain)
      outputGain.connect(state.audioCtx.destination)

      state.freqData = new Uint8Array(state.analyser.frequencyBinCount)
      resumeAudioCtxIfNeeded(state.audioCtx)
      return true
    } catch {
      return false
    }
  }

  function closeAudioContext(state) {
    try {
      if (state.audioCtx && state.audioCtx.state !== 'closed') state.audioCtx.close()
    } catch (_) {}
    state.audioCtx = null
    state.analyser = null
    state.freqData = null
  }

  window.FlowModules = window.FlowModules || {}
  window.FlowModules.audioPlayer = {
    createPlayerAudio,
    ensureAudioAnalyser,
    closeAudioContext,
  }
})()
