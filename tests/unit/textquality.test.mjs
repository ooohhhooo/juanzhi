// 文本层质量门单元测试：直接导入 TS 源文件（node --experimental-strip-types）
import assert from 'node:assert/strict'
import { judgeTextLayer } from '../../src/main/pipeline/textquality.ts'

const english = 'Look at the sheep. They are so big! How much is this skirt? It is fifty yuan. '.repeat(2)
const chinese = '一、选出不同类的单词。（每题2分，共10分）二、单项选择。（每题2分，共20分）三、根据图片完成对话。'

// 正常文本通过
assert.equal(judgeTextLayer(english).usable, true)
assert.equal(judgeTextLayer(chinese).usable, true)
assert.equal(judgeTextLayer(chinese + '\n' + english).usable, true)

// 字数不够（封面、只有页码）
const few = judgeTextLayer('第 1 页')
assert.equal(few.usable, false)
assert.match(few.reason, /只有/)

// 空白不计入字数
assert.equal(judgeTextLayer(' \n\t '.repeat(100)).usable, false)

// 缺 ToUnicode：私有区字符，字数够也要拒绝
const pua = Array.from({ length: 120 }, (_, i) => String.fromCharCode(0xe000 + (i % 26))).join('')
const verdict = judgeTextLayer(pua)
assert.equal(verdict.usable, false)
assert.match(verdict.reason, /乱码/)
assert.ok(verdict.chars >= 100)

// U+FFFD 替换字符
assert.equal(judgeTextLayer('�'.repeat(60)).usable, false)

// 正文里夹零星乱码（<5%）仍可用；大量乱码（>5%）不可用
const mostlyGood = english + '�'.repeat(3)
assert.equal(judgeTextLayer(mostlyGood).usable, true)
assert.equal(judgeTextLayer(english + '�'.repeat(40)).usable, false)

// 可读字符占比：一堆控制字符/不可见符号
assert.equal(judgeTextLayer('\u0001\u0002\u0003\u0004'.repeat(30)).usable, false)

console.log('textquality 单元测试通过（正常文本、字数不足、空白、私有区乱码、U+FFFD、乱码比例阈值、控制字符）')
