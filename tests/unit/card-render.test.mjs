// 卡片的渲染（M9 §2.4–2.7）：静态 HTML（PDF / 复制成图片）、Word、卡片色令牌的对比度、答题卡不含学生信息。
// Word 用 mammoth 读回文字，并按 ECMA-376 的元素顺序检查卡片用到的元素（同 docx-structure.test）。
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import { DOMParser } from '@xmldom/xmldom'
import { markdownToHtml, cardImagePage, reportHtmlPage } from '../../src/shared/mdhtml.ts'
import { CARD_AMBER, CARD_PAPER, CARD_WIDTH, cardCss, contrast } from '../../src/shared/card-style.ts'
import { buildDocx } from '../../src/main/report/docx.ts'

const MD = [
  '## 做题方法', '',
  '::: trick 口诀大招', '**一句话**：名词复数别马虎，sheep 不加 s。', '**例**：Look at the sheep. 看那些羊。', '**出自考点**：名词复数', ':::', '',
  '::: answercard 答题卡 | 同类变形题',
  '1. Mia has two pens. These are my ____. {choice: pen | pens | a pen | pen\'s}',
  '2. Mum ____ (c) dinner every evening. {blank: 1}',
  '3. 写一写 {lines: 2}',
  ':::'
].join('\n')

// ── 卡片色令牌：文字对比度 ≥ 7:1（浅色在淡琥珀横幅上；深色在深琥珀底和 #1D1D35 画布上）──
assert.ok(contrast(CARD_AMBER.light.ink, CARD_AMBER.light.band) >= 7, `浅色横幅文字对比度 ${contrast(CARD_AMBER.light.ink, CARD_AMBER.light.band).toFixed(2)}`)
assert.ok(contrast(CARD_AMBER.dark.ink, CARD_AMBER.dark.band) >= 7, `深色横幅文字对比度 ${contrast(CARD_AMBER.dark.ink, CARD_AMBER.dark.band).toFixed(2)}`)
assert.ok(contrast(CARD_AMBER.dark.ink, '#1D1D35') >= 7, '深色琥珀字在深色画布上也 ≥ 7:1')
assert.ok(contrast(CARD_PAPER.ink, CARD_PAPER.paper) >= 7 && contrast(CARD_PAPER.ink2, CARD_PAPER.paper) >= 4.5, '卡片正文 / 次要文字在白纸上够清楚')
assert.ok(contrast(CARD_PAPER.onBadge, CARD_PAPER.badge) >= 7, '题号徽标白字对比度')
assert.equal(CARD_WIDTH, 720, '卡片宽度固定 720px')
// 卡片色只在 card-style 里定义：琥珀（语音大类色）#B98733 不能被当成卡片横幅色
assert.notEqual(CARD_AMBER.light.band.toUpperCase(), '#B98733')

// ── HTML ──
const html = markdownToHtml(MD)
assert.ok(html.includes('data-card="trick"') && html.includes('口诀大招'))
assert.ok(html.includes('<p class="ewb-trick__main">名词复数别马虎'), '口诀大字')
assert.ok(html.includes('class="ewb-trick__eg"><i>Look at the sheep. </i>看那些羊。'), '例句行：英文用斜体，中文保持正体')
assert.ok(html.includes('出自考点：名词复数'))
assert.ok(html.includes('data-card="answercard"') && html.includes('答题卡 · 同类变形题'))
assert.equal((html.match(/class="ewb-ans__no"/g) ?? []).length, 3, '三个编号徽标')
assert.ok(html.includes('○ A. pen') && html.includes('○ B. pens') && html.includes('○ C. a pen') && html.includes("○ D. pen's"), '选择题 ○A ○B ○C ○D')
assert.equal((html.match(/class="ewb-ans__box"/g) ?? []).length, 3, '填空 1 个 + 书写 2 行 = 3 个虚线作答框')
assert.ok(html.includes('姓名<i class="ewb-ans__line">') && html.includes('日期<i class="ewb-ans__line">'), '答题卡顶部留着手写的姓名 / 日期横线')
assert.ok(html.includes('AI 出题') && html.includes('AI 出题，老师逐题核对后使用') && !html.includes('第二次 AI 解答核对'), '标签和页脚声明（不夸大成“已核对”）')
// 答题卡里没有答案和讲解（这两样在报告里“参考答案与讲解（教师用）”）
assert.ok(!/参考答案|讲解/.test(html.slice(html.indexOf('data-card="answercard"'))))
// 学生信息：除了空白横线，不出现任何具体的姓名 / 日期值
const css = cardCss()
assert.ok(css.includes('dashed') && css.includes('border-radius: 18px') && css.includes('width: 720px'))
assert.ok(css.includes(CARD_AMBER.light.band) && css.includes(CARD_PAPER.badge))
// 转义：卡片里的 HTML 不会被执行
assert.ok(!markdownToHtml('::: trick x\n**一句话**：<script>alert(1)</script>\n:::').includes('<script>'))
// PDF 页面带卡片样式；图片页面强制白底、zoom 2、720 宽
assert.ok(reportHtmlPage({ title: 't', bodyHtml: html }).includes('.ewb-card__band'))
const img = cardImagePage(html)
assert.ok(img.includes('zoom: 2') && img.includes('#FFFFFF') && img.includes(`width: ${CARD_WIDTH}px`) && !img.includes('<script'))

