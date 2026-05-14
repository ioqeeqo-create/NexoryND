/**
 * Собирает renderer.js из фрагментов в каталоге renderer-src/ (по алфавиту имён).
 * Нужен потому, что несколько отдельных <script src> не делят let/const между файлами.
 * Запуск: node scripts/merge-renderer.js
 */
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const srcDir = path.join(root, 'renderer-src')
const outFile = path.join(root, 'renderer.js')

const files = fs
  .readdirSync(srcDir)
  .filter((f) => f.endsWith('.js'))
  .sort()

if (!files.length) {
  console.error('merge-renderer: нет .js в renderer-src/')
  process.exit(1)
}

const merged = files
  .map((name) => {
    const body = fs.readFileSync(path.join(srcDir, name), 'utf8')
    if (!body.endsWith('\n')) {
      console.warn('merge-renderer: добавлен перевод строки в конце', name)
      return body + '\n'
    }
    return body
  })
  .join('')

fs.writeFileSync(outFile, merged, 'utf8')
console.log('merge-renderer:', files.join(' + '), '→', path.relative(root, outFile), `(${merged.length} bytes)`)

// Сброс кэша Chromium/Electron: кроме хеша контента добавляем метку времени, чтобы ?v= менялся при каждом запуске
// merge (даже если бандл байт-в-байт тот же — иначе предзагрузка/дисковый кэш может оставить старый renderer).
const indexPath = path.join(root, 'index.html')
try {
  const html = fs.readFileSync(indexPath, 'utf8')
  const contentHash = crypto.createHash('sha256').update(merged).digest('hex').slice(0, 12)
  const runStamp = Date.now().toString(36)
  const cacheToken = `${contentHash}-${runStamp}`
  const replacement = `<script src="renderer.js?v=${cacheToken}"></script>`
  // Допускаем пробелы, одинарные кавычки, defer/async, относительный путь ./renderer.js
  const re =
    /<script\b[^>]*\bsrc\s*=\s*["'](?:\.\/)?renderer\.js(?:\?[^"']*)?["'][^>]*>\s*<\/script>/i
  const matches = html.match(re)
  const next = html.replace(re, replacement)
  if (matches && matches.length > 0) {
    if (next !== html) {
      fs.writeFileSync(indexPath, next, 'utf8')
      console.log('merge-renderer: index.html → renderer.js?v=' + cacheToken)
    } else {
      console.warn(
        'merge-renderer: тег renderer.js найден, но замена не изменила HTML — проверь index.html вручную.',
      )
    }
  } else {
    console.warn(
      'merge-renderer: в index.html не найден <script … src="…renderer.js…"> — пропуск кэш-баста. Запускай из каталога приложения (например flow_fixed): npm run merge-renderer',
    )
  }
} catch (e) {
  console.warn('merge-renderer: не удалось обновить кэш-баст в index.html:', e && e.message ? e.message : e)
}
