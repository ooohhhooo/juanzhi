// M7 命令行：结果文件 / 导出目标的安全规则（评审 P1-5）：不能覆盖数据库、不能写进数据目录、不覆盖别人的文件、不跟随符号链接。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertResultFileWritable, assertExportTarget, writeFileAtomic, isInside, realPathLoose } from '../../src/main/cli/outfile.ts'
import { CliError } from '../../src/main/cli/args.ts'

const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-outfile-')))
const userData = path.join(d, 'userData'), dataDir = path.join(userData, 'workbench-data')
fs.mkdirSync(dataDir, { recursive: true })
fs.writeFileSync(path.join(dataDir, 'db.sqlite'), 'SQLITE DATA')
const forbidden = [userData, dataDir]
const bad = (fn, re) => assert.throws(fn, e => e instanceof CliError && e.code === 'usage' && re.test(e.message))

// 数据库 / 数据目录里的任何文件、userData 里的文件：拒绝（评审里的 `--result-file <数据目录>/db.sqlite`）
bad(() => assertResultFileWritable(path.join(dataDir, 'db.sqlite'), forbidden), /不能放在卷知的数据目录里/)
bad(() => assertResultFileWritable(path.join(dataDir, 'new.json'), forbidden), /不能放在卷知的数据目录里/)
bad(() => assertResultFileWritable(path.join(userData, 'ewb-config.json'), forbidden), /不能放在卷知的数据目录里/)
bad(() => assertResultFileWritable(path.join(dataDir, '..', 'workbench-data', 'x.json'), forbidden), /不能放在/, '.. 绕不过去')
// 符号链接指向数据目录：解开链接后判断
const link = path.join(d, 'sneaky'); fs.symlinkSync(dataDir, link)
bad(() => assertResultFileWritable(path.join(link, 'x.json'), forbidden), /不能放在卷知的数据目录里/)
const fileLink = path.join(d, 'file-link.json'); fs.symlinkSync(path.join(dataDir, 'db.sqlite'), fileLink)
bad(() => assertResultFileWritable(fileLink, forbidden), /不能放在卷知的数据目录里|符号链接/)
assert.equal(fs.readFileSync(path.join(dataDir, 'db.sqlite'), 'utf8'), 'SQLITE DATA')
// 扩展名
bad(() => assertResultFileWritable(path.join(d, 'x.db'), forbidden), /扩展名只能是/); bad(() => assertResultFileWritable(path.join(d, 'x.sh'), forbidden), /扩展名只能是/)
for (const ok of ['r.json', 'r.txt', 'r']) assert.equal(assertResultFileWritable(path.join(d, ok), forbidden), path.join(d, ok))
// 已经存在：必须是本程序以前写的结果文件
fs.writeFileSync(path.join(d, 'notes.txt'), '我的笔记')
bad(() => assertResultFileWritable(path.join(d, 'notes.txt'), forbidden), /不是卷知以前写的结果文件/)
fs.writeFileSync(path.join(d, 'prev.json'), '{"ok":true,"data":{}}\n')
assert.ok(assertResultFileWritable(path.join(d, 'prev.json'), forbidden), '自己以前写的可以覆盖')
fs.writeFileSync(path.join(d, 'empty.json'), ''); assert.ok(assertResultFileWritable(path.join(d, 'empty.json'), forbidden), '空文件可以')
// 目录
fs.mkdirSync(path.join(d, 'adir.json')); bad(() => assertResultFileWritable(path.join(d, 'adir.json'), forbidden), /不是普通文件/)

// 导出目标：已存在不覆盖（加 --overwrite 才行）；数据目录里不行；符号链接 / 目录不行
fs.writeFileSync(path.join(d, 'r.docx'), 'old')
bad(() => assertExportTarget(path.join(d, 'r.docx'), forbidden, false), /已经存在.*--overwrite/)
assert.equal(assertExportTarget(path.join(d, 'r.docx'), forbidden, true), path.join(d, 'r.docx'))
assert.equal(assertExportTarget(path.join(d, 'fresh.docx'), forbidden, false), path.join(d, 'fresh.docx'))
bad(() => assertExportTarget(path.join(dataDir, 'r.docx'), forbidden, true), /不能放在卷知的数据目录里/)
fs.symlinkSync(path.join(d, 'r.docx'), path.join(d, 'l.docx')); bad(() => assertExportTarget(path.join(d, 'l.docx'), forbidden, true), /符号链接或目录不能覆盖/)

// 原子写：写完整改名，不留临时文件
writeFileAtomic(path.join(d, 'out', 'a.json'), '{"ok":true}\n'); assert.equal(fs.readFileSync(path.join(d, 'out', 'a.json'), 'utf8'), '{"ok":true}\n'); assert.deepEqual(fs.readdirSync(path.join(d, 'out')), ['a.json'])
assert.ok(isInside(path.join(dataDir, 'files', 'x'), dataDir) && !isInside(path.join(d, 'other'), dataDir) && !isInside(dataDir + '-sibling/x', dataDir), '前缀相同但不是子目录的不算')
assert.ok(realPathLoose(path.join(d, 'nope', 'deeper')).startsWith(d))
fs.rmSync(d, { recursive: true, force: true })
console.log('cli-outfile.test ✓')
