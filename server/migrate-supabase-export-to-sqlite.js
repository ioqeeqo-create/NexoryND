#!/usr/bin/env node
/**
 * One-off migration helper:
 * Supabase table exports (JSON/CSV) -> local Flow social SQLite.
 *
 * Usage:
 *   npm run social-migrate -- --input ./supabase-export --db ./data/flow-social.sqlite
 * На VPS после импорта перезапуск не обязателен; файл БД задаёт FLOW_SOCIAL_DB_PATH.
 */

const fs = require('fs')
const path = require('path')
const Database = require('better-sqlite3')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'
    out[key] = value
  }
  return out
}

function ensureDir(p) {
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
    throw new Error(`Input directory not found: ${p}`)
  }
}

function listFiles(p) {
  return fs.readdirSync(p).map((n) => path.join(p, n))
}

function tableCandidates(table) {
  return [
    `${table}.json`,
    `${table}.csv`,
    `${table}.ndjson`,
    `${table}_export.json`,
    `${table}_export.csv`,
    `public.${table}.json`,
    `public.${table}.csv`,
  ]
}

function pickInputFile(inputDir, table) {
  const names = new Set(listFiles(inputDir).map((f) => path.basename(f).toLowerCase()))
  const candidates = tableCandidates(table)
  for (const c of candidates) {
    if (names.has(c.toLowerCase())) return path.join(inputDir, c)
  }
  return null
}

function parseJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').trim()
  if (!raw) return []
  if (raw.startsWith('[')) {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  }
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function parseCsvLine(line) {
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        cur += ch
      }
      continue
    }
    if (ch === '"') {
      quoted = true
      continue
    }
    if (ch === ',') {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out
}

function parseCsvFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8')
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0)
  if (!lines.length) return []
  const header = parseCsvLine(lines[0]).map((h) => h.trim())
  const rows = []
  for (let i = 1; i < lines.length; i += 1) {
    const parts = parseCsvLine(lines[i])
    const row = {}
    for (let j = 0; j < header.length; j += 1) row[header[j]] = parts[j] ?? ''
    rows.push(row)
  }
  return rows
}

function loadRows(inputDir, table) {
  const file = pickInputFile(inputDir, table)
  if (!file) return { file: null, rows: [] }
  const ext = path.extname(file).toLowerCase()
  let rows = []
  if (ext === '.json' || ext === '.ndjson') rows = parseJsonFile(file)
  else if (ext === '.csv') rows = parseCsvFile(file)
  else throw new Error(`Unsupported format: ${file}`)
  return { file, rows: Array.isArray(rows) ? rows : [] }
}

