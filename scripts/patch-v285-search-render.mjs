import fs from 'node:fs'
import path from 'node:path'

const d = String.fromCharCode(100, 105, 118)
const file = path.join(path.resolve(import.meta.dirname, '..'), 'renderer-src', '02-peer-profile-to-end.js')
let src = fs.readFileSync(file, 'utf8')

const start = src.indexOf('function filterSearchResultsByCategory')
const end = src.indexOf('function getSourceLabel()', start)
if (start < 0 || end < 0) throw new Error('block not found')

const block = `function searchEntityTypeLabel(type) {
  const t = String(type || 'track').toLowerCase()
  if (t === 'playlist') return 'плейлистов'
  if (t === 'album') return 'альбомов'
  if (t === 'artist') return 'артистов'
  return 'треков'
}

function makeSearchEntityEl(item) {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'search-entity-row'
  const type = String(item?.entityType || 'track').toLowerCase()
  const cover = item?.cover
    ? \`background-image:url(\${escapeHtml(item.cover)})\`
    : \`background:\${item?.bg || 'linear-gradient(135deg,#7c3aed,#a855f7)'}\`
  const badge = typeof flowTrackSourceBadgeHtml === 'function' ? flowTrackSourceBadgeHtml(item) : ''
  const meta =
    type === 'playlist' || type === 'album'
      ? \`\${item?.trackCount ? \`\${item.trackCount} треков\` : 'Коллекция'}\`
      : type === 'artist'
        ? \`\${item?.trackCount ? \`\${item.trackCount} треков\` : 'Артист'}\`
        : ''
  row.innerHTML = \`
    <span class="search-entity-cover" style="\${cover}"></span>
    <span class="search-entity-meta">
      <strong>\${escapeHtml(item?.title || '—')}</strong>
      <span>\${escapeHtml(item?.artist || '—')}\${meta ? \` · \${escapeHtml(meta)}\` : ''}</span>
    </span>
    <span class="search-entity-kind">\${escapeHtml(type === 'track' ? 'Трек' : type === 'playlist' ? 'Плейлист' : type === 'album' ? 'Альбом' : 'Артист')}</span>
    \${badge ? \`<span class="search-entity-src">\${badge}</span>\` : ''}
  \`
  return row
}

async function openSearchEntity(item) {
  const type = String(item?.entityType || 'track').toLowerCase()
  if (type === 'track' || !type) {
    const track = sanitizeTrack(item)
    queue = [track]
    queueIndex = 0
    queueScope = 'search'
    await playTrackObj(track)
    return
  }
  if (type === 'artist') {
    const q = String(item?.title || item?.artist || '').trim()
    if (!q) return
    _searchFilter = 'tracks'
    document.querySelectorAll('.nx-search-filter').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-filter') === 'tracks')
    })
    const input = document.getElementById('search-input')
    if (input) input.value = q
    return searchTracks()
  }
  const url = String(item?.importUrl || '').trim()
  if (!url || !window.api?.importPlaylistLink) {
    showToast('Для этого результата нет ссылки импорта', true)
    return
  }
  showToast('Импорт коллекции...')
  const imported = await window.api.importPlaylistLink(url, {
    yandex: String(getSettings()?.yandexToken || '').trim(),
    vk: String(getSettings()?.vkToken || '').trim(),
    spotify: String(getSettings()?.spotifyToken || '').trim(),
  }).catch((e) => ({ ok: false, error: normalizeInvokeError(e) }))
  if (!imported?.ok || !imported?.tracks?.length) {
    showToast(imported?.error || 'Не удалось загрузить коллекцию', true)
    return
  }
  const tracks = sanitizeTrackList(imported.tracks)
  queue = tracks
  queueIndex = 0
  queueScope = 'search'
  showToast(\`\${imported.name || 'Коллекция'}: \${tracks.length} треков\`)
  await playTrackObj(tracks[0])
}
window.openSearchEntity = openSearchEntity

function renderResults(results) {
  _lastSearchResults = Array.isArray(results) ? results.slice() : []
  const container = document.getElementById('search-results')
  const meta = document.getElementById('search-results-meta')
  const countEl = document.getElementById('results-count')
  const srcEl = document.getElementById('results-source-label')
  if (!container) return
  if (!_lastSearchResults.length) {
    container.innerHTML = \`<${d} class="empty-state"><${d} class="empty-icon"><svg class="ui-icon lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg></${d}><p>Ничего не найдено</p><small>Попробуй другой запрос или источник</small></${d}>\`
    if (meta) meta.style.display = 'none'
    return
  }
  const tracksOnly = _lastSearchResults.filter((it) => !it?.entityType || it.entityType === 'track')
  if (tracksOnly.length === _lastSearchResults.length) {
    queue = sanitizeTrackList(tracksOnly)
    queueIndex = 0
    queueScope = 'search'
  }
  if (meta) meta.style.display = 'flex'
  const kind = _lastSearchResults[0]?.entityType || 'track'
  if (countEl) countEl.textContent = \`\${_lastSearchResults.length} \${searchEntityTypeLabel(kind)}\`
  if (srcEl) srcEl.textContent = getSourceLabel()
  container.innerHTML = ''
  _lastSearchResults.forEach((item, i) => {
    const type = String(item?.entityType || 'track').toLowerCase()
    if (type === 'track') {
      const track = sanitizeTrack(item)
      const el = makeTrackEl(track, true, false)
      el.addEventListener('click', () => {
        queueIndex = tracksOnly.indexOf(track)
        if (queueIndex < 0) queueIndex = i
        playTrackObj(track)
      })
      container.appendChild(el)
      return
    }
    const el = makeSearchEntityEl(item)
    el.addEventListener('click', () => openSearchEntity(item))
    container.appendChild(el)
  })
  try {
    refreshNowPlayingTrackHighlight()
  } catch (_) {}
}

`

src = src.slice(0, start) + block + src.slice(end)
fs.writeFileSync(file, src, 'utf8')
console.log('patched search render')
