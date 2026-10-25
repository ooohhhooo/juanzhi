// Windows OCR 脚本的静态交叉校验：本机没有 PowerShell/Windows，不能运行脚本，
// 但可以从脚本里把关键正则原样取出来，用 Node 的正则引擎验证行为（.NET 与 JS 在这个语法子集上一致）。
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert')

const file = path.join(__dirname, '../../native/windows/ocr.ps1')
const raw = fs.readFileSync(file)
const src = raw.toString('utf8')

// 1. 必须是带 BOM 的 UTF-8
assert.deepStrictEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'ocr.ps1 必须带 UTF-8 BOM')

// 2. 取出 $cjk 字符类与替换用的模式
const cjk = /\$cjk = '([^']+)'/.exec(src)?.[1]
const tmpl = /\[regex\]::Replace\(\$text, "([^"]+)", ''\)/.exec(src)?.[1]
assert.ok(cjk && tmpl, '没有在脚本里找到 CJK 正则')
assert.ok(/^[\x00-\x7F]+$/.test(cjk + tmpl), '正则必须是纯 ASCII（用 \\uXXXX 转义），不能依赖脚本文件编码')
const re = new RegExp(tmpl.replaceAll('$cjk', cjk), 'g')

const strip = s => s.replace(re, '')
const cases = [
  ['中 文 字 符 识 别', '中文字符识别'],
  ['第 一 题 ： 选 择', '第一题：选择'],
  ['How are you? 你 好 吗', 'How are you? 你好吗'],
  ['Hello world', 'Hello world'],
  ['A. sunny  B. windy', 'A. sunny  B. windy'],
  ['选出不同类的单词。 A. sunny', '选出不同类的单词。 A. sunny'],
  ['1. 英 语 (English) 试 卷', '1. 英语 (English) 试卷']
]
for (const [input, want] of cases) assert.strictEqual(strip(input), want, `输入: ${input}`)

// 3. 对照：评审指出的旧写法 ([CJK])\s+([CJK]) → $1$2 会漏掉一半，用来证明上面的用例有判别力
const oldRe = new RegExp(`(${cjk})\\s+(${cjk})`, 'g')
assert.notStrictEqual('中 文 字 符 识 别'.replace(oldRe, '$1$2'), '中文字符识别', '旧写法应当失败（否则测试没有判别力）')

// 4. 结果类型必须显式传入，不能再用 GetInterfaces() 推断
assert.ok(!/GetInterfaces\(\)/.test(src), '脚本里不应再通过 GetInterfaces() 推断 WinRT 结果类型')
assert.ok((src.match(/Await \(/g) || []).length >= 5, '每次 Await 都应显式传结果类型')

console.log('ocr.ps1 静态校验通过（BOM、正则行为 7 例、旧写法对照、显式结果类型）')
