// 把设计稿 PNG 转成打包用的 JPEG（质量默认 85，可用第二个参数指定，宽 1086）并生成 resources/card-templates/manifest.json 里的模板清单：
//   node scripts/convert-card-templates.cjs <含 manifest-v3.json 和底图 PNG 的目录>
// 底图文件名由清单里的 source 决定，输出为 <id>.jpg。
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const src = process.argv[2]
if (!src) { console.error('用法：node scripts/convert-card-templates.cjs <设计稿目录>'); process.exit(1) }
const out = path.join(__dirname, '..', 'resources', 'card-templates')
const v3 = JSON.parse(fs.readFileSync(path.join(src, 'manifest-v3.json'), 'utf8'))
const r4 = x => Math.round(x * 10000) / 10000
const templates = v3.templates.map(t => {
  const dst = path.join(out, t.id + '.jpg')
  execFileSync('/usr/bin/sips', ['--resampleWidth', '1086', '-s', 'format', 'jpeg', '-s', 'formatOptions', process.argv[3] || '85', path.join(src, t.source), '--out', dst], { stdio: 'ignore' })
  console.log(t.id, fs.statSync(dst).size)
  return {
    id: t.id, audience: t.audience, name: t.name,
    scene: t.audience === 'student' ? '学生知识卡：' + t.name : '给家长的学情信：' + t.name,
    file: t.id + '.jpg', width: 1086, height: 1448,
    paper: t.paper.map(r4), content: t.content.map(r4),
    style: { accent: t.accent, accent2: t.accent2, paperBg: t.paperBg }
  }
})
const mf = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'))
mf.templates = templates
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(mf, null, 1))
