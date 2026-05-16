import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const d = String.fromCharCode(100, 105, 118)
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')

const searchNew = `<${d} id="page-search" class="page">
      <${d} class="content-header content-header--search">
        <h2>Поиск</h2>
      </${d}>
      <${d} class="nx-search-shell glass" id="nx-search-shell">
        <${d} class="nx-search-top-row">
          <${d} class="nx-search-input-wrap">
            <svg class="ui-icon md nx-search-ico" data-lucide="search" viewBox="0 0 24 24" aria-hidden="true"></svg>
            <input id="search-input" type="search" enterkeyhint="search" placeholder="Исполнитель, название трека..." oninput="onSearchInput()" autocomplete="off">
            <button type="button" class="nx-search-clear hidden" id="search-clear-btn" onclick="clearSearchInput()" aria-label="Очистить"><svg class="ui-icon sm" data-lucide="x" viewBox="0 0 24 24"></svg></button>
          </${d}>
          <button type="button" class="nx-search-src-btn" id="search-src-btn" onclick="toggleSearchSourcePopover(event)" title="Источник" aria-expanded="false">
            <img id="search-src-logo" class="nx-search-src-logo nx-src-mono" src="assets/icon-source.png" alt="">
          </button>
          <${d} class="nx-search-src-pop hidden" id="search-src-pop" role="menu">
            <button type="button" class="nx-search-src-opt" data-src="hybrid" onclick="pickSearchSource('hybrid')"><img src="assets/icon-source.png" alt=""><span>Classic</span></button>
            <button type="button" class="nx-search-src-opt" data-src="yandex" onclick="pickSearchSource('yandex')"><img src="assets/source-yandex-music.png" alt=""><span>Яндекс</span></button>
            <button type="button" class="nx-search-src-opt" data-src="vk" onclick="pickSearchSource('vk')"><img src="assets/source-vk.png" alt=""><span>ВКонтакте</span></button>
          </${d}>
        </${d}>
        <${d} class="nx-search-divider" aria-hidden="true"></${d}>
        <${d} class="nx-search-filters" role="tablist" aria-label="Категория поиска">
          <button type="button" class="nx-search-filter active" data-filter="all" onclick="setSearchFilter('all')"><svg class="ui-icon sm" data-lucide="search" viewBox="0 0 24 24"></svg><span>Все</span></button>
          <button type="button" class="nx-search-filter" data-filter="tracks" onclick="setSearchFilter('tracks')"><svg class="ui-icon sm" data-lucide="music-2" viewBox="0 0 24 24"></svg><span>Треки</span></button>
          <button type="button" class="nx-search-filter" data-filter="playlists" onclick="setSearchFilter('playlists')"><svg class="ui-icon sm" data-lucide="list-music" viewBox="0 0 24 24"></svg><span>Плейлисты</span></button>
          <button type="button" class="nx-search-filter" data-filter="albums" onclick="setSearchFilter('albums')"><svg class="ui-icon sm" data-lucide="disc-3" viewBox="0 0 24 24"></svg><span>Альбомы</span></button>
          <button type="button" class="nx-search-filter" data-filter="artists" onclick="setSearchFilter('artists')"><svg class="ui-icon sm" data-lucide="user-round" viewBox="0 0 24 24"></svg><span>Артисты</span></button>
          <button type="button" class="nx-search-filter" data-filter="lyrics" onclick="setSearchFilter('lyrics')"><svg class="ui-icon sm" data-lucide="align-left" viewBox="0 0 24 24"></svg><span>По тексту</span></button>
        </${d}>
      </${d}>
      <${d} id="search-results-meta" class="results-meta" style="display:none">
        <span class="results-count" id="results-count"></span>
        <span class="results-source-label" id="results-source-label"></span>
      </${d}>
      <${d} class="tracks" id="search-results"></${d}>
    </${d}>

    <${d} id="page-library"`

if (!html.includes('nx-search-shell')) {
  const next = html.replace(/<div id="page-search"[\s\S]*?<\/div>\s*\n\s*<div id="page-library"/, searchNew)
  if (next === html) throw new Error('page-search replace failed')
  html = next
}

html = html.replace(
  /<button type="button" class="home-nx-cover-expand-btn"[\s\S]*?<\/button>/,
  `<button type="button" class="home-nx-cover-expand-btn" onclick="enterPlayerMode()" title="Полный экран" aria-label="Полный экран"><svg class="ui-icon home-nx-cover-fs-min" data-lucide="maximize-2" viewBox="0 0 24 24" aria-hidden="true"></svg></button>`
)

html = html.replace(/<button type="button" class="ctrl-btn home-nx-aux-btn home-nx-only"[\s\S]*?<\/button>\s*/, '')

if (!html.includes('home-nx-row-like-btn')) {
  html = html.replace(
    /(<\/div>\s*<\/div>\s*)<button class="ctrl-btn" id="home-shuffle-btn" onclick="toggleShuffleMode\(\)" title="Перемешка">[\s\S]*?<button class="ctrl-btn" id="home-repeat-btn" onclick="toggleRepeatMode\(\)" title="Повтор">[\s\S]*?<\/button>/,
    `$1<button type="button" class="ctrl-btn home-nx-row-like" id="home-nx-row-like-btn" onclick="likeCurrentTrack()" title="Лайк"><svg class="ui-icon flow-ref-heart-player" data-lucide="heart" viewBox="0 0 24 24"></svg></button>
                  <button class="ctrl-btn" onclick="prevTrack()"><svg class="ui-icon" data-lucide="skip-back" viewBox="0 0 24 24"></svg></button>
                  <button class="ctrl-btn play-btn" id="home-play-btn" onclick="togglePlay()"><svg class="ui-icon ctrl-play-icon" data-lucide="play" viewBox="0 0 24 24"></svg></button>
                  <button class="ctrl-btn" onclick="nextTrack()"><svg class="ui-icon" data-lucide="skip-forward" viewBox="0 0 24 24"></svg></button>
                  <button class="ctrl-btn" id="home-shuffle-btn" onclick="toggleShuffleMode()" title="Перемешка"><svg class="ui-icon flow-ref-ctrl" data-lucide="shuffle" viewBox="0 0 24 24"></svg></button>`
  )
}

