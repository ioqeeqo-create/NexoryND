import fs from 'node:fs'

const d = String.fromCharCode(100, 105, 118)
const path = 'index.html'
let html = fs.readFileSync(path, 'utf8')

const start = html.indexOf('<motion class="home-clone-controls home-clone-controls--nx">'.replace('motion', 'motion'))
const start2 = html.indexOf('<div class="home-clone-controls home-clone-controls--nx">')
const idx = start2 >= 0 ? start2 : start
if (idx < 0) throw new Error('controls block not found')
const end = html.indexOf('<div class="home-nx-vol-row', idx)
if (end < 0) throw new Error('vol row not found')

const block = `            <${d} class="home-clone-controls home-clone-controls--nx">
              <span id="host-lock-indicator-home" style="display:none;align-items:center;gap:4px;font-size:11px;opacity:.75;padding:0 4px">🔒 Host only</span>
              <${d} class="home-nx-ctrl-dock">
                <button type="button" class="ctrl-btn home-nx-aux-btn home-nx-only" onclick="findSimilarTracks()" title="Похожие треки"><svg class="ui-icon" data-lucide="download" viewBox="0 0 24 24"></svg></button>
                <${d} class="home-nx-ctrl-row">
                  <${d} class="home-nx-menu-wrap home-nx-ctrl-slot">
                    <button type="button" class="ctrl-btn home-nx-ctrl-btn home-nx-source-btn" id="home-nx-source-btn" onclick="toggleHomeNxSourceMenu(event)" title="Источник" aria-expanded="false"><img class="home-nx-src-logo" id="home-nx-src-logo" src="assets/auth/flow.svg" alt=""></button>
                    <${d} class="home-nx-dropdown home-nx-dropdown--up hidden" id="home-nx-source-menu" role="menu">
                      <button type="button" class="home-nx-src-opt" data-src="vk" onclick="pickHomeNxSource('vk')"><img src="assets/source-vk.png" alt=""><span>ВКонтакте</span></button>
                      <button type="button" class="home-nx-src-opt" data-src="yandex" onclick="pickHomeNxSource('yandex')"><img src="assets/source-yandex-music.png" alt=""><span>Яндекс</span></button>
                      <button type="button" class="home-nx-src-opt" data-src="hybrid" onclick="pickHomeNxSource('hybrid')"><img src="assets/auth/flow.svg" alt=""><span>Classic</span></button>
                    </${d}>
                  </${d}>
                  <button class="ctrl-btn" id="home-shuffle-btn" onclick="toggleShuffleMode()" title="Перемешка"><svg class="ui-icon flow-ref-ctrl" data-lucide="shuffle" viewBox="0 0 24 24"></svg></button>
                  <button class="ctrl-btn" onclick="prevTrack()"><svg class="ui-icon" data-lucide="skip-back" viewBox="0 0 24 24"></svg></button>
                  <button class="ctrl-btn play-btn" id="home-play-btn" onclick="togglePlay()"><svg class="ui-icon ctrl-play-icon" data-lucide="play" viewBox="0 0 24 24"></svg></button>
                  <button class="ctrl-btn" onclick="nextTrack()"><svg class="ui-icon" data-lucide="skip-forward" viewBox="0 0 24 24"></svg></button>
                  <button class="ctrl-btn" id="home-repeat-btn" onclick="toggleRepeatMode()" title="Повтор"><svg class="ui-icon flow-ref-ctrl" data-lucide="repeat" viewBox="0 0 24 24"></svg></button>
                  <${d} class="home-nx-menu-wrap home-nx-ctrl-slot">
                    <button type="button" class="ctrl-btn home-nx-ctrl-btn" id="home-nx-speed-btn" onclick="toggleHomeNxSpeedMenu(event)" title="Скорость" aria-expanded="false"><svg class="ui-icon" data-lucide="gauge" viewBox="0 0 24 24"></svg><span class="home-nx-ctrl-badge" id="home-nx-speed-badge">1×</span></button>
                    <${d} class="home-nx-dropdown home-nx-dropdown--up home-nx-speed-dropdown hidden" id="home-nx-speed-menu" role="dialog">
                      <${d} class="home-nx-speed-pills">
                        <button type="button" class="home-nx-speed-pill" data-rate="0.75" onclick="setPlaybackRate(0.75)">0.75×</button>
                        <button type="button" class="home-nx-speed-pill active" data-rate="1" onclick="setPlaybackRate(1)">1×</button>
                        <button type="button" class="home-nx-speed-pill" data-rate="1.25" onclick="setPlaybackRate(1.25)">1.25×</button>
                        <button type="button" class="home-nx-speed-pill" data-rate="1.5" onclick="setPlaybackRate(1.5)">1.5×</button>
                        <button type="button" class="home-nx-speed-pill" data-rate="2" onclick="setPlaybackRate(2)">2×</button>
                      </${d}>
                      <input type="range" class="home-nx-speed-slider" id="home-nx-speed-slider" min="0.75" max="2" step="0.05" value="1" oninput="setPlaybackRate(this.value)">
                    </${d}>
                  </${d}>
                  <${d} class="home-nx-menu-wrap home-nx-ctrl-slot home-nx-ctrl-slot--eq">
                    <button type="button" class="ctrl-btn home-nx-ctrl-btn" id="home-nx-eq-btn" onclick="toggleHomeNxEqMenu(event)" title="Эквалайзер" aria-expanded="false"><svg class="ui-icon" data-lucide="sliders-vertical" viewBox="0 0 24 24"></svg></button>
                    <${d} class="home-nx-dropdown home-nx-dropdown--up home-nx-eq-dropdown hidden" id="home-nx-eq-menu" role="dialog">
                      <${d} class="home-nx-eq-presets-row">
                        <button type="button" class="home-nx-eq-scroll-btn" id="home-nx-eq-scroll-l" title="Влево">‹</button>
                        <${d} class="home-nx-eq-presets" id="home-nx-eq-presets"></${d}>
                        <button type="button" class="home-nx-eq-scroll-btn" id="home-nx-eq-scroll-r" title="Вправо">›</button>
                        <button type="button" class="home-nx-eq-save-btn" id="home-nx-eq-save-btn" onclick="saveHomeNxEqForTrack(event)" title="Сохранить">+</button>
                      </${d}>
                      <${d} class="home-nx-eq-graph-wrap">
                        <svg class="home-nx-eq-graph" id="home-nx-eq-graph" viewBox="0 0 400 120" preserveAspectRatio="none"></svg>
                        <${d} class="home-nx-eq-freq-labels" id="home-nx-eq-freq-labels"></${d}>
                      </${d}>
                    </${d}>
                  </${d}>
                </${d}>
              </${d}>
              <button type="button" class="ctrl-btn home-nx-only hidden" id="home-wave-dislike-btn" onclick="dislikeCurrentYandexWaveTrack()" title="Не нравится"><svg class="ui-icon" data-lucide="thumbs-down" viewBox="0 0 24 24"></svg></button>
            </${d}>
            `

html = html.slice(0, idx) + block + html.slice(end)
fs.writeFileSync(path, html, 'utf8')
console.log('patched controls v2.8.1')
