(() => {
  const YEAR_TOKEN_RE = /\b(?:19|20)\d{2}\b/g
  const NOISE_BRACKETS_RE = /[\[(](?:official\s*(?:video|audio|lyrics?)|lyric\s*video|visualizer|hd|hq|4k|8k|remaster(?:ed)?|audio|video|prod\.?\s+by|explicit|clean|radio\s*edit|extended|full\s*version|live|clip|teaser|trailer)[^\])]*[\])]/gi
  const NOISE_WORD_RE = /\b(?:official|video|audio|lyrics?|lyric|visualizer|hq|hd|4k|8k|remaster(?:ed)?|explicit|clean|full\s*version)\b/gi

  function smartCleanTrackTitle(title) {
    return String(title || '')
      .replace(NOISE_BRACKETS_RE, ' ')
      .replace(YEAR_TOKEN_RE, ' ')
      .replace(NOISE_WORD_RE, ' ')
      .replace(/[_|]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
  }

  function splitArtistAndTitle(fileName) {
    const plain = String(fileName || '').replace(/\.[a-z0-9]+$/i, '').trim()
    if (!plain) return { artist: 'Локальный файл', title: 'Без названия' }
    const chunks = plain.split(/\s+-\s+/)
    if (chunks.length >= 2) {
      return {
        artist: chunks.shift().trim() || 'Локальный файл',
        title: smartCleanTrackTitle(chunks.join(' - ')) || plain
      }
    }
    return { artist: 'Локальный файл', title: smartCleanTrackTitle(plain) || plain }
  }

  window.FlowModules = window.FlowModules || {}
  window.FlowModules.smartCleaning = {
    smartCleanTrackTitle,
    splitArtistAndTitle,
  }
})()
