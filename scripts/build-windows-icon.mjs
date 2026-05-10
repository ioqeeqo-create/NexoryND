/**
 * Собирает assets/icon.ico из assets/icon-source.png (256×, cover) для exe/installer.
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-ico-'))
const tmpPng = path.join(tmpDir, 'icon-256.png')

try {
  await sharp(src)
    .resize(256, 256, { fit: 'cover', position: 'centre' })
    .png()
    .toFile(tmpPng)
  const buf = await pngToIco(tmpPng)
  fs.writeFileSync(out, buf)
  console.log('Wrote', out)
} finally {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch (_) {}
}
