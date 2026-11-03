// 虚构运营数据生成器（问卷 / 上课记录 / 续费退费）。全部是编造的：人名是「张老师01」这类明显虚构的，手机号是 139 开头的随机数字。
// 输出到 tests/fixtures/ops/：survey.xlsx（两张表，问卷前面有 2 行标题）、classes.csv（UTF-8 带 BOM）、renewal.xlsx、renewal.tsv（制表符）。
// 用法：node tests/fixtures/gen-ops-data.cjs [输出目录]；也可 require 后调用 generate(dir)。
const fs = require('node:fs')
const path = require('node:path')
const JSZip = require('jszip')

function rng(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const R = rng(20261103)
const pick = a => a[Math.floor(R() * a.length)]
const int = (lo, hi) => lo + Math.floor(R() * (hi - lo + 1))
const pad = (n, w = 2) => String(n).padStart(w, '0')
const day = (m, d) => `2026-${pad(m)}-${pad(d)}`

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const colName = c => { let n = c + 1, s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26) } return s }

/** 最小 xlsx：文字用行内字符串，数字用数值单元格；merges 形如 ['A1:F1'] */
async function buildXlsx(file, sheets) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`)
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`)
  sheets.forEach((s, i) => {
    const body = s.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
      if (v === '' || v === null || v === undefined) return ''
      const ref = `${colName(ci)}${ri + 1}`
      return typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`
    }).join('')}</row>`).join('')
    const merges = (s.merges ?? []).length ? `<mergeCells count="${s.merges.length}">${s.merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : ''
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData>${merges}</worksheet>`)
  })
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
}

const csvCell = (v, d) => { const s = String(v ?? ''); return s.includes(d) || /["\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }
const toCsv = (rows, d = ',') => rows.map(r => r.map(v => csvCell(v, d)).join(d)).join('\r\n') + '\r\n'

const GRADES = ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级']
const CHANNELS = ['线上投放', '老带新', '地推', '自然到访']
const CLASSES = ['启航A班', '启航B班', '进阶A班', '进阶B班', '冲刺班']
const TEACHERS = ['张老师01', '张老师02', '李老师03', '王老师04', '赵老师05']
const COACHES = ['陈辅导01', '周辅导02', '吴辅导03', '郑辅导04']
const REASONS = ['课程内容', '老师讲解', '价格', '上课时间', '学习效果', '服务态度']
const OPINIONS = ['老师讲得很清楚，孩子愿意听', '作业有点多，希望适当减少', '上课时间能不能再灵活一些', '课程内容很实用', '价格偏高，希望有更多优惠', '辅导老师回复很及时', '']

function surveyRows(n) {
  const rows = [['学员编号', '家长手机', '年级', '新老生', '渠道', '班级', '授课老师', '辅导老师', '推荐分', '满意度', '推荐原因（多选）', '文字意见', '提交时间']]
  for (let i = 1; i <= n; i++) {
    const k = int(1, 3)
    const reasons = []
    while (reasons.length < k) { const r = pick(REASONS); if (!reasons.includes(r)) reasons.push(r) }
    rows.push([100000 + i, '139' + pad(int(0, 99999999), 8), pick(GRADES), R() < 0.4 ? '新生' : '老生', pick(CHANNELS), pick(CLASSES), pick(TEACHERS), pick(COACHES),
      int(0, 10), int(1, 5), reasons.join('┋'), pick(OPINIONS), `${day(int(9, 10), int(1, 28))} ${pad(int(8, 21))}:${pad(int(0, 59))}`])
  }
  return rows
}

function classRows(n) {
  const rows = [['上课日期', '班级', '授课老师', '应到人数', '实到人数', '课时数', '课堂互动分']]
  for (let i = 0; i < n; i++) {
    const due = int(8, 20)
    rows.push([day(int(9, 11), int(1, 28)), pick(CLASSES), pick(TEACHERS), due, int(due - 4, due), pick([1, 1.5, 2]), +(R() * 4 + 6).toFixed(1)])
  }
  return rows
}

function renewalRows(n) {
  const rows = [['学员编号', '订单日期', '订单类型', '金额', '课程名称', '销售顾问', '是否退费', '备注']]
  for (let i = 1; i <= n; i++) {
    const t = pick(['新购', '续费', '续费', '退费'])
    rows.push([100000 + int(1, 300), day(int(8, 11), int(1, 28)), t, t === '退费' ? -int(10, 40) * 100 : int(10, 60) * 100 + 0.5 * int(0, 1), pick(['春季班', '秋季班', '暑期班', '寒假班']), pick(['孙顾问01', '钱顾问02', '冯顾问03']), t === '退费' ? '是' : '否', t === '退费' ? '时间冲突' : ''])
  }
  return rows
}

async function generate(outDir) {
  fs.mkdirSync(outDir, { recursive: true })
  const survey = surveyRows(300)
  await buildXlsx(path.join(outDir, 'survey.xlsx'), [
    { name: '问卷', rows: [['2026 秋季学员满意度问卷（虚构数据）'], [''], ...survey], merges: ['A1:M1'] },
    { name: '教师名册', rows: [['教师', '负责班级'], ...TEACHERS.map((t, i) => [t, CLASSES[i % CLASSES.length]])] }
  ])
  fs.writeFileSync(path.join(outDir, 'classes.csv'), '﻿' + toCsv(classRows(120)))
  const ren = renewalRows(200)
  await buildXlsx(path.join(outDir, 'renewal.xlsx'), [{ name: '订单', rows: ren }])
  fs.writeFileSync(path.join(outDir, 'renewal.tsv'), toCsv(ren, '\t'))
  return { dir: outDir, survey: survey.length - 1, classes: 120, renewal: ren.length - 1 }
}

module.exports = { generate, buildXlsx, toCsv, TEACHERS, COACHES, CLASSES }

if (require.main === module) {
  generate(process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, 'ops')).then(r => console.log('已生成', r))
}
