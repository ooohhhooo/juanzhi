// 文档资料：存取、分段读、去个人信息、出现在 list_datasets 的数据目录里
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DocumentStore, readDocument, documentsForModel, DOC_READ_MAX } from '../../src/main/analysis/documents.ts'
import { listDatasets } from '../../src/main/analysis/datasets/tools.ts'
import { DatasetStore } from '../../src/main/analysis/datasets/store.ts'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-docs-'))
const docs = new DocumentStore(dir)
assert.deepEqual(docs.list(), [])
const body = '家长反馈：孩子过去式总写错。电话 13812345678。\n' + '练习'.repeat(DOC_READ_MAX)
const d = docs.add('家长反馈.txt', 'text', body)
assert.equal(docs.list().length, 1)
assert.equal(docs.text(d.id), body)
assert.throws(() => docs.text('../etc/passwd'))

const r1 = await readDocument.run({ documentId: d.id }, { documents: docs })
assert.ok(r1.text.includes('过去式总写错'))
assert.ok(!r1.text.includes('13812345678') && r1.text.includes('【手机号】'), '手机号去掉')
assert.equal(r1.from, 0); assert.ok(r1.nextFrom > 0, '长文档有下一段')
const r2 = await readDocument.run({ documentId: d.id, from: r1.nextFrom }, { documents: docs })
assert.equal(r2.from, r1.nextFrom)
assert.ok((await readDocument.run({ documentId: 'doc-nope' }, { documents: docs })).error)

const cat = documentsForModel({ documents: docs })
assert.equal(cat[0].id, d.id); assert.equal(cat[0].kind, 'text')
const list = await listDatasets.run({}, { store: new DatasetStore(dir), documents: docs })
assert.equal(list.documents.length, 1, 'list_datasets 带上文档资料')

docs.rename(d.id, '新名字'); assert.equal(docs.get(d.id).name, '新名字')
assert.equal(docs.remove(d.id), true); assert.equal(docs.list().length, 0); assert.equal(docs.remove(d.id), false)
fs.rmSync(dir, { recursive: true, force: true })
console.log('documents.test ✓')
