// 数据包里 settings 值的逐键校验、提示词的校验规则与读取侧的容错
import assert from 'node:assert/strict'
import { checkPackSetting } from '../../src/main/pack/settings-rules.ts'
import { promptProblem, sanitizeOverrides, isPromptKey, MAX_PROMPT_CHARS } from '../../src/main/ai/prompt-rules.ts'

const J = JSON.stringify
const ok = (k, v) => { const r = checkPackSetting(k, J(v)); assert.equal(r.ok, true, `${k}=${J(v)} 应通过：${r.note}`); return r }
const no = (k, raw) => { const r = checkPackSetting(k, typeof raw === 'string' ? raw : J(raw)); assert.equal(r.ok, false, `${k}=${raw} 应被丢弃`); assert.ok(r.note); return r }

// 提示词：必须是「合格 key → 合格文本」的纯对象
ok('ai_prompts', { 'p3_report.system': 'x' })
ok('ai_prompts', { 'p1_text.user': '{{KNOWLEDGE_TREE}}{{QUESTION_TYPES}}{{OCR_TEXT}}', 'p1_text.system': 'Return JSON' })
for (const bad of [null, 'abc', 5, [], true]) no('ai_prompts', bad)
no('ai_prompts', '{not json'); no('ai_prompts', {})                      // 空对象 = 没有任何合格条目
no('ai_prompts', { 'p3_report.user': 5 }); no('ai_prompts', { 'evil.key': 'x' }); no('ai_prompts', { 'p3_report.user': '缺占位符' })
no('ai_prompts', { 'p1_text.system': '没有那个词' }); no('ai_prompts', { 'p3_report.system': 'x'.repeat(MAX_PROMPT_CHARS + 1) })
assert.equal(ok('ai_prompts', { 'p3_report.system': 'x', 'p3_report.user': '坏的' }).note.includes('1 条自定义提示词不合格'), true, '部分合格：只丢坏的并说明')
assert.deepEqual(ok('ai_prompts', { 'p3_report.system': 'x', 'p3_report.user': '坏的' }).value, { 'p3_report.system': 'x' })
// 其它键
ok('ui_theme', 'dark'); ok('ui_language', 'zh'); ok('default_textbook', '人教PEP')
for (const k of ['ui_theme', 'ui_language']) { no(k, 5); no(k, null); no(k, ''); no(k, 'x'.repeat(41)); no(k, { a: 1 }); no(k, 'a\nb') }
no('default_textbook', 'x'.repeat(101)); no('default_textbook', 7); no('default_textbook', null)
no('ai_key_enc', 'x'); no('ai_config', {}); no('import_marker', 'x'); no('data_dir_custom', '/etc')   // 白名单以外的键永远不收

// 读取侧：存着的覆盖表是坏数据 → 当没有，回退默认，不报错
assert.deepEqual(sanitizeOverrides(null), {}); assert.deepEqual(sanitizeOverrides('abc'), {}); assert.deepEqual(sanitizeOverrides(5), {}); assert.deepEqual(sanitizeOverrides([1]), {})
assert.deepEqual(sanitizeOverrides({ 'p3_report.user': 5, 'p3_report.system': 'ok', 'bogus': 'x', 'p2_yoy.system': '   ' }), { 'p3_report.system': 'ok' })
assert.ok(isPromptKey('p1_vision.user') && !isPromptKey('p1_vision.other') && !isPromptKey('__proto__'))
assert.equal(promptProblem('p3_report.user', '{{KP_DIST}}{{QTYPE_DIST}}{{DIFF_DIST}}{{ERROR_PRONE}}'), null)
assert.match(promptProblem('p2_yoy.user', 'x'), /缺少必需的占位符/); assert.match(promptProblem('p1_text.system', 'x'), /JSON/); assert.match(promptProblem('p3_report.system', '  '), /不能为空/)
console.log('settings-rules.test ✓')
