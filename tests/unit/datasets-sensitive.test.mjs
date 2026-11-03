// 敏感列识别、代号本往返、toModel / fromModel、代号稳定性与持久化、工具输出不含真名
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatasetStore } from '../../src/main/analysis/datasets/store.ts'
import { Codebook, detectSensitive, makeCode } from '../../src/main/analysis/datasets/sensitive.ts'
import { DATASET_TOOLS } from '../../src/main/analysis/datasets/tools.ts'

const require = createRequire(import.meta.url)
const P = (distinct, n = distinct) => ({ nonNull: n, nullRate: 0, distinct, examples: [], hints: [] })

// ── 列名关键词 ──
for (const [label, kind] of [['姓名', 'person'], ['学员姓名', 'person'], ['授课老师', 'person'], ['手机号', 'phone'], ['联系电话', 'phone'], ['身份证号', 'idcard'], ['家庭住址', 'address'], ['微信', 'other'], ['邮箱', 'email'], ['ldap', 'person'], ['工号', 'id'], ['用户id', 'id'], ['student_id', 'id'], ['学员编号', 'id']]) {
  const g = detectSensitive(label, 'text', P(200), Array.from({ length: 50 }, (_, i) => 'v' + i))
  assert.ok(g, label + ' 应识别为敏感'); assert.equal(g.kind, kind, label)
}
// 不该误伤
for (const label of ['年级', '渠道', '班级', '推荐分', '满意度', '课程名称', '提交时间']) assert.equal(detectSensitive(label, 'select', P(5, 100), ['a', 'b']), null, label + ' 不是敏感列')
assert.equal(detectSensitive('班级id', 'integer', P(5, 300), ['1', '2']), null, '低基数的 id 列不标')
assert.equal(detectSensitive('老师满意度', 'integer', P(5, 300), ['1', '2']), null, '数值的评分列不标')
assert.ok(detectSensitive('机构名称', 'text', P(200), ['x']), '名称类 + 取值很多才标')
assert.equal(detectSensitive('机构名称', 'select', P(4, 100), ['x']), null)
// ── 取值模式（列名看不出来） ──
const phones = Array.from({ length: 50 }, (_, i) => '1390000' + String(1000 + i))
assert.equal(detectSensitive('联络', 'integer', P(50), phones).kind, 'phone')
assert.equal(detectSensitive('备用', 'text', P(50), Array.from({ length: 50 }, (_, i) => `u${i}@example.com`)).kind, 'email')
assert.equal(detectSensitive('备用2', 'text', P(50), Array.from({ length: 50 }, (_, i) => `11010119900101${String(1000 + i)}`)).kind, 'idcard')
const cn = ['赵', '钱', '孙', '李', '周', '吴', '郑', '王'], gv = ['明', '华', '强', '芳', '军', '丽', '涛', '静', '磊', '洋']
const names = []; for (const a of cn) for (const b of gv) names.push(a + b)
assert.equal(detectSensitive('填表人', 'text', P(80), names).kind, 'person', '像人名的高基数短中文')
assert.equal(detectSensitive('填表人', 'text', P(3, 80), ['赵明', '钱华']), null)

// ── 代号本往返 ──
assert.equal(makeCode('person', 17), '人员A017'); assert.equal(makeCode('person', 1000), '人员B001'); assert.equal(makeCode('id', 231), '编号0231')
{
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-cb-')), 'x.codes.json')
  const b = new Codebook(f)
  const a = b.code('person', '张老师01'), c = b.code('person', '李老师02')
  assert.equal(a, '人员A001'); assert.equal(c, '人员A002'); assert.equal(b.code('person', '张老师01'), a, '同一原值同一代号')
  assert.equal(b.decode(`${a}比${c}好，${a}还行，人员A999 不认识`), '张老师01比李老师02好，张老师01还行，人员A999 不认识')
  b.flush()
  const b2 = new Codebook(f)
  assert.equal(b2.code('person', '李老师02'), c, '重新加载后仍稳定')
  assert.equal(b2.code('person', '王老师03'), '人员A003')
  assert.equal(b2.decode('人员A001'), '张老师01')
}

// ── 数据集级：导入虚构问卷，代号化 ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-ds-sens-'))
const store = new DatasetStore(tmp)
const { generate, TEACHERS, COACHES } = require('../fixtures/gen-ops-data.cjs')
await generate(path.join(tmp, 'ops'))
const d = await store.importFile(path.join(tmp, 'ops', 'survey.xlsx'))
const t = d.tables.find(x => x.sheet === '问卷')
const flag = label => t.columns.find(c => c.label === label)
for (const l of ['学员编号', '家长手机', '授课老师', '辅导老师']) assert.ok(flag(l).sensitive && flag(l).sensitiveAuto, l + ' 自动标为敏感')
for (const l of ['年级', '新老生', '渠道', '班级', '推荐分', '满意度']) assert.ok(!flag(l).sensitive, l + ' 不敏感')
const T = `d1."${t.name}"`
const allRealNames = [...TEACHERS, ...COACHES]
const leaks = obj => { const s = JSON.stringify(obj); return allRealNames.filter(n => s.includes(n)) }

