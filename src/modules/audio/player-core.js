(() => {
  function createPlayerAudio(onError) {
    const audio = new Audio()
    audio.volume = 0.8
    audio.onerror = () => {
      if (typeof onError === 'function') onError(audio)
    }
    return audio
  }

  function ensureAudioAnalyser(audio, state) {
    if (
      state.analyser &&
      state.freqData &&
      state.audioCtx &&
      state.audioCtx.state !== 'closed'
    ) {
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
      state.analyser.fftSize = 256
      state.analyser.smoothingTimeConstant = 0.68

      const lowShelf = state.audioCtx.createBiquadFilter()
      lowShelf.type = 'lowshelf'
      lowShelf.frequency.value = 170
      lowShelf.gain.value = 2.2

      const presence = state.audioCtx.createBiquadFilter()
      presence.type = 'peaking'
      presence.frequency.value = 3100
      presence.Q.value = 0.9
      presence.gain.value = 1.8

      const compressor = state.audioCtx.createDynamicsCompressor()
      compressor.threshold.value = -22
      compressor.knee.value = 18
      compressor.ratio.value = 3.2
      compressor.attack.value = 0.004
      compressor.release.value = 0.19

      const outputGain = state.audioCtx.createGain()
      outputGain.gain.value = 1.08

      // Как в FlowPleerLoww: один линейный граф (два выхода с одного MediaElementSource дают лишнюю работу рендеру аудио)
      src.connect(state.analyser)
      state.analyser.connect(lowShelf)
      lowShelf.connect(presence)
      presence.connect(compressor)
      compressor.connect(outputGain)
      outputGain.connect(state.audioCtx.destination)

      state.freqData = new Uint8Array(state.analyser.frequencyBinCount)
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
