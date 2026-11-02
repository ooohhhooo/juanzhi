// 诊断包的规则：配置脱敏、CSV、说明文字、反馈链接。黄金测试：喂入假密钥 / 假标题 / 假题干，输出里全文搜索必须找不到
import assert from 'node:assert/strict'
import { scrubConfig, toCsv, csvCell, buildReadme, feedbackUrl, shortDiagnosis, shortPaperId, DIAG_NEVER_INCLUDED } from '../../src/main/diagnostics-core.ts'

const SECRET = 'sk-GOLDEN-SECRET-123456'
const cfg = {
  provider: 'deepseek', base_url: `https://user:pw@api.example.com/v1/secret-path?key=${SECRET}`, model: 'm1', vision_model: 'v1',
  concurrency: 8, max_tokens: 32768, max_tokens_auto: true, api_key: SECRET, apiKey: SECRET, secret: 'x', authorization: 'Bearer y',
  nested: { api: SECRET }
}
const out = scrubConfig(cfg, true)
const text = JSON.stringify(out)
assert.ok(!text.includes(SECRET) && !text.includes('secret-path') && !text.includes('pw@') && !text.includes('Bearer'), text)
assert.ok(String(out.base_host).endsWith('api.example.com'))
assert.equal(out.api_key, '已设置')
assert.equal(out.concurrency, 8)
assert.equal(out.max_tokens, 32768, 'max_tokens 不是密钥，要保留')
assert.equal(out.nested, undefined, '对象类字段一律不带')
assert.equal(scrubConfig({ base_url: '' }, false).api_key, '未设置')

// CSV：引号、逗号、换行、公式前缀
assert.equal(csvCell('a,b'), '"a,b"')
assert.equal(csvCell('say "hi"'), '"say ""hi"""')
assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)")
assert.equal(csvCell(-3), '-3')
assert.equal(toCsv(['a', 'b'], [[1, 'x,y']]), 'a,b\n1,"x,y"\n')

// 试卷只用 8 位短编号
assert.equal(shortPaperId('0123456789abcdef-0000'), '01234567')

// 说明文字：列出永远不包含的内容，且不含任何密钥
const readme = buildReadme('1.3.0-beta.1', '2026-11-02')
for (const n of DIAG_NEVER_INCLUDED) assert.ok(readme.includes(n))
assert.ok(readme.includes('github.com/ooohhhooo/juanzhi/issues'))
assert.ok(!readme.includes(SECRET))

// 反馈链接：官方仓库的新建 Issue 页，预填版本和系统，提醒附诊断包、不要写学生姓名和密钥，长度在安全范围
const url = feedbackUrl({ version: '1.3.0-beta.1', platform: 'darwin', arch: 'arm64', osRelease: '25.0' })
const u = new URL(url)
assert.equal(u.origin + u.pathname, 'https://github.com/ooohhhooo/juanzhi/issues/new')
const body = u.searchParams.get('body')
assert.ok(body.includes('1.3.0-beta.1') && body.includes('darwin arm64') && body.includes('诊断') && body.includes('学生姓名') && body.includes('API Key'))
assert.ok(url.length < 2000, `链接太长：${url.length}`)

// 简短诊断 5 行
assert.equal(shortDiagnosis({ version: '1', platform: 'win32', arch: 'x64', osRelease: '10', model: 'm', visionModel: '', ocr: '可用' }).split('\n').length, 5)
console.log('diagnostics-core.test ✓')
