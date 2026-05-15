const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  minimize: () => ipcRenderer.send('window-minimize'),
  close: (opts) => ipcRenderer.send('window-close', opts && typeof opts === 'object' ? opts : {}),
  setTrayOnClose: (v) => ipcRenderer.send('flow-set-tray-on-close', Boolean(v)),
  getLaunchAtLogin: () => ipcRenderer.invoke('get-launch-at-login'),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke('set-launch-at-login', Boolean(enabled)),
  maximizeToggle: () => ipcRenderer.invoke('window-maximize-toggle'),
  isWindowMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  getVkToken: (login, password) => ipcRenderer.invoke('vk-get-token', { login, password }),
  vkBrowserAuth: () => ipcRenderer.invoke('vk-browser-auth'),
  vkSearch: (q, token, allowSeleniumBridge) => ipcRenderer.invoke('vk-search', { q, token, allowSeleniumBridge: Boolean(allowSeleniumBridge) }),
  vkValidateToken: (token) => ipcRenderer.invoke('vk-validate-token', { token }),
  yandexValidateToken: (token) => ipcRenderer.invoke('yandex-validate-token', { token }),
  yandexSearch: (q, token) => ipcRenderer.invoke('yandex-search', { q, token }),
  serverSearch: (q, settings = {}) => ipcRenderer.invoke('server-search', { q, settings }),
  importPlaylistLink: (url, tokens = {}) => ipcRenderer.invoke('import-playlist-link', { url, tokens }),
  audiusSearch: (q) => ipcRenderer.invoke('audius-search', { q }),
  youtubeSearch: (q) => ipcRenderer.invoke('youtube-search', { q }),
  youtubeStream: (videoId, instance, options = {}) => ipcRenderer.invoke('youtube-stream', { videoId, instance, ...options }),
  youtubePrefetchStreams: (ids, instance) => ipcRenderer.invoke('youtube-prefetch-streams', { ids, instance }),
  youtubeEngineStatus: () => ipcRenderer.invoke('youtube-engine-status'),
  ytdlpUpdate: () => ipcRenderer.invoke('ytdlp-update'),
  ytdlpInfo: () => ipcRenderer.invoke('ytdlp-info'),
  probeStreamUrl: (url) => ipcRenderer.invoke('probe-stream-url', { url }),
  saveCustomMedia: (payload) => ipcRenderer.invoke('save-custom-media', payload),
  listCustomMedia: () => ipcRenderer.invoke('list-custom-media'),
  presetEmbedMedia: (fileUrl) => ipcRenderer.invoke('preset-embed-media', fileUrl),
  streamCacheLookup: (payload) => ipcRenderer.invoke('stream-cache-lookup', payload),
  streamCacheStore: (payload) => ipcRenderer.invoke('stream-cache-store', payload),
  appVersion: () => ipcRenderer.invoke('app-version'),
  appUpdateCheck: () => ipcRenderer.invoke('app-update-check'),
  appUpdateDownload: () => ipcRenderer.invoke('app-update-download'),
  appUpdateInstall: (downloadedPath) => ipcRenderer.invoke('app-update-install', { downloadedPath }),
  scFetchClientId: () => ipcRenderer.invoke('sc-fetch-client-id'),
  scSearch: (q, clientId) => ipcRenderer.invoke('sc-search', { q, clientId }),
  scStream: (transcodingUrl, clientId) => ipcRenderer.invoke('sc-stream', { transcodingUrl, clientId }),
  yandexStream: (trackId, token) => ipcRenderer.invoke('yandex-stream', { trackId, token }),
  yandexMyWaveFetch: (payload) => ipcRenderer.invoke('yandex-my-wave-fetch', payload || {}),
  yandexRotorFeedback: (payload) => ipcRenderer.invoke('yandex-rotor-feedback', payload || {}),
  yandexTrackDislike: (payload) => ipcRenderer.invoke('yandex-track-dislike', payload || {}),
  yandexTrackLike: (payload) => ipcRenderer.invoke('yandex-track-like', payload || {}),
  yandexTrackUnlike: (payload) => ipcRenderer.invoke('yandex-track-unlike', payload || {}),
  getLyrics: (title, artist, duration, options = {}) => ipcRenderer.invoke('get-lyrics', {
    title,
    artist,
    duration,
    source: options?.source || '',
    trackId: options?.trackId || '',
    yandexToken: options?.yandexToken || '',
  }),
  proxySetUrl: (url) => ipcRenderer.invoke('proxy-set-url', url),
  discordRpcConnect: (clientId) => ipcRenderer.invoke('discord-rpc-connect', { clientId }),
  discordRpcUpdate: (payload) => ipcRenderer.invoke('discord-rpc-update', payload),
  discordRpcClear: () => ipcRenderer.invoke('discord-rpc-clear'),
  onDiscordJoinSecret: (cb) => {
    if (typeof cb !== 'function') return () => {}
    const handler = (event, secret) => cb(secret)
    ipcRenderer.on('discord-join-secret', handler)
    return () => ipcRenderer.removeListener('discord-join-secret', handler)
  },
  lastfmNowPlaying: (payload) => ipcRenderer.invoke('lastfm-now-playing', payload),
  lastfmScrobble: (payload) => ipcRenderer.invoke('lastfm-scrobble', payload),
  onFlowWindowState: (cb) => {
    if (typeof cb !== 'function') return () => {}
    const handler = (_e, state) => {
      try {
        cb(state || {})
      } catch (_) {}
    }
    ipcRenderer.on('flow-window-state', handler)
    return () => ipcRenderer.removeListener('flow-window-state', handler)
  },
  getFlowWindowState: () => ipcRenderer.invoke('flow-window-get-state'),
})
