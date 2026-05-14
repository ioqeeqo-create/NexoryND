/**
 * Nexory Social — свой бэкенд вместо Supabase (SQLite + REST + WebSocket).
 *
 * Локально:
 *   FLOW_SOCIAL_SECRET=... npm run social-server
 *
 * На VPS (корень репо = /opt/flow, как на сервере):
 *   1) git pull (этот файл должен лежать в server/flow-social-server.js)
 *   2) npm install
 *   3) задать env: FLOW_SOCIAL_SECRET, опционально FLOW_SOCIAL_PORT, FLOW_SOCIAL_DB_PATH
 *   4) systemd ExecStart: /usr/bin/node /opt/flow/server/flow-social-server.js
 *   5) без домена: в клиенте flowSocialApiBase = http://<IP>:3847
 *   6) см. docs/FLOW_SOCIAL_DEPLOY.md
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const express = require('express')
const cors = require('cors')
const Database = require('better-sqlite3')
const { WebSocketServer } = require('ws')

const PORT = Number(process.env.FLOW_SOCIAL_PORT || process.env.PORT || 3847)
const SECRET = String(process.env.FLOW_SOCIAL_SECRET || '').trim()
const DB_PATH = process.env.FLOW_SOCIAL_DB_PATH || path.join(__dirname, '..', 'data', 'flow-social.sqlite')

if (!SECRET) {
  console.error('[flow-social-server] Задайте FLOW_SOCIAL_SECRET (длинная случайная строка)')
  process.exit(1)
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

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

CREATE INDEX IF NOT EXISTS idx_flow_friends_owner ON flow_friends(owner_username);
CREATE INDEX IF NOT EXISTS idx_flow_friends_friend ON flow_friends(friend_username);
CREATE INDEX IF NOT EXISTS idx_flow_friend_requests_to ON flow_friend_requests(to_username, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_flow_room_members_room_seen ON flow_room_members(room_id, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_flow_rooms_updated_at ON flow_rooms(updated_at DESC);
`.trim()

db.exec(SCHEMA_SQL)

function rowProfile(r) {
  if (!r) return null
  let pinned_tracks = []
  let pinned_playlists = []
  try { pinned_tracks = JSON.parse(r.pinned_tracks || '[]') } catch (_) {}
  try { pinned_playlists = JSON.parse(r.pinned_playlists || '[]') } catch (_) {}
  return {
    username: r.username,
    password_hash: r.password_hash,
    password_salt: r.password_salt,
    online: !!r.online,
    last_seen: r.last_seen,
    avatar_data: r.avatar_data,
    banner_data: r.banner_data,
    profile_color: r.profile_color,
    bio: r.bio,
    pinned_tracks,
    pinned_playlists,
    total_tracks: r.total_tracks,
    total_seconds: r.total_seconds,
  }
}

function rowRoom(r) {
  if (!r) return null
  let shared_queue = []
  let now_playing = null
  let playback_state = {}
  try { shared_queue = JSON.parse(r.shared_queue || '[]') } catch (_) {}
  try { now_playing = r.now_playing ? JSON.parse(r.now_playing) : null } catch { now_playing = null }
  try { playback_state = JSON.parse(r.playback_state || '{}') } catch (_) {}
  return {
    room_id: r.room_id,
    host_peer_id: r.host_peer_id,
    shared_queue,
    now_playing,
    playback_state,
    playback_ts: r.playback_ts,
    updated_by_peer_id: r.updated_by_peer_id,
    updated_at: r.updated_at,
  }
}

function parseAnyDateMs(value) {
  const ms = Date.parse(String(value || ''))
  return Number.isFinite(ms) ? ms : null
}

function isFreshIso(value, freshMs = 180000) {
  const ms = parseAnyDateMs(value)
  if (!Number.isFinite(ms)) return false
  return (Date.now() - ms) <= Math.max(15000, Number(freshMs || 0))
}

function roomHasMember(roomId, peerId) {
  if (!roomId || !peerId) return false
  const r = db.prepare(
    'SELECT 1 AS ok FROM flow_room_members WHERE room_id=? AND peer_id=? LIMIT 1'
  ).get(String(roomId), String(peerId))
  return !!r?.ok
}

function electRoomHost(roomId, opts = {}) {
  const rid = String(roomId || '').trim()
  if (!rid) return null
  const room = db.prepare('SELECT * FROM flow_rooms WHERE room_id=?').get(rid)
  if (!room) return null
  const members = db.prepare(
    'SELECT peer_id,last_seen FROM flow_room_members WHERE room_id=? ORDER BY last_seen DESC'
  ).all(rid)
  if (!members.length) return null
  const currentHost = String(room.host_peer_id || '').trim()
  if (currentHost && members.some((m) => String(m.peer_id || '') === currentHost)) {
    return currentHost
  }
  const elected = String(members[0]?.peer_id || '').trim()
  if (!elected) return null
  db.prepare(
    `UPDATE flow_rooms
      SET host_peer_id=?,
          updated_by_peer_id=?,
          updated_at=?,
          playback_ts=?
      WHERE room_id=?`
  ).run(
    elected,
    String(opts.updatedBy || 'server-election'),
    new Date().toISOString(),
    Date.now(),
    rid
  )
  return elected
}

/** --- WebSocket hubs --- */
const app = express()
app.use(cors({ origin: true }))
app.use(express.json({ limit: '64mb' }))

