// 应用内更新的纯逻辑（src/main/update/core.ts）：版本比较、清单解析与选包、sha512 校验、拒绝规则、替换脚本。
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  compareVersions, isNewer, parseManifest, pickMacZip, pickPortableExe, summarizeNotes, verifyFile, sha512OfFile,
  macBundleOf, macInstallBlocker, sweepStages, MAC_SWAP_SCRIPT, WIN_SWAP_SCRIPT, safeArg, feedBases, autoCheckEnabled, RELEASES_PAGE, CHECK_INTERVAL_HOURS, RECHECK_HOURS
} from '../../src/main/update/core.ts'

// ── 自动检查频率：启动时至少隔 1 小时，开着时每 4 小时 ──
assert.equal(CHECK_INTERVAL_HOURS, 1)
assert.equal(RECHECK_HOURS, 4)

// ── 版本比较 ──
assert.equal(compareVersions('1.2.2', '1.2.1'), 1)
assert.equal(compareVersions('1.2.1', '1.2.1'), 0)
assert.equal(compareVersions('1.10.0', '1.9.9'), 1, '按数字比，不是按字符串')
assert.equal(compareVersions('2.0.0', '1.99.99'), 1)
assert.equal(compareVersions('1.2.1', '1.3.0'), -1)
assert.equal(compareVersions('v1.2.2', '1.2.1'), 1, '容忍 v 前缀')
assert.equal(compareVersions('1.3.0', '1.3.0-beta.1'), 1, '正式版 > 预发布')
assert.equal(compareVersions('1.3.0-beta.2', '1.3.0-beta.10'), -1)
assert.equal(compareVersions('abc', '1.0.0'), null)
assert.ok(isNewer('1.2.2', '1.2.1') && !isNewer('1.2.1', '1.2.1') && !isNewer('1.2.0', '1.2.1') && !isNewer('garbage', '1.2.1'))

// ── 清单解析（electron-builder 真实输出的样子）──
const MAC_YML = `version: 1.2.2
files:
  - url: Juanzhi-1.2.2-mac-arm64.zip
    sha512: AAAA+/bb==
    size: 123456
  - url: Juanzhi-1.2.2-mac-arm64.dmg
    sha512: DMGARM==
    size: 222
  - url: Juanzhi-1.2.2-mac-x64.zip
    sha512: XXXX==
    size: 654321
  - url: Juanzhi-1.2.2-mac-x64.dmg
    sha512: DMGX64==
    size: 333
path: Juanzhi-1.2.2-mac-arm64.zip
sha512: AAAA+/bb==
releaseDate: '2026-11-02T10:00:00.000Z'
releaseNotes: |
  ## 新功能
  - 一键更新
  - **修复** 若干问题
`
const m = parseManifest(MAC_YML)
assert.equal(m.version, '1.2.2')
assert.equal(m.files.length, 4)
assert.deepEqual(m.files[0], { url: 'Juanzhi-1.2.2-mac-arm64.zip', sha512: 'AAAA+/bb==', size: 123456 })
assert.equal(pickMacZip(m, 'arm64').url, 'Juanzhi-1.2.2-mac-arm64.zip')
assert.equal(pickMacZip(m, 'x64').sha512, 'XXXX==', 'x64 选 x64 的 zip，不会选到 dmg 或 arm64')
assert.equal(pickMacZip(m, 'ia32'), null)
assert.equal(pickMacZip(parseManifest(MAC_YML.replace(/Juanzhi-1\.2\.2-mac-x64\.zip/g, 'x.pkg')), 'x64'), null, '清单里没有该架构的 zip → null')
assert.match(m.releaseNotes, /一键更新/)
assert.equal(summarizeNotes(m.releaseNotes), '新功能\n一键更新\n修复 若干问题')
assert.equal(summarizeNotes('<p>a</p>\n' + 'x\n'.repeat(10), 3), 'a\nx\nx…')
assert.equal(summarizeNotes(undefined), '')
// 老格式（只有顶层 path / sha512）、Windows 行尾
const old = parseManifest('version: 1.0.1\r\npath: Juanzhi-1.0.1-win-x64-setup.exe\r\nsha512: ZZ==\r\nsize: 5\r\n')
assert.deepEqual(old.files, [{ url: 'Juanzhi-1.0.1-win-x64-setup.exe', sha512: 'ZZ==', size: 5 }])
const port = parseManifest(`version: 1.2.2\nfiles:\n  - url: Juanzhi-1.2.2-win-x64-portable.exe\n    sha512: PP==\n    size: 9\n`)
assert.equal(pickPortableExe(port).sha512, 'PP==')
assert.equal(pickPortableExe(old), null)
// 残缺 / 恶意的清单一律拒绝
assert.throws(() => parseManifest('files:\n  - url: a.zip\n    sha512: x\n'), /版本号/)
assert.throws(() => parseManifest('version: 1.2.2\nfiles:\n  - url: a.zip\n'), /没有可下载/)
assert.throws(() => parseManifest('version: 1.2.2\nfiles:\n  - url: ../evil.zip\n    sha512: x\n'), /不安全/)
assert.throws(() => parseManifest('version: 1.2.2\nfiles:\n  - url: https://evil.example/a.zip\n    sha512: x\n'), /不安全/)
assert.throws(() => parseManifest('<html>404</html>'), /版本号/)

