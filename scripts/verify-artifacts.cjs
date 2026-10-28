#!/usr/bin/env node
// 检查 release/ 里的安装包（M5 验收用，可重复运行）：
//   Windows 产物（任何系统上都能查）：exe 存在、大小合理；解开 setup / portable 里内嵌的 app-64.7z，核对 app.asar 里的关键文件、没有多余的原生模块、
//     resources/native/windows/ocr.ps1 在且字节和源文件完全一致（BOM 没丢）、exe 的图标和版本信息已改过。
//   Windows / Mac 的主程序都要关掉 RunAsNode 熔丝（用 @electron/fuses 读出来核对）：否则 WorkBuddy、VS Code 终端这类带着 ELECTRON_RUN_AS_NODE=1 的环境里，`juanzhi` 会被当成普通 Node 运行。
//   Mac 产物（只在 macOS 上查）：dmg 能挂载；.app 存在；codesign 是 ad-hoc 签名；OCR helper 在 Resources/native 里、是 arm64+x86_64 通用二进制且已签名；Info.plist 的版本；
//     spctl 的结果如实记录（没有公证，会被 Gatekeeper 拒绝——这是预期）。
// 用法：node scripts/verify-artifacts.cjs [release 目录]      退出码 0 = 全部通过
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createRequire } = require('node:module')

const root = path.join(__dirname, '..')
const req = createRequire(path.join(root, 'package.json'))
const dir = path.resolve(process.argv[2] || path.join(root, 'release'))
const version = require('../package.json').version
const results = []
const notes = []
/** 只记录、不计入通过数的信息（比如 spctl 的结果：没有公证被拒绝是预期，不是「通过」） */
const note = (feature, text) => { notes.push({ feature, text }); console.log(`ℹ️  [${feature}] ${text}`) }
const check = (feature, name, pass, detail = '') => { results.push({ feature, name, pass: !!pass, detail: String(detail).slice(0, 400) }); console.log(`${pass ? '✅' : '❌'} [${feature}] ${name}${detail ? '  — ' + String(detail).slice(0, 240) : ''}`) }
const MB = 1024 * 1024
/** 找 7-Zip（能读 NSIS 安装器）：EWB_7ZA > PATH 里的 7zz/7za/7z > electron-builder 下载缓存里的那份 */
function find7z() {
  if (process.env.EWB_7ZA) return process.env.EWB_7ZA
  for (const n of ['7zz', '7za', '7z']) { const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [n], { encoding: 'utf8' }); if (r.status === 0) return r.stdout.split(/\r?\n/)[0].trim() }
  const caches = [process.env.ELECTRON_BUILDER_CACHE, path.join(os.homedir(), 'Library/Caches/electron-builder'), path.join(os.homedir(), '.cache/electron-builder'), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'electron-builder/Cache')].filter(Boolean)
  for (const c of caches) {
    try {
      for (const d of fs.readdirSync(c).filter(x => x.startsWith('7zip'))) {
        const stack = [path.join(c, d)]
        while (stack.length) { const cur = stack.pop(); for (const e of fs.readdirSync(cur, { withFileTypes: true })) { const p = path.join(cur, e.name); if (e.isDirectory()) stack.push(p); else if (/^7za(\.exe)?$/.test(e.name)) return p } }
      }
    } catch { /* 这个缓存目录不存在 */ }
  }
  throw new Error('找不到 7-Zip：安装 7zz / 7za，或用 EWB_7ZA 指定')
}
/**
 * RunAsNode 熔丝必须是「关」（electron-builder.config.cjs 的 electronFuses.runAsNode = false）：
 * 开着的话，环境里有 ELECTRON_RUN_AS_NODE=1（基于 Electron 的 Agent 常见）就会让卷知变成普通 Node，命令行全坏。
 * target：Mac 传 .app 目录，Windows 传 exe。另外把 inspect 参数那个熔丝的状态记下来（只记录，不计入通过数；Playwright 冒烟要用，保持默认）。
 */
async function checkRunAsNodeOff(feature, target) {
  const { getCurrentFuseWire, FuseV1Options } = req('@electron/fuses')
  const DISABLED = 0x30   // '0'：@electron/fuses 里 FuseState.DISABLE（index 没有导出它）
  let wire = null, err = ''
  try { wire = await getCurrentFuseWire(target) } catch (e) { err = String(e && e.message || e) }
  const st = wire ? wire[FuseV1Options.RunAsNode] : undefined
  check(feature, `RunAsNode 熔丝已关闭（ELECTRON_RUN_AS_NODE=1 对打包版无效）`, st === DISABLED, wire ? `RunAsNode=0x${Number(st).toString(16)}（0x30=关，0x31=开）` : err)
  if (wire) note(feature, `其余熔丝保持默认：EnableNodeCliInspectArguments=0x${Number(wire[FuseV1Options.EnableNodeCliInspectArguments]).toString(16)}（0x31=开，Playwright 冒烟需要）`)
}
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * MB, ...opts })

