import assert from 'node:assert/strict'
import { parseWebhook, toWecomMarkdown, markdownSegments, textSegments, explainWecomError, maskWebhook, redactKey } from '../../src/main/connectors/wecom-core.ts'

const ok = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a91f6-7xxx-4bc4-97a0-0ec2sifa5aaa'
assert.equal(parseWebhook(ok)?.key, '693a91f6-7xxx-4bc4-97a0-0ec2sifa5aaa')
for (const bad of ['', 'abc', 'http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh1234', 'https://evil.com/cgi-bin/webhook/send?key=abcdefgh1234',
  'https://qyapi.weixin.qq.com.evil.com/cgi-bin/webhook/send?key=abcdefgh1234', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=a b',
  'https://qyapi.weixin.qq.com/cgi-bin/other?key=abcdefgh1234', 'https://u:p@qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh1234', 'https://qyapi.weixin.qq.com:8443/cgi-bin/webhook/send?key=abcdefgh1234'])
  assert.equal(parseWebhook(bad), null, bad)
const local = 'http://127.0.0.1:5555/cgi-bin/webhook/send?key=abcdefgh1234'
assert.equal(parseWebhook(local), null, '默认不允许本机')
assert.equal(parseWebhook(local, true)?.base, 'http://127.0.0.1:5555')
assert.ok(!maskWebhook(ok).includes('7xxx'))
assert.equal(redactKey('fail ?key=abc-123&x'), 'fail ?key=****&x')

// Markdown 转换
const md = toWecomMarkdown('# 标题\n## 二级\n##### 深\n\n- 项一\n  - 子项\n1. 有序\n\n*斜* ~~删~~ **粗** [链](http://a.b) ![图](http://i.png)\n\n| 列A | 列B |\n|---|---|\n| 1 | 2 |\n\n```js\nlet a = 1\n```\n\n---\n<div>x</div> <font color="info">绿</font>')
assert.match(md, /^# 标题/)
assert.match(md, /### 深/)
assert.ok(!md.includes('#####'))
assert.match(md, /• 项一/)
assert.match(md, /　• 子项/)
assert.match(md, /1\. 有序/)
assert.match(md, /斜 删 \*\*粗\*\* \[链\]\(http:\/\/a\.b\) \[图\]\(http:\/\/i\.png\)/)
assert.match(md, /\*\*列A\*\* \| \*\*列B\*\*\n1 \| 2/)
assert.ok(!md.includes('|---'))
assert.match(md, /> let a = 1/)
assert.ok(!md.includes('```'))
assert.match(md, /——————/)
assert.ok(!md.includes('<div>') && md.includes('<font color="info">绿</font>'))

// 分段
assert.deepEqual(markdownSegments('短文'), ['短文'])
assert.deepEqual(markdownSegments(''), [])
const long = Array.from({ length: 400 }, (_, i) => `第${i}行内容内容内容内容`).join('\n')
const segs = markdownSegments(long)
assert.ok(segs.length > 1)
for (const [i, s] of segs.entries()) { assert.ok(Buffer.byteLength(s) <= 4096, 'seg ' + i); assert.ok(s.startsWith(`（${i + 1}/${segs.length}）`)) }
assert.equal(segs.join('').replace(/（\d+\/\d+）\n/g, '').replace(/\n/g, ''), long.replace(/\n/g, ''), '分段不丢字')
const oneLine = '字'.repeat(5000)
const s2 = markdownSegments(oneLine)
assert.ok(s2.length >= 4 && s2.every(s => Buffer.byteLength(s) <= 4096))
assert.equal(s2.join('').replace(/（\d+\/\d+）\n/g, ''), oneLine)
const t = textSegments('x'.repeat(5000))
assert.ok(t.length >= 3 && t.every(s => Buffer.byteLength(s) <= 2048))

// 错误码
assert.match(explainWecomError(93000), /地址无效/)
assert.match(explainWecomError(45009), /每分钟 20 条/)
assert.equal(explainWecomError(99999, 'weird key=abc123'), '企业微信返回错误 99999：weird key=****')
assert.equal(explainWecomError(77777), '企业微信返回错误 77777')
// ── 发文件白名单（send-guard） ──
{
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { checkSendAllowed, allowSendOnce, hasSendPermit } = await import('../../src/main/connectors/send-guard.ts')
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-send-'))
  const mk = (rel, body = 'hello world') => { const f = path.join(dataDir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f }
  const scope = { sessionId: 's1', dataDir }
  const ok = mk('agent-outputs/s1/exports/报告.docx')
  assert.equal(checkSendAllowed(ok, scope), null, '本会话导出目录里的文件放行')
  assert.ok(checkSendAllowed(mk('agent-outputs/s2/exports/别人的.docx'), scope), '别的会话的导出不行')
  assert.ok(checkSendAllowed(mk('agent-outputs/s1/index.json'), scope), '会话目录里导出目录以外的不行')
  // 数据集目录和内部文件一律拒绝，哪怕有一次性许可
  const ds = [mk('datasets/abc.sqlite'), mk('datasets/abc.codes.json'), mk('datasets/catalog.json'), mk('db.sqlite'), mk('db.sqlite-wal'), mk('agent-outputs/s1/exports/x.codes.json'), mk('agent-outputs/s1/exports/catalog.json')]
  for (const f of ds) { allowSendOnce(f); assert.ok(checkSendAllowed(f, scope), '应拒绝：' + f); assert.ok(checkSendAllowed(f, scope, { strict: false }), '预览也拒绝：' + f) }
  // 符号链接指到数据集：看真实路径
  const link = path.join(dataDir, 'agent-outputs/s1/exports/link.json')
  fs.symlinkSync(path.join(dataDir, 'datasets/catalog.json'), link)
  assert.ok(checkSendAllowed(link, scope), '软链接指向数据集也拒绝')
  // 用户在系统文件框选的文件：一次性许可，用一次就没了
  const picked = mk('桌面/汇报.pdf')
  assert.ok(checkSendAllowed(picked, scope), '没选过的文件不行')
  allowSendOnce(picked)
  assert.ok(hasSendPermit(picked))
  assert.equal(checkSendAllowed(picked, scope, { consume: true }), null)
  assert.ok(checkSendAllowed(picked, scope), '许可只用一次')
  // 预览阶段不知道会话：只认「像某个会话导出目录」的路径
  assert.equal(checkSendAllowed(ok, {}, { strict: false }), null)
  assert.ok(checkSendAllowed(mk('其它/a.docx'), {}, { strict: false }))
  assert.ok(checkSendAllowed(ok, {}), '严格模式没有会话信息就不放行')
}

console.log('wecom-core.test ✓')