if (!html.includes('vs-slider-preview-canvas')) {
  html = html.replace(
    /<div class="vs-row">\s*<label class="vs-label">Стиль слайдера<\/label>[\s\S]*?<\/div>\s*(?=<motion class="vs-row">\s*<label class="vs-label">Профиль чистоты)/.source
      ? /<div class="vs-row">\s*<label class="vs-label">Стиль слайдера<\/label>[\s\S]*?<\/div>\s*(?=<div class="vs-row">\s*<label class="vs-label">Профиль чистоты)/
      : /<div class="vs-row">\s*<label class="vs-label">Стиль слайдера<\/label>[\s\S]*?<\/div>\s*(?=<div class="vs-row">\s*<label class="vs-label">Профиль чистоты)/,
    `<div class="vs-row vs-row--slider-style">
              <label class="vs-label">Стиль слайдера</label>
              <div class="vs-slider-style-block">
                <div class="vs-btn-group">
                  <button class="vsb" id="slider-style-line" onclick="setHomeSliderStyle('line')">Обычный</button>
                  <button class="vsb" id="slider-style-wave" onclick="setHomeSliderStyle('wave')">Волновой</button>
                  <button class="vsb" id="slider-style-ios" onclick="setHomeSliderStyle('ios')">iOS</button>
                </div>
                <div class="vs-slider-preview" id="vs-slider-preview" aria-hidden="true">
                  <canvas id="vs-slider-preview-canvas" width="320" height="72"></canvas>
                  <span class="vs-slider-preview-title" id="vs-slider-preview-title">ARXANGEL</span>
                  <span class="vs-slider-preview-time vs-slider-preview-time--l" id="vs-slider-preview-cur">0:43</span>
                  <span class="vs-slider-preview-time vs-slider-preview-time--r" id="vs-slider-preview-tot">2:07</span>
                </div>
              </div>
            </div>
            `
  )
}

if (!html.includes('pm-source-btn')) {
  const pmRail = `<div class="pm-controls-rail-bar">
    <div class="home-nx-menu-wrap pm-src-wrap">
      <button type="button" class="pm-btn-side pm-source-btn" id="pm-source-btn" onclick="toggleHomeNxSourceMenu(event)" title="Источник" aria-expanded="false"><img class="home-nx-src-logo nx-src-mono" id="pm-source-logo" src="assets/icon-source.png" alt=""></button>
    </div>
    <button type="button" class="pm-btn-side" id="pm-like-btn" onclick="likeCurrentTrack()" title="Лайк"><svg class="ui-icon flow-ref-heart-player" data-lucide="heart" viewBox="0 0 24 24"></svg></button>
    <button class="pm-btn" onclick="prevTrack()" title="Предыдущий">
      <svg class="ui-icon lg" data-lucide="skip-back" viewBox="0 0 24 24"></svg>
    </button>
    <button class="pm-btn pm-play" id="pm-play-btn" onclick="togglePlay()" title="Пауза / воспроизведение">
      <svg id="pm-play-icon" class="ui-icon ctrl-play-icon" data-lucide="play" viewBox="0 0 24 24"></svg>
    </button>
    <button class="pm-btn" onclick="nextTrack()" title="Следующий">
      <svg class="ui-icon lg" data-lucide="skip-forward" viewBox="0 0 24 24"></svg>
    </button>
    <button class="pm-btn-side" id="pm-shuffle-btn" onclick="toggleShuffleMode()" title="Перемешка"><svg class="ui-icon" data-lucide="shuffle" viewBox="0 0 24 24"></svg></button>
    <button type="button" class="pm-btn-side pm-speed-btn" id="pm-speed-btn" onclick="toggleHomeNxSpeedMenu(event)" title="Скорость"><svg class="ui-icon" data-lucide="gauge" viewBox="0 0 24 24"></svg></button>
    <button type="button" class="pm-btn-side pm-eq-btn" id="pm-eq-btn" onclick="toggleHomeNxEqMenu(event)" title="Фильтр / EQ"><svg class="ui-icon" data-lucide="sliders-vertical" viewBox="0 0 24 24"></svg></button>
    <button type="button" class="pm-btn-side hidden" onclick="dislikeCurrentYandexWaveTrack()" id="pm-wave-dislike-btn" title="Не нравится"><svg class="ui-icon" data-lucide="thumbs-down" viewBox="0 0 24 24"></svg></button>
    </div>`
  html = html.replace(/<div class="pm-controls-rail-bar">[\s\S]*?<\/div>\s*<\/div>\s*<div class="pm-volume-wrap">/, pmRail + `\n  </div>\n\n  <div class="pm-volume-wrap">`)
}

fs.writeFileSync(path.join(root, 'index.html'), html, 'utf8')
console.log('index.html patched v2.8.4')
