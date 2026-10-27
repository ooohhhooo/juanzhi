// Word 导出的结构（P1-5）：mammoth 对元素顺序和缺项很宽容，「能读回」不等于 Word / WPS 能打开。
// 这里按 ECMA-376 的元素顺序逐个检查：pPr / rPr / tcPr / tblPr 的子元素先后、tbl 必有 tblGrid 且列数对得上、每个 tc 有 tcW 且以段落结尾、
// XML 里不含 XML 1.0 不允许的字符（U+FFFE / U+FFFF / 控制字符 / 孤立代理项）、关系和内容类型齐全。
// 没有离线可用的 OOXML XSD，所以顺序表是手写的（只列本文件会写出来的元素）；用 Word / WPS 实际打开一次仍是发布前必做项。
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { DOMParser } from '@xmldom/xmldom'
import { buildDocx, xmlText } from '../../src/main/report/docx.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

// CT_PPrBase / CT_RPr / CT_TcPr / CT_TblPr 里本文件会用到的子元素，按 schema 里的先后顺序
const ORDER = {
  pPr: ['pStyle', 'keepNext', 'keepLines', 'pBdr', 'shd', 'spacing', 'ind', 'jc', 'outlineLvl'],
  rPr: ['rStyle', 'rFonts', 'b', 'i', 'color', 'sz', 'szCs', 'lang'],
  tcPr: ['tcW', 'gridSpan', 'vMerge', 'tcBorders', 'shd'],
  tblPr: ['tblStyle', 'tblW', 'jc', 'tblLayout', 'tblLook'],
  tcBorders: ['top', 'left', 'bottom', 'right'],
  pBdr: ['top', 'left', 'bottom', 'right']
}
const list = nl => Array.from({ length: nl.length }, (_, i) => nl.item(i))
const byTag = (doc, name) => list(doc.getElementsByTagNameNS(W, name))
const kids = el => list(el.childNodes).filter(n => n.nodeType === 1)
const local = n => n.localName

function checkOrder(doc, label) {
  for (const [parent, order] of Object.entries(ORDER)) {
    for (const el of byTag(doc, parent)) {
      let last = -1
      for (const c of kids(el)) {
        const i = order.indexOf(local(c))
        assert.ok(i >= 0, `${label}：<w:${parent}> 里出现了没登记的子元素 <w:${local(c)}>`)
        assert.ok(i >= last, `${label}：<w:${parent}> 的子元素顺序不对：<w:${local(c)}> 在 <w:${order[last]}> 后面（schema 要求 ${order.join(' → ')}）`)
        last = i
      }
    }
  }
}

function parse(xml, label) {
  const errors = []
  const doc = new DOMParser({ onError: (lvl, msg) => errors.push(`${lvl}: ${msg}`) }).parseFromString(xml, 'text/xml')
  assert.deepEqual(errors, [], `${label} 不是良构的 XML`)
  assert.ok(!/[^\x09\x0A\x0D\x20-퟿-�\u{10000}-\u{10FFFF}]/u.test(xml), `${label} 里有 XML 1.0 不允许的字符`)
  return doc
}

const md = ['# 标题', '> 说明：AI 草稿〔未核实〕', '## 易错点', '- **名词复数**：tomato 的复数加 -es', '- 第二条', '1. 第一条', '2. 第二条', '| 名称 | 份数 | 备注 |', '|---|---|---|', '| 名词复数 | 3/3 |', '| 一般过去时 | 2/3 | x |', '', '---', '```', 'code', '```', '引用 [2025卷 · 7] 结束 <script>x</script> & "q"'].join('\n')
// 文字里混进 XML 不允许的字符：U+FFFE、U+FFFF、控制字符、孤立代理项
const dirty = md + '\n脏字符：A￾B￿C\u0001D\u0008E\ud800F\udc00G'
const buf = await buildDocx({ title: '四年级 考情分析报告（家长版）· 2026-10-26', markdown: dirty, images: new Map([['[2025卷 · 7]', { png, width: 300, height: 60 }]]), footer: 'AI 草稿 · 请老师核对后再使用' })
const z = await JSZip.loadAsync(buf)
const docXml = await z.file('word/document.xml').async('string')
const doc = parse(docXml, 'document.xml')
parse(await z.file('word/styles.xml').async('string'), 'styles.xml')
parse(await z.file('[Content_Types].xml').async('string'), '[Content_Types].xml')
parse(await z.file('word/_rels/document.xml.rels').async('string'), 'document.xml.rels')
checkOrder(doc, 'document.xml')
checkOrder(parse(await z.file('word/styles.xml').async('string'), 'styles.xml'), 'styles.xml')

