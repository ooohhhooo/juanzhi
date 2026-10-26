// 知识点树编辑：新增 / 改名 / 移动 / 合并 / 停用 / 删除。节点 ID 稳定、内置节点只能改名（不能移动 / 合并掉 / 删除）、
// 合并把题目关联迁到目标且统计口径正确（同一份卷子里同时有两个节点只算一份）、编辑推高数据修订号、一批操作要么全成要么全不成。
import assert from 'node:assert/strict'
import { newDb, addPaper } from './helpers/db.mjs'
import * as S from '../../src/main/stats/core.ts'
import { saveTaxonomy, TaxonomyError } from '../../src/main/taxonomy/edit.ts'

const { db } = newDb()
const rev = () => db.prepare('SELECT rev r FROM data_rev').get().r
const kp = c => db.prepare('SELECT * FROM kps WHERE code = ?').get(c)
const fails = (ops, re) => assert.throws(() => saveTaxonomy(db, ops), e => e instanceof TaxonomyError && re.test(e.message), String(re))
const stat = (code, f = {}) => S.distribution(db, f).nodes.find(n => n.code === code)
const kpsOf = qid => db.prepare('SELECT kp_code, is_primary FROM question_kps WHERE question_id = ? ORDER BY is_primary DESC, kp_code').all(qid).map(r => `${r.kp_code}${r.is_primary ? '*' : ''}`)

// 内置节点：GR.TENSE.PAST.REG / .IRREG（3 级）、FN.SHOP（2 级）
const Q = (k, sec = [], score = 2) => ({ kp: k, sec, score, difficulty: 3 })
addPaper(db, { title: 'p1', questions: [Q('GR.TENSE.PAST.REG'), Q('FN.SHOP')] })
addPaper(db, { title: 'p2', questions: [Q('GR.TENSE.PAST.IRREG')] })

// ── 新增 ──
let r = saveTaxonomy(db, [{ op: 'add', parent_code: 'GR.TENSE', name: '时态小测（自建）', note: '例：last week', intro_grade: 5 }])
assert.deepEqual(r.touched, ['GR.TENSE.U1'])
const n1 = kp('GR.TENSE.U1')
assert.deepEqual([n1.parent_code, n1.name, n1.level, n1.builtin, n1.deprecated, n1.intro_grade, n1.note], ['GR.TENSE', '时态小测（自建）', 2, 0, 0, 5, '例：last week'])
saveTaxonomy(db, [{ op: 'add', parent_code: 'GR.TENSE.U1', name: '三级自建' }])
assert.equal(kp('GR.TENSE.U1.U1').level, 3)
fails([{ op: 'add', parent_code: 'GR.TENSE.U1.U1', name: '第四层' }], /最多 3 层/)
fails([{ op: 'add', parent_code: 'GR.TENSE', name: '时态小测（自建）' }], /已经有叫/)
fails([{ op: 'add', parent_code: 'GR.TENSE', name: '   ' }], /名称不能为空/)
fails([{ op: 'add', parent_code: 'GR.TENSE', name: 'x'.repeat(31) }], /30 个字/)
fails([{ op: 'add', parent_code: 'NOPE', name: 'x' }], /不存在/)
saveTaxonomy(db, [{ op: 'add', parent_code: null, name: '自建的一级' }])
assert.equal(kp('U.U1').level, 1, '一级节点的代码以 U 开头')

// ── 改名：代码不变；内置节点可以改名；改名推高修订号，统计立刻用新名字，标注没动 ──
let before = rev()
saveTaxonomy(db, [{ op: 'update', code: 'GR.TENSE.PAST.REG', name: '规则动词过去式（改）' }])
assert.equal(kp('GR.TENSE.PAST.REG').name, '规则动词过去式（改）'); assert.equal(kp('GR.TENSE.PAST.REG').builtin, 1)
assert.ok(rev() > before, '改名推高数据修订号（看板和 AI 缓存据此失效）')
assert.equal(stat('GR.TENSE.PAST.REG').name, '规则动词过去式（改）')
assert.equal(db.prepare("SELECT COUNT(*) c FROM question_kps WHERE kp_code = 'GR.TENSE.PAST.REG'").get().c, 1, '题目标注没动')
fails([{ op: 'update', code: 'GR.TENSE.PAST.IRREG', name: '规则动词过去式（改）' }], /已经有叫/)
fails([{ op: 'update', code: 'GR.TENSE.PAST.IRREG', intro_grade: 9 }], /1–6/)
saveTaxonomy(db, [{ op: 'update', code: 'GR.TENSE.PAST.IRREG', note: '改过的说明', intro_grade: null }])
assert.deepEqual([kp('GR.TENSE.PAST.IRREG').note, kp('GR.TENSE.PAST.IRREG').intro_grade], ['改过的说明', null])