function bearerAuth(req, res, next) {
  const h = req.headers.authorization || ''
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : ''
  if (token !== SECRET) return res.status(401).json({ error: 'unauthorized' })
  next()
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'flow-social-server' }))
app.get('/flow-api/v1/health', (_req, res) => res.json({ ok: true, service: 'flow-social-v1' }))

/** Profiles */
app.get('/flow-api/v1/profile-public/:username', bearerAuth, (req, res) => {
  const username = String(req.params.username || '').trim().toLowerCase()
  if (!username) return res.status(400).json({ error: 'bad username' })
  const r = db.prepare('SELECT * FROM flow_profiles WHERE username = ?').get(username)
  if (!r) return res.status(404).json({ error: 'not_found' })
  const row = rowProfile(r)
  delete row.password_hash
  delete row.password_salt
  res.json(row)
})

/** Для входа приложение уже само проверяет хеш — отдаём соль и hash как в Supabase. */
app.get('/flow-api/v1/profile-auth/:username', bearerAuth, (req, res) => {
  const username = String(req.params.username || '').trim().toLowerCase()
  const r = db.prepare(
    'SELECT username,password_hash,password_salt FROM flow_profiles WHERE username = ?'
  ).get(username)
  if (!r) return res.status(404).json({ error: 'not_found' })
  res.json({ username: r.username, password_hash: r.password_hash, password_salt: r.password_salt })
})

