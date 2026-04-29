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
  if (!raw) return null
  const fromPath = (path = '') => {
    const m = String(path || '').match(/\/users\/([^/?#]+)\/playlists\/([^/?#]+)/i)
    if (!m) return null
    return { user: decodeURIComponent(m[1]), kind: decodeURIComponent(m[2]) }
  }
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
    const u = new URL(withScheme)
    if (!/(^|\.)music\.yandex\./i.test(u.hostname)) return null
    return fromPath(u.pathname)
  } catch {}
  return fromPath(raw)
}

function parseVkPlaylistRef(input) {
  const raw = String(input || '').trim()
  if (!raw) return null
  const widgetArgs = raw.match(/VK\.Widgets\.Playlist\(\s*["'][^"']+["']\s*,\s*(-?\d+)\s*,\s*(\d+)\s*,\s*["']([a-zA-Z0-9_-]+)["']/i)
  if (widgetArgs) {
    return { ownerId: widgetArgs[1], albumId: widgetArgs[2], accessKey: widgetArgs[3] || null }
  }
  const widgetObject = raw.match(/VK\.Widgets\.Playlist\([^)]*owner_id\s*:\s*(-?\d+)[^)]*playlist_id\s*:\s*(\d+)[^)]*(?:hash|access_hash|access_key)\s*:\s*["']([a-zA-Z0-9_-]+)["']/is)
  if (widgetObject) {
    return { ownerId: widgetObject[1], albumId: widgetObject[2], accessKey: widgetObject[3] || null }
  }
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