// ── 移动：自建节点可以移；内置不行；不能成环；不能超过 3 层 ──
fails([{ op: 'move', code: 'FN.SHOP', parent_code: 'GR.TENSE' }], /内置知识点，只能改名，不能移动/)
fails([{ op: 'move', code: 'GR.TENSE.U1', parent_code: 'GR.TENSE.U1.U1' }], /自己或它的子节点/)
fails([{ op: 'move', code: 'GR.TENSE.U1', parent_code: 'GR.TENSE.PAST' }], /超过 3 层/)   // U1 带着一个子节点，挂到二级节点下会变 4 层
saveTaxonomy(db, [{ op: 'move', code: 'GR.TENSE.U1', parent_code: 'FN' }])
assert.deepEqual([kp('GR.TENSE.U1').parent_code, kp('GR.TENSE.U1').level, kp('GR.TENSE.U1.U1').level], ['FN', 2, 3], '移动后代码不变，自己和子树的层级跟着变')
saveTaxonomy(db, [{ op: 'move', code: 'GR.TENSE.U1', parent_code: null }])
assert.deepEqual([kp('GR.TENSE.U1').parent_code, kp('GR.TENSE.U1').level, kp('GR.TENSE.U1.U1').level], [null, 1, 2])
saveTaxonomy(db, [{ op: 'move', code: 'GR.TENSE.U1', parent_code: 'GR.TENSE' }])   // 放回去

// ── 合并：S → T ──
// 数据：q1 主=S；q2 主=S 次=T；q3 主=T 次=S；q4 主=X 次=S；q5 主=T（不涉及 S）。每题一份卷子（q2/q3 在同一份里：看"同一份卷子里同时有 S 和 T 只算一份"）
const SRC = 'GR.TENSE.U1', DST = 'GR.TENSE.FUT'
const pa = addPaper(db, { title: 'm1', questions: [Q(SRC), Q(SRC, [DST]), Q(DST, [SRC])] })
const pb = addPaper(db, { title: 'm2', questions: [Q('FN.SHOP', [SRC])] })
const pc = addPaper(db, { title: 'm3', questions: [Q(DST)] })
const qs = id => db.prepare('SELECT id FROM questions WHERE paper_id = ? ORDER BY ord').all(id).map(r => r.id)
const [mq1, mq2, mq3] = qs(pa), [mq4] = qs(pb)
const sBefore = stat(SRC), tBefore = stat(DST)
assert.deepEqual([sBefore.papers, sBefore.questions, tBefore.papers, tBefore.questions], [2, 4, 2, 3], '合并前：S 在 m1、m2 里共 4 道题（主 2 + 次 2）；T 在 m1、m3 里共 3 道题（含次知识点）')
// 先给 S 一个会被"挂到 T 下面"的子节点（层数合适）：S 是二级、T 也是二级，子节点是三级 → 合并后仍是三级
before = rev()
saveTaxonomy(db, [{ op: 'merge', code: SRC, into: DST }])
assert.ok(rev() > before, '合并推高修订号')
assert.deepEqual(kpsOf(mq1), [`${DST}*`], 'q1：主 S → 主 T')
assert.deepEqual(kpsOf(mq2), [`${DST}*`], 'q2：主 S 次 T → 只留一条 T，主知识点优先')
assert.deepEqual(kpsOf(mq3), [`${DST}*`], 'q3：主 T 次 S → 只留 T')
assert.deepEqual(kpsOf(mq4), ['FN.SHOP*', `${DST}`], 'q4：次 S → 次 T')
assert.equal(db.prepare('SELECT COUNT(*) c FROM question_kps WHERE kp_code = ?').get(SRC).c, 0, 'S 下面一道题也不剩')
assert.deepEqual([kp(SRC).deprecated, kp(SRC).merged_into], [1, DST], 'S 停用并记下去向')
assert.equal(kp('GR.TENSE.U1.U1').parent_code, DST, 'S 的子节点挂到了 T 下面')
assert.equal(kp('GR.TENSE.U1.U1').level, 3)
// 统计：T 现在 = 原来 T 的题 + S 的题，同一份卷子只算一份；S 不再出现
const tAfter = stat(DST)
assert.equal(stat(SRC), undefined, '合并后 S 在统计里消失')
assert.equal(tAfter.papers, 3, '含 T 的卷子：m1、m2（q4 的次 T）、m3 → 3 份（m1 里 S 和 T 都有，只算一份）')
assert.equal(tAfter.questions, 5, 'q1 q2 q3 q4 + m3 的一道 = 5 道题（一道题只算一次）')
assert.equal(tAfter.score, 2 + 2 + 2 + 2, '分值只按主知识点算：q1 q2 q3 + m3 的 = 8 分（q4 的主知识点是购物）')
// 父级向上汇总也一致：一级「时态」含 p1 p2 m1 m2 m3 共 5 份
assert.equal(stat('GR.TENSE').papers, 5)
// S 已经合并掉了，再合并一次会被拒绝（目标已停用 / 源已停用都不行）
fails([{ op: 'merge', code: SRC, into: DST }], /已经合并到别的知识点了/)
fails([{ op: 'merge', code: 'GR.TENSE.U1.U1', into: SRC }], /已停用/)
// 链式合并：以前合并到 U2 的，U2 再合并走后，指向的是最终目标
saveTaxonomy(db, [{ op: 'add', parent_code: 'GR.TENSE', name: '临时 A' }, { op: 'add', parent_code: 'GR.TENSE', name: '临时 B' }])
assert.equal(kp('GR.TENSE.U2').name, '临时 A'); assert.equal(kp('GR.TENSE.U3').name, '临时 B')
saveTaxonomy(db, [{ op: 'merge', code: 'GR.TENSE.U2', into: 'GR.TENSE.U3' }])
saveTaxonomy(db, [{ op: 'merge', code: 'GR.TENSE.U3', into: DST }])
assert.equal(kp('GR.TENSE.U2').merged_into, DST, 'U2 先并到 U3、U3 再并到 T 后，U2 也直接指向 T')