app.put('/flow-api/v1/profile', bearerAuth, (req, res) => {
  const b = req.body || {}
  const username = String(b.username || '').trim().toLowerCase()
  if (!username) return res.status(400).json({ error: 'username required' })
  const existing = db.prepare('SELECT username FROM flow_profiles WHERE username=?').get(username)
  const payload = {
    username,
    password_hash: b.password_hash != null ? String(b.password_hash) : existing ? undefined : null,
    password_salt: b.password_salt != null ? String(b.password_salt) : existing ? undefined : null,
    online: b.online !== undefined ? (b.online ? 1 : 0) : 0,
    last_seen: b.last_seen || new Date().toISOString(),
    avatar_data: b.avatar_data ?? null,
    banner_data: b.banner_data ?? null,
    profile_color: b.profile_color ?? null,
    bio: typeof b.bio === 'string' ? b.bio : '',
    pinned_tracks: JSON.stringify(Array.isArray(b.pinned_tracks) ? b.pinned_tracks : []),
    pinned_playlists: JSON.stringify(Array.isArray(b.pinned_playlists) ? b.pinned_playlists : []),
    total_tracks: Number.isFinite(Number(b.total_tracks)) ? Number(b.total_tracks) : 0,
    total_seconds: Number.isFinite(Number(b.total_seconds)) ? Number(b.total_seconds) : 0,
  }
  // upsert без перетирания пароля если не передан
  if (existing) {
    const prev = db.prepare(
      'SELECT password_hash,password_salt FROM flow_profiles WHERE username=?'
    ).get(username)
    if (payload.password_hash === undefined) payload.password_hash = prev.password_hash
    if (payload.password_salt === undefined) payload.password_salt = prev.password_salt
    db.prepare(`UPDATE flow_profiles SET
      password_hash=@password_hash,
      password_salt=@password_salt,
      online=@online,
      last_seen=@last_seen,
      avatar_data=@avatar_data,
      banner_data=@banner_data,
      profile_color=@profile_color,
      bio=@bio,
      pinned_tracks=@pinned_tracks,
      pinned_playlists=@pinned_playlists,
      total_tracks=@total_tracks,
      total_seconds=@total_seconds
    WHERE username=@username`).run(payload)
  } else {
    db.prepare(`INSERT INTO flow_profiles (
      username,password_hash,password_salt,online,last_seen,avatar_data,banner_data,profile_color,bio,pinned_tracks,pinned_playlists,total_tracks,total_seconds
    ) VALUES (
      @username,@password_hash,@password_salt,@online,@last_seen,@avatar_data,@banner_data,@profile_color,@bio,@pinned_tracks,@pinned_playlists,@total_tracks,@total_seconds
    )`).run(payload)
  }
  const r = db.prepare('SELECT * FROM flow_profiles WHERE username=?').get(username)
  wsBroadcastProfilesRow(r)
  res.json({ ok: true })
})

/** Миграция «старый аккаунт без пароля»: выставить пароль только если hash ещё NULL. */
app.patch('/flow-api/v1/profile-password', bearerAuth, (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase()
  const password_hash = String(req.body?.password_hash || '')
  const password_salt = String(req.body?.password_salt || '')
  if (!username || !password_hash || !password_salt) return res.status(400).json({ error: 'bad body' })
  const cur = db.prepare('SELECT password_hash FROM flow_profiles WHERE username=?').get(username)
  if (!cur) return res.status(404).json({ error: 'not_found' })
  if (cur.password_hash != null && String(cur.password_hash).length) {
    return res.status(409).json({ error: 'already_has_password' })
  }
  db.prepare(
    `UPDATE flow_profiles SET password_hash=?, password_salt=?, last_seen=datetime('now'), online=1 WHERE username=?`
  ).run(password_hash, password_salt, username)
  const r = db.prepare('SELECT * FROM flow_profiles WHERE username=?').get(username)
  wsBroadcastProfilesRow(r)
  res.json({ ok: true })
})

/** Friends */
app.get('/flow-api/v1/friends/:owner', bearerAuth, (req, res) => {
  const owner = String(req.params.owner || '').trim().toLowerCase()
  const rows = db.prepare(
    `WITH friend_set AS (
      SELECT friend_username AS username, created_at FROM flow_friends WHERE owner_username = ?
      UNION ALL
      SELECT owner_username AS username, created_at FROM flow_friends WHERE friend_username = ?
    )
    SELECT username AS friend_username, MAX(created_at) AS created_at
    FROM friend_set
    WHERE username IS NOT NULL AND username <> ''
    GROUP BY username
    ORDER BY created_at DESC`
  ).all(owner, owner)
  res.json(rows)
})

