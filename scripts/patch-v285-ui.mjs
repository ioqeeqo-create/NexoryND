import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

// index.html — controls + volume +
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')

html = html.replace(/ nx-src-mono/g, '')

html = html.replace(
  /<button type="button" class="ctrl-btn home-nx-row-like" id="home-nx-row-like-btn"[\s\S]*?<\/button>\s*<button class="ctrl-btn" onclick="prevTrack\(\)">/,
  `<button type="button" class="ctrl-btn home-nx-row-like" id="home-nx-row-like-btn" onclick="likeCurrentTrack()" title="Лайк"><svg class="ui-icon flow-ref-heart-player" data-lucide="heart" viewBox="0 0 24 24"></svg></button>
                  <button type="button" class="ctrl-btn home-nx-row-dislike" id="home-nx-row-dislike-btn" onclick="dislikeCurrentYandexWaveTrack()" title="Не нравится"><svg class="ui-icon" data-lucide="thumbs-down" viewBox="0 0 24 24"></svg></button>
                  <button class="ctrl-btn" onclick="prevTrack()">`
)

html = html.replace(
  /<div class="home-nx-vol-row" id="home-nx-vol-row">\s*<svg[\s\S]*?<span class="home-nx-vol-val" id="home-nx-vol-val">8<\/span>\s*<\/div>/,
  `<div class="home-nx-vol-row" id="home-nx-vol-row">
              <svg class="ui-icon" data-lucide="volume-2" viewBox="0 0 24 24" aria-hidden="true"></svg>
              <input type="range" class="home-nx-volume" id="home-nx-volume" min="0" max="1" step="0.01" value="0.8" oninput="setVolume(this.value)">
              <button type="button" class="home-nx-vol-add-btn" onclick="addCurrentTrackToPlaylist()" title="Добавить в плейлист"><svg class="ui-icon" data-lucide="plus" viewBox="0 0 24 24"></svg></button>
              <span class="home-nx-vol-val" id="home-nx-vol-val">8</span>
            </div>`
)

html = html.replace(
  /<div class="pm-controls-rail-bar">[\s\S]*?<\/motion>\s*<\/motion>\s*<div class="pm-volume-wrap">/.test(html)
    ? null
    : null
)

const pmRail = `<motion class="pm-controls-rail-bar">
    <button type="button" class="pm-btn-side" id="pm-like-btn" onclick="likeCurrentTrack()" title="Лайк"><svg class="ui-icon flow-ref-heart-player" data-lucide="heart" viewBox="0 0 24 24"></svg></button>
    <button type="button" class="pm-btn-side" id="pm-dislike-btn" onclick="dislikeCurrentYandexWaveTrack()" title="Не нравится"><svg class="ui-icon" data-lucide="thumbs-down" viewBox="0 0 24 24"></svg></button>
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
    </motion>`.replace(/<motion /g, '<div ').replace(/<\/motion>/g, '</div>')

html = html.replace(
  /<div class="pm-controls-rail-bar">[\s\S]*?<\/div>\s*<\/div>\s*<motion class="pm-volume-wrap">/.source
  ? /<div class="pm-controls-rail-bar">[\s\S]*?<\/motion>\s*<\/motion>\s*<div class="pm-volume-wrap">/
  : /<div class="pm-controls-rail-bar">[\s\S]*?<\/div>\s*<\/div>\s*<div class="pm-volume-wrap">/,
  pmRail + `\n  </div>\n\n  <div class="pm-volume-wrap">`
)

