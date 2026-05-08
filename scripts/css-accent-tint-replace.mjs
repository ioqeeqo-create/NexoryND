/**
 * Одиночный прогон: фиолетовые/розовые rgba в styles.css → color-mix + var(--accent/--accent2).
 * Удалить скрипт после применения или оставить для повторного использования.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const cssPath = path.join(__dirname, '..', 'styles.css')

let s = fs.readFileSync(cssPath, 'utf8')

function repRgb(s, r, g, b, varName) {
  const re = new RegExp(
    `rgba\\(\\s*${r}\\s*,\\s*${g}\\s*,\\s*${b}\\s*,\\s*([0-9.]+)\\s*\\)`,
    'gi',
  )
  return s.replace(re, (_, alpha) => {
    const p = Math.min(100, Math.max(0, Math.round(parseFloat(alpha) * 100)))
    return `color-mix(in srgb, var(${varName}) ${p}%, transparent)`
  })
}

s = repRgb(s, 124, 58, 237, '--accent')
s = repRgb(s, 59, 130, 246, '--accent2')
s = repRgb(s, 168, 85, 247, '--accent2')
s = repRgb(s, 236, 72, 153, '--accent2')
s = repRgb(s, 139, 92, 246, '--accent')
s = repRgb(s, 192, 181, 255, '--accent2')
s = repRgb(s, 145, 70, 255, '--accent')
s = repRgb(s, 216, 189, 255, '--accent2')
s = repRgb(s, 235, 229, 255, '--accent2')
s = repRgb(s, 237, 219, 255, '--accent2')
s = repRgb(s, 220, 208, 255, '--accent2')
s = repRgb(s, 230, 224, 255, '--accent2')

fs.writeFileSync(cssPath, s)
console.log('Updated', cssPath)
