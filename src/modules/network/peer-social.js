;(function peerSocialDefine() {
  const STORAGE_KEYS = {
    profiles: 'flow_profiles',
    current: 'flow_current_user',
    friendsPrefix: 'flow_friends_',
  }

  const DB_PROFILES = 'flow_profiles'
  const DB_FRIENDS = 'flow_friends'
  const DB_FRIEND_REQUESTS = 'flow_friend_requests'

  function getBackend() {
    return typeof window.FlowSocialBackend?.isConfigured === 'function' && window.FlowSocialBackend.isConfigured()
      ? window.FlowSocialBackend
      : null
  }

  function getProfiles() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEYS.profiles) || '[]') || []
    } catch {
      return []
    }
  }

  function saveProfiles(list) {
    localStorage.setItem(STORAGE_KEYS.profiles, JSON.stringify(list || []))
  }

  function rememberCurrentUser(username) {
    const safe = normalizeUsername(username)
    if (!safe) return
    localStorage.setItem(STORAGE_KEYS.current, safe)
    localStorage.setItem('flow_auth_last_user', safe)
  }

  function normalizeUsername(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_\-.]/g, '')
      .slice(0, 32)
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

  async function profileExistsOnServer(username) {
    const be = getBackend()
    if (!be) return false
    try {
      await be.request('GET', `/flow-api/v1/profile-auth/${encodeURIComponent(username)}`)
      return true
    } catch (e) {
      if (e?.status === 404) return false
      throw e
    }
  }

  async function createProfile(rawName, rawPassword = '') {
    const username = normalizeUsername(rawName)
    if (!username || username.length < 3) return { ok: false, error: 'Username: минимум 3 символа [a-z0-9_-.]' }
    const password = String(rawPassword || '')
    if (password.length < 4) return { ok: false, error: 'Пароль: минимум 4 символа' }
    const be = getBackend()
    if (!be) return { ok: false, error: 'Сервер недоступен (задай URL социального сервера Nexory в настройках)' }
    try {
      const exists = await profileExistsOnServer(username)
      if (exists) return { ok: false, error: 'Такой Username уже занят' }
      const salt = randomSalt(24)
      const passHash = await hashPassword(password, salt)
      await be.request('PUT', '/flow-api/v1/profile', {
        username,
        password_hash: passHash,
        password_salt: salt,
        online: true,
        last_seen: new Date().toISOString(),
      })
    } catch (e) {
      return { ok: false, error: e?.message || String(e) }
    }
    const profiles = getProfiles()
    if (profiles.some((p) => p.username === username)) return { ok: true, profile: { username, createdAt: Date.now() } }
    const profile = { username, createdAt: Date.now() }
    profiles.push(profile)
    saveProfiles(profiles)
    rememberCurrentUser(username)
    return { ok: true, profile }
  }

  async function loginProfile(rawName, rawPassword = '') {
    const username = normalizeUsername(rawName)
    const password = String(rawPassword || '')
    if (!username) return { ok: false, error: 'Введите Username' }
    if (!password) return { ok: false, error: 'Введите пароль' }
    const be = getBackend()
    if (!be) return { ok: false, error: 'Сервер недоступен (задай URL социального сервера Nexory в настройках)' }
    let row = null
    try {
      row = await be.request('GET', `/flow-api/v1/profile-auth/${encodeURIComponent(username)}`)
    } catch (e) {
      if (e?.status === 404) return { ok: false, error: 'Профиль не найден, зарегистрируйся' }
      return { ok: false, error: e?.message || 'Ошибка входа' }
    }
    try {
      if (!row?.username) return { ok: false, error: 'Профиль не найден, зарегистрируйся' }
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
    rememberCurrentUser(username)
    return { ok: true, profile }
  }

  async function migrateLegacyAccount(rawName, rawPassword = '') {
    const username = normalizeUsername(rawName)
    const password = String(rawPassword || '')
    if (!username) return { ok: false, error: 'Введите Username' }
    if (password.length < 4) return { ok: false, error: 'Пароль: минимум 4 символа' }
    const be = getBackend()
    if (!be) return { ok: false, error: 'Сервер недоступен' }
    try {
      const row = await be.request('GET', `/flow-api/v1/profile-auth/${encodeURIComponent(username)}`).catch(() => null)
      if (!row?.username) return { ok: false, error: 'Профиль не найден' }
      const hasPassword =
        String(row.password_hash || '').trim() && String(row.password_salt || '').trim()
      if (hasPassword) return { ok: false, error: 'Аккаунт уже мигрирован. Войди через пароль.' }
      const salt = randomSalt(24)
      const passHash = await hashPassword(password, salt)
      await be.request('PATCH', '/flow-api/v1/profile-password', {
        username,
        password_hash: passHash,
        password_salt: salt,
      })
      const profiles = getProfiles()
      if (!profiles.some((p) => p.username === username)) {
        profiles.push({ username, createdAt: Date.now() })
        saveProfiles(profiles)
      }
      rememberCurrentUser(username)
      return { ok: true, profile: { username } }
    } catch (e) {
      if (e?.data?.error === 'already_has_password')
        return { ok: false, error: 'Аккаунт уже мигрирован. Войди через пароль.' }
      return { ok: false, error: e?.message || String(e) }
    }
  }

  function getCurrentProfile() {
    let username = normalizeUsername(localStorage.getItem(STORAGE_KEYS.current) || '')
    if (!username) {
      username = normalizeUsername(localStorage.getItem('flow_auth_last_user') || '')
    }
    if (!username) {
      try {
        const legacyActive = JSON.parse(localStorage.getItem('flow_profile_active') || 'null')
        username = normalizeUsername(legacyActive?.username || legacyActive?.login || '')
      } catch {}
    }
    if (!username) return null
    rememberCurrentUser(username)
    return getProfiles().find((p) => p.username === username) || { username }
  }

  function logoutProfile() {
    localStorage.removeItem(STORAGE_KEYS.current)
    localStorage.removeItem('flow_auth_last_user')
  }

  function getFriends(username) {
    if (!username) return []
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEYS.friendsPrefix + username) || '[]') || []
    } catch {
      return []
    }
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

  async function upsertProfileCloud(username) {
    try {
      const be = getBackend()
      if (!be || !username) return
      await be.request('PUT', '/flow-api/v1/profile', {
        username,
        online: true,
        last_seen: new Date().toISOString(),
      })
    } catch {}
  }

  async function setProfileOfflineCloud(username) {
    try {
      const be = getBackend()
      if (!be || !username) return
      await be.request('PUT', '/flow-api/v1/profile', {
        username,
        online: false,
        last_seen: new Date().toISOString(),
      })
    } catch {}
  }

  async function pullFriendsFromCloud(username) {
    try {
      const be = getBackend()
      if (!be || !username) return
      const data = await be.request('GET', `/flow-api/v1/friends/${encodeURIComponent(username)}`)
      if (!Array.isArray(data)) return
      const list = [
        ...new Set(data.map((x) => normalizeUsername(x?.friend_username)).filter(Boolean)),
      ]
      localStorage.setItem(STORAGE_KEYS.friendsPrefix + username, JSON.stringify(list))
    } catch {}
  }

  async function syncFriendToCloud(ownerUsername, friendUsername) {
    try {
      const be = getBackend()
      if (!be || !ownerUsername || !friendUsername) return
      await be.request('PUT', '/flow-api/v1/friends/pair', {
        owner_username: ownerUsername,
        friend_username: friendUsername,
      })
    } catch {}
  }

  async function removeFriendFromCloud(ownerUsername, friendUsername) {
    try {
      const be = getBackend()
      if (!be || !ownerUsername || !friendUsername) return
      const qs = `?owner_username=${encodeURIComponent(ownerUsername)}&friend_username=${encodeURIComponent(friendUsername)}`
      await be.request('DELETE', `/flow-api/v1/friends/pair${qs}`)
    } catch {}
  }

  async function sendFriendRequestCloud(fromUsername, toUsername) {
    const from = normalizeUsername(fromUsername)
    const to = normalizeUsername(toUsername)
    if (!from || !to || from === to) return { ok: false, error: 'Некорректный запрос' }
    try {
      const be = getBackend()
      if (!be) return { ok: false, error: 'Сервер недоступен' }
      const checking = await be.request(
        'GET',
        `/flow-api/v1/friends/${encodeURIComponent(from)}`,
      ).catch(() => [])
      const already = Array.isArray(checking) && checking.some((r) => normalizeUsername(r?.friend_username) === to)
      if (already) return { ok: false, error: 'Вы уже друзья' }
      await be.request('POST', '/flow-api/v1/friend-requests', {
        from_username: from,
        to_username: to,
        status: 'pending',
      })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e?.message || String(e) }
    }
  }

  async function getIncomingFriendRequestsCloud(username) {
    const safe = normalizeUsername(username)
    if (!safe) return []
    try {
      const be = getBackend()
      if (!be) return []
      const data = await be.request('GET', `/flow-api/v1/friend-requests/incoming/${encodeURIComponent(safe)}`)
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
      const be = getBackend()
      if (!be) return { ok: false, error: 'Сервер недоступен' }
      const status = accept ? 'accepted' : 'rejected'
      await be.request('PATCH', '/flow-api/v1/friend-requests', {
        from_username: from,
        to_username: to,
        status,
      })
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
      this._globalChannel = true
      this._roomChannel = true
      this._pending = new Map()
      this._knownPeers = new Set()
      this._incomingReqByPeer = new Map()
      this._profileHeartbeatTimer = null
      this._relayUnsubs = []
      this._presenceTimer = null
    }

    _unsubsAll() {
      while (this._relayUnsubs.length) {
        const u = this._relayUnsubs.pop()
        try {
          if (typeof u === 'function') u()
        } catch (_) {}
      }
    }

    _dispatchRelayEnvelope(payload) {
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
    }

    _onBackendMessage(raw) {
      if (!this.peer || !window.FlowSocialBackend) return

      if (raw?.t === 'ws_state') {
        this.onStatus({
          type: 'ws-state',
          state: String(raw.state || 'degraded'),
          attempt: Number(raw.attempt || 0),
          reason: raw.reason ? String(raw.reason) : '',
        })
        return
      }

      if (raw?.t === 'relay_direct') {
        if (String(raw.to_peer_id || '') !== this.peer?.id) return
        const from = String(raw.from_peer_id || '').trim()
        this._dispatchRelayEnvelope({
          toPeerId: raw.to_peer_id,
          fromPeerId: from,
          message: raw.message,
        })
        return
      }

      if (raw?.t === 'relay_room' && String(raw.room_id || '') === String(this.roomId || '')) {
        const from = String(raw.from_peer_id || '').trim()
        const msg = raw.message
        if (!msg || !from || from === this.peer?.id) return
        this.onMessage(msg, from)
        return
      }

      if (raw?.t === 'presence_sync' && String(raw.room_id || '') === String(this.roomId || '')) {
        const next = new Set()
        ;(raw.peers || []).forEach((p) => {
          const pid = String(p?.peer_id || '').trim()
          if (!pid || pid === this.peer.id) return
          next.add(pid)
          if (!this.connections.has(pid)) {
            this.connections.set(pid, { peer: pid })
            this.onStatus({ type: 'peer-joined', peerId: pid, incoming: true })
          }
        })
        this._knownPeers.forEach((peerId) => {
          if (!next.has(peerId)) {
            this.connections.delete(peerId)
            this.onStatus({ type: 'peer-left', peerId })
          }
        })
        this._knownPeers = next
      }
    }

    init() {
      const be = getBackend()
      if (!be) return { ok: false, error: 'Сервер соц-слоя не задан (URL и секрет в настройках)' }
      if (!this.username) return { ok: false, error: 'Username не задан' }
      this.peer = { id: `flow-${this.username}` }
      this.onStatus({ type: 'ready', id: this.peer.id })

      FlowSocialBackend.ensureWs()
      FlowSocialBackend.bindPeer(this.peer.id, this.username)

      const unsub = FlowSocialBackend.onMessage((msg) => this._onBackendMessage(msg))
      this._relayUnsubs.push(unsub)

      upsertProfileCloud(this.username).catch(() => {})
      this._startProfileHeartbeat()
      pullFriendsFromCloud(this.username).catch(() => {})

      FlowSocialBackend.wsSubscribeTopics([])
      return { ok: true }
    }

    _startProfileHeartbeat() {
      if (this._profileHeartbeatTimer) clearInterval(this._profileHeartbeatTimer)
      this._profileHeartbeatTimer = setInterval(() => {
        upsertProfileCloud(this.username).catch(() => {})
      }, 25000)
    }

    _wireRoomChannel(roomId) {
      const rid = String(roomId || '').trim()
      if (!rid) return
      if (this._presenceTimer) {
        clearInterval(this._presenceTimer)
        this._presenceTimer = null
      }
      FlowSocialBackend.wsSubscribeTopics([
        `presence:${rid}`,
        `room_peer:${rid}`,
      ])
      FlowSocialBackend.ensureWs()
      FlowSocialBackend.bindPeer(this.peer?.id || '', this.username)

      FlowSocialBackend.roomPing(rid)
      this._presenceTimer = setInterval(() => {
        FlowSocialBackend.roomPing(rid)
      }, 3400)
    }

    destroy() {
      this.leaveRoom()
      this._unsubsAll()
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
        const be = getBackend()
        const safe = normalizeUsername(username)
        if (!be || !safe) return resolve(false)
        const probeTimeoutMs = Math.max(2500, Number(timeoutMs || 0))
        const freshWindowMs = 3 * 60 * 1000
        Promise.race([
          be.request('GET', `/flow-api/v1/profile-public/${encodeURIComponent(safe)}`),
          new Promise((r) => setTimeout(() => r(null), probeTimeoutMs)),
        ])
          .then((row) => {
            if (!row) return resolve(false)
            const onlineFlag = row.online === true || row.online === 1 || String(row.online || '') === '1'
            const seen = Date.parse(String(row.last_seen || row.lastSeen || ''))
            const seenFresh = !Number.isNaN(seen) && Date.now() - seen < freshWindowMs
            if (onlineFlag && !Number.isNaN(seen)) return resolve(seenFresh)
            if (onlineFlag) return resolve(true)
            resolve(false)
          })
          .catch(() => resolve(false))
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
      const rid = this.roomId
      if (!rid) return
      FlowSocialBackend.relayRoom({
        room_id: rid,
        message: payload,
      })
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
      FlowSocialBackend.relayDirect({
        to_peer_id: target,
        message: payload,
      })
    }

    disconnectPeer(peerId) {
      const target = String(peerId || '').trim()
      if (!target) return false
      return this.connections.delete(target)
    }

    leaveRoom() {
      if (this._presenceTimer) {
        clearInterval(this._presenceTimer)
        this._presenceTimer = null
      }
      this._roomChannel = null
      this.connections.clear()
      this._knownPeers.clear()
      this.roomId = null
      return { ok: true }
    }

    peersCount() {
      return this.roomId ? this.connections.size + 1 : 1
    }
  }

  async function createProfileCloudAware(rawName, rawPassword = '') {
    const res = await createProfile(rawName, rawPassword)
    if (res?.ok && res?.profile?.username) upsertProfileCloud(res.profile.username).catch(() => {})
    return res
  }

  async function loginProfileCloudAware(rawName, rawPassword = '') {
    const res = await loginProfile(rawName, rawPassword)
    if (res?.ok && res?.profile?.username) {
      upsertProfileCloud(res.profile.username).catch(() => {})
      pullFriendsFromCloud(res.profile.username).catch(() => {})
    }
    return res
  }

  function logoutProfileCloudAware() {
    const cur = getCurrentProfile()
    if (cur?.username) setProfileOfflineCloud(cur.username).catch(() => {})
    logoutProfile()
  }

  function getFriendsCloudAware(username) {
    const list = getFriends(username)
    pullFriendsFromCloud(username).catch(() => {})
    return list
  }

  function addFriendCloudAware(username, friendUsername) {
    return addFriend(username, friendUsername)
  }

  function removeFriendCloudAware(username, friendUsername) {
    return removeFriend(username, friendUsername)
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
    getSocialBackendConfigured: () => !!getBackend(),
    invalidateSocialBackendCaches: () => {
      try {
        window.FlowSocialBackend?.invalidate?.()
      } catch (_) {}
    },
  }
})()