app.put('/flow-api/v1/friends/pair', bearerAuth, (req, res) => {
  const a = String(req.body?.owner_username || '').trim().toLowerCase()
  const b = String(req.body?.friend_username || '').trim().toLowerCase()
  if (!a || !b || a === b) return res.status(400).json({ error: 'bad pair' })
  const ins = db.prepare(
    'INSERT OR REPLACE INTO flow_friends (owner_username,friend_username) VALUES (?,?)'
  )
  ins.run(a, b)
  ins.run(b, a)
  res.json({ ok: true })
})

app.delete('/flow-api/v1/friends/pair', bearerAuth, (req, res) => {
  const a = String(req.query.owner_username || '').trim().toLowerCase()
  const b = String(req.query.friend_username || '').trim().toLowerCase()
  if (!a || !b) return res.status(400).json({ error: 'bad query' })
  db.prepare(
    'DELETE FROM flow_friends WHERE owner_username=? AND friend_username=?'
  ).run(a, b)
  db.prepare(
    'DELETE FROM flow_friends WHERE owner_username=? AND friend_username=?'
  ).run(b, a)
  res.json({ ok: true })
})

/** Friend requests */
app.post('/flow-api/v1/friend-requests', bearerAuth, (req, res) => {
  const from_username = String(req.body?.from_username || '').trim().toLowerCase()
  const to_username = String(req.body?.to_username || '').trim().toLowerCase()
  const status = String(req.body?.status || 'pending')
  if (!from_username || !to_username || from_username === to_username) {
    return res.status(400).json({ error: 'bad request' })
  }
  db.prepare(
    `INSERT INTO flow_friend_requests (from_username,to_username,status,updated_at)
    VALUES (?,?,?,datetime('now'))
    ON CONFLICT(from_username,to_username) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`
  ).run(from_username, to_username, status)
  res.json({ ok: true })
})

app.get('/flow-api/v1/friend-requests/incoming/:username', bearerAuth, (req, res) => {
  const to = String(req.params.username || '').trim().toLowerCase()
  const rows = db.prepare(
    `SELECT from_username,to_username,status,updated_at FROM flow_friend_requests
    WHERE to_username=? AND status='pending' ORDER BY updated_at DESC`
  ).all(to)
  res.json(rows)
})

app.patch('/flow-api/v1/friend-requests', bearerAuth, (req, res) => {
  const from = String(req.body?.from_username || '').trim().toLowerCase()
  const to = String(req.body?.to_username || '').trim().toLowerCase()
  const status = String(req.body?.status || '')
  if (!from || !to || !['accepted', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'bad body' })
  }
  db.prepare(`UPDATE flow_friend_requests SET status=?, updated_at=datetime('now')
    WHERE from_username=? AND to_username=? AND status='pending'`).run(status, from, to)
  if (status === 'accepted') {
    db.prepare(
      `INSERT OR REPLACE INTO flow_friends (owner_username,friend_username,created_at)
       VALUES (?,?,datetime('now'))`
    ).run(from, to)
    db.prepare(
      `INSERT OR REPLACE INTO flow_friends (owner_username,friend_username,created_at)
       VALUES (?,?,datetime('now'))`
    ).run(to, from)
  }
  res.json({ ok: true })
})

/** Rooms */
app.get('/flow-api/v1/rooms/:roomId', bearerAuth, (req, res) => {
  const roomId = String(req.params.roomId || '').trim()
  const r = db.prepare('SELECT * FROM flow_rooms WHERE room_id=?').get(roomId)
  if (!r) return res.status(404).json({ error: 'not_found' })
  res.json(rowRoom(r))
})

