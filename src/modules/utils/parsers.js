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
  const decodeSafe = (v) => {
    try { return decodeURIComponent(String(v || '').trim()) } catch { return String(v || '').trim() }
  }
  const fromPath = (path = '') => {
    const src = String(path || '')
    const m1 = src.match(/\/users\/([^/?#]+)\/playlists\/([^/?#]+)/i)
    if (m1) return { user: decodeSafe(m1[1]), kind: decodeSafe(m1[2]) }
    // Short form occasionally appears in shared links.
    const m2 = src.match(/\/playlist\/([^/?#]+)\/([^/?#]+)/i)
    if (m2) return { user: decodeSafe(m2[1]), kind: decodeSafe(m2[2]) }
    // Also support compact form: /playlist/user:kind or /playlist/user/kind
    const m3 = src.match(/\/playlist\/([^/?#]+)/i)
    if (m3) return fromRawLike(m3[1])
    return null
  }
  const fromRawLike = (value = '') => {
    const src = String(value || '').trim()
    if (!src) return null
    const pair = src.match(/^([a-zA-Z0-9._-]{1,128})[:/]+([a-zA-Z0-9._-]{1,128})$/)
    if (pair) return { user: decodeSafe(pair[1]), kind: decodeSafe(pair[2]) }
    return fromPath(src)
  }
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
    const u = new URL(withScheme)
    const host = String(u.hostname || '').toLowerCase()
    // Accept music.yandex.* and direct yandex.* playlist links.
    if (!/(^|\.)music\.yandex\./i.test(host) && !/(^|\.)yandex\./i.test(host)) return null
    const direct = fromPath(u.pathname)
    if (direct) return direct
    // Some shared URLs place real target in query params.
    const qp = ['url', 'target', 'to', 'redirect', 'link']
    for (const key of qp) {
      const val = u.searchParams.get(key)
      if (!val) continue
      const nested = parseYandexPlaylistRef(val)
      if (nested) return nested
    }
    return fromRawLike(u.pathname)
  } catch {}
  return fromRawLike(raw)
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
