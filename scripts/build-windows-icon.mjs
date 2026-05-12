/**
 * Собирает assets/icon.ico из assets/icon-source.png для exe/installer.
 * Перед ресайзом — trim по альфе, иначе большой прозрачный поле вокруг глифа
 * даёт крошечный знак в маленьких тайлах Windows / панели задач.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const src = path.join(root, 'assets', 'icon-source.png')
const out = path.join(root, 'assets', 'icon.ico')

if (!fs.existsSync(src)) {
  console.error('Missing', src)
  process.exit(1)
}

/** Тёмная подложка под панель задач Windows. */
const BG = { r: 12, g: 12, b: 16, alpha: 1 }

/** Средняя яркость непрозрачных пикселей (0–255). */
async function meanOpaqueLuminance(pngBuf) {
  const { data, info } = await sharp(pngBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (info.channels !== 4) return 200
  let sum = 0
  let n = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 14) continue
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    n++
  }
  return n ? sum / n : 200
}

/** Макс. яркость по непрозрачным — отличает «светлый знак на тёмном фоне» от тёмного глифа. */
async function maxOpaqueLuminance(pngBuf) {
  const { data, info } = await sharp(pngBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (info.channels !== 4) return 0
  let mx = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 14) continue
    const L = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    if (L > mx) mx = L
  }
  return mx
}

/** Убрать пустые поля по прозрачности — один раз на весь ICO. */
async function trimAlphaPng(pngBuf) {
  try {
    return await sharp(pngBuf).ensureAlpha().trim({ threshold: 12 }).png().toBuffer()
  } catch {
    return pngBuf
  }
}

async function renderIconPng(size, glyphSrcBuf) {
  // Чуть плотнее к краю кадра, чем раньше — в Start tile знак крупнее.
  const pad = Math.max(1, Math.round(size * 0.045))
  const inner = Math.max(4, size - pad * 2)

  let logoBuf = await sharp(glyphSrcBuf)
    .ensureAlpha()
    .resize(inner, inner, {
      fit: 'inside',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer()

  const lum = await meanOpaqueLuminance(logoBuf)
  const lumMax = await maxOpaqueLuminance(logoBuf)
  // Тёмный глиф на прозрачном / светлой подложке → инвертируем в светлый для тёмной titlebar.
  // Белый знак на чёрном (официальный Nexory) — средняя низкая, но пик яркий; не инвертировать.
  if (lum < 150 && lumMax < 198) {
    logoBuf = await sharp(logoBuf).negate({ alpha: false }).png().toBuffer()
  }

  let outSharp = sharp({
    create: { width: size, height: size, channels: 4, background: BG },
  }).composite([{ input: logoBuf, gravity: 'centre' }])

  if (size <= 32) {
    outSharp = outSharp.sharpen({ sigma: 0.48, m1: 1.1, m2: 0.24 })
  }

  return outSharp.png().toBuffer()
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexory-ico-'))
try {
  const srcPng = await sharp(src).ensureAlpha().png().toBuffer()
  const glyphSrcBuf = await trimAlphaPng(srcPng)

  const order = [16, 32, 48, 256]
  const paths = []
  for (const s of order) {
    const buf = await renderIconPng(s, glyphSrcBuf)
    const p = path.join(tmpDir, `icon-${s}.png`)
    fs.writeFileSync(p, buf)
    paths.push(p)
  }
  const buf = await pngToIco(paths)
  fs.writeFileSync(out, buf)
  console.log('Wrote', out, '(' + order.join(', ') + ')')
} finally {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch (_) {}
}