// 查询结果里的敏感列 → 代号
let r = await store.runQuery(`select "${flag('授课老师').name}", count(*) n from ${T} group by 1 order by 1`, [d.id])
assert.ok(r.ok); assert.equal(r.rows.length, 5)
assert.ok(r.rows.every(x => /^人员[A-Z]\d{3}$/.test(x[0])), JSON.stringify(r.rows))
assert.deepEqual(leaks(r), [])
// 起别名也逃不掉（整格等于敏感值）
r = await store.runQuery(`select "${flag('辅导老师').name}" as who, count(*) from ${T} group by 1`, [d.id])
assert.ok(r.rows.every(x => /^人员/.test(x[0])), '别名后仍代号化')
// 数值型编号起别名：整列都是敏感值 → 代号；计数列不动
r = await store.runQuery(`select "${flag('学员编号').name}" as k, count(*) as n from ${T} group by 1 limit 3`, [d.id])
assert.ok(r.rows.every(x => /^编号\d{4}$/.test(x[0]) && x[1] === 1), JSON.stringify(r.rows))
// group_concat / 文字里夹着人名
r = await store.runQuery(`select group_concat(distinct "${flag('授课老师').name}") from ${T}`, [d.id])
assert.deepEqual(leaks(r), [], 'group_concat 里的人名也替换')
assert.match(String(r.rows[0][0]), /人员A\d{3}/)
// 不敏感的列原样
r = await store.runQuery(`select "${flag('年级').name}", count(*) from ${T} group by 1`, [d.id])
assert.ok(r.rows.some(x => x[0] === '四年级'))
// 计数结果恰好等于某个编号数值（如 100001）也不会被误替换：计数列名含 count / n
r = await store.runQuery(`select count(*) as total from ${T}`, [d.id])
assert.equal(r.rows[0][0], 300)

// SQL 里写代号 → 还原成原值再执行
const codeOfFirst = (await store.runQuery(`select "${flag('授课老师').name}" from ${T} where _row = 1`, [d.id])).rows[0][0]
const direct = await store.runQuery(`select count(*) as total from ${T} where "${flag('授课老师').name}" = '${codeOfFirst}'`, [d.id])
const real = store.fromModel([d.id], codeOfFirst)
assert.ok(TEACHERS.includes(real), '代号能还原：' + codeOfFirst + ' → ' + real)
assert.ok(direct.rows[0][0] > 0, '用代号筛选能查到')

// fromModel：模型回答里的代号 → 真名
assert.equal(store.fromModel([d.id], `${codeOfFirst} 的满意度最高`), `${real} 的满意度最高`)
// 代号稳定：新建仓库实例（从磁盘重读）代号不变
const store2 = new DatasetStore(tmp)
const again = (await store2.runQuery(`select "${flag('授课老师').name}" from ${T} where _row = 1`, [d.id])).rows[0][0]
assert.equal(again, codeOfFirst)
assert.ok(fs.existsSync(path.join(tmp, 'datasets', `${d.id}.codes.json`)))
// 映射表不在数据集 sqlite 里
const sqliteBytes = fs.readFileSync(path.join(tmp, 'datasets', `${d.id}.sqlite`))
assert.ok(!sqliteBytes.includes(Buffer.from('人员A001')), '代号只存在 codes.json')

// 概况文本 / 取值分布 / 工具输出 都不含真名
const ctx = { store }
const prof = await DATASET_TOOLS.find(x => x.name === 'dataset_profile').run({ datasetId: d.id, table: t.name }, ctx)
assert.deepEqual(leaks(prof), []); assert.match(prof.text, /人员A\d{3}/)
assert.ok(!/139\d{8}/.test(prof.text), '手机号不出现在概况里')
const cv = await DATASET_TOOLS.find(x => x.name === 'column_values').run({ datasetId: d.id, table: t.name, column: '授课老师' }, ctx)
assert.deepEqual(leaks(cv), []); assert.equal(cv.values.length, 5)
const lst = await DATASET_TOOLS.find(x => x.name === 'list_datasets').run({}, ctx)
assert.equal(lst.datasets.length, 1)
const rq = await DATASET_TOOLS.find(x => x.name === 'run_query').run({ sql: `select * from ${T} limit 20`, datasets: [d.id] }, ctx)
assert.ok(rq.ok); assert.deepEqual(leaks(rq), []); assert.ok(!/139\d{8}/.test(JSON.stringify(rq)))
// 用户备注里夹着真名，也会被代号化
store.setNote(d.id, `${TEACHERS[0]} 的班要重点看`)
const lst2 = await DATASET_TOOLS.find(x => x.name === 'list_datasets').run({}, ctx)
assert.deepEqual(leaks(lst2), []); assert.match(lst2.datasets[0].note, /人员A\d{3}/)

