import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const cssPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles.css')
let css = fs.readFileSync(cssPath, 'utf8')
if (css.includes('/* v300 */')) {
  console.log('already')
  process.exit(0)
}

const block = `
/* v300 — wave slider seek hit area, visible back button */
body.flow-slider-style-wave #home-clone-progress.home-slider-wave-active,
body.flow-slider-style-wave #pm-progress.home-slider-wave-active {
  height: 42px !important;
  min-height: 42px !important;
  flex: 1 1 auto !important;
}
body.flow-slider-style-wave .flow-slider-host--wave {
  position: relative !important;
  height: 42px !important;
  min-height: 42px !important;
}
body.flow-slider-style-wave .flow-slider-host--wave input[type="range"] {
  position: absolute !important;
  inset: 0 !important;
  width: 100% !important;
  height: 100% !important;
  margin: 0 !important;
  z-index: 4 !important;
  opacity: 0.01 !important;
  pointer-events: auto !important;
  cursor: pointer !important;
  -webkit-appearance: none !important;
  appearance: none !important;
}
body.flow-slider-style-wave .flow-slider-host--wave .home-slider-wave-canvas {
  z-index: 2 !important;
  pointer-events: none !important;
}

.pm-close {
  z-index: 30 !important;
  top: 48px !important;
  left: 16px !important;
  width: auto !important;
  min-width: 40px !important;
  height: 40px !important;
  padding: 0 14px 0 10px !important;
  gap: 6px !important;
  border-radius: 999px !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  font-size: 13px !important;
  font-weight: 500 !important;
  color: var(--text) !important;
  pointer-events: auto !important;
}
.pm-close-label {
  line-height: 1;
  letter-spacing: 0.01em;
}
`

fs.appendFileSync(cssPath, block)
console.log('appended v300 css')
