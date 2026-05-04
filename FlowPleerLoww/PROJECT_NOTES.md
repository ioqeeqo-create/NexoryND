# Flow — Музыкальный плеер | Заметки проекта

## Что это за проект
**Flow** — десктопный музыкальный плеер на **Electron** (не браузер!).  
Файлы: `main.js` (Electron main), `renderer.js` (вся логика UI), `index.html`, `styles.css`.

---

## Текущая версия: v6 (Hitmo)

### Что изменилось в v6
- ❌ Убрана Яндекс Музыка (требовала токен + подписку Плюс)
- ✅ Добавлен **Hitmo** (`ru.hitmoz.org`) — бесплатно, без регистрации
- ✅ Новый UI поиска с **source pills** (переключатель источников прямо в поиске)
- ✅ Hover-эффект на обложках треков: затемнение + кнопка Play с анимацией
- ✅ Кнопки лайк/плей появляются только при наведении (чище)
- ✅ Glow эффект на обложках при ховере (акцент: `#ff2e88`)
- ✅ Счётчик результатов и лейбл источника над списком треков
- ✅ Улучшен empty state поиска

---

## Архитектура

```
renderer.js
├── Visual Settings  (getVisual, saveVisual, applyVisualSettings)
├── Fullscreen Player (enterPlayerMode, exitPlayerMode, syncPlayerModeUI)
├── Providers map    { hitmo, soundcloud, vk, youtube, spotify }
├── Settings         (getSettings, saveSettingsRaw, loadSettingsPage)
├── Navigation       (openPage)
├── Player           (playTrackObj, togglePlay, seekTo, prevTrack, nextTrack)
├── Search           (searchTracks, renderResults, switchSearchSource)
├── Sources
│   ├── searchHitmo(q)        ← новый, парсит ru.hitmoz.org
│   ├── searchSoundCloud(q)   ← автоматический Client ID
│   ├── searchVK(q, token)    ← нужен токен Kate Mobile
│   ├── searchYouTube(q)      ← через Invidious, только Electron
│   └── searchSpotify(q, tok) ← Bearer токен, воспроизведение через YT
├── Track Card       (makeTrackEl) ← обложка с hover overlay
├── Likes            (likeTrack, getLiked, renderLiked)
├── Playlists        (createPlaylist, openPlaylist, addToPlaylist)
└── Lyrics           (toggleLyrics, loadLyrics, syncLyrics)
```

---

## Источники музыки

| Источник     | Токен?     | Работает в браузере? | Статус |
|-------------|-----------|----------------------|--------|
| **Hitmo**   | ❌ нет     | ⚠️ CORS (нужен Electron) | ✅ новый дефолт |
| SoundCloud  | Авто / ручной | ⚠️ CORS | ✅ работает |
| YouTube     | ❌ нет     | ❌ только Electron | ✅ работает |
| Spotify     | Bearer токен | ✅ | ✅ поиск, воспроизведение через YT |
| ВКонтакте   | Kate Mobile токен | ⚠️ CORS | ✅ при наличии токена |
| ~~Яндекс~~  | OAuth + Плюс | ❌ | ❌ убран в v6 |

---

## Hitmo — как работает

```js
// renderer.js: searchHitmo(q)
// 1. Если window.api.hitmoSearch — используем IPC (main.js должен реализовать)
// 2. Если window.api.fetchHtml   — main.js делает HTTP запрос (обход CORS)
// 3. Fallback: прямой fetch (только если webSecurity:false в Electron)

// Парсинг: parseHitmoResults(html)
// Ищет: .song-item, .track-item, [data-mp3], [data-url]
// Поля трека: title, artist, url (mp3), cover (img src), source:'hitmo'
```

### Что нужно добавить в main.js (Electron) для Hitmo:
```js
ipcMain.handle('hitmo-fetch-html', async (e, url) => {
  const { net } = require('electron')
  // либо node-fetch / axios
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    return { ok: true, html: await res.text() }
  } catch(err) {
    return { ok: false, error: err.message }
  }
})
// В preload.js добавить: fetchHtml: (url) => ipcRenderer.invoke('hitmo-fetch-html', url)
```

---

## Дизайн-система

### Цвета
```css
--bg:      #08080f       /* почти чёрный */
--accent:  #7c3aed       /* фиолетовый (меняется в настройках) */
--accent2: #a855f7
--text:    #f0eeff
--muted:   rgba(240,238,255,0.4)
--border:  rgba(255,255,255,0.08)
```

### Hitmo акцент (жёстко задан в CSS)
```css
#ff2e88  /* розово-пурпурный — используется для glow обложек и source pill */
```

### Glassmorphism
```css
backdrop-filter: blur(var(--glass-blur)) saturate(180%)
background: var(--glass-bg)  /* rgba(255,255,255, 0.08) */
border: 1px solid rgba(255,255,255,0.12)
```

### Шрифты
- **Заголовки**: `Syne` (Google Fonts) — bold/extrabold
- **Текст**: `DM Sans` (Google Fonts) — 300/400/500

---

## Компоненты UI (HTML ids)

### Player bar (внизу)
- `#player-cover` — обложка
- `#player-name`, `#player-artist` — название/артист
- `#play-btn` — кнопка play/pause
- `#progress` — прогресс-бар (input range 0–1)
- `#volume` — громкость
- `#player-like-btn` — лайк
- `#lyrics-btn` — текст песни

### Fullscreen player (`#player-mode`)
- `#pm-cover`, `#pm-cover-glow`
- `#pm-title`, `#pm-artist`
- `#pm-progress`, `#pm-play-btn`, `#pm-play-icon`
- `#pm-volume`, `#pm-like-btn`

### Search page
- `#search-input` — поле поиска
- `.search-source-pill[data-src="..."]` — pills переключения источника
- `#search-results` — список треков
- `#search-results-meta` — мета (счётчик + источник)

---

## Что можно улучшить дальше

### 🔧 Функциональность
- [ ] Реализовать `window.api.fetchHtml` в `main.js` для Hitmo (CORS bypass)
- [ ] Кэш обложек (IndexedDB или файловая система)
- [ ] Очередь и shuffle режим
- [ ] Equalizer / bass boost через Web Audio API
- [ ] Скачивание треков (только Hitmo + SoundCloud)
- [ ] Поиск по жанрам/топ чарты (Hitmo поддерживает)

### 🎨 Дизайн
- [ ] Анимация переключения треков (slide обложки)
- [ ] Waveform визуализатор (Web Audio API → Canvas)
- [ ] Мини-визуализатор в player bar вместо иконки
- [ ] Цветовая тема трека (уже есть updateOrbsFromCover — расширить на весь UI)
- [ ] Контекстное меню правой кнопкой на треке

### 🔌 Новые источники
- [ ] Last.fm (метаданные + похожие треки)
- [ ] Deezer (поиск без токена)
- [ ] Jamendo (бесплатная музыка под CC)

---

## Структура файлов

```
flow_v6_hitmo/
├── index.html        ← разметка, все страницы как #page-*
├── renderer.js       ← вся логика (1100+ строк)
├── styles.css        ← стили (700+ строк)
├── main.js           ← Electron main process
├── preload.js        ← IPC bridge (window.api.*)
├── package.json      ← зависимости Electron
├── assets/
│   └── icon.ico
└── PROJECT_NOTES.md  ← этот файл
```

---

## Запуск
```bash
npm install
npm start
# или
npx electron .
```