// 界面预览显示真名
const pv = store.preview(d.id, t.name)
assert.equal(pv.rows.length, 100); assert.ok(TEACHERS.includes(pv.rows[0][pv.columns.findIndex(c => c.label === '授课老师')]), '预览是原值')

// 用户改标记：取消敏感后不再代号化；再标回来
store.setSensitive(d.id, t.name, '授课老师', false)
// 名册表里的「教师」列同样是敏感列、取值相同：只要它还标着，这些值在任何结果里仍会被代号化（按值保护）
r = await store.runQuery(`select "${flag('授课老师').name}" from ${T} limit 3`, [d.id])
assert.ok(r.rows.every(x => /^人员/.test(x[0])), '同一批人名在别的敏感列里还标着：仍代号化')
store.setSensitive(d.id, d.tables.find(x => x.sheet === '教师名册').name, '教师', false)
r = await store.runQuery(`select "${flag('授课老师').name}" from ${T} limit 3`, [d.id])
assert.ok(r.rows.every(x => TEACHERS.includes(x[0])), '取消标记后是原值')
assert.equal(flag('授课老师').sensitiveAuto, false)
store.setSensitive(d.id, t.name, '年级', true)
r = await store.runQuery(`select "${flag('年级').name}" from ${T} limit 3`, [d.id])
assert.ok(r.rows.every(x => /^敏感值\d{4}$/.test(x[0])), '新标记生效：' + JSON.stringify(r.rows))
const prof2 = store.profileText(d.id, t.name)
assert.ok(!/四年级/.test(prof2.split('\n').find(l => l.includes('c03_年级'))), '新标的敏感列概况里不出现原值')


