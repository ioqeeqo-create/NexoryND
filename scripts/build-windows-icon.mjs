/**
 * Собирает assets/icon.ico из assets/icon-source.png для exe/installer.
 * Для 16×32 px в панели задач: поля вокруг глифа + отдельные кадры 16/32/48/256.
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

/** Тёмная подложка как у нормальных Win-иконок (не «серый квадрат» на панели). */
const BG = { r: 14, g: 14, b: 18, alpha: 1 }

async function renderIconPng(size) {
  const pad = Math.max(2, Math.round(size * 0.17))
  const inner = Math.max(4, size - pad * 2)

  const logoBuf = await sharp(src)
    .ensureAlpha()
    .resize(inner, inner, {
      fit: 'inside',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer()

  let outSharp = sharp({
    create: { width: size, height: size, channels: 4, background: BG },
  }).composite([{ input: logoBuf, gravity: 'centre' }])

  if (size <= 32) {
    outSharp = outSharp.sharpen({ sigma: 0.55, m1: 1.15, m2: 0.28 })
  }

  return outSharp.png().toBuffer()
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexory-ico-'))
try {
  const order = [16, 32, 48, 256]
  const paths = []
  for (const s of order) {
    const buf = await renderIconPng(s)
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