async function verifyWindows(file, kind) {
  const f = path.join(dir, file)
  const feature = `Windows ${kind}`
  const ok = fs.existsSync(f)
  check(feature, `${file} 存在`, ok)
  if (!ok) return
  const size = fs.statSync(f).size
  check(feature, `体积合理（80–250 MB）`, size > 80 * MB && size < 250 * MB, `${(size / MB).toFixed(1)} MB`)
  const head = fs.readFileSync(f).subarray(0, 2).toString('latin1')
  check(feature, 'PE 可执行文件头（MZ）', head === 'MZ')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-verify-win-'))
  try {
    const sz = find7z()
    let r = sh(sz, ['x', '-y', `-o${tmp}/a`, f, '$PLUGINSDIR/app-64.7z'])
    const inner = path.join(tmp, 'a', '$PLUGINSDIR', 'app-64.7z')
    check(feature, 'NSIS 安装器里内嵌了应用包（app-64.7z）', fs.existsSync(inner), r.stderr)
    if (!fs.existsSync(inner)) return
    r = sh(sz, ['x', '-y', `-o${tmp}/b`, inner])
    const app = path.join(tmp, 'b')
    const exe = path.join(app, 'EnglishExamWorkbench.exe')
    check(feature, '解包后有 EnglishExamWorkbench.exe 和 resources/app.asar', fs.existsSync(exe) && fs.existsSync(path.join(app, 'resources/app.asar')), r.stderr)
    if (fs.existsSync(exe)) await checkRunAsNodeOff(feature, exe)
    const asar = req('@electron/asar')
    const list = asar.listPackage(path.join(app, 'resources/app.asar')).map(x => x.replace(/\\/g, '/'))
    const need = ['/out/main/index.js', '/out/preload/index.js', '/out/renderer/index.html', '/package.json',
      '/node_modules/pdfjs-dist/legacy/build/pdf.mjs', '/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', '/node_modules/pdfjs-dist/cmaps/GBK-EUC-H.bcmap', '/node_modules/pdfjs-dist/standard_fonts/FoxitSerif.pfb',
      '/node_modules/mammoth/package.json', '/node_modules/jszip/package.json', '/node_modules/yauzl/package.json', '/node_modules/yazl/package.json', '/node_modules/zod/package.json']
    const missing = need.filter(n => !list.includes(n))
    check(feature, `app.asar 里关键文件齐全（主进程 / 预加载 / 渲染端 / pdf.js 的 mjs + cmaps + 标准字体 / 运行期依赖）`, missing.length === 0, missing.join(', ') || `${list.length} 个条目`)
    check(feature, 'app.asar 里没有原生模块（@napi-rs）、没有只给渲染端用的 antd、没有 ._ 文件', !list.some(x => x.includes('@napi-rs') || x.includes('node_modules/antd') || /\/\._/.test(x)))
    const pkg = JSON.parse(asar.extractFile(path.join(app, 'resources/app.asar'), 'package.json').toString('utf8'))
    check(feature, `app.asar 里 package.json 的版本 = ${version}`, pkg.version === version, pkg.version)
    const ps1 = path.join(app, 'resources/native/windows/ocr.ps1')
    const src = path.join(root, 'native/windows/ocr.ps1')
    check(feature, 'resources/native/windows/ocr.ps1 在 asar 之外，字节和源文件一致（UTF-8 BOM 没丢）', fs.existsSync(ps1) && fs.readFileSync(ps1).equals(fs.readFileSync(src)) && fs.readFileSync(ps1)[0] === 0xef, ps1)
    const R = await import('resedit')
    const nt = R.NtExecutable.from(fs.readFileSync(exe), { ignoreCert: true })
    const res = R.NtExecutableResource.from(nt)
    const vi = R.Resource.VersionInfo.fromEntries(res.entries)[0]
    const sv = vi ? vi.getStringValues(vi.getAllLanguagesForStringValues()[0]) : {}
    const groups = R.Resource.IconGroupEntry.fromEntries(res.entries)
    check(feature, `exe 的版本信息已写入（ProductName / FileVersion = ${version}）、图标是我们的 ico（${groups[0]?.icons?.length ?? 0} 个尺寸）`, sv.ProductName === '卷知' && sv.FileVersion === version && (groups[0]?.icons?.length ?? 0) >= 6, JSON.stringify(sv).slice(0, 200))
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
}

async function verifyMac(file, arch) {
  const f = path.join(dir, file)
  const feature = `macOS ${arch}`
  const ok = fs.existsSync(f)
  check(feature, `${file} 存在`, ok)
  if (!ok) return
  const size = fs.statSync(f).size
  check(feature, '体积合理（80–250 MB）', size > 80 * MB && size < 250 * MB, `${(size / MB).toFixed(1)} MB`)
  const mnt = fs.mkdtempSync(path.join(os.tmpdir(), 'ewb-verify-dmg-'))
  const att = sh('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mnt, f])
  check(feature, 'dmg 能挂载并通过镜像校验（hdiutil attach -nobrowse，不跳过校验，用完卸载）', att.status === 0, att.stderr || att.stdout.split('\n').pop())
  try {
    if (att.status !== 0) return
    const app = path.join(mnt, '卷知.app')
    check(feature, 'dmg 里有「卷知.app」和指向 /Applications 的快捷方式', fs.existsSync(app) && fs.existsSync(path.join(mnt, 'Applications')))
    const cs = sh('codesign', ['-dv', '--verbose=2', app])
    const txt = cs.stderr + cs.stdout
    check(feature, 'codesign -dv：ad-hoc 签名（Signature=adhoc）', /Signature=adhoc/.test(txt) && /flags=0x2\(adhoc\)/.test(txt), txt.split('\n').filter(l => /Signature|flags|Identifier/.test(l)).join(' | '))
    const ver = sh('codesign', ['--verify', '--deep', '--strict', app])
    check(feature, 'codesign --verify --deep --strict 通过（签名完整）', ver.status === 0, ver.stderr)
    await checkRunAsNodeOff(feature, app)
    const helper = path.join(app, 'Contents/Resources/native/macos/bin/ewb-ocr')
    const hs = sh('codesign', ['-dv', helper])
    const lipo = sh('lipo', ['-info', helper])
    check(feature, 'OCR helper 在 Resources/native/macos/bin（asar 之外）、是 arm64 + x86_64 通用二进制、已签名', fs.existsSync(helper) && /x86_64/.test(lipo.stdout) && /arm64/.test(lipo.stdout) && /Signature=adhoc/.test(hs.stderr + hs.stdout), (lipo.stdout + (hs.stderr || '')).replace(/\n/g, ' ').slice(0, 200))
    const hmode = fs.statSync(helper).mode
    check(feature, `OCR helper 在 dmg 里带执行位（mode ${(hmode & 0o777).toString(8)}，要求含 0o111：没有执行位 Mac 上图片 OCR 全坏）`, (hmode & 0o111) === 0o111, (hmode & 0o777).toString(8))
    const plist = sh('plutil', ['-p', path.join(app, 'Contents/Info.plist')]).stdout
    check(feature, `Info.plist：版本 ${version}、最低系统 13.0、应用名`, plist.includes(`"CFBundleShortVersionString" => "${version}"`) && plist.includes('"LSMinimumSystemVersion" => "13.0"') && plist.includes('"CFBundleName" => "卷知"'))
    const main = sh('lipo', ['-archs', path.join(app, 'Contents/MacOS/卷知')]).stdout.trim()
    check(feature, `主程序架构 = ${arch === 'arm64' ? 'arm64' : 'x86_64'}`, main === (arch === 'arm64' ? 'arm64' : 'x86_64'), main)
    const sp = sh('spctl', ['--assess', '--type', 'execute', '-vv', app])
    // 未公证：Gatekeeper 拒绝是预期结果（安装指南里讲了怎么放行）。这里只如实记录。
    note(feature, `spctl --assess：${(sp.stderr + sp.stdout).trim().split('\n').pop().replace(/^.*\.app: /, '')}（未公证被拒绝是预期，不计入通过数）`)
  } finally {
    sh('hdiutil', ['detach', mnt, '-force'])
    try { fs.rmSync(mnt, { recursive: true, force: true }) } catch { /* 已卸载 */ }
  }
}

;(async () => {
  console.log(`检查 ${dir}（版本 ${version}）`)
  await verifyWindows(`Juanzhi-${version}-win-x64-setup.exe`, 'setup')
  await verifyWindows(`Juanzhi-${version}-win-x64-portable.exe`, 'portable')
  if (process.platform === 'darwin') {
    await verifyMac(`Juanzhi-${version}-mac-arm64.dmg`, 'arm64')
    await verifyMac(`Juanzhi-${version}-mac-x64.dmg`, 'x64')
  } else console.log('⚠️ 非 macOS：跳过 dmg 检查')
  const failed = results.filter(r => !r.pass)
  console.log(`\n==== 产物检查：${results.length - failed.length}/${results.length} 通过 ====`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'verify-artifacts.json'), JSON.stringify({ results, notes }, null, 2))
  process.exit(failed.length ? 1 : 0)
})().catch(e => { console.error(e); process.exit(2) })