app.put('/flow-api/v1/rooms', bearerAuth, (req, res) => {
  const b = req.body || {}
  const room_id = String(b.room_id || '').trim()
  if (!room_id) return res.status(400).json({ error: 'room_id required' })
  const existing = db.prepare('SELECT * FROM flow_rooms WHERE room_id=?').get(room_id)
  const host_peer_id = String(b.host_peer_id || '').trim()
  const shared_queue = JSON.stringify(Array.isArray(b.shared_queue) ? b.shared_queue : [])
  const now_playing = b.now_playing != null ? JSON.stringify(b.now_playing) : null
  const playback_state = JSON.stringify(
    typeof b.playback_state === 'object' && b.playback_state ? b.playback_state : {}
  )
  const playback_ts = Number.isFinite(Number(b.playback_ts)) ? Number(b.playback_ts) : 0
  const updated_by_peer_id = b.updated_by_peer_id ? String(b.updated_by_peer_id) : null
  const updated_at = b.updated_at || new Date().toISOString()
  const hasQueuePatch =
    Object.prototype.hasOwnProperty.call(b, 'shared_queue') ||
    Object.prototype.hasOwnProperty.call(b, 'now_playing') ||
    Object.prototype.hasOwnProperty.call(b, 'playback_state') ||
    Object.prototype.hasOwnProperty.call(b, 'playback_ts')

  if (existing && existing.host_peer_id && updated_by_peer_id && updated_by_peer_id !== existing.host_peer_id) {
    if (host_peer_id && host_peer_id !== existing.host_peer_id) {
      return res.status(409).json({ error: 'host_transfer_required', host_peer_id: existing.host_peer_id })
    }
    if (hasQueuePatch) {
      return res.status(409).json({ error: 'not_host', host_peer_id: existing.host_peer_id })
    }
  }

  if (existing && playback_ts > 0 && Number(existing.playback_ts || 0) > playback_ts) {
    return res.status(409).json({ error: 'stale_state', server_playback_ts: Number(existing.playback_ts || 0) })
  }

  db.prepare(`INSERT INTO flow_rooms (
    room_id,host_peer_id,shared_queue,now_playing,playback_state,playback_ts,updated_by_peer_id,updated_at
  ) VALUES (?,?,?,?,?,?,?,?)
  ON CONFLICT(room_id) DO UPDATE SET
    host_peer_id = COALESCE(excluded.host_peer_id, flow_rooms.host_peer_id),
    shared_queue = COALESCE(excluded.shared_queue, flow_rooms.shared_queue),
    now_playing = CASE WHEN excluded.now_playing IS NOT NULL THEN excluded.now_playing ELSE flow_rooms.now_playing END,
    playback_state = COALESCE(excluded.playback_state, flow_rooms.playback_state),
    playback_ts = CASE WHEN excluded.playback_ts > 0 THEN excluded.playback_ts ELSE flow_rooms.playback_ts END,
    updated_by_peer_id = excluded.updated_by_peer_id,
    updated_at = excluded.updated_at
  `).run(
    room_id,
    host_peer_id || room_id,
    shared_queue,
    now_playing,
    playback_state,
    playback_ts,
    updated_by_peer_id,
    updated_at
  )
  const rr = db.prepare('SELECT * FROM flow_rooms WHERE room_id=?').get(room_id)
  wsBroadcastRoomTick(room_id)
  res.json({ ok: true })
})

app.post('/flow-api/v1/rooms/:roomId/transfer-host', bearerAuth, (req, res) => {
  const roomId = String(req.params.roomId || '').trim()
  const to_peer_id = String(req.body?.to_peer_id || '').trim()
  const requested_by_peer_id = String(req.body?.requested_by_peer_id || '').trim()
  if (!roomId || !to_peer_id || !requested_by_peer_id) {
    return res.status(400).json({ error: 'bad body' })
  }
  const room = db.prepare('SELECT * FROM flow_rooms WHERE room_id=?').get(roomId)
  if (!room) return res.status(404).json({ error: 'not_found' })
  if (String(room.host_peer_id || '').trim() !== requested_by_peer_id) {
    return res.status(403).json({ error: 'only_host_can_transfer', host_peer_id: room.host_peer_id || null })
  }
  if (!roomHasMember(roomId, to_peer_id)) {
    return res.status(404).json({ error: 'target_not_in_room' })
  }
  db.prepare(
    `UPDATE flow_rooms
      SET host_peer_id=?,
          updated_by_peer_id=?,
          updated_at=?,
          playback_ts=?
      WHERE room_id=?`
  ).run(to_peer_id, requested_by_peer_id, new Date().toISOString(), Date.now(), roomId)
  wsBroadcastRoomTick(roomId)
  res.json({ ok: true, host_peer_id: to_peer_id })
})

