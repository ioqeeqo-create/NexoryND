'use strict'

const axios = require('axios')

const VK_CLIENTS = [
  { id: '2685278', secret: 'lxhD8OD7dMsqtXIm5IUY' },
  { id: '3140623', secret: 'VeWdmVclDCtn6ihuP1nt' },
  { id: '6287487', secret: 'Ms2CD44oBLij0TDbxKhu' },
]

const VK_KATE_MOBILE_UA =
  'KateMobileAndroid/56 lite-460 (Android 9; 9; SDK 28; HIGH)'
const VK_KATE_MOBILE_UA_ALT =
  'KateMobileAndroid/52.1 lite-445 (Android 4.4.2; SDK 19; x86; unknown Android SDK built for x86; en)'
const VK_KATE_UAS = [VK_KATE_MOBILE_UA, VK_KATE_MOBILE_UA_ALT]

const VK_AUDIO_INVOKE_FULL_PLANS = [
  ['get', VK_KATE_MOBILE_UA, '5.131'],
  ['post', VK_KATE_MOBILE_UA, '5.131'],
  ['get', VK_KATE_MOBILE_UA_ALT, '5.131'],
  ['post', VK_KATE_MOBILE_UA_ALT, '5.131'],
  ['post', VK_KATE_MOBILE_UA, '5.131', 'm'],
  ['post', VK_KATE_MOBILE_UA_ALT, '5.131', 'm'],
  ['post', VK_KATE_MOBILE_UA, '5.199'],
  ['post', VK_KATE_MOBILE_UA, '5.81'],
  ['post', VK_KATE_MOBILE_UA_ALT, '5.81'],
  ['get', VK_KATE_MOBILE_UA, '5.95'],
  ['post', VK_KATE_MOBILE_UA, '5.95'],
  ['get', VK_KATE_MOBILE_UA_ALT, '5.95'],
  ['post', VK_KATE_MOBILE_UA_ALT, '5.95'],
  ['post', VK_KATE_MOBILE_UA, '5.131', 'api.vk.ru'],
  ['post', VK_KATE_MOBILE_UA, '5.131', 'm', 'api.vk.ru'],
]

const VK_AUDIO_SEARCH_PLANS = [
  ['get', VK_KATE_MOBILE_UA, '5.131'],
  ['post', VK_KATE_MOBILE_UA, '5.131'],
  ['post', VK_KATE_MOBILE_UA_ALT, '5.131'],
  ['post', VK_KATE_MOBILE_UA, '5.131', 'm'],
  // Для части токенов из Marusia/vkhost audio.search поднимается только через api.vk.ru.
  ['post', VK_KATE_MOBILE_UA, '5.131', 'api.vk.ru'],
  ['post', VK_KATE_MOBILE_UA, '5.131', 'm', 'api.vk.ru'],
  ['post', VK_KATE_MOBILE_UA, '5.95'],
]

function vkKateApiHeaders(userAgent = VK_KATE_MOBILE_UA, site = 'www') {
  if (site === 'm') {
    return {
      'User-Agent': userAgent,
      Referer: 'https://m.vk.com/',
      Origin: 'https://m.vk.com',
      Accept: 'application/json',
    }
  }
  return {
    'User-Agent': userAgent,
    Referer: 'https://vk.com/',
    Origin: 'https://vk.com',
    Accept: 'application/json',
  }
}

function vkAwaitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * @param {string} method
 * @param {Record<string, string>} paramsSansV
 * @param {number} [timeout]
 * @param {any[][]} [plans]
 * @returns {Promise<{ status: number, body: any }>}
 */
