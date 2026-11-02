// 生成一份只含两张卡片（口诀大招 / 答题卡）的 Word 样张，给 E2E 用 macOS 的 Quick Look 渲染成图片（run-m10b.cjs 调用）。
// 用法：node --experimental-strip-types --no-warnings tests/e2e/word-cards-sample.mjs <输出.docx>
// 注意：Quick Look 的渲染只是“另一个 Word 渲染器”的参考，不等于真 Word / WPS；发布前仍要在 Word、WPS、Pages 里各打开一次（docs/验收清单.md）。
import fs from 'node:fs'
import { buildDocx } from '../../src/main/report/docx.ts'

const md = [
  '## 做题方法', '',
  '::: trick 口诀大招', '**一句话**：看到数量别马虎，两个以上用复数。', '**例**：Look at the sheep. 看那些羊。', '**出自考点**：名词复数', ':::', '',
  '::: answercard 答题卡 | 同类变形题',
  '1. Mia has two pens. These are my ____. {choice: pen | pens | a pen | pen\'s}',
  '2. Ben ____ to school by bike every day. {choice: go | goes | going | gone}',
  '3. Mum is in the kitchen. She ____ (c) dinner every evening. {blank: 1}',
  ':::'
].join('\n')
fs.writeFileSync(process.argv[2], await buildDocx({ title: '老师版 · 卡片样张', markdown: md, footer: 'AI 草稿 · 请老师核对后再使用' }))