// ── 合并的限制 ──
fails([{ op: 'merge', code: 'FN.SHOP', into: 'FN.DIR' }], /内置知识点，只能改名，不能合并掉/)
fails([{ op: 'merge', code: DST, into: DST }], /合并到它自己/)
saveTaxonomy(db, [{ op: 'add', parent_code: 'FN', name: '自建甲' }])
const mine = 'FN.U1'
fails([{ op: 'merge', code: mine, into: SRC }], /已停用/)
saveTaxonomy(db, [{ op: 'merge', code: mine, into: 'FN.SHOP' }])   // 内置节点可以作为合并的目标
assert.deepEqual([kp(mine).deprecated, kp(mine).merged_into], [1, 'FN.SHOP'])
saveTaxonomy(db, [{ op: 'add', parent_code: 'FN', name: '父' }])
saveTaxonomy(db, [{ op: 'add', parent_code: 'FN.U2', name: '子' }])
fails([{ op: 'merge', code: 'FN.U2', into: 'FN.U2.U1' }], /自己的子节点/)
saveTaxonomy(db, [{ op: 'add', parent_code: 'GR.TENSE.PAST', name: '深一层' }])   // 三级
fails([{ op: 'merge', code: 'FN.U2', into: 'GR.TENSE.PAST.U1' }], /超过 3 层/)

// ── 停用 / 重新启用：内置节点也可以（可逆）；停用整棵子树；有合并去向的不能重新启用 ──
saveTaxonomy(db, [{ op: 'deprecate', code: 'GR.TENSE.PAST', deprecated: true }])
assert.deepEqual(['GR.TENSE.PAST', 'GR.TENSE.PAST.REG', 'GR.TENSE.PAST.IRREG', 'GR.TENSE.PAST.AUX'].map(c => kp(c).deprecated), [1, 1, 1, 1], '停用连同子树')
assert.ok(stat('GR.TENSE.PAST.REG'), '停用不影响统计：已有标注的节点照常出现')
fails([{ op: 'deprecate', code: 'GR.TENSE.PAST.REG', deprecated: false }], /上级「.+」还停用着/)
fails([{ op: 'add', parent_code: 'GR.TENSE.PAST', name: '新的' }], /已停用/)
saveTaxonomy(db, [{ op: 'deprecate', code: 'GR.TENSE.PAST', deprecated: false }, { op: 'deprecate', code: 'GR.TENSE.PAST.REG', deprecated: false }])
assert.deepEqual([kp('GR.TENSE.PAST').deprecated, kp('GR.TENSE.PAST.REG').deprecated, kp('GR.TENSE.PAST.IRREG').deprecated], [0, 0, 1])
fails([{ op: 'deprecate', code: SRC, deprecated: false }], /已经合并到别的知识点/)