app.put('/flow-api/v1/room-members', bearerAuth, (req, res) => {
  const b = req.body || {}
  const room_id = String(b.room_id || '').trim()
  const peer_id = String(b.peer_id || '').trim()
  const username = String(b.username || '').trim().toLowerCase()
  const profileJson = JSON.stringify(typeof b.profile === 'object' && b.profile ? b.profile : {})
  const last_seen = b.last_seen || new Date().toISOString()
  if (!room_id || !peer_id || !username) return res.status(400).json({ error: 'bad body' })
  db.prepare(`INSERT INTO flow_room_members (room_id,peer_id,username,profile,last_seen)
    VALUES (?,?,?,?,?)
    ON CONFLICT(room_id,peer_id) DO UPDATE SET username=excluded.username, profile=excluded.profile, last_seen=excluded.last_seen
  `).run(room_id, peer_id, username, profileJson, last_seen)
  const elected = electRoomHost(room_id, { updatedBy: 'server-join' })
  wsBroadcastRoomTick(room_id)
  res.json({ ok: true, host_peer_id: elected || null })
})

app.delete('/flow-api/v1/room-members', bearerAuth, (req, res) => {
  const room_id = String(req.query.room_id || '').trim()
  const peer_id = String(req.query.peer_id || '').trim()
  if (!room_id || !peer_id) return res.status(400).json({ error: 'bad query' })
  db.prepare('DELETE FROM flow_room_members WHERE room_id=? AND peer_id=?').run(room_id, peer_id)
  const elected = electRoomHost(room_id, { updatedBy: 'server-leave' })
  wsBroadcastRoomTick(room_id)
  res.json({ ok: true, host_peer_id: elected || null })
})

app.get('/flow-api/v1/room-members/:roomId', bearerAuth, (req, res) => {
  const roomId = String(req.params.roomId || '').trim()
  const since = String(req.query.since || '').trim()
  let q = 'SELECT peer_id,username,profile,last_seen FROM flow_room_members WHERE room_id=?'
  const params = [roomId]
  if (since) {
    q += ' AND last_seen >= ?'
    params.push(since)
  }
  q += ' ORDER BY last_seen DESC'
  const rows = db.prepare(q).all(...params)
  rows.forEach((r) => {
    try {
      r.profile = JSON.parse(r.profile || '{}')
    } catch {
      r.profile = {}
    }
  })
  res.json(rows)
})

app.get('/flow-api/v1/presence/friends/:owner', bearerAuth, (req, res) => {
  const owner = String(req.params.owner || '').trim().toLowerCase()
  if (!owner) return res.status(400).json({ error: 'bad owner' })
  const rows = db.prepare(
    `WITH friend_set AS (
      SELECT friend_username AS username FROM flow_friends WHERE owner_username = ?
      UNION
      SELECT owner_username AS username FROM flow_friends WHERE friend_username = ?
    )
    SELECT
      fs.username AS username,
      p.online AS online,
      p.last_seen AS last_seen,
      (
        SELECT rm.room_id
        FROM flow_room_members rm
        WHERE rm.username = fs.username
          AND rm.last_seen >= datetime('now', '-180 seconds')
        ORDER BY rm.last_seen DESC
        LIMIT 1
      ) AS room_id,
      (
        SELECT rm.peer_id
        FROM flow_room_members rm
        WHERE rm.username = fs.username
          AND rm.last_seen >= datetime('now', '-180 seconds')
        ORDER BY rm.last_seen DESC
        LIMIT 1
      ) AS peer_id
    FROM friend_set fs
    LEFT JOIN flow_profiles p ON p.username = fs.username
    WHERE fs.username IS NOT NULL AND fs.username <> ''
    ORDER BY fs.username ASC`
  ).all(owner, owner)

  const out = rows.map((r) => {
    const onlineFlag = Number(r?.online || 0) === 1
    const seen = String(r?.last_seen || '')
    const online = onlineFlag || isFreshIso(seen, 180000)
    return {
      username: String(r?.username || '').trim().toLowerCase(),
      online,
      online_raw: onlineFlag,
      last_seen: seen || null,
      room_id: r?.room_id ? String(r.room_id) : null,
      peer_id: r?.peer_id ? String(r.peer_id) : null,
    }
  }).filter((r) => !!r.username)
  res.json(out)
})

