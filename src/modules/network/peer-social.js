(() => {
  const STORAGE_KEYS = {
    profiles: 'flow_profiles',
    current: 'flow_current_user',
    friendsPrefix: 'flow_friends_',
    supabaseUrl: 'flow_supabase_url',
    supabaseKey: 'flow_supabase_key',
  }

  const DEFAULT_SUPABASE_URL = 'https://cdfwiqgwwxdzznvbpcgj.supabase.co'
  const DEFAULT_SUPABASE_KEY = 'sb_publishable_fAF9-Qezjp_51olpGfpkYw_K1q1Yzxm'
  const DB_PROFILES = 'flow_profiles'
  const DB_FRIENDS = 'flow_friends'
  const DB_FRIEND_REQUESTS = 'flow_friend_requests'

  function getProfiles() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.profiles) || '[]') || [] } catch { return [] }
  }

  function saveProfiles(list) {
    localStorage.setItem(STORAGE_KEYS.profiles, JSON.stringify(list || []))
  }

  function normalizeUsername(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_\-.]/g, '').slice(0, 32)
  }

  function randomSalt(len = 16) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    let out = ''
    for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)]
    return out
  }

  async function hashPassword(password, salt) {
    const input = String(password || '') + '::' + String(salt || '')
    try {
      if (window?.crypto?.subtle && window?.TextEncoder) {
        const enc = new TextEncoder()
        const bytes = enc.encode(input)
        const digest = await window.crypto.subtle.digest('SHA-256', bytes)
        const arr = Array.from(new Uint8Array(digest))
        return arr.map((b) => b.toString(16).padStart(2, '0')).join('')
      }
    } catch {}
    return btoa(unescape(encodeURIComponent(input))).slice(0, 120)
  }

  async function createProfile(rawName, rawPassword = '') {
    const username = normalizeUsername(rawName)
    if (!username || username.length < 3) return { ok: false, error: 'Username: минимум 3 символа [a-z0-9_-.]' }
    const password = String(rawPassword || '')
    if (password.length < 4) return { ok: false, error: 'Пароль: минимум 4 символа' }
    const sb = getSupabase()
    if (!sb) return { ok: false, error: 'Сервер недоступен' }
    try {
      const { data: existing } = await sb
        .from(DB_PROFILES)
        .select('username')
        .eq('username', username)
        .maybeSingle()
      if (existing?.username) return { ok: false, error: 'Такой Username уже занят' }
      const salt = randomSalt(24)
      const passHash = await hashPassword(password, salt)
      const { error } = await sb.from(DB_PROFILES).insert({
        username,
        password_salt: salt,
        password_hash: passHash,
        online: true,
        last_seen: new Date().toISOString(),
      })
      if (error) return { ok: false, error: error.message || 'Не удалось создать аккаунт' }
    } catch (e) {
      return { ok: false, error: e?.message || String(e) }
    }
    const profiles = getProfiles()
    if (profiles.some((p) => p.username === username)) return { ok: true, profile: { username, createdAt: Date.now() } }
    const profile = { username, createdAt: Date.now() }
    profiles.push(profile)
    saveProfiles(profiles)
    localStorage.setItem(STORAGE_KEYS.current, username)
    return { ok: true, profile }
  }

  async function loginProfile(rawName, rawPassword = '') {
    const username = normalizeUsername(rawName)
    const password = String(rawPassword || '')
    if (!username) return { ok: false, error: 'Введите Username' }
    if (!password) return { ok: false, error: 'Введите пароль' }
    const sb = getSupabase()
    if (!sb) return { ok: false, error: 'Сервер недоступен' }
    let row = null
    try {
      const { data, error } = await sb
        .from(DB_PROFILES)
        .select('username,password_hash,password_salt')
        .eq('username', username)
        .maybeSingle()
      if (error) return { ok: false, error: error.message || 'Ошибка входа' }
      if (!data?.username) return { ok: false, error: 'Профиль не найден, зарегистрируйся' }
      row = data
      const salt = String(row.password_salt || '')
      const expected = String(row.password_hash || '')
      if (!salt || !expected) {
        return { ok: false, legacy: true, error: 'Старый аккаунт без пароля. Нужна миграция.' }
      }
      const actual = await hashPassword(password, salt)
      if (actual !== expected) return { ok: false, error: 'Неверный пароль' }
    } catch (e) {
      return { ok: false, error: e?.message || String(e) }
    }
    const profile = getProfiles().find((p) => p.username === username) || { username, createdAt: Date.now() }
    const profiles = getProfiles()
    if (!profiles.some((p) => p.username === username)) {
      profiles.push(profile)
      saveProfiles(profiles)
    }
    localStorage.setItem(STORAGE_KEYS.current, username)
    return { ok: true, profile }
  }

  async function migrateLegacyAccount(rawName, rawPassword = '') {
    const username = normalizeUsername(rawName)
    const password = String(rawPassword || '')
    if (!username) return { ok: false, error: 'Введите Username' }
    if (password.length < 4) return { ok: false, error: 'Пароль: минимум 4 символа' }
    const sb = getSupabase()
    if (!sb) return { ok: false, error: 'Сервер недоступен' }
    try {
      const { data, error } = await sb
        .from(DB_PROFILES)
        .select('username,password_hash,password_salt')
        .eq('username', username)
        .maybeSingle()
      if (error) return { ok: false, error: error.message || 'Ошибка миграции' }
      if (!data?.username) return { ok: false, error: 'Профиль не найден' }
      const hasPassword = String(data.password_hash || '').trim() && String(data.password_salt || '').trim()
      if (hasPassword) return { ok: false, error: 'Аккаунт уже мигрирован. Войди через пароль.' }
      const salt = randomSalt(24)
      const passHash = await hashPassword(password, salt)
      const { error: upError } = await sb
        .from(DB_PROFILES)
        .update({
          password_hash: passHash,
          password_salt: salt,
          last_seen: new Date().toISOString(),
          online: true,
        })
        .eq('username', username)
        .is('password_hash', null)
      if (upError) return { ok: false, error: upError.message || 'Не удалось завершить миграцию' }
      const profiles = getProfiles()
      if (!profiles.some((p) => p.username === username)) {
        profiles.push({ username, createdAt: Date.now() })
        saveProfiles(profiles)
      }
      localStorage.setItem(STORAGE_KEYS.current, username)
      return { ok: true, profile: { username } }
    } catch (e) {
      return { ok: false, error: e?.message || String(e) }
    }
  }

  function getCurrentProfile() {
    const username = localStorage.getItem(STORAGE_KEYS.current)
    if (!username) return null
    return getProfiles().find((p) => p.username === username) || { username }
  }

  function logoutProfile() {
    localStorage.removeItem(STORAGE_KEYS.current)
  }

  function getFriends(username) {
    if (!username) return []
    try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.friendsPrefix + username) || '[]') || [] } catch { return [] }
  }

  function addFriend(username, friendUsername) {
    const safe = normalizeUsername(friendUsername)
    if (!safe || safe === username) return { ok: false, error: 'Некорректный Username друга' }
    const list = getFriends(username)
    if (!list.includes(safe)) list.push(safe)
    localStorage.setItem(STORAGE_KEYS.friendsPrefix + username, JSON.stringify(list))
    syncFriendToCloud(username, safe).catch(() => {})
    return { ok: true, list }
  }

  function removeFriend(username, friendUsername) {
    const owner = normalizeUsername(username)
    const safe = normalizeUsername(friendUsername)
    if (!owner || !safe || safe === owner) return { ok: false, error: 'Некорректный Username друга' }
    const list = getFriends(owner).filter((item) => normalizeUsername(item) !== safe)
    localStorage.setItem(STORAGE_KEYS.friendsPrefix + owner, JSON.stringify(list))
    removeFriendFromCloud(owner, safe).catch(() => {})
    return { ok: true, list }
  }

  function getSupabaseConfig() {
    const url = String(localStorage.getItem(STORAGE_KEYS.supabaseUrl) || DEFAULT_SUPABASE_URL || '').trim()
    const key = String(localStorage.getItem(STORAGE_KEYS.supabaseKey) || DEFAULT_SUPABASE_KEY || '').trim()
    return { url, key }
  }

  let _supabase = null
  function getSupabase() {
    try {
      if (_supabase) return _supabase
      const cfg = getSupabaseConfig()
      const factory = window?.supabase?.createClient
      if (!factory || !cfg.url || !cfg.key) return null
      _supabase = factory(cfg.url, cfg.key, { realtime: { params: { eventsPerSecond: 30 } } })
      return _supabase
    } catch {
      return null
    }
  }

  async function upsertProfileCloud(username) {
    try {
      const sb = getSupabase()
      if (!sb || !username) return
      await sb.from(DB_PROFILES).upsert({
        username,
        online: true,
        last_seen: new Date().toISOString(),
      }, { onConflict: 'username' })
    } catch {}
  }

  async function setProfileOfflineCloud(username) {
    try {
      const sb = getSupabase()
      if (!sb || !username) return
      await sb.from(DB_PROFILES).upsert({
        username,
        online: false,
        last_seen: new Date().toISOString(),
      }, { onConflict: 'username' })
    } catch {}
  }

  async function pullFriendsFromCloud(username) {
    try {
      const sb = getSupabase()
      if (!sb || !username) return
      const { data } = await sb.from(DB_FRIENDS)
        .select('friend_username')
        .eq('owner_username', username)
      if (!Array.isArray(data)) return
      const list = [...new Set(data.map((x) => normalizeUsername(x?.friend_username)).filter(Boolean))]
      localStorage.setItem(STORAGE_KEYS.friendsPrefix + username, JSON.stringify(list))
    } catch {}
  }

  async function syncFriendToCloud(ownerUsername, friendUsername) {
    try {
      const sb = getSupabase()
      if (!sb || !ownerUsername || !friendUsername) return
      await sb.from(DB_FRIENDS).upsert({
        owner_username: ownerUsername,
        friend_username: friendUsername,
      }, { onConflict: 'owner_username,friend_username' })
      await sb.from(DB_FRIENDS).upsert({
        owner_username: friendUsername,
        friend_username: ownerUsername,
      }, { onConflict: 'owner_username,friend_username' })
    } catch {}
  }

  async function removeFriendFromCloud(ownerUsername, friendUsername) {
    try {
      const sb = getSupabase()
      if (!sb || !ownerUsername || !friendUsername) return
      await sb.from(DB_FRIENDS)
        .delete()
        .eq('owner_username', ownerUsername)
        .eq('friend_username', friendUsername)
      await sb.from(DB_FRIENDS)
        .delete()
        .eq('owner_username', friendUsername)
        .eq('friend_username', ownerUsername)
    } catch {}
  }

  async function sendFriendRequestCloud(fromUsername, toUsername) {
    const from = normalizeUsername(fromUsername)
    const to = normalizeUsername(toUsername)
    if (!from || !to || from === to) return { ok: false, error: 'Некорректный запрос' }
    try {
      const sb = getSupabase()
      if (!sb) return { ok: false, error: 'Supabase недоступен' }
      const { data: existing } = await sb.from(DB_FRIENDS)
        .select('owner_username')
        .eq('owner_username', from)
        .eq('friend_username', to)
        .maybeSingle()
      if (existing) return { ok: false, error: 'Вы уже друзья' }
      const { error } = await sb.from(DB_FRIEND_REQUESTS).upsert({
        from_username: from,
        to_username: to,
        status: 'pending',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'from_username,to_username' })
      if (error) return { ok: false, error: error.message || 'Не удалось отправить запрос' }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e?.message || String(e) }
    }
  }

  async function getIncomingFriendRequestsCloud(username) {
    const safe = normalizeUsername(username)
    if (!safe) return []
    try {
      const sb = getSupabase()
      if (!sb) return []
      const { data } = await sb.from(DB_FRIEND_REQUESTS)
        .select('from_username,to_username,status,updated_at')
        .eq('to_username', safe)
        .eq('status', 'pending')
        .order('updated_at', { ascending: false })
      return Array.isArray(data) ? data : []
    } catch {
      return []
    }
  }

  async function respondFriendRequestCloud(currentUsername, fromUsername, accept = true) {
    const to = normalizeUsername(currentUsername)
    const from = normalizeUsername(fromUsername)
    if (!to || !from) return { ok: false, error: 'Некорректные данные' }
    try {
      const sb = getSupabase()
      if (!sb) return { ok: false, error: 'Supabase недоступен' }
      const status = accept ? 'accepted' : 'rejected'
      const { error } = await sb.from(DB_FRIEND_REQUESTS)
        .update({ status, updated_at: new Date().toISOString() })
        .eq('from_username', from)
        .eq('to_username', to)
        .eq('status', 'pending')
      if (error) return { ok: false, error: error.message || 'Ошибка ответа' }
      if (accept) await syncFriendToCloud(to, from)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e?.message || String(e) }
    }
  }

  class FlowPeerSocial {
    constructor(username, opts = {}) {
      this.username = normalizeUsername(username)
      this.maxPeers = Number(opts.maxPeers || 3)
      this.peer = null
      this.connections = new Map()
      this.roomId = null
      this.onMessage = typeof opts.onMessage === 'function' ? opts.onMessage : () => {}
      this.onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : () => {}
      this.sharedQueue = []
      this._sb = null
      this._globalChannel = null
      this._roomChannel = null
      this._pending = new Map()
      this._knownPeers = new Set()
      this._incomingReqByPeer = new Map()
      this._profileHeartbeatTimer = null
    }

    init() {
      if (!this.username) return { ok: false, error: 'Username не задан' }
      this.peer = { id: `flow-${this.username}` }
      this._sb = getSupabase()
      this.onStatus({ type: 'ready', id: this.peer.id })
      upsertProfileCloud(this.username).catch(() => {})
      this._startProfileHeartbeat()
      pullFriendsFromCloud(this.username).catch(() => {})
      this._wireGlobalChannel()
      return { ok: true }
    }

    _startProfileHeartbeat() {
      if (this._profileHeartbeatTimer) clearInterval(this._profileHeartbeatTimer)
      this._profileHeartbeatTimer = setInterval(() => {
        upsertProfileCloud(this.username).catch(() => {})
      }, 25000)
    }

    _wireGlobalChannel() {
      if (!this._sb || this._globalChannel) return
      this._globalChannel = this._sb.channel('flow-global')
        .on('broadcast', { event: 'direct' }, ({ payload }) => {
          const to = String(payload?.toPeerId || '').trim()
          const from = String(payload?.fromPeerId || '').trim()
          const msg = payload?.message
          if (!to || to !== this.peer?.id || !msg) return
          if (msg._reqId && !msg._responseTo && from) this._incomingReqByPeer.set(from, msg._reqId)
          if (msg._responseTo && this._pending.has(msg._responseTo)) {
            const done = this._pending.get(msg._responseTo)
            this._pending.delete(msg._responseTo)
            done({ ok: true, data: msg })
            return
          }
          this.onMessage(msg, from)
        })
        .subscribe(() => {})
    }

    _wireRoomChannel(roomId) {
      if (!this._sb) return
      if (this._roomChannel) {
        try { this._sb.removeChannel(this._roomChannel) } catch {}
      }
      this._roomChannel = this._sb.channel(`flow-room:${roomId}`, { config: { presence: { key: this.peer.id } } })
        .on('presence', { event: 'sync' }, () => {
          const state = this._roomChannel.presenceState()
          const next = new Set()
          Object.keys(state || {}).forEach((peerId) => {
            if (!peerId || peerId === this.peer.id) return
            next.add(peerId)
            if (!this.connections.has(peerId)) {
              this.connections.set(peerId, { peer: peerId })
              this.onStatus({ type: 'peer-joined', peerId, incoming: true })
            }
          })
          this._knownPeers.forEach((peerId) => {
            if (!next.has(peerId)) {
              this.connections.delete(peerId)
              this.onStatus({ type: 'peer-left', peerId })
            }
          })
          this._knownPeers = next
        })
        .on('broadcast', { event: 'room-message' }, ({ payload }) => {
          const from = String(payload?.fromPeerId || '').trim()
          const msg = payload?.message
          if (!msg || !from || from === this.peer?.id) return
          this.onMessage(msg, from)
        })
        .subscribe(async (status) => {
          if (status === 'SUBSCRIBED') {
            try {
              await this._roomChannel.track({
                peerId: this.peer.id,
                username: this.username,
                ts: Date.now(),
              })
            } catch {}
          }
        })
    }

    destroy() {
      this.leaveRoom()
      if (this._sb && this._globalChannel) {
        try { this._sb.removeChannel(this._globalChannel) } catch {}
      }
      this._globalChannel = null
      if (this._profileHeartbeatTimer) clearInterval(this._profileHeartbeatTimer)
      this._profileHeartbeatTimer = null
      this.connections.clear()
      setProfileOfflineCloud(this.username).catch(() => {})
      this.peer = null
      this.roomId = null
    }

    createRoom() {
      if (!this.peer) return { ok: false, error: 'Соц модуль не инициализирован' }
      this.roomId = this.peer.id
      this._wireRoomChannel(this.roomId)
      return { ok: true, roomId: this.roomId, host: true }
    }

    joinRoom(roomId) {
      if (!this.peer) return { ok: false, error: 'Соц модуль не инициализирован' }
      const target = String(roomId || '').trim()
      if (!target) return { ok: false, error: 'Укажи ID румы' }
      this.roomId = target
      this._wireRoomChannel(target)
      return { ok: true, roomId: target, host: false }
    }

    probeUser(username, timeoutMs = 3500) {
      return new Promise((resolve) => {
        const sb = this._sb || getSupabase()
        const safe = normalizeUsername(username)
        if (!sb || !safe) return resolve(false)
        Promise.race([
          sb.from(DB_PROFILES).select('online,last_seen').eq('username', safe).maybeSingle(),
          new Promise((r) => setTimeout(() => r({ data: null }), Math.max(1000, Number(timeoutMs || 0))))
        ]).then((r) => {
          const row = r?.data
          if (!row) return resolve(false)
          const seen = Date.parse(String(row.last_seen || ''))
          const seenFresh = !Number.isNaN(seen) && (Date.now() - seen) < 75000
          if (row.online === true && seenFresh) return resolve(true)
          if (seenFresh) return resolve(true)
          resolve(false)
        }).catch(() => resolve(false))
      })
    }

    requestPeerData(peerId, message = {}, timeoutMs = 3500) {
      return new Promise((resolve) => {
        if (!this.peer) return resolve({ ok: false, error: 'Peer не инициализирован' })
        const target = String(peerId || '').trim()
        if (!target || target === this.peer.id) return resolve({ ok: false, error: 'Некорректный PeerID' })
        const reqId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const timer = setTimeout(() => {
          this._pending.delete(reqId)
          resolve({ ok: false, error: 'timeout' })
        }, Math.max(1200, Number(timeoutMs || 0)))
        this._pending.set(reqId, (result) => {
          clearTimeout(timer)
          resolve(result)
        })
        this.sendToPeer(target, Object.assign({}, message || {}, { _reqId: reqId }))
      })
    }

    send(message) {
      const payload = { ...(message || {}), _ts: Date.now(), _from: this.username, _peerId: this.peer?.id || null }
      if (!this._roomChannel) return
      try {
        this._roomChannel.send({
          type: 'broadcast',
          event: 'room-message',
          payload: { fromPeerId: this.peer?.id || null, message: payload },
        })
      } catch {}
    }

    sendToPeer(peerId, message) {
      const target = String(peerId || '').trim()
      if (!target) return
      const payload = { ...(message || {}), _ts: Date.now(), _from: this.username, _peerId: this.peer?.id || null }
      if (!payload._responseTo && this._incomingReqByPeer.has(target)) {
        payload._responseTo = this._incomingReqByPeer.get(target)
        this._incomingReqByPeer.delete(target)
      }
      if (payload._reqId) payload._expectsResponse = true
      if (payload._responseTo) payload._expectsResponse = false
      if (!this._globalChannel) return
      try {
        this._globalChannel.send({
          type: 'broadcast',
          event: 'direct',
          payload: {
            toPeerId: target,
            fromPeerId: this.peer?.id || null,
            message: payload,
          },
        })
      } catch {}
    }

    disconnectPeer(peerId) {
      const target = String(peerId || '').trim()
      if (!target) return false
      return this.connections.delete(target)
    }

    leaveRoom() {
      if (this._roomChannel && this._sb) {
        try { this._sb.removeChannel(this._roomChannel) } catch {}
      }
      this._roomChannel = null
      this.connections.clear()
      this._knownPeers.clear()
      this.roomId = null
      return { ok: true }
    }

    peersCount() {
      return this.roomId ? (this.connections.size + 1) : 1
    }
  }

  const _origCreateProfile = createProfile
  const _origLoginProfile = loginProfile
  const _origLogoutProfile = logoutProfile
  const _origGetFriends = getFriends
  const _origAddFriend = addFriend
  const _origRemoveFriend = removeFriend

  async function createProfileCloudAware(rawName, rawPassword = '') {
    const res = await _origCreateProfile(rawName, rawPassword)
    if (res?.ok && res?.profile?.username) upsertProfileCloud(res.profile.username).catch(() => {})
    return res
  }

  async function loginProfileCloudAware(rawName, rawPassword = '') {
    const res = await _origLoginProfile(rawName, rawPassword)
    if (res?.ok && res?.profile?.username) {
      upsertProfileCloud(res.profile.username).catch(() => {})
      pullFriendsFromCloud(res.profile.username).catch(() => {})
    }
    return res
  }

  function logoutProfileCloudAware() {
    const cur = getCurrentProfile()
    if (cur?.username) setProfileOfflineCloud(cur.username).catch(() => {})
    _origLogoutProfile()
  }

  function getFriendsCloudAware(username) {
    const list = _origGetFriends(username)
    pullFriendsFromCloud(username).catch(() => {})
    return list
  }

  function addFriendCloudAware(username, friendUsername) {
    return _origAddFriend(username, friendUsername)
  }

  function removeFriendCloudAware(username, friendUsername) {
    return _origRemoveFriend(username, friendUsername)
  }

  window.FlowModules = window.FlowModules || {}
  window.FlowModules.peerSocial = {
    EVENTS: {
      QUEUE_UPDATE: 'queue-update',
    },
    STORAGE_KEYS,
    normalizeUsername,
    createProfile: createProfileCloudAware,
    loginProfile: loginProfileCloudAware,
    getCurrentProfile,
    logoutProfile: logoutProfileCloudAware,
    getFriends: getFriendsCloudAware,
    addFriend: addFriendCloudAware,
    removeFriend: removeFriendCloudAware,
    migrateLegacyAccount,
    sendFriendRequest: sendFriendRequestCloud,
    getIncomingFriendRequests: getIncomingFriendRequestsCloud,
    respondFriendRequest: respondFriendRequestCloud,
    FlowPeerSocial,
  }
})()
