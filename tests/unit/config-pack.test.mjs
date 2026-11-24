// 定制包：导出时去掉所有密钥、读取时校验、导入前的预览（新增 / 替换 / 相同）、只处理勾选的项目
import assert from 'node:assert/strict'
import { buildPack, serializePack, parsePack, previewPack, applyPack, looksSecret, redactArg, PACK_FORMAT } from '../../src/main/agent/pack/pack.ts'

const role = { id: 'c-abc123', name: '续费跟进', description: '你在帮班主任跟进续费', tools: ['stats_overview', 'run_query'], suggestions: ['谁快到期了'], notes: '只列需要的字段' }
const skill = { name: '家长话术', description: '写话术', roles: ['tutor'], when: '写话术时', body: '# 家长话术\n1. 用 `stats_overview` 看整体\n', version: 3, sampleCount: 4 }
const SECRET_ENV = 'sk-abcdefghijklmnop1234567890'
const SECRET_URL = 'https://mcp.example.com/v1/hook?key=abcdef1234567890abcdef'
const mcp = {
  type: 'mcp', name: '文档服务', pub: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything', '--token=ghp_abcdefghijklmnopqrstuvwx', 'ordinary'], preset: 'x', extra: '不该带' },
  envKeys: ['DOC_API_KEY'], headerKeys: [], secretArgsCount: 1, hasSecretUrl: false
}
const wecom = { type: 'wecom', name: '三年级群', pub: {}, envKeys: [], headerKeys: [], secretArgsCount: 0, hasSecretUrl: false, secretFieldNames: ['webhook'] }
const http = { type: 'mcp', name: '网址服务', pub: { transport: 'http' }, envKeys: [], headerKeys: ['Authorization'], secretArgsCount: 0, hasSecretUrl: true }

// ───── 导出：没有任何密钥 ─────
{
  const { pack, warnings } = buildPack({ roles: [role], skills: [skill], prompts: { 'p7_role_draft.system': '你是顾问。只输出 JSON。' }, connectors: [mcp, wecom, http], now: new Date('2026-11-20T00:00:00Z') })
  const text = serializePack(pack)
  assert.ok(!text.includes(SECRET_ENV) && !text.includes('ghp_abcdefghijklmnop') && !text.includes('abcdef1234567890abcdef'), '密钥一个字都不在文件里')
  assert.ok(!text.includes('c-abc123'), '角色 id 不带出去')
  assert.ok(!text.includes('不该带'), '连接里不认识的字段不带')
  const c = pack.connectors[0]
  assert.deepEqual(c.needs.env, ['DOC_API_KEY'], '只带环境变量的名字，没有值'); assert.equal(c.needs.secretArgs, 1)
  assert.equal(c.pub.args[2], '--token=〈请填写〉'); assert.equal(c.pub.args[3], 'ordinary'); assert.equal(c.pub.args[1], '@modelcontextprotocol/server-everything', '普通的长包名不当密钥')
  assert.equal(pack.connectors[1].needs.other[0], 'webhook'); assert.equal(pack.connectors[2].needs.url, true); assert.deepEqual(pack.connectors[2].needs.headers, ['Authorization'])
  assert.equal(pack.skills[0].version, 3); assert.equal(pack.format, PACK_FORMAT)
  assert.deepEqual(warnings, [])
  assert.ok(!/papers|questions|agent_steps|学员|对话/.test(Object.keys(pack).join()), '包里没有试卷 / 学员 / 对话')
  // 手滑把密钥写进 Skill 或角色说明：给出警告
  const w = buildPack({ roles: [{ ...role, notes: `api_key: ${SECRET_ENV}` }], skills: [{ ...skill, body: `用 Bearer abcdefghijklmnopqrstuvwxyz 调用` }], prompts: {}, connectors: [] }).warnings
  assert.equal(w.length, 2)
  assert.ok(looksSecret(SECRET_ENV) && looksSecret(SECRET_URL) && !looksSecret('一段普通的中文说明，没有密钥') && !looksSecret('@modelcontextprotocol/server-filesystem'))
  assert.equal(redactArg('--api-key=hello'), '--api-key=〈请填写〉'); assert.equal(redactArg('/tmp/data'), '/tmp/data')
}

