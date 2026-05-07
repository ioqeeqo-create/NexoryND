;(function initWaveEngine(global) {
  const MY_WAVE_MIN_TRACKS = 10
  const MY_WAVE_MAX_TRACKS = 30
  const MY_WAVE_MODES = {
    default: {
      label: 'Обычная',
      hint: 'глубокая очередь по общему вкусу, жанрам и похожим артистам',
      keywords: ['official', 'audio', 'music', 'mix', 'single', 'album', 'remix', 'feat', 'prod', 'viral', 'trend', 'trending', 'hit', 'popular', 'vibe', 'tiktok', 'hyperpop', 'phonk', 'dreamcore'],
      queryTerms: ['viral hits', 'tiktok vibe', 'trending music', 'popular mix', 'hyperpop viral', 'phonk viral', 'slowed reverb popular'],
    },
    sad: {
      label: 'Грустная',
      hint: 'мягкая и меланхоличная очередь из твоих предпочтений',
      keywords: ['sad', 'slow', 'slowed', 'reverb', 'dreamcore', 'doll', 'mirrors', 'lofi', 'lo-fi', 'melancholy', 'melancholic', 'alone', 'lonely', 'cry', 'tears', 'rain', 'night', 'dark', 'blue', 'broken', 'heartbreak', 'empty', 'pain', 'груст', 'печаль', 'слез', 'один', 'одна', 'одиноч', 'дожд', 'ноч', 'боль', 'разбит', 'тоска', 'пуст', 'плак', 'забыть'],
      queryTerms: ['sad viral', 'sad tiktok', 'slowed reverb popular', 'dreamcore music', 'sad aesthetic tiktok', 'depression cherry vibe', 'melancholic pop'],
    },
    happy: {
      label: 'Веселая',
      hint: 'более светлая и позитивная очередь по твоему вкусу',
      keywords: ['happy', 'smile', 'summer', 'sun', 'sunny', 'party', 'dance', 'fun', 'joy', 'love', 'good', 'vibe', 'vibes', 'club', 'bright', 'feel good', 'hyperpop', 'glitchcore', 'весел', 'улыб', 'лето', 'солн', 'танц', 'кайф', 'радост', 'любов', 'позитив', 'движ', 'туса', 'вечерин'],
      queryTerms: ['happy viral', 'tiktok happy', 'feel good', 'hyperpop happy', 'glitchcore pop', 'summer vibe', 'party mix'],
    },
    energetic: {
      label: 'Энергичная',
      hint: 'треклист поживее, чтобы разогнаться',
      keywords: ['energy', 'energetic', 'speed', 'fast', 'power', 'rock', 'metal', 'drum', 'bass', 'dnb', 'phonk', 'rave', 'club', 'hard', 'workout', 'rage', 'trap', 'banger', 'aggressive', 'brazilian', 'drift', 'gym', 'фонк', 'энерг', 'быстр', 'мощ', 'рок', 'метал', 'рейв', 'клуб', 'фонк', 'драм', 'бас', 'разнос', 'жестк'],
      queryTerms: ['phonk viral', 'aggressive phonk', 'brazilian funk popular', 'gym phonk', 'tiktok hype', 'energetic viral', 'club banger'],
    },
    calm: {
      label: 'Спокойная',
      hint: 'ровная очередь без резких прыжков',
      keywords: ['calm', 'chill', 'relax', 'ambient', 'acoustic', 'piano', 'sleep', 'dream', 'soft', 'quiet', 'slow', 'lofi', 'lo-fi', 'dreamcore', 'softcore', 'спокой', 'чил', 'расслаб', 'акуст', 'пианино', 'сон', 'мечт', 'тих', 'медлен', 'мягк'],
      queryTerms: ['chill viral', 'calm tiktok', 'soft night', 'lofi vibe', 'dreamcore chill', 'ambient playlist', 'relax mix'],
    },
    romantic: {
      label: 'Романтика',
      hint: 'больше треков про любовь и мягкий вайб',
      keywords: ['love', 'heart', 'kiss', 'romance', 'romantic', 'baby', 'darling', 'sweet', 'relationship', 'miss you', 'slowed', 'soft', 'любов', 'сердц', 'роман', 'поцел', 'мила', 'милый', 'нежн', 'скуч', 'твоя', 'твой', 'влюб'],
      queryTerms: ['romantic viral', 'love tiktok', 'soft love', 'heartbreak love', 'slowed love songs', 'night romance', 'relationship songs'],
    },
  }
  const MY_WAVE_TOKEN_STOPWORDS = new Set(['official', 'audio', 'video', 'music', 'feat', 'ft', 'prod', 'remix', 'mix', 'single', 'album', 'lyrics', 'lyric', 'clip', 'track', 'version', 'radio', 'edit', 'the', 'and', 'for', 'with', 'для', 'при', 'это', 'как', 'или', 'feat.'])
  const WAVE_TASTE_STORAGE_KEY = 'flow_wave_taste_v1'
  const WAVE_TASTE_MAX_ART = 22
  const WAVE_TASTE_MAX_TOK = 16
  const WAVE_MY_WAVE_MIN_DURATION_SEC = 75

  /** @typedef {ReturnType<typeof createWaveEngine>} WaveEngineApi */

  /** @param {object} ctx */
  function createWaveEngine(ctx) {
    const getListenHistory = typeof ctx.getListenHistory === 'function' ? ctx.getListenHistory : () => []
    const getLiked = typeof ctx.getLiked === 'function' ? ctx.getLiked : () => []
    const getPlaylists = typeof ctx.getPlaylists === 'function' ? ctx.getPlaylists : () => []
    const normalizePlaylist = typeof ctx.normalizePlaylist === 'function' ? ctx.normalizePlaylist : (p) => p
    const sanitizeTrack = typeof ctx.sanitizeTrack === 'function' ? ctx.sanitizeTrack : (t) => t
    const sanitizeTrackList = typeof ctx.sanitizeTrackList === 'function' ? ctx.sanitizeTrackList : (list) => list
    const getSettings = typeof ctx.getSettings === 'function' ? ctx.getSettings : () => ({})
    const searchHybridTracks = typeof ctx.searchHybridTracks === 'function' ? ctx.searchHybridTracks : async () => ({ tracks: [] })
    const searchTracksDirect = typeof ctx.searchTracksDirect === 'function' ? ctx.searchTracksDirect : async () => []
    const getMyWaveSource = typeof ctx.getMyWaveSource === 'function' ? ctx.getMyWaveSource : () => 'hybrid'
    const normalizeTrackSignature = typeof ctx.normalizeTrackSignature === 'function' ? ctx.normalizeTrackSignature : () => ''
    const getQueue = typeof ctx.getQueue === 'function' ? ctx.getQueue : () => []
    const getCurrentTrack = typeof ctx.getCurrentTrack === 'function' ? ctx.getCurrentTrack : () => null

    function getMyWaveTrackKey(track) {
      const safe = sanitizeTrack(track)
      if (!safe?.id) return ''
      return `${safe.source || 'unknown'}:${safe.id}`
    }

    function addMyWaveCandidate(map, track, weight = 1, playedAt = 0) {
      const safe = sanitizeTrack(track)
      const key = getMyWaveTrackKey(safe)
      if (!key) return
      const prev = map.get(key)
      const score = Number(weight) || 0
      if (prev) {
        prev.weight += score
        prev.playedAt = Math.max(Number(prev.playedAt || 0), Number(playedAt || 0))
      } else {
        map.set(key, { key, track: safe, weight: score, playedAt: Number(playedAt || 0) })
      }
    }

    function getMyWaveCandidates() {
      const map = new Map()
      const history = getListenHistory()
      history.forEach((item, idx) => {
        addMyWaveCandidate(map, item?.track, 6 + Math.max(0, MY_WAVE_MAX_TRACKS - idx) / 8, item?.playedAt)
      })
      getLiked().forEach((track) => addMyWaveCandidate(map, track, 4, 0))
      getPlaylists().map(normalizePlaylist).forEach((pl) => {
        ;(pl.tracks || []).forEach((track) => addMyWaveCandidate(map, track, 2, 0))
      })
      return Array.from(map.values())
    }

    function getMyWaveSeedTracks() {
      return getMyWaveCandidates()
        .sort((a, b) => (Number(b.weight || 0) + Number(b.playedAt || 0) / 1e13) - (Number(a.weight || 0) + Number(a.playedAt || 0) / 1e13))
        .map((item) => item.track)
        .filter(Boolean)
    }

    function getMyWaveTokens(track) {
      return `${track?.artist || ''} ${track?.title || ''}`
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
        .split(/\s+/)
        .map((x) => x.trim())
        .filter((x) => x.length >= 3 && !MY_WAVE_TOKEN_STOPWORDS.has(x) && !/^\d+$/.test(x))
    }

    function normalizeMyWaveArtistName(value) {
      return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
    }

    function getMyWaveArtistNames(track) {
      return String(track?.artist || '')
        .split(/\s*(?:,|&|\+| x | feat\.? | ft\.? | при участии | и )\s*/i)
        .map(normalizeMyWaveArtistName)
        .filter((name) => name && name !== '—' && name.length >= 2)
        .slice(0, 4)
    }

    function getMyWavePrimaryArtist(track) {
      return getMyWaveArtistNames(track)[0] || normalizeMyWaveArtistName(track?.artist || '')
    }

    function getNormalizedTrackDurationSec(track) {
      const raw = Number(track?.duration_ms ?? track?.duration ?? track?.durationSec)
      if (!Number.isFinite(raw) || raw <= 0) return null
      const src = String(track?.source || '').toLowerCase()
      if (src === 'youtube' || src === 'vk' || src === 'yandex') {
        return raw > 7200 ? raw / 1000 : raw
      }
      if (raw >= 30000) return raw / 1000
      if (raw < 600) return raw
      return raw / 1000
    }

    function loadWaveTasteMap() {
      try {
        const parsed = JSON.parse(global.localStorage?.getItem(WAVE_TASTE_STORAGE_KEY) || 'null')
        if (!parsed || typeof parsed !== 'object') return { artistNeg: {}, tokenNeg: {}, artistPos: {} }
        return {
          artistNeg: typeof parsed.artistNeg === 'object' && parsed.artistNeg ? parsed.artistNeg : {},
          tokenNeg: typeof parsed.tokenNeg === 'object' && parsed.tokenNeg ? parsed.tokenNeg : {},
          artistPos: typeof parsed.artistPos === 'object' && parsed.artistPos ? parsed.artistPos : {},
        }
      } catch {
        return { artistNeg: {}, tokenNeg: {}, artistPos: {} }
      }
    }

    function saveWaveTasteMap(taste) {
      try {
        const prune = (obj, limit = 48) => {
          const ent = Object.entries(obj || {}).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
          const out = {}
          ent.slice(0, limit).forEach(([k, v]) => { if (k && Number.isFinite(Number(v))) out[k] = Number(v) })
          return out
        }
        const payload = {
          artistNeg: prune(taste?.artistNeg || {}),
          tokenNeg: prune(taste?.tokenNeg || {}),
          artistPos: prune(taste?.artistPos || {}, 32),
        }
        global.localStorage?.setItem(WAVE_TASTE_STORAGE_KEY, JSON.stringify(payload))
      } catch {}
    }

    function bumpWaveNeg(map, key, delta) {
      const k = String(key || '').trim().toLowerCase()
      if (!k || k.length < 2) return map
      map[k] = Math.min(WAVE_TASTE_MAX_ART, Math.max(0, Number(map[k] || 0) + delta))
      return map
    }

    function bumpWavePos(map, key, delta) {
      const k = String(key || '').trim().toLowerCase()
      if (!k || k.length < 2) return map
      map[k] = Math.min(WAVE_TASTE_MAX_ART, Math.max(0, Number(map[k] || 0) + delta))
      return map
    }

    function recordWaveEarlySkip(track) {
      const safe = sanitizeTrack(track)
      if (!safe?.artist) return
      const taste = loadWaveTasteMap()
      bumpWaveNeg(taste.artistNeg, getMyWavePrimaryArtist(safe), 5)
      getMyWaveTokens(safe).slice(0, 6).forEach((tok) => bumpWaveNeg(taste.tokenNeg, tok, 3))
      saveWaveTasteMap(taste)
    }

    function recordWavePositiveListen(track) {
      const safe = sanitizeTrack(track)
      if (!safe?.artist) return
      const taste = loadWaveTasteMap()
      bumpWavePos(taste.artistPos, getMyWavePrimaryArtist(safe), 1.2)
      saveWaveTasteMap(taste)
    }

    function applyWaveTasteToScore(track, baseScore) {
      const taste = loadWaveTasteMap()
      let s = baseScore
      getMyWaveArtistNames(track).forEach((a) => {
        const k = normalizeMyWaveArtistName(a)
        s -= Math.min(taste.artistNeg[k] || taste.artistNeg[a] || 0, WAVE_TASTE_MAX_ART) * 0.85
        s += Math.min(taste.artistPos[k] || taste.artistPos[a] || 0, WAVE_TASTE_MAX_ART) * 0.45
      })
      getMyWaveTokens(track).forEach((tok) => {
        s -= Math.min(taste.tokenNeg[tok] || 0, WAVE_TASTE_MAX_TOK) * 0.65
      })
      return s
    }

    function buildMyWavePreferenceProfile(candidates) {
      const profile = { artists: new Map(), sources: new Map(), tokens: new Map(), totalWeight: 0 }
      const bump = (map, key, score) => {
        const safeKey = String(key || '').trim().toLowerCase()
        if (!safeKey || safeKey === '—') return
        map.set(safeKey, (map.get(safeKey) || 0) + score)
      }
      candidates.forEach((item) => {
        const track = item.track || {}
        const score = Math.max(1, Number(item.weight || 1))
        profile.totalWeight += score
        getMyWaveArtistNames(track).forEach((artist, idx) => bump(profile.artists, artist, score * (idx === 0 ? 0.9 : 0.45)))
        bump(profile.sources, track.source, score * 0.6)
        getMyWaveTokens(track).forEach((token) => bump(profile.tokens, token, score * 0.65))
      })
      return profile
    }

    function getMyWavePreferenceTerms(profile, limit = 8) {
      return Array.from(profile.tokens.entries())
        .filter(([token]) => token && !MY_WAVE_TOKEN_STOPWORDS.has(token))
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([token]) => token)
    }

    function getMyWaveMoodScore(track, mode) {
      const cfg = MY_WAVE_MODES[mode] || MY_WAVE_MODES.default
      const text = `${track?.artist || ''} ${track?.title || ''}`.toLowerCase()
      const hits = (cfg.keywords || []).reduce((sum, keyword) => sum + (text.includes(keyword) ? 1 : 0), 0)
      return hits * (mode === 'default' ? 1.5 : 7)
    }

    function getMyWaveTrendScore(track, resultIndex = 0) {
      const metricKeys = [
        'popularity',
        'playback_count',
        'play_count',
        'plays',
        'stream_count',
        'favorite_count',
        'likes_count',
        'likes',
        'reposts_count',
        'reposts',
        'score',
      ]
      let score = 0
      for (const key of metricKeys) {
        const raw = Number(track?.[key])
        if (!Number.isFinite(raw) || raw <= 0) continue
        score += raw <= 100 ? Math.min(raw / 100, 1) * 10 : Math.min(Math.log10(raw + 1), 7) * 1.8
      }
      const text = `${track?.artist || ''} ${track?.title || ''}`.toLowerCase()
      const vibeWords = ['viral', 'trend', 'trending', 'tiktok', 'tik tok', 'hit', 'popular', 'vibe', 'slay', 'speed', 'sped up', 'phonk', 'вайб', 'тренд', 'хит']
      score += vibeWords.reduce((sum, word) => sum + (text.includes(word) ? 3 : 0), 0)
      score += Math.max(0, 8 - Math.min(8, Number(resultIndex) || 0))
      return Math.min(score, 28)
    }

    function getMyWaveVibeScore(track, mode) {
      const text = `${track?.artist || ''} ${track?.title || ''}`.toLowerCase()
      const vibeSets = {
        default: ['viral', 'tiktok', 'tik tok', 'hyperpop', 'phonk', 'dreamcore', 'slowed', 'reverb', 'hit', 'vibe'],
        sad: ['miss you', 'broken', 'lonely', 'mirrors', 'doll', 'babydoll', 'slowed', 'reverb', 'dreamcore', 'aesthetic', 'empty', 'pain'],
        happy: ['hyperpop', 'glitchcore', 'dance', 'party', 'summer', 'feel good', 'cute', 'bubblegum', 'vibe'],
        energetic: ['phonk', 'sigma', 'dxrk', 'murder', 'brazilian', 'drift', 'tmsts', 'gym', 'aggressive', 'rage', 'hype'],
        calm: ['lofi', 'lo-fi', 'dreamcore', 'ambient', 'soft', 'night', 'rain', 'sleep', 'chill'],
        romantic: ['love', 'miss you', 'heart', 'romantic', 'relationship', 'slowed', 'soft', 'kiss'],
      }
      const words = vibeSets[mode] || vibeSets.default
      return Math.min(words.reduce((sum, word) => sum + (text.includes(word) ? (mode === 'energetic' ? 7 : 5) : 0), 0), 24)
    }

    function getMyWaveOfficialBonus(track) {
      const text = `${track?.artist || ''} ${track?.title || ''}`.toLowerCase()
      const strong = ['official audio', 'official music video', 'original mix', 'album version', 'full version', 'official video']
      if (strong.some((w) => text.includes(w))) return 10
      if (/\bofficial\b/.test(text) && (text.includes('audio') || text.includes('video'))) return 6
      return 0
    }

    function getMyWaveQualityPenalty(track, mode) {
      const text = `${track?.artist || ''} ${track?.title || ''}`.toLowerCase()
      if (mode === 'sad' && ['slowed', 'reverb', 'acoustic', 'dreamcore'].some((word) => text.includes(word))) {
        const sec = getNormalizedTrackDurationSec(track)
        if (sec != null && sec < 40) return 28
        return 0
      }
      const noisy = [
        'nightcore', '1 hour', '8d audio', 'bass boosted', 'karaoke', 'instrumental remake',
        'speed up', 'sped up', 'speedup', 'tiktok version', 'cover by', 'cover (', ' acoustic cover',
        'fan cover', 'remake', 'snippet', 'preview only', 'short version', 'edit audio', 'tik tok',
        'минус', 'караоке', 'перепев', 'фанатск', 'mashup', 'bootleg', 'vocals only',
        'live from concert', 'на шоу', 'pitch ',
      ]
      let pen = noisy.some((word) => text.includes(word)) ? 22 : 0
      const sec = getNormalizedTrackDurationSec(track)
      if (sec != null && sec < 45) pen += 40
      else if (sec != null && sec < WAVE_MY_WAVE_MIN_DURATION_SEC) pen += 14
      return pen
    }

    function scoreMyWaveTrack(track, profile, mode, resultIndex = 0) {
      const source = String(track.source || '').trim().toLowerCase()
      const artists = getMyWaveArtistNames(track)
      let score = 0
      const artistMatch = Math.max(0, ...artists.map((artist) => profile.artists.get(artist) || 0))
      score += Math.min(artistMatch, 18) * 0.75
      score += (profile.sources.get(source) || 0) * 0.8
      getMyWaveTokens(track).forEach((token) => { score += Math.min(profile.tokens.get(token) || 0, 12) })
      score += getMyWaveMoodScore(track, mode)
      score += getMyWaveTrendScore(track, resultIndex)
      score += getMyWaveVibeScore(track, mode)
      score -= getMyWaveQualityPenalty(track, mode)
      score += getMyWaveOfficialBonus(track)
      score = applyWaveTasteToScore(track, score)
      return score
    }

    function getMyWaveExcludedSignatures() {
      const set = new Set()
      const add = (track) => {
        const sig = normalizeTrackSignature(track)
        if (sig) set.add(sig)
      }
      getMyWaveCandidates().forEach((item) => add(item.track))
      ;(getQueue() || []).forEach(add)
      const ct = getCurrentTrack()
      if (ct) add(ct)
      return set
    }

    function isMyWaveRecommendationAllowed(track, excluded, selected) {
      const safe = sanitizeTrack(track)
      if (!safe?.id && !safe?.title) return false
      const sig = normalizeTrackSignature(safe)
      if (!sig || excluded.has(sig) || selected.has(sig)) return false
      const text = `${safe.artist || ''} ${safe.title || ''}`.toLowerCase()
      if (!text.trim() || text.includes('karaoke') || text.includes('instrumental remake')) return false
      const durSec = getNormalizedTrackDurationSec(safe)
      if (durSec != null && durSec < WAVE_MY_WAVE_MIN_DURATION_SEC) return false
      return true
    }

    function getMyWaveTopArtists(seedTracks, limit = 8) {
      const counts = new Map()
      seedTracks.forEach((track, idx) => {
        getMyWaveArtistNames(track).forEach((artist, artistIdx) => {
          counts.set(artist, (counts.get(artist) || 0) + Math.max(1, 10 - idx) * (artistIdx === 0 ? 1 : 0.55))
        })
      })
      return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([artist]) => artist)
    }

    function buildMyWaveQueries(seedTracks, mode, profile) {
      const cfg = MY_WAVE_MODES[mode] || MY_WAVE_MODES.default
      const artists = getMyWaveTopArtists(seedTracks, 8)
      const seeds = seedTracks.slice(0, 10)
      const prefTerms = getMyWavePreferenceTerms(profile, 8)
      const moodTerms = (cfg.queryTerms || MY_WAVE_MODES.default.queryTerms || []).slice(0, 6)
      const trendTermsByMode = {
        default: ['viral hits', 'tiktok vibe', 'trending now', 'popular songs', 'hyperpop viral', 'phonk viral'],
        sad: ['slowed reverb popular', 'sad tiktok', 'dreamcore music', 'sad aesthetic tiktok'],
        happy: ['happy tiktok', 'hyperpop viral', 'feel good hits', 'party tiktok'],
        energetic: ['phonk viral', 'aggressive phonk', 'brazilian funk popular', 'gym phonk', 'tiktok hype'],
        calm: ['chill tiktok', 'lofi vibe', 'dreamcore chill', 'soft night'],
        romantic: ['love tiktok', 'romantic viral', 'slowed love songs', 'heartbreak love'],
      }
      const trendTerms = trendTermsByMode[mode] || trendTermsByMode.default
      const queries = []
      artists.forEach((artist, idx) => {
        const term = moodTerms[idx % moodTerms.length] || 'similar'
        queries.push(`${artist} ${term}`)
        queries.push(`${artist} ${trendTerms[idx % trendTerms.length]}`)
        if (mode === 'energetic') queries.push(`${artist} phonk viral`)
        if (mode === 'sad') queries.push(`${artist} slowed reverb popular`)
        queries.push(`${artist} similar artists`)
      })
      seeds.forEach((track, idx) => {
        const artist = String(track?.artist || '').trim()
        const term = moodTerms[idx % moodTerms.length] || 'similar'
        const token = prefTerms[idx % Math.max(1, prefTerms.length)] || ''
        if (artist && token) queries.push(`${artist} ${token} ${term}`)
        else if (artist) queries.push(`${artist} ${term}`)
      })
      prefTerms.forEach((token, idx) => {
        const term = moodTerms[idx % moodTerms.length] || 'playlist'
        queries.push(`${token} ${term}`)
      })
      moodTerms.forEach((term) => queries.push(`${term} music`))
      trendTerms.forEach((term) => queries.push(term))
      return Array.from(new Set(queries.map((q) => q.trim()).filter(Boolean))).slice(0, 28)
    }

    async function findMyWaveRecommendations(min = MY_WAVE_MIN_TRACKS, mode) {
      const modeId = MY_WAVE_MODES[mode] ? mode : 'default'
      const candidates = getMyWaveCandidates()
      const profile = buildMyWavePreferenceProfile(candidates)
      const target = Math.min(MY_WAVE_MAX_TRACKS, Math.max(MY_WAVE_MIN_TRACKS, Number(min) || MY_WAVE_MIN_TRACKS))
      const seedTracks = getMyWaveSeedTracks()
      const queries = buildMyWaveQueries(seedTracks, modeId, profile)
      const excluded = getMyWaveExcludedSignatures()
      const selected = new Set()
      const selectedArtists = new Map()
      const found = []
      const settings = getSettings()
      const sourceModeRaw = String(getMyWaveSource() || 'hybrid').toLowerCase()
      const sourceMode = sourceModeRaw === 'vk' || sourceModeRaw === 'yandex' ? sourceModeRaw : 'hybrid'
      const searchByWaveSource = async (query) => {
        if (sourceMode === 'hybrid') {
          const hybrid = await searchHybridTracks(query, settings)
          return sanitizeTrackList(hybrid?.tracks || [])
        }
        const scopedSettings = Object.assign({}, settings, { activeSource: sourceMode })
        const direct = await searchTracksDirect(query, scopedSettings)
        return sanitizeTrackList(Array.isArray(direct) ? direct : [])
      }
      for (const query of queries) {
        if (found.length >= target) break
        let results = []
        try {
          results = await searchByWaveSource(query)
        } catch { /* ignore */ }
        const ranked = results
          .map((track) => sanitizeTrack(track))
          .map((track, idx) => ({ track, idx }))
          .filter(({ track }) => isMyWaveRecommendationAllowed(track, excluded, selected))
          .map(({ track, idx }) => ({ track, score: scoreMyWaveTrack(track, profile, modeId, idx) }))
          .sort((a, b) => b.score - a.score)
        let pickedFromQuery = 0
        for (const { track } of ranked) {
          const artist = getMyWavePrimaryArtist(track)
          const artistCount = selectedArtists.get(artist) || 0
          if (artist && artistCount >= 2 && found.length < target - 4) continue
          const sig = normalizeTrackSignature(track)
          selected.add(sig)
          if (artist) selectedArtists.set(artist, artistCount + 1)
          found.push(track)
          pickedFromQuery += 1
          if (pickedFromQuery >= 3 || found.length >= target) break
        }
      }
      return found.slice(0, target)
    }

    return {
      findMyWaveRecommendations,
      getMyWaveSeedTracks,
      recordWaveEarlySkip,
      recordWavePositiveListen,
    }
  }

  global.FlowModules = global.FlowModules || {}
  global.FlowModules.waveEngine = {
    createWaveEngine,
    MY_WAVE_MIN_TRACKS,
    MY_WAVE_MAX_TRACKS,
    MY_WAVE_MODES,
    MY_WAVE_TOKEN_STOPWORDS,
    WAVE_EARLY_SKIP_SEC: 14,
  }
})(typeof window !== 'undefined' ? window : globalThis)
