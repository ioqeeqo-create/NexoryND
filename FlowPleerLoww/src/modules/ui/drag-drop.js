(() => {
  function isGif(file) {
    return Boolean(file) && (file.type === 'image/gif' || /\.gif$/i.test(file.name || ''))
  }

  function isMp3(file) {
    return Boolean(file) && (file.type === 'audio/mpeg' || /\.mp3$/i.test(file.name || ''))
  }

  function setupGlobalDragDrop(handlers = {}) {
    const onMp3 = typeof handlers.onMp3 === 'function' ? handlers.onMp3 : () => {}
    const onGif = typeof handlers.onGif === 'function' ? handlers.onGif : () => {}
    const onInvalid = typeof handlers.onInvalid === 'function' ? handlers.onInvalid : () => {}

    const stop = (event) => {
      event.preventDefault()
      event.stopPropagation()
    }

    ;['dragenter', 'dragover', 'dragleave', 'drop'].forEach((evt) => {
      window.addEventListener(evt, stop, false)
      document.addEventListener(evt, stop, false)
    })

    window.addEventListener('drop', async (event) => {
      const files = Array.from(event?.dataTransfer?.files || [])
      if (!files.length) return
      const mp3 = files.find(isMp3)
      if (mp3) return onMp3(mp3)
      const gif = files.find(isGif)
      if (gif) return onGif(gif)
      onInvalid(files)
    })
  }

  window.FlowModules = window.FlowModules || {}
  window.FlowModules.dragDrop = {
    setupGlobalDragDrop,
  }
})()
