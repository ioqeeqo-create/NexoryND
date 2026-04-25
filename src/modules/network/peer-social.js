(() => {
  const STORAGE_KEYS = {
    profiles: 'flow_profiles',
    current: 'flow_current_user',
    friendsPrefix: 'flow_friends_',
  }

  function getProfiles() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.profiles) || '[]') || [] } catch { return [] }
  }

  function saveProfiles(list) {
    localStorage.setItem(STORAGE_KEYS.profiles, JSON.stringify(list || []))
  }

  function normalizeUsername(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_\-.]/g, '').slice(0, 32)
  }

  function createProfile(rawName) {
    const username = normalizeUsername(rawName)
    if (!username || username.length < 3) return { ok: false, error: 'Username: минимум 3 символа [a-z0-9_-.]' }
    const profiles = getProfiles()
    if (profiles.some((p) => p.username === username)) {
      return { ok: false, error: 'Такой Username уже занят' }
    }
    const profile = { username, createdAt: Date.now() }
    profiles.push(profile)
    saveProfiles(profiles)
    localStorage.setItem(STORAGE_KEYS.current, username)
    return { ok: true, profile }
  }

  function loginProfile(rawName) {
    const username = normalizeUsername(rawName)
    const profile = getProfiles().find((p) => p.username === username)
    if (!profile) return { ok: false, error: 'Профиль не найден, зарегистрируйся' }
    localStorage.setItem(STORAGE_KEYS.current, username)
    return { ok: true, profile }
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
    return { ok: true, list }
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
    }

    init() {
      if (!window.Peer || !this.username) return { ok: false, error: 'PeerJS недоступен' }
      const peer = new window.Peer(`flow-${this.username}`)
      this.peer = peer
      peer.on('open', () => this.onStatus({ type: 'ready', id: peer.id }))
      peer.on('connection', (conn) => this._wireConn(conn, true))
      peer.on('error', (err) => this.onStatus({ type: 'error', error: err?.message || String(err) }))
      return { ok: true }
    }

    destroy() {
      this.connections.forEach((c) => { try { c.close() } catch {} })
      this.connections.clear()
      if (this.peer) {
        try { this.peer.destroy() } catch {}
      }
      this.peer = null
      this.roomId = null
    }

    _wireConn(conn, incoming = false) {
      if (!conn?.peer) return
      const isTransient = Boolean(conn?.metadata?.transient)
      conn.on('open', () => {
        if (isTransient) return
        if (this.connections.size >= this.maxPeers) {
          conn.send({ type: 'room-full', roomId: this.roomId })
          conn.close()
          return
        }
        this.connections.set(conn.peer, conn)
        this.onStatus({ type: 'peer-joined', peerId: conn.peer, incoming })
      })
      conn.on('data', (msg) => this.onMessage(msg, conn.peer))
      conn.on('close', () => {
        if (isTransient) return
        this.connections.delete(conn.peer)
        this.onStatus({ type: 'peer-left', peerId: conn.peer })
      })
      conn.on('error', (err) => this.onStatus({ type: 'conn-error', peerId: conn.peer, error: err?.message || String(err) }))
    }

    createRoom() {
      if (!this.peer) return { ok: false, error: 'Peer не инициализирован' }
      this.roomId = this.peer.id
      return { ok: true, roomId: this.roomId, host: true }
    }

    joinRoom(roomId) {
      if (!this.peer) return { ok: false, error: 'Peer не инициализирован' }
      const target = String(roomId || '').trim()
      if (!target) return { ok: false, error: 'Укажи ID румы' }
      this.roomId = target
      const conn = this.peer.connect(target, { reliable: true, serialization: 'json' })
      this._wireConn(conn, false)
      return { ok: true, roomId: target, host: false }
    }

    probeUser(username, timeoutMs = 3500) {
      return new Promise((resolve) => {
        if (!this.peer) return resolve(false)
        const target = `flow-${normalizeUsername(username)}`
        if (!target || target === this.peer.id) return resolve(false)
        let done = false
        const conn = this.peer.connect(target, { reliable: false, serialization: 'json', metadata: { transient: true } })
        const finish = (ok) => {
          if (done) return
          done = true
          try { conn.close() } catch {}
          resolve(Boolean(ok))
        }
        const timer = setTimeout(() => finish(false), Math.max(1000, Number(timeoutMs || 0)))
        conn.on('open', () => { clearTimeout(timer); finish(true) })
        conn.on('error', () => { clearTimeout(timer); finish(false) })
      })
    }

    requestPeerData(peerId, message = {}, timeoutMs = 3500) {
      return new Promise((resolve) => {
        if (!this.peer) return resolve({ ok: false, error: 'Peer не инициализирован' })
        const target = String(peerId || '').trim()
        if (!target || target === this.peer.id) return resolve({ ok: false, error: 'Некорректный PeerID' })
        let done = false
        let timer = null
        const conn = this.peer.connect(target, { reliable: true, serialization: 'json', metadata: { transient: true } })
        const finish = (result) => {
          if (done) return
          done = true
          if (timer) clearTimeout(timer)
          try { conn.close() } catch {}
          resolve(result)
        }
        timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), Math.max(1200, Number(timeoutMs || 0)))
        conn.on('open', () => {
          try { conn.send({ ...(message || {}), _from: this.username, _peerId: this.peer?.id || null, _ts: Date.now() }) } catch {}
        })
        conn.on('data', (msg) => finish({ ok: true, data: msg }))
        conn.on('error', (err) => finish({ ok: false, error: err?.message || String(err) }))
      })
    }

    send(message) {
      const payload = { ...(message || {}), _ts: Date.now(), _from: this.username, _peerId: this.peer?.id || null }
      this.connections.forEach((conn) => {
        try { conn.send(payload) } catch {}
      })
    }

    sendToPeer(peerId, message) {
      const target = String(peerId || '').trim()
      if (!target) return
      const payload = { ...(message || {}), _ts: Date.now(), _from: this.username, _peerId: this.peer?.id || null }
      const conn = this.connections.get(target)
      if (conn) {
        try { conn.send(payload) } catch {}
        return
      }
      if (!this.peer || target === this.peer.id) return
      const temp = this.peer.connect(target, { reliable: true, serialization: 'json', metadata: { transient: true } })
      temp.on('open', () => {
        try { temp.send(payload) } catch {}
        try { temp.close() } catch {}
      })
      temp.on('error', () => {})
    }

    disconnectPeer(peerId) {
      const target = String(peerId || '').trim()
      if (!target) return false
      const conn = this.connections.get(target)
      if (!conn) return false
      try { conn.close() } catch {}
      this.connections.delete(target)
      return true
    }

    leaveRoom() {
      this.connections.forEach((conn) => { try { conn.close() } catch {} })
      this.connections.clear()
      this.roomId = null
      return { ok: true }
    }

    peersCount() {
      return this.connections.size + 1
    }
  }

  window.FlowModules = window.FlowModules || {}
  window.FlowModules.peerSocial = {
    EVENTS: {
      QUEUE_UPDATE: 'queue-update',
    },
    STORAGE_KEYS,
    normalizeUsername,
    createProfile,
    loginProfile,
    getCurrentProfile,
    logoutProfile,
    getFriends,
    addFriend,
    FlowPeerSocial,
  }
})()