// ───────────────────────── 复审补丁：数字敏感列、海量人名、概况 / 目录原文、rawError ─────────────────────────
{
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-ds-sens2-'))
  const st = new DatasetStore(tmp2)
  const sur = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄'
  const nm = []
  for (let k = 0; k < 70; k++) for (const a of sur) nm.push(a + String.fromCharCode(0x4e30 + k * 7))   // 两个字的姓名，一共 7000 个左右
  assert.ok(new Set(nm).size > 5100, '不同的姓名要超过 5000：' + new Set(nm).size)
  const people = [...new Set(nm)]
  const N = people.length
  const lines = ['姓名,学号,手机号,评语,分数']
  people.forEach((n, i) => lines.push(`${n},${20230001 + i},${13900000000 + i},老师说${n}这次进步很大,${60 + (i % 40)}`))
  const ds = await st.importBuffer(Buffer.from(lines.join('\n')), people[10] + '的名单.csv')
  const tb = ds.tables[0]
  const col = l => tb.columns.find(c => c.label === l)
  assert.ok(col('姓名').sensitive && col('学号').sensitive && col('手机号').sensitive, '姓名 / 学号 / 手机号都自动标敏感：' + JSON.stringify(tb.columns.map(c => [c.label, c.sensitive, c.type])))
  const TT = `d1."${tb.name}"`
  const hasRaw = obj => { const j = JSON.stringify(obj); return people.find(n => j.includes(n)) || (/2023\d{4}/.test(j) ? '学号' : /139\d{8}/.test(j) ? '手机' : null) }

  // 数字敏感列：不论别名、行数都按值代号化（单行也是）；计数 / 统计量不受影响
  let q = await st.runQuery(`select max("${col('学号').name}") as x from ${TT}`, [ds.id])
  assert.ok(q.ok && /^编号\d{4}$/.test(q.rows[0][0]), '单行聚合出的学号：' + JSON.stringify(q.rows))
  q = await st.runQuery(`select "${col('手机号').name}" as foo from ${TT} limit 2`, [ds.id])
  assert.ok(q.rows.every(r => /^手机\d{4}$/.test(r[0])), '整数手机号起别名也代号化：' + JSON.stringify(q.rows))
  q = await st.runQuery(`select "${col('学号').name}" + 0 as k from ${TT} where _row = 5`, [ds.id])
  assert.ok(/^编号\d{4}$/.test(q.rows[0][0]), '表达式算出的学号也按值认')
  q = await st.runQuery(`select count(*) as 人数, sum("${col('分数').name}") as 总分, avg("${col('分数').name}") as 平均 from ${TT}`, [ds.id])
  assert.equal(q.rows[0][0], N); assert.ok(typeof q.rows[0][1] === 'number' && typeof q.rows[0][2] === 'number')

  // 超过 5000 个姓名：短名也在自由文本里被代号化
  q = await st.runQuery(`select "${col('评语').name}" from ${TT} where _row in (1, 3000, 5000, ${N})`, [ds.id])
  assert.ok(q.ok && q.rows.length === 4); assert.equal(hasRaw(q), null, '评语里的姓名已代号化：' + JSON.stringify(q.rows))
  assert.ok(q.rows.every(r => /老师说人员[A-Z]\d{3}这次进步很大/.test(r[0])), JSON.stringify(q.rows))
  q = await st.runQuery(`select group_concat("${col('姓名').name}" || ':' || "${col('学号').name}", '；') from ${TT} where _row <= 3`, [ds.id])
  assert.equal(hasRaw(q), null, '拼接文本里的姓名和学号都替换：' + JSON.stringify(q.rows))

  // 性能：10 万行 × 多列在几秒内
  const big = []
  for (let i = 0; i < 100000; i++) big.push([people[i % N], 20230001 + (i % N), `老师说${people[(i * 7) % N]}很好，第${i}次`, i % 5, '甲班'])
  const t0 = Date.now()
  const out = st.toModel([ds.id], ['x1', 'x2', 'x3', 'x4', 'x5'], big)
  const ms = Date.now() - t0
  assert.ok(ms < 8000, 'toModel 10 万行耗时 ' + ms + ' ms')
  assert.equal(hasRaw(out.slice(0, 200)), null); assert.equal(hasRaw(out.slice(-200)), null)
  assert.equal(out[5][3], 0); assert.equal(out[5][4], '甲班')

  // 概况 / 目录 / 列值：不含敏感原文（文件名里的人名、非敏感列里夹的手机号）
  const lst = await DATASET_TOOLS.find(x => x.name === 'list_datasets').run({}, { store: st })
  assert.equal(hasRaw(lst), null, '目录里没有文件名里的人名：' + JSON.stringify(lst))
  assert.match(lst.datasets[0].sourceFile, /人员[A-Z]\d{3}的名单\.csv/)
  const prof = st.profileText(ds.id)
  assert.equal(hasRaw(prof), null, '概况没有姓名 / 学号 / 手机号')
  const cv = st.columnValues(ds.id, tb.name, '评语', 5)
  assert.equal(hasRaw(cv), null, '列值里的自由文本也过一遍')
  assert.equal(hasRaw(st.schemaText([ds.id])), null)
  // 非敏感列里夹着手机号：概况的示例 / 常见取值里不出现
  const st2 = new DatasetStore(fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-ds-sens3-')))
  const rows2 = ['备注,分数']; for (let i = 0; i < 40; i++) rows2.push(`${['请联系13912345678', '微信 wxid_abcdef' + i, '无'][i % 3]},${i}`)
  const d3 = await st2.importBuffer(Buffer.from(rows2.join('\n')), 'x.csv')
  const prof3 = st2.profileText(d3.id)
  assert.ok(!/13912345678/.test(prof3), '示例里的手机号被去掉：' + prof3)

  // rawError 不外泄；SQL 里的代号被还原后报错，错误里也不能带真名
  const c1 = (await st.runQuery(`select "${col('姓名').name}" from ${TT} where _row = 1`, [ds.id])).rows[0][0]
  q = await st.runQuery(`select * from d1."${c1}"`, [ds.id])
  assert.ok(!q.ok && !('rawError' in q)); assert.equal(hasRaw(q), null, '错误信息里没有真名：' + JSON.stringify(q.message) + q.detail)
  const rqt = await DATASET_TOOLS.find(x => x.name === 'run_query').run({ sql: 'select nope from ' + TT, datasets: [ds.id] }, { store: st })
  assert.ok(rqt.ok === false && !JSON.stringify(rqt).includes('rawError'))
}
// 代号本从 JSON 读回：__proto__ / constructor 键不会污染也不会冲突
{
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-cb2-')), 'y.codes.json')
  fs.writeFileSync(f, '{"kinds":{"person":{"n":2,"fwd":{"__proto__":"人员A001","constructor":"人员A002","张三":"人员A003"}}}}')
  const cb = new Codebook(f)
  assert.equal(cb.lookup('person', 'toString'), undefined, '没有从原型链上借来的键')
  assert.equal(cb.lookup('person', '__proto__'), '人员A001'); assert.equal(cb.lookup('person', 'constructor'), '人员A002')
  assert.ok(cb.code('person', 'hasOwnProperty').startsWith('人员'))
  assert.equal({}.polluted, undefined)
  assert.equal(cb.decode('人员A001'), '__proto__')
}

console.log('datasets-sensitive.test ✓')
