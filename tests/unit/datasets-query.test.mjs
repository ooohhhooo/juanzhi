// 只读查询执行器：SQL 防护、只读打开、行数上限、超时、白话错误、多数据集关联
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatasetStore } from '../../src/main/analysis/datasets/store.ts'
import { checkSql, runReadOnly, QUERY_LIMITS } from '../../src/main/analysis/datasets/query.ts'
import { DATASET_TOOLS } from '../../src/main/analysis/datasets/tools.ts'

// ── checkSql：放行 ──
for (const ok of [
  'select 1', 'SELECT * FROM d1."t" WHERE a = 1;', 'with x as (select 1) select * from x', '  select replace(a, \'x\', \'y\') from t',
  'select a from t -- 注释里写 delete from t', "select 'drop table x; pragma foo' as s", 'select "update" from t', 'select /* attach database */ 1',
  "select 'it''s' from t", 'select a from t;;'
]) assert.ok(checkSql(ok).ok, '应放行：' + ok)
// ── checkSql：拒绝 ──
const bad = {
  'delete from t': /SELECT/, 'update t set a=1': /SELECT/, 'insert into t values (1)': /SELECT/, 'drop table t': /SELECT/, 'create table x(a)': /SELECT/, 'alter table t add c': /SELECT/,
  'pragma table_info(t)': /SELECT/, "attach database 'x.db' as y": /SELECT/, 'vacuum': /SELECT/, 'replace into t values (1)': /SELECT/,
  'select 1; select 2': /一次只能/, 'select 1; delete from t': /一次只能/, 'select 1;\ndrop table t': /一次只能/,
  'with x as (select 1) delete from t': /DELETE/, 'with x as (select 1) insert into t select * from x': /INSERT/,
  'select * from t where a in (select 1) ; pragma query_only=off': /一次只能/, 'select 1 /* 没闭合': /没闭合/, "select 'abc": /没闭合/, '': /空/, '   ;  ': /空/,
  'select 1 union select 2 ; ': null
}
for (const [sql, re] of Object.entries(bad)) {
  const r = checkSql(sql)
  if (re === null) { assert.ok(r.ok, sql); continue }
  assert.ok(!r.ok && re.test(r.message), `应拒绝：${JSON.stringify(sql)} → ${r.message}`)
}
// 注释把关键字藏起来、大小写混写、换行混写
assert.ok(!checkSql('sel/**/ect 1').ok)
assert.ok(!checkSql('SeLeCt 1; DrOp TABLE t').ok)
assert.ok(!checkSql('select 1\n;\nPRAGMA writable_schema=1').ok)
assert.ok(!checkSql('select load_extension(\'x\')').ok)

// ── 实际执行 ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-ds-query-'))
const store = new DatasetStore(tmp)
const rows = ['班级,分数,备注']
for (let i = 0; i < 1200; i++) rows.push(`${['甲班', '乙班', '丙班'][i % 3]},${i % 100},${'很长的备注'.repeat(60)}`)
const d1 = await store.importBuffer(Buffer.from(rows.join('\n')), 'big.csv')
const d2 = await store.importBuffer(Buffer.from('班级,老师\n甲班,老师甲\n乙班,老师乙\n丙班,老师丙\n'), 'teachers.csv')
const T1 = `d1."${d1.tables[0].name}"`
const file1 = path.join(tmp, 'datasets', `${d1.id}.sqlite`)
const before = fs.readFileSync(file1)

