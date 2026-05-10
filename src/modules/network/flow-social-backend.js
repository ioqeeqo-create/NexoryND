;(function initFlowSocialBackend() {
  /** Публичный Nginx :80 → flow-social-server; с телефона/браузера не :3847. */
  const DEFAULT_BASE = 'http://85.239.34.229/social'
  /** Должен совпадать с FLOW_SOCIAL_SECRET на VPS (у тебя flowflow). */
  const DEFAULT_SECRET = 'flowflow'
  /** Для релизной сборки: всегда используем встроенный backend без ручного ввода. */
  const FORCE_DEFAULT_CONFIG = true
  const listeners = new Set()
  let ws = null
  let reconnectTimer = null
  let connectAttempt = 0
  let boundPeerId = ''
  let boundUsername = ''
  let lastTopics = []
  let wsAuthTimeout = null
  let wsConnectingHang = null
  /** Сообщения relay, отправленные пока сокет был закрыт — дольются после auth_ok */
  const relayBacklog = []
  const RELAY_BACKLOG_CAP = 64

  function normalizeApiBase(rawBase) {
    const input = String(rawBase || '').trim()
    if (!input) return DEFAULT_BASE
    // UI console URL is not an API endpoint.
    if (/timeweb\.cloud\/my\/servers\/\d+\/console/i.test(input)) return DEFAULT_BASE
    let parsed = null
    try {
      parsed = new URL(input)
    } catch (_) {
      return DEFAULT_BASE
    }
    const host = String(parsed.hostname || '').toLowerCase()
    if (!host || host === 'localhost' || host === '127.0.0.1') return DEFAULT_BASE
    parsed.hash = ''
    parsed.search = ''
    const cleanPath = String(parsed.pathname || '').replace(/\/+$/, '')
    if (!cleanPath || cleanPath === '/') {
      // Keep root for direct backend port (e.g. http://IP:3847),
      // use /social for reverse-proxy setups on :80/:443.
      parsed.pathname = parsed.port ? '/' : '/social'
    } else {
      parsed.pathname = cleanPath
    }
    return parsed.toString().replace(/\/$/, '')
  }

  function getConfig() {
    if (FORCE_DEFAULT_CONFIG) {
      return { base: DEFAULT_BASE, secret: DEFAULT_SECRET }
    }
    let base = DEFAULT_BASE
    let secret = DEFAULT_SECRET
    try {
      const lsBase = normalizeApiBase(localStorage.getItem('flow_social_api_base') || '')
      const lsSecret = String(localStorage.getItem('flow_social_api_secret') || '').trim()
      if (lsBase) base = lsBase
      if (lsSecret) secret = lsSecret
      if (typeof window.getSettings === 'function') {
        const s = window.getSettings()
        if (s?.flowSocialApiBase) {
          const sBase = normalizeApiBase(s.flowSocialApiBase)
          if (sBase) base = sBase
        }
        if (s?.flowSocialApiSecret) {
          const sSecret = String(s.flowSocialApiSecret).trim()
          if (sSecret) secret = sSecret
        }
      }
    } catch (_) {}
    return { base: normalizeApiBase(base), secret }
  }

  function isConfigured() {
    const { base, secret } = getConfig()
    return Boolean(base && secret)
  }

  function emit(msg) {
    listeners.forEach((fn) => {
      try {
        fn(msg)
      } catch (_) {}
    })
  }

  function emitWsState(state, details = {}) {
    emit(Object.assign({ t: 'ws_state', state: String(state || 'degraded') }, details || {}))
  }

  function flushRelayBacklog() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    while (relayBacklog.length) {
      const line = relayBacklog.shift()
      try {
        ws.send(line)
      } catch (_) {
        relayBacklog.unshift(line)
        break
      }
    }
  }

  function pushRelayLine(line) {
    if (relayBacklog.length >= RELAY_BACKLOG_CAP) relayBacklog.shift()
    relayBacklog.push(line)
  }

  function authHeaders() {
    const { secret } = getConfig()
    return {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    }
  }

  async function request(method, path, body) {
    const { base } = getConfig()
    if (!base) throw new Error('flow_social_api_base not set')
    const url = `${base}${path.startsWith('/') ? path : `/${path}`}`
    const opts = { method, headers: authHeaders(), cache: 'no-store' }
    if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
      opts.body = typeof body === 'string' ? body : JSON.stringify(body)
    }
    const r = await fetch(url, opts)
    const text = await r.text()
    let data = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = text
      }
    }
    if (!r.ok) {
      const err = new Error(typeof data === 'object' && data?.error ? data.error : r.statusText || 'request failed')
      err.status = r.status
      err.data = data
      throw err
    }
    return data
  }

  function wsUrl() {
    const { base } = getConfig()
    const u = new URL(base.startsWith('http') ? base : `https://${base}`)
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
    u.pathname = '/flow-api/ws'
    u.search = ''
    return u.toString()
  }

  function clearReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function clearWsLifecycleTimers() {
    if (wsAuthTimeout) {
      clearTimeout(wsAuthTimeout)
      wsAuthTimeout = null
    }
    if (wsConnectingHang) {
      clearTimeout(wsConnectingHang)
      wsConnectingHang = null
    }
  }

  function scheduleReconnect() {
    if (!isConfigured()) return
    clearReconnect()
    const delay = Math.min(30000, 800 + connectAttempt * 400)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connectWs()
    }, delay)
  }

  function connectWs() {
    const { secret } = getConfig()
    if (!secret || !getConfig().base) return
    clearReconnect()
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
    connectAttempt += 1
    emitWsState('connecting', { attempt: connectAttempt })
    try {
      ws = new WebSocket(wsUrl())
    } catch (_) {
      emitWsState('degraded', { reason: 'constructor_failed' })
      scheduleReconnect()
      return
    }

    const sock = ws
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ op: 'auth', token: secret }))
      } catch (_) {}
      clearWsLifecycleTimers()
      wsAuthTimeout = setTimeout(() => {
        wsAuthTimeout = null
        try {
          if (sock && (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING)) sock.close()
        } catch (_) {}
      }, 12000)
      wsConnectingHang = setTimeout(() => {
        wsConnectingHang = null
        try {
          if (sock && sock.readyState === WebSocket.CONNECTING) sock.close()
        } catch (_) {}
      }, 15000)
    }

    ws.onmessage = (ev) => {
      let msg
      try {
        msg = JSON.parse(String(ev.data || '{}'))
      } catch {
        return
      }
      if (msg.op === 'auth_ok') {
        clearWsLifecycleTimers()
        connectAttempt = 0
        emitWsState('online', { attempt: connectAttempt })
        try {
          if (boundPeerId) {
            ws.send(JSON.stringify({ op: 'bind', peer_id: boundPeerId, username: boundUsername || undefined }))
          }
          if (lastTopics.length) {
            ws.send(JSON.stringify({ op: 'sub', topics: lastTopics }))
          }
        } catch (_) {}
        flushRelayBacklog()
        return
      }
      if (msg.op === 'auth_err') {
        clearWsLifecycleTimers()
        emitWsState('degraded', { reason: 'auth_err' })
        try {
          ws.close()
        } catch (_) {}
        return
      }
      emit(msg)
    }

    ws.onclose = () => {
      clearWsLifecycleTimers()
      ws = null
      // Не «degraded» на каждом reconnect — иначе UI мигает красным при нормальной сети.
      emitWsState('connecting', { reason: 'socket_closed', reconnecting: true })
      scheduleReconnect()
    }
    ws.onerror = () => {
      emitWsState('degraded', { reason: 'socket_error' })
      try {
        ws.close()
      } catch (_) {}
    }
  }

  function ensureWs() {
    if (!isConfigured()) return
    connectWs()
  }

  /** Добавить подписки (объединяет с уже запрошенными топиками). */
  function wsSubscribeTopics(topics) {
    const add = new Set(lastTopics)
    ;(topics || []).forEach((t) => {
      const s = String(t || '').trim()
      if (s) add.add(s)
    })
    lastTopics = Array.from(add)
    ensureWs()
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify({ op: 'sub', topics: lastTopics }))
    } catch (_) {}
  }

  function bindPeer(peerId, username) {
    boundPeerId = String(peerId || '').trim()
    boundUsername = String(username || '').trim().toLowerCase()
    ensureWs()
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ op: 'bind', peer_id: boundPeerId, username: boundUsername }))
      } catch (_) {}
    }
  }

  function relayDirect(payload) {
    ensureWs()
    const line = JSON.stringify({ op: 'relay_direct', payload: payload || {} })
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      pushRelayLine(line)
      return
    }
    try {
      ws.send(line)
    } catch (_) {
      pushRelayLine(line)
    }
  }

  function relayRoom(payload) {
    ensureWs()
    const line = JSON.stringify({ op: 'relay_room', payload: payload || {} })
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      pushRelayLine(line)
      return
    }
    try {
      ws.send(line)
    } catch (_) {
      pushRelayLine(line)
    }
  }

  function roomPing(roomId) {
    ensureWs()
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify({ op: 'room_ping', room_id: String(roomId || '').trim() }))
    } catch (_) {}
  }

  function invalidate() {
    boundPeerId = ''
    boundUsername = ''
    lastTopics = []
    relayBacklog.length = 0
    clearWsLifecycleTimers()
    clearReconnect()
    try {
      if (ws) ws.close()
    } catch (_) {}
    ws = null
    connectAttempt = 0
    emitWsState('degraded', { reason: 'invalidated' })
  }

  window.FlowSocialBackend = {
    getConfig,
    isConfigured,
    invalidate,
    onMessage(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    request,
    ensureWs,
    wsSubscribeTopics,
    bindPeer,
    relayDirect,
    relayRoom,
    roomPing,
  }
})()