function asInt(v, fallback = 0) {
  if (v === null || v === undefined || v === '') return fallback
  if (typeof v === 'boolean') return v ? 1 : 0
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

function asText(v, fallback = null) {
  if (v === undefined || v === null || v === '') return fallback
  return String(v)
}

function asJsonText(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch (_) {
    return fallback
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS flow_profiles (
  username TEXT PRIMARY KEY,
  password_hash TEXT,
  password_salt TEXT,
  online INTEGER NOT NULL DEFAULT 0,
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  avatar_data TEXT,
  banner_data TEXT,
  profile_color TEXT,
  bio TEXT NOT NULL DEFAULT '',
  pinned_tracks TEXT NOT NULL DEFAULT '[]',
  pinned_playlists TEXT NOT NULL DEFAULT '[]',
  total_tracks INTEGER NOT NULL DEFAULT 0,
  total_seconds INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS flow_friends (
  owner_username TEXT NOT NULL,
  friend_username TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_username, friend_username)
);

CREATE TABLE IF NOT EXISTS flow_friend_requests (
  from_username TEXT NOT NULL,
  to_username TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (from_username, to_username)
);

CREATE TABLE IF NOT EXISTS flow_rooms (
  room_id TEXT PRIMARY KEY,
  host_peer_id TEXT NOT NULL,
  shared_queue TEXT NOT NULL DEFAULT '[]',
  now_playing TEXT,
  playback_state TEXT NOT NULL DEFAULT '{}',
  playback_ts INTEGER NOT NULL DEFAULT 0,
  updated_by_peer_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS flow_room_members (
  room_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  username TEXT NOT NULL,
  profile TEXT NOT NULL DEFAULT '{}',
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (room_id, peer_id)
);
`.trim()

function main() {
  const args = parseArgs(process.argv.slice(2))
  const inputDir = path.resolve(process.cwd(), args.input || args.i || '')
  const dbPath = path.resolve(process.cwd(), args.db || args.d || path.join('data', 'flow-social.sqlite'))
  const dryRun = args['dry-run'] === 'true'

  if (!args.input && !args.i) {
    throw new Error('Missing --input <dir> with exported tables')
  }
  ensureDir(inputDir)
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA_SQL)

  const tables = [
    'flow_profiles',
    'flow_friends',
    'flow_friend_requests',
    'flow_rooms',
    'flow_room_members',
  ]

  const loaded = {}
  for (const t of tables) loaded[t] = loadRows(inputDir, t)

  const upsertProfile = db.prepare(`
    INSERT INTO flow_profiles (
      username,password_hash,password_salt,online,last_seen,avatar_data,banner_data,profile_color,bio,pinned_tracks,pinned_playlists,total_tracks,total_seconds
    ) VALUES (
      @username,@password_hash,@password_salt,@online,@last_seen,@avatar_data,@banner_data,@profile_color,@bio,@pinned_tracks,@pinned_playlists,@total_tracks,@total_seconds
    )
    ON CONFLICT(username) DO UPDATE SET
      password_hash=excluded.password_hash,
      password_salt=excluded.password_salt,
      online=excluded.online,
      last_seen=excluded.last_seen,
      avatar_data=excluded.avatar_data,
      banner_data=excluded.banner_data,
      profile_color=excluded.profile_color,
      bio=excluded.bio,
      pinned_tracks=excluded.pinned_tracks,
      pinned_playlists=excluded.pinned_playlists,
      total_tracks=excluded.total_tracks,
      total_seconds=excluded.total_seconds
  `)
  const upsertFriend = db.prepare(`
    INSERT INTO flow_friends (owner_username,friend_username,created_at)
    VALUES (@owner_username,@friend_username,@created_at)
    ON CONFLICT(owner_username,friend_username) DO UPDATE SET created_at=excluded.created_at
  `)
  const upsertRequest = db.prepare(`
    INSERT INTO flow_friend_requests (from_username,to_username,status,updated_at,created_at)
    VALUES (@from_username,@to_username,@status,@updated_at,@created_at)
    ON CONFLICT(from_username,to_username) DO UPDATE SET
      status=excluded.status, updated_at=excluded.updated_at, created_at=excluded.created_at
  `)
  const upsertRoom = db.prepare(`
    INSERT INTO flow_rooms (room_id,host_peer_id,shared_queue,now_playing,playback_state,playback_ts,updated_by_peer_id,updated_at)
    VALUES (@room_id,@host_peer_id,@shared_queue,@now_playing,@playback_state,@playback_ts,@updated_by_peer_id,@updated_at)
    ON CONFLICT(room_id) DO UPDATE SET
      host_peer_id=excluded.host_peer_id,
      shared_queue=excluded.shared_queue,
      now_playing=excluded.now_playing,
      playback_state=excluded.playback_state,
      playback_ts=excluded.playback_ts,
      updated_by_peer_id=excluded.updated_by_peer_id,
      updated_at=excluded.updated_at
  `)
  const upsertMember = db.prepare(`
    INSERT INTO flow_room_members (room_id,peer_id,username,profile,last_seen)
    VALUES (@room_id,@peer_id,@username,@profile,@last_seen)
    ON CONFLICT(room_id,peer_id) DO UPDATE SET
      username=excluded.username, profile=excluded.profile, last_seen=excluded.last_seen
  `)

  const stats = { flow_profiles: 0, flow_friends: 0, flow_friend_requests: 0, flow_rooms: 0, flow_room_members: 0 }
  const run = db.transaction(() => {
    for (const row of loaded.flow_profiles.rows) {
      const username = asText(row.username, '').trim().toLowerCase()
      if (!username) continue
      upsertProfile.run({
        username,
        password_hash: asText(row.password_hash, null),
        password_salt: asText(row.password_salt, null),
        online: asInt(row.online, 0) ? 1 : 0,
        last_seen: asText(row.last_seen, new Date().toISOString()),
        avatar_data: asText(row.avatar_data, null),
        banner_data: asText(row.banner_data, null),
        profile_color: asText(row.profile_color, null),
        bio: asText(row.bio, '') || '',
        pinned_tracks: asJsonText(row.pinned_tracks, '[]'),
        pinned_playlists: asJsonText(row.pinned_playlists, '[]'),
        total_tracks: asInt(row.total_tracks, 0),
        total_seconds: asInt(row.total_seconds, 0),
      })
      stats.flow_profiles += 1
    }
    for (const row of loaded.flow_friends.rows) {
      const owner_username = asText(row.owner_username, '').trim().toLowerCase()
      const friend_username = asText(row.friend_username, '').trim().toLowerCase()
      if (!owner_username || !friend_username || owner_username === friend_username) continue
      upsertFriend.run({
        owner_username,
        friend_username,
        created_at: asText(row.created_at, new Date().toISOString()),
      })
      stats.flow_friends += 1
    }
    for (const row of loaded.flow_friend_requests.rows) {
      const from_username = asText(row.from_username, '').trim().toLowerCase()
      const to_username = asText(row.to_username, '').trim().toLowerCase()
      if (!from_username || !to_username || from_username === to_username) continue
      upsertRequest.run({
        from_username,
        to_username,
        status: asText(row.status, 'pending'),
        updated_at: asText(row.updated_at, new Date().toISOString()),
        created_at: asText(row.created_at, new Date().toISOString()),
      })
      stats.flow_friend_requests += 1
    }
    for (const row of loaded.flow_rooms.rows) {
      const room_id = asText(row.room_id, '').trim()
      if (!room_id) continue
      upsertRoom.run({
        room_id,
        host_peer_id: asText(row.host_peer_id, room_id),
        shared_queue: asJsonText(row.shared_queue, '[]'),
        now_playing: asJsonText(row.now_playing, null),
        playback_state: asJsonText(row.playback_state, '{}'),
        playback_ts: asInt(row.playback_ts, 0),
        updated_by_peer_id: asText(row.updated_by_peer_id, null),
        updated_at: asText(row.updated_at, new Date().toISOString()),
      })
      stats.flow_rooms += 1
    }
    for (const row of loaded.flow_room_members.rows) {
      const room_id = asText(row.room_id, '').trim()
      const peer_id = asText(row.peer_id, '').trim()
      const username = asText(row.username, '').trim().toLowerCase()
      if (!room_id || !peer_id || !username) continue
      upsertMember.run({
        room_id,
        peer_id,
        username,
        profile: asJsonText(row.profile, '{}'),
        last_seen: asText(row.last_seen, new Date().toISOString()),
      })
      stats.flow_room_members += 1
    }
  })

  if (dryRun) {
    console.log('[dry-run] Parsed files:')
    for (const t of tables) {
      const src = loaded[t].file ? path.basename(loaded[t].file) : '(missing)'
      console.log(`  ${t}: ${loaded[t].rows.length} rows from ${src}`)
    }
    db.close()
    return
  }

  run()
  db.close()

  console.log('Migration complete.')
  for (const t of tables) {
    const src = loaded[t].file ? path.basename(loaded[t].file) : '(missing)'
    console.log(`  ${t}: imported ${stats[t]} rows (source: ${src})`)
  }
  console.log(`SQLite: ${dbPath}`)
}

try {
  main()
} catch (err) {
  console.error(`[migrate] ${err && err.message ? err.message : err}`)
  process.exit(1)
}
