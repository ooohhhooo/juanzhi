// 运行日志：脱敏（密钥、提示词式长文本、路径、网址）与滚动大小上限
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLogWriter, sanitize, reduceConsoleMessage, MAX_LINE_CHARS } from '../../src/main/log-core.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-log-'))
const SECRET = 'sk-abcdef1234567890SECRETKEY'
const home = os.homedir()

// 1. 密钥：已知密钥、sk- 形态、Bearer 都被抹掉
{
  const s = sanitize(`请求失败 Authorization: Bearer ${SECRET} key=${SECRET}`, [SECRET])
  assert.ok(!s.includes(SECRET) && !s.includes('abcdef1234567890'), s)
  assert.ok(!sanitize('token sk-ZZZZZZZZZZZZZZZZ 结束').includes('ZZZZZZZZ'))
  // 密钥跨在截断点上也不会只漏一半：先脱敏再截断
  const long = 'x'.repeat(MAX_LINE_CHARS - 5) + SECRET
  assert.ok(!sanitize(long, [SECRET]).includes('abcdef'))
}
// 2. 路径里的用户名、网址的路径与参数
{
  const s = sanitize(`打开 ${home}/Documents/试卷/张三.pdf 失败`, [], home)
  assert.ok(!s.includes(home) && !s.includes('张三') && s.includes('<path>.pdf'), s)
  assert.ok(!sanitize('C:\\Users\\zhangsan\\Desktop\\a.pdf').includes('zhangsan'))
  assert.ok(!sanitize('/Users/lisi/x').includes('lisi'))
  const u = sanitize('POST https://api.example.com/v1/chat/completions?key=abc 返回 429')
  assert.ok(u.includes('api.example.com') && !u.includes('/v1/') && !u.includes('key=abc'), u)
}
// 2b. 各种形态的路径整段隐藏（保留扩展名）；用户名带空格也不漏
{
  for (const [raw, leak] of [['D:\\x\\张三.pdf', '张三'], ['\\\\srv\\share\\a.pdf', 'srv'], ['/Volumes/X/张三期中.pdf', '张三'], ['C:\\Users\\Zhang San\\Desktop\\期中 卷.pdf', 'Zhang'], ['/Users/Zhang San/Documents/a.docx', 'Zhang']]) {
    const s = sanitize(`导入 ${raw} 失败`)
    assert.ok(!s.includes(leak) && !s.includes('Users') && /<path>\.(pdf|docx)/.test(s), `${raw} → ${s}`)
  }
  assert.ok(!sanitize('C:\\Users\\Zhang San\\').includes('Zhang'))
  assert.ok(!sanitize('/Users/Zhang San/Documents/').includes('Zhang'))
  // 用户信息里带 / 的网址
  const u = sanitize('GET https://us/er:pa/ss@api.example.com/v1/x?k=1')
  assert.ok(u.includes('api.example.com') && !u.includes('pa/ss') && !u.includes('/v1'), u)
  // 不认识的长密钥、Google 形态
  assert.ok(!sanitize('key AIzaSyA1234567890abcdefghijklmnopqrstu x').includes('AIzaSy'))
  assert.ok(sanitize('model Qwen3-235B-A22B-Instruct-2507 forbidden').includes('Qwen3-235B-A22B-Instruct-2507'))
  assert.ok(!sanitize('tok a1b2c3d4e5f6a7b8c9d0e1f2a3b4 end').includes('a1b2c3d4e5f6'))
  assert.ok(!sanitize('token Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZmdoaWo').includes('Zm9vYmFy'))
  assert.ok(!sanitize('hex 0123456789abcdef0123456789abcdef').includes('0123456789abcdef0123'))
}
// 2c. console 的原文：冒号 / 竖线之后的错误原文（可能含 AI 返回的题干、文件名）不落盘
{
  const jsonErr = `非法 JSON：Unexpected token '题', "{"stem": "请选出画线部分读音不同的一项" is not valid JSON`
  const r = reduceConsoleMessage(jsonErr)
  assert.equal(r, '非法 JSON')
  assert.equal(reduceConsoleMessage('失败 ab12cd34: Bad request | {"error":"学生张三的作文"}'), '失败 ab12cd34')
  assert.equal(reduceConsoleMessage('OCR 失败: /Volumes/X/张三期中.pdf 读不出来'), 'OCR 失败')
  assert.ok(reduceConsoleMessage('x'.repeat(200)).length <= 61)
  assert.equal(reduceConsoleMessage('已把 3 份中断的解析退回'), '已把 3 份中断的解析退回')
}
// 3. 过长的文字（比如误传进来的提示词 / AI 返回）被截断
{
  const prompt = '题干：' + '请把下列单词归类。'.repeat(200)
  const s = sanitize(prompt)
  assert.ok(s.length < MAX_LINE_CHARS + 20 && s.endsWith('(已截断)'))
}
// 4. 写文件：字段只收数字 / 布尔 / 字符串；密钥与路径不落盘；对象字段（可能装着正文）被丢弃
{
  const dir = path.join(tmp, 'a')
  const w = createLogWriter({ dir, secrets: () => [SECRET] })
  w.write('info', 'ai', `调用 ${SECRET}`, { ms: 12, ok: true, model: 'deepseek-v4', body: { messages: [{ content: '学生张三的作文' }] }, note: `${home}/x` })
  const text = fs.readFileSync(path.join(dir, 'juanzhi.log'), 'utf8')
  assert.ok(text.includes('ms=12') && text.includes('ok=true') && text.includes('model=deepseek-v4'))
  for (const bad of [SECRET, 'abcdef1234567890', '学生张三', 'messages', home]) assert.ok(!text.includes(bad), `日志里不该出现 ${bad}：\n${text}`)
}
// 5. 滚动：每个文件不超过上限，最多保留 maxFiles 个，最新的在 juanzhi.log
{
  const dir = path.join(tmp, 'b')
  const w = createLogWriter({ dir, maxBytes: 1000, maxFiles: 3 })
  for (let i = 0; i < 200; i++) w.write('info', 'test', `第 ${i} 条 ${'a'.repeat(40)}`)
  const files = fs.readdirSync(dir).sort()
  assert.deepEqual(files, ['juanzhi.1.log', 'juanzhi.2.log', 'juanzhi.log'])
  for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size <= 1000, f)
  assert.ok(fs.readFileSync(path.join(dir, 'juanzhi.log'), 'utf8').includes('第 199 条'), '最新一条在当前文件里')
  assert.equal(w.files().length, 3)
}
// 6. 写不进去不抛错
{
  const blocker = path.join(tmp, 'file')
  fs.writeFileSync(blocker, 'x')
  const w = createLogWriter({ dir: path.join(blocker, 'sub') })
  w.write('error', 'x', '不会抛')
}
fs.rmSync(tmp, { recursive: true, force: true })
console.log('log-core.test ✓')