// ── 微信 / 退化：旧版不认识的卡片在 PDF 里是引用块（不崩）──
assert.ok(markdownToHtml('::: banner 新\n内容\n:::').includes('<blockquote>'))

// ── Word ──
const buf = await buildDocx({ title: '老师版', markdown: MD })
const z = await JSZip.loadAsync(buf)
const xml = await z.file('word/document.xml').async('string')
const errors = []
const doc = new DOMParser({ onError: (l, m) => errors.push(m) }).parseFromString(xml, 'text/xml')
assert.deepEqual(errors, [], 'document.xml 是良构的 XML')
assert.ok(xml.includes('w:val="dashed"'), '作答区是虚线框（tcBorders dashed）')
assert.ok(xml.includes(`w:fill="${CARD_AMBER.light.band.slice(1)}"`), '口诀卡横幅有淡琥珀底色，和界面 / PDF 同一个色值')
assert.ok(xml.includes(`w:fill="${CARD_PAPER.badge.slice(1)}"`), '题号徽标有深色底')
assert.ok(xml.includes('<w:i/>'), '例句是斜体')
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const list = nl => Array.from({ length: nl.length }, (_, i) => nl.item(i))
const kids = el => list(el.childNodes).filter(n => n.nodeType === 1).map(n => n.localName)
const tbls = list(doc.getElementsByTagNameNS(W, 'tbl'))
assert.equal(tbls.length, 2, '口诀卡一个表、答题卡一个表')
for (const t of tbls) {
  const grid = kids(t.getElementsByTagNameNS(W, 'tblGrid').item(0)).length
  assert.deepEqual(kids(t).slice(0, 2), ['tblPr', 'tblGrid'])
  for (const tr of list(t.getElementsByTagNameNS(W, 'tr'))) {
    const cells = list(tr.childNodes).filter(n => n.localName === 'tc')
    const span = cells.reduce((s, c) => s + Number(c.getElementsByTagNameNS(W, 'gridSpan').item(0)?.getAttributeNS(W, 'val') ?? 1), 0)
    assert.equal(span, grid, '每行占的列数 = 表格列数（合并单元格也算）')
    for (const tc of cells) {
      const ck = kids(tc)
      assert.equal(ck[0], 'tcPr'); assert.equal(ck[ck.length - 1], 'p', '单元格必须以段落结尾')
      const order = ['tcW', 'gridSpan', 'tcBorders', 'shd', 'tcMar', 'vAlign']
      let last = -1
      for (const k of kids(tc.getElementsByTagNameNS(W, 'tcPr').item(0))) { const i = order.indexOf(k); assert.ok(i >= last && i >= 0, `tcPr 子元素顺序：${k}`); last = i }
      const bo = ['top', 'left', 'bottom', 'right']
      last = -1
      for (const k of kids(tc.getElementsByTagNameNS(W, 'tcBorders').item(0))) { const i = bo.indexOf(k); assert.ok(i >= last, `tcBorders 顺序：${k}`); last = i }
    }
  }
}
const body = kids(doc.getElementsByTagNameNS(W, 'body').item(0))
assert.equal(body[body.length - 1], 'sectPr'); assert.equal(body[body.indexOf('tbl') + 1], 'p', '表格后面紧跟段落')
const text = (await mammoth.extractRawText({ buffer: buf })).value
assert.ok(text.includes('口诀大招') && text.includes('名词复数别马虎') && text.includes('Look at the sheep'))
assert.ok(text.includes('答题卡 · 同类变形题') && text.includes('姓名 ____') && text.includes('○ B. pens') && text.includes('老师逐题核对后使用'))
assert.ok(!/参考答案/.test(text), 'Word 里的答题卡同样不含答案')

console.log('card-render.test ✓')