// 行数上限 + 总行数 + 单元格截断
let r = await store.runQuery(`select * from ${T1}`, [d1.id])
assert.ok(r.ok); assert.equal(r.returned, QUERY_LIMITS.rows); assert.equal(r.totalRows, 1200); assert.ok(r.truncated && /1200/.test(r.message))
assert.ok(Math.max(...r.rows[0].map(c => String(c).length)) <= QUERY_LIMITS.cellChars + 1, '单元格截断')
r = await store.runQuery(`select "c01_班级", count(*), avg("c02_分数") from ${T1} group by 1 order by 1`, [d1.id])
assert.deepEqual(r.rows.map(x => [x[0], x[1]]), [['乙班', 400], ['丙班', 400], ['甲班', 400]].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
assert.equal(r.truncated, false)
// 重复列名不丢列（用数组返回）
r = await store.runQuery(`select a."c02_分数", b."c02_分数" from ${T1} a join ${T1} b on a._row = b._row limit 2`, [d1.id])
assert.equal(r.columns.length, 2); assert.equal(r.rows[0].length, 2)
// 多数据集关联：d1 + d2
r = await store.runQuery(`select b."c02_老师", count(*) from ${T1} a join d2."${d2.tables[0].name}" b on a."c01_班级" = b."c01_班级" group by 1 order by 1`, [d1.id, d2.id])
assert.ok(r.ok, r.message); assert.equal(r.rows.length, 3); assert.equal(r.rows[0][1], 400)

// 只读：直接用 runReadOnly 绕过 checkSql 之外的路径也写不进去（checkSql 会先拦；这里验证文件没变）
for (const sql of [`delete from ${T1}`, `update ${T1} set "c02_分数" = 0`, `pragma writable_schema = 1`, `drop table ${T1}`, `attach database '${file1}' as z`, `select 1; delete from ${T1}`]) {
  const x = await runReadOnly({ files: [file1], sql })
  assert.ok(!x.ok, sql)
}
assert.ok(fs.readFileSync(file1).equals(before), '数据集文件内容没有被改动')
r = await store.runQuery(`select count(*) from ${T1}`, [d1.id])
assert.equal(r.rows[0][0], 1200)
// 只读连接本身：node:sqlite 的只读打开拒绝写入（防护第二层）
{
  const { DatabaseSync } = await import('node:sqlite')
  const ro = new DatabaseSync(file1, { readOnly: true })
  assert.throws(() => ro.exec(`delete from ${T1.slice(3)}`), /readonly|read-only/i)
  ro.exec(`attach database '${path.join(tmp, 'datasets', `${d2.id}.sqlite`)}' as z`)
  assert.throws(() => ro.exec(`create table z.hack(a)`), /readonly|read-only/i, '被挂载的库也是只读')
  ro.close()
}

// 白话错误
r = await store.runQuery('select * from d1."没有这张表"', [d1.id])
assert.ok(!r.ok && /没有叫/.test(r.message) && /no such table/.test(r.rawError)); assert.match(r.schema ?? '', /可用的表和列/, '失败时附上可用的表和列')
r = await store.runQuery(`select nonexist from ${T1}`, [d1.id])
assert.ok(!r.ok && /没有叫 nonexist 的列/.test(r.message))
r = await store.runQuery('selec 1', [d1.id]); assert.ok(!r.ok)
r = await store.runQuery(`select * from ${T1} where`, [d1.id]); assert.ok(!r.ok && /语法/.test(r.message) && r.rawError)
r = await store.runQuery('delete from x', [d1.id]); assert.ok(!r.ok && /SELECT/.test(r.message))
r = await store.runQuery('select 1', []); assert.ok(!r.ok)

// 超时：有限但很慢的递归查询，300 ms 就放弃（后台线程会自己跑完）
{
  const t0 = Date.now()
  const x = await runReadOnly({ files: [file1], sql: 'with recursive c(x) as (select 1 union all select x+1 from c where x < 60000000) select count(*) from c', timeoutMs: 300 })
  assert.ok(!x.ok && /超过/.test(x.message) && x.rawError === 'timeout'); assert.ok(Date.now() - t0 < 3000, '及时返回：' + (Date.now() - t0))
}
// 大结果只数到上限
r = await runReadOnly({ files: [file1], sql: 'with recursive c(x) as (select 1 union all select x+1 from c where x < 300000) select x from c' })
assert.ok(r.ok && r.returned === 500 && r.countCapped && /至少/.test(r.message), JSON.stringify({ ...r, rows: 0 }))

// 模型看到的表和列说明
const schema = store.schemaText([d1.id, d2.id])
assert.match(schema, /d1\."big"/); assert.match(schema, /d2\."teachers"/); assert.match(schema, /c02_分数/); assert.match(schema, /_row/)
// 工具形状
for (const tool of DATASET_TOOLS) {
  assert.equal(tool.level, 'read'); assert.equal(typeof tool.run, 'function'); assert.ok(tool.description.length > 20); assert.equal(typeof tool.params.safeParse, 'function')
}
assert.deepEqual(DATASET_TOOLS.map(x => x.name), ['list_datasets', 'dataset_profile', 'run_query', 'column_values'])
const rq = DATASET_TOOLS.find(x => x.name === 'run_query')
assert.ok(!rq.params.safeParse({ sql: '', datasets: [] }).success)
const out = await rq.run({ sql: 'drop table x', datasets: [d1.id] }, { store })
assert.equal(out.ok, false)

console.log('datasets-query.test ✓')