// ── 删除：内置不能删；有子节点 / 有标注 / 合并掉的不能删；干净的自建节点可以删 ──
fails([{ op: 'delete', code: 'FN.SHOP' }], /内置知识点，不能删除/)
fails([{ op: 'delete', code: 'FN.U2' }], /还有子节点/)
fails([{ op: 'delete', code: mine }], /已经合并到别的知识点/)
saveTaxonomy(db, [{ op: 'add', parent_code: 'FN', name: '待删' }])
const doomed = 'FN.U3'
assert.equal(kp(doomed).name, '待删')
addPaper(db, { title: 'u', questions: [Q(doomed)] })
fails([{ op: 'delete', code: doomed }], /标注了 1 道题/)
saveTaxonomy(db, [{ op: 'add', parent_code: 'FN', name: '空节点' }])
saveTaxonomy(db, [{ op: 'delete', code: 'FN.U4' }])
assert.equal(kp('FN.U4'), undefined)

// ── 一批操作原子：第二步失败，第一步也不留 ──
{
  const snap = () => JSON.stringify(db.prepare('SELECT * FROM kps ORDER BY code').all()) + JSON.stringify(db.prepare('SELECT * FROM question_kps ORDER BY question_id, kp_code').all()) + rev()
  const s0 = snap()
  fails([{ op: 'update', code: 'FN.SHOP', name: '购物（改名了）' }, { op: 'delete', code: 'FN.SHOP' }], /第 2 步：.*内置知识点/)
  assert.equal(snap(), s0, '整批回滚：连第 1 步的改名和修订号都没留下')
  saveTaxonomy(db, [{ op: 'update', code: 'FN.SHOP', name: '购物（改名了）' }, { op: 'update', code: 'FN.DIR', name: '问路（改名了）' }])
  assert.deepEqual([kp('FN.SHOP').name, kp('FN.DIR').name], ['购物（改名了）', '问路（改名了）'])
}
// 节点 ID（代码）稳定：整个编辑过程里内置节点的代码一个都没丢，也没有被改
{
  const { db: fresh } = newDb()
  const seeded = fresh.prepare('SELECT code FROM kps WHERE builtin = 1').all().map(r => r.code).sort()
  const now = db.prepare('SELECT code FROM kps WHERE builtin = 1').all().map(r => r.code).sort()
  assert.deepEqual(now, seeded, '内置节点的代码集合与出厂时完全一致')
}
// 编辑后统计口径没有被破坏：停用的节点和合并掉的节点都不会让同一份卷子重复计数
{
  const d = S.distribution(db, {})
  const t = d.nodes.find(n => n.code === DST)
  assert.ok(t.papers <= d.papers, '出现份数不会超过总份数')
  assert.equal(d.nodes.find(n => n.code === 'GR.TENSE.U1'), undefined)
}
// 审核 P2-10b：重新启用一个已停用的节点时，同级有同名的启用节点 → 拒绝（不能造出两个同名同级）
{
  saveTaxonomy(db, [{ op: 'add', parent_code: 'FN', name: '重名测试' }])
  const code = db.prepare("SELECT code FROM kps WHERE name = '重名测试'").get().code
  saveTaxonomy(db, [{ op: 'deprecate', code, deprecated: true }])
  saveTaxonomy(db, [{ op: 'add', parent_code: 'FN', name: '重名测试' }])   // 停用的不算重名，可以再建一个同名的
  fails([{ op: 'deprecate', code, deprecated: false }], /同一级下已经有叫「重名测试」/)
  assert.equal(kp(code).deprecated, 1, '被拒绝后仍是停用的')
  saveTaxonomy(db, [{ op: 'update', code: db.prepare("SELECT code FROM kps WHERE name = '重名测试' AND deprecated = 0").get().code, name: '重名测试改' }])
  saveTaxonomy(db, [{ op: 'deprecate', code, deprecated: false }])
  assert.equal(kp(code).deprecated, 0, '改名之后可以启用')
}
console.log('taxonomy-edit.test ✓')
