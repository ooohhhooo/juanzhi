// 把设计稿 PNG 转成打包用的 JPEG（质量 85）：node scripts/convert-card-templates.cjs <源目录>
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const src = process.argv[2]
if (!src) { console.error('用法：node scripts/convert-card-templates.cjs <含 s01.png … p10.png 的目录>'); process.exit(1) }
const out = path.join(__dirname, '..', 'resources', 'card-templates')
fs.mkdirSync(out, { recursive: true })
for (const a of ['s', 'p']) {
  for (let i = 1; i <= 10; i++) {
    const id = a + String(i).padStart(2, '0')
    const dst = path.join(out, id + '.jpg')
    execFileSync('/usr/bin/sips', ['--resampleWidth', '1086', '-s', 'format', 'jpeg', '-s', 'formatOptions', '85', path.join(src, id + '.png'), '--out', dst], { stdio: 'ignore' })
    console.log(id, fs.statSync(dst).size)
  }
}