async function vkInvokeKateMethod(method, paramsSansV, timeout = 14000, plans = VK_AUDIO_INVOKE_FULL_PLANS) {
  const base = { lang: '0', ...paramsSansV }
  let last = { status: 0, body: { error: { error_msg: 'empty', error_code: -1 } } }
  let needGap = false

  async function gap() {
    if (needGap) await vkAwaitMs(420)
    needGap = true
  }

  for (const entry of plans) {
    const kind = entry[0]
    const uaStr = entry[1]
    const ver = entry[2]
    let site = 'www'
    let host = 'api.vk.com'
    for (let i = 3; i < entry.length; i++) {
      const x = entry[i]
      if (x === 'm') site = 'm'
      else if (typeof x === 'string' && /^api\.vk\./.test(x)) host = x
    }
    const merged = { ...base, v: ver }
    const heads = vkKateApiHeaders(uaStr, site)
    const qs = new URLSearchParams(merged).toString()

    for (let floodRetry = 0; floodRetry < 2; floodRetry++) {
      await gap()
      try {
        if (kind === 'get') {
          const url = `https://${host}/method/${method}?${qs}`
          const r = await axios.get(url, { headers: heads, timeout, validateStatus: () => true })
          last = { status: r.status, body: r.data }
        } else {
          const url = `https://${host}/method/${method}`
          const r = await axios.post(url, qs, {
            headers: { ...heads, 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout,
            validateStatus: () => true,
          })
          last = { status: r.status, body: r.data }
        }
      } catch (e) {
        last = { status: 0, body: { error: { error_msg: e?.message || String(e), error_code: -2 } } }
        break
      }

      if (last.body && !last.body.error) return last
      const ec = last.body?.error?.error_code
      if (ec === 6 && floodRetry === 0) {
        await vkAwaitMs(1500)
        continue
      }
      break
    }

    const c = last.body?.error?.error_code
    if (c != null && c !== 3) return last
  }
  return last
}

async function vkMethodPostJson(method, flatParams, timeout = 14000) {
  const qs = new URLSearchParams(flatParams).toString()
  const heads = vkKateApiHeaders()
  const r = await axios.post(`https://api.vk.com/method/${method}`, qs, {
    headers: { ...heads, 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout,
    validateStatus: () => true,
  })
  return { status: r.status, body: r.data }
}

function vkAudioResponseItems(body) {
  if (!body || body.error || body.response == null) return null
  const resp = body.response
  if (Array.isArray(resp)) return resp
  if (typeof resp === 'object' && Array.isArray(resp.items)) return resp.items
  return []
}

function normalizeVkItems(items = []) {
  return (items || []).filter((t) => t?.url).map((t) => ({
    title: t.title || 'Без названия',
    artist: t.artist || '—',
    url: t.url,
    cover: t.album?.thumb?.photo_300 || null,
    bg: 'linear-gradient(135deg,#4680c2,#5b9bd5)',
    source: 'vk',
    id: String(t.id || ''),
  }))
}

/**
 * Поиск VK (Kate): то же, что десктоп + шлюз.
 * @param {string} query
 * @param {string} token
 * @returns {Promise<ReturnType<typeof normalizeVkItems>>}
 */
async function searchVkTracks(query, token) {
  const last = await vkInvokeKateMethod(
    'audio.search',
    {
      q: String(query || ''),
      access_token: token,
      count: '20',
      auto_complete: '1',
    },
    14000,
    VK_AUDIO_SEARCH_PLANS,
  )
  const itemsRaw = vkAudioResponseItems(last.body)
  if (itemsRaw !== null && last.body && !last.body.error) return normalizeVkItems(itemsRaw)
  const msg = last.body?.error?.error_msg || 'VK: нет результатов'
  throw new Error(`VK: ${msg}`)
}

module.exports = {
  VK_CLIENTS,
  VK_KATE_MOBILE_UA,
  VK_KATE_MOBILE_UA_ALT,
  VK_KATE_UAS,
  VK_AUDIO_INVOKE_FULL_PLANS,
  VK_AUDIO_SEARCH_PLANS,
  vkKateApiHeaders,
  vkAwaitMs,
  vkInvokeKateMethod,
  vkMethodPostJson,
  vkAudioResponseItems,
  normalizeVkItems,
  searchVkTracks,
}
