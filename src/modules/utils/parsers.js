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
  const raw = String(input || '').trim().replace(/^["']|["']$/g, '')
  if (!raw) return null
  const decodeSafe = (v) => {
    try { return decodeURIComponent(String(v || '').trim()) } catch { return String(v || '').trim() }
  }
  const safeUser = (value = '') => {
    const cleaned = String(value || '').trim().replace(/^@+/, '')
    return cleaned || 'me'
  }
  const fromPath = (path = '') => {
    const src = String(path || '')
    const m1 = src.match(/(?:^|\/)users\/([^/?#]+)\/playlists\/([^/?#]+)/i)
    if (m1) return { user: decodeSafe(m1[1]), kind: decodeSafe(m1[2]) }
    // Short form occasionally appears in shared links.
    const m2 = src.match(/(?:^|\/)playlist\/([^/?#]+)\/([^/?#]+)/i)
    if (m2) return { user: decodeSafe(m2[1]), kind: decodeSafe(m2[2]) }
    // Also support compact form: /playlist/user:kind or /playlist/user/kind
    const m3 = src.match(/(?:^|\/)playlist\/([^/?#]+)/i)
    if (m3) return fromRawLike(m3[1])
    // Some links can omit user and only include /playlists/<id>.
    const m4 = src.match(/(?:^|\/)playlists\/([^/?#]+)/i)
    if (m4) return { user: 'me', kind: decodeSafe(m4[1]) }
    return null
  }
  const fromRawLike = (value = '') => {
    const src = String(value || '').trim()
    if (!src) return null
    const pair = src.match(/^([a-zA-Z0-9._-]{1,128})[:/]+([a-zA-Z0-9._-]{1,128})$/)
    if (pair && !/^playlists?$/i.test(pair[1])) return { user: decodeSafe(pair[1]), kind: decodeSafe(pair[2]) }
    const byPath = fromPath(src)
    if (byPath) return byPath
    const compact = src.match(/(?:playlist\/)?([a-zA-Z0-9._-]{1,128})[:/]([a-zA-Z0-9._-]{1,128})/i)
    if (compact) return { user: decodeSafe(compact[1]), kind: decodeSafe(compact[2]) }
    const onlyKind = src.match(/(?:playlists?\/)?([a-zA-Z0-9._-]{1,128})$/i)
    if (onlyKind) return { user: 'me', kind: decodeSafe(onlyKind[1]) }
    return null
  }
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    const withScheme = hasScheme ? raw : `https://${raw}`
    const u = new URL(withScheme)
    const host = String(u.hostname || '').toLowerCase()
    if (!host) return fromRawLike(raw)
    // Accept music.yandex.* and direct yandex.* playlist links.
    if (!/(^|\.)music\.yandex\./i.test(host) && !/(^|\.)yandex\./i.test(host)) {
      return hasScheme ? null : fromRawLike(raw)
    }
    const direct = fromPath(u.pathname)
    if (direct) {
      if (!direct.user || direct.user === 'me') {
        const owner = u.searchParams.get('owner') || u.searchParams.get('user') || u.searchParams.get('uid') || u.searchParams.get('login') || u.searchParams.get('nickname')
        if (owner) direct.user = safeUser(decodeSafe(owner))
      }
      return direct
    }
    // Some shared URLs place real target in query params.
    const qp = ['url', 'target', 'to', 'redirect', 'link']
    for (const key of qp) {
      const val = u.searchParams.get(key)
      if (!val) continue
      const nested = parseYandexPlaylistRef(val)
      if (nested) return nested
    }
    const hash = String(u.hash || '').replace(/^#/, '')
    if (hash) {
      const nestedHash = parseYandexPlaylistRef(hash)
      if (nestedHash) return nestedHash
    }
    return fromRawLike(u.pathname)
  } catch {}
  const embeddedUrl = raw.match(/https?:\/\/[^\s"'<>]+/i)
  if (embeddedUrl) {
    const nested = parseYandexPlaylistRef(embeddedUrl[0])
    if (nested) return nested
  }
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
