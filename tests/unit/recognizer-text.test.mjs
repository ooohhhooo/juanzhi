// 「这一页是怎么识别的、为什么」的白话（M9 D2）：纯函数，主进程和界面共用。
import assert from 'node:assert/strict'
import { recognizerTitle, recognizerNote, reasonText, groupPages, rangeText, paperIncomplete, OCR_TUTORIAL_URL } from '../../src/shared/recognizer-text.ts'

assert.equal(recognizerTitle({ recognizer: 'win-ocr', ocrLang: 'en-US' }), 'Windows 自带识别（English）')
assert.equal(recognizerTitle({ recognizer: 'win-ocr', ocrLang: 'zh-Hans-CN' }), 'Windows 自带识别（中文）')
assert.equal(recognizerTitle({ recognizer: 'mac-vision', ocrLang: null }), 'Mac 自带识别')
assert.equal(recognizerTitle({ recognizer: 'pdf-text', ocrLang: null }), 'PDF 自带文字层')
assert.equal(recognizerTitle({ recognizer: 'docx-text', ocrLang: null }), 'Word 文件：直接读取文字，不经过识别')
assert.equal(recognizerTitle({ recognizer: 'vision-model', ocrLang: null }), 'AI 读图')

assert.equal(recognizerNote({ recognizer: 'win-ocr', ocrLang: 'en-US', reason: 'no-vision-model', low: true }), '没装中文语言包，中文可能认不全')
assert.equal(recognizerNote({ recognizer: 'win-ocr', ocrLang: 'zh-Hans-CN', reason: 'ocr-ok', low: false }), '')
assert.match(recognizerNote({ recognizer: 'mac-vision', ocrLang: null, reason: 'no-vision-model', low: true }), /识别效果不太好/)
assert.equal(recognizerNote({ recognizer: 'vision-model', ocrLang: null, reason: 'low-quality', low: true }), '', '已经改用 AI 读图的页不再提醒')

for (const r of ['text-layer-ok', 'docx-text', 'ocr-ok', 'low-quality', 'lang-mismatch', 'low-conf', 'policy-images-always', 'ocr-failed', 'no-text', 'no-vision-model', 'vision-never', 'vision-forbidden']) {
  const t = reasonText(r)
  assert.ok(t.length > 5, r)
  assert.ok(!/OCR|token|HTTP/i.test(t), `白话里不出现技术词：${t}`)
}
assert.equal(reasonText(null), '')

// 相邻、方式和原因都相同的页并成一条
{
  const pages = [
    { idx: 1, recognizer: 'win-ocr', ocrLang: 'en-US', reason: 'no-vision-model', low: true },
    { idx: 2, recognizer: 'win-ocr', ocrLang: 'en-US', reason: 'no-vision-model', low: true },
    { idx: 3, recognizer: 'win-ocr', ocrLang: 'en-US', reason: 'no-vision-model', low: true },
    { idx: 4, recognizer: 'vision-model', ocrLang: null, reason: 'lang-mismatch', low: true },
    { idx: 5, recognizer: 'pdf-text', ocrLang: null, reason: 'text-layer-ok', low: false }
  ]
  const g = groupPages(pages)
  assert.equal(g.length, 3)
  assert.equal(rangeText(g[0]), '第 1–3 页'); assert.equal(g[0].title, 'Windows 自带识别（English）'); assert.equal(g[0].needsZhPack, true)
  assert.equal(rangeText(g[1]), '第 4 页'); assert.equal(g[1].title, 'AI 读图'); assert.equal(g[1].needsZhPack, false)
  assert.equal(g[2].title, 'PDF 自带文字层')
  assert.equal(paperIncomplete(pages), true, '前三页识别不好又没读图')
  assert.equal(paperIncomplete(pages.slice(3)), false, '识别不好的页已经改用读图了')
  assert.equal(paperIncomplete([]), false)
}
assert.ok(OCR_TUTORIAL_URL.startsWith('https://github.com/ooohhhooo/juanzhi/blob/main/docs/'))
console.log('recognizer-text.test ✓')
