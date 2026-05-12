/**
 * Импорт мастер-лого NexoryND: квадрат 1024 на прозрачном фоне + UI-mark.
 * На тёмном фоне мастера не применяем stripLightMatte (иначе съедается белый знак).
 * Использование: node scripts/prepare-nexory-logo.mjs [путь-к-исходнику.png]
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

const DEFAULT_SRC = path.join(
  process.env.USERPROFILE || '',
  '.cursor',
  'projects',
  'c-Users-Trankvilizator-Documents-Codex-2026-04-21-files-mentioned-by-the-user-flow-fresh-extract2',
  'assets',
  'c__Users_Trankvilizator_AppData_Roaming_Cursor_User_workspaceStorage_2c8d2eb933a247bf3cbe75832c0da375_images_image-e50c2c3f-b9f9-432a-a62f-27996b38f23c.png',
)

const SQ = 1024
/** Иконка приложения: без белых полос — глиф на прозрачном квадрате (ico кладётся на тёмный BG в build-windows-icon). */
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 }
/** Доля высоты, срезаемая снизу (0 = не трогать квадратный арт). */
const BOTTOM_CROP_RATIO = 0

/** Убирает почти белые/светло-серые «плашки» (низкая насыщенность), оставляя сам знак. */
async function stripLightMatte(pngBuf) {
  const { data, info } = await sharp(pngBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  if (channels !== 4) throw new Error('expected RGBA')
  const out = Buffer.from(data)
  const minLum = 232
  const maxSat = 44
  for (let i = 0; i < out.length; i += 4) {
    const r = out[i]
    const g = out[i + 1]
    const b = out[i + 2]
    const a = out[i + 3]
    if (a < 6) continue
    const mx = Math.max(r, g, b)
    const mn = Math.min(r, g, b)
    const sat = mx - mn
    const lum = 0.299 * r + 0.587 * g + 0.114 * b
    if (lum >= minLum && sat <= maxSat) {
      out[i] = 0
      out[i + 1] = 0
      out[i + 2] = 0
      out[i + 3] = 0
    }
  }
  return sharp(out, { raw: { width, height, channels: 4 } }).png().toBuffer()
}

async function hasVisibleContent(pngBuf) {
  const s = await sharp(pngBuf).stats()
  const ch = s.channels
  if (ch.length < 4) return true
  return ch[3].mean > 1.2
}

/** Средняя яркость по углам (если тёмная — мастер «белое на чёрном», без dematte). */
async function avgCornerLuminance(pngBuf, edge = 32) {
  const m = await sharp(pngBuf).metadata()
  const w = m.width || 1
  const h = m.height || 1
  const s = Math.min(edge, Math.floor(w / 4), Math.floor(h / 4), 48)
  if (s < 2) return 200
  const regions = [
    { left: 0, top: 0, width: s, height: s },
    { left: w - s, top: 0, width: s, height: s },
    { left: 0, top: h - s, width: s, height: s },
    { left: w - s, top: h - s, width: s, height: s },
  ]
  let sum = 0
  let n = 0
  for (const r of regions) {
    const { data, info } = await sharp(pngBuf)
      .extract(r)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (info.channels !== 4) continue
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 20) continue
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
      n++
    }
  }
  return n ? sum / n : 200
}

const LOCAL_MASTER = path.join(root, 'assets', '_nexory-master-in.png')

function resolveSrc() {
  const arg = process.argv[2]
  if (arg && fs.existsSync(arg)) return path.resolve(arg)
  if (fs.existsSync(LOCAL_MASTER)) return LOCAL_MASTER
  if (fs.existsSync(DEFAULT_SRC)) return DEFAULT_SRC
  console.error('Укажи путь к PNG: node scripts/prepare-nexory-logo.mjs <файл.png>')
  console.error('Или положи мастер в', LOCAL_MASTER)
  console.error('Ожидался также:', DEFAULT_SRC)
  process.exit(1)
}

async function main() {
  const src = resolveSrc()
  const meta = await sharp(src).metadata()
  const W = meta.width || SQ
  const H = meta.height || SQ
  const cropBottom = Math.min(Math.round(H * BOTTOM_CROP_RATIO), H - 2)
  const newH = H - cropBottom

  const cropped = await sharp(src)
    .extract({ left: 0, top: 0, width: W, height: newH })
    .png()
    .toBuffer()

  const croppedPng = await sharp(cropped).png().toBuffer()
  let forIcon = croppedPng
  const cornerLum = await avgCornerLuminance(croppedPng)
  if (cornerLum > 88) {
    try {
      const dem = await stripLightMatte(croppedPng)
      if (await hasVisibleContent(dem)) forIcon = dem
    } catch (_) {
      /* оставляем cropped */
    }
  }

  const squareTrans = await sharp({
    create: { width: SQ, height: SQ, channels: 4, background: TRANSPARENT },
  })
    .composite([{ input: forIcon, gravity: 'centre' }])
    .png()
    .toBuffer()

  /** Для icon-source / ICO: trim + крупный масштаб в кадре — иначе в Start tile крошечная «точка». */
  async function packGlyphForShellIcon(pngBuf) {
    let tight
    try {
      tight = await sharp(pngBuf).trim({ threshold: 12 }).png().toBuffer()
    } catch {
      tight = pngBuf
    }
    const target = Math.round(SQ * 0.9)
    const scaled = await sharp(tight)
      .resize(target, target, {
        fit: 'inside',
        background: TRANSPARENT,
      })
      .png()
      .toBuffer()
    return sharp({
      create: { width: SQ, height: SQ, channels: 4, background: TRANSPARENT },
    })
      .composite([{ input: scaled, gravity: 'centre' }])
      .png()
      .toBuffer()
  }

  const packedIconSource = await packGlyphForShellIcon(forIcon)

  const outIcon = path.join(root, 'assets', 'icon-source.png')
  const outMark = path.join(root, 'assets', 'nexory-mark.png')
  const outAuth = path.join(root, 'assets', 'auth', 'nexory.png')
  const outMarkLogin = path.join(root, 'assets', 'auth', 'mark-login.png')

  fs.writeFileSync(outIcon, packedIconSource)
  fs.writeFileSync(outMark, squareTrans)
  fs.writeFileSync(outAuth, squareTrans)
  fs.writeFileSync(outMarkLogin, squareTrans)

  /** UI: tight trim по альфе, без принудительной заливки в белый (иначе «белый прямоугольник»). */
  const outUi = path.join(root, 'assets', 'nexory-mark-ui.png')
  let uiBuf
  try {
    const tmeta = await sharp(forIcon).trim({ threshold: 12 }).metadata()
    const pad = Math.max(
      4,
      Math.round(Math.max(tmeta.width || 0, tmeta.height || 0) * 0.05),
    )
    uiBuf = await sharp(forIcon)
      .trim({ threshold: 12 })
      .extend({
        top: pad,
        bottom: pad,
        left: pad,
        right: pad,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer()
  } catch (_) {
    uiBuf = forIcon
  }
  fs.writeFileSync(outUi, uiBuf)

  console.log('OK', {
    src,
    was: `${W}×${H}`,
    cropBottom,
    cornerLum: Math.round(cornerLum),
    out: `${SQ}×${SQ} transparent + ui trim`,
  })
  console.log('Wrote', outIcon, outMark, outAuth, outMarkLogin, outUi)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
