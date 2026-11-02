// 现场生成测试用的 Word 试卷（.docx）：自动编号的列表、带下划线的填空横线、表格、标题。不依赖 Word，用 jszip 手写 OOXML。
// 用法：const { makeExamDocx } = require('./make-docx.cjs'); await makeExamDocx('/tmp/x.docx')
const fs = require('node:fs')
const JSZip = require('jszip')

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 一段文字；parts 里的 { u: '   ' } 是带下划线的片段（填空横线） */
const run = (t, o = {}) => `<w:r><w:rPr>${o.b ? '<w:b/>' : ''}${o.u ? '<w:u w:val="single"/>' : ''}</w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`
const para = (parts, o = {}) => {
  const pPr = `${o.style ? `<w:pStyle w:val="${o.style}"/>` : ''}${o.num ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${o.num}"/></w:numPr>` : ''}${o.center ? '<w:jc w:val="center"/>' : ''}`
  const body = (Array.isArray(parts) ? parts : [parts]).map(p => typeof p === 'string' ? run(p, o) : run(p.u, { u: true })).join('')
  return `<w:p><w:pPr>${pPr}</w:pPr>${body}</w:p>`
}
const cell = t => `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>${para(t)}</w:tc>`
const table = rows => `<w:tbl><w:tblPr><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(b => `<w:${b} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`).join('')}</w:tblBorders></w:tblPr>${rows.map(r => `<w:tr>${r.map(cell).join('')}</w:tr>`).join('')}</w:tbl>`

/**
 * 一份 12 题的小试卷（和 tests/mock-ai/canned.cjs 里的 m9a-word 对应）：
 *  标题 → 一、选择（自动编号 1–6，选项另起一段）→ 二、填空（手打的题号 7–10，下划线空格）→ 三、对话（表格里的两道题 11–12）
 */
async function makeExamDocx(file) {
  const body = [
    para('小学四年级英语期末测试卷', { b: true, center: true }),
    para('一、单项选择（每题2分）', { b: true }),
    para("What's your name?", { num: 1 }), para('A. Tom  B. Tom is  C. I Tom'),
    para('Is this a pen?', { num: 1 }), para('A. Yes, it is.  B. Yes, this is.  C. No, I am not.'),
    para('How many apples are there?', { num: 1 }), para('A. Two apple  B. Two apples  C. Second apple'),
    para('My sister ____ a teacher.', { num: 1 }), para('A. am  B. is  C. are'),
    para('Where is the library?', { num: 1 }), para('A. On the second floor.  B. It is red.  C. Yes, it is.'),
    para('What time is it?', { num: 1 }), para("A. It's seven o'clock.  B. It's sunny.  C. I like it."),
    para('二、用所给词的适当形式填空（每题2分）', { b: true }),
    para(['7. I ', { u: '        ' }, ' (like) apples very much.']),
    para(['8. Look at the ', { u: '        ' }, ' (sheep) on the farm.']),
    para(['9. She ', { u: '        ' }, ' (go) to school by bus every day.']),
    para(['10. These ', { u: '        ' }, ' (tomato) are very fresh.']),
    para('三、补全对话（每题3分）', { b: true }),
    table([['11. —How much is this dress?', '—It is fifty yuan.'], ['12. —What is the weather like today?', '—It is sunny and warm.']])
  ].join('')
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>')
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>')
  zip.file('word/document.xml', doc)
  zip.file('word/numbering.xml', numbering)
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  return file
}

module.exports = { makeExamDocx }
