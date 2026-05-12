/**
 * Импорт мастер-лого Nexory: обрезка снизу + квадрат 1024 на прозрачном фоне (иконка без белых полос).
 * nexory-mark-ui.png — белый силуэт на прозрачном для тёмного UI (без CSS filter).
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
  'c__Users_Trankvilizator_AppData_Roaming_Cursor_User_workspaceStorage_2c8d2eb933a247bf3cbe75832c0da375_images_image-6e8709fa-33c1-4949-82ac-ce8659705e6e.png',
)

const SQ = 1024
/** Иконка приложения: без белых полос — глиф на прозрачном квадрате (ico кладётся на тёмный BG в build-windows-icon). */
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 }
/** Доля высоты, срезаемая снизу (пустое поле под знаком). */
const BOTTOM_CROP_RATIO = 0.11

/** Любой непрозрачный пиксель → белый с той же альфой (для тёмного UI без CSS invert). */
async function toWhiteOnTransparent(pngBuf) {
  const { data, info } = await sharp(pngBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  const out = Buffer.alloc(data.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels
      const a = data[i + 3]
      if (a < 6) {
        out[i] = 0
        out[i + 1] = 0
        out[i + 2] = 0
        out[i + 3] = 0
      } else {
        out[i] = 255
        out[i + 1] = 255
        out[i + 2] = 255
        out[i + 3] = a
      }
    }
  }
  return sharp(out, { raw: { width, height, channels: 4 } }).png().toBuffer()
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

  const squareTrans = await sharp({
    create: { width: SQ, height: SQ, channels: 4, background: TRANSPARENT },
  })
    .composite([{ input: cropped, gravity: 'centre' }])
    .png()
    .toBuffer()

  const outIcon = path.join(root, 'assets', 'icon-source.png')
  const outMark = path.join(root, 'assets', 'nexory-mark.png')
  const outAuth = path.join(root, 'assets', 'auth', 'flow.png')

  fs.writeFileSync(outIcon, squareTrans)
  fs.writeFileSync(outMark, squareTrans)
  fs.writeFileSync(outAuth, squareTrans)

  /** Шапка/сайдбар: обрезка по содержимому, без белого квадрата; светлый силуэт в PNG (без filter в CSS). */
  const outUi = path.join(root, 'assets', 'nexory-mark-ui.png')
  let uiBuf
  try {
    const trimmed = sharp(cropped).trim({ threshold: 24 })
    const tm = await trimmed.metadata()
    const pad = Math.max(4, Math.round(Math.max(tm.width || 0, tm.height || 0) * 0.05))
    const padded = await trimmed
      .extend({
        top: pad,
        bottom: pad,
        left: pad,
        right: pad,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer()
    uiBuf = await toWhiteOnTransparent(padded)
  } catch (_) {
    uiBuf = await toWhiteOnTransparent(squareTrans)
  }
  fs.writeFileSync(outUi, uiBuf)

  console.log('OK', { src, was: `${W}×${H}`, cropBottom, out: `${SQ}×${SQ} transparent + ui white silhouette` })
  console.log('Wrote', outIcon, outMark, outAuth, outUi)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
