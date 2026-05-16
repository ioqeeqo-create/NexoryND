import fs from 'node:fs'
import path from 'node:path'

const cssPath = path.join(path.resolve(import.meta.dirname, '..'), 'styles.css')
let css = fs.readFileSync(cssPath, 'utf8')

if (css.includes('/* v284 */')) {
  console.log('v284 css already present')
  process.exit(0)
}

const block = `
/* v284 */
.nx-search-shell {
  padding: 12px 14px 10px;
  border-radius: 16px;
  margin-bottom: 16px;
  border: 1px solid rgba(255,255,255,0.1);
  background: color-mix(in srgb, var(--glass-bg) 55%, rgba(8,10,18,0.72));
}
.nx-search-top-row {
  display: flex;
  align-items: center;
  gap: 10px;
  position: relative;
}
.nx-search-input-wrap {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 42px;
  padding: 0 12px;
  border-radius: 12px;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.08);
}
.nx-search-input-wrap input {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 14px;
  outline: none;
  font-family: var(--font-ui);
}
.nx-search-clear {
  border: none;
  background: transparent;
  color: rgba(255,255,255,0.55);
  cursor: pointer;
  padding: 4px;
  display: inline-flex;
}
.nx-search-clear.hidden { display: none !important; }
.nx-search-src-btn {
  width: 42px;
  height: 42px;
  border-radius: 12px;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(255,255,255,0.06);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
}
.nx-search-src-logo { width: 22px; height: 22px; object-fit: contain; }
.nx-search-src-pop {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 40;
  min-width: 180px;
  padding: 6px;
  border-radius: 12px;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(12,14,22,0.94);
  backdrop-filter: blur(14px);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.nx-search-src-pop.hidden { display: none !important; }
.nx-search-src-opt {
  display: flex;
  align-items: center;
  gap: 10px;
  border: none;
  background: transparent;
  color: #fff;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
}
.nx-search-src-opt img { width: 20px; height: 20px; object-fit: contain; filter: grayscale(1) brightness(1.35); opacity: 0.9; }
.nx-search-src-opt:hover { background: rgba(255,255,255,0.08); }
.nx-search-divider {
  height: 1px;
  margin: 10px 0 8px;
  background: rgba(255,255,255,0.08);
}
.nx-search-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: center;
}
.nx-search-filter {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: transparent;
  color: rgba(255,255,255,0.62);
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 999px;
  cursor: pointer;
  transition: background 0.16s ease, color 0.16s ease;
}
.nx-search-filter.active {
  background: rgba(255,255,255,0.92);
  color: #0a0c12;
}
.nx-search-filter .ui-icon { width: 14px; height: 14px; }
.content-header--search { margin-bottom: 10px; }

.nx-src-mono,
.home-nx-src-logo,
.pm-source-btn .home-nx-src-logo,
.nx-search-src-logo {
  filter: grayscale(1) brightness(1.2) contrast(0.95);
  opacity: 0.88;
}
.home-nx-src-opt img,
.nx-search-src-opt img {
  filter: grayscale(1) brightness(1.25);
  opacity: 0.9;
}
.home-nx-source-btn.home-nx-source-btn--pulse img,
.pm-source-btn.home-nx-source-btn--pulse img {
  animation: nx-src-pop 0.42s var(--ease-flow);
}
@keyframes nx-src-pop {
  0% { transform: scale(0.82); opacity: 0.35; }
  55% { transform: scale(1.08); opacity: 1; }
  100% { transform: scale(1); opacity: 0.88; }
}
.home-nx-dropdown .home-nx-src-opt {
  animation: nx-src-opt-in 0.28s var(--ease-flow) both;
}
.home-nx-dropdown .home-nx-src-opt:nth-child(1) { animation-delay: 0ms; }
.home-nx-dropdown .home-nx-src-opt:nth-child(2) { animation-delay: 40ms; }
.home-nx-dropdown .home-nx-src-opt:nth-child(3) { animation-delay: 80ms; }
@keyframes nx-src-opt-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
.track-source-mono {
  display: inline-flex;
  align-items: center;
  padding: 0;
  background: transparent !important;
  border: none !important;
}
.track-source-mono img {
  width: 18px;
  height: 18px;
  object-fit: contain;
  filter: grayscale(1) brightness(1.25);
  opacity: 0.88;
}
.player-track-source-inline .track-source-mono img { width: 16px; height: 16px; }

.home-up-next {
  background: color-mix(in srgb, var(--glass-bg) 28%, rgba(8,10,18,0.42)) !important;
  border-color: rgba(255,255,255,0.07) !important;
}
.home-up-next-item {
  background: color-mix(in srgb, var(--glass-bg) 22%, rgba(10,12,20,0.55)) !important;
  border-color: rgba(255,255,255,0.08) !important;
}

.home-nx-cover-expand-btn {
  background: transparent !important;
  opacity: 0;
}
.home-clone-cover-wrap:hover .home-nx-cover-expand-btn {
  opacity: 1;
  background: radial-gradient(ellipse 72% 72% at 50% 50%, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.38) 52%, transparent 78%) !important;
}
.home-nx-cover-fs-label { display: none !important; }
.home-nx-cover-fs-min {
  width: 28px;
  height: 28px;
  opacity: 0.92;
  filter: drop-shadow(0 2px 8px rgba(0,0,0,0.45));
}
#page-home:not(.media-queue-off) .home-nx-cover-actions {
  left: 14px;
  right: 14px;
  bottom: 14px;
}
.home-nx-row-like { display: none; }
#page-home.media-queue-off .home-nx-row-like { display: inline-flex; }
#page-home.media-queue-off .home-nx-cover-actions { display: none; }

#page-home.media-queue-off .home-clone-progress-wrap input,
#page-home #home-clone-progress.home-slider-ios {
  height: 4px;
}
#page-home #home-clone-progress.home-slider-ios::-webkit-slider-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #f2f2f2;
  border: none;
  box-shadow: 0 0 0 1px rgba(0,0,0,0.35);
}
#page-home.media-queue-off .home-nx-vol-row {
  max-width: min(72%, 420px);
  margin-inline: auto;
}
#page-home.media-queue-off .home-nx-vol-row .ui-icon {
  width: 14px;
  height: 14px;
}
#page-home.media-queue-off .home-clone-title { font-size: clamp(20px, 2.2vw, 26px); }
#page-home.media-queue-off .home-clone-artist { font-size: 13px; }
#page-home.media-queue-off .home-clone-controls .ctrl-btn:not(.play-btn) {
  width: 38px;
  height: 38px;
}
#page-home.media-queue-off .home-clone-controls .play-btn {
  width: 48px;
  height: 48px;
}

.pm-cover {
  width: min(calc(280px / max(0.72, var(--ui-scale, 1))), 44vmin, 82vw) !important;
  max-width: min(340px, 94vw) !important;
}
@media (min-width: 900px) {
  .pm-cover {
    width: min(calc(300px / max(0.72, var(--ui-scale, 1))), 46vmin, 82vw) !important;
    max-width: min(380px, 94vw) !important;
  }
}
.pm-title { font-size: clamp(18px, 2.2vw, 24px) !important; }
.pm-artist { font-size: 13px !important; }
.pm-progress { height: 4px !important; }
.pm-time { font-size: 10px !important; min-width: 34px !important; }
.pm-btn { width: 40px !important; height: 40px !important; }
.pm-btn-side { font-size: 17px !important; padding: 6px !important; }
.pm-play { width: 54px !important; height: 54px !important; }
.pm-play #pm-play-icon, .pm-play .ctrl-play-icon { width: 28px !important; height: 28px !important; }
.pm-volume-wrap {
  max-width: min(68%, 380px) !important;
  margin-inline: auto !important;
  gap: 8px !important;
}
.pm-volume-wrap .flow-vol-icon { width: 14px !important; height: 14px !important; }
.pm-volume { height: 2px !important; }

.vs-slider-style-block { display: flex; flex-direction: column; gap: 10px; width: 100%; }
.vs-slider-preview {
  position: relative;
  width: 100%;
  max-width: 360px;
  height: 88px;
  border-radius: 12px;
  border: 1px solid rgba(255,255,255,0.12);
  background: linear-gradient(180deg, rgba(18,22,34,0.9), rgba(8,10,16,0.95));
  overflow: hidden;
}
.vs-slider-preview canvas {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 22px;
  width: calc(100% - 24px);
  height: 42px;
}
.vs-slider-preview-title {
  position: absolute;
  top: 10px;
  left: 0;
  right: 0;
  text-align: center;
  font-family: var(--font-title);
  font-size: 11px;
  letter-spacing: 0.12em;
  color: rgba(255,255,255,0.92);
}
.vs-slider-preview-time {
  position: absolute;
  bottom: 8px;
  font-size: 9px;
  color: rgba(255,255,255,0.72);
  font-family: var(--font-title);
}
.vs-slider-preview-time--l { left: 12px; }
.vs-slider-preview-time--r { right: 12px; }
`

fs.appendFileSync(cssPath, block, 'utf8')
console.log('v284 css appended')
