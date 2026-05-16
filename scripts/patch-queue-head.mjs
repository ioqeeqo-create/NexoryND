import fs from 'node:fs'

const d = String.fromCharCode(100, 105, 118)
let h = fs.readFileSync('index.html', 'utf8')
const start = h.indexOf('<motion class="home-up-next-head">'.replace('motion', 'motion'))
const start2 = h.indexOf('<div class="home-up-next-head">')
const idx = start2 >= 0 ? start2 : start
if (idx < 0) throw new Error('head not found')
const end = h.indexOf('<div class="home-up-next-list"', idx)
if (end < 0) throw new Error('list not found')
const block = `          <${d} class="home-up-next-head">\n            <${d} class="home-up-next-badge">Дальше в очереди</${d}>\n          </${d}>\n          `
h = h.slice(0, idx) + block + h.slice(end)
h = h.replace(/<\/?motion\b[^>]*>/g, (tag) => tag.replace(/motion/g, d))
fs.writeFileSync('index.html', h, 'utf8')
console.log('queue head patched')
