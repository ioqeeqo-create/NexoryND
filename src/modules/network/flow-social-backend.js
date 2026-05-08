;(function initFlowSocialBackend() {
  /** Публичный Nginx :80 → flow-social-server; с телефона/браузера не :3847. */
  const DEFAULT_BASE = 'http://85.239.34.229/social'
  /** Должен совпадать с FLOW_SOCIAL_SECRET на VPS (у тебя flowflow). */
  const DEFAULT_SECRET = 'flowflow'
  const listeners = new Set()
  let ws = null
  let reconnectTimer = null
  let connectAttempt = 0
  let boundPeerId = ''
  let boundUsername = ''
  let lastTopics = []

  function getConfig() {
    let base = DEFAULT_BASE
    let secret = DEFAULT_SECRET
    try {
      const lsBase = String(localStorage.getItem('flow_social_api_base') || '').trim().replace(/\/$/, '')
      const lsSecret = String(localStorage.getItem('flow_social_api_secret') || '').trim()
      if (lsBase) base = lsBase
      if (lsSecret) secret = lsSecret
      if (typeof window.getSettings === 'function') {
        const s = window.getSettings()
        if (s?.flowSocialApiBase) {
          const sBase = String(s.flowSocialApiBase).trim().replace(/\/$/, '')
          if (sBase) base = sBase
        }
        if (s?.flowSocialApiSecret) {
          const sSecret = String(s.flowSocialApiSecret).trim()
          if (sSecret) secret = sSecret
        }
      }
    } catch (_) {}
    return { base, secret }
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
    try {
      ws = new WebSocket(wsUrl())
    } catch (_) {
      scheduleReconnect()
      return
    }

    ws.onopen = () => {
      connectAttempt = 0
      try {
        ws.send(JSON.stringify({ op: 'auth', token: secret }))
      } catch (_) {}
    }

    ws.onmessage = (ev) => {
      let msg
      try {
        msg = JSON.parse(String(ev.data || '{}'))
      } catch {
        return
      }
      if (msg.op === 'auth_ok') {
        try {
          if (boundPeerId) {
            ws.send(JSON.stringify({ op: 'bind', peer_id: boundPeerId, username: boundUsername || undefined }))
          }
          if (lastTopics.length) {
            ws.send(JSON.stringify({ op: 'sub', topics: lastTopics }))
          }
        } catch (_) {}
        return
      }
      if (msg.op === 'auth_err') {
        try {
          ws.close()
        } catch (_) {}
        return
      }
      emit(msg)
    }

    ws.onclose = () => {
      ws = null
      scheduleReconnect()
    }
    ws.onerror = () => {
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
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify({ op: 'relay_direct', payload: payload || {} }))
    } catch (_) {}
  }

  function relayRoom(payload) {
    ensureWs()
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify({ op: 'relay_room', payload: payload || {} }))
    } catch (_) {}
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
    clearReconnect()
    try {
      if (ws) ws.close()
    } catch (_) {}
    ws = null
    connectAttempt = 0
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