/** --- WS --- */
const server = http.createServer(app)

const sockets = new Set()
/** @type {WeakMap<object, { authed?: boolean peer_id?: string, username?: string, topics?: Set<string> }>} */

function wsClientsByPeerId(peerId) {
  const targets = []
  sockets.forEach((ws) => {
    const meta = ws.__flowSocial
    if (meta?.authed && meta.peer_id === peerId) targets.push(ws)
  })
  return targets
}

function wsSubscribe(ws, topics) {
  const meta = ws.__flowSocial
  if (!meta) return
  if (!meta.topics) meta.topics = new Set()
  ;(topics || []).forEach((t) => {
    const s = String(t || '').trim()
    if (s) meta.topics.add(s)
  })
}

function sendToTopic(topic, envelope) {
  const raw = JSON.stringify(envelope)
  const t = String(topic || '').trim()
  if (!t) return
  sockets.forEach((ws) => {
    if (ws.readyState !== 1) return
    const meta = ws.__flowSocial
    if (!meta?.authed || !meta.topics?.has(t)) return
    try {
      ws.send(raw)
    } catch (_) {}
  })
}

function sqliteRowToProfileNew(r) {
  if (!r) return null
  let pinned_tracks = []
  let pinned_playlists = []
  try {
    pinned_tracks = JSON.parse(r.pinned_tracks || '[]')
  } catch (_) {}
  try {
    pinned_playlists = JSON.parse(r.pinned_playlists || '[]')
  } catch (_) {}
  return {
    username: r.username,
    password_hash: r.password_hash,
    password_salt: r.password_salt,
    online: !!r.online,
    last_seen: r.last_seen,
    avatar_data: r.avatar_data,
    banner_data: r.banner_data,
    profile_color: r.profile_color,
    bio: r.bio || '',
    pinned_tracks,
    pinned_playlists,
    total_tracks: r.total_tracks,
    total_seconds: r.total_seconds,
  }
}

function wsBroadcastProfilesRow(rawSqliteRow) {
  const row = sqliteRowToProfileNew(rawSqliteRow)
  if (!row?.username) return
  sendToTopic('profiles', { event: '*', schema: 'public', table: 'flow_profiles', new: row })
}

function wsBroadcastRoomTick(roomId) {
  if (!roomId) return
  const topic = `room:${roomId}`
  sendToTopic(topic, {
    event: '*',
    schema: 'public',
    table: 'flow_rooms',
    room_id: roomId,
  })
  sendToTopic(topic, {
    event: '*',
    schema: 'public',
    table: 'flow_room_members',
    room_id: roomId,
  })
}

/** relay direct to peer */
function handleRelay(ws, payload) {
  const meta = ws.__flowSocial
  if (!meta?.authed || !meta.peer_id) return
  const to = String(payload?.to_peer_id || '').trim()
  const msg = payload?.message
  if (!to || !msg) return
  const outgoing = JSON.stringify({
    t: 'relay_direct',
    from_peer_id: meta.peer_id,
    to_peer_id: to,
    message: msg,
  })
  wsClientsByPeerId(to).forEach((w) => {
    try {
      w.send(outgoing)
    } catch (_) {}
  })
}

