function parseSpotifyPlaylistId(input) {
  const raw = String(input || '').trim()
  if (!raw) return null
  const spotifyUrl = raw.match(/(?:https?:\/\/)?(?:open\.)?spotify\.com\/playlist\/([a-zA-Z0-9]+)(?:[/?].*)?$/i)
  if (spotifyUrl) return spotifyUrl[1]
  const m2 = raw.match(/^spotify:playlist:([a-zA-Z0-9]+)$/i)
  if (m2) return m2[1]
  return null
}

function parseYandexPlaylistRef(input) {
  const raw = String(input || '').trim()
  const m = raw.match(/music\.yandex\.[^/]+\/users\/([^/]+)\/playlists\/(\d+)/i)
  if (!m) return null
  return { user: decodeURIComponent(m[1]), kind: m[2] }
}

function parseVkPlaylistRef(input) {
  const raw = String(input || '').trim()
  if (!raw) return null
  const patterns = [
    /audio_playlist(-?\d+)_([0-9]+)(?:_([a-zA-Z0-9]+))?/i,
    /music\.vk\.com\/playlist\/(-?\d+)_([0-9]+)(?:_([a-zA-Z0-9]+))?/i,
    /vk\.com\/music\/playlist\/(-?\d+)_([0-9]+)(?:_([a-zA-Z0-9]+))?/i,
  ]
  for (const rx of patterns) {
    const m = raw.match(rx)
    if (!m) continue
    return { ownerId: m[1], albumId: m[2], accessKey: m[3] || null }
  }
  return null
}

module.exports = {
  parseSpotifyPlaylistId,
  parseYandexPlaylistRef,
  parseVkPlaylistRef,
}