// ───── 读取：格式、大小、被手改过 ─────
{
  assert.equal(parsePack('不是 json').ok, false)
  assert.equal(parsePack(JSON.stringify({ format: 'other' })).ok, false)
  assert.equal(parsePack(JSON.stringify({ format: PACK_FORMAT, roles: [{ name: '' }] })).ok, false)
  assert.equal(parsePack('x'.repeat(3 * 1024 * 1024)).ok, false)
  const hand = parsePack(JSON.stringify({ format: PACK_FORMAT, prompts: { 'no_such.system': 'x', 'p7_role_draft.system': '完全没有那个关键字样' }, connectors: [{ type: 'mcp', name: 'a', pub: { command: 'run', args: [`--token=${SECRET_ENV}`] } }] }))
  assert.ok(hand.ok); assert.equal(Object.keys(hand.pack.prompts).length, 0); assert.equal(hand.dropped.length, 2)
  assert.ok(!JSON.stringify(hand.pack).includes(SECRET_ENV), '被手改塞进来的密钥读取时也去掉')
}

// ───── 预览与导入 ─────
{
  const { pack } = buildPack({ roles: [role, { ...role, name: '新角色', tools: ['stats_overview', 'not_here'] }], skills: [skill, { ...skill, name: '周报', body: '# 周报\n步骤\n' }, { ...skill, name: '学情周报' }], prompts: { 'p7_role_draft.system': '你是顾问。只输出 JSON。' }, connectors: [mcp, wecom] })
  const cur = {
    roles: [{ ...role, description: '旧的说明' }],
    userSkills: [{ name: '家长话术', description: '写话术', when: '', body: skill.body, version: 1 }, { name: '周报', description: '写话术', when: '', body: '# 周报\n旧步骤\n', version: 2 }],
    builtinSkillNames: new Set(['学情周报']),
    prompts: {}, connectors: [{ type: 'mcp', name: '文档服务' }], knownTools: new Set(['stats_overview', 'run_query'])
  }
  const items = previewPack(pack, cur)
  const f = (k, key) => items.find(i => i.kind === k && i.key === key)
  assert.equal(f('role', '续费跟进').status, 'replace'); assert.equal(f('role', '续费跟进').selected, false, '要替换的默认不勾')
  assert.equal(f('role', '新角色').status, 'add'); assert.ok(f('role', '新角色').note.includes('1 个功能'), '提示有工具这台电脑没有')
  assert.equal(f('skill', '家长话术').status, 'same'); assert.equal(f('skill', '周报').status, 'replace'); assert.ok(f('skill', '周报').note.includes('恢复'))
  assert.equal(f('skill', '学情周报').status, 'add'); assert.ok(f('skill', '学情周报').note.includes('内置'), '和内置同名要说清')
  assert.equal(f('prompt', 'p7_role_draft.system').status, 'add')
  assert.equal(f('connector', 'mcp:文档服务').status, 'replace'); assert.ok(f('connector', 'mcp:文档服务').note.includes('不会立刻运行') && f('connector', 'mcp:文档服务').note.includes('DOC_API_KEY'))
  assert.equal(f('connector', 'wecom:三年级群').status, 'add'); assert.ok(f('connector', 'mcp:文档服务').detail.startsWith('npx'))

  // 只处理勾选的；单个失败不影响其他
  const log = []
  const deps = {
    saveRole: (r, id) => log.push(['role', r.name, id, r.tools.join()]),
    saveSkill: (s, ex) => { log.push(['skill', s.name, ex]); return { warnings: [] } },
    savePrompt: (k) => log.push(['prompt', k]),
    saveConnector: c => (c.type === 'wecom' ? { ok: false, note: '要填密钥' } : (log.push(['conn', c.name]), { ok: true, note: '' }))
  }
  const res = applyPack(pack, cur, new Set(['role:新角色', 'skill:周报', 'skill:家长话术', 'connector:mcp:文档服务', 'connector:wecom:三年级群']), deps)
  assert.deepEqual(log.map(l => l[0] + ':' + l[1]), ['role:新角色', 'skill:周报', 'conn:文档服务'], '没勾的（续费跟进、学情周报、提示词）不动；相同的不重复写')
  assert.equal(log[0][3], 'stats_overview', '这台电脑没有的工具去掉'); assert.equal(log[1][2], '周报', '替换时带上旧名字')
  assert.equal(res.added, 1); assert.equal(res.replaced, 2); assert.ok(res.notes.some(n => n.includes('三年级群')) && res.skipped >= 4)
  assert.deepEqual(res.needSecrets, ['文档服务'], '导入后提醒去填密钥')
}
console.log('config-pack ok')