/** room broadcast to all subscribed to presence or room_peer topic */
function handleRoomRelay(ws, payload) {
  const meta = ws.__flowSocial
  if (!meta?.authed || !meta.peer_id) return
  const room_id = String(payload?.room_id || '').trim()
  const msg = payload?.message
  if (!room_id || msg == null) return
  const raw = JSON.stringify({
    t: 'relay_room',
    room_id,
    from_peer_id: meta.peer_id,
    message: msg,
  })
  sockets.forEach((w) => {
    if (w.readyState !== 1) return
    const m = w.__flowSocial
    if (!m?.authed || !m.topics) return
    if (m.topics.has(`room_peer:${room_id}`)) {
      try {
        w.send(raw)
      } catch (_) {}
    }
  })
}

/** presence: простой список peer_id подписчиков комнаты */
const roomPeers = new Map()

function touchRoomPresence(room_id, peer_id, username) {
  let m = roomPeers.get(room_id)
  if (!m) {
    m = new Map()
    roomPeers.set(room_id, m)
  }
  m.set(peer_id, { username, ts: Date.now() })
}

function pruneRoomPresence(room_id) {
  const m = roomPeers.get(room_id)
  if (!m) return
  const cutoff = Date.now() - 90000
  m.forEach((v, pid) => {
    if ((v.ts || 0) < cutoff) m.delete(pid)
  })
}

setInterval(() => {
  roomPeers.forEach((_m, room_id) => pruneRoomPresence(room_id))
}, 45000)

const wss = new WebSocketServer({ server, path: '/flow-api/ws' })

wss.on('connection', (ws) => {
  ws.__flowSocial = { authed: false, topics: new Set() }
  sockets.add(ws)

  ws.on('message', (buf) => {
    let msg
    try {
      msg = JSON.parse(String(buf || '{}'))
    } catch {
      return
    }
    const meta = ws.__flowSocial
    if (!msg?.op) return
    if (msg.op === 'auth') {
      if (String(msg.token || '').trim() === SECRET) {
        meta.authed = true
        ws.send(JSON.stringify({ op: 'auth_ok' }))
      } else {
        ws.send(JSON.stringify({ op: 'auth_err' }))
        try {
          ws.close()
        } catch (_) {}
      }
      return
    }
    if (!meta.authed) return
    if (msg.op === 'bind') {
      meta.peer_id = String(msg.peer_id || '').trim() || meta.peer_id
      meta.username = String(msg.username || '').trim().toLowerCase() || meta.username
      return
    }
    if (msg.op === 'sub') {
      wsSubscribe(ws, msg.topics)
      return
    }
    if (msg.op === 'relay_direct') {
      handleRelay(ws, msg.payload || {})
      return
    }
    if (msg.op === 'relay_room') {
      handleRoomRelay(ws, msg.payload || {})
      return
    }
    if (msg.op === 'room_ping') {
      const room_id = String(msg.room_id || '').trim()
      if (!room_id || !meta.peer_id) return
      touchRoomPresence(room_id, meta.peer_id, meta.username || '')
      const m = roomPeers.get(room_id) || new Map()
      const peers = []
      pruneRoomPresence(room_id)
      m.forEach((v, pid) => peers.push({ peer_id: pid, username: v.username }))
      sockets.forEach((w) => {
        if (w.readyState !== 1) return
        const mm = w.__flowSocial
        if (!mm?.authed || !mm.topics?.has?.(`presence:${room_id}`)) return
        try {
          w.send(JSON.stringify({ t: 'presence_sync', room_id, peers }))
        } catch (_) {}
      })
      return
    }
  })

  ws.on('close', () => {
    sockets.delete(ws)
  })
})

server.listen(PORT, () => {
  console.log(`[flow-social-server] SQLite: ${DB_PATH}`)
  console.log(`[flow-social-server] HTTP+WS listening on ${PORT}`)
  console.log('[flow-social-server] REST prefix /flow-api/v1  WebSocket path /flow-api/ws')
})