html = html.replace(
  /<div class="pm-volume-wrap">\s*<svg class="flow-vol-icon[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<\/motion>\s*<aside class="pm-glass-window pm-win-next/,
  (m) => {
    if (m.includes('pm-vol-add-btn')) return m
    return `<div class="pm-volume-wrap">
    <svg class="flow-vol-icon ui-icon md" data-lucide="volume-2" viewBox="0 0 24 24" style="opacity:0.75;flex-shrink:0"></svg>
    <input type="range" class="pm-volume" min="0" max="1" step="0.01" value="0.8" oninput="setVolume(this.value)" id="pm-volume">
    <button type="button" class="pm-vol-add-btn" onclick="addCurrentTrackToPlaylist()" title="Добавить в плейлист"><svg class="ui-icon" data-lucide="plus" viewBox="0 0 24 24"></svg></button>
    <svg class="flow-vol-icon ui-icon md" data-lucide="volume-2" viewBox="0 0 24 24" style="opacity:0.75;flex-shrink:0"></svg>
  </div>
  </div>
  </motion>
  <aside class="pm-glass-window pm-win-next`
      .replace(/<\/motion>\s*<aside/, '</div>\n  </motion>\n  <aside')
      .replace('  </motion>\n  <aside', '  </div>\n  </div>\n  <aside')
  }
)

fs.writeFileSync(path.join(root, 'index.html'), html.replace(/<\/motion>\s*<aside class="pm-glass-window/, '</motion>\n  <aside class="pm-glass-window').replace(/  <\/motion>\n  <aside/, '  </div>\n  <aside'), 'utf8')

// CSS append
const cssPath = path.join(root, 'styles.css')
let css = fs.readFileSync(cssPath, 'utf8')
if (!css.includes('/* v285 */')) {
  css += `
/* v285 */
.nx-src-mono, .home-nx-src-logo, .pm-source-btn .home-nx-src-logo, .nx-search-src-logo {
  filter: none !important;
  opacity: 1 !important;
}
.home-nx-src-opt img, .nx-search-src-opt img { filter: none !important; opacity: 1 !important; }

.search-entity-row {
  width: 100%;
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr) auto auto;
  gap: 10px;
  align-items: center;
  padding: 8px 10px;
  border-radius: 12px;
  border: 1px solid rgba(255,255,255,0.1);
  background: color-mix(in srgb, var(--glass-bg) 34%, rgba(8,10,18,0.72));
  color: var(--text);
  cursor: pointer;
  text-align: left;
}
.search-entity-row:hover { border-color: rgba(255,255,255,0.18); }
.search-entity-cover {
  width: 52px;
  height: 52px;
  border-radius: 10px;
  background-size: cover;
  background-position: center;
}
.search-entity-meta { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.search-entity-meta strong { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.search-entity-meta span { font-size: 12px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.search-entity-kind { font-size: 11px; color: rgba(255,255,255,0.55); }
.search-entity-src .track-source { margin: 0; }

#page-home.media-queue-off .home-nx-ctrl-row {
  justify-content: center;
  width: 100%;
  max-width: min(100%, 560px);
  margin-inline: auto;
}
#page-home.media-queue-off .home-nx-ctrl-dock {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
}
.home-nx-row-dislike { display: none; }
#page-home.media-queue-off .home-nx-row-dislike { display: inline-flex; }

.home-nx-vol-add-btn,
.pm-vol-add-btn {
  width: 32px;
  height: 32px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.16);
  background: rgba(255,255,255,0.08);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
}
.home-nx-vol-add-btn:hover,
.pm-vol-add-btn:hover { background: rgba(255,255,255,0.16); }

.pm-controls-rail-bar {
  justify-content: center !important;
  gap: clamp(4px, 1.2vw, 14px) !important;
  max-width: min(100%, 420px);
  margin-inline: auto;
}
.pm-meta-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  width: 100%;
}
.pm-meta-zone .pm-info,
.pm-meta-zone .pm-progress-wrap,
.pm-meta-zone .pm-controls,
.pm-meta-zone .pm-volume-wrap {
  width: 100%;
  max-width: min(100%, 420px);
  margin-inline: auto;
}
.pm-source-row .track-source { margin-top: 4px; }
#pm-dislike-btn.hidden, #home-nx-row-dislike-btn.hidden { display: none !important; }
`
  fs.writeFileSync(cssPath, css, 'utf8')
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
pkg.version = '2.8.5'
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 4) + '\n', 'utf8')

console.log('v285 ui patched')
