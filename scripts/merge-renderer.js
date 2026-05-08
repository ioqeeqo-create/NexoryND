/**
 * Собирает renderer.js из фрагментов в каталоге renderer-src/ (по алфавиту имён).
 * Нужен потому, что несколько отдельных <script src> не делят let/const между файлами.
 * Запуск: node scripts/merge-renderer.js
 */
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
