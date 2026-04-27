const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  minimize: () => ipcRenderer.send('window-minimize'),
  close: () => ipcRenderer.send('window-close'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  getVkToken: (login, password) => ipcRenderer.invoke('vk-get-token', { login, password }),
  vkBrowserAuth: () => ipcRenderer.invoke('vk-browser-auth'),
  vkSearch: (q, token) => ipcRenderer.invoke('vk-search', { q, token }),
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
  appVersion: () => ipcRenderer.invoke('app-version'),
  scFetchClientId: () => ipcRenderer.invoke('sc-fetch-client-id'),
  scSearch: (q, clientId) => ipcRenderer.invoke('sc-search', { q, clientId }),
  scStream: (transcodingUrl, clientId) => ipcRenderer.invoke('sc-stream', { transcodingUrl, clientId }),
  yandexStream: (trackId, token) => ipcRenderer.invoke('yandex-stream', { trackId, token }),
  getLyrics: (title, artist, duration) => ipcRenderer.invoke('get-lyrics', { title, artist, duration }),
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
})
