/**
 * Импорт мастер-лого Nexory: обрезка снизу (лишнее поле) + квадрат 1024 с центрированием.
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
/** Квадратные экспорты (иконка, марк, auth) — белый фон, без «чёрной подложки». */
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 }
/** Доля высоты, срезаемая снизу (пустое поле под знаком). */
const BOTTOM_CROP_RATIO = 0.11

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

  const square = await sharp({
    create: { width: SQ, height: SQ, channels: 4, background: WHITE },
  })
    .composite([{ input: cropped, gravity: 'centre' }])
    .png()
    .toBuffer()

  const outIcon = path.join(root, 'assets', 'icon-source.png')
  const outMark = path.join(root, 'assets', 'nexory-mark.png')
  const outAuth = path.join(root, 'assets', 'auth', 'flow.png')

  fs.writeFileSync(outIcon, square)
  fs.writeFileSync(outMark, square)
  fs.writeFileSync(outAuth, square)

  /** В шапке/сайдбаре — без огромных полей, иначе при 20px «знак» исчезает. */
  const outUi = path.join(root, 'assets', 'nexory-mark-ui.png')
  let uiBuf
  try {
    const trimmed = sharp(square).trim({ threshold: 24 })
    const tm = await trimmed.metadata()
    const pad = Math.max(4, Math.round(Math.max(tm.width || 0, tm.height || 0) * 0.05))
    uiBuf = await trimmed
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
    uiBuf = square
  }
  fs.writeFileSync(outUi, uiBuf)

  console.log('OK', { src, was: `${W}×${H}`, cropBottom, out: `${SQ}×${SQ}` })
  console.log('Wrote', outIcon, outMark, outAuth, outUi)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