// 列表项：缩进（ind）在行距（spacing）后面——这是审核里点名的那一处
assert.ok(/<w:spacing [^>]*\/><w:ind w:left="360"\/>/.test(docXml), '列表项的 <w:ind> 要在 <w:spacing> 后面')
assert.ok(!/<w:ind [^>]*\/><w:spacing/.test(docXml))

// 表格：tblPr → tblGrid → tr；gridCol 数 = 表头列数；每个 tc 有 tcW、以 <w:p> 结尾；每行单元格数 = 列数
const tbls = byTag(doc, 'tbl')
assert.equal(tbls.length, 1)
for (const t of tbls) {
  const ks = kids(t).map(local)
  assert.equal(ks[0], 'tblPr'); assert.equal(ks[1], 'tblGrid', '表格必须有 tblGrid'); assert.ok(ks.slice(2).every(k => k === 'tr'))
  const cols = kids(kids(t)[1]).length
  assert.equal(cols, 3)
  for (const tr of kids(t).filter(k => local(k) === 'tr')) {
    const tcs = kids(tr)
    assert.equal(tcs.length, cols, '每行的单元格数 = 列数（缺的补空格子）')
    for (const tc of tcs) {
      const ck = kids(tc).map(local)
      assert.equal(ck[0], 'tcPr'); assert.equal(local(kids(kids(tc)[0])[0]), 'tcW', '单元格要有 tcW')
      assert.equal(ck[ck.length - 1], 'p', '单元格必须以段落结尾')
    }
  }
}
// 表格后面紧跟一个段落（body 末尾不能是表格），sectPr 是 body 的最后一个子元素
const bodyKids = kids(byTag(doc, 'body')[0]).map(local)
assert.equal(bodyKids[bodyKids.length - 1], 'sectPr')
assert.ok(bodyKids.indexOf('tbl') >= 0 && bodyKids[bodyKids.indexOf('tbl') + 1] === 'p')

// 脏字符被滤掉，其余文字还在
assert.ok(docXml.includes('ABCDE') || docXml.includes('A') && docXml.includes('FG'), '干净的字符保留')
assert.ok(!docXml.includes('￾') && !docXml.includes('￿'))
assert.equal(xmlText('a￾b￿c\u0000d\ud800e'), 'abcde')
assert.equal(xmlText('正常文字\n\t保留'), '正常文字\n\t保留')
assert.equal(xmlText('😀'), '😀', '成对的代理项（emoji）不能被当成孤立的删掉')

// 关系：图片关系和文件对得上；内容类型里有 png
const rels = await z.file('word/_rels/document.xml.rels').async('string')
for (const m of rels.matchAll(/Target="(media\/[^"]+)"/g)) assert.ok(z.file(`word/${m[1]}`), `关系指向的 ${m[1]} 要存在`)
assert.ok((await z.file('[Content_Types].xml').async('string')).includes('Extension="png"'))
// 空文档也是良构的
parse(await (await JSZip.loadAsync(await buildDocx({ title: 't', markdown: '' }))).file('word/document.xml').async('string'), 'empty document.xml')

console.log('docx-structure.test ✓')
