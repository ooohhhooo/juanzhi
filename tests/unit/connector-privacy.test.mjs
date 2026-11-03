import assert from 'node:assert/strict'
import { detectPersonalInfo, privacyWarning } from '../../src/main/connectors/privacy.ts'

assert.equal(detectPersonalInfo('联系 13812345678 即可').phone, true)
assert.equal(detectPersonalInfo('编号 113812345678901').phone, false)
assert.equal(detectPersonalInfo('身份证 110101200801011234').idCard, true)
assert.equal(detectPersonalInfo('身份证 11010120080101123X').idCard, true)
assert.equal(detectPersonalInfo('张三、李四、王五 未完成').names, true)
assert.equal(detectPersonalInfo('张三 李四 王五').names, true)
assert.equal(detectPersonalInfo('- 张三\n- 李四\n- 王五\n').names, true)
assert.equal(detectPersonalInfo('本周正确率 85%，时态是薄弱点').any, false)
assert.equal(detectPersonalInfo('张三 本周进步明显').names, false)
assert.match(privacyWarning('电话 13812345678'), /内容可能包含个人信息.*手机号/)
assert.equal(privacyWarning('没有敏感信息'), undefined)
console.log('connector-privacy.test ✓')