// ── sha512 校验 ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-update-test-'))
try {
  const f = path.join(tmp, '更新 包.zip')   // 空格 + 中文
  fs.writeFileSync(f, 'hello update')
  const good = crypto.createHash('sha512').update('hello update').digest('base64')
  assert.equal(await sha512OfFile(f), good)
  assert.deepEqual(await verifyFile(f, { sha512: good, size: 12 }), { ok: true })
  assert.equal((await verifyFile(f, { sha512: good, size: 13 })).ok, false, '大小不对')
  const bad = await verifyFile(f, { sha512: good.replace(/^./, c => (c === 'A' ? 'B' : 'A')), size: 12 })
  assert.equal(bad.ok, false); assert.match(bad.reason, /sha512/)
  assert.equal((await verifyFile(path.join(tmp, 'nope'), { sha512: good })).ok, false, '文件不存在')

  // ── 拒绝规则 ──
  const W = () => true, NW = () => false
  const exe = (b) => `${b}/Contents/MacOS/卷知`
  assert.equal(macBundleOf(exe('/Applications/卷知.app')), '/Applications/卷知.app')
  assert.equal(macBundleOf('/usr/local/bin/electron'), null)
  assert.equal(macInstallBlocker(exe('/Applications/卷知.app'), W), null)
  assert.equal(macInstallBlocker(exe('/Users/a b/应用 测试/卷知.app'), W), null, '路径带空格和中文也可以')
  assert.equal(macInstallBlocker(exe('/Volumes/卷知 1.2.1/卷知.app'), W).code, 'dmg')
  assert.equal(macInstallBlocker(exe('/Volumes/Elements/Apps/卷知.app'), W).code, 'dmg')
  assert.equal(macInstallBlocker(exe('/private/var/folders/xx/T/AppTranslocation/ABC-123/d/卷知.app'), W).code, 'translocation')
  assert.equal(macInstallBlocker(exe('/Applications/卷知.app'), NW).code, 'unwritable')
  assert.match(macInstallBlocker(exe('/Applications/卷知.app'), NW).message, /\/Applications/)
  assert.equal(macInstallBlocker('/x/node_modules/electron/dist/Electron', W).code, 'dev')
  for (const code of ['dmg', 'translocation', 'unwritable']) assert.match(macInstallBlocker(code === 'dmg' ? exe('/Volumes/a/卷知.app') : code === 'translocation' ? exe('/a/AppTranslocation/x/卷知.app') : exe('/Applications/卷知.app'), code === 'unwritable' ? NW : W).message, /[一-鿿]/, '白话中文说明')

  // ── 替换脚本：脚本正文里没有路径，路径全走参数 / 环境变量 ──
  assert.ok(!/Applications|Users|\/var\//.test(MAC_SWAP_SCRIPT), '正文里不写死路径')
  assert.ok(/"\$NEW"/.test(MAC_SWAP_SCRIPT) && /"\$TARGET"/.test(MAC_SWAP_SCRIPT), '用到路径的地方都加了引号')
  assert.ok(!/\$NEW[^"]/.test(MAC_SWAP_SCRIPT.replace(/"\$NEW"/g, '')) , '没有不带引号的 $NEW')
  assert.ok(/xattr -dr com\.apple\.quarantine/.test(MAC_SWAP_SCRIPT))
  assert.ok(/[一-鿿]/.test(MAC_SWAP_SCRIPT) && /ewb|%EWB_/.test(WIN_SWAP_SCRIPT))
  assert.ok(!/[^\x00-\x7f]/.test(WIN_SWAP_SCRIPT), 'Windows 脚本纯 ASCII（路径走环境变量）')
  for (const v of ['EWB_NEW', 'EWB_TARGET', 'EWB_TARGET_NAME', 'EWB_LOG', 'EWB_PID', 'EWB_WORK']) assert.ok(WIN_SWAP_SCRIPT.includes(`%${v}%`), v)
  assert.ok(/"%EWB_TARGET%"/.test(WIN_SWAP_SCRIPT) && /"%EWB_NEW%"/.test(WIN_SWAP_SCRIPT), 'Windows 脚本里路径加了引号')
  assert.ok(/del \/F \/Q "%EWB_TARGET%\.old"/.test(WIN_SWAP_SCRIPT.split(':waitpid')[0]), '先清掉上次留下的 .old')
  const giveup = WIN_SWAP_SCRIPT.split(':giveup')[1].split(':finish')[0]
  assert.ok(/start "" "%EWB_TARGET%"/.test(giveup), '放弃时重新打开旧版')
  assert.ok(/rmdir \/s \/q "%EWB_WORK%"/.test(WIN_SWAP_SCRIPT) && /del \/F \/Q "%EWB_NEW%"/.test(WIN_SWAP_SCRIPT.split(':finish')[1]), '结束时清 .new 和临时目录')
  // 暂存目录清理：别的 pid 留下的没备份的立刻删；有备份的放满一天；本进程的不动
  {
    const par = path.join(tmp, 'sweep'); fs.mkdirSync(par)
    const mkd = (n, backup) => { const d = path.join(par, n); fs.mkdirSync(d); if (backup) fs.mkdirSync(path.join(d, 'backup')); return d }
    mkd('.juanzhi-update-111'); const withBackup = mkd('.juanzhi-update-222', true); mkd('.juanzhi-update-999'); mkd('.juanzhi-update-abc'); fs.mkdirSync(path.join(par, '卷知.app'))
    assert.deepEqual(sweepStages(par, 999).sort(), ['.juanzhi-update-111'])
    assert.ok(fs.existsSync(withBackup) && fs.existsSync(path.join(par, '.juanzhi-update-999')) && fs.existsSync(path.join(par, '.juanzhi-update-abc')) && fs.existsSync(path.join(par, '卷知.app')))
    assert.deepEqual(sweepStages(par, 999, Date.now() + 2 * 86400_000), ['.juanzhi-update-222'], '满一天的带备份目录也清掉')
    assert.ok(fs.existsSync(path.join(par, '.juanzhi-update-999')), '本进程的永远不动')
    assert.deepEqual(sweepStages(path.join(par, 'nope'), 1), [])
  }
  assert.throws(() => safeArg('a\nb'), /不允许/)
  assert.equal(safeArg('/a b/卷知 (1).app'), '/a b/卷知 (1).app')

  // 真跑一遍 Mac 脚本（只在 macOS / Linux 上）：路径带空格、中文、括号；成功路径和「新版挪不进去 → 还原旧版」两条
  if (process.platform !== 'win32') {
    const script = path.join(tmp, 'swap.sh')
    fs.writeFileSync(script, MAC_SWAP_SCRIPT)
    const mk = (root, label) => {
      const parent = path.join(root, '应用 文件夹 (测试)')
      const target = path.join(parent, '卷知.app'), stage = path.join(parent, '.juanzhi-update-1'), neu = path.join(stage, 'new.app')
      fs.mkdirSync(path.join(target, 'Contents'), { recursive: true }); fs.writeFileSync(path.join(target, 'Contents', 'v'), 'old')
      fs.mkdirSync(path.join(neu, 'Contents'), { recursive: true }); fs.writeFileSync(path.join(neu, 'Contents', 'v'), label)
      const work = path.join(root, 'work'); fs.mkdirSync(work)
      return { parent, target, stage, neu, work, backup: path.join(stage, 'backup'), log: path.join(root, 'log.txt') }
    }
    // 成功：pid 用一个已经不存在的（直接通过等待）。open 在测试里会失败（目标不是真 app），只记日志；PATH 里放个假 open 避免真的打开东西
    const fakeBin = path.join(tmp, 'bin'); fs.mkdirSync(fakeBin)
    fs.writeFileSync(path.join(fakeBin, 'open'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` }
    {
      const root = path.join(tmp, 'ok2'); fs.mkdirSync(root)
      const t = mk(root, 'new')
      const r = spawnSync('/bin/sh', [script, '99999999', t.neu, t.target, t.backup, t.log, t.work], { env, encoding: 'utf8', timeout: 60000 })
      assert.equal(r.status, 0, r.stderr + fs.readFileSync(t.log, 'utf8'))
      assert.equal(fs.readFileSync(path.join(t.target, 'Contents', 'v'), 'utf8'), 'new', '新版已就位')
      assert.ok(!fs.existsSync(t.work), '临时目录已清理')
      // 测试里没有真的新版进程在跑：脚本等满 20 秒后保留备份（旧版在 backup/old.app），不会误删
      assert.equal(fs.readFileSync(path.join(t.backup, 'old.app', 'Contents', 'v'), 'utf8'), 'old', '没看到新版运行时备份保留着')
      assert.match(fs.readFileSync(t.log, 'utf8'), /备份保留/)
    }
    {
      // 新版不存在 → mv 失败 → 必须把旧版原样还原
      const root = path.join(tmp, 'fail'); fs.mkdirSync(root)
      const t = mk(root, 'new'); fs.rmSync(t.neu, { recursive: true })
      const r = spawnSync('/bin/sh', [script, '99999999', t.neu, t.target, t.backup, t.log, t.work], { env, encoding: 'utf8', timeout: 60000 })
      assert.equal(r.status, 1)
      assert.equal(fs.readFileSync(path.join(t.target, 'Contents', 'v'), 'utf8'), 'old', '失败时旧版原样还原')
      assert.match(fs.readFileSync(t.log, 'utf8'), /恢复旧版/)
    }
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }) }

// ── 更新源 / 自动检查开关 ──
assert.deepEqual(feedBases({}), ['https://github.com/ooohhhooo/juanzhi/releases/latest/download'])
assert.deepEqual(feedBases({ EWB_UPDATE_FEED: ' http://127.0.0.1:9/x/ ' }), ['http://127.0.0.1:9/x'])
assert.equal(RELEASES_PAGE, 'https://github.com/ooohhhooo/juanzhi/releases/latest')
assert.equal(autoCheckEnabled({}, true), true)
assert.equal(autoCheckEnabled({}, false), false, '开发版不查')
assert.equal(autoCheckEnabled({ EWB_USER_DATA_DIR: '/x' }, true), false, '测试用的数据目录 → 自动关闭')
assert.equal(autoCheckEnabled({ EWB_USER_DATA_DIR: '/x', EWB_UPDATE_FEED: 'http://h' }, true), true, '给了更新源就查')
assert.equal(autoCheckEnabled({ EWB_UPDATE_FEED: 'http://h', EWB_DISABLE_UPDATE_CHECK: '1' }, true), false, '明确关闭优先')

console.log('update.test ✓')
